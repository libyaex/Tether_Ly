-- 0001_core_ledger.sql
-- Core: profiles, ledger accounts, immutable double-entry ledger, wallet cache, RLS.
-- STATUS: written but NOT yet executed against a real Postgres (no DB in the authoring environment).
-- Rounding rule: LYD amounts are exact to 2 dp (rejected, never silently rounded); USDT to 6 dp.

create extension if not exists pgcrypto;

create type account_status as enum ('active','pending_verification','needs_review','restricted','suspended');
create type ledger_direction as enum ('debit','credit');

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  full_name text not null check (char_length(btrim(full_name)) >= 2),
  phone text,
  status account_status not null default 'pending_verification',
  accepted_terms_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- ledger accounts
create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  kind text not null check (kind in (
    'customer_available','customer_held','provider_clearing','company_cash',
    'company_usdt','fee_revenue','suspense','customer_payable')),
  currency text not null check (currency in ('LYD','USDT')),
  owner_user_id uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((kind in ('customer_available','customer_held')) = (owner_user_id is not null))
);
create unique index ledger_accounts_one_per_user_kind
  on public.ledger_accounts(owner_user_id, kind) where owner_user_id is not null;

-- ---------------------------------------------------------------- ledger (immutable)
create table public.ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  kind text not null,
  reference_type text,
  reference_id uuid,
  description text,
  reverses_transaction_id uuid unique references public.ledger_transactions(id),
  created_by uuid,
  created_at timestamptz not null default now()
);

create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.ledger_transactions(id),
  account_id uuid not null references public.ledger_accounts(id),
  direction ledger_direction not null,
  currency text not null check (currency in ('LYD','USDT')),
  amount numeric(24,8) not null check (amount > 0),
  created_at timestamptz not null default now(),
  check (currency <> 'LYD' or amount = round(amount, 2)),
  check (currency <> 'USDT' or amount = round(amount, 6))
);
create index ledger_entries_tx_idx on public.ledger_entries(transaction_id);
create index ledger_entries_account_idx on public.ledger_entries(account_id, created_at);

-- Immutability: no UPDATE / DELETE / TRUNCATE on ledger tables, for anyone (incl. service_role).
create function public.forbid_ledger_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'ledger is append-only: % on % is forbidden (post a reversing transaction instead)', tg_op, tg_table_name;
end $$;

create trigger ledger_transactions_immutable before update or delete on public.ledger_transactions
  for each row execute function public.forbid_ledger_mutation();
create trigger ledger_entries_immutable before update or delete on public.ledger_entries
  for each row execute function public.forbid_ledger_mutation();
create trigger ledger_transactions_no_truncate before truncate on public.ledger_transactions
  for each statement execute function public.forbid_ledger_mutation();
create trigger ledger_entries_no_truncate before truncate on public.ledger_entries
  for each statement execute function public.forbid_ledger_mutation();

-- Balanced check at commit: per transaction and currency, debits = credits; at least 2 entries.
create function public.assert_transaction_balanced() returns trigger language plpgsql as $$
declare bad record;
begin
  select currency, sum(case when direction='debit' then amount else -amount end) as diff, count(*) as n
    into bad
    from public.ledger_entries where transaction_id = new.transaction_id
    group by currency
    having sum(case when direction='debit' then amount else -amount end) <> 0 or count(*) < 2
    limit 1;
  if found then
    raise exception 'unbalanced ledger transaction % (currency %, diff %, entries %)',
      new.transaction_id, bad.currency, bad.diff, bad.n;
  end if;
  return null;
end $$;

create constraint trigger ledger_entries_balanced
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function public.assert_transaction_balanced();

-- ---------------------------------------------------------------- wallets (cache of customer ledger balances)
create table public.wallets (
  user_id uuid primary key references public.profiles(id) on delete restrict,
  available_account_id uuid not null unique references public.ledger_accounts(id),
  held_account_id uuid not null unique references public.ledger_accounts(id),
  available numeric(24,2) not null default 0 check (available >= 0),
  held numeric(24,2) not null default 0 check (held >= 0),
  updated_at timestamptz not null default now()
);

-- Wallet rows may only change inside post_ledger_transaction (defence in depth, even vs service_role).
create function public.guard_wallet_update() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('app.ledger_posting', true), '') <> 'on' then
    raise exception 'wallet balances can only change through post_ledger_transaction';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger wallets_guard before update on public.wallets
  for each row execute function public.guard_wallet_update();

