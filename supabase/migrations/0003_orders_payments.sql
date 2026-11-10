-- 0003_orders_payments.sql
-- Deposits (DPay), provider events, rate quotes, buy/sell orders, TXID registry, payouts, notifications.
-- STATUS: written, NOT yet executed against a real Postgres.
-- Writes to these tables happen ONLY in Edge Functions / RPCs running as service_role.

-- ---------------------------------------------------------------- deposits via DPay
create type deposit_status as enum ('pending','awaiting_payment','paid','failed','expired','cancelled','needs_review');

create table public.deposit_orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10)),
  user_id uuid not null references public.profiles(id),
  amount numeric(18,2) not null check (amount > 0),           -- credited to wallet (pre provider fee)
  status deposit_status not null default 'pending',
  provider_amount_charged numeric(18,2),                      -- as reported by DPay, never recomputed
  provider_fee numeric(18,4),
  provider_tx_id text,
  review_reason text,
  credited_transaction_id uuid unique references public.ledger_transactions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'paid' or credited_transaction_id is not null)   -- paid <=> ledger credit exists
);
create index deposit_orders_user_idx on public.deposit_orders(user_id, created_at desc);
create index deposit_orders_pending_idx on public.deposit_orders(created_at) where status in ('pending','awaiting_payment');

create table public.dpay_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  deposit_order_id uuid not null references public.deposit_orders(id),
  checkout_id text not null unique,                            -- cs_… / cs_test_…
  idempotency_key text not null unique check (char_length(idempotency_key) <= 64),
  attempt integer not null check (attempt >= 1),
  live boolean not null,
  url text not null,
  status text not null default 'open' check (status in ('open','paid','expired','cancelled')),
  amount numeric(18,2) not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (deposit_order_id, attempt),
  check ((live and checkout_id like 'cs\_%' and checkout_id not like 'cs\_test\_%')
      or (not live and checkout_id like 'cs\_test\_%'))        -- sandbox ids can never be mixed with live
);

create table public.payment_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'dpay',
  event text not null,
  checkout_session_id text not null,
  live boolean not null,
  signature_valid boolean not null,
  payload jsonb not null,
  outcome text,                                                -- applied | duplicate | mismatch | ignored_env | error
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event, checkout_session_id)                -- DPay's documented dedupe key
);

-- ---------------------------------------------------------------- price quotes (price lock)
create table public.rate_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  side text not null check (side in ('buy','sell')),           -- from the customer's point of view
  rate_id uuid not null references public.exchange_rates(id),
  price numeric(18,4) not null check (price > 0),
  fee_pct numeric(7,4) not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- global TXID registry
create table public.usdt_transfers (
  id uuid primary key default gen_random_uuid(),
  network_code text not null references public.supported_networks(code),
  txid text not null check (char_length(btrim(txid)) >= 8),
  direction text not null check (direction in ('outgoing_to_customer','incoming_from_customer')),
  recorded_by uuid references public.profiles(id),
  verification text not null default 'unverified' check (verification in ('unverified','verified_onchain','rejected')),
  created_at timestamptz not null default now(),
  unique (network_code, txid)                                  -- one TXID, one order, ever
);

-- ---------------------------------------------------------------- payout methods
create table public.payout_methods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  type text not null check (type in ('internal_wallet','bank_iban','bank_local','other')),
  holder_name text,
  bank_name text,
  iban text,
  account_number text,
  verification text not null default 'unverified' check (verification in ('unverified','verified','rejected')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  check (type = 'internal_wallet' or holder_name is not null)
);
create unique index payout_methods_one_default on public.payout_methods(user_id) where is_default;

-- ---------------------------------------------------------------- buy orders (customer buys USDT)
create table public.buy_orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10)),
  user_id uuid not null references public.profiles(id),
  quote_id uuid not null unique references public.rate_quotes(id),
  status text not null default 'pending_review' check (status in
    ('pending_review','approved','processing','completed','rejected','cancelled','failed','needs_attention')),
  price numeric(18,4) not null,
  fee_pct numeric(7,4) not null,
  usdt_amount numeric(24,6) not null check (usdt_amount > 0),
  lyd_gross numeric(18,2) not null check (lyd_gross > 0),      -- usdt_amount * price
  lyd_fee numeric(18,2) not null check (lyd_fee >= 0),
  lyd_total numeric(18,2) not null check (lyd_total = lyd_gross + lyd_fee),
  network_code text not null references public.supported_networks(code),
  receive_address text not null,
  hold_transaction_id uuid not null unique references public.ledger_transactions(id),
  settle_transaction_id uuid unique references public.ledger_transactions(id),
  release_transaction_id uuid unique references public.ledger_transactions(id),
  assigned_to uuid references public.profiles(id),
  outgoing_transfer_id uuid unique references public.usdt_transfers(id),
  executed_by uuid references public.profiles(id),
  executed_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'completed' or (outgoing_transfer_id is not null and executed_by is not null
                                   and settle_transaction_id is not null)),
  check (status not in ('rejected','cancelled','failed') or release_transaction_id is not null)
);
create index buy_orders_user_idx on public.buy_orders(user_id, created_at desc);
create index buy_orders_status_idx on public.buy_orders(status, created_at);

