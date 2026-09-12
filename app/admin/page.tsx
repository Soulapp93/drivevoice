'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase/client';

type AdminTab = 'overview' | 'restaurants' | 'hubrise' | 'quality' | 'admins';
type Restaurant = { id: string; name: string; address: string | null; city: string | null; brand_id: string | null; active: boolean; created_at: string };
type PlatformAdmin = { id: string; full_name: string; role: string; active: boolean; created_at: string };

const tabs: Array<[AdminTab, string, string]> = [['overview', 'Vue d’ensemble', '▥'], ['restaurants', 'Restaurants clients', '▦'], ['hubrise', 'Connexions HubRise', '⌁'], ['quality', 'Qualité IA', '◌'], ['admins', 'Administrateurs internes', '◎']];

export default function AdminPage() {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [selected, setSelected] = useState<Restaurant | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState({ name: '', address: '', city: '', siret: '', brand: '', phone: '', managerName: '', managerEmail: '', role: 'Directeur' });
  const [admins, setAdmins] = useState<PlatformAdmin[]>([]);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminDraft, setAdminDraft] = useState({ fullName: '', email: '', role: 'Administrateur' });

  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
    window.location.assign('/login');
  };

  const loadRestaurants = async () => {
    if (!supabase) { setLoading(false); return; }
    const { data, error } = await supabase.from('restaurants').select('id,name,address,city,brand_id,active,created_at').order('created_at', { ascending: false });
    if (error) setNotice(error.message);
    setRestaurants((data ?? []) as Restaurant[]);
    setLoading(false);
  };
  useEffect(() => { void loadRestaurants(); }, []);
  useEffect(() => {
    if (tab !== 'admins' || !supabase) return;
    void supabase.from('platform_admins').select('id,full_name,role,active,created_at').order('created_at', { ascending: false }).then(({ data, error }) => {
      if (error) setNotice(error.message);
      setAdmins((data ?? []) as PlatformAdmin[]);
    });
  }, [tab]);
  const activeCount = useMemo(() => restaurants.filter((restaurant) => restaurant.active).length, [restaurants]);

  const createRestaurant = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) return;
    const { data, error } = await supabase.from('restaurants').insert({ name: draft.name, address: draft.address, city: draft.city, siret: draft.siret, brand_name: draft.brand, phone: draft.phone, manager_name: draft.managerName, manager_email: draft.managerEmail, manager_role: draft.role }).select('id,name,address,city,brand_id,active,created_at').single();
    if (error) { setNotice(error.message); return; }
    const invitation = await supabase.from('restaurant_invitations').insert({ restaurant_id: data.id, email: draft.managerEmail, full_name: draft.managerName, role: draft.role }).select().single();
    if (invitation.error) { setNotice(`Restaurant créé, mais invitation non enregistrée : ${invitation.error.message}`); }
    else {
      const inviteLink = await supabase.auth.signInWithOtp({ email: draft.managerEmail, options: { emailRedirectTo: window.location.origin } });
      setNotice(inviteLink.error ? `Restaurant créé. Invitation enregistrée, mais l’e-mail n’a pas pu être envoyé : ${inviteLink.error.message}` : 'Restaurant créé et lien de connexion envoyé au responsable.');
    }
    setRestaurants((current) => [data as Restaurant, ...current]);
    setCreateOpen(false);
    setDraft({ name: '', address: '', city: '', siret: '', brand: '', phone: '', managerName: '', managerEmail: '', role: 'Directeur' });
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
      <aside className="relative overflow-hidden border-b border-white/10 bg-[#071a11]/95 p-5 text-white shadow-[10px_0_45px_rgba(7,26,17,.08)] backdrop-blur-2xl lg:sticky lg:top-0 lg:min-h-screen lg:border-b-0 lg:border-r lg:border-white/10 lg:p-7"><div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-[#ffc647]/10 blur-3xl" /><div className="relative flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#ff5a36] text-lg font-black shadow-[0_8px_25px_rgba(255,90,54,.25)]">D</span><div><p className="font-black tracking-[-.04em]">DRIVE<span className="text-[#ff7556]">VOICE</span></p><p className="text-[9px] uppercase tracking-[.18em] text-white/40">Platform admin</p></div></div><div className="relative mt-10 rounded-2xl border border-white/10 bg-white/[.06] p-4 shadow-inner backdrop-blur-xl"><p className="text-[9px] font-black uppercase tracking-[.17em] text-white/40">Espace actif</p><p className="mt-2 text-sm font-black">Administration plateforme</p><p className="mt-1 text-[10px] text-white/45">Données Supabase en direct</p></div><div className="relative mt-8"><p className="px-3 text-[9px] font-black uppercase tracking-[.2em] text-white/35">Administration</p><nav className="mt-4 space-y-1">{tabs.map(([id, label, icon]) => <button key={id} onClick={() => setTab(id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-xs font-black transition ${tab === id ? 'bg-white text-[#102019] shadow-[0_8px_25px_rgba(0,0,0,.12)]' : 'text-white/55 hover:bg-white/[.08] hover:text-white'}`}><span className={`grid h-8 w-8 place-items-center rounded-lg text-base ${tab === id ? 'bg-[#ff5a36] text-white' : 'bg-white/[.06]'}`}>{icon}</span>{label}</button>)}</nav></div><div className="relative mt-10 rounded-2xl border border-white/10 bg-white/[.04] p-4"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-[#ffc647] text-xs font-black text-[#172019]">AM</span><div><p className="text-xs font-black">Administrateur DriveVoice</p><p className="text-[9px] text-white/40">Accès plateforme</p></div></div><button onClick={signOut} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-[10px] font-black text-white/60 transition hover:border-[#ff7556] hover:bg-[#ff5a36] hover:text-white">↪ Se déconnecter</button></div></aside>
      <section className="min-w-0"><header className="sticky top-0 z-20 flex items-center justify-between border-b border-[#dfe5de]/80 bg-[#f4f6f1]/80 px-5 py-5 backdrop-blur-xl md:px-9"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#89938b]">DriveVoice / Back-office</p><h1 className="mt-1 text-lg font-black">{tabs.find(([id]) => id === tab)?.[1]}</h1></div><div className="flex items-center gap-3"><span className="hidden rounded-full border border-[#dce7dc] bg-white/80 px-3 py-2 text-[10px] font-black text-[#27894a] shadow-sm md:block">● Supabase connecté</span><a href="/" className="rounded-xl border border-[#dfe5de] bg-white/80 px-4 py-2 text-xs font-black shadow-sm transition hover:border-[#ff7556]">Espace restaurant</a></div></header><div className="mx-auto max-w-[1500px] p-5 md:p-9">
        {tab === 'overview' && <Overview restaurants={restaurants} activeCount={activeCount} />}
        {tab === 'restaurants' && <RestaurantList restaurants={restaurants} loading={loading} selected={selected} setSelected={setSelected} onCreate={() => setCreateOpen(true)} />}
        {tab === 'hubrise' && <HubrisePanel />}
        {tab === 'quality' && <QualityPanel />}
        {tab === 'admins' && <AdminsPanel admins={admins} onInvite={() => setAdminOpen(true)} />}
      </div></section>
      {createOpen && <CreateRestaurant draft={draft} setDraft={setDraft} onClose={() => setCreateOpen(false)} onSubmit={createRestaurant} />}
      {adminOpen && <AdminInvite draft={adminDraft} setDraft={setAdminDraft} onClose={() => setAdminOpen(false)} onSubmit={inviteAdmin} />}
      {notice && <div className="fixed bottom-5 right-5 rounded-2xl bg-[#0b1f14] px-5 py-4 text-xs font-bold text-white shadow-xl">{notice}</div>}
    </main>
  );
}

