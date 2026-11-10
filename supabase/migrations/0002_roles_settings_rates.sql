-- 0002_roles_settings_rates.sql
-- Roles & permissions, append-only audit log, settings (no secrets), networks, deposit addresses, versioned rates.
-- STATUS: written, NOT yet executed against a real Postgres.
-- Design note: the spec lists exchange_rates + exchange_rate_history. Here exchange_rates is itself an
-- append-only version table (every change = a new immutable row), so history is the table; no duplicate store.

-- ---------------------------------------------------------------- roles & permissions
create type staff_role as enum (
  'super_admin','admin','finance_manager','buy_operator','sell_operator',
  'deposit_reviewer','support_agent','auditor');

create table public.permissions (
  code text primary key,
  description text not null
);
create table public.role_permissions (
  role staff_role not null,
  permission text not null references public.permissions(code) on delete restrict,
  primary key (role, permission)
);
create table public.user_roles (
  user_id uuid not null references public.profiles(id) on delete restrict,
  role staff_role not null,
  granted_by uuid references public.profiles(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (user_id, role)
);

insert into public.permissions(code, description) values
  ('orders.read','Read all orders'),
  ('buy.process','Start/return/reject buy orders'),
  ('buy.complete','Confirm USDT transfer for a buy order'),
  ('sell.review','Review incoming USDT for sell orders'),
  ('sell.approve_deposit','Approve that customer USDT arrived'),
  ('payout.execute','Record an external LYD payout'),
  ('payout.approve','Approve a recorded payout (second person)'),
  ('deposits.review','Review quarantined/mismatched deposits'),
  ('rates.write','Publish exchange rates and fees'),
  ('settings.read','Read non-public settings'),
  ('settings.write','Change settings'),
  ('users.read','Read customer profiles and balances'),
  ('users.restrict','Suspend / restrict customer accounts'),
  ('roles.manage','Grant or revoke staff roles'),
  ('audit.read','Read audit log'),
  ('support.reply','Handle support tickets'),
  ('ledger.adjust','Propose/approve exceptional ledger adjustments'),
  ('reports.read','Read financial reports');

insert into public.role_permissions(role, permission)
  select 'super_admin', code from public.permissions;
insert into public.role_permissions(role, permission) values
  ('admin','orders.read'),('admin','users.read'),('admin','users.restrict'),('admin','settings.read'),
  ('admin','settings.write'),('admin','rates.write'),('admin','reports.read'),('admin','audit.read'),
  ('finance_manager','orders.read'),('finance_manager','payout.approve'),('finance_manager','rates.write'),
  ('finance_manager','reports.read'),('finance_manager','ledger.adjust'),('finance_manager','users.read'),
  ('buy_operator','orders.read'),('buy_operator','buy.process'),('buy_operator','buy.complete'),
  ('sell_operator','orders.read'),('sell_operator','sell.review'),('sell_operator','sell.approve_deposit'),
  ('sell_operator','payout.execute'),
  ('deposit_reviewer','orders.read'),('deposit_reviewer','deposits.review'),
  ('support_agent','support.reply'),('support_agent','users.read'),
  ('auditor','orders.read'),('auditor','users.read'),('auditor','reports.read'),('auditor','audit.read');

-- Permission check from the JWT identity only; never from anything the client sends.
create function public.has_permission(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role = ur.role
    join public.profiles pr on pr.id = ur.user_id
    where ur.user_id = auth.uid()
      and ur.revoked_at is null
      and pr.status = 'active'
      and rp.permission = p);
$$;
revoke all on function public.has_permission(text) from public, anon;
grant execute on function public.has_permission(text) to authenticated, service_role;

-- ---------------------------------------------------------------- audit log (append-only)
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_idx on public.audit_logs(entity_type, entity_id);
create index audit_logs_actor_idx on public.audit_logs(actor_id, created_at);

create function public.forbid_audit_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs is append-only (% forbidden)', tg_op;
end $$;
create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.forbid_audit_mutation();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function public.forbid_audit_mutation();

-- Generic row-change auditor (security definer so clients can never write audit rows directly).
create function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  v_id := coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'id',
                   (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'key',
                   (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'user_id');
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, before_data, after_data)
  values (auth.uid(), lower(tg_op), tg_table_name, v_id,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return null;
end $$;

create trigger user_roles_audit after insert or update or delete on public.user_roles
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- settings (NO secrets here)
create table public.admin_settings (
  key text primary key check (key ~ '^[a-z0-9_.]+$'
                              and key !~* '(secret|token|private|password|api_key|service_role)'),
  value jsonb not null,
  is_public boolean not null default false,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create trigger admin_settings_audit after insert or update or delete on public.admin_settings
  for each row execute function public.audit_row_change();

-- Operational switches. These are structure/defaults only, not market data.
insert into public.admin_settings(key, value, is_public) values
  ('platform.name', '"Libya USDT Exchange"', true),
  ('platform.default_locale', '"ar"', true),
  ('platform.base_currency', '"LYD"', true),
  ('trading.buy_enabled', 'false', true),
  ('trading.sell_enabled', 'false', true),
  ('maintenance.enabled', 'false', true),
  ('payments.dpay_mode', '"sandbox"', false),
  ('payments.topups_enabled', 'false', true),
  ('trading.quote_ttl_seconds', '120', true);

-- ---------------------------------------------------------------- networks & deposit addresses
create table public.supported_networks (
  code text primary key check (code ~ '^[A-Z0-9_]+$'),
  display_name text not null,
  status text not null default 'disabled' check (status in ('active','disabled')),
  min_deposit numeric(24,6) not null default 0 check (min_deposit >= 0),
  required_confirmations integer not null default 1 check (required_confirmations >= 1),
  address_regex text not null,             -- admin supplies per network; validated on address insert
  explorer_tx_url text,                    -- e.g. https://…/tx/{txid}
  instructions text,
  warnings text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create trigger supported_networks_audit after insert or update or delete on public.supported_networks
  for each row execute function public.audit_row_change();

create table public.deposit_addresses (
  id uuid primary key default gen_random_uuid(),
  network_code text not null references public.supported_networks(code),
  address text not null,
  status text not null default 'draft' check (status in ('draft','active','disabled')),
  instructions text,
  activated_at timestamptz,
  disabled_at timestamptz,
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (network_code, address)
);
-- One active address per network at a time (replacement = disable old, activate new, both audited).
create unique index deposit_addresses_one_active on public.deposit_addresses(network_code) where status = 'active';
create trigger deposit_addresses_audit after insert or update or delete on public.deposit_addresses
  for each row execute function public.audit_row_change();

create function public.validate_deposit_address() returns trigger language plpgsql as $$
declare v_re text;
begin
  select address_regex into v_re from public.supported_networks where code = new.network_code;
  if new.address !~ v_re then
    raise exception 'address does not match the format required for network %', new.network_code;
  end if;
  if new.status = 'active' then
    if not exists (select 1 from public.supported_networks where code = new.network_code and status = 'active') then
      raise exception 'network % is not active', new.network_code;
    end if;
    new.activated_at := coalesce(new.activated_at, now());
  end if;
  if new.status = 'disabled' then new.disabled_at := coalesce(new.disabled_at, now()); end if;
  return new;
end $$;
create trigger deposit_addresses_validate before insert or update on public.deposit_addresses
  for each row execute function public.validate_deposit_address();

-- ---------------------------------------------------------------- exchange rates (append-only versions)
create table public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  sell_price numeric(18,4) not null check (sell_price > 0),   -- platform SELLS USDT to customer (LYD per USDT)
  buy_price  numeric(18,4) not null check (buy_price > 0),    -- platform BUYS USDT from customer
  buy_fee_pct  numeric(7,4) not null default 0 check (buy_fee_pct  between 0 and 20),
  sell_fee_pct numeric(7,4) not null default 0 check (sell_fee_pct between 0 and 20),
  min_buy_lyd  numeric(18,2) not null check (min_buy_lyd >= 0),
  max_buy_lyd  numeric(18,2) not null,
  min_sell_usdt numeric(24,6) not null check (min_sell_usdt >= 0),
  max_sell_usdt numeric(24,6) not null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (buy_price <= sell_price),                            -- two independent prices, never inverted
  check (max_buy_lyd >= min_buy_lyd),
  check (max_sell_usdt >= min_sell_usdt),
  check (valid_to is null or valid_to > valid_from)
);
create index exchange_rates_valid_idx on public.exchange_rates(valid_from desc);
create trigger exchange_rates_immutable before update or delete on public.exchange_rates
  for each row execute function public.forbid_ledger_mutation();   -- reuse: raises append-only error
create trigger exchange_rates_audit after insert on public.exchange_rates
  for each row execute function public.audit_row_change();

create view public.current_exchange_rate with (security_invoker = true) as
  select * from public.exchange_rates
  where valid_from <= now() and (valid_to is null or valid_to > now())
  order by valid_from desc, created_at desc limit 1;

-- ---------------------------------------------------------------- RLS
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles enable row level security;
alter table public.audit_logs enable row level security;
alter table public.admin_settings enable row level security;
alter table public.supported_networks enable row level security;
alter table public.deposit_addresses enable row level security;
alter table public.exchange_rates enable row level security;

revoke all on public.permissions, public.role_permissions, public.user_roles, public.audit_logs,
              public.admin_settings, public.supported_networks, public.deposit_addresses,
              public.exchange_rates, public.current_exchange_rate from anon, authenticated;

grant select on public.user_roles, public.audit_logs, public.admin_settings, public.supported_networks,
                public.deposit_addresses, public.exchange_rates, public.current_exchange_rate to authenticated;
grant select on public.admin_settings, public.supported_networks, public.exchange_rates,
                public.current_exchange_rate to anon;

create policy roles_select_own   on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_permission('roles.manage'));
create policy audit_select_staff on public.audit_logs for select to authenticated
  using (public.has_permission('audit.read'));
create policy settings_select_public on public.admin_settings for select to anon, authenticated
  using (is_public);
create policy settings_select_staff  on public.admin_settings for select to authenticated
  using (public.has_permission('settings.read'));
create policy networks_select_active on public.supported_networks for select to anon, authenticated
  using (status = 'active');
create policy networks_select_staff  on public.supported_networks for select to authenticated
  using (public.has_permission('settings.read'));
-- Customers see ONLY the currently active address of an active network.
create policy addresses_select_active on public.deposit_addresses for select to authenticated
  using (status = 'active' or public.has_permission('settings.read'));
create policy rates_select_current on public.exchange_rates for select to anon, authenticated
  using (valid_from <= now() and (valid_to is null or valid_to > now()) or public.has_permission('rates.write'));
-- No INSERT/UPDATE/DELETE policies and no write grants: all writes go through Edge Functions (service_role)
-- that check has_permission-equivalent claims server-side and are audited by the triggers above.
