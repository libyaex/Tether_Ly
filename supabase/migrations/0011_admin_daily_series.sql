-- 0011: daily completed-volume and fee series for the admin dashboard chart.
-- Read-only, staff-gated (reports.read) and callable only through the `api` Edge Function (service_role).
-- Days are bucketed in Africa/Tripoli. The range is capped at 93 days to keep the query cheap.

create function public.admin_daily_series(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.actor_has_permission(p_actor, 'reports.read') then raise exception 'forbidden'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '93 days' then
    raise exception 'invalid_range';
  end if;

  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'day', d.day,
               'buy_volume_lyd', coalesce(b.vol, 0),
               'sell_volume_lyd', coalesce(s.vol, 0),
               'fees_lyd', coalesce(b.fee, 0) + coalesce(s.fee, 0))
             order by d.day)
      from (
        select distinct (g at time zone 'Africa/Tripoli')::date as day
          from generate_series(p_from, p_to - interval '1 second', interval '1 day') as g
      ) d
      left join (
        select (created_at at time zone 'Africa/Tripoli')::date as day, sum(lyd_gross) as vol, sum(lyd_fee) as fee
          from public.buy_orders
         where status = 'completed' and created_at >= p_from and created_at < p_to
         group by 1
      ) b on b.day = d.day
      left join (
        select (created_at at time zone 'Africa/Tripoli')::date as day, sum(lyd_gross) as vol, sum(lyd_fee) as fee
          from public.sell_orders
         where status = 'completed' and created_at >= p_from and created_at < p_to
         group by 1
      ) s on s.day = d.day
  ), '[]'::jsonb);
end $$;

revoke all on function public.admin_daily_series(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_daily_series(uuid, timestamptz, timestamptz) to service_role;
