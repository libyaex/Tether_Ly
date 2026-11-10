-- Run:  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/002_rpcs_buy_and_deposits.test.sql
-- One rolled-back transaction. STATUS: written, NOT yet run (no Postgres in the authoring environment).
begin;

create or replace function pg_temp.expect_error(sql text, needle text) returns void language plpgsql as $$
begin
  begin execute sql;
  exception when others then
    if sqlerrm ilike '%' || needle || '%' then return; end if;
    raise exception 'wrong error for [%]: got "%", wanted "%"', sql, sqlerrm, needle;
  end;
  raise exception 'expected failure but succeeded: %', sql;
end $$;

do $$
declare
  u1 uuid := gen_random_uuid(); stf uuid := gen_random_uuid();
  dep public.deposit_orders; dep2 public.deposit_orders; chk jsonb; res text;
  q1 uuid; q2 uuid; q3 uuid; o1 uuid; o2 uuid; o3 uuid; w record; addr text := 'T0123456789abcdef';
begin
  insert into auth.users(id, email, raw_user_meta_data) values
    (u1,  'cust@test.local',  '{"full_name":"Customer One"}'),
    (stf, 'staff@test.local', '{"full_name":"Staff Operator"}');
  update public.profiles set status = 'active' where id in (u1, stf);
  insert into public.user_roles(user_id, role) values (stf, 'buy_operator');

  update public.admin_settings set value = 'true' where key in ('trading.buy_enabled','payments.topups_enabled');
  insert into public.admin_settings(key, value) values ('payments.topup_min_lyd','10'), ('payments.topup_max_lyd','5000');
  insert into public.supported_networks(code, display_name, status, address_regex)
    values ('TEST','Test network','active','^T[a-z0-9]{10,}$');
  insert into public.exchange_rates(sell_price, buy_price, buy_fee_pct, sell_fee_pct, min_buy_lyd, max_buy_lyd, min_sell_usdt, max_sell_usdt)
    values (10.20, 10.00, 1.0, 1.0, 10, 20000, 1, 5000);

  -- ---- DEPOSIT: top up 500 through the DPay path (sandbox)
  dep := public.create_deposit_order(u1, 500);
  perform public.attach_checkout_session(dep.id, 'cs_test_AAA', 'dep:' || dep.id || ':1', 1, false, 'https://dpay.test/x', now() + interval '1 hour');
  chk := jsonb_build_object('live', false, 'status', 'paid', 'amount', 500, 'currency', 'LYD', 'reference', dep.ref,
           'payment', jsonb_build_object('tx_id','txn_1','amount_charged',505,'fee_amount',5));

  assert public.apply_checkout('cs_test_AAA', jsonb_set(chk, '{live}', 'true')) = 'ignored_env', 'live event on sandbox session ignored';
  assert (select available from public.wallets where user_id = u1) = 0, 'env mismatch must not credit';
  assert public.apply_checkout('cs_test_AAA', chk) = 'applied', 'first paid applies';
  assert public.apply_checkout('cs_test_AAA', chk) = 'already_paid', 'duplicate webhook is a no-op';
  assert (select available from public.wallets where user_id = u1) = 500, 'credited exactly once';
  assert (select count(*) from public.notifications where user_id = u1 and type = 'deposit_paid') = 1, 'one success notification';
  assert (select status from public.deposit_orders where id = dep.id) = 'paid';

  -- mismatching amount: quarantined, no credit
  dep2 := public.create_deposit_order(u1, 100);
  perform public.attach_checkout_session(dep2.id, 'cs_test_BBB', 'dep:' || dep2.id || ':1', 1, false, 'https://dpay.test/y', now() + interval '1 hour');
  res := public.apply_checkout('cs_test_BBB', jsonb_build_object('live', false, 'status', 'paid', 'amount', 999,
          'currency', 'LYD', 'reference', dep2.ref, 'payment', jsonb_build_object('tx_id','txn_2','amount_charged',1000,'fee_amount',1)));
  assert res = 'mismatch', 'amount mismatch detected';
  assert (select status from public.deposit_orders where id = dep2.id) = 'needs_review';
  assert (select available from public.wallets where user_id = u1) = 500, 'mismatch must not credit';
  -- a wrong reference is a mismatch too
  perform pg_temp.expect_error(format('select public.create_deposit_order(%L, 5)', u1), 'out_of_limits');
  perform pg_temp.expect_error(format('select public.create_deposit_order(%L, 10.005)', u1), 'invalid_amount');

  -- ---- BUY: 102 LYD at 10.20 -> 10 USDT, fee 1% = 1.02, total 103.02
  q1 := (public.create_quote(u1, 'buy')).id;
  o1 := public.create_buy_order(u1, q1, 102, null, 'TEST', addr);
  select * into w from public.wallets where user_id = u1;
  assert w.available = 396.98 and w.held = 103.02, format('hold math wrong: %s / %s', w.available, w.held);
  assert (select usdt_amount from public.buy_orders where id = o1) = 10, 'usdt derived from LYD';
  perform pg_temp.expect_error(format('select public.create_buy_order(%L,%L,102,null,''TEST'',%L)', u1, q1, addr), 'quote_used');
  perform pg_temp.expect_error(format('select public.create_buy_order(%L,%L,1,1,''TEST'',%L)', u1, (public.create_quote(u1,'buy')).id, addr), 'exactly_one');

  q2 := (public.create_quote(u1, 'buy')).id;
  perform pg_temp.expect_error(format('select public.create_buy_order(%L,%L,null,1000,''TEST'',%L)', u1, q2, addr), 'insufficient_balance');
  perform pg_temp.expect_error(format('select public.create_buy_order(%L,%L,null,1,''TEST'',''bad'')', u1, q2), 'invalid_address');

  -- reject returns the hold exactly once
  perform pg_temp.expect_error(format('select public.release_buy_order(%L,%L,''rejected'',''x'')', u1, o1), 'forbidden');
  perform public.buy_order_set_status(stf, o1, 'approved');
  perform public.release_buy_order(stf, o1, 'rejected', 'test rejection');
  select * into w from public.wallets where user_id = u1;
  assert w.available = 500 and w.held = 0, 'rejection restores balance';
  perform pg_temp.expect_error(format('select public.release_buy_order(%L,%L,''rejected'',''again'')', stf, o1), 'illegal_transition');
  assert (select count(*) from public.ledger_transactions where reverses_transaction_id is not null) = 1, 'one reversing entry';

  -- ---- BUY: full manual completion
  q3 := (public.create_quote(u1, 'buy')).id;
  o2 := public.create_buy_order(u1, q3, null, 10, 'TEST', addr);            -- 10 USDT -> 102.00 + 1.02
  perform pg_temp.expect_error(format('select public.complete_buy_order(%L,%L,''TEST'',%L,10,''tx-aaaaaaaa'')', stf, o2, addr), 'illegal_transition');
  perform public.buy_order_set_status(stf, o2, 'approved');
  perform public.buy_order_set_status(stf, o2, 'processing');
  perform pg_temp.expect_error(format('select public.complete_buy_order(%L,%L,''TEST'',%L,10,''tx-aaaaaaaa'')', u1, o2, addr), 'forbidden');
  perform pg_temp.expect_error(format('select public.complete_buy_order(%L,%L,''TEST'',''Twrongaddress1234'',10,''tx-aaaaaaaa'')', stf, o2), 'confirmation_mismatch');
  perform pg_temp.expect_error(format('select public.complete_buy_order(%L,%L,''TEST'',%L,9.5,''tx-aaaaaaaa'')', stf, o2, addr), 'confirmation_mismatch');
  perform public.complete_buy_order(stf, o2, 'TEST', addr, 10, 'tx-aaaaaaaa', 'sent manually');
  select * into w from public.wallets where user_id = u1;
  assert w.available = 500 - 103.02 and w.held = 0, 'held debited, nothing double-charged';
  assert (select status from public.buy_orders where id = o2) = 'completed';
  perform pg_temp.expect_error(format('select public.complete_buy_order(%L,%L,''TEST'',%L,10,''tx-aaaaaaaa'')', stf, o2, addr), 'illegal_transition');

  -- same TXID cannot close another order
  o3 := public.create_buy_order(u1, (public.create_quote(u1,'buy')).id, null, 1, 'TEST', addr);
  perform public.buy_order_set_status(stf, o3, 'approved');
  perform public.buy_order_set_status(stf, o3, 'processing');
  perform pg_temp.expect_error(format('select public.complete_buy_order(%L,%L,''TEST'',%L,1,''tx-aaaaaaaa'')', stf, o3, addr), 'txid_already_used');
  assert (select status from public.buy_orders where id = o3) = 'processing', 'failed completion leaves order untouched';

  -- order terms are frozen
  perform pg_temp.expect_error(format('update public.buy_orders set price = 1 where id = %L', o3), 'frozen');

  -- every ledger transaction balances per currency; cache equals ledger truth
  assert not exists (
    select 1 from public.ledger_entries group by transaction_id, currency
    having sum(case direction when 'debit' then amount else -amount end) <> 0), 'all transactions balanced';
  assert not exists (select 1 from public.v_wallet_ledger_mismatch), 'wallet cache matches ledger';

  raise notice 'ALL 002 TESTS PASSED';
end $$;

rollback;
