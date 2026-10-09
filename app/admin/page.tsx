'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, supabaseAnonKey, supabaseUrl } from '@/lib/supabase/client';
import { adminApiRequest } from '@/lib/admin/client';
import { SupportPanel } from '@/components/support-panel';

type AdminTab = 'overview' | 'restaurants' | 'demos' | 'quality' | 'demo-requests' | 'support' | 'admins';
type HubRiseStatus = { connected: boolean; status: string; lastSyncAt: string | null; lastError: string | null };
type RestaurantDetails = { products: number; orders: { day: number; week: number; month: number; total: number }; aiAudits: number | null };
type Restaurant = { id: string; name: string; address: string | null; city: string | null; code: string | null; brand_id: string | null; brand_name: string | null; master_brands?: { name: string }[] | null; active: boolean; created_at: string };
type RestaurantRow = { id: string; name: string; address: string | null; city: string | null; code: string | null; active: boolean; created_at: string; brand_id: string | null; master_brands?: { name: string }[] | null; };
type PlatformAdmin = { id: string; user_id: string; full_name: string; role: string; active: boolean; created_at: string };
type DemoRequest = { id: string; full_name: string; email: string; phone: string; restaurant_name: string; restaurant_count: number; role: string; message: string; received_at: string; status: 'new' | 'contacted' | 'demo' | 'converted' | 'rejected'; assigned_to: string | null; notes: string; updated_at: string; organization_id: string | null };
type ClientOrganization = { id: string; name: string; active: boolean; created_at: string; restaurants: RestaurantRow[]; organization_members: Array<{ id: string; user_id: string; role: string; active: boolean; created_at: string }>; restaurant_invitations: Array<{ id: string; restaurant_id: string; email: string; full_name: string; role: string; status: string; invited_at: string }> };
type CreateRestaurantDraft = { name: string; organizationName: string; organizationId: string; address: string; city: string; siret: string; brand: string; phone: string; managerName: string; managerEmail: string; role: string };

