-- 0005_sell_flow_and_payouts.sql
-- Payout methods, SELL flow (customer sends USDT, platform pays LYD), manual payout with two-person approval.
-- STATUS: written, NOT yet executed against a real Postgres.
-- Accounting of a sell order (all legs balanced per currency):
--   deposit approved : Dr company_usdt / Cr trade_clearing_USDT ;  Dr trade_clearing_LYD gross / Cr customer_payable net / Cr fee_revenue fee
--   payout approved  : Dr customer_payable net / Cr customer_available (internal wallet) OR Cr company_cash (bank payout)

-- ---------------------------------------------------------------- schema adjustments
alter table public.payout_methods add column archived_at timestamptz;
alter table public.sell_orders
  add column sender_address text,
  add column proof_path text,
  add column review_note text;

-- A TXID claim that staff rejected must not lock the TXID forever (anti front-running): uniqueness applies to live claims.
alter table public.usdt_transfers drop constraint usdt_transfers_network_code_txid_key;
create unique index usdt_transfers_live_txid on public.usdt_transfers(network_code, txid) where verification <> 'rejected';

-- Late submissions: an expired order may receive a TXID, but only into manual review.
create or replace function public.sell_transition_allowed(f text, t text) returns boolean language sql immutable as $$
  select (f, t) in (
    ('awaiting_deposit','deposit_submitted'),('awaiting_deposit','cancelled'),('awaiting_deposit','expired'),
    ('expired','needs_review'),
    ('deposit_submitted','needs_review'),('deposit_submitted','awaiting_payout'),('deposit_submitted','rejected'),
    ('needs_review','awaiting_payout'),('needs_review','rejected'),('needs_review','deposit_submitted'),
    ('awaiting_payout','completed'),('awaiting_payout','needs_review'));
$$;

-- ---------------------------------------------------------------- helpers
create function public._sod_enabled() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public._setting('security.separation_of_duties'), 'true')::boolean;
$$;

create function public._iban_valid(p text) returns boolean language plpgsql immutable as $$
declare s text; rem bigint := 0; ch text; i integer;
begin
  if p !~ '^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30}$' then return false; end if;
  s := substr(p, 5) || substr(p, 1, 4);
  for i in 1..length(s) loop
    ch := substr(s, i, 1);
    if ch ~ '[0-9]' then rem := (rem * 10 + ch::integer) % 97;
    else rem := (rem * 100 + (ascii(ch) - 55)) % 97; end if;
  end loop;
  return rem = 1;
end $$;

-- returns the normalised IBAN (or null) after validating the fields for the method type
create function public._validate_method(p_type text, p_holder text, p_bank text, p_iban text, p_account text) returns text
language plpgsql immutable as $$
declare v_iban text;
begin
  if p_type not in ('internal_wallet','bank_iban','bank_local','other') then raise exception 'invalid_type'; end if;
  if p_type = 'internal_wallet' then return null; end if;
  if coalesce(btrim(p_holder), '') = '' then raise exception 'holder_required'; end if;
  if coalesce(btrim(p_bank), '') = '' then raise exception 'bank_required'; end if;
  if p_type = 'bank_iban' then
    v_iban := upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g'));
    if not public._iban_valid(v_iban) then raise exception 'invalid_iban'; end if;
    return v_iban;
  elsif p_type = 'bank_local' then
    if coalesce(p_account, '') !~ '^[0-9A-Za-z\-]{4,34}$' then raise exception 'invalid_account_number'; end if;
  end if;
  return null;
end $$;

create function public._method_in_use(p_method uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sell_orders
                 where payout_method_id = p_method and status in ('awaiting_deposit','deposit_submitted','needs_review','awaiting_payout'));
$$;

-- ---------------------------------------------------------------- payout methods (customer-managed)
create function public.create_payout_method(p_user uuid, p_type text, p_holder text, p_bank text,
                                            p_iban text, p_account text, p_default boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_iban text; v_id uuid; v_first boolean;
begin
  perform public._as_actor(p_user);
  if (select status from public.profiles where id = p_user) is distinct from 'active' then raise exception 'account_not_active'; end if;
  if (select count(*) from public.payout_methods where user_id = p_user and archived_at is null) >= 10 then
    raise exception 'too_many_methods'; end if;
  v_iban := public._validate_method(p_type, p_holder, p_bank, p_iban, p_account);
  if p_type = 'internal_wallet' and exists (select 1 from public.payout_methods
        where user_id = p_user and type = 'internal_wallet' and archived_at is null) then
    raise exception 'already_exists'; end if;
  v_first := not exists (select 1 from public.payout_methods where user_id = p_user and archived_at is null);
  if p_default or v_first then update public.payout_methods set is_default = false where user_id = p_user and is_default; end if;
  insert into public.payout_methods(user_id, type, holder_name, bank_name, iban, account_number, is_default)
  values (p_user, p_type, btrim(p_holder), btrim(p_bank), v_iban, p_account, p_default or v_first) returning id into v_id;
  return v_id;
end $$;

create function public.update_payout_method(p_user uuid, p_method uuid, p_holder text, p_bank text,
                                            p_iban text, p_account text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.payout_methods; v_iban text;
begin
  perform public._as_actor(p_user);
  select * into m from public.payout_methods where id = p_method and user_id = p_user and archived_at is null for update;
  if not found then raise exception 'not_found'; end if;
  if public._method_in_use(m.id) then raise exception 'method_in_use'; end if;     -- no edits under an open order
  v_iban := public._validate_method(m.type, p_holder, p_bank, p_iban, p_account);
  update public.payout_methods
     set holder_name = btrim(p_holder), bank_name = btrim(p_bank), iban = v_iban, account_number = p_account,
         verification = 'unverified'                                              -- any edit needs re-verification
   where id = m.id;
end $$;

create function public.set_default_payout_method(p_user uuid, p_method uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._as_actor(p_user);
  if not exists (select 1 from public.payout_methods where id = p_method and user_id = p_user and archived_at is null) then
    raise exception 'not_found'; end if;
  update public.payout_methods set is_default = false where user_id = p_user and is_default;
  update public.payout_methods set is_default = true where id = p_method;
end $$;

create function public.archive_payout_method(p_user uuid, p_method uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._as_actor(p_user);
  if not exists (select 1 from public.payout_methods where id = p_method and user_id = p_user and archived_at is null) then
    raise exception 'not_found'; end if;
  if public._method_in_use(p_method) then raise exception 'method_in_use'; end if;
  update public.payout_methods set archived_at = now(), is_default = false where id = p_method;
end $$;

-- staff: mark a method verified / rejected
create function public.verify_payout_method(p_actor uuid, p_method uuid, p_result text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'sell.review') then raise exception 'forbidden'; end if;
  if p_result not in ('verified','rejected') then raise exception 'invalid_target'; end if;
  update public.payout_methods set verification = p_result where id = p_method and archived_at is null;
  if not found then raise exception 'not_found'; end if;
end $$;

-- ---------------------------------------------------------------- SELL: create
create function public.create_sell_order(p_user uuid, p_quote_id uuid, p_usdt numeric, p_network text, p_method uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  q public.rate_quotes; r public.exchange_rates; n public.supported_networks; da public.deposit_addresses;
  pm public.payout_methods; v_gross numeric; v_fee numeric; v_net numeric; v_window integer; v_id uuid;
begin
  perform public._as_actor(p_user);
  select * into q from public.rate_quotes where id = p_quote_id for update;
  if not found or q.user_id <> p_user or q.side <> 'sell' then raise exception 'quote_invalid'; end if;
  if q.used_at is not null then raise exception 'quote_used'; end if;
  if q.expires_at <= now() then raise exception 'quote_expired'; end if;
  perform public._assert_can_trade(p_user, 'sell');

  if p_usdt is null or p_usdt <= 0 or p_usdt <> trunc(p_usdt, 6) then raise exception 'invalid_amount'; end if;
  select * into r from public.exchange_rates where id = q.rate_id;
  if p_usdt < r.min_sell_usdt or p_usdt > r.max_sell_usdt then raise exception 'out_of_limits'; end if;

  select * into n from public.supported_networks where code = p_network and status = 'active';
  if not found then raise exception 'network_inactive'; end if;
  if p_usdt < n.min_deposit then raise exception 'below_network_minimum'; end if;
  select * into da from public.deposit_addresses where network_code = p_network and status = 'active';
  if not found then raise exception 'no_deposit_address'; end if;

  select * into pm from public.payout_methods where id = p_method and user_id = p_user and archived_at is null;
  if not found or pm.verification = 'rejected' then raise exception 'invalid_payout_method'; end if;

  v_gross := round(p_usdt * q.price, 2);
  v_fee   := round(v_gross * q.fee_pct / 100, 2);
  v_net   := v_gross - v_fee;
  if v_net <= 0 then raise exception 'invalid_amount'; end if;
  v_window := coalesce(public._setting('trading.sell_deposit_window_minutes'), '120')::integer;

  insert into public.sell_orders(user_id, quote_id, price, fee_pct, usdt_expected, lyd_gross, lyd_fee, lyd_net,
                                 network_code, deposit_address_id, payout_method_id, expires_at)
  values (p_user, q.id, q.price, q.fee_pct, p_usdt, v_gross, v_fee, v_net, p_network, da.id, pm.id,
          now() + make_interval(mins => v_window))
  returning id into v_id;
  update public.rate_quotes set used_at = now() where id = q.id;

  perform public._notify(p_user, 'sell_order_created', 'info', 'تم إنشاء طلب البيع', 'أرسل USDT إلى العنوان المعروض ثم قدّم رقم المعاملة',
                         'sell_order', v_id, '/orders/sell/' || v_id, 'sell-created:' || v_id);
  perform public._notify_staff('sell.review', 'staff_new_sell_order', 'info', 'طلب بيع جديد', null,
                               'sell_order', v_id, '/admin/orders/sell/' || v_id);
  return v_id;
end $$;

create function public.cancel_sell_order(p_user uuid, p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.sell_orders;
begin
  perform public._as_actor(p_user);
  select * into o from public.sell_orders where id = p_order and user_id = p_user for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'awaiting_deposit' then raise exception 'illegal_transition'; end if;    -- never after a TXID was submitted
  update public.sell_orders set status = 'cancelled' where id = o.id;
end $$;

-- ---------------------------------------------------------------- SELL: customer submits the TXID (+ optional proof)
create function public.submit_sell_txid(p_user uuid, p_order uuid, p_txid text, p_sender text default null,
                                        p_proof_path text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o public.sell_orders; t uuid; late boolean;
begin
  perform public._as_actor(p_user);
  select * into o from public.sell_orders where id = p_order and user_id = p_user for update;
  if not found then raise exception 'not_found'; end if;
  if o.status not in ('awaiting_deposit', 'expired') then raise exception 'illegal_transition'; end if;
  if char_length(btrim(coalesce(p_txid, ''))) < 8 then raise exception 'invalid_txid'; end if;
  if p_proof_path is not null and left(p_proof_path, 37) <> p_user::text || '/' then raise exception 'invalid_proof_path'; end if;
  late := (o.status = 'expired');

  begin
    insert into public.usdt_transfers(network_code, txid, direction, recorded_by)
    values (o.network_code, btrim(p_txid), 'incoming_from_customer', p_user) returning id into t;
  exception when unique_violation then
    raise exception 'txid_already_used';
  end;

  update public.sell_orders
     set incoming_transfer_id = t, sender_address = nullif(btrim(p_sender), ''), proof_path = p_proof_path,
         status = case when late then 'needs_review' else 'deposit_submitted' end,
         review_note = case when late then 'TXID submitted after order expiry' else review_note end
   where id = o.id;
  perform public._notify_staff('sell.review', case when late then 'staff_sell_late_txid' else 'staff_sell_txid_submitted' end,
                               case when late then 'critical' else 'info' end,
                               case when late then 'تم تقديم TXID بعد انتهاء الطلب' else 'تم تقديم TXID لطلب بيع' end, null,
                               'sell_order', o.id, '/admin/orders/sell/' || o.id);
end $$;

-- ---------------------------------------------------------------- SELL: staff reviews the incoming USDT
-- decision: approve | reject | needs_review
create function public.review_sell_deposit(p_actor uuid, p_order uuid, p_decision text, p_usdt_received numeric,
                                           p_onchain_verified boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  o public.sell_orders; pm public.payout_methods; v_snap jsonb; v_tx uuid;
  cu uuid; clr_u uuid; clr_l uuid; pay uuid; rev uuid;
begin
  perform public._as_actor(p_actor);
  select * into o from public.sell_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if p_actor = o.user_id then raise exception 'self_dealing'; end if;
  if p_decision not in ('approve','reject','needs_review') then raise exception 'invalid_decision'; end if;

  if p_decision = 'approve' then
    if not public.actor_has_permission(p_actor, 'sell.approve_deposit') then raise exception 'forbidden'; end if;
    if o.status not in ('deposit_submitted','needs_review') or o.incoming_transfer_id is null then
      raise exception 'illegal_transition'; end if;
    if p_usdt_received is distinct from o.usdt_expected then raise exception 'amount_mismatch'; end if;   -- reject or re-quote instead
    if not coalesce(p_onchain_verified, false) and coalesce(btrim(p_note), '') = '' then
      raise exception 'note_required'; end if;           -- manual attestation must be documented

    select * into pm from public.payout_methods where id = o.payout_method_id;
    v_snap := jsonb_build_object('method_id', pm.id, 'type', pm.type, 'holder_name', pm.holder_name,
                                 'bank_name', pm.bank_name, 'iban', pm.iban, 'account_number', pm.account_number,
                                 'verification', pm.verification);
    select id into cu    from public.ledger_accounts where code = 'SYS-USDT';
    select id into clr_u from public.ledger_accounts where code = 'SYS-TRADE-CLEARING-USDT';
    select id into clr_l from public.ledger_accounts where code = 'SYS-TRADE-CLEARING-LYD';
    select id into pay   from public.ledger_accounts where code = 'SYS-CUSTOMER-PAYABLE-LYD';
    select id into rev   from public.ledger_accounts where code = 'SYS-FEE-REVENUE-LYD';

    v_tx := public.post_ledger_transaction('sell-accept:' || o.id, 'sell_accept', 'sell_order', o.id,
      'USDT received for sell order; LYD owed to customer',
      jsonb_build_array(
        jsonb_build_object('account_id', cu,    'direction', 'debit',  'amount', o.usdt_expected),
        jsonb_build_object('account_id', clr_u, 'direction', 'credit', 'amount', o.usdt_expected),
        jsonb_build_object('account_id', clr_l, 'direction', 'debit',  'amount', o.lyd_gross),
        jsonb_build_object('account_id', pay,   'direction', 'credit', 'amount', o.lyd_net))
        || case when o.lyd_fee > 0 then jsonb_build_array(
             jsonb_build_object('account_id', rev, 'direction', 'credit', 'amount', o.lyd_fee)) else '[]'::jsonb end,
      null, p_actor);

    update public.usdt_transfers set verification = case when p_onchain_verified then 'verified_onchain' else verification end
     where id = o.incoming_transfer_id;
    update public.sell_orders
       set status = 'awaiting_payout', payout_snapshot = v_snap, usdt_received = p_usdt_received,
           deposit_verified_by = p_actor, deposit_verified_at = now(), review_note = p_note
     where id = o.id;
    perform public._notify(o.user_id, 'sell_usdt_received', 'success', 'تم استلام USDT', 'جارٍ تجهيز الدفع',
                           'sell_order', o.id, '/orders/sell/' || o.id, 'sell-received:' || o.id);
    perform public._notify_staff('payout.execute', 'staff_sell_awaiting_payout', 'info', 'طلب بيع بانتظار الصرف', null,
                                 'sell_order', o.id, '/admin/orders/sell/' || o.id);

  elsif p_decision = 'reject' then
    if not public.actor_has_permission(p_actor, 'sell.review') then raise exception 'forbidden'; end if;
    if o.status not in ('deposit_submitted','needs_review') then raise exception 'illegal_transition'; end if;
    if coalesce(btrim(p_note), '') = '' then raise exception 'reason_required'; end if;
    update public.usdt_transfers set verification = 'rejected' where id = o.incoming_transfer_id;   -- frees the TXID
    update public.sell_orders set status = 'rejected', rejection_reason = p_note where id = o.id;
    perform public._notify(o.user_id, 'sell_rejected', 'warning', 'تعذر اعتماد طلب البيع', p_note,
                           'sell_order', o.id, '/orders/sell/' || o.id, 'sell-rejected:' || o.id);

  else  -- needs_review
    if not public.actor_has_permission(p_actor, 'sell.review') then raise exception 'forbidden'; end if;
    if o.status <> 'deposit_submitted' then raise exception 'illegal_transition'; end if;
    if coalesce(btrim(p_note), '') = '' then raise exception 'reason_required'; end if;
    update public.sell_orders set status = 'needs_review', review_note = p_note where id = o.id;
    perform public._notify(o.user_id, 'sell_more_info', 'warning', 'نحتاج معلومات إضافية لطلب البيع', p_note,
                           'sell_order', o.id, '/orders/sell/' || o.id, 'sell-info:' || o.id || ':' || md5(p_note));
  end if;
end $$;

-- ---------------------------------------------------------------- SELL: payout (record, then a DIFFERENT person approves)
create function public.record_sell_payout(p_actor uuid, p_order uuid, p_external_reference text, p_proof_path text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o public.sell_orders;
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'payout.execute') then raise exception 'forbidden'; end if;
  select * into o from public.sell_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if p_actor = o.user_id then raise exception 'self_dealing'; end if;
  if o.status <> 'awaiting_payout' then raise exception 'illegal_transition'; end if;
  if exists (select 1 from public.payout_records where sell_order_id = o.id) then raise exception 'payout_already_recorded'; end if;
  if public._sod_enabled() and p_actor = o.deposit_verified_by then raise exception 'separation_of_duties'; end if;
  if char_length(btrim(coalesce(p_external_reference, ''))) < 3 then raise exception 'reference_required'; end if;
  if coalesce(public._setting('payout.require_proof'), 'false')::boolean and p_proof_path is null then
    raise exception 'proof_required'; end if;
  insert into public.payout_records(sell_order_id, amount, method_snapshot, external_reference, proof_path, executed_by)
  values (o.id, o.lyd_net, o.payout_snapshot, btrim(p_external_reference), p_proof_path, p_actor);
  perform public._notify_staff('payout.approve', 'staff_payout_needs_approval', 'info', 'صرف بانتظار الاعتماد', null,
                               'sell_order', o.id, '/admin/orders/sell/' || o.id);
end $$;

create function public.approve_sell_payout(p_actor uuid, p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.sell_orders; pr public.payout_records; pay uuid; dest uuid; tx uuid; v_internal boolean;
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'payout.approve') then raise exception 'forbidden'; end if;
  select * into o from public.sell_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if p_actor = o.user_id then raise exception 'self_dealing'; end if;
  if o.status <> 'awaiting_payout' then raise exception 'illegal_transition'; end if;     -- blocks double approval
  select * into pr from public.payout_records where sell_order_id = o.id for update;
  if not found then raise exception 'payout_not_recorded'; end if;
  if pr.approved_by is not null then raise exception 'illegal_transition'; end if;
  if p_actor = pr.executed_by then raise exception 'separation_of_duties'; end if;
  if public._sod_enabled() and p_actor = o.deposit_verified_by then raise exception 'separation_of_duties'; end if;

  v_internal := (o.payout_snapshot->>'type') = 'internal_wallet';
  select id into pay from public.ledger_accounts where code = 'SYS-CUSTOMER-PAYABLE-LYD';
  if v_internal then
    select available_account_id into dest from public.wallets where user_id = o.user_id;
  else
    select id into dest from public.ledger_accounts where code = 'SYS-CASH-LYD';
  end if;
  tx := public.post_ledger_transaction('sell-payout:' || o.id, 'sell_payout', 'sell_order', o.id,
    case when v_internal then 'Sell proceeds credited to internal wallet' else 'Sell proceeds paid out of company cash' end,
    jsonb_build_array(
      jsonb_build_object('account_id', pay,  'direction', 'debit',  'amount', o.lyd_net),
      jsonb_build_object('account_id', dest, 'direction', 'credit', 'amount', o.lyd_net)),
    null, p_actor);

  update public.payout_records set approved_by = p_actor, approved_at = now(), credit_transaction_id = tx where id = pr.id;
  update public.sell_orders set status = 'completed' where id = o.id;
  perform public._notify(o.user_id, 'sell_completed', 'success', 'اكتمل طلب البيع',
                         case when v_internal then 'تمت إضافة المبلغ إلى محفظتك' else 'تم تنفيذ الدفع إلى وسيلة الاستلام' end,
                         'sell_order', o.id, '/orders/sell/' || o.id, 'sell-completed:' || o.id);
end $$;

-- ---------------------------------------------------------------- SELL: expiry sweep (called by a scheduled Edge Function / pg_cron)
create function public.expire_sell_orders() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in select id, user_id from public.sell_orders where status = 'awaiting_deposit' and expires_at < now() for update skip locked loop
    update public.sell_orders set status = 'expired' where id = r.id;
    perform public._notify(r.user_id, 'sell_expired', 'warning', 'انتهت مهلة طلب البيع',
                           'إن كنت قد أرسلت USDT فقدّم رقم المعاملة أو تواصل مع الدعم',
                           'sell_order', r.id, '/orders/sell/' || r.id, 'sell-expired:' || r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- assignment (prevents orders falling between staff)
create function public.assign_order(p_actor uuid, p_kind text, p_order uuid, p_assignee uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur uuid; need text;
begin
  perform public._as_actor(p_actor);
  if p_kind not in ('buy','sell') then raise exception 'invalid_target'; end if;
  need := case p_kind when 'buy' then 'buy.process' else 'sell.review' end;
  if not public.actor_has_permission(p_actor, need) then raise exception 'forbidden'; end if;
  if not public.actor_has_permission(p_assignee, need) then raise exception 'assignee_not_eligible'; end if;
  if p_kind = 'buy' then select assigned_to into cur from public.buy_orders where id = p_order for update;
  else select assigned_to into cur from public.sell_orders where id = p_order for update; end if;
  if not found then raise exception 'not_found'; end if;
  if cur is not null and cur <> p_actor and not public.actor_has_permission(p_actor, 'settings.write') then
    raise exception 'already_assigned'; end if;                         -- only a manager may take over
  if p_kind = 'buy' then update public.buy_orders set assigned_to = p_assignee where id = p_order;
  else update public.sell_orders set assigned_to = p_assignee where id = p_order; end if;
  perform public._notify(p_assignee, 'staff_order_assigned', 'info', 'تم إسناد طلب إليك', null,
                         p_kind || '_order', p_order, '/admin/orders/' || p_kind || '/' || p_order,
                         'assigned:' || p_order || ':' || p_assignee);
end $$;

-- ---------------------------------------------------------------- grants: service_role only
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      '_sod_enabled','_method_in_use','create_payout_method','update_payout_method','set_default_payout_method',
      'archive_payout_method','verify_payout_method','create_sell_order','cancel_sell_order','submit_sell_txid',
      'review_sell_deposit','record_sell_payout','approve_sell_payout','expire_sell_orders','assign_order')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
