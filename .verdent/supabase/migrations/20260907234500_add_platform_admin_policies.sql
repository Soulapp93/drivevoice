drop policy if exists platform_admin_restaurants_access on public.restaurants;
create policy platform_admin_restaurants_access on public.restaurants
  for all to authenticated
  using (exists (select 1 from public.platform_admins a where a.user_id = auth.uid() and a.active))
  with check (exists (select 1 from public.platform_admins a where a.user_id = auth.uid() and a.active));

drop policy if exists platform_admin_invitations_access on public.restaurant_invitations;
create policy platform_admin_invitations_access on public.restaurant_invitations
  for all to authenticated
  using (exists (select 1 from public.platform_admins a where a.user_id = auth.uid() and a.active))
  with check (exists (select 1 from public.platform_admins a where a.user_id = auth.uid() and a.active));

drop policy if exists platform_admin_orders_access on public.restaurant_orders;
create policy platform_admin_orders_access on public.restaurant_orders
  for all to authenticated
  using (exists (select 1 from public.platform_admins a where a.user_id = auth.uid() and a.active))
  with check (exists (select 1 from public.platform_admins a where a.user_id = auth.uid() and a.active));