function Overview({ restaurants, activeCount }: { restaurants: Restaurant[]; activeCount: number }) {
  const cards = [['Restaurants clients', String(restaurants.length), `${activeCount} actifs`], ['Enseignes / groupes', '—', 'Selon les données Supabase'], ['Commandes aujourd’hui', '—', 'Aucune donnée fictive'], ['Compréhension IA', '—', 'Audits disponibles après conversations']];
  return <div><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Pilotage plateforme</p><h2 className="mt-2 text-4xl font-black tracking-[-.05em]">Vue d’ensemble</h2><p className="mt-3 text-sm text-[#738078]">Une lecture réelle de l’activité DriveVoice, alimentée par Supabase.</p></div><span className="rounded-full bg-[#e5f6e9] px-4 py-2 text-xs font-black text-[#27894a]">● Données live</span></div><div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value, detail]) => <div key={label} className="rounded-3xl bg-white p-6 shadow-sm"><p className="text-xs font-bold text-[#89948b]">{label}</p><p className="mt-4 text-4xl font-black">{value}</p><p className="mt-2 text-xs text-[#7d897f]">{detail}</p></div>)}</div><div className="mt-5 rounded-3xl bg-[#0b1f14] p-7 text-white"><p className="text-xs font-black uppercase tracking-widest text-[#ffc647]">Principe de production</p><h3 className="mt-3 text-2xl font-black">Aucune métrique inventée</h3><p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">Les compteurs sans données restent à — jusqu’à ce que les commandes, connexions et audits soient enregistrés dans Supabase.</p></div></div>;
}