-- ---------------------------------------------------------------- sell orders (customer sells USDT)
create table public.sell_orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10)),
  user_id uuid not null references public.profiles(id),
  quote_id uuid not null unique references public.rate_quotes(id),
  status text not null default 'awaiting_deposit' check (status in
    ('awaiting_deposit','deposit_submitted','needs_review','awaiting_payout','completed',
     'rejected','cancelled','expired','failed')),
  price numeric(18,4) not null,
  fee_pct numeric(7,4) not null,
  usdt_expected numeric(24,6) not null check (usdt_expected > 0),
  lyd_gross numeric(18,2) not null check (lyd_gross > 0),
  lyd_fee numeric(18,2) not null check (lyd_fee >= 0),
  lyd_net numeric(18,2) not null check (lyd_net = lyd_gross - lyd_fee and lyd_net > 0),
  network_code text not null references public.supported_networks(code),
  deposit_address_id uuid not null references public.deposit_addresses(id),   -- address shown at creation
  payout_method_id uuid not null references public.payout_methods(id),
  payout_snapshot jsonb,                       -- frozen when the reviewer approves; later edits cannot change it
  incoming_transfer_id uuid unique references public.usdt_transfers(id),
  usdt_received numeric(24,6),
  deposit_verified_by uuid references public.profiles(id),
  deposit_verified_at timestamptz,
  expires_at timestamptz not null,
  assigned_to uuid references public.profiles(id),
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status not in ('awaiting_payout','completed') or
         (incoming_transfer_id is not null and deposit_verified_by is not null and payout_snapshot is not null))
);
create index sell_orders_user_idx on public.sell_orders(user_id, created_at desc);
create index sell_orders_status_idx on public.sell_orders(status, created_at);

create table public.payout_records (
  id uuid primary key default gen_random_uuid(),
  sell_order_id uuid not null unique references public.sell_orders(id),
  amount numeric(18,2) not null check (amount > 0),
  method_snapshot jsonb not null,
  external_reference text not null check (char_length(btrim(external_reference)) >= 3),
  proof_path text,
  executed_by uuid not null references public.profiles(id),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  credit_transaction_id uuid unique references public.ledger_transactions(id),  -- internal-wallet payouts
  created_at timestamptz not null default now(),
  check (approved_by is null or approved_by <> executed_by)     -- separation of duties
);

-- ---------------------------------------------------------------- state machines
create function public.buy_transition_allowed(f text, t text) returns boolean language sql immutable as $$
  select (f, t) in (
    ('pending_review','approved'),('pending_review','rejected'),('pending_review','cancelled'),('pending_review','needs_attention'),
    ('approved','processing'),('approved','rejected'),('approved','needs_attention'),
    ('processing','completed'),('processing','failed'),('processing','needs_attention'),('processing','rejected'),
    ('needs_attention','pending_review'),('needs_attention','processing'),('needs_attention','rejected'));
$$;
create function public.sell_transition_allowed(f text, t text) returns boolean language sql immutable as $$
  select (f, t) in (
    ('awaiting_deposit','deposit_submitted'),('awaiting_deposit','cancelled'),('awaiting_deposit','expired'),
    ('deposit_submitted','needs_review'),('deposit_submitted','awaiting_payout'),('deposit_submitted','rejected'),
    ('needs_review','awaiting_payout'),('needs_review','rejected'),('needs_review','deposit_submitted'),
    ('awaiting_payout','completed'),('awaiting_payout','failed'),('awaiting_payout','needs_review'));
$$;
create function public.deposit_transition_allowed(f deposit_status, t deposit_status) returns boolean language sql immutable as $$
  select (f::text, t::text) in (
    ('pending','awaiting_payment'),('pending','failed'),('pending','cancelled'),
    ('awaiting_payment','paid'),('awaiting_payment','failed'),('awaiting_payment','expired'),
    ('awaiting_payment','cancelled'),('awaiting_payment','needs_review'),
    ('expired','paid'),('expired','needs_review'),               -- DPay: a late bank confirmation can flip expired -> paid
    ('needs_review','paid'),('needs_review','failed'));
$$;

create function public.enforce_transition() returns trigger language plpgsql as $$
declare ok boolean;
begin
  if new.status::text is not distinct from old.status::text then
    new.updated_at := now(); return new;
  end if;
  ok := case tg_table_name
          when 'buy_orders'      then public.buy_transition_allowed(old.status::text, new.status::text)
          when 'sell_orders'     then public.sell_transition_allowed(old.status::text, new.status::text)
          when 'deposit_orders'  then public.deposit_transition_allowed(old.status::text::deposit_status, new.status::text::deposit_status)
        end;
  if not coalesce(ok, false) then
    raise exception 'illegal status transition on %: % -> %', tg_table_name, old.status, new.status;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger buy_orders_transition     before update on public.buy_orders     for each row execute function public.enforce_transition();
create trigger sell_orders_transition    before update on public.sell_orders    for each row execute function public.enforce_transition();
create trigger deposit_orders_transition before update on public.deposit_orders for each row execute function public.enforce_transition();

