-- 0009_customer_summary_and_visibility.sql
-- Customer-facing read needs found while building the UI. STATUS: written, NOT yet executed against a real Postgres.

-- Customers may see the TXID of THEIR OWN orders (never the whole registry).
create policy transfers_own on public.usdt_transfers for select to authenticated
  using (exists (select 1 from public.buy_orders b where b.outgoing_transfer_id = usdt_transfers.id and b.user_id = auth.uid())
      or exists (select 1 from public.sell_orders s where s.incoming_transfer_id = usdt_transfers.id and s.user_id = auth.uid()));

-- Settings the UI must be able to read before login (not secrets): top-up limits, DPay environment label.
insert into public.admin_settings(key, value, is_public) values
  ('payments.topup_min_lyd', 'null', true), ('payments.topup_max_lyd', 'null', true),
  ('trading.sell_deposit_window_minutes', '120', true), ('payments.checkout_ttl_minutes', '30', false)
on conflict (key) do nothing;
update public.admin_settings set is_public = true
 where key in ('payments.dpay_mode', 'payments.topup_min_lyd', 'payments.topup_max_lyd', 'trading.sell_deposit_window_minutes');

-- Real totals for the signed-in customer's dashboard (computed in SQL; a new account yields exact zeros).
create function public.my_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;
  return jsonb_build_object(
    'available', coalesce((select available from public.wallets where user_id = v_uid), 0),
    'held',      coalesce((select held from public.wallets where user_id = v_uid), 0),
    'deposits_total_lyd', coalesce((select sum(amount) from public.deposit_orders where user_id = v_uid and status = 'paid'), 0),
    'buy_total_lyd',  coalesce((select sum(lyd_gross) from public.buy_orders where user_id = v_uid and status = 'completed'), 0),
    'buy_total_usdt', coalesce((select sum(usdt_amount) from public.buy_orders where user_id = v_uid and status = 'completed'), 0),
    'sell_total_lyd',  coalesce((select sum(lyd_gross) from public.sell_orders where user_id = v_uid and status = 'completed'), 0),
    'sell_total_usdt', coalesce((select sum(usdt_received) from public.sell_orders where user_id = v_uid and status = 'completed'), 0),
    'last_buy_price',  (select price from public.buy_orders  where user_id = v_uid order by created_at desc limit 1),
    'last_sell_price', (select price from public.sell_orders where user_id = v_uid order by created_at desc limit 1),
    'pending_orders', (select (select count(*) from public.deposit_orders where user_id = v_uid and status in ('pending','awaiting_payment'))
                            + (select count(*) from public.buy_orders  where user_id = v_uid and status in ('pending_review','approved','processing','needs_attention'))
                            + (select count(*) from public.sell_orders where user_id = v_uid and status in ('awaiting_deposit','deposit_submitted','needs_review','awaiting_payout'))),
    'unread_notifications', (select count(*) from public.notifications where user_id = v_uid and read_at is null));
end $$;
revoke all on function public.my_summary() from public, anon;
grant execute on function public.my_summary() to authenticated;

-- Mark all of my notifications read in one call (the table grant only allows read_at updates on own rows).
create function public.mark_all_notifications_read() returns void
language sql security definer set search_path = public as $$
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null;
$$;
revoke all on function public.mark_all_notifications_read() from public, anon;
grant execute on function public.mark_all_notifications_read() to authenticated;