const demoRestaurantIds = new Set<string>(['31065664-a449-4fe3-a311-de880b436726', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890']);
const restaurantWorkspace = new Map([
  ['31065664-a449-4fe3-a311-de880b436726', '/restaurant?restaurant=bk-loire&tab=order'],
  ['a1b2c3d4-e5f6-7890-abcd-ef1234567890', '/restaurant?restaurant=piazza-republique&tab=order'],
]);
const tabs: Array<[AdminTab, string, string]> = [['overview', 'Vue d’ensemble', '▥'], ['restaurants', 'Restaurants clients', '▦'], ['demos', 'Restaurants démo', '◇'], ['quality', 'Qualité IA', '◌'], ['demo-requests', 'Demandes d’intégration', '✉'], ['support', 'Messagerie support', '◉'], ['admins', 'Administrateurs internes', '◎']];

function normalizeRestaurant(row: RestaurantRow): Restaurant {
  const brandName = row.master_brands?.[0]?.name ?? null;
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    code: row.code,
    brand_id: row.brand_id,
    brand_name: brandName,
    master_brands: row.master_brands ?? null,
    active: row.active,
    created_at: row.created_at,
  };
}

export default function AdminPage() {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [organizations, setOrganizations] = useState<ClientOrganization[]>([]);
  const [selected, setSelected] = useState<Restaurant | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState({ name: '', organizationName: '', organizationId: '', address: '', city: '', siret: '', brand: '', phone: '', managerName: '', managerEmail: '', role: 'Directeur' });
  const [convertingRequestId, setConvertingRequestId] = useState<string | null>(null);
  const [admins, setAdmins] = useState<PlatformAdmin[]>([]);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminDraft, setAdminDraft] = useState({ fullName: '', email: '', role: 'Administrateur' });
  const [demoRequests, setDemoRequests] = useState<DemoRequest[]>([]);
  const [demoRequestsLoading, setDemoRequestsLoading] = useState(false);
  const [demoRequestsError, setDemoRequestsError] = useState(() => supabase ? '' : 'Configuration Supabase indisponible.');

  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
    window.location.assign('/login');
  };

  const reloadOrganizations = useCallback(async () => {
    const result = await adminApiRequest<{ organizations: ClientOrganization[] }>('/api/admin/organizations');
    const rows = result.organizations ?? [];
    setOrganizations(rows);
    const refreshed = rows.flatMap((organization) => organization.restaurants.map((restaurant) => normalizeRestaurant(restaurant)));
    setRestaurants(refreshed);
    setSelected((previous) => previous ? refreshed.find((restaurant) => restaurant.id === previous.id) ?? null : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        await reloadOrganizations();
      } catch (error) {
        if (current) setNotice(error instanceof Error ? error.message : 'Impossible de charger le portefeuille clients.');
        if (current) setLoading(false);
      }
    };
    const initialTimer = window.setTimeout(() => void load(), 0);
    const refreshTimer = window.setInterval(() => void load(), 15000);
    return () => {
      current = false;
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
    };
  }, [reloadOrganizations]);
  useEffect(() => {
    if (tab !== 'admins') return;
    let current = true;
    void adminApiRequest<{ admins: PlatformAdmin[] }>('/api/admin/invite')
      .then((result) => { if (current) setAdmins(result.admins ?? []); })
      .catch((error: unknown) => { if (current) setNotice(error instanceof Error ? error.message : 'Impossible de charger les administrateurs.'); });
    return () => { current = false; };
  }, [tab]);
  useEffect(() => {
    if (tab !== 'demo-requests') return;
    if (!supabase) return;
    let current = true;
    let authUnsubscribe: (() => void) | null = null;
    const loadDemoRequests = async (knownAccessToken?: string) => {
      setDemoRequestsLoading(true);
      setDemoRequestsError('');
      try {
        let accessToken = knownAccessToken;
        if (!accessToken) {
          const { data: sessionData } = await supabase.auth.getSession();
          accessToken = sessionData.session?.access_token;
        }
        if (!accessToken) {
          const { data: refreshedSession, error: refreshError } = await supabase.auth.refreshSession();
          if (refreshError) throw refreshError;
          accessToken = refreshedSession.session?.access_token;
        }
        if (!accessToken) throw new Error('Session administrateur expirée.');

        const request = async (token: string) => fetch('/api/admin/demo-requests', {
          headers: { authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        let response = await request(accessToken);
        if (response.status === 401) {
          const { data: refreshedSession, error: refreshError } = await supabase.auth.refreshSession();
          if (refreshError || !refreshedSession.session?.access_token) {
            throw refreshError ?? new Error('Session administrateur expirée.');
          }
          response = await request(refreshedSession.session.access_token);
        }
        const result = await response.json() as { requests?: DemoRequest[]; error?: string };
        if (!response.ok) throw new Error(result.error || 'Impossible de charger les demandes.');
        if (current) setDemoRequests(result.requests ?? []);
      } catch (error) {
        if (current) setDemoRequestsError(error instanceof Error ? error.message : 'Impossible de charger les demandes.');
      } finally {
        if (current) setDemoRequestsLoading(false);
      }
    };
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') && session?.access_token) {
        void loadDemoRequests(session.access_token);
      }
    });
    authUnsubscribe = data.subscription.unsubscribe;
    void loadDemoRequests();
    return () => {
      current = false;
      if (authUnsubscribe) authUnsubscribe();
    };
  }, [tab]);
  const demoRestaurants = useMemo(() => restaurants.filter((restaurant) => demoRestaurantIds.has(restaurant.id)), [restaurants]);
  const clientRestaurants = useMemo(() => restaurants, [restaurants]);
  const activeCount = useMemo(() => clientRestaurants.filter((restaurant) => restaurant.active).length, [clientRestaurants]);
  const selectedClientRestaurant = clientRestaurants.find((restaurant) => restaurant.id === selected?.id) ?? null;
  const selectedDemoRestaurant = demoRestaurants.find((restaurant) => restaurant.id === selected?.id) ?? null;

  const createRestaurant = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const result = await adminApiRequest<{ organizationId: string; restaurantId: string; invitationSent: boolean; error?: string }>('/api/admin/organizations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: draft.organizationId || undefined,
          organizationName: draft.organizationName,
          restaurantName: draft.name,
          address: draft.address,
          city: draft.city,
          code: draft.siret,
          managerName: draft.managerName,
          managerEmail: draft.managerEmail,
          managerRole: draft.role,
        }),
      });
      setCreateOpen(false);
      setDraft({ name: '', organizationName: '', organizationId: '', address: '', city: '', siret: '', brand: '', phone: '', managerName: '', managerEmail: '', role: 'Directeur' });
      await reloadOrganizations();
      setSelected({ id: result.restaurantId, name: draft.name, address: draft.address || null, city: draft.city || null, code: draft.siret || null, brand_id: null, brand_name: null, active: true, created_at: new Date().toISOString() });
      let conversionNotice = '';
      if (convertingRequestId) {
        try {
          const update = await adminApiRequest<{ request: Partial<DemoRequest> }>('/api/admin/demo-requests', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: convertingRequestId, status: 'converted', organizationId: result.organizationId }),
          });
          setDemoRequests((current) => current.map((request) => request.id === convertingRequestId ? { ...request, ...update.request } : request));
          conversionNotice = ' Demande marquée comme convertie.';
        } catch (error) {
          conversionNotice = ` Le compte est créé, mais la demande n’a pas pu être convertie : ${error instanceof Error ? error.message : 'erreur inconnue'}`;
        }
        setConvertingRequestId(null);
      }
      setNotice(`${result.error ?? (result.invitationSent ? 'Restaurant créé et invitation envoyée.' : 'Restaurant créé, mais l’invitation n’a pas été envoyée.')}${conversionNotice}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Impossible de créer ce compte client.');
    }
  };

  const inviteAdmin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { data: sessionData } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
    const response = await fetch('/api/admin/invite', { method: 'POST', headers: { 'content-type': 'application/json', ...(sessionData.session ? { authorization: `Bearer ${sessionData.session.access_token}` } : {}) }, body: JSON.stringify(adminDraft) });
    const result = await response.json() as { error?: string; admin?: PlatformAdmin };
    if (!response.ok) { setNotice(result.error ?? 'Invitation impossible.'); return; }
    if (result.admin) setAdmins((current) => [result.admin!, ...current]);
    setAdminOpen(false);
    setAdminDraft({ fullName: '', email: '', role: 'Administrateur' });
    setNotice('Invitation envoyée. Le nouvel administrateur pourra définir son accès depuis son e-mail.');
  };

  return (
    <main className="min-h-screen bg-[#f4f6f1] text-[#132018] lg:grid lg:grid-cols-[270px_1fr]">
      <aside className="relative overflow-hidden border-b border-white/10 bg-[#071a11]/95 p-5 text-white shadow-[10px_0_45px_rgba(7,26,17,.08)] backdrop-blur-2xl lg:sticky lg:top-0 lg:min-h-screen lg:border-b-0 lg:border-r lg:border-white/10 lg:p-7"><div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-[#ffc647]/10 blur-3xl" /><div className="relative flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#ff5a36] text-lg font-black shadow-[0_8px_25px_rgba(255,90,54,.25)]">D</span><div><p className="font-black tracking-[-.04em]">DRIVE<span className="text-[#ff7556]">VOICE</span></p><p className="text-[9px] uppercase tracking-[.18em] text-white/40">Platform admin</p></div></div><Link href="/" className="relative mt-6 inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 px-4 text-xs font-bold text-white/65 transition hover:border-[#ffc647]/50 hover:bg-white/[.06] hover:text-white">← Accueil DriveVoice</Link><div className="relative mt-10 rounded-2xl border border-white/10 bg-white/[.06] p-4 shadow-inner backdrop-blur-xl"><p className="text-[9px] font-black uppercase tracking-[.17em] text-white/40">Espace actif</p><p className="mt-2 text-sm font-black">Administration plateforme</p><p className="mt-1 text-[10px] text-white/45">Données Supabase en direct</p></div><div className="relative mt-8"><p className="px-3 text-[9px] font-black uppercase tracking-[.2em] text-white/35">Administration</p><nav className="mt-4 space-y-1">{tabs.map(([id, label, icon]) => <button key={id} onClick={() => setTab(id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-xs font-black transition ${tab === id ? 'bg-white text-[#102019] shadow-[0_8px_25px_rgba(0,0,0,.12)]' : 'text-white/55 hover:bg-white/[.08] hover:text-white'}`}><span className={`grid h-8 w-8 place-items-center rounded-lg text-base ${tab === id ? 'bg-[#ff5a36] text-white' : 'bg-white/[.06]'}`}>{icon}</span>{label}</button>)}</nav></div><div className="relative mt-10 rounded-2xl border border-white/10 bg-white/[.04] p-4"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-[#ffc647] text-xs font-black text-[#172019]">AM</span><div><p className="text-xs font-black">Administrateur DriveVoice</p><p className="text-[9px] text-white/40">Accès plateforme</p></div></div><button onClick={signOut} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-[10px] font-black text-white/60 transition hover:border-[#ff7556] hover:bg-[#ff5a36] hover:text-white">↪ Se déconnecter</button></div></aside>
      <section className="min-w-0"><header className="sticky top-0 z-20 flex items-center justify-between border-b border-[#dfe5de]/80 bg-[#f4f6f1]/80 px-5 py-5 backdrop-blur-xl md:px-9"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#89938b]">DriveVoice / Back-office</p><h1 className="mt-1 text-lg font-black">{tabs.find(([id]) => id === tab)?.[1]}</h1></div></header><div className="mx-auto max-w-[1500px] p-5 md:p-9">
        {tab === 'overview' && <Overview restaurants={clientRestaurants} activeCount={activeCount} organizations={organizations} />}
        {tab === 'restaurants' && <><RestaurantList restaurants={clientRestaurants} loading={loading} selected={selectedClientRestaurant} setSelected={setSelected} onCreate={() => setCreateOpen(true)} mode="client" description="Portefeuille des établissements clients pour le suivi commercial." /><OrganizationsPortfolio organizations={organizations} /></>}
        {tab === 'demos' && <RestaurantList restaurants={demoRestaurants} loading={loading} selected={selectedDemoRestaurant} setSelected={setSelected} mode="demo" title="Restaurants démo" eyebrow="Environnements de démonstration" description="Comptes de démonstration pour tester l’espace restaurant." emptyMessage="Aucun restaurant de démonstration trouvé." />}
        {tab === 'quality' && <QualityPanel />}
        {tab === 'demo-requests' && <DemoRequestsPanel requests={demoRequests} loading={demoRequestsLoading} error={demoRequestsError} onUpdate={async (id, update) => {
          const result = await adminApiRequest<{ request: Partial<DemoRequest> }>('/api/admin/demo-requests', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, ...update }),
          });
          setDemoRequests((current) => current.map((request) => request.id === id ? { ...request, ...result.request } : request));
        }} onConvert={(request) => {
          setConvertingRequestId(request.id);
          setDraft({ name: request.restaurant_name, organizationName: request.restaurant_name, organizationId: '', address: '', city: '', siret: '', brand: '', phone: request.phone, managerName: request.full_name, managerEmail: request.email, role: request.role === 'Responsable réseau' ? 'Manager' : 'Directeur' });
          setCreateOpen(true);
          setTab('restaurants');
        }} />}
        {tab === 'support' && <SupportPanel mode="admin" restaurants={clientRestaurants.map(({ id, name }) => ({ id, name }))} />}
        {tab === 'admins' && <AdminsPanel admins={admins} onInvite={() => setAdminOpen(true)} />}
      </div></section>
      {createOpen && <CreateRestaurant draft={draft} setDraft={setDraft} organizations={organizations} onClose={() => { setCreateOpen(false); setConvertingRequestId(null); }} onSubmit={createRestaurant} />}
      {adminOpen && <AdminInvite draft={adminDraft} setDraft={setAdminDraft} onClose={() => setAdminOpen(false)} onSubmit={inviteAdmin} />}
      {notice && <div className="fixed bottom-5 right-5 rounded-2xl bg-[#0b1f14] px-5 py-4 text-xs font-bold text-white shadow-xl">{notice}</div>}
    </main>
  );
}

