drop policy if exists "restaurant_hubrise_connections_open"
  on public.restaurant_hubrise_connections;

create policy "restaurant_hubrise_connections_member_access"
  on public.restaurant_hubrise_connections
  for select to authenticated
  using (
    exists (
      select 1
      from public.restaurants r
      where r.id = restaurant_id
        and r.owner_id = auth.uid()
    )
    or exists (
      select 1
      from public.restaurant_members m
      where m.restaurant_id = restaurant_hubrise_connections.restaurant_id
        and m.user_id = auth.uid()
        and m.active
    )
    or public.is_platform_admin()
  );

revoke all on public.restaurant_hubrise_connections from anon;

notify pgrst, 'reload schema';