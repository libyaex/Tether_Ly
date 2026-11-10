-- 0010_resolve_deposit_review.sql
-- Staff resolution of deposits quarantined as needs_review (amount/currency/reference mismatch).
-- 'credit' shares the idempotency key 'deposit:<id>' with apply_checkout, so a later provider confirmation can never
-- credit a second time. STATUS: written, NOT yet executed against a real Postgres.
create function public.resolve_deposit_review(p_actor uuid, p_order uuid, p_decision text, p_provider_ref text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare o public.deposit_orders; clr uuid; av uuid; tx uuid;
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'deposits.review') then raise exception 'forbidden'; end if;
  select * into o from public.deposit_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if p_actor = o.user_id then raise exception 'self_dealing'; end if;
  if o.status <> 'needs_review' then raise exception 'illegal_transition'; end if;
  if char_length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'reason_required'; end if;
  if p_decision = 'fail' then
    update public.deposit_orders set status = 'failed', review_reason = p_note where id = o.id;
    perform public._notify(o.user_id, 'deposit_failed', 'warning', 'لم تكتمل عملية الشحن', 'لم يُضف أي مبلغ إلى محفظتك. تواصل مع الدعم إن كنت قد دفعت.',
                           'deposit_order', o.id, '/wallet/deposits/' || o.id, 'deposit-failed:' || o.id);
  elsif p_decision = 'credit' then
    if char_length(btrim(coalesce(p_provider_ref, ''))) < 4 then raise exception 'reference_required'; end if;   -- evidence of the provider-side payment
    select id into clr from public.ledger_accounts where code = 'SYS-PROVIDER-CLEARING-LYD';
    select available_account_id into av from public.wallets where user_id = o.user_id;
    tx := public.post_ledger_transaction('deposit:' || o.id, 'deposit', 'deposit_order', o.id, 'Manually resolved deposit: ' || p_note,
      jsonb_build_array(jsonb_build_object('account_id', clr, 'direction', 'debit', 'amount', o.amount),
                        jsonb_build_object('account_id', av, 'direction', 'credit', 'amount', o.amount)), null, p_actor);
    update public.deposit_orders set status = 'paid', credited_transaction_id = tx, provider_tx_id = btrim(p_provider_ref), review_reason = p_note where id = o.id;
    perform public._notify(o.user_id, 'deposit_paid', 'success', 'تم شحن محفظتك بنجاح', null, 'deposit_order', o.id, '/wallet/deposits/' || o.id, 'deposit-paid:' || o.id);
  else raise exception 'invalid_decision';
  end if;
end $$;
revoke all on function public.resolve_deposit_review(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_deposit_review(uuid, uuid, text, text, text) to service_role;
