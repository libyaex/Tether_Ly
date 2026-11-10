-- ONE-TIME operator script: creates the first super admin. Run it once, after the first user has registered normally.
-- Run from the Supabase SQL editor (service role) or:  psql "$SUPABASE_DB_URL" -v admin_email='you@example.com' -f supabase/bootstrap/first_super_admin.sql
-- It refuses to run if a super admin already exists, so it cannot be used to escalate privileges later.
\set ON_ERROR_STOP on
\if :{?admin_email}
\else
  \echo 'Pass -v admin_email=... (the registered account email)'
  \quit 1
\endif

do $$
declare
  v_email text := :'admin_email';
  v_user uuid;
begin
  if exists (select 1 from public.user_roles where role = 'super_admin' and revoked_at is null) then
    raise exception 'a super admin already exists; use the admin panel (Staff) to grant further roles';
  end if;
  select id into v_user from auth.users where lower(email) = lower(v_email);
  if v_user is null then raise exception 'no account with email %', v_email; end if;
  update public.profiles set status = 'active' where id = v_user;
  insert into public.user_roles (user_id, role, granted_by) values (v_user, 'super_admin', v_user);
  raise notice 'super_admin granted to % (%)', v_email, v_user;
end $$;