function RestaurantList({ restaurants, loading, selected, setSelected, onCreate }: { restaurants: Restaurant[]; loading: boolean; selected: Restaurant | null; setSelected: (restaurant: Restaurant | null) => void; onCreate: () => void }) {
  return <div><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Portefeuille client</p><h2 className="mt-2 text-4xl font-black tracking-[-.05em]">Restaurants clients</h2><p className="mt-3 text-sm text-[#738078]">Liste complète des établissements enregistrés dans Supabase.</p></div><button onClick={onCreate} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">＋ Créer un restaurant</button></div><div className="mt-7 grid gap-5 xl:grid-cols-[1fr_360px]"><section className="overflow-hidden rounded-3xl bg-white shadow-sm"><div className="border-b border-[#edf0eb] px-5 py-4 text-xs font-black uppercase tracking-widest text-[#89948b]">{loading ? 'Chargement…' : `${restaurants.length} établissement${restaurants.length > 1 ? 's' : ''}`}</div>{restaurants.length ? <div className="divide-y divide-[#edf0eb]">{restaurants.map((restaurant) => <button key={restaurant.id} onClick={() => setSelected(restaurant)} className="flex w-full items-center justify-between px-5 py-5 text-left hover:bg-[#f8faf7]"><div><p className="text-sm font-black">{restaurant.name}</p><p className="mt-1 text-xs text-[#7c887f]">{restaurant.address || 'Adresse non renseignée'}{restaurant.city ? ` · ${restaurant.city}` : ''}</p></div><span className={`rounded-full px-3 py-1 text-[10px] font-black ${restaurant.active ? 'bg-[#e5f6e9] text-[#27894a]' : 'bg-[#f0f2ef] text-[#7c887f]'}`}>{restaurant.active ? 'Actif' : 'Inactif'}</span></button>)}</div> : <div className="p-10 text-center text-sm text-[#849087]">Aucun restaurant enregistré. Créez le premier établissement pour démarrer.</div>}</section>{selected ? <section className="rounded-3xl bg-[#0b1f14] p-6 text-white"><p className="text-xs font-black uppercase tracking-widest text-[#ffc647]">Détail restaurant</p><h3 className="mt-3 text-2xl font-black">{selected.name}</h3><p className="mt-3 text-sm text-white/60">{selected.address || 'Adresse non renseignée'}</p><div className="mt-7 space-y-3">{[['Produits', '—'], ['Commandes jour', '—'], ['Commandes semaine', '—'], ['Commandes mois', '—'], ['Compréhension IA', '—']].map(([label, value]) => <div key={label} className="flex justify-between border-b border-white/10 pb-3 text-xs"><span className="text-white/55">{label}</span><strong>{value}</strong></div>)}</div><p className="mt-6 text-[10px] leading-relaxed text-white/40">Les indicateurs apparaîtront dès que les données réelles de commandes et d’audits seront enregistrées.</p></section> : <section className="rounded-3xl border border-dashed border-[#cad6cc] p-6 text-sm text-[#7b887f]">Sélectionnez un restaurant pour consulter ses détails.</section>}</div></div>;
}

function DataPanel({ title, description, empty }: { title: string; description: string; empty: string }) {
  return <section><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Administration</p><h2 className="mt-2 text-4xl font-black tracking-[-.05em]">{title}</h2><p className="mt-3 text-sm text-[#738078]">{description}</p><div className="mt-8 rounded-3xl border border-dashed border-[#cad6cc] bg-white p-12 text-center text-sm text-[#7b887f]">{empty}</div></section>;
}

function HubrisePanel() {
  return <section><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Connectivité</p><h2 className="mt-2 text-4xl font-black tracking-[-.05em]">Connexions HubRise</h2><p className="mt-3 text-sm text-[#738078]">Surveillez l’état des connexions caisse, la synchronisation catalogue et les erreurs par établissement.</p><div className="mt-8 grid gap-4 md:grid-cols-3">{[['Connexions actives', '—'], ['Dernière synchronisation', '—'], ['Erreurs de flux', '—']].map(([label, value]) => <div key={label} className="rounded-3xl bg-white p-6 shadow-sm"><p className="text-xs font-bold text-[#89948b]">{label}</p><p className="mt-4 text-4xl font-black">{value}</p><p className="mt-2 text-xs text-[#7d897f]">Données disponibles après connexions</p></div>)}</div><div className="mt-5 rounded-3xl border border-dashed border-[#cad6cc] bg-white p-12 text-center text-sm text-[#7b887f]">Les connexions réelles apparaîtront ici dès qu’un restaurant aura autorisé HubRise.</div></section>;
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

function CreateRestaurant({ draft, setDraft, onClose, onSubmit }: { draft: { name: string; address: string; city: string; siret: string; brand: string; phone: string; managerName: string; managerEmail: string; role: string }; setDraft: React.Dispatch<React.SetStateAction<{ name: string; address: string; city: string; siret: string; brand: string; phone: string; managerName: string; managerEmail: string; role: string }>>; onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const fields: Array<[keyof typeof draft, string, string]> = [['name', 'Nom du restaurant', 'BK Paris République'], ['address', 'Adresse', '12 rue de la République'], ['city', 'Ville', 'Paris'], ['siret', 'SIRET', '12345678900000'], ['brand', 'Enseigne / groupe', 'Burger King France'], ['phone', 'Téléphone', '+33 1 00 00 00 00'], ['managerName', 'Responsable', 'Alex Martin'], ['managerEmail', 'E-mail professionnel', 'directeur@restaurant.fr']];
  return <div className="fixed inset-0 z-50 overflow-y-auto bg-[#07130d]/70 p-4"><div className="mx-auto my-8 max-w-2xl rounded-3xl bg-white p-7 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Nouveau client</p><h2 className="mt-2 text-2xl font-black">Créer un restaurant</h2><p className="mt-2 text-sm text-[#738078]">Le responsable recevra ensuite son lien d’accès sécurisé.</p></div><button onClick={onClose} className="text-2xl">×</button></div><form onSubmit={onSubmit} className="mt-7 grid gap-4 sm:grid-cols-2">{fields.map(([key, label, placeholder]) => <label key={key} className="text-xs font-black text-[#68736a]">{label}<input required={key === 'name' || key === 'managerEmail'} value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} placeholder={placeholder} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" /></label>)}<label className="text-xs font-black text-[#68736a]">Profil responsable<select value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))} className="mt-2 w-full rounded-xl border border-[#dfe5de] bg-white px-4 py-3 text-sm"><option>Directeur</option><option>Franchisé</option></select></label><div className="flex justify-end gap-3 sm:col-span-2"><button type="button" onClick={onClose} className="rounded-xl border border-[#dfe5de] px-4 py-3 text-xs font-black">Annuler</button><button className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Créer et préparer l’invitation</button></div></form></div></div>;
}