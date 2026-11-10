-- 0007_rate_limits.sql — DB-backed fixed-window rate limiter used by Edge Functions (service_role only).
-- STATUS: written, NOT yet executed against a real Postgres.
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create function public.check_rate_limit(p_key text, p_max integer, p_window_secs integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare w timestamptz; h integer;
begin
  if p_window_secs < 1 or p_max < 1 then raise exception 'invalid_rate_limit'; end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  insert into public.rate_limits(key, window_start, hits) values (left(p_key, 200), w, 1)
  on conflict (key, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into h;
  return h <= p_max;
end $$;

create function public.purge_rate_limits() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.purge_rate_limits() from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;
grant execute on function public.purge_rate_limits() to service_role;
