-- 0006_admin_support_ops.sql
-- Admin actions, two-person ledger adjustments, order policy checks, support, Web Push, health/ops checks,
-- reports, private storage. STATUS: written, NOT yet executed against a real Postgres.

-- ---------------------------------------------------------------- order policy: daily limit + large-order flag
alter table public.buy_orders  add column flagged_large boolean not null default false;
alter table public.sell_orders add column flagged_large boolean not null default false;

create function public.order_policy_checks() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_limit numeric; v_large numeric; v_used numeric; v_day timestamptz;
begin
  v_day   := date_trunc('day', now() at time zone 'Africa/Tripoli') at time zone 'Africa/Tripoli';
  v_limit := nullif(public._setting('trading.user_daily_limit_lyd'), '')::numeric;   -- unset => no limit
  v_large := nullif(public._setting('trading.large_order_lyd'), '')::numeric;
  if v_limit is not null then
    if tg_table_name = 'buy_orders' then
      select coalesce(sum(lyd_gross), 0) into v_used from public.buy_orders
       where user_id = new.user_id and created_at >= v_day and status not in ('rejected','cancelled','failed');
    else
      select coalesce(sum(lyd_gross), 0) into v_used from public.sell_orders
       where user_id = new.user_id and created_at >= v_day and status not in ('rejected','cancelled','expired','failed');
    end if;
    if v_used + new.lyd_gross > v_limit then raise exception 'daily_limit_exceeded'; end if;
  end if;
  if v_large is not null and new.lyd_gross >= v_large then new.flagged_large := true; end if;
  return new;
end $$;
create trigger buy_orders_policy  before insert on public.buy_orders  for each row execute function public.order_policy_checks();
create trigger sell_orders_policy before insert on public.sell_orders for each row execute function public.order_policy_checks();

create function public.notify_large_order() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.flagged_large then
    perform public._notify_staff(case tg_table_name when 'buy_orders' then 'buy.process' else 'sell.review' end,
      'staff_large_order', 'critical', 'عملية ذات قيمة كبيرة تحتاج انتباهًا', null,
      case tg_table_name when 'buy_orders' then 'buy_order' else 'sell_order' end, new.id,
      '/admin/orders/' || case tg_table_name when 'buy_orders' then 'buy/' else 'sell/' end || new.id);
  end if;
  return null;
end $$;
create trigger buy_orders_large  after insert on public.buy_orders  for each row execute function public.notify_large_order();
create trigger sell_orders_large after insert on public.sell_orders for each row execute function public.notify_large_order();

create trigger profiles_audit after update on public.profiles for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- calculation preview (same math as production)
create function public.preview_calc(p_side text, p_price numeric, p_fee_pct numeric, p_lyd numeric, p_usdt numeric) returns jsonb
language plpgsql immutable as $$
declare v_usdt numeric; v_gross numeric; v_fee numeric;
begin
  if p_price is null or p_price <= 0 then raise exception 'invalid_price'; end if;
  if p_side = 'buy' and p_usdt is null then v_usdt := trunc(p_lyd / p_price, 6); else v_usdt := p_usdt; end if;
  if v_usdt is null or v_usdt <= 0 then raise exception 'invalid_amount'; end if;
  v_gross := round(v_usdt * p_price, 2);
  v_fee := round(v_gross * p_fee_pct / 100, 2);
  return jsonb_build_object('usdt', v_usdt, 'gross_lyd', v_gross, 'fee_lyd', v_fee,
           'total_lyd', case when p_side = 'buy' then v_gross + v_fee end,
           'net_lyd',   case when p_side = 'sell' then v_gross - v_fee end);
