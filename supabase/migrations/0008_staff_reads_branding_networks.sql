-- 0008_staff_reads_branding_networks.sql
-- Gaps found while designing the UI: staff read access to customer data, my_permissions(), editable branding/content
-- settings, network + deposit-address admin RPCs, optional auto-activation on signup.
-- STATUS: written, NOT yet executed against a real Postgres.

-- ---------------------------------------------------------------- profiles.email (staff need to identify customers)
alter table public.profiles add column email text;
update public.profiles p set email = u.email from auth.users u where u.id = p.id;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare a_id uuid; h_id uuid; v_status account_status;
begin
  -- security.auto_activate_on_signup = true skips manual review (admin choice; default false)
  v_status := case when coalesce((select value #>> '{}' from public.admin_settings where key = 'security.auto_activate_on_signup'), 'false')::boolean
                   then 'active' else 'pending_verification' end;
  insert into public.profiles(id, full_name, phone, email, status)
  values (new.id, coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'), ''), 'مستخدم جديد'),
          new.raw_user_meta_data->>'phone', new.email, v_status);
  insert into public.ledger_accounts(code, name, kind, currency, owner_user_id)
    values ('CUST-AVL-'||new.id, 'Customer available LYD', 'customer_available', 'LYD', new.id) returning id into a_id;
  insert into public.ledger_accounts(code, name, kind, currency, owner_user_id)
    values ('CUST-HLD-'||new.id, 'Customer held LYD', 'customer_held', 'LYD', new.id) returning id into h_id;
  insert into public.wallets(user_id, available_account_id, held_account_id) values (new.id, a_id, h_id);
  return new;
end $$;

-- ---------------------------------------------------------------- staff read policies
create policy profiles_select_staff on public.profiles for select to authenticated
  using (public.has_permission('users.read') or public.has_permission('roles.manage'));
create policy wallets_select_staff on public.wallets for select to authenticated
  using (public.has_permission('users.read'));
create policy accounts_select_staff on public.ledger_accounts for select to authenticated
  using (public.has_permission('ledger.adjust') or public.has_permission('reports.read') or public.has_permission('users.read'));
create policy entries_select_staff on public.ledger_entries for select to authenticated
  using (public.has_permission('users.read') or public.has_permission('reports.read'));
create policy tx_select_staff on public.ledger_transactions for select to authenticated
  using (public.has_permission('users.read') or public.has_permission('reports.read'));

-- UI gating only (the database still enforces every permission itself)
create function public.my_permissions() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct rp.permission), '{}')
  from public.user_roles ur
  join public.role_permissions rp on rp.role = ur.role
  join public.profiles pr on pr.id = ur.user_id
  where ur.user_id = auth.uid() and ur.revoked_at is null and pr.status = 'active';
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

-- ---------------------------------------------------------------- editable branding / content (public settings)
-- Content pages are seeded EMPTY on purpose: legal text must be written/approved by the owner, never invented here.
insert into public.admin_settings(key, value, is_public) values
  ('platform.tagline', '""', true), ('platform.description', '""', true), ('platform.logo_url', '""', true),
  ('platform.primary_color', '"#0B2545"', true), ('platform.accent_color', '"#0E9F8E"', true),
  ('platform.support_email', '""', true), ('platform.support_phone', '""', true),
  ('platform.website', '""', true), ('platform.legal_entity', '""', true),
  ('platform.social_links', '{}', true), ('platform.timezone', '"Africa/Tripoli"', true),
  ('maintenance.message', '""', true), ('maintenance.eta', '""', true), ('maintenance.allow_staff', 'true', true),
  ('security.auto_activate_on_signup', 'false', false),
  ('content.about', '""', true), ('content.how_it_works', '""', true), ('content.fees', '""', true),
  ('content.faq', '[]', true), ('content.terms', '""', true), ('content.privacy', '""', true),
  ('content.complaints', '""', true), ('content.refunds', '""', true), ('content.risk', '""', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- networks & deposit addresses (admin RPCs)
create function public.upsert_network(p_actor uuid, p_code text, p_display_name text, p_status text, p_min_deposit numeric,
    p_confirmations integer, p_address_regex text, p_explorer text, p_instructions text, p_warnings text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'settings.write') then raise exception 'forbidden'; end if;
  if p_code !~ '^[A-Z0-9_]{2,20}$' then raise exception 'invalid_network'; end if;
  if p_status not in ('active','disabled') then raise exception 'invalid_value'; end if;
  begin perform '' ~ p_address_regex; exception when invalid_regular_expression then raise exception 'invalid_regex'; end;
  if p_explorer is not null and p_explorer <> '' and p_explorer !~ '^https://' then raise exception 'invalid_value'; end if;
  insert into public.supported_networks(code, display_name, status, min_deposit, required_confirmations, address_regex,
                                        explorer_tx_url, instructions, warnings, updated_by)
  values (p_code, p_display_name, p_status, p_min_deposit, p_confirmations, p_address_regex,
          nullif(p_explorer, ''), p_instructions, p_warnings, p_actor)
  on conflict (code) do update set display_name = excluded.display_name, status = excluded.status,
      min_deposit = excluded.min_deposit, required_confirmations = excluded.required_confirmations,
      address_regex = excluded.address_regex, explorer_tx_url = excluded.explorer_tx_url,
      instructions = excluded.instructions, warnings = excluded.warnings, updated_by = excluded.updated_by, updated_at = now();
end $$;

create function public.add_deposit_address(p_actor uuid, p_network text, p_address text, p_instructions text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'settings.write') then raise exception 'forbidden'; end if;
  insert into public.deposit_addresses(network_code, address, status, instructions, updated_by)
  values (p_network, btrim(p_address), 'draft', p_instructions, p_actor) returning id into v_id;   -- trigger validates format
  return v_id;
end $$;

-- Replacement flow: the previously active address of the network is disabled in the same transaction.
create function public.activate_deposit_address(p_actor uuid, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.deposit_addresses;
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'settings.write') then raise exception 'forbidden'; end if;
  select * into a from public.deposit_addresses where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if a.status = 'disabled' then raise exception 'illegal_transition'; end if;     -- a disabled address is never revived; add a new one
  update public.deposit_addresses set status = 'disabled', updated_by = p_actor
   where network_code = a.network_code and status = 'active' and id <> a.id;
  update public.deposit_addresses set status = 'active', updated_by = p_actor where id = a.id;
end $$;

create function public.disable_deposit_address(p_actor uuid, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._as_actor(p_actor);
  if not public.actor_has_permission(p_actor, 'settings.write') then raise exception 'forbidden'; end if;
  update public.deposit_addresses set status = 'disabled', updated_by = p_actor where id = p_id;
  if not found then raise exception 'not_found'; end if;
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('upsert_network','add_deposit_address','activate_deposit_address','disable_deposit_address')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