-- ---------------------------------------------------------------- signup: profile + wallet + customer accounts
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare a_id uuid; h_id uuid;
begin
  insert into public.profiles(id, full_name, phone)
  values (new.id, coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'), ''), 'مستخدم جديد'),
          new.raw_user_meta_data->>'phone');
  insert into public.ledger_accounts(code, name, kind, currency, owner_user_id)
    values ('CUST-AVL-'||new.id, 'Customer available LYD', 'customer_available', 'LYD', new.id) returning id into a_id;
  insert into public.ledger_accounts(code, name, kind, currency, owner_user_id)
    values ('CUST-HLD-'||new.id, 'Customer held LYD', 'customer_held', 'LYD', new.id) returning id into h_id;
  insert into public.wallets(user_id, available_account_id, held_account_id) values (new.id, a_id, h_id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- System (company) accounts: structure only, zero balances.
insert into public.ledger_accounts(code, name, kind, currency) values
  ('SYS-PROVIDER-CLEARING-LYD','Payment provider clearing (LYD)','provider_clearing','LYD'),
  ('SYS-CASH-LYD','Company cash & bank liquidity (LYD)','company_cash','LYD'),
  ('SYS-USDT','Company USDT holdings','company_usdt','USDT'),
  ('SYS-FEE-REVENUE-LYD','Fee & spread revenue (LYD)','fee_revenue','LYD'),
  ('SYS-SUSPENSE-LYD','Reconciliation suspense (LYD)','suspense','LYD'),
  ('SYS-CUSTOMER-PAYABLE-LYD','Owed to customers pending payout (LYD)','customer_payable','LYD');

-- ---------------------------------------------------------------- the ONLY write path for money
-- p_entries: [{"account_id": "...", "direction": "debit|credit", "amount": "12.50"}, ...]
-- Customer accounts are liabilities (credit-normal): credit increases, debit decreases.
create function public.post_ledger_transaction(
  p_idempotency_key text, p_kind text, p_reference_type text, p_reference_id uuid,
  p_description text, p_entries jsonb, p_reverses uuid default null, p_actor uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tx uuid; e jsonb; v_acc public.ledger_accounts; v_amount numeric; v_delta numeric;
begin
  perform set_config('app.ledger_posting', 'on', true);

  select id into v_tx from public.ledger_transactions where idempotency_key = p_idempotency_key;
  if found then return v_tx; end if;               -- replay: same effect once

  begin
    insert into public.ledger_transactions(idempotency_key, kind, reference_type, reference_id,
                                           description, reverses_transaction_id, created_by)
    values (p_idempotency_key, p_kind, p_reference_type, p_reference_id, p_description, p_reverses, p_actor)
    returning id into v_tx;
  exception when unique_violation then
    select id into v_tx from public.ledger_transactions where idempotency_key = p_idempotency_key;
    if v_tx is null then raise; end if;
    return v_tx;                                    -- concurrent replay
  end;

  -- deterministic account order => consistent row-lock order => no deadlocks
  for e in select value from jsonb_array_elements(p_entries) order by value->>'account_id' loop
    select * into v_acc from public.ledger_accounts where id = (e->>'account_id')::uuid;
    if not found then raise exception 'unknown ledger account %', e->>'account_id'; end if;
    v_amount := (e->>'amount')::numeric;

    insert into public.ledger_entries(transaction_id, account_id, direction, currency, amount)
    values (v_tx, v_acc.id, (e->>'direction')::ledger_direction, v_acc.currency, v_amount);

    if v_acc.kind = 'customer_available' or v_acc.kind = 'customer_held' then
      v_delta := case when e->>'direction' = 'credit' then v_amount else -v_amount end;
      if v_acc.kind = 'customer_available' then
        update public.wallets set available = available + v_delta where user_id = v_acc.owner_user_id;
      else
        update public.wallets set held = held + v_delta where user_id = v_acc.owner_user_id;
      end if;                                       -- CHECK (>= 0) aborts the whole transaction on overdraw
    end if;
  end loop;

  return v_tx;
end $$;

revoke all on function public.post_ledger_transaction(text,text,text,uuid,text,jsonb,uuid,uuid) from public, anon, authenticated;
grant execute on function public.post_ledger_transaction(text,text,text,uuid,text,jsonb,uuid,uuid) to service_role;

-- Reconciliation view: cached wallet vs ledger truth (must always return zero rows).
create view public.v_wallet_ledger_mismatch with (security_invoker = true) as
select w.user_id, w.available as cached_available,
       coalesce(sum(case when a.id = w.available_account_id then case e.direction when 'credit' then e.amount else -e.amount end end),0) as ledger_available,
       w.held as cached_held,
       coalesce(sum(case when a.id = w.held_account_id then case e.direction when 'credit' then e.amount else -e.amount end end),0) as ledger_held
from public.wallets w
left join public.ledger_accounts a on a.id in (w.available_account_id, w.held_account_id)
left join public.ledger_entries e on e.account_id = a.id
group by w.user_id, w.available, w.held
having w.available <> coalesce(sum(case when a.id = w.available_account_id then case e.direction when 'credit' then e.amount else -e.amount end end),0)
    or w.held <> coalesce(sum(case when a.id = w.held_account_id then case e.direction when 'credit' then e.amount else -e.amount end end),0);
revoke all on public.v_wallet_ledger_mismatch from anon, authenticated;

-- ---------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.wallets enable row level security;

-- Browser roles: read-only on own data, zero write access to money tables.
revoke all on public.profiles, public.ledger_accounts, public.ledger_transactions,
              public.ledger_entries, public.wallets from anon, authenticated;
grant select on public.profiles, public.wallets, public.ledger_accounts,
                public.ledger_transactions, public.ledger_entries to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;   -- NOT status

create policy profiles_select_own on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy wallets_select_own on public.wallets for select to authenticated using (user_id = auth.uid());
create policy accounts_select_own on public.ledger_accounts for select to authenticated using (owner_user_id = auth.uid());
create policy entries_select_own on public.ledger_entries for select to authenticated
  using (exists (select 1 from public.ledger_accounts a where a.id = account_id and a.owner_user_id = auth.uid()));
create policy tx_select_own on public.ledger_transactions for select to authenticated
  using (exists (select 1 from public.ledger_entries e join public.ledger_accounts a on a.id = e.account_id
                 where e.transaction_id = ledger_transactions.id and a.owner_user_id = auth.uid()));
-- Staff/admin read policies are added in the roles migration (0002).