end $$;
grant execute on function public.preview_calc(text, numeric, numeric, numeric, numeric) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- admin: rates
create function public.publish_rate(p_actor uuid, p_sell_price numeric, p_buy_price numeric,
    p_buy_fee_pct numeric, p_sell_fee_pct numeric, p_min_buy_lyd numeric, p_max_buy_lyd numeric,
    p_min_sell_usdt numeric, p_max_sell_usdt numeric, p_valid_from timestamptz default null,
    p_valid_to timestamptz default null, p_note text default null, p_confirm_large boolean default false,
    p_notify boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare cur public.exchange_rates; v_id uuid; v_max_pct numeric;
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'rates.write') then raise exception 'forbidden'; end if;
  select * into cur from public.exchange_rates
   where valid_from <= now() and (valid_to is null or valid_to > now()) order by valid_from desc, created_at desc limit 1;
  v_max_pct := coalesce(public._setting('rates.max_change_pct'), '10')::numeric;
  if found and not coalesce(p_confirm_large, false) and
     (abs(p_sell_price / cur.sell_price - 1) * 100 > v_max_pct or abs(p_buy_price / cur.buy_price - 1) * 100 > v_max_pct) then
    raise exception 'large_rate_change_confirm_required';          -- fat-finger guard
  end if;
  insert into public.exchange_rates(sell_price, buy_price, buy_fee_pct, sell_fee_pct, min_buy_lyd, max_buy_lyd,
                                    min_sell_usdt, max_sell_usdt, valid_from, valid_to, note, created_by)
  values (p_sell_price, p_buy_price, p_buy_fee_pct, p_sell_fee_pct, p_min_buy_lyd, p_max_buy_lyd,
          p_min_sell_usdt, p_max_sell_usdt, coalesce(p_valid_from, now()), p_valid_to, p_note, p_actor)
  returning id into v_id;                                           -- existing orders/quotes keep their frozen price
  if p_notify then
    insert into public.notifications(user_id, type, level, title, body, link, dedupe_key)
    select id, 'rate_changed', 'info', 'تم تحديث أسعار الشراء والبيع', null, '/prices', 'rate:' || v_id
      from public.profiles where status = 'active' on conflict (user_id, dedupe_key) do nothing;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------- admin: settings (with go-live gate)
create function public.update_setting(p_actor uuid, p_key text, p_value jsonb, p_confirm text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_missing text[] := '{}';
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'settings.write') then raise exception 'forbidden'; end if;
  if p_key like '%\_enabled' and jsonb_typeof(p_value) <> 'boolean' then raise exception 'invalid_value'; end if;
  if p_key = 'payments.dpay_live_approved' and not exists (
       select 1 from public.user_roles where user_id = p_actor and role = 'super_admin' and revoked_at is null) then
    raise exception 'forbidden';                                    -- only a super admin may attest the provider's approval
  end if;
  if p_key = 'payments.dpay_mode' then
    if p_value not in ('"sandbox"'::jsonb, '"live"'::jsonb) then raise exception 'invalid_value'; end if;
    if p_value = '"live"'::jsonb then
      if p_confirm is distinct from 'GO LIVE' then raise exception 'confirmation_required'; end if;
      if coalesce(public._setting('payments.dpay_live_approved'), 'false') <> 'true' then v_missing := v_missing || 'dpay_written_approval'; end if;
      if public._setting('payments.topup_min_lyd') is null or public._setting('payments.topup_max_lyd') is null then v_missing := v_missing || 'topup_limits'; end if;
      if not exists (select 1 from public.exchange_rates) then v_missing := v_missing || 'exchange_rate'; end if;
      if not exists (select 1 from public.supported_networks where status = 'active') then v_missing := v_missing || 'active_network'; end if;
      if array_length(v_missing, 1) > 0 then raise exception 'live_readiness_failed: %', array_to_string(v_missing, ','); end if;
    end if;
  end if;
  insert into public.admin_settings(key, value, updated_by) values (p_key, p_value, p_actor)
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
end $$;

-- ---------------------------------------------------------------- admin: roles and account status
create function public._is_super_admin(p_user uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = p_user and role = 'super_admin' and revoked_at is null);
$$;

create function public.grant_role(p_actor uuid, p_user uuid, p_role staff_role) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'roles.manage') then raise exception 'forbidden'; end if;
  if p_actor = p_user then raise exception 'self_dealing'; end if;
  if p_role in ('super_admin', 'admin') and not public._is_super_admin(p_actor) then raise exception 'forbidden'; end if;
  if (select status from public.profiles where id = p_user) is distinct from 'active' then raise exception 'target_not_active'; end if;
  insert into public.user_roles(user_id, role, granted_by) values (p_user, p_role, p_actor)
  on conflict (user_id, role) do update set revoked_at = null, granted_by = excluded.granted_by, granted_at = now();
  perform public._notify(p_user, 'security_role_granted', 'warning', 'تم تغيير صلاحيات حسابك', null, null, null, null,
                         'role:' || p_role || ':' || extract(epoch from now())::bigint);
