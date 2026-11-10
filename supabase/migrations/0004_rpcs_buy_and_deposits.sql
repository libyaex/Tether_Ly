-- 0004_rpcs_buy_and_deposits.sql
-- Server-side business logic. Every function: SECURITY DEFINER, executable by service_role ONLY
-- (called from Edge Functions that have already authenticated the caller and pass the user id).
-- STATUS: written, NOT yet executed against a real Postgres.
-- Rounding rules: gross LYD = round(usdt * price, 2) (half away from zero); fee = round(gross * pct / 100, 2);
--                 USDT derived from an LYD input = trunc(lyd / price, 6) (never rounds up in the customer's favour).
-- Error contract: functions raise exceptions whose message is a stable code (e.g. 'quote_expired').

-- ---------------------------------------------------------------- extra system accounts for trade settlement
alter table public.ledger_accounts drop constraint ledger_accounts_kind_check;
alter table public.ledger_accounts add constraint ledger_accounts_kind_check check (kind in (
  'customer_available','customer_held','provider_clearing','company_cash','company_usdt',
  'fee_revenue','suspense','customer_payable','trade_clearing'));
insert into public.ledger_accounts(code, name, kind, currency) values
  ('SYS-TRADE-CLEARING-LYD',  'Trade clearing (LYD)',  'trade_clearing', 'LYD'),
  ('SYS-TRADE-CLEARING-USDT', 'Trade clearing (USDT)', 'trade_clearing', 'USDT');

-- ---------------------------------------------------------------- helpers
create function public._as_actor(p_actor uuid) returns void language plpgsql as $$
begin   -- makes auth.uid() (used by audit triggers) report the real actor inside service-role RPCs
  perform set_config('request.jwt.claim.sub', coalesce(p_actor::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_actor)::text, true);
end $$;

create function public.actor_has_permission(p_actor uuid, p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.role_permissions rp on rp.role = ur.role
    join public.profiles pr on pr.id = ur.user_id
    where ur.user_id = p_actor and ur.revoked_at is null and pr.status = 'active' and rp.permission = p);
$$;

create function public._setting(p_key text) returns text language sql stable security definer set search_path = public as $$
  select value #>> '{}' from public.admin_settings where key = p_key;
$$;

create function public._notify(p_user uuid, p_type text, p_level text, p_title text, p_body text,
                               p_entity_type text, p_entity uuid, p_link text, p_dedupe text) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications(user_id, type, level, title, body, entity_type, entity_id, link, dedupe_key)
  values (p_user, p_type, p_level, p_title, p_body, p_entity_type, p_entity, p_link, p_dedupe)
  on conflict (user_id, dedupe_key) do nothing;
$$;

create function public._notify_staff(p_permission text, p_type text, p_level text, p_title text, p_body text,
                                     p_entity_type text, p_entity uuid, p_link text) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select distinct ur.user_id from public.user_roles ur
           join public.role_permissions rp on rp.role = ur.role
           join public.profiles pr on pr.id = ur.user_id
           where rp.permission = p_permission and ur.revoked_at is null and pr.status = 'active' loop
    perform public._notify(r.user_id, p_type, p_level, p_title, p_body, p_entity_type, p_entity, p_link,
                           p_type || ':' || p_entity::text);
  end loop;
end $$;

create function public._assert_can_trade(p_user uuid, p_side text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if (select status from public.profiles where id = p_user) is distinct from 'active' then
    raise exception 'account_not_active'; end if;
  if coalesce(public._setting('maintenance.enabled'), 'false')::boolean then raise exception 'maintenance'; end if;
  if not coalesce(public._setting(case p_side when 'buy' then 'trading.buy_enabled' else 'trading.sell_enabled' end), 'false')::boolean then
    raise exception 'trading_disabled'; end if;
end $$;

-- ---------------------------------------------------------------- price quote (price lock)
create function public.create_quote(p_user uuid, p_side text) returns public.rate_quotes
language plpgsql security definer set search_path = public as $$
declare r public.exchange_rates; q public.rate_quotes; ttl integer;
begin
  if p_side not in ('buy','sell') then raise exception 'invalid_side'; end if;
  perform public._assert_can_trade(p_user, p_side);
  select * into r from public.exchange_rates
   where valid_from <= now() and (valid_to is null or valid_to > now())
   order by valid_from desc, created_at desc limit 1;
  if not found then raise exception 'no_rate'; end if;
  ttl := coalesce(public._setting('trading.quote_ttl_seconds'), '120')::integer;
  insert into public.rate_quotes(user_id, side, rate_id, price, fee_pct, expires_at)
  values (p_user, p_side, r.id,
          case p_side when 'buy' then r.sell_price else r.buy_price end,   -- customer BUYS at the platform's sell price
          case p_side when 'buy' then r.buy_fee_pct else r.sell_fee_pct end,
          now() + make_interval(secs => ttl))
  returning * into q;
  return q;
end $$;

-- ---------------------------------------------------------------- BUY: create (holds LYD atomically)
create function public.create_buy_order(p_user uuid, p_quote_id uuid, p_lyd_amount numeric,
                                        p_usdt_amount numeric, p_network text, p_address text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  q public.rate_quotes; r public.exchange_rates; net public.supported_networks;
  v_usdt numeric; v_gross numeric; v_fee numeric; v_total numeric;
  acc_av uuid; acc_hd uuid; v_hold uuid; v_id uuid;
begin
  perform public._as_actor(p_user);
  select * into q from public.rate_quotes where id = p_quote_id for update;           -- serialises double-submit
  if not found or q.user_id <> p_user or q.side <> 'buy' then raise exception 'quote_invalid'; end if;
  if q.used_at is not null then raise exception 'quote_used'; end if;
  if q.expires_at <= now() then raise exception 'quote_expired'; end if;
  perform public._assert_can_trade(p_user, 'buy');

  if (p_lyd_amount is null) = (p_usdt_amount is null) then raise exception 'exactly_one_amount_required'; end if;
  if p_usdt_amount is not null then
    if p_usdt_amount <= 0 or p_usdt_amount <> trunc(p_usdt_amount, 6) then raise exception 'invalid_amount'; end if;
    v_usdt := p_usdt_amount;
  else
    if p_lyd_amount <= 0 or p_lyd_amount <> round(p_lyd_amount, 2) then raise exception 'invalid_amount'; end if;
    v_usdt := trunc(p_lyd_amount / q.price, 6);
  end if;
  if v_usdt <= 0 then raise exception 'invalid_amount'; end if;

  v_gross := round(v_usdt * q.price, 2);
  v_fee   := round(v_gross * q.fee_pct / 100, 2);
  v_total := v_gross + v_fee;

  select * into r from public.exchange_rates where id = q.rate_id;
  if v_gross < r.min_buy_lyd or v_gross > r.max_buy_lyd then raise exception 'out_of_limits'; end if;

  select * into net from public.supported_networks where code = p_network and status = 'active';
  if not found then raise exception 'network_inactive'; end if;
  if p_address is null or p_address !~ net.address_regex then raise exception 'invalid_address'; end if;

  select available_account_id, held_account_id into acc_av, acc_hd from public.wallets where user_id = p_user;
  begin
    v_hold := public.post_ledger_transaction('buy-hold:' || q.id, 'buy_hold', 'rate_quote', q.id,
      'Hold LYD for buy order',
      jsonb_build_array(
        jsonb_build_object('account_id', acc_av, 'direction', 'debit',  'amount', v_total),
        jsonb_build_object('account_id', acc_hd, 'direction', 'credit', 'amount', v_total)),
      null, p_user);
  exception when check_violation then
    raise exception 'insufficient_balance';
  end;

  insert into public.buy_orders(user_id, quote_id, price, fee_pct, usdt_amount, lyd_gross, lyd_fee, lyd_total,
                                network_code, receive_address, hold_transaction_id)
  values (p_user, q.id, q.price, q.fee_pct, v_usdt, v_gross, v_fee, v_total, p_network, p_address, v_hold)
  returning id into v_id;
  update public.rate_quotes set used_at = now() where id = q.id;

  perform public._notify(p_user, 'buy_order_created', 'info', 'تم إنشاء طلب الشراء', null,
                         'buy_order', v_id, '/orders/buy/' || v_id, 'buy-created:' || v_id);
  perform public._notify_staff('buy.process', 'staff_new_buy_order', 'info', 'طلب شراء جديد', null,
                               'buy_order', v_id, '/admin/orders/buy/' || v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- BUY: staff status moves (no money moves here)
create function public.buy_order_set_status(p_actor uuid, p_order uuid, p_to text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.buy_orders;
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'buy.process') then raise exception 'forbidden'; end if;
  if p_to not in ('approved','processing','needs_attention','pending_review') then raise exception 'invalid_target'; end if;
  select * into o from public.buy_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if p_actor = o.user_id then raise exception 'self_dealing'; end if;
  update public.buy_orders
     set status = p_to,
         assigned_to = case when p_to = 'processing' then p_actor else assigned_to end
   where id = p_order;                                   -- enforce_transition rejects illegal moves
  if p_to = 'processing' then
    perform public._notify(o.user_id, 'buy_processing', 'info', 'بدأت معالجة طلب الشراء', null,
                           'buy_order', o.id, '/orders/buy/' || o.id, 'buy-processing:' || o.id);
  end if;
end $$;

-- ---------------------------------------------------------------- BUY: reject / cancel / fail  (reverses the hold)
create function public.release_buy_order(p_actor uuid, p_order uuid, p_to text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.buy_orders; acc_av uuid; acc_hd uuid; v_rel uuid;
begin
  perform public._as_actor(p_actor);
  if p_to not in ('rejected','cancelled','failed') then raise exception 'invalid_target'; end if;
  select * into o from public.buy_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;

  if p_to = 'cancelled' and p_actor = o.user_id and o.status = 'pending_review' then
    null;                                                            -- customer may cancel only before staff review
  elsif not public.actor_has_permission(p_actor, 'buy.process') then
    raise exception 'forbidden';
  elsif p_actor = o.user_id then
    raise exception 'self_dealing';
  end if;
  if p_to in ('rejected','failed') and coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  if not public.buy_transition_allowed(o.status, p_to) then raise exception 'illegal_transition'; end if;

  select available_account_id, held_account_id into acc_av, acc_hd from public.wallets where user_id = o.user_id;
  v_rel := public.post_ledger_transaction('buy-release:' || o.id, 'buy_release', 'buy_order', o.id,
    'Release held LYD (' || p_to || ')',
    jsonb_build_array(
      jsonb_build_object('account_id', acc_hd, 'direction', 'debit',  'amount', o.lyd_total),
      jsonb_build_object('account_id', acc_av, 'direction', 'credit', 'amount', o.lyd_total)),
    o.hold_transaction_id, p_actor);

  update public.buy_orders set status = p_to, release_transaction_id = v_rel, rejection_reason = p_reason
   where id = o.id;
  perform public._notify(o.user_id, 'buy_' || p_to, case p_to when 'cancelled' then 'info' else 'warning' end,
                         case p_to when 'cancelled' then 'تم إلغاء طلب الشراء' else 'تعذر تنفيذ طلب الشراء' end,
                         'تمت إعادة المبلغ المحجوز إلى رصيدك المتاح',
                         'buy_order', o.id, '/orders/buy/' || o.id, 'buy-' || p_to || ':' || o.id);
end $$;

-- ---------------------------------------------------------------- BUY: complete (staff confirms the manual USDT transfer)
-- The TXID is recorded as 'unverified' on-chain: the UI must show "pending verified confirmation",
-- never "confirmed on blockchain", until an on-chain check flips usdt_transfers.verification.
create function public.complete_buy_order(p_actor uuid, p_order uuid, p_network text, p_address text,
                                          p_usdt_sent numeric, p_txid text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  o public.buy_orders; t uuid; v_settle uuid; acc_hd uuid; clr_l uuid; clr_u uuid; rev uuid; cu uuid; ent jsonb;
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'buy.complete') then raise exception 'forbidden'; end if;
  select * into o from public.buy_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if p_actor = o.user_id then raise exception 'self_dealing'; end if;
  if o.status <> 'processing' then raise exception 'illegal_transition'; end if;      -- blocks double completion

  if p_network is distinct from o.network_code or p_address is distinct from o.receive_address
     or p_usdt_sent is distinct from o.usdt_amount then
    raise exception 'confirmation_mismatch';          -- operator must re-confirm network, address and amount exactly
  end if;
  if coalesce(btrim(p_txid), '') = '' then raise exception 'txid_required'; end if;

  begin
    insert into public.usdt_transfers(network_code, txid, direction, recorded_by)
    values (p_network, btrim(p_txid), 'outgoing_to_customer', p_actor) returning id into t;
  exception when unique_violation then
    raise exception 'txid_already_used';
  end;

  select held_account_id into acc_hd from public.wallets where user_id = o.user_id;
  select id into clr_l from public.ledger_accounts where code = 'SYS-TRADE-CLEARING-LYD';
  select id into clr_u from public.ledger_accounts where code = 'SYS-TRADE-CLEARING-USDT';
  select id into rev   from public.ledger_accounts where code = 'SYS-FEE-REVENUE-LYD';
  select id into cu    from public.ledger_accounts where code = 'SYS-USDT';

  ent := jsonb_build_array(
    jsonb_build_object('account_id', acc_hd, 'direction', 'debit',  'amount', o.lyd_total),
    jsonb_build_object('account_id', clr_l,  'direction', 'credit', 'amount', o.lyd_gross),
    jsonb_build_object('account_id', clr_u,  'direction', 'debit',  'amount', o.usdt_amount),
    jsonb_build_object('account_id', cu,     'direction', 'credit', 'amount', o.usdt_amount));
  if o.lyd_fee > 0 then
    ent := ent || jsonb_build_array(jsonb_build_object('account_id', rev, 'direction', 'credit', 'amount', o.lyd_fee));
  end if;

  v_settle := public.post_ledger_transaction('buy-settle:' || o.id, 'buy_settle', 'buy_order', o.id,
    'Settle buy order' || coalesce(' | note: ' || p_note, ''), ent, null, p_actor);

  update public.buy_orders
     set status = 'completed', outgoing_transfer_id = t, executed_by = p_actor,
         executed_at = now(), settle_transaction_id = v_settle
   where id = o.id;

  perform public._notify(o.user_id, 'buy_completed', 'success', 'تم تنفيذ طلب شراء USDT', null,
                         'buy_order', o.id, '/orders/buy/' || o.id, 'buy-completed:' || o.id);
end $$;

-- ---------------------------------------------------------------- DEPOSIT: create + attach DPay session
create function public.create_deposit_order(p_user uuid, p_amount numeric) returns public.deposit_orders
language plpgsql security definer set search_path = public as $$
declare o public.deposit_orders; v_min numeric; v_max numeric;
begin
  perform public._as_actor(p_user);
  if (select status from public.profiles where id = p_user) is distinct from 'active' then
    raise exception 'account_not_active'; end if;
  if coalesce(public._setting('maintenance.enabled'), 'false')::boolean then raise exception 'maintenance'; end if;
  if not coalesce(public._setting('payments.topups_enabled'), 'false')::boolean then raise exception 'topups_disabled'; end if;
  v_min := public._setting('payments.topup_min_lyd')::numeric;
  v_max := public._setting('payments.topup_max_lyd')::numeric;
  if v_min is null or v_max is null then raise exception 'topup_limits_not_configured'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'invalid_amount'; end if;
  if p_amount < v_min or p_amount > v_max then raise exception 'out_of_limits'; end if;
  insert into public.deposit_orders(user_id, amount) values (p_user, p_amount) returning * into o;
  return o;
end $$;

create function public.attach_checkout_session(p_order uuid, p_checkout_id text, p_idem text, p_attempt integer,
                                               p_live boolean, p_url text, p_expires_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare o public.deposit_orders;
begin
  if exists (select 1 from public.dpay_checkout_sessions where idempotency_key = p_idem) then return; end if;   -- replay
  select * into o from public.deposit_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'pending' then raise exception 'illegal_transition'; end if;
  insert into public.dpay_checkout_sessions(deposit_order_id, checkout_id, idempotency_key, attempt, live, url, amount, expires_at)
  values (o.id, p_checkout_id, p_idem, p_attempt, p_live, p_url, o.amount, p_expires_at);
  update public.deposit_orders set status = 'awaiting_payment' where id = o.id;
end $$;

-- Checkouts the reconciler should re-read (DPay: <= 30 reads per run; 'expired' can still flip to 'paid').
create function public.list_reconcilable_checkouts(p_hours integer default 24, p_limit integer default 30)
returns table(checkout_id text, deposit_order_id uuid)
language sql stable security definer set search_path = public as $$
  select s.checkout_id, s.deposit_order_id
  from public.dpay_checkout_sessions s
  join public.deposit_orders o on o.id = s.deposit_order_id
  where o.status in ('awaiting_payment','expired')
    and s.created_at > now() - make_interval(hours => p_hours)
  order by s.created_at
  limit least(p_limit, 30);
$$;

-- ---------------------------------------------------------------- DEPOSIT: the single idempotent transition
-- Called by (a) return-page handler, (b) verified webhook, (c) reconciler. p_checkout is DPay's v2 object or a
-- checkout.* webhook body (same keys; money may be a JSON number or a string — normalised via numeric).
-- Returns: applied | already_paid | quarantined | mismatch | ignored_env | released | noop | unknown_session
create function public.apply_checkout(p_checkout_id text, p_checkout jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare
  s public.dpay_checkout_sessions; o public.deposit_orders; amt numeric; st text; pay jsonb;
  clr uuid; av uuid; tx uuid;
begin
  select * into s from public.dpay_checkout_sessions where checkout_id = p_checkout_id;
  if not found then return 'unknown_session'; end if;
  select * into o from public.deposit_orders where id = s.deposit_order_id for update;     -- serialises concurrent entry points
  perform public._as_actor(null);

  if (p_checkout->>'live') is not null and (p_checkout->>'live')::boolean <> s.live then
    return 'ignored_env';                               -- sandbox event on a live system or vice versa
  end if;

  st  := p_checkout->>'status';
  amt := (p_checkout->>'amount')::numeric;
  if amt is null or amt <> round(amt, 2) or round(amt, 2) <> o.amount
     or coalesce(p_checkout->>'currency', '') <> 'LYD'
     or coalesce(p_checkout->>'reference', '') <> o.ref then
    if o.status in ('awaiting_payment', 'expired') then
      update public.deposit_orders set status = 'needs_review',
             review_reason = 'DPay checkout does not match amount/currency/reference' where id = o.id;
      perform public._notify_staff('deposits.review', 'staff_deposit_mismatch', 'critical',
                                   'عملية شحن غير متطابقة تحتاج مراجعة', null, 'deposit_order', o.id,
                                   '/admin/deposits/' || o.id);
    end if;
    return 'mismatch';                                  -- never credits on mismatch
  end if;

  if st = 'paid' then
    if o.status = 'paid' then return 'already_paid'; end if;
    if o.status not in ('awaiting_payment', 'expired') then return 'quarantined'; end if;
    pay := p_checkout->'payment';
    if pay is null or (pay->>'tx_id') is null then raise exception 'paid_without_payment_details'; end if;

    select id into clr from public.ledger_accounts where code = 'SYS-PROVIDER-CLEARING-LYD';
    select available_account_id into av from public.wallets where user_id = o.user_id;
    tx := public.post_ledger_transaction('deposit:' || o.id, 'deposit', 'deposit_order', o.id,
      'Wallet top-up via DPay (' || p_checkout_id || ')',
      jsonb_build_array(
        jsonb_build_object('account_id', clr, 'direction', 'debit',  'amount', o.amount),
        jsonb_build_object('account_id', av,  'direction', 'credit', 'amount', o.amount)),
      null, null);

    update public.deposit_orders
       set status = 'paid', credited_transaction_id = tx,
           provider_amount_charged = round((pay->>'amount_charged')::numeric, 2),
           provider_fee = (pay->>'fee_amount')::numeric,
           provider_tx_id = pay->>'tx_id'
     where id = o.id;
    update public.dpay_checkout_sessions set status = 'paid' where id = s.id;
    perform public._notify(o.user_id, 'deposit_paid', 'success', 'تم شحن محفظتك بنجاح', null,
                           'deposit_order', o.id, '/wallet/deposits/' || o.id, 'deposit-paid:' || o.id);
    return 'applied';
  end if;

  if st in ('expired', 'cancelled') then
    if o.status = 'awaiting_payment' then
      update public.deposit_orders set status = st::deposit_status where id = o.id;
      update public.dpay_checkout_sessions set status = st where id = s.id;
      perform public._notify(o.user_id, 'deposit_' || st, 'warning', 'لم تكتمل عملية الشحن', null,
                             'deposit_order', o.id, '/wallet/deposits/' || o.id, 'deposit-' || st || ':' || o.id);
      return 'released';
    end if;
    return 'noop';
  end if;

  return 'noop';                                        -- 'open': still payable, nothing to do
end $$;

-- ---------------------------------------------------------------- grants: service_role only
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      '_as_actor','actor_has_permission','_setting','_notify','_notify_staff','_assert_can_trade',
      'create_quote','create_buy_order','buy_order_set_status','release_buy_order','complete_buy_order',
      'create_deposit_order','attach_checkout_session','list_reconcilable_checkouts','apply_checkout')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
