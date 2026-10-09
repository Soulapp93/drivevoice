create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'manager',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

alter table public.restaurants add column if not exists organization_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'restaurants_organization_id_fkey'
      and conrelid = 'public.restaurants'::regclass
  ) then
    alter table public.restaurants
      add constraint restaurants_organization_id_fkey
      foreign key (organization_id) references public.organizations(id) on delete restrict;
  end if;
end $$;

do $$
declare
  restaurant_row record;
  new_organization_id uuid;
begin
  for restaurant_row in
    select id, name
    from public.restaurants
    where organization_id is null
    order by created_at, id
  loop
    insert into public.organizations (name)
    values (coalesce(nullif(btrim(restaurant_row.name), ''), 'Restaurant client'))
    returning id into new_organization_id;

    update public.restaurants
    set organization_id = new_organization_id
    where id = restaurant_row.id;
  end loop;
end $$;

alter table public.restaurants alter column organization_id set not null;
create index if not exists idx_restaurants_organization_id on public.restaurants (organization_id);

insert into public.organization_members (organization_id, user_id, role)
select distinct r.organization_id, r.owner_id, 'owner'
from public.restaurants r
where r.owner_id is not null
on conflict (organization_id, user_id) do nothing;

create table if not exists public.restaurant_invitations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  email text not null,
  full_name text not null,
  role text not null,
  organization_id uuid references public.organizations(id) on delete cascade,
  organization_role text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'cancelled')),
  invited_by uuid references auth.users(id) on delete set null,
  auth_user_id uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.restaurant_invitations
  add column if not exists organization_id uuid references public.organizations(id) on delete cascade,
  add column if not exists organization_role text;

create unique index if not exists idx_restaurant_invitations_pending_email
  on public.restaurant_invitations (restaurant_id, lower(email))
  where status = 'pending';

alter table public.demo_requests
  add column if not exists status text not null default 'new',
  add column if not exists assigned_to uuid references auth.users(id) on delete set null,
  add column if not exists notes text not null default '',
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists organization_id uuid references public.organizations(id) on delete set null;

alter table public.demo_requests drop constraint if exists demo_requests_status_check;
alter table public.demo_requests add constraint demo_requests_status_check
  check (status in ('new', 'contacted', 'demo', 'converted', 'rejected'));
create index if not exists idx_demo_requests_status_received_at
  on public.demo_requests (status, received_at desc);

create table if not exists public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null unique references public.restaurants(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'closed')),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  sender_type text not null check (sender_type in ('platform_admin', 'restaurant')),
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists idx_support_conversations_last_message
  on public.support_conversations (last_message_at desc nulls last);
create index if not exists idx_support_messages_conversation_created
  on public.support_messages (conversation_id, created_at desc);
create index if not exists idx_support_messages_unread
  on public.support_messages (sender_type, conversation_id) where read_at is null;

create or replace function public.is_active_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid() and active = true
  );
$$;

create or replace function public.can_access_restaurant(target_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_platform_admin() or exists (
    select 1
    from public.restaurants r
    where r.id = target_restaurant_id
      and (
        r.owner_id = auth.uid()
        or exists (
          select 1 from public.restaurant_members rm
          where rm.restaurant_id = r.id and rm.user_id = auth.uid() and rm.active = true
        )
        or exists (
          select 1 from public.organization_members om
          where om.organization_id = r.organization_id and om.user_id = auth.uid() and om.active = true
        )
      )
  );
$$;

create or replace function public.can_manage_restaurant(target_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_platform_admin() or exists (
    select 1
    from public.restaurants r
    where r.id = target_restaurant_id
      and (
        r.owner_id = auth.uid()
        or exists (
          select 1 from public.restaurant_members rm
          where rm.restaurant_id = r.id and rm.user_id = auth.uid() and rm.active = true
            and lower(rm.role) in ('owner', 'admin', 'manager', 'directeur', 'administrateur')
        )
        or exists (
          select 1 from public.organization_members om
          where om.organization_id = r.organization_id and om.user_id = auth.uid() and om.active = true
            and lower(om.role) in ('owner', 'admin', 'manager', 'directeur', 'administrateur')
        )
      )
  );
$$;

revoke all on function public.is_active_platform_admin() from public, anon;
revoke all on function public.can_access_restaurant(uuid) from public, anon;
revoke all on function public.can_manage_restaurant(uuid) from public, anon;
grant execute on function public.is_active_platform_admin() to authenticated, service_role;
grant execute on function public.can_access_restaurant(uuid) to authenticated, service_role;
grant execute on function public.can_manage_restaurant(uuid) to authenticated, service_role;

create or replace function public.admin_create_client_account(
  p_admin_id uuid,
  p_organization_name text,
  p_restaurant_name text,
  p_address text,
  p_city text,
  p_code text,
  p_manager_name text,
  p_manager_email text,
  p_manager_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created_organization_id uuid;
  created_restaurant_id uuid;
  created_invitation_id uuid;
begin
  if not exists (
    select 1 from public.platform_admins
    where user_id = p_admin_id and active = true
  ) then
    raise exception 'Accès administrateur requis.' using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_organization_name, ''))) not between 1 and 160
    or length(btrim(coalesce(p_restaurant_name, ''))) not between 1 and 160
    or length(btrim(coalesce(p_manager_name, ''))) not between 2 and 120
    or lower(btrim(coalesce(p_manager_email, ''))) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_manager_role not in ('Directeur', 'Manager') then
    raise exception 'Les informations du compte sont invalides.' using errcode = '22023';
  end if;

  insert into public.organizations (name)
  values (btrim(p_organization_name))
  returning id into created_organization_id;

  insert into public.restaurants (organization_id, name, address, city, code)
  values (
    created_organization_id,
    btrim(p_restaurant_name),
    nullif(btrim(coalesce(p_address, '')), ''),
    nullif(btrim(coalesce(p_city, '')), ''),
    nullif(btrim(coalesce(p_code, '')), '')
  )
  returning id into created_restaurant_id;

  insert into public.restaurant_invitations (
    restaurant_id, organization_id, organization_role, email, full_name, role, invited_by
  ) values (
    created_restaurant_id, created_organization_id, 'owner',
    lower(btrim(p_manager_email)), btrim(p_manager_name), p_manager_role, p_admin_id
  )
  returning id into created_invitation_id;

  return jsonb_build_object(
    'organization_id', created_organization_id,
    'restaurant_id', created_restaurant_id,
    'invitation_id', created_invitation_id
  );
end;
$$;

revoke all on function public.admin_create_client_account(uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_create_client_account(uuid, text, text, text, text, text, text, text, text) to service_role;

create or replace function public.admin_add_client_restaurant(
  p_admin_id uuid,
  p_organization_id uuid,
  p_restaurant_name text,
  p_address text,
  p_city text,
  p_code text,
  p_manager_name text,
  p_manager_email text,
  p_manager_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created_restaurant_id uuid;
  created_invitation_id uuid;
begin
  if not exists (
    select 1 from public.platform_admins
    where user_id = p_admin_id and active = true
  ) then
    raise exception 'Accès administrateur requis.' using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_restaurant_name, ''))) not between 1 and 160
    or length(btrim(coalesce(p_manager_name, ''))) not between 2 and 120
    or lower(btrim(coalesce(p_manager_email, ''))) !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    or p_manager_role not in ('Directeur', 'Manager')
    or not exists (select 1 from public.organizations where id = p_organization_id and active = true) then
    raise exception 'Les informations du restaurant sont invalides.' using errcode = '22023';
  end if;

  insert into public.restaurants (organization_id, name, address, city, code)
  values (
    p_organization_id,
    btrim(p_restaurant_name),
    nullif(btrim(coalesce(p_address, '')), ''),
    nullif(btrim(coalesce(p_city, '')), ''),
    nullif(btrim(coalesce(p_code, '')), '')
  )
  returning id into created_restaurant_id;

  insert into public.restaurant_invitations (
    restaurant_id, organization_id, organization_role, email, full_name, role, invited_by
  ) values (
    created_restaurant_id, p_organization_id, 'manager',
    lower(btrim(p_manager_email)), btrim(p_manager_name), p_manager_role, p_admin_id
  )
  returning id into created_invitation_id;

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'restaurant_id', created_restaurant_id,
    'invitation_id', created_invitation_id
  );
end;
$$;

revoke all on function public.admin_add_client_restaurant(uuid, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_add_client_restaurant(uuid, uuid, text, text, text, text, text, text, text) to service_role;

create or replace function public.admin_attach_client_invitation(
  p_admin_id uuid,
  p_invitation_id uuid,
  p_auth_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  invitation_row record;
begin
  if not exists (
    select 1 from public.platform_admins
    where user_id = p_admin_id and active = true
  ) then
    raise exception 'Accès administrateur requis.' using errcode = '42501';
  end if;

  select restaurant_id, organization_id, role, organization_role
  into invitation_row
  from public.restaurant_invitations
  where id = p_invitation_id and status = 'pending'
  for update;
  if not found then
    raise exception 'Invitation introuvable ou déjà traitée.' using errcode = 'P0002';
  end if;

  update public.restaurant_invitations
  set auth_user_id = p_auth_user_id
  where id = p_invitation_id;

  insert into public.organization_members (organization_id, user_id, role, active)
  values (invitation_row.organization_id, p_auth_user_id, coalesce(invitation_row.organization_role, 'manager'), true)
  on conflict (organization_id, user_id) do update set active = true;

  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values (invitation_row.restaurant_id, p_auth_user_id, invitation_row.role, true)
  on conflict (restaurant_id, user_id) do update set role = excluded.role, active = true;

  update public.restaurants
  set owner_id = p_auth_user_id
  where id = invitation_row.restaurant_id and owner_id is null;
end;
$$;

revoke all on function public.admin_attach_client_invitation(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_attach_client_invitation(uuid, uuid, uuid) to service_role;

create or replace function public.touch_support_conversation_from_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.support_conversations
  set last_message_at = new.created_at, status = 'open'
  where id = new.conversation_id;
  return new;
end;
$$;

revoke all on function public.touch_support_conversation_from_message() from public, anon, authenticated;
drop trigger if exists trg_support_message_touch_conversation on public.support_messages;
create trigger trg_support_message_touch_conversation
after insert on public.support_messages
for each row execute function public.touch_support_conversation_from_message();

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.restaurant_invitations enable row level security;
alter table public.support_conversations enable row level security;
alter table public.support_messages enable row level security;
alter table public.demo_requests enable row level security;
alter table public.restaurants enable row level security;
alter table public.restaurant_products enable row level security;

revoke all on public.organizations, public.organization_members, public.restaurant_invitations,
  public.support_conversations, public.support_messages from anon, authenticated;
grant select on public.organizations, public.organization_members, public.restaurant_invitations,
  public.support_conversations, public.support_messages to authenticated;
grant all on public.organizations, public.organization_members, public.restaurant_invitations,
  public.support_conversations, public.support_messages to service_role;

drop policy if exists organizations_member_read on public.organizations;
create policy organizations_member_read on public.organizations
  for select to authenticated using (
    public.is_active_platform_admin()
    or exists (
      select 1 from public.organization_members om
      where om.organization_id = organizations.id and om.user_id = auth.uid() and om.active = true
    )
  );

drop policy if exists organization_members_self_read on public.organization_members;
create policy organization_members_self_read on public.organization_members
  for select to authenticated using (user_id = auth.uid() or public.is_active_platform_admin());

drop policy if exists restaurant_invitations_manager_read on public.restaurant_invitations;
create policy restaurant_invitations_manager_read on public.restaurant_invitations
  for select to authenticated using (public.can_manage_restaurant(restaurant_id));

drop policy if exists support_conversations_member_read on public.support_conversations;
create policy support_conversations_member_read on public.support_conversations
  for select to authenticated using (public.can_access_restaurant(restaurant_id));

drop policy if exists support_messages_member_read on public.support_messages;
create policy support_messages_member_read on public.support_messages
  for select to authenticated using (
    exists (
      select 1 from public.support_conversations c
      where c.id = support_messages.conversation_id
        and public.can_access_restaurant(c.restaurant_id)
    )
  );

drop policy if exists demo_requests_active_admin_update on public.demo_requests;
create policy demo_requests_active_admin_update on public.demo_requests
  for update to authenticated using (public.is_active_platform_admin())
  with check (public.is_active_platform_admin());
grant update on public.demo_requests to authenticated;

-- Replace the legacy tenant-wide policies: client access now requires an authenticated membership.
drop policy if exists restaurants_open on public.restaurants;
drop policy if exists restaurants_member_read on public.restaurants;
create policy restaurants_member_read on public.restaurants
  for select to authenticated using (public.can_access_restaurant(id));
drop policy if exists restaurants_manager_update on public.restaurants;
create policy restaurants_manager_update on public.restaurants
  for update to authenticated using (public.can_manage_restaurant(id))
  with check (public.can_manage_restaurant(id));
revoke all on public.restaurants from anon;
grant select, update on public.restaurants to authenticated;

drop policy if exists restaurant_products_open on public.restaurant_products;
drop policy if exists restaurant_products_member_read on public.restaurant_products;
create policy restaurant_products_member_read on public.restaurant_products
  for select to authenticated using (public.can_access_restaurant(restaurant_id));
drop policy if exists restaurant_products_manager_insert on public.restaurant_products;
create policy restaurant_products_manager_insert on public.restaurant_products
  for insert to authenticated with check (public.can_manage_restaurant(restaurant_id));
drop policy if exists restaurant_products_manager_update on public.restaurant_products;
create policy restaurant_products_manager_update on public.restaurant_products
  for update to authenticated using (public.can_manage_restaurant(restaurant_id))
  with check (public.can_manage_restaurant(restaurant_id));
drop policy if exists restaurant_products_manager_delete on public.restaurant_products;
create policy restaurant_products_manager_delete on public.restaurant_products
  for delete to authenticated using (public.can_manage_restaurant(restaurant_id));
revoke all on public.restaurant_products from anon;
grant select, insert, update, delete on public.restaurant_products to authenticated;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_organizations_updated on public.organizations;
create trigger trg_organizations_updated before update on public.organizations
  for each row execute function public.set_updated_at();
drop trigger if exists trg_support_conversations_updated on public.support_conversations;
create trigger trg_support_conversations_updated before update on public.support_conversations
  for each row execute function public.set_updated_at();
drop trigger if exists trg_demo_requests_updated on public.demo_requests;
create trigger trg_demo_requests_updated before update on public.demo_requests
  for each row execute function public.set_updated_at();