end $$;

create function public.revoke_role(p_actor uuid, p_user uuid, p_role staff_role) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'roles.manage') then raise exception 'forbidden'; end if;
  if p_role in ('super_admin', 'admin') and not public._is_super_admin(p_actor) then raise exception 'forbidden'; end if;
  if p_role = 'super_admin' and (select count(*) from public.user_roles
        where role = 'super_admin' and revoked_at is null and user_id <> p_user) = 0 then
    raise exception 'last_super_admin';
  end if;
  update public.user_roles set revoked_at = now() where user_id = p_user and role = p_role and revoked_at is null;
  if not found then raise exception 'not_found'; end if;
  perform public._notify(p_user, 'security_role_revoked', 'warning', 'تم تغيير صلاحيات حسابك', null, null, null, null,
                         'role-rev:' || p_role || ':' || extract(epoch from now())::bigint);
end $$;

create function public.set_user_status(p_actor uuid, p_user uuid, p_status account_status, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'users.restrict') then raise exception 'forbidden'; end if;
  if p_actor = p_user then raise exception 'self_dealing'; end if;
  if public._is_super_admin(p_user) and not public._is_super_admin(p_actor) then raise exception 'forbidden'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'reason_required'; end if;
  update public.profiles set status = p_status where id = p_user;
  if not found then raise exception 'not_found'; end if;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, note, after_data)
  values (p_actor, 'set_status', 'profiles', p_user::text, p_reason, jsonb_build_object('status', p_status));
  perform public._notify(p_user, 'security_account_status', case when p_status = 'active' then 'info' else 'critical' end,
                         'تم تحديث حالة حسابك', 'للاستفسار تواصل مع الدعم الفني', null, null, '/support',
                         'status:' || p_status || ':' || extract(epoch from now())::bigint);
end $$;

-- ---------------------------------------------------------------- exceptional ledger adjustments (always two people)
insert into public.ledger_accounts(code, name, kind, currency) values
  ('SYS-SUSPENSE-USDT', 'Reconciliation suspense (USDT)', 'suspense', 'USDT');

create table public.adjustment_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.profiles(id),
  approved_by uuid references public.profiles(id),
  account_id uuid not null references public.ledger_accounts(id),
  direction ledger_direction not null,
  amount numeric(24,8) not null check (amount > 0),
  reason text not null check (char_length(btrim(reason)) >= 10),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decision_note text,
  ledger_transaction_id uuid unique references public.ledger_transactions(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (approved_by is null or approved_by <> requested_by),
  check ((status = 'approved') = (ledger_transaction_id is not null))
);
create trigger adjustment_requests_audit after insert or update on public.adjustment_requests
  for each row execute function public.audit_row_change();

create function public.request_adjustment(p_actor uuid, p_account uuid, p_direction ledger_direction,
                                          p_amount numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare a public.ledger_accounts; v_id uuid;
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'ledger.adjust') then raise exception 'forbidden'; end if;
  select * into a from public.ledger_accounts where id = p_account;
  if not found or a.kind = 'suspense' then raise exception 'invalid_account'; end if;
  insert into public.adjustment_requests(requested_by, account_id, direction, amount, reason)
  values (p_actor, p_account, p_direction, p_amount, p_reason) returning id into v_id;
  perform public._notify_staff('ledger.adjust', 'staff_adjustment_pending', 'warning', 'طلب تسوية مالية بانتظار الاعتماد', null,
                               'adjustment', v_id, '/admin/adjustments/' || v_id);
  return v_id;
end $$;

