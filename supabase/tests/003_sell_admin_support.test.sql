-- Run:  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/003_sell_admin_support.test.sql
-- One rolled-back transaction. STATUS: written, NOT yet run (no Postgres in the authoring environment).
begin;

create schema test_helpers;
grant usage on schema test_helpers to public;
create or replace function test_helpers.expect_error(sql text, needle text) returns void language plpgsql as $$
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
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid(); fm uuid := gen_random_uuid(); sa uuid := gen_random_uuid();
  m_wallet uuid; m_iban uuid; m2 uuid; q uuid; o1 uuid; o2 uuid; o3 uuid; o4 uuid; o5 uuid; o6 uuid;
  adj uuid; tk uuid; w record; d jsonb; r jsonb; n integer; i integer;
  addr text := 'Tdeposit1234567890';
begin
  insert into auth.users(id, email, raw_user_meta_data) values
    (u1,'c1@t.local','{"full_name":"Customer One"}'), (u2,'c2@t.local','{"full_name":"Customer Two"}'),
    (s1,'s1@t.local','{"full_name":"Sell Op One"}'),   (s2,'s2@t.local','{"full_name":"Sell Op Two"}'),
    (fm,'fm@t.local','{"full_name":"Finance Mgr"}'),   (sa,'sa@t.local','{"full_name":"Super Admin"}');
  update public.profiles set status = 'active';
  insert into public.user_roles(user_id, role) values
    (s1,'sell_operator'), (s2,'sell_operator'), (fm,'finance_manager'), (sa,'super_admin');

  update public.admin_settings set value = 'true' where key = 'trading.sell_enabled';
  insert into public.supported_networks(code, display_name, status, address_regex) values ('TEST','Test','active','^T[a-z0-9]{10,}$');
  insert into public.deposit_addresses(network_code, address, status) values ('TEST', addr, 'active');
  insert into public.exchange_rates(sell_price, buy_price, buy_fee_pct, sell_fee_pct, min_buy_lyd, max_buy_lyd, min_sell_usdt, max_sell_usdt)
    values (10.20, 10.00, 1.0, 1.0, 10, 20000, 1, 5000);

  -- ---- two-person ledger adjustment funds company cash (no one can self-approve)
  adj := public.request_adjustment(fm, (select id from public.ledger_accounts where code = 'SYS-CASH-LYD'), 'debit', 10000, 'Opening bank liquidity for tests');
  perform test_helpers.expect_error(format('select public.decide_adjustment(%L,%L,true)', fm, adj), 'separation_of_duties');
  perform test_helpers.expect_error(format('select public.request_adjustment(%L,%L,''debit'',1,''too short'')', s1, (select id from public.ledger_accounts where code='SYS-CASH-LYD')), 'forbidden');
  perform public.decide_adjustment(sa, adj, true);
  assert public._acct_net_debit('SYS-CASH-LYD') = 10000, 'adjustment posted';
  perform test_helpers.expect_error(format('select public.decide_adjustment(%L,%L,true)', sa, adj), 'illegal_transition');

  -- ---- payout methods
  m_wallet := public.create_payout_method(u1, 'internal_wallet', null, null, null, null, true);
  perform test_helpers.expect_error(format('select public.create_payout_method(%L,''bank_iban'',''A B'',''Bank'',''LY00BADIBAN0000000000'',null,false)', u1), 'invalid_iban');
  m_iban := public.create_payout_method(u1, 'bank_iban', 'Customer One', 'Test Bank', 'LY83 0020 4800 0020 1001 2036 1', null, false);
  assert (select iban from public.payout_methods where id = m_iban) = 'LY83002048000020100120361', 'IBAN normalised';
  assert (select count(*) from public.payout_methods where user_id = u1 and is_default) = 1, 'single default';

  -- ---- SELL happy path: 100 USDT @ 10.00, fee 1% => gross 1000.00, fee 10.00, net 990.00
  q := (public.create_quote(u1, 'sell')).id;
  o1 := public.create_sell_order(u1, q, 100, 'TEST', m_wallet);
  select lyd_gross, lyd_fee, lyd_net into w from public.sell_orders where id = o1;
  assert w.lyd_gross = 1000 and w.lyd_fee = 10 and w.lyd_net = 990, 'sell math';
  perform test_helpers.expect_error(format('select public.create_sell_order(%L,%L,100,''TEST'',%L)', u1, q, m_wallet), 'quote_used');

  -- a method used by an open order cannot be edited/archived; an unused one can (and loses its verification)
  perform public.update_payout_method(u1, m_iban, 'Customer One', 'Test Bank 2', 'LY83002048000020100120361', null);
  assert (select verification from public.payout_methods where id = m_iban) = 'unverified', 'edit resets verification';
  perform test_helpers.expect_error(format('select public.update_payout_method(%L,%L,''A B'',''B'',null,null)', u1, m_wallet), 'method_in_use');
  perform test_helpers.expect_error(format('select public.archive_payout_method(%L,%L)', u1, m_wallet), 'method_in_use');

  -- ---- customer submits the TXID
  perform test_helpers.expect_error(format('select public.submit_sell_txid(%L,%L,''short'')', u1, o1), 'invalid_txid');
  perform test_helpers.expect_error(format('select public.submit_sell_txid(%L,%L,''txid-sell-0001'',null,%L)', u1, o1, u2::text || '/proof.png'), 'invalid_proof_path');
  perform public.submit_sell_txid(u1, o1, 'txid-sell-0001', 'Tsender1234567890', u1::text || '/proof.png');
  assert (select status from public.sell_orders where id = o1) = 'deposit_submitted';
  perform test_helpers.expect_error(format('select public.cancel_sell_order(%L,%L)', u1, o1), 'illegal_transition');

  o2 := public.create_sell_order(u1, (public.create_quote(u1, 'sell')).id, 10, 'TEST', m_wallet);
  perform test_helpers.expect_error(format('select public.submit_sell_txid(%L,%L,''txid-sell-0001'')', u1, o2), 'txid_already_used');

  -- ---- staff reviews the incoming USDT
  perform test_helpers.expect_error(format('select public.review_sell_deposit(%L,%L,''approve'',99,true,null)', s1, o1), 'amount_mismatch');
  perform test_helpers.expect_error(format('select public.review_sell_deposit(%L,%L,''approve'',100,false,null)', s1, o1), 'note_required');
  perform test_helpers.expect_error(format('select public.review_sell_deposit(%L,%L,''approve'',100,true,null)', fm, o1), 'forbidden');
  perform test_helpers.expect_error(format('select public.review_sell_deposit(%L,%L,''approve'',100,true,null)', u1, o1), 'forbidden');
  perform public.review_sell_deposit(s1, o1, 'approve', 100, false, 'Amount, network and sender address matched manually');
  assert (select status from public.sell_orders where id = o1) = 'awaiting_payout';
  assert public._acct_net_debit('SYS-CUSTOMER-PAYABLE-LYD') = -990, 'payable = net';
  assert public._acct_net_debit('SYS-USDT') = 100, 'company USDT increased';
  assert public._acct_net_debit('SYS-FEE-REVENUE-LYD') = -10, 'fee revenue booked';
  assert (select verification from public.usdt_transfers where txid = 'txid-sell-0001') = 'unverified', 'manual attestation is not on-chain verification';
  perform test_helpers.expect_error(format('select public.review_sell_deposit(%L,%L,''approve'',100,false,''again again'')', s1, o1), 'illegal_transition');

  -- ---- payout: record by one person, approve by ANOTHER; neither may be the deposit approver
  perform test_helpers.expect_error(format('select public.record_sell_payout(%L,%L,''REF-0001'')', s1, o1), 'separation_of_duties');
  perform test_helpers.expect_error(format('select public.record_sell_payout(%L,%L,''ab'')', s2, o1), 'reference_required');
  perform public.record_sell_payout(s2, o1, 'INTERNAL-REF-0001');
  perform test_helpers.expect_error(format('select public.record_sell_payout(%L,%L,''INTERNAL-REF-0002'')', s2, o1), 'payout_already_recorded');
  perform test_helpers.expect_error(format('select public.approve_sell_payout(%L,%L)', s2, o1), 'forbidden');
  perform public.approve_sell_payout(fm, o1);
  assert (select status from public.sell_orders where id = o1) = 'completed';
  assert (select available from public.wallets where user_id = u1) = 990, 'internal-wallet payout credited exactly once';
  assert public._acct_net_debit('SYS-CUSTOMER-PAYABLE-LYD') = 0, 'payable cleared';
  perform test_helpers.expect_error(format('select public.approve_sell_payout(%L,%L)', fm, o1), 'illegal_transition');

  -- ---- rejection frees the TXID for the rightful owner
  perform public.submit_sell_txid(u1, o2, 'txid-sell-0002');
  perform test_helpers.expect_error(format('select public.review_sell_deposit(%L,%L,''reject'',null,null,null)', s1, o2), 'reason_required');
  perform public.review_sell_deposit(s1, o2, 'reject', null, null, 'TXID does not match any incoming transfer');
  assert (select status from public.sell_orders where id = o2) = 'rejected';
  assert (select verification from public.usdt_transfers where txid = 'txid-sell-0002') = 'rejected';
  o3 := public.create_sell_order(u1, (public.create_quote(u1, 'sell')).id, 10, 'TEST', m_wallet);
  perform public.submit_sell_txid(u1, o3, 'txid-sell-0002');                      -- allowed: the rejected claim no longer locks it
  perform public.review_sell_deposit(s1, o3, 'approve', 10, true, null);
  -- super admin holds every permission, so the executor == approver rule must still stop it
  perform public.record_sell_payout(sa, o3, 'INTERNAL-REF-0003');
  perform test_helpers.expect_error(format('select public.approve_sell_payout(%L,%L)', sa, o3), 'separation_of_duties');
  perform public.approve_sell_payout(fm, o3);
  assert (select available from public.wallets where user_id = u1) = 990 + 99;

  -- ---- bank payout leaves the wallet alone and reduces company cash
  o4 := public.create_sell_order(u1, (public.create_quote(u1, 'sell')).id, 20, 'TEST', m_iban);
  perform public.submit_sell_txid(u1, o4, 'txid-sell-0004');
  perform public.review_sell_deposit(s1, o4, 'approve', 20, true, null);
  assert (select verification from public.usdt_transfers where txid = 'txid-sell-0004') = 'verified_onchain';
  perform public.record_sell_payout(s2, o4, 'BANK-TRANSFER-0004');
  perform public.approve_sell_payout(fm, o4);
  assert public._acct_net_debit('SYS-CASH-LYD') = 10000 - 198, 'bank payout reduced company cash';
  assert (select available from public.wallets where user_id = u1) = 990 + 99, 'bank payout does not touch the wallet';
  perform test_helpers.expect_error(format('update public.sell_orders set payout_snapshot = ''{}''::jsonb where id = %L', o4), 'snapshot');
  perform test_helpers.expect_error(format('update public.sell_orders set price = 1 where id = %L', o4), 'frozen');

  -- ---- expiry; a late TXID goes to manual review, never auto-accepted
  o5 := public.create_sell_order(u1, (public.create_quote(u1, 'sell')).id, 5, 'TEST', m_wallet);
  update public.sell_orders set expires_at = now() - interval '1 minute' where id = o5;
  assert public.expire_sell_orders() >= 1, 'expiry sweep';
  assert (select status from public.sell_orders where id = o5) = 'expired';
  perform public.submit_sell_txid(u1, o5, 'txid-sell-0005');
  assert (select status from public.sell_orders where id = o5) = 'needs_review', 'late TXID -> manual review';

  -- ---- order policy: daily limit and large-order flag
  insert into public.admin_settings(key, value) values ('trading.user_daily_limit_lyd', '1000'), ('trading.large_order_lyd', '150');
  perform test_helpers.expect_error(format('select public.create_sell_order(%L,%L,10,''TEST'',%L)', u1, (public.create_quote(u1,'sell')).id, m_wallet), 'daily_limit_exceeded');
  m2 := public.create_payout_method(u2, 'internal_wallet', null, null, null, null, true);
  o6 := public.create_sell_order(u2, (public.create_quote(u2, 'sell')).id, 20, 'TEST', m2);   -- gross 200 >= 150
  assert (select flagged_large from public.sell_orders where id = o6), 'large order flagged';
  assert exists (select 1 from public.notifications where user_id = s1 and type = 'staff_large_order'), 'staff alerted';
  update public.admin_settings set value = '""' where key = 'trading.user_daily_limit_lyd';

  -- ---- admin: settings and go-live gate
  perform test_helpers.expect_error(format('select public.update_setting(%L,''platform.name'',''"X"''::jsonb)', s1), 'forbidden');
  perform test_helpers.expect_error(format('select public.update_setting(%L,''trading.buy_enabled'',''"yes"''::jsonb)', sa), 'invalid_value');
  perform test_helpers.expect_error(format('select public.update_setting(%L,''dpay.webhook_secret'',''"x"''::jsonb)', sa), 'check');
  perform test_helpers.expect_error(format('select public.update_setting(%L,''payments.dpay_mode'',''"live"''::jsonb)', sa), 'confirmation_required');
  perform test_helpers.expect_error(format('select public.update_setting(%L,''payments.dpay_mode'',''"live"''::jsonb,''GO LIVE'')', sa), 'live_readiness_failed');
  assert public._setting('payments.dpay_mode') = 'sandbox', 'still sandbox';

  -- ---- admin: roles and account status
  perform test_helpers.expect_error(format('select public.grant_role(%L,%L,''support_agent'')', fm, u2), 'forbidden');
  perform test_helpers.expect_error(format('select public.grant_role(%L,%L,''admin'')', sa, sa), 'self_dealing');
  perform public.grant_role(sa, u2, 'support_agent');
  assert public.actor_has_permission(u2, 'support.reply'), 'role granted';
  perform public.revoke_role(sa, u2, 'support_agent');
  assert not public.actor_has_permission(u2, 'support.reply'), 'role revoked';
  perform test_helpers.expect_error(format('select public.revoke_role(%L,%L,''super_admin'')', sa, sa), 'last_super_admin');
  perform test_helpers.expect_error(format('select public.set_user_status(%L,%L,''suspended'',''Suspicious activity'')', s1, u2), 'forbidden');
  perform test_helpers.expect_error(format('select public.set_user_status(%L,%L,''suspended'',''no'')', sa, u2), 'reason_required');
  perform test_helpers.expect_error(format('select public.set_user_status(%L,%L,''suspended'',''Suspicious activity'')', sa, sa), 'self_dealing');
  perform public.set_user_status(sa, u2, 'suspended', 'Suspicious activity under review');
  perform test_helpers.expect_error(format('select public.create_quote(%L,''sell'')', u2), 'account_not_active');
  perform public.set_user_status(sa, u2, 'active', 'Review finished, cleared');

  -- ---- support
  tk := public.create_ticket(u1, 'sell_issue', 'Payout question', 'Please check my sell order', 'sell_order', o1, null);
  perform test_helpers.expect_error(format('select public.create_ticket(%L,''sell_issue'',''Not mine'',''body'',''sell_order'',%L)', u2, o1), 'related_not_found');
  perform test_helpers.expect_error(format('select public.reply_ticket(%L,%L,''hello'')', s1, tk), 'forbidden');
  perform public.reply_ticket(sa, tk, 'We are checking your order');
  assert (select status from public.support_tickets where id = tk) = 'pending_customer';
  assert (select first_response_at from public.support_tickets where id = tk) is not null;
  assert (select count(*) from public.notifications where user_id = u1 and type = 'support_reply') = 1;
  perform public.reply_ticket(u1, tk, 'Thank you');
  assert (select status from public.support_tickets where id = tk) = 'pending_staff';
  perform test_helpers.expect_error(format('select public.close_ticket(%L,%L)', u2, tk), 'forbidden');
  perform public.close_ticket(u1, tk);
  perform test_helpers.expect_error(format('select public.reply_ticket(%L,%L,''more'')', u1, tk), 'ticket_closed');
  perform test_helpers.expect_error(format('select public.reopen_ticket(%L,%L)', u2, tk), 'not_found');
  perform public.reopen_ticket(u1, tk);
  assert (select reopen_count from public.support_tickets where id = tk) = 1;
  for i in 1..4 loop perform public.create_ticket(u1, 'other', 'Extra ticket ' || i, 'body ' || i); end loop;
  perform test_helpers.expect_error(format('select public.create_ticket(%L,''other'',''One too many'',''body'')', u1), 'too_many_open_tickets');
  perform test_helpers.expect_error('update public.support_messages set body = ''edited''', 'append-only');
  perform test_helpers.expect_error('delete from public.support_messages', 'append-only');

  -- ---- web push
  perform public.register_push_subscription(u1, 'https://push.test/endpoint-1', 'k1', 'a1', 'UA');
  perform public.register_push_subscription(u2, 'https://push.test/endpoint-1', 'k2', 'a2', 'UA');   -- device switched account
  assert (select user_id from public.push_subscriptions where endpoint = 'https://push.test/endpoint-1') = u2;
  perform test_helpers.expect_error(format('select public.register_push_subscription(%L,''http://insecure.test/x'',''k'',''a'')', u1), 'invalid_endpoint');

  -- ---- reports and ops checks
  d := public.admin_dashboard(fm);
  assert (d->>'reconciliation_mismatches')::integer = 0, 'dashboard: no mismatches';
  perform test_helpers.expect_error(format('select public.admin_dashboard(%L)', s1), 'forbidden');
  r := public.admin_report(fm, now() - interval '1 day', now() + interval '1 day');
  assert (r->'net_profit') = 'null'::jsonb, 'net profit is never fabricated';
  assert (r->>'fee_revenue_lyd')::numeric >= 13, 'fee revenue visible';
  assert (public.run_ops_checks()->>'mismatches')::integer = 0, 'ops checks clean';

  -- ---- RLS as an ordinary customer (u2): sees only own rows, cannot call RPCs
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u2::text, true);
  set local role authenticated;
  assert (select count(*) from public.support_tickets) = 0, 'u2 cannot see u1 tickets';
  assert (select count(*) from public.sell_orders where user_id <> u2) = 0, 'u2 cannot see other sell orders';
  assert (select count(*) from public.payout_methods where user_id <> u2) = 0, 'u2 cannot see other payout methods';
  assert (select count(*) from public.usdt_transfers) = 0, 'customers cannot read the TXID registry';
  assert (select count(*) from public.adjustment_requests) = 0, 'customers cannot read adjustments';
  begin
    perform public.create_sell_order(u2, gen_random_uuid(), 1, 'TEST', m2);
    raise exception 'customer called a service-role RPC';
  exception when insufficient_privilege then null; end;
  begin
    update public.notifications set title = 'x' where user_id = u2;
    raise exception 'customer edited notification text';
  exception when insufficient_privilege then null; end;
  reset role;

  -- ---- global invariants
  assert not exists (
    select 1 from public.ledger_entries group by transaction_id, currency
    having sum(case direction when 'debit' then amount else -amount end) <> 0), 'all transactions balanced';
  assert not exists (select 1 from public.v_wallet_ledger_mismatch), 'wallet cache matches ledger';

  raise notice 'ALL 003 TESTS PASSED';
end $$;

rollback;