function Overview({ restaurants, activeCount, organizations }: { restaurants: Restaurant[]; activeCount: number; organizations: ClientOrganization[] }) {
  const [orderPeriod, setOrderPeriod] = useState<'jour' | 'semaine' | 'mois' | 'année'>('jour');

  const periodLabels = { jour: "aujourd'hui", semaine: 'cette semaine', mois: 'ce mois', année: 'cette année' };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Pilotage plateforme</p>
          <h2 className="mt-2 text-4xl font-black tracking-[-.05em]">Vue d&apos;ensemble</h2>
          <p className="mt-3 text-sm text-[#738078]">Une lecture réelle de l&apos;activité DriveVoice, alimentée par Supabase.</p>
        </div>
        <span className="rounded-full bg-[#e5f6e9] px-4 py-2 text-xs font-black text-[#27894a]">● Données live</span>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* Carte 1 : Nombre de restaurants clients */}
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <p className="text-xs font-bold text-[#89948b]">Restaurants clients</p>
          <p className="mt-4 text-4xl font-black">{restaurants.length}</p>
          <p className="mt-2 text-xs text-[#7d897f]">{activeCount} actifs</p>
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <p className="text-xs font-bold text-[#89948b]">Organisations clientes</p>
          <p className="mt-4 text-4xl font-black">{organizations.length}</p>
          <p className="mt-2 text-xs text-[#7d897f]">{organizations.filter((organization) => organization.active).length} actives · {restaurants.length} restaurants rattachés</p>
        </div>

        {/* Carte 3 : Commandes totales avec filtre */}
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between">
            <p className="text-xs font-bold text-[#89948b]">Commandes totales</p>
            <select
              value={orderPeriod}
              onChange={(e) => setOrderPeriod(e.target.value as typeof orderPeriod)}
              className="rounded-lg border border-[#dfe5de] bg-[#f8faf7] px-2 py-1 text-[10px] font-black outline-none"
            >
              <option value="jour">Jour</option>
              <option value="semaine">Semaine</option>
              <option value="mois">Mois</option>
              <option value="année">Année</option>
            </select>
          </div>
          <p className="mt-4 text-4xl font-black">—</p>
          <p className="mt-2 text-xs text-[#7d897f]">Aucune donnée {periodLabels[orderPeriod]}</p>
        </div>

        {/* Carte 4 : Compréhension IA générale */}
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <p className="text-xs font-bold text-[#89948b]">Compréhension IA</p>
          <p className="mt-4 text-4xl font-black">—</p>
          <p className="mt-2 text-xs text-[#7d897f]">Audits disponibles après conversations</p>
        </div>
      </div>
    </div>
  );
}

