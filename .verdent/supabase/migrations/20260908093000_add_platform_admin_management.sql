create or replace function public.is_platform_admin(check_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = check_user_id and active
  );
$$;

revoke all on function public.is_platform_admin(uuid) from public;
grant execute on function public.is_platform_admin(uuid) to authenticated, service_role;

drop policy if exists platform_admins_authenticated on public.platform_admins;
create policy platform_admins_management on public.platform_admins
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());