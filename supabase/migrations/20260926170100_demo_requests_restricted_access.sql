create or replace function public.is_active_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.platform_admins
    where user_id = auth.uid()
      and active = true
  );
$$;

revoke all on function public.is_active_platform_admin() from public, anon;
grant execute on function public.is_active_platform_admin() to authenticated;

revoke all on table public.demo_requests from anon, authenticated, service_role;
grant insert on table public.demo_requests to anon;
grant select on table public.demo_requests to authenticated;

create policy demo_requests_public_insert
  on public.demo_requests
  for insert
  to anon
  with check (
    length(btrim(full_name)) between 2 and 120
    and length(btrim(email)) between 6 and 254
    and lower(btrim(email)) = email
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    and length(btrim(phone)) between 6 and 40
    and length(regexp_replace(phone, '\D', '', 'g')) >= 6
    and length(btrim(restaurant_name)) between 1 and 160
    and restaurant_count between 1 and 10000
    and role in ('Propriétaire / franchisé', 'Directeur / directrice', 'Responsable réseau', 'Autre')
    and length(btrim(message)) between 10 and 4000
  );

create policy demo_requests_active_admin_read
  on public.demo_requests
  for select
  to authenticated
  using (public.is_active_platform_admin());