-- Immutable financial terms once an order exists (price/amounts/addresses never change retroactively).
create function public.freeze_order_terms() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'buy_orders' and
     (new.price, new.fee_pct, new.usdt_amount, new.lyd_gross, new.lyd_fee, new.lyd_total,
      new.network_code, new.receive_address, new.user_id, new.quote_id, new.hold_transaction_id)
     is distinct from
     (old.price, old.fee_pct, old.usdt_amount, old.lyd_gross, old.lyd_fee, old.lyd_total,
      old.network_code, old.receive_address, old.user_id, old.quote_id, old.hold_transaction_id) then
    raise exception 'buy order terms are frozen';
  elsif tg_table_name = 'sell_orders' and
     (new.price, new.fee_pct, new.usdt_expected, new.lyd_gross, new.lyd_fee, new.lyd_net,
      new.network_code, new.deposit_address_id, new.user_id, new.quote_id, new.payout_method_id)
     is distinct from
     (old.price, old.fee_pct, old.usdt_expected, old.lyd_gross, old.lyd_fee, old.lyd_net,
      old.network_code, old.deposit_address_id, old.user_id, old.quote_id, old.payout_method_id) then
    raise exception 'sell order terms are frozen';
  elsif tg_table_name = 'sell_orders' and old.payout_snapshot is not null
        and new.payout_snapshot is distinct from old.payout_snapshot then
    raise exception 'approved payout snapshot cannot change';
  elsif tg_table_name = 'deposit_orders' and (new.amount, new.user_id) is distinct from (old.amount, old.user_id) then
    raise exception 'deposit terms are frozen';
  end if;
  return new;
end $$;
create trigger buy_orders_freeze     before update on public.buy_orders     for each row execute function public.freeze_order_terms();
create trigger sell_orders_freeze    before update on public.sell_orders    for each row execute function public.freeze_order_terms();
create trigger deposit_orders_freeze before update on public.deposit_orders for each row execute function public.freeze_order_terms();

create trigger buy_orders_audit     after insert or update on public.buy_orders     for each row execute function public.audit_row_change();
create trigger sell_orders_audit    after insert or update on public.sell_orders    for each row execute function public.audit_row_change();
create trigger deposit_orders_audit after insert or update on public.deposit_orders for each row execute function public.audit_row_change();
create trigger payout_records_audit after insert or update on public.payout_records for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- notifications
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  level text not null default 'info' check (level in ('info','success','warning','critical')),
  title text not null,
  body text,                                    -- never include balances/amounts that could show on a lock screen
  entity_type text,
  entity_id uuid,
  link text,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)                  -- a repeated webhook cannot produce a second notification
);
create index notifications_user_idx on public.notifications(user_id, created_at desc);
create index notifications_unread_idx on public.notifications(user_id) where read_at is null;

-- ---------------------------------------------------------------- RLS
alter table public.deposit_orders enable row level security;
alter table public.dpay_checkout_sessions enable row level security;
alter table public.payment_provider_events enable row level security;
alter table public.rate_quotes enable row level security;
alter table public.usdt_transfers enable row level security;
alter table public.payout_methods enable row level security;
alter table public.buy_orders enable row level security;
alter table public.sell_orders enable row level security;
alter table public.payout_records enable row level security;
alter table public.notifications enable row level security;

revoke all on public.deposit_orders, public.dpay_checkout_sessions, public.payment_provider_events,
              public.rate_quotes, public.usdt_transfers, public.payout_methods, public.buy_orders,
              public.sell_orders, public.payout_records, public.notifications from anon, authenticated;

grant select on public.deposit_orders, public.rate_quotes, public.buy_orders, public.sell_orders,
                public.payout_methods, public.notifications to authenticated;
grant select on public.usdt_transfers, public.payout_records, public.dpay_checkout_sessions,
                public.payment_provider_events to authenticated;          -- staff only via policies below
grant update (read_at) on public.notifications to authenticated;

create policy deposits_own   on public.deposit_orders for select to authenticated
  using (user_id = auth.uid() or public.has_permission('orders.read'));
create policy quotes_own     on public.rate_quotes for select to authenticated using (user_id = auth.uid());
create policy buy_own        on public.buy_orders for select to authenticated
  using (user_id = auth.uid() or public.has_permission('orders.read'));
create policy sell_own       on public.sell_orders for select to authenticated
  using (user_id = auth.uid() or public.has_permission('orders.read'));
create policy payout_methods_own on public.payout_methods for select to authenticated
  using (user_id = auth.uid() or public.has_permission('sell.review'));
create policy transfers_staff on public.usdt_transfers for select to authenticated
  using (public.has_permission('orders.read'));
create policy payouts_staff  on public.payout_records for select to authenticated
  using (public.has_permission('orders.read'));
create policy dpay_sessions_staff on public.dpay_checkout_sessions for select to authenticated
  using (public.has_permission('orders.read'));
create policy dpay_events_staff on public.payment_provider_events for select to authenticated
  using (public.has_permission('deposits.review'));
create policy notifications_own on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_mark_read on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter publication supabase_realtime add table public.notifications;   -- Realtime respects the RLS above