function isoWeekLabel(date: Date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function RestaurantList({ restaurants, loading, selected, setSelected, onCreate, mode = 'client', title = 'Restaurants clients', eyebrow = 'Portefeuille client', description = 'Liste complète des établissements enregistrés dans Supabase.', emptyMessage = 'Aucun restaurant enregistré. Créez le premier établissement pour démarrer.' }: { restaurants: Restaurant[]; loading: boolean; selected: Restaurant | null; setSelected: (restaurant: Restaurant | null) => void; onCreate?: () => void; mode?: 'client' | 'demo'; title?: string; eyebrow?: string; description?: string; emptyMessage?: string }) {
  const [dayDate, setDayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [weekDate, setWeekDate] = useState(() => isoWeekLabel(new Date()));
  const [monthDate, setMonthDate] = useState(() => new Date().toISOString().slice(0, 7));
  const [brandFilter, setBrandFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const dateFieldClass = 'rounded-lg border border-white/15 bg-white/10 px-2 py-1 text-[10px] font-bold text-white outline-none [color-scheme:dark] focus:border-[#ff7556]';
  const brandOptions = useMemo(() => {
    const brands = new Map<string, string>();
    restaurants.forEach((restaurant) => {
      if (restaurant.brand_id) brands.set(restaurant.brand_id, restaurant.master_brands?.[0]?.name || 'Enseigne non renseignée');
    });
    return [...brands.entries()].sort((a, b) => a[1].localeCompare(b[1], 'fr'));
  }, [restaurants]);
  const filteredRestaurants = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLocaleLowerCase('fr');
    return restaurants.filter((restaurant) => {
      const matchesBrand = brandFilter === 'all' || (brandFilter === 'none' ? !restaurant.brand_id : restaurant.brand_id === brandFilter);
      const searchableText = `${restaurant.name} ${restaurant.address || ''} ${restaurant.city || ''} ${restaurant.master_brands?.[0]?.name || ''}`.toLocaleLowerCase('fr');
      return matchesBrand && (!normalizedSearch || searchableText.includes(normalizedSearch));
    });
  }, [restaurants, brandFilter, searchTerm]);
  const hasUnbrandedRestaurants = restaurants.some((restaurant) => !restaurant.brand_id);
  const [hubriseStatus, setHubriseStatus] = useState<HubRiseStatus | null>(null);
  const [hubriseLoading, setHubriseLoading] = useState(false);
  const [hubriseLoadError, setHubriseLoadError] = useState('');
  const [restaurantDetails, setRestaurantDetails] = useState<RestaurantDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsLoadError, setDetailsLoadError] = useState('');
  const selectedIdRef = useRef<string | null>(null);
  const selectedId = selected?.id ?? null;

  useEffect(() => {
    if (mode === 'demo' || !selectedId) {
      selectedIdRef.current = null;
      return;
    }
    if (selectedIdRef.current !== selectedId) {
      selectedIdRef.current = selectedId;
      setHubriseStatus(null);
      setHubriseLoadError('');
      setRestaurantDetails(null);
      setDetailsLoadError('');
    }
    let current = true;
    let inFlight = false;
    const refreshDetails = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      setHubriseLoading(true);
      setDetailsLoading(true);
      let accessToken: string | undefined;
      try {
        const { data: sessionData } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
        accessToken = sessionData.session?.access_token;
      } catch (error) {
        if (current) {
          setHubriseLoadError(error instanceof Error ? error.message : 'Session administrateur indisponible.');
          setDetailsLoadError('Session administrateur indisponible.');
          setHubriseLoading(false);
          setDetailsLoading(false);
        }
        inFlight = false;
        return;
      }
      const query = new URLSearchParams({
        restaurantId: selectedId,
        day: dayDate,
        week: weekDate,
        month: monthDate,
      });
      const hubriseRequest = (async () => {
        if (!supabaseAnonKey) throw new Error('Clé publique Supabase indisponible.');
        const response = await fetch(`${supabaseUrl}/functions/v1/hubrise-oauth?action=status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${supabaseAnonKey}` },
          body: JSON.stringify({ restaurantId: selectedId }),
          cache: 'no-store',
        });
        const result = await response.json() as HubRiseStatus & { error?: string };
        if (!response.ok) throw new Error(result.error || 'Impossible de charger l’état HubRise.');
        if (current) {
          setHubriseStatus(result);
          setHubriseLoadError('');
        }
      })().catch((error) => {
        if (current) setHubriseLoadError(error instanceof Error ? error.message : 'Impossible de charger l’état HubRise.');
      }).finally(() => {
        if (current) setHubriseLoading(false);
      });
      const detailsRequest = (async () => {
        if (!accessToken) throw new Error('Session administrateur expirée.');
        const response = await fetch(`/api/admin/restaurant-details?${query}`, {
          headers: { authorization: `Bearer ${accessToken}` },
          cache: 'no-store',
        });
        const result = await response.json() as RestaurantDetails & { error?: string };
        if (!response.ok) throw new Error(result.error || 'Impossible de charger les indicateurs du restaurant.');
        if (current) {
          setRestaurantDetails(result);
          setDetailsLoadError('');
        }
      })().catch((error) => {
        if (current) setDetailsLoadError(error instanceof Error ? error.message : 'Impossible de charger les indicateurs du restaurant.');
      }).finally(() => {
        if (current) setDetailsLoading(false);
      });
      await Promise.all([hubriseRequest, detailsRequest]);
      inFlight = false;
    };
    void refreshDetails();
    const refreshTimer = window.setInterval(() => void refreshDetails(), 15000);
    const refreshOnFocus = () => void refreshDetails();
    const refreshOnVisibility = () => { if (document.visibilityState === 'visible') void refreshDetails(); };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return () => {
      current = false;
      window.clearInterval(refreshTimer);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, [mode, selectedId, dayDate, weekDate, monthDate]);

  return <div><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">{eyebrow}</p><h2 className="mt-2 text-4xl font-black tracking-[-.05em]">{title}</h2><p className="mt-3 text-sm text-[#738078]">{description}</p></div><div className="flex flex-wrap items-center gap-2"><label className="sr-only" htmlFor="restaurant-search">Rechercher un restaurant</label><input id="restaurant-search" type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Rechercher un restaurant…" className="w-full rounded-xl border border-[#dfe5de] bg-white px-4 py-3 text-xs outline-none focus:border-[#ff5a36] sm:w-56" /><label className="sr-only" htmlFor="restaurant-brand-filter">Filtrer par enseigne</label><select id="restaurant-brand-filter" value={brandFilter} onChange={(event) => setBrandFilter(event.target.value)} className="rounded-xl border border-[#dfe5de] bg-white px-4 py-3 text-xs font-bold outline-none focus:border-[#ff5a36]"><option value="all">Toutes les enseignes</option>{brandOptions.map(([brandId, brandName]) => <option key={brandId} value={brandId}>{brandName}</option>)}{hasUnbrandedRestaurants && <option value="none">Sans enseigne</option>}</select>{onCreate && <button onClick={onCreate} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">＋ Créer un restaurant</button>}</div></div><div className="mt-7 grid gap-5 xl:grid-cols-[1fr_360px]"><section className="overflow-hidden rounded-3xl bg-white shadow-sm"><div className="border-b border-[#edf0eb] px-5 py-4 text-xs font-black uppercase tracking-widest text-[#89948b]">{loading ? 'Chargement…' : `${filteredRestaurants.length} / ${restaurants.length} établissement${restaurants.length > 1 ? 's' : ''}`}</div>{restaurants.length ? filteredRestaurants.length ? <div className="divide-y divide-[#edf0eb]">{filteredRestaurants.map((restaurant) => <button key={restaurant.id} onClick={() => setSelected(restaurant)} className="flex w-full items-center justify-between px-5 py-5 text-left hover:bg-[#f8faf7]"><div><p className="text-sm font-black">{restaurant.name}</p><p className="mt-1 text-xs text-[#7c887f]">{restaurant.address || 'Adresse non renseignée'}{restaurant.city ? ` · ${restaurant.city}` : ''}</p></div><div className="flex items-center gap-3"><span className={`rounded-full px-3 py-1 text-[10px] font-black ${restaurant.active ? 'bg-[#e5f6e9] text-[#27894a]' : 'bg-[#f0f2ef] text-[#7c887f]'}`}>{restaurant.active ? 'Actif' : 'Inactif'}</span></div></button>)}</div> : <div className="p-10 text-center text-sm text-[#849087]">Aucun restaurant ne correspond à votre recherche ou à cette enseigne.</div> : <div className="p-10 text-center text-sm text-[#849087]">{emptyMessage}</div>}</section>{selected ? mode === 'demo' ? <section className="rounded-3xl bg-[#0b1f14] p-6 text-white"><p className="text-xs font-black uppercase tracking-widest text-[#ffc647]">Compte de démonstration</p><h3 className="mt-3 text-2xl font-black">{selected.name}</h3><p className="mt-3 text-sm text-white/60">{selected.address || 'Adresse non renseignée'}</p><p className="mt-4 text-xs text-white/60">Ce compte permet de tester l’espace restaurant DriveVoice sans affecter de vraies données commerciales.</p><button onClick={() => { const workspace = restaurantWorkspace.get(selected.id); if (workspace) window.location.assign(workspace); }} className="mt-6 w-full rounded-xl bg-[#ff5a36] py-3 text-xs font-black text-white">Se connecter</button></section> : <section className="rounded-3xl bg-[#0b1f14] p-6 text-white"><p className="text-xs font-black uppercase tracking-widest text-[#ffc647]">Détail restaurant</p><h3 className="mt-3 text-2xl font-black">{selected.name}</h3><p className="mt-3 text-sm text-white/60">{selected.address || 'Adresse non renseignée'}</p>{mode === 'demo' && restaurantWorkspace.get(selected.id) && <button onClick={() => { const workspace = restaurantWorkspace.get(selected.id); if (workspace) window.location.assign(workspace); }} className="mt-4 w-full rounded-xl bg-[#ff5a36] py-3 text-xs font-black text-white">Ouvrir l’espace restaurant</button>}<div className="mt-6 rounded-2xl border border-white/10 bg-white/[.05] p-4"><div className="flex items-center justify-between gap-3"><p className="text-xs font-black uppercase tracking-widest text-[#ffc647]">Connexion HubRise</p><span className={`rounded-full px-3 py-1 text-[10px] font-black ${hubriseLoading ? 'bg-white/10 text-white/60' : hubriseLoadError ? 'bg-[#fbe9e5] text-[#d95032]' : hubriseStatus?.connected ? 'bg-[#e5f6e9] text-[#27894a]' : 'bg-white/10 text-white/60'}`}>{hubriseLoading ? 'Chargement…' : hubriseLoadError ? 'Statut indisponible' : hubriseStatus?.connected ? 'Connecté à HubRise' : 'Non connecté à HubRise'}</span></div><div className="mt-4 space-y-3 text-xs"><div className="flex justify-between gap-3"><span className="text-white/55">Dernière synchronisation</span><strong className="text-right">{hubriseLoading ? '—' : hubriseLoadError ? 'Indisponible' : hubriseStatus?.lastSyncAt ? new Date(hubriseStatus.lastSyncAt).toLocaleString('fr-FR') : '—'}</strong></div><div className="flex justify-between gap-3"><span className="text-white/55">Erreurs de flux</span><strong className={`text-right ${hubriseLoading || hubriseLoadError ? 'text-[#ff927a]' : hubriseStatus?.lastError ? 'text-[#ff927a]' : 'text-[#9bd7a9]'}`}>{hubriseLoading ? '—' : hubriseLoadError ? 'Indisponible' : hubriseStatus?.lastError ? 'Erreur enregistrée' : 'Aucune erreur connue'}</strong></div>{hubriseStatus?.lastError && <p className="rounded-xl bg-[#ff5a36]/10 p-3 text-[11px] leading-relaxed text-[#ffb5a3]">{hubriseStatus.lastError}</p>}{hubriseLoadError && <p role="alert" className="text-[11px] text-[#ffb5a3]">{hubriseLoadError}</p>}</div></div><div className="mt-7 space-y-3"><div className="flex items-center justify-between border-b border-white/10 pb-3 text-xs"><span className="text-white/55">Produits</span><strong>{detailsLoading && !restaurantDetails ? 'Chargement…' : detailsLoadError ? 'Indisponible' : restaurantDetails?.products ?? '—'}</strong></div><div className="flex items-center justify-between gap-2 border-b border-white/10 pb-3 text-xs"><span className="text-white/55">Commandes jour</span><span className="flex items-center gap-2"><input aria-label="Date du jour consulté" type="date" value={dayDate} onChange={(event) => setDayDate(event.target.value)} className={dateFieldClass} /><strong>{detailsLoading && !restaurantDetails ? 'Chargement…' : detailsLoadError ? 'Indisponible' : restaurantDetails?.orders.day ?? '—'}</strong></span></div><div className="flex items-center justify-between gap-2 border-b border-white/10 pb-3 text-xs"><span className="text-white/55">Commandes semaine</span><span className="flex items-center gap-2"><input aria-label="Semaine consultée" type="week" value={weekDate} onChange={(event) => setWeekDate(event.target.value)} className={dateFieldClass} /><strong>{detailsLoading && !restaurantDetails ? 'Chargement…' : detailsLoadError ? 'Indisponible' : restaurantDetails?.orders.week ?? '—'}</strong></span></div><div className="flex items-center justify-between gap-2 border-b border-white/10 pb-3 text-xs"><span className="text-white/55">Commandes mois</span><span className="flex items-center gap-2"><input aria-label="Mois consulté" type="month" value={monthDate} onChange={(event) => setMonthDate(event.target.value)} className={dateFieldClass} /><strong>{detailsLoading && !restaurantDetails ? 'Chargement…' : detailsLoadError ? 'Indisponible' : restaurantDetails?.orders.month ?? '—'}</strong></span></div><div className="flex items-center justify-between border-b border-white/10 pb-3 text-xs"><span className="text-white/55">Commandes totales</span><strong>{detailsLoading && !restaurantDetails ? 'Chargement…' : detailsLoadError ? 'Indisponible' : restaurantDetails?.orders.total ?? '—'}</strong></div><div className="flex items-center justify-between border-b border-white/10 pb-3 text-xs"><span className="text-white/55">Audits IA</span><strong>{detailsLoading && !restaurantDetails ? 'Chargement…' : detailsLoadError ? 'Indisponible' : restaurantDetails?.aiAudits ?? '—'}</strong></div></div><p className="mt-4 text-[10px] text-white/40">Périodes consultées : {dayDate} · {weekDate} · {monthDate}</p><p className="mt-2 text-[10px] text-white/40">Mise à jour automatique toutes les 15 secondes et au retour sur cet onglet.</p>{detailsLoadError && <p role="alert" className="mt-2 text-[10px] leading-relaxed text-[#ffb5a3]">Indicateurs indisponibles : {detailsLoadError}</p>}</section> : <section className="rounded-3xl border border-dashed border-[#cad6cc] p-6 text-sm text-[#7b887f]">{mode === 'demo' ? 'Sélectionnez un compte de démonstration pour vous y connecter.' : 'Sélectionnez un restaurant pour consulter ses détails.'}</section>}</div></div>;
}

