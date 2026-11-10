-- Run:  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/001_ledger_and_rls.test.sql
-- Everything runs inside one transaction that is rolled back; a failed ASSERT aborts with a message.
-- STATUS: written, NOT yet run (no Postgres in the authoring environment). Expect to fix small issues on first run.

begin;

create schema test_helpers;
grant usage on schema test_helpers to public;
create or replace function test_helpers.expect_error(sql text, needle text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm ilike '%' || needle || '%' then return; end if;
    raise exception 'wrong error for [%]: got "%", wanted "%"', sql, sqlerrm, needle;
  end;
  raise exception 'expected failure but succeeded: %', sql;
end $$;

do $$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  a1 uuid; a2 uuid; clearing uuid; tx1 uuid; tx1b uuid; w record;
begin
  -- signup creates profile + wallet + customer ledger accounts, with a REAL zero balance
  insert into auth.users(id, email, raw_user_meta_data) values
    (u1, 'u1@test.local', '{"full_name":"User One"}'), (u2, 'u2@test.local', '{"full_name":"User Two"}');
  select * into w from public.wallets where user_id = u1;
  assert w.available = 0 and w.held = 0, 'new wallet must be exactly zero';
  a1 := w.available_account_id;
  select available_account_id into a2 from public.wallets where user_id = u2;
  select id into clearing from public.ledger_accounts where code = 'SYS-PROVIDER-CLEARING-LYD';

  -- credit once
  tx1 := public.post_ledger_transaction('test-dep-0001', 'deposit', 'deposit_order', null, 't',
    jsonb_build_array(
      jsonb_build_object('account_id', clearing, 'direction', 'debit',  'amount', '100.00'),
      jsonb_build_object('account_id', a1,       'direction', 'credit', 'amount', '100.00')));
  assert (select available from public.wallets where user_id = u1) = 100, 'credit applied';

  -- replay with same idempotency key: same tx id, balance NOT doubled
  tx1b := public.post_ledger_transaction('test-dep-0001', 'deposit', 'deposit_order', null, 't', '[]'::jsonb);
  assert tx1b = tx1, 'replay returns original transaction';
  assert (select available from public.wallets where user_id = u1) = 100, 'no double credit';

  -- unbalanced entries are rejected at commit (force check now)
  perform test_helpers.expect_error($q$
    select public.post_ledger_transaction('test-unbal-01', 'x', null, null, 't',
      jsonb_build_array(jsonb_build_object('account_id', (select id from public.ledger_accounts where code='SYS-CASH-LYD'),
                                           'direction','debit','amount','5.00'),
                        jsonb_build_object('account_id', (select id from public.ledger_accounts where code='SYS-FEE-REVENUE-LYD'),
                                           'direction','credit','amount','4.00')));
    set constraints all immediate;
  $q$, 'unbalanced');
  set constraints all deferred;

  -- overdraw is rejected by the wallet CHECK
  perform test_helpers.expect_error(format($q$
    select public.post_ledger_transaction('test-overdraw1', 'x', null, null, 't',
      jsonb_build_array(jsonb_build_object('account_id', %L, 'direction','debit','amount','150.00'),
                        jsonb_build_object('account_id', %L, 'direction','credit','amount','150.00')))
  $q$, a1, clearing), 'available');

  -- 3-decimal LYD amount is rejected, not rounded
  perform test_helpers.expect_error(format($q$
    select public.post_ledger_transaction('test-3dec-0001', 'x', null, null, 't',
      jsonb_build_array(jsonb_build_object('account_id', %L, 'direction','debit','amount','1.005'),
                        jsonb_build_object('account_id', %L, 'direction','credit','amount','1.005')))
  $q$, clearing, a2), 'check');

  -- ledger is append-only
  perform test_helpers.expect_error('update public.ledger_entries set amount = 1', 'append-only');
  perform test_helpers.expect_error('delete from public.ledger_entries', 'append-only');
  perform test_helpers.expect_error('update public.ledger_transactions set kind = ''hack''', 'append-only');
  perform test_helpers.expect_error('truncate public.ledger_entries', 'append-only');

  -- wallet cannot be edited directly, even as table owner / service role
  perform test_helpers.expect_error(format('update public.wallets set available = 999999 where user_id = %L', u1),
                               'only change through post_ledger_transaction');

  -- cache == ledger truth
  assert not exists (select 1 from public.v_wallet_ledger_mismatch), 'wallet cache matches ledger';

  -- audit log is append-only
  perform test_helpers.expect_error('delete from public.audit_logs', 'append-only');

  -- rates: inverted prices and silent edits are impossible
  perform test_helpers.expect_error($q$
    insert into public.exchange_rates(sell_price, buy_price, min_buy_lyd, max_buy_lyd, min_sell_usdt, max_sell_usdt)
    values (10, 11, 10, 1000, 1, 100)$q$, 'check');
  insert into public.exchange_rates(sell_price, buy_price, min_buy_lyd, max_buy_lyd, min_sell_usdt, max_sell_usdt)
    values (10.15, 10.00, 10, 1000, 1, 100);
  perform test_helpers.expect_error('update public.exchange_rates set sell_price = 1', 'append-only');

  -- settings can never hold secret-looking keys
  perform test_helpers.expect_error($q$insert into public.admin_settings(key, value) values ('dpay.webhook_secret','"x"')$q$, 'check');

  -- RLS: as user u1 (authenticated)
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u1::text, true);
  set local role authenticated;

  assert (select count(*) from public.wallets) = 1, 'u1 sees only own wallet';
  assert (select count(*) from public.profiles) = 1, 'u1 sees only own profile';
  assert (select count(*) from public.ledger_entries) = 1, 'u1 sees only own entries (1 credit)';
  perform test_helpers.expect_error('update public.wallets set available = 1', 'permission denied');
  perform test_helpers.expect_error('insert into public.ledger_entries(transaction_id, account_id, direction, currency, amount) select id, id, ''credit'', ''LYD'', 1 from public.ledger_accounts limit 1', 'permission denied');
  perform test_helpers.expect_error(format('update public.profiles set status = ''active'' where id = %L', u1), 'permission denied');
  perform test_helpers.expect_error(format('insert into public.user_roles(user_id, role) values (%L, ''super_admin'')', u1), 'permission denied');
  perform test_helpers.expect_error('insert into public.exchange_rates(sell_price, buy_price, min_buy_lyd, max_buy_lyd, min_sell_usdt, max_sell_usdt) values (1,1,1,1,1,1)', 'permission denied');
  assert (select count(*) from public.audit_logs) = 0, 'regular user reads no audit logs';
  assert not public.has_permission('rates.write'), 'regular user has no staff permission';
  perform test_helpers.expect_error('select public.post_ledger_transaction(''x'',''x'',null,null,null,''[]''::jsonb)', 'permission denied');

  reset role;
  raise notice 'ALL 001 TESTS PASSED';
end $$;

rollback;