create function public.decide_adjustment(p_actor uuid, p_request uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.adjustment_requests; a public.ledger_accounts; sus uuid; tx uuid;
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'ledger.adjust') then raise exception 'forbidden'; end if;
  select * into r from public.adjustment_requests where id = p_request for update;
  if not found then raise exception 'not_found'; end if;
  if r.status <> 'pending' then raise exception 'illegal_transition'; end if;
  if p_actor = r.requested_by then raise exception 'separation_of_duties'; end if;   -- not configurable
  if not p_approve then
    update public.adjustment_requests set status = 'rejected', approved_by = null, decision_note = p_note, decided_at = now() where id = r.id;
    return;
  end if;
  select * into a from public.ledger_accounts where id = r.account_id;
  select id into sus from public.ledger_accounts where code = case a.currency when 'LYD' then 'SYS-SUSPENSE-LYD' else 'SYS-SUSPENSE-USDT' end;
  tx := public.post_ledger_transaction('adjust:' || r.id, 'adjustment', 'adjustment', r.id, 'Approved adjustment: ' || r.reason,
    jsonb_build_array(
      jsonb_build_object('account_id', r.account_id, 'direction', r.direction, 'amount', r.amount),
      jsonb_build_object('account_id', sus, 'direction', case r.direction when 'debit' then 'credit' else 'debit' end, 'amount', r.amount)),
    null, p_actor);
  update public.adjustment_requests set status = 'approved', approved_by = p_actor, decision_note = p_note,
         ledger_transaction_id = tx, decided_at = now() where id = r.id;
end $$;

-- ---------------------------------------------------------------- support
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 8)),
  user_id uuid not null references public.profiles(id),
  category text not null check (category in ('deposit_issue','buy_issue','sell_issue','transfer_delay',
                                             'account_data','financial_inquiry','complaint','other')),
  subject text not null check (char_length(btrim(subject)) between 3 and 200),
  related_type text check (related_type in ('deposit_order','buy_order','sell_order')),
  related_id uuid,
  status text not null default 'pending_staff' check (status in ('pending_staff','pending_customer','closed')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assigned_to uuid references public.profiles(id),
  reopen_count integer not null default 0 check (reopen_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  first_response_at timestamptz,
  closed_at timestamptz,
  check ((related_type is null) = (related_id is null))
);
create index support_tickets_user_idx on public.support_tickets(user_id, created_at desc);
create index support_tickets_queue_idx on public.support_tickets(status, priority, created_at);

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id),
  author_id uuid not null references public.profiles(id),
  is_staff boolean not null,
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  attachment_path text,
  created_at timestamptz not null default now()
);
create index support_messages_ticket_idx on public.support_messages(ticket_id, created_at);

create function public.forbid_mutation() returns trigger language plpgsql as $$
begin raise exception '% is append-only (% forbidden)', tg_table_name, tg_op; end $$;
create trigger support_messages_immutable before update or delete on public.support_messages
  for each row execute function public.forbid_mutation();