function OrganizationsPortfolio({ organizations }: { organizations: ClientOrganization[] }) {
  const [searchTerm, setSearchTerm] = useState('');
  const filteredOrganizations = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase('fr');
    if (!query) return organizations;
    return organizations.filter((organization) => `${organization.name} ${organization.restaurants.map((restaurant) => `${restaurant.name} ${restaurant.city ?? ''}`).join(' ')}`.toLocaleLowerCase('fr').includes(query));
  }, [organizations, searchTerm]);

  return <section className="mt-8 rounded-3xl bg-white p-5 shadow-sm sm:p-7">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Comptes multi-sites</p><h2 className="mt-2 text-2xl font-black">Organisations clientes</h2><p className="mt-2 text-sm text-[#738078]">Restaurants, membres et invitations regroupés par compte client.</p></div><label className="sr-only" htmlFor="organization-search">Rechercher une organisation</label><input id="organization-search" type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Rechercher un compte…" className="w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-xs outline-none focus:border-[#ff5a36] sm:w-64" /></div>
    {filteredOrganizations.length ? <div className="mt-5 space-y-3">{filteredOrganizations.map((organization) => <details key={organization.id} className="rounded-2xl border border-[#e6ebe4] p-4"><summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3"><span><strong className="text-sm">{organization.name}</strong><span className="ml-3 text-xs text-[#89948b]">{organization.restaurants.length} restaurant(s) · {organization.organization_members.length} membre(s)</span></span><span className={`rounded-full px-3 py-1 text-[10px] font-black ${organization.active ? 'bg-[#e5f6e9] text-[#27894a]' : 'bg-[#f0f2ef] text-[#7c887f]'}`}>{organization.active ? 'Actif' : 'Inactif'}</span></summary><div className="mt-4 grid gap-5 border-t border-[#edf0eb] pt-4 md:grid-cols-2"><div><p className="text-[10px] font-black uppercase tracking-wider text-[#89948b]">Restaurants</p>{organization.restaurants.length ? <ul className="mt-2 space-y-2">{organization.restaurants.map((restaurant) => <li key={restaurant.id} className="flex items-center justify-between gap-3 text-xs"><span className="font-bold">{restaurant.name}<span className="ml-2 font-normal text-[#89948b]">{restaurant.city || restaurant.address || ''}</span></span><span className={restaurant.active ? 'text-[#27894a]' : 'text-[#89948b]'}>{restaurant.active ? 'Actif' : 'Inactif'}</span></li>)}</ul> : <p className="mt-2 text-xs text-[#89948b]">Aucun restaurant associé.</p>}</div><div><p className="text-[10px] font-black uppercase tracking-wider text-[#89948b]">Accès et invitations</p><p className="mt-2 text-xs text-[#46564d]">{organization.organization_members.filter((member) => member.active).length} membre(s) actif(s), {organization.restaurant_invitations.filter((invitation) => invitation.status === 'pending').length} invitation(s) en attente.</p>{organization.organization_members.length > 0 && <p className="mt-2 text-xs text-[#89948b]">Profils : {organization.organization_members.map((member) => member.role).join(', ')}</p>}</div></div></details>)}</div> : <p className="mt-6 rounded-2xl bg-[#f7f9f6] p-8 text-center text-sm text-[#89948b]">Aucune organisation ne correspond à cette recherche.</p>}
  </section>;
}

function DemoRequestsPanel({ requests, loading, error, onUpdate, onConvert }: { requests: DemoRequest[]; loading: boolean; error: string; onUpdate: (id: string, update: { status?: DemoRequest['status']; notes?: string; assignedTo?: string | null }) => Promise<void>; onConvert: (request: DemoRequest) => void }) {
  const [statusFilter, setStatusFilter] = useState<DemoRequest['status'] | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [notesDrafts, setNotesDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState('');
  const [actionError, setActionError] = useState('');
  const statusLabels: Record<DemoRequest['status'], string> = { new: 'Nouveau', contacted: 'Contacté', demo: 'Démo', converted: 'Converti', rejected: 'Refusé' };
  const filteredRequests = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase('fr');
    return requests.filter((request) => {
      const matchesStatus = statusFilter === 'all' || request.status === statusFilter;
      const matchesSearch = !query || `${request.restaurant_name} ${request.full_name} ${request.email} ${request.phone} ${request.message}`.toLocaleLowerCase('fr').includes(query);
      return matchesStatus && matchesSearch;
    });
  }, [requests, searchTerm, statusFilter]);
  const saveUpdate = async (id: string, update: { status?: DemoRequest['status']; notes?: string; assignedTo?: string | null }) => {
    setSavingId(id);
    setActionError('');
    try {
      await onUpdate(id, update);
    } catch (updateError) {
      setActionError(updateError instanceof Error ? updateError.message : 'Impossible de mettre à jour cette demande.');
    } finally {
      setSavingId('');
    }
  };

  return <section>
    <p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Prospects</p>
    <div className="mt-2 flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-4xl font-black tracking-[-.05em]">Demandes d’intégration</h2><p className="mt-3 text-sm text-[#738078]">Suivez chaque demande, ajoutez vos notes et convertissez-la en compte client.</p></div><span className="rounded-full bg-white px-4 py-2 text-xs font-black text-[#657269]">{loading ? 'Chargement…' : `${filteredRequests.length} / ${requests.length} demande(s)`}</span></div>
    <div className="mt-5 flex flex-wrap gap-3"><label className="sr-only" htmlFor="request-search">Rechercher une demande</label><input id="request-search" type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Rechercher un prospect…" className="min-w-56 flex-1 rounded-xl border border-[#dfe5de] bg-white px-4 py-3 text-xs outline-none focus:border-[#ff5a36]" /><label className="sr-only" htmlFor="request-status-filter">Filtrer par statut</label><select id="request-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="rounded-xl border border-[#dfe5de] bg-white px-4 py-3 text-xs font-bold"><option value="all">Tous les statuts</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {error && <div role="alert" className="mt-6 rounded-2xl bg-[#fff0e9] p-4 text-sm font-semibold text-[#a53d27]"><p>{error}</p>{error === 'Session administrateur expirée.' && <Link href="/login?mode=admin" className="mt-3 inline-flex rounded-xl bg-[#0b1f14] px-4 py-2.5 text-xs font-black text-white">Se connecter à l’administration</Link>}</div>}
    {actionError && <p role="alert" className="mt-4 rounded-xl bg-[#fff0e9] p-3 text-xs font-bold text-[#a53d27]">{actionError}</p>}
    {loading && !requests.length ? <div className="mt-6 rounded-3xl bg-white p-12 text-center text-sm text-[#7b887f]">Chargement des demandes…</div> : filteredRequests.length ? <div className="mt-6 space-y-4">{filteredRequests.map((request) => <article key={request.id} className="rounded-3xl bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#edf0eb] pb-4"><div><h3 className="text-lg font-black">{request.restaurant_name}</h3><p className="mt-1 text-xs text-[#89948b]">Reçue le {new Date(request.received_at).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}</p></div><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[#fff2eb] px-3 py-1.5 text-[10px] font-black text-[#d95337]">{request.restaurant_count} restaurant{request.restaurant_count === 1 ? '' : 's'}</span><label className="sr-only" htmlFor={`request-status-${request.id}`}>Statut de la demande</label><select id={`request-status-${request.id}`} value={request.status} disabled={savingId === request.id} onChange={(event) => void saveUpdate(request.id, { status: event.target.value as DemoRequest['status'] })} className="rounded-lg border border-[#dfe5de] bg-white px-3 py-2 text-xs font-bold">{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
      <dl className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3"><div><dt className="text-[10px] font-black uppercase tracking-wider text-[#89948b]">Contact</dt><dd className="mt-1 text-sm font-bold">{request.full_name}</dd></div><div><dt className="text-[10px] font-black uppercase tracking-wider text-[#89948b]">Fonction</dt><dd className="mt-1 text-sm font-bold">{request.role}</dd></div><div><dt className="text-[10px] font-black uppercase tracking-wider text-[#89948b]">E-mail</dt><dd className="mt-1 break-all text-sm font-bold"><a href={`mailto:${request.email}`} className="text-[#d95337] hover:underline">{request.email}</a></dd></div><div><dt className="text-[10px] font-black uppercase tracking-wider text-[#89948b]">Téléphone</dt><dd className="mt-1 text-sm font-bold"><a href={`tel:${request.phone}`} className="text-[#d95337] hover:underline">{request.phone}</a></dd></div></dl>
      <div className="mt-5 rounded-2xl bg-[#f7f9f6] p-4"><p className="text-[10px] font-black uppercase tracking-wider text-[#89948b]">Besoin exprimé</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#46564d]">{request.message}</p></div>
      <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto]"><label className="text-[10px] font-black uppercase tracking-wider text-[#89948b]">Notes de suivi<textarea rows={2} maxLength={5000} value={notesDrafts[request.id] ?? request.notes ?? ''} onChange={(event) => setNotesDrafts((current) => ({ ...current, [request.id]: event.target.value }))} placeholder="Ajouter une note interne…" className="mt-2 w-full rounded-xl border border-[#dfe5de] px-3 py-2 text-sm font-normal normal-case outline-none focus:border-[#ff5a36]" /></label><div className="flex flex-wrap items-end gap-2"><button disabled={savingId === request.id} onClick={() => void saveUpdate(request.id, { notes: notesDrafts[request.id] ?? request.notes ?? '' })} className="rounded-xl border border-[#dfe5de] px-4 py-3 text-xs font-black disabled:opacity-50">{savingId === request.id ? 'Enregistrement…' : 'Enregistrer la note'}</button><button disabled={savingId === request.id} onClick={() => void saveUpdate(request.id, { assignedTo: 'me' })} className="rounded-xl border border-[#dfe5de] px-4 py-3 text-xs font-black disabled:opacity-50">M’assigner le suivi</button><span className="px-2 py-3 text-[10px] text-[#89948b]">{request.assigned_to ? 'Suivi attribué' : 'Sans responsable'}</span>{request.status !== 'converted' && <button onClick={() => onConvert(request)} className="rounded-xl bg-[#ff5a36] px-4 py-3 text-xs font-black text-white">Créer le compte</button>}</div></div>
    </article>)}</div> : !error ? <div className="mt-6 rounded-3xl border border-dashed border-[#cad6cc] bg-white p-12 text-center text-sm text-[#7b887f]">{requests.length ? 'Aucune demande ne correspond aux filtres.' : 'Aucune demande d’intégration pour le moment.'}</div> : null}
  </section>;
}

function DataPanel({ title, description, empty }: { title: string; description: string; empty: string }) {
  return <section><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Administration</p><h2 className="mt-2 text-4xl font-black tracking-[-.05em]">{title}</h2><p className="mt-3 text-sm text-[#738078]">{description}</p><div className="mt-8 rounded-3xl border border-dashed border-[#cad6cc] bg-white p-12 text-center text-sm text-[#7b887f]">{empty}</div></section>;
}

function AdminsPanel({ admins, onInvite }: { admins: PlatformAdmin[]; onInvite: () => void }) {
  return <section><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Gouvernance</p><h2 className="mt-2 text-4xl font-black tracking-[-.05em]">Administrateurs internes</h2><p className="mt-3 text-sm text-[#738078]">Contrôlez les accès des équipes qui administrent la plateforme.</p></div><button onClick={onInvite} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">＋ Ajouter un administrateur</button></div><div className="mt-8 overflow-hidden rounded-3xl bg-white shadow-sm"><div className="grid grid-cols-[1fr_180px_110px] border-b border-[#edf0eb] px-6 py-4 text-[10px] font-black uppercase tracking-widest text-[#89948b]"><span>Administrateur</span><span>Rôle</span><span>Statut</span></div>{admins.length ? admins.map((admin) => <div key={admin.id} className="grid grid-cols-[1fr_180px_110px] items-center border-b border-[#edf0eb] px-6 py-5 text-sm"><div><p className="font-black">{admin.full_name}</p><p className="mt-1 text-xs text-[#89948b]">Ajouté le {new Date(admin.created_at).toLocaleDateString('fr-FR')}</p></div><span className="text-xs font-bold text-[#657269]">{admin.role}</span><span className={`w-fit rounded-full px-3 py-1 text-[10px] font-black ${admin.active ? 'bg-[#e5f6e9] text-[#27894a]' : 'bg-[#f0f2ef] text-[#7c887f]'}`}>{admin.active ? 'Actif' : 'Suspendu'}</span></div>) : <div className="p-12 text-center text-sm text-[#7b887f]">Aucun administrateur supplémentaire. Ajoutez un membre de votre équipe pour partager la gestion.</div>}</div></section>;
}

function AdminInvite({ draft, setDraft, onClose, onSubmit }: { draft: { fullName: string; email: string; role: string }; setDraft: React.Dispatch<React.SetStateAction<{ fullName: string; email: string; role: string }>>; onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  return <div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/70 p-4"><div className="w-full max-w-lg rounded-3xl bg-white p-7 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Nouvel accès</p><h2 className="mt-2 text-2xl font-black">Ajouter un administrateur</h2><p className="mt-2 text-sm text-[#738078]">Un e-mail sécurisé sera envoyé pour créer son accès.</p></div><button onClick={onClose} className="text-2xl">×</button></div><form onSubmit={onSubmit} className="mt-7 space-y-4"><label className="block text-xs font-black text-[#68736a]">Nom complet<input required value={draft.fullName} onChange={(event) => setDraft((current) => ({ ...current, fullName: event.target.value }))} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" /></label><label className="block text-xs font-black text-[#68736a]">E-mail professionnel<input required type="email" value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" /></label><label className="block text-xs font-black text-[#68736a]">Rôle<select value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))} className="mt-2 w-full rounded-xl border border-[#dfe5de] bg-white px-4 py-3 text-sm"><option>Administrateur</option><option>Super administrateur</option><option>Analyste</option><option>Support</option></select></label><div className="flex justify-end gap-3 pt-3"><button type="button" onClick={onClose} className="rounded-xl border border-[#dfe5de] px-4 py-3 text-xs font-black">Annuler</button><button className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Envoyer l’invitation</button></div></form></div></div>;
}

function QualityPanel() {
  return <section><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Analyse IA</p><h2 className="mt-2 text-4xl font-black tracking-[-.05em]">Qualité de compréhension</h2><p className="mt-3 text-sm text-[#738078]">Les indicateurs seront calculés à partir des conversations auditées dans Supabase.</p><div className="mt-8 grid gap-4 md:grid-cols-3">{[['Taux de compréhension', '—'], ['Demandes reformulées', '—'], ['Erreurs de catalogue', '—']].map(([label, value]) => <div key={label} className="rounded-3xl bg-white p-6 shadow-sm"><p className="text-xs font-bold text-[#89948b]">{label}</p><p className="mt-4 text-4xl font-black">{value}</p><p className="mt-2 text-xs text-[#7d897f]">En attente de données d’audit</p></div>)}</div></section>;
}

function CreateRestaurant({ draft, setDraft, organizations, onClose, onSubmit }: { draft: CreateRestaurantDraft; setDraft: React.Dispatch<React.SetStateAction<CreateRestaurantDraft>>; organizations: ClientOrganization[]; onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const fields: Array<[keyof typeof draft, string, string]> = [['name', 'Nom du restaurant', 'Nom de l’établissement'], ['address', 'Adresse', '12 rue de la République'], ['city', 'Ville', 'Paris'], ['siret', 'SIRET', '12345678900000'], ['brand', 'Enseigne / groupe', 'Nom de l’enseigne'], ['phone', 'Téléphone', '+33 1 00 00 00 00'], ['managerName', 'Responsable', 'Alex Martin'], ['managerEmail', 'E-mail professionnel', 'directeur@restaurant.fr']];
  return <div className="fixed inset-0 z-50 overflow-y-auto bg-[#07130d]/70 p-4"><div className="mx-auto my-8 max-w-2xl rounded-3xl bg-white p-7 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Nouveau client</p><h2 className="mt-2 text-2xl font-black">Créer un restaurant</h2><p className="mt-2 text-sm text-[#738078]">Rattachez-le à une organisation ou créez un nouveau compte client.</p></div><button onClick={onClose} className="text-2xl">×</button></div><form onSubmit={onSubmit} className="mt-7 grid gap-4 sm:grid-cols-2"><label className="text-xs font-black text-[#68736a] sm:col-span-2">Organisation cliente<select value={draft.organizationId} onChange={(event) => setDraft((current) => ({ ...current, organizationId: event.target.value }))} className="mt-2 w-full rounded-xl border border-[#dfe5de] bg-white px-4 py-3 text-sm"><option value="">Créer une nouvelle organisation</option>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name} · {organization.restaurants.length} restaurant(s)</option>)}</select></label>{!draft.organizationId && <label className="text-xs font-black text-[#68736a] sm:col-span-2">Nom de l’organisation<input required minLength={1} maxLength={160} value={draft.organizationName} onChange={(event) => setDraft((current) => ({ ...current, organizationName: event.target.value }))} placeholder="Société ou groupe client" className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" /></label>}{fields.map(([key, label, placeholder]) => <label key={key} className="text-xs font-black text-[#68736a]">{label}<input required={key === 'name' || key === 'managerEmail' || key === 'managerName'} type={key === 'managerEmail' ? 'email' : 'text'} value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} placeholder={placeholder} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" /></label>)}<label className="text-xs font-black text-[#68736a]">Profil responsable<select value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))} className="mt-2 w-full rounded-xl border border-[#dfe5de] bg-white px-4 py-3 text-sm"><option>Directeur</option><option>Manager</option></select></label><div className="flex justify-end gap-3 sm:col-span-2"><button type="button" onClick={onClose} className="rounded-xl border border-[#dfe5de] px-4 py-3 text-xs font-black">Annuler</button><button className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Créer et préparer l’invitation</button></div></form></div></div>;
}