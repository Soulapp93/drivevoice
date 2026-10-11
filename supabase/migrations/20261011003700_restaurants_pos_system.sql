-- Ajout de la colonne pos_system sur la table restaurants.
-- Valeurs autorisées : 'hubrise' (défaut), 'deliverect', 'direct_pos'.
alter table public.restaurants
  add column if not exists pos_system text not null default 'hubrise'
    check (pos_system in ('hubrise', 'deliverect', 'direct_pos'));

-- Mise à jour des fonctions admin pour accepter le choix du système de caisse.

create or replace function public.admin_create_client_account(
  p_admin_id uuid,
  p_organization_name text,
  p_restaurant_name text,
  p_address text,
  p_city text,
  p_code text,
  p_manager_name text,
  p_manager_email text,
  p_manager_role text,
  p_pos_system text default 'hubrise'
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
  v_pos_system text;
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

  v_pos_system := case when p_pos_system in ('hubrise', 'deliverect', 'direct_pos') then p_pos_system else 'hubrise' end;

  insert into public.organizations (name)
  values (btrim(p_organization_name))
  returning id into created_organization_id;

  insert into public.restaurants (organization_id, name, address, city, code, pos_system)
  values (
    created_organization_id,
    btrim(p_restaurant_name),
    nullif(btrim(coalesce(p_address, '')), ''),
    nullif(btrim(coalesce(p_city, '')), ''),
    nullif(btrim(coalesce(p_code, '')), ''),
    v_pos_system
  )
  returning id into created_restaurant_id;

  insert into public.restaurant_invitations (
    restaurant_id, organization_id, email, full_name, role, status
  ) values (
    created_restaurant_id, created_organization_id,
    lower(btrim(p_manager_email)), btrim(p_manager_name), p_manager_role, 'pending'
  )
  returning id into created_invitation_id;

  return jsonb_build_object(
    'organization_id', created_organization_id,
    'restaurant_id', created_restaurant_id,
    'invitation_id', created_invitation_id
  );
end;
$$;

create or replace function public.admin_add_client_restaurant(
  p_admin_id uuid,
  p_organization_id uuid,
  p_restaurant_name text,
  p_address text,
  p_city text,
  p_code text,
  p_manager_name text,
  p_manager_email text,
  p_manager_role text,
  p_pos_system text default 'hubrise'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created_restaurant_id uuid;
  created_invitation_id uuid;
  v_pos_system text;
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

  v_pos_system := case when p_pos_system in ('hubrise', 'deliverect', 'direct_pos') then p_pos_system else 'hubrise' end;

  insert into public.restaurants (organization_id, name, address, city, code, pos_system)
  values (
    p_organization_id,
    btrim(p_restaurant_name),
    nullif(btrim(coalesce(p_address, '')), ''),
    nullif(btrim(coalesce(p_city, '')), ''),
    nullif(btrim(coalesce(p_code, '')), ''),
    v_pos_system
  )
  returning id into created_restaurant_id;

  insert into public.restaurant_invitations (
    restaurant_id, organization_id, email, full_name, role, status
  ) values (
    created_restaurant_id, p_organization_id,
    lower(btrim(p_manager_email)), btrim(p_manager_name), p_manager_role, 'pending'
  )
  returning id into created_invitation_id;

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'restaurant_id', created_restaurant_id,
    'invitation_id', created_invitation_id
  );
end;
$$;