create function public.create_ticket(p_user uuid, p_category text, p_subject text, p_body text,
    p_related_type text default null, p_related_id uuid default null, p_attachment text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_owner uuid;
begin
  perform public._as_actor(p_user);
  if (select status from public.profiles where id = p_user) is null then raise exception 'not_found'; end if;
  if (select count(*) from public.support_tickets where user_id = p_user and status <> 'closed') >= 5 then
    raise exception 'too_many_open_tickets'; end if;
  if p_attachment is not null and left(p_attachment, 37) <> p_user::text || '/' then raise exception 'invalid_attachment_path'; end if;
  if p_related_type is not null then
    select user_id into v_owner from (
      select user_id, id, 'deposit_order' t from public.deposit_orders
      union all select user_id, id, 'buy_order' from public.buy_orders
      union all select user_id, id, 'sell_order' from public.sell_orders) x
     where t = p_related_type and id = p_related_id;
    if v_owner is distinct from p_user then raise exception 'related_not_found'; end if;   -- cannot attach someone else's order
  end if;
  insert into public.support_tickets(user_id, category, subject, related_type, related_id)
  values (p_user, p_category, btrim(p_subject), p_related_type, p_related_id) returning id into v_id;
  insert into public.support_messages(ticket_id, author_id, is_staff, body, attachment_path)
  values (v_id, p_user, false, p_body, p_attachment);
  perform public._notify_staff('support.reply', 'staff_new_ticket', 'info', 'تذكرة دعم جديدة', null, 'ticket', v_id, '/admin/support/' || v_id);
  return v_id;
end $$;

create function public.reply_ticket(p_actor uuid, p_ticket uuid, p_body text, p_attachment text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare t public.support_tickets; v_staff boolean; v_msg uuid;
begin
  perform public._as_actor(p_actor);
  select * into t from public.support_tickets where id = p_ticket for update;
  if not found then raise exception 'not_found'; end if;
  v_staff := p_actor <> t.user_id;
  if v_staff and not public.actor_has_permission(p_actor, 'support.reply') then raise exception 'forbidden'; end if;
  if t.status = 'closed' then raise exception 'ticket_closed'; end if;
  if p_attachment is not null and left(p_attachment, 37) <> p_actor::text || '/' then raise exception 'invalid_attachment_path'; end if;
  insert into public.support_messages(ticket_id, author_id, is_staff, body, attachment_path)
  values (t.id, p_actor, v_staff, p_body, p_attachment) returning id into v_msg;
  update public.support_tickets
     set status = case when v_staff then 'pending_customer' else 'pending_staff' end,
         updated_at = now(),
         first_response_at = case when v_staff then coalesce(first_response_at, now()) else first_response_at end,
         assigned_to = case when v_staff then coalesce(assigned_to, p_actor) else assigned_to end
   where id = t.id;
  if v_staff then
    perform public._notify(t.user_id, 'support_reply', 'info', 'رد جديد من الدعم الفني', null,
                           'ticket', t.id, '/support/' || t.id, 'ticket-reply:' || v_msg);
  end if;
  return v_msg;
end $$;

create function public.close_ticket(p_actor uuid, p_ticket uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t public.support_tickets;
begin
  perform public._as_actor(p_actor);
  select * into t from public.support_tickets where id = p_ticket for update;
  if not found then raise exception 'not_found'; end if;
  if p_actor <> t.user_id and not public.actor_has_permission(p_actor, 'support.reply') then raise exception 'forbidden'; end if;
  if t.status = 'closed' then return; end if;
  update public.support_tickets set status = 'closed', closed_at = now(), updated_at = now() where id = t.id;
end $$;

-- Reopen policy: only the customer, within 7 days of closing, at most 3 times.
create function public.reopen_ticket(p_user uuid, p_ticket uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t public.support_tickets;
begin
  perform public._as_actor(p_user);
  select * into t from public.support_tickets where id = p_ticket and user_id = p_user for update;
  if not found then raise exception 'not_found'; end if;
  if t.status <> 'closed' then raise exception 'illegal_transition'; end if;
  if t.closed_at < now() - interval '7 days' then raise exception 'reopen_window_passed'; end if;
  if t.reopen_count >= 3 then raise exception 'reopen_limit'; end if;
  update public.support_tickets set status = 'pending_staff', closed_at = null, reopen_count = reopen_count + 1, updated_at = now() where id = t.id;
  perform public._notify_staff('support.reply', 'staff_ticket_reopened', 'warning', 'تمت إعادة فتح تذكرة', null, 'ticket', t.id, '/admin/support/' || t.id);
end $$;

create function public.set_ticket_meta(p_actor uuid, p_ticket uuid, p_priority text, p_assignee uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'support.reply') then raise exception 'forbidden'; end if;
  if p_assignee is not null and not public.actor_has_permission(p_assignee, 'support.reply') then raise exception 'assignee_not_eligible'; end if;
  update public.support_tickets set priority = coalesce(p_priority, priority), assigned_to = coalesce(p_assignee, assigned_to), updated_at = now()
   where id = p_ticket;
  if not found then raise exception 'not_found'; end if;
end $$;

-- ---------------------------------------------------------------- Web Push subscriptions
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id) where revoked_at is null;

create function public.register_push_subscription(p_user uuid, p_endpoint text, p_p256dh text, p_auth text, p_ua text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_endpoint !~ '^https://' then raise exception 'invalid_endpoint'; end if;
  insert into public.push_subscriptions(user_id, endpoint, p256dh, auth, user_agent)
  values (p_user, p_endpoint, p_p256dh, p_auth, left(p_ua, 300))
  on conflict (endpoint) do update                       -- same device, new account / rotated keys
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, last_seen_at = now(), revoked_at = null;
end $$;

create function public.revoke_push_subscription(p_user uuid, p_endpoint text) returns void
language sql security definer set search_path = public as $$
  update public.push_subscriptions set revoked_at = now() where endpoint = p_endpoint and user_id = p_user;
$$;

-- ---------------------------------------------------------------- health checks & operational monitors
create table public.system_health_checks (
  id bigint generated always as identity primary key,
  check_name text not null,
  status text not null check (status in ('ok','degraded','down')),
  detail jsonb,
  checked_at timestamptz not null default now()
);
create index system_health_checks_idx on public.system_health_checks(check_name, checked_at desc);

create function public.record_health_check(p_name text, p_status text, p_detail jsonb default null) returns void
language sql security definer set search_path = public as $$
  insert into public.system_health_checks(check_name, status, detail) values (p_name, p_status, p_detail);
$$;

create function public._acct_net_debit(p_code text) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(case e.direction when 'debit' then e.amount else -e.amount end), 0)
  from public.ledger_entries e join public.ledger_accounts a on a.id = e.account_id where a.code = p_code;
$$;

create function public.run_ops_checks() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_mis integer; v_day uuid := md5('ops:' || current_date)::uuid; v_cash numeric; v_usdt numeric;
  v_min_cash numeric; v_min_usdt numeric; v_sla integer; r record; v_alerts text[] := '{}';
begin
  select count(*) into v_mis from public.v_wallet_ledger_mismatch;
  perform public.record_health_check('wallet_ledger_consistency', case when v_mis = 0 then 'ok' else 'down' end, jsonb_build_object('mismatches', v_mis));
  if v_mis > 0 then
    perform public._notify_staff('reports.read', 'staff_ledger_mismatch', 'critical', 'اختلاف بين أرصدة المحافظ والدفتر', null, 'ops', v_day, '/admin/reports');
    v_alerts := v_alerts || 'ledger_mismatch';
  end if;

  v_cash := public._acct_net_debit('SYS-CASH-LYD'); v_usdt := public._acct_net_debit('SYS-USDT');
  v_min_cash := nullif(public._setting('ops.min_liquidity_lyd'), '')::numeric;
  v_min_usdt := nullif(public._setting('ops.min_usdt_inventory'), '')::numeric;
  if v_min_cash is not null and v_cash < v_min_cash then
    perform public._notify_staff('reports.read', 'staff_low_lyd_liquidity', 'critical', 'انخفاض السيولة بالدينار', null, 'ops', v_day, '/admin/reports');
    v_alerts := v_alerts || 'low_lyd';
  end if;
  if v_min_usdt is not null and v_usdt < v_min_usdt then
    perform public._notify_staff('reports.read', 'staff_low_usdt', 'critical', 'انخفاض رصيد USDT', null, 'ops', v_day, '/admin/reports');
    v_alerts := v_alerts || 'low_usdt';
  end if;
  perform public.record_health_check('liquidity', case when cardinality(v_alerts) = 0 then 'ok' else 'degraded' end,
                                     jsonb_build_object('cash_lyd', v_cash, 'usdt', v_usdt));

  v_sla := nullif(public._setting('ops.sla_minutes'), '')::integer;
  if v_sla is not null then
    for r in
      select id, 'buy' as k from public.buy_orders where status in ('pending_review','approved','processing') and created_at < now() - make_interval(mins => v_sla)
      union all select id, 'sell' from public.sell_orders where status in ('deposit_submitted','needs_review','awaiting_payout') and updated_at < now() - make_interval(mins => v_sla)
    loop
      perform public._notify_staff(case r.k when 'buy' then 'buy.process' else 'sell.review' end, 'staff_sla_breach', 'warning',
                                   'طلب متأخر عن مهلة المعالجة', null, r.k || '_order', r.id, '/admin/orders/' || r.k || '/' || r.id);
    end loop;
  end if;
  return jsonb_build_object('mismatches', v_mis, 'cash_lyd', v_cash, 'usdt', v_usdt, 'alerts', v_alerts);
end $$;

-- ---------------------------------------------------------------- reports (permission-checked, jsonb)
create function public.admin_dashboard(p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_day timestamptz := date_trunc('day', now() at time zone 'Africa/Tripoli') at time zone 'Africa/Tripoli';
begin
  if not public.actor_has_permission(p_actor, 'reports.read') then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'users_total',  (select count(*) from public.profiles),
    'users_active', (select count(*) from public.profiles where status = 'active'),
    'deposits_pending', (select count(*) from public.deposit_orders where status in ('pending','awaiting_payment')),
    'deposits_paid',    (select count(*) from public.deposit_orders where status = 'paid'),
    'buy_open',  (select count(*) from public.buy_orders  where status in ('pending_review','approved','processing','needs_attention')),
    'sell_open', (select count(*) from public.sell_orders where status in ('awaiting_deposit','deposit_submitted','needs_review','awaiting_payout')),
    'needs_attention', (select (select count(*) from public.deposit_orders where status = 'needs_review')
                             + (select count(*) from public.buy_orders where status = 'needs_attention')
                             + (select count(*) from public.sell_orders where status = 'needs_review')),
    'orders_today',  (select (select count(*) from public.buy_orders where created_at >= v_day) + (select count(*) from public.sell_orders where created_at >= v_day)),
    'failed_today',  (select (select count(*) from public.buy_orders where created_at >= v_day and status in ('failed','rejected'))
                           + (select count(*) from public.sell_orders where created_at >= v_day and status in ('failed','rejected'))
                           + (select count(*) from public.deposit_orders where created_at >= v_day and status = 'failed')),
    'wallet_available_total', (select coalesce(sum(available), 0) from public.wallets),
    'wallet_held_total',      (select coalesce(sum(held), 0) from public.wallets),
    'customer_payable_lyd',   -public._acct_net_debit('SYS-CUSTOMER-PAYABLE-LYD'),
    'company_cash_lyd',       public._acct_net_debit('SYS-CASH-LYD'),
    'provider_clearing_lyd',  public._acct_net_debit('SYS-PROVIDER-CLEARING-LYD'),
    'company_usdt',           public._acct_net_debit('SYS-USDT'),
    'reconciliation_mismatches', (select count(*) from public.v_wallet_ledger_mismatch));
end $$;

create function public.admin_report(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.actor_has_permission(p_actor, 'reports.read') then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'deposits', (select jsonb_build_object('paid_count', count(*) filter (where status = 'paid'),
                  'paid_total_lyd', coalesce(sum(amount) filter (where status = 'paid'), 0),
                  'failed_count', count(*) filter (where status in ('failed','expired','cancelled')),
                  'pending_count', count(*) filter (where status in ('pending','awaiting_payment')),
                  'provider_fees_reported', coalesce(sum(provider_fee) filter (where status = 'paid'), 0))
                 from public.deposit_orders where created_at >= p_from and created_at < p_to),
    'buy', (select jsonb_build_object('count', count(*), 'completed', count(*) filter (where status = 'completed'),
                  'rejected', count(*) filter (where status in ('rejected','cancelled','failed')),
                  'pending', count(*) filter (where status in ('pending_review','approved','processing','needs_attention')),
                  'completed_volume_lyd', coalesce(sum(lyd_gross) filter (where status = 'completed'), 0),
                  'completed_usdt', coalesce(sum(usdt_amount) filter (where status = 'completed'), 0),
                  'fees_lyd', coalesce(sum(lyd_fee) filter (where status = 'completed'), 0))
            from public.buy_orders where created_at >= p_from and created_at < p_to),
    'sell', (select jsonb_build_object('count', count(*), 'completed', count(*) filter (where status = 'completed'),
                  'rejected', count(*) filter (where status in ('rejected','cancelled','expired','failed')),
                  'pending', count(*) filter (where status in ('awaiting_deposit','deposit_submitted','needs_review','awaiting_payout')),
                  'completed_volume_lyd', coalesce(sum(lyd_gross) filter (where status = 'completed'), 0),
                  'completed_usdt', coalesce(sum(usdt_received) filter (where status = 'completed'), 0),
                  'fees_lyd', coalesce(sum(lyd_fee) filter (where status = 'completed'), 0))
             from public.sell_orders where created_at >= p_from and created_at < p_to),
    'payouts_total_lyd', (select coalesce(sum(amount), 0) from public.payout_records where approved_at >= p_from and approved_at < p_to),
    'fee_revenue_lyd', (select coalesce(sum(case e.direction when 'credit' then e.amount else -e.amount end), 0)
                          from public.ledger_entries e join public.ledger_accounts a on a.id = e.account_id
                         where a.code = 'SYS-FEE-REVENUE-LYD' and e.created_at >= p_from and e.created_at < p_to),
    'adjustments_approved', (select count(*) from public.adjustment_requests where status = 'approved' and decided_at >= p_from and decided_at < p_to),
    'liabilities', jsonb_build_object(
        'customer_wallets_lyd', (select coalesce(sum(available + held), 0) from public.wallets),
        'customer_payable_lyd', -public._acct_net_debit('SYS-CUSTOMER-PAYABLE-LYD'),
        'company_cash_lyd', public._acct_net_debit('SYS-CASH-LYD'),
        'provider_clearing_lyd', public._acct_net_debit('SYS-PROVIDER-CLEARING-LYD'),
        'note', 'Compare liabilities with cash + provider clearing; the internal balance is not assumed to equal real liquidity'),
    'reconciliation_mismatches', (select count(*) from public.v_wallet_ledger_mismatch),
    -- Deliberately NOT computed: needs a USDT cost basis and a network/transfer cost ledger that do not exist yet.
    'net_profit', null,
    'net_profit_note', 'not computed: volume, fees and spread are reported separately; net profit requires cost basis and network costs');
end $$;

-- ---------------------------------------------------------------- RLS for new tables
alter table public.adjustment_requests enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.system_health_checks enable row level security;

revoke all on public.adjustment_requests, public.support_tickets, public.support_messages,
              public.push_subscriptions, public.system_health_checks from anon, authenticated;
grant select on public.adjustment_requests, public.support_tickets, public.support_messages,
                public.push_subscriptions, public.system_health_checks to authenticated;

create policy adjustments_staff on public.adjustment_requests for select to authenticated
  using (public.has_permission('ledger.adjust') or public.has_permission('reports.read'));
create policy tickets_own on public.support_tickets for select to authenticated
  using (user_id = auth.uid() or public.has_permission('support.reply'));
create policy ticket_messages_own on public.support_messages for select to authenticated
  using (exists (select 1 from public.support_tickets t where t.id = ticket_id
                 and (t.user_id = auth.uid() or public.has_permission('support.reply'))));
create policy push_own on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy health_staff on public.system_health_checks for select to authenticated using (public.has_permission('settings.read'));

alter publication supabase_realtime add table public.support_messages, public.support_tickets;

-- ---------------------------------------------------------------- private storage (proofs, support attachments)
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types) values
  ('proofs',  'proofs',  false, 5242880, array['image/jpeg','image/png','image/webp','application/pdf']),
  ('support', 'support', false, 5242880, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

create policy storage_insert_own_folder on storage.objects for insert to authenticated
  with check (bucket_id in ('proofs','support') and (storage.foldername(name))[1] = auth.uid()::text);
create policy storage_select_own_or_staff on storage.objects for select to authenticated
  using (bucket_id in ('proofs','support') and (
        (storage.foldername(name))[1] = auth.uid()::text
     or (bucket_id = 'proofs'  and public.has_permission('orders.read'))
     or (bucket_id = 'support' and public.has_permission('support.reply'))));
-- no UPDATE / DELETE policies: uploaded evidence cannot be replaced or removed from the client.

-- ---------------------------------------------------------------- scheduling (only if pg_cron is available)
do $$
begin
  begin create extension if not exists pg_cron; exception when others then null; end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('expire-sell-orders', '* * * * *', 'select public.expire_sell_orders()');
    perform cron.schedule('ops-checks', '*/5 * * * *', 'select public.run_ops_checks()');
  end if;
end $$;

-- ---------------------------------------------------------------- grants: service_role only
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'publish_rate','update_setting','_is_super_admin','grant_role','revoke_role','set_user_status',
      'request_adjustment','decide_adjustment','create_ticket','reply_ticket','close_ticket','reopen_ticket',
      'set_ticket_meta','register_push_subscription','revoke_push_subscription','record_health_check',
      '_acct_net_debit','run_ops_checks','admin_dashboard','admin_report','order_policy_checks','notify_large_order')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
