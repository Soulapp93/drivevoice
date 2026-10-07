'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase/client';

type DashboardOrder = {
  id: string;
  ref: string | null;
  source: string | null;
  status: string | null;
  total: number | null;
  items: string[];
  createdAt: string;
  dateKey: string;
  dateLabel: string;
  timeLabel: string;
};

type DashboardProps = { restaurantId: string };

const panelCard = 'rounded-[24px] border border-[#e2e6df] bg-white shadow-[0_16px_50px_rgba(17,32,22,.05)]';
const currency = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const dashboardPeriods = ['Aujourd’hui', 'Hier', 'Cette semaine', 'Ce mois', 'Cette année'];

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfWeek(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function orderStatus(status: string | null) {
  const normalized = status?.toLowerCase();
  if (normalized === 'sent') return 'Envoyée à HubRise';
  if (normalized === 'pending') return 'En attente';
  if (normalized === 'failed') return 'Échec';
  return status || 'Inconnu';
}

function toDashboardOrder(row: Record<string, unknown>): DashboardOrder {
  const createdAt = String(row.created_at ?? '');
  const created = new Date(createdAt);
  const rawItems = Array.isArray(row.items) ? row.items : [];
  const items = rawItems.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    const name = String(item.product_name ?? item.name ?? '').trim();
    if (!name) return [];
    const quantity = Number(item.quantity ?? 1);
    return [`${name}${quantity > 1 ? ` × ${quantity}` : ''}`];
  });
  const rawTotal = row.total;

  return {
    id: String(row.id),
    ref: typeof row.ref === 'string' ? row.ref : null,
    source: typeof row.source === 'string' ? row.source : null,
    status: typeof row.status === 'string' ? row.status : null,
    total: rawTotal === null || rawTotal === undefined || !Number.isFinite(Number(rawTotal)) ? null : Number(rawTotal),
    items,
    createdAt,
    dateKey: Number.isNaN(created.getTime()) ? '' : localDateKey(created),
    dateLabel: Number.isNaN(created.getTime()) ? 'Date indisponible' : created.toLocaleDateString('fr-FR'),
    timeLabel: Number.isNaN(created.getTime()) ? '—' : created.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  };
}

function OrderHistory({ orders, selectedId, onSelect, onClose }: {
  orders: DashboardOrder[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const [period, setPeriod] = useState('jour');
  const [date, setDate] = useState(() => localDateKey(new Date()));
  const selected = orders.find((order) => order.id === selectedId) ?? null;
  const filtered = orders.filter((order) => {
    if (period === 'jour') return order.dateKey === date;
    if (period === 'mois') return order.dateKey.startsWith(date.slice(0, 7));
    if (period === 'année') return order.dateKey.startsWith(date.slice(0, 4));
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#07130d]/70 p-4 md:p-8">
      <div className="mx-auto max-w-6xl rounded-[28px] bg-[#f4f6f1] shadow-2xl">
        <div className="flex items-start justify-between border-b border-[#e1e6df] bg-white p-6 md:p-8">
          <div>
            <p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Pilotage des ventes</p>
            <h2 className="mt-2 text-3xl font-black">Toutes les commandes</h2>
            <p className="mt-2 text-sm text-[#738078]">Historique issu des commandes enregistrées pour ce restaurant.</p>
          </div>
          <button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl bg-[#f0f3ee] text-xl font-black" aria-label="Fermer">×</button>
        </div>
        <div className="grid gap-5 p-5 md:grid-cols-[250px_1fr] md:p-8">
          <aside className="rounded-2xl bg-white p-5">
            <p className="text-xs font-black uppercase tracking-widest text-[#89948b]">Période</p>
            <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-1">
              {['jour', 'mois', 'année', 'toutes'].map((item) => (
                <button key={item} onClick={() => setPeriod(item)} className={`rounded-xl px-4 py-3 text-left text-xs font-black capitalize ${period === item ? 'bg-[#0b1f14] text-white' : 'bg-[#f3f5f1] text-[#68736a]'}`}>
                  {item === 'toutes' ? 'Toutes les dates' : `Par ${item}`}
                </button>
              ))}
            </div>
            {period !== 'toutes' && (
              <label className="mt-5 block text-xs font-black text-[#68736a]">
                Sélectionner une date
                <input
                  type={period === 'jour' ? 'date' : period === 'mois' ? 'month' : 'number'}
                  min={period === 'année' ? '2020' : undefined}
                  max={period === 'année' ? '2100' : undefined}
                  value={period === 'année' ? date.slice(0, 4) : period === 'mois' ? date.slice(0, 7) : date}
                  onChange={(event) => setDate(period === 'année' ? `${event.target.value}-01-01` : period === 'mois' ? `${event.target.value}-01` : event.target.value)}
                  className="mt-2 w-full rounded-xl border border-[#dfe5de] px-3 py-3 text-sm"
                />
              </label>
            )}
            <div className="mt-6 rounded-2xl bg-[#e8f6eb] p-4">
              <p className="text-2xl font-black text-[#248b4a]">{filtered.length}</p>
              <p className="mt-1 text-xs font-bold text-[#55745d]">commandes affichées</p>
            </div>
          </aside>
          <section className="min-w-0">
            {selected ? (
              <div>
                <button onClick={() => onSelect(null)} className="mb-4 text-xs font-black text-[#ff5a36]">← Retour à la liste</button>
                <article className="rounded-2xl bg-white p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-black uppercase tracking-widest text-[#89948b]">Commande</p>
                      <h3 className="mt-2 text-2xl font-black">{selected.ref || selected.id}</h3>
                      <p className="mt-1 text-xs text-[#7c887f]">{selected.dateLabel} · {selected.timeLabel} · {selected.source || 'Source inconnue'}</p>
                    </div>
                    <span className="rounded-full bg-[#e5f6e9] px-3 py-2 text-xs font-black text-[#27894a]">{orderStatus(selected.status)}</span>
                  </div>
                  <div className="mt-7 grid gap-6 md:grid-cols-[1fr_300px]">
                    <div>
                      <p className="text-xs font-black uppercase tracking-widest text-[#89948b]">Articles enregistrés</p>
                      {selected.items.length ? (
                        <ul className="mt-3 space-y-2 text-sm text-[#4b5a50]">
                          {selected.items.map((item, index) => <li key={`${item}-${index}`} className="rounded-xl bg-[#f7f8f5] px-4 py-3">{item}</li>)}
                        </ul>
                      ) : <p className="mt-3 text-sm text-[#7b887f]">Aucun détail d’article n’est enregistré.</p>}
                    </div>
                    <aside className="rounded-2xl bg-[#0b1f14] p-5 text-white">
                      <p className="text-xs font-black uppercase tracking-widest text-[#ffc647]">Détails réels</p>
                      <div className="mt-5 space-y-4">
                        {[
                          ['Montant total', selected.total === null ? '—' : currency.format(selected.total)],
                          ['Canal enregistré', selected.source || '—'],
                          ['Statut enregistré', selected.status || '—'],
                          ['Articles', String(selected.items.length)],
                        ].map(([label, value]) => <div key={label} className="flex justify-between gap-3 border-b border-white/10 pb-3 text-sm"><span className="text-white/55">{label}</span><strong className="text-right">{value}</strong></div>)}
                      </div>
                    </aside>
                  </div>
                </article>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl bg-white">
                <div className="border-b border-[#edf0eb] px-5 py-4 text-xs font-black uppercase tracking-widest text-[#89948b]">Historique des commandes</div>
                {filtered.length ? (
                  <div className="divide-y divide-[#edf0eb]">
                    {filtered.map((order) => (
                      <button key={order.id} onClick={() => onSelect(order.id)} className="grid w-full grid-cols-[1fr_1fr_1fr] items-center gap-3 px-5 py-5 text-left transition hover:bg-[#fafbf8] md:grid-cols-[1.2fr_1fr_1fr_1fr_1fr]">
                        <span className="font-black">{order.ref || order.id}</span>
                        <span className="text-xs text-[#7c887f]">{order.dateLabel} · {order.timeLabel}</span>
                        <span className="text-xs font-bold">{order.source || '—'}</span>
                        <span className="font-black">{order.total === null ? '—' : currency.format(order.total)}</span>
                        <span className="text-xs font-black text-[#27894a]">{orderStatus(order.status)}</span>
                      </button>
                    ))}
                  </div>
                ) : <div className="p-12 text-center text-sm text-[#7b887f]">Aucune commande réelle pour cette période.</div>}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export function RestaurantDashboardPanel({ restaurantId }: DashboardProps) {
  const [orders, setOrders] = useState<DashboardOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [dashboardPeriod, setDashboardPeriod] = useState('Aujourd’hui');
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const loadOrders = async () => {
      setLoadError('');
      setRequiresLogin(false);
      setLoading(true);
      if (!supabase) {
        setLoadError('La connexion à Supabase n’est pas disponible.');
        setLoading(false);
        return;
      }
      const { data, error } = await supabase.auth.getSession();
      if (!active) return;
      if (error) {
        setLoadError('Impossible de vérifier votre session DriveVoice. Reconnectez-vous.');
        setRequiresLogin(true);
        setLoading(false);
        return;
      }
      if (!data.session) {
        setLoadError('Aucune session DriveVoice active. La connexion à HubRise ne remplace pas la connexion à votre compte DriveVoice.');
        setRequiresLogin(true);
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/restaurant-dashboard?restaurantId=${encodeURIComponent(restaurantId)}`, {
          headers: { authorization: `Bearer ${data.session.access_token}` },
          cache: 'no-store',
          signal: controller.signal,
        });
        const result = await response.json() as { orders?: Array<Record<string, unknown>>; error?: string };
        if (!response.ok) {
          if (response.status === 401) setRequiresLogin(true);
          throw new Error(result.error || 'Impossible de charger les commandes réelles.');
        }
        if (active) setOrders((result.orders ?? []).map(toDashboardOrder));
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === 'AbortError')) {
          setLoadError(error instanceof Error ? error.message : 'Impossible de charger les commandes réelles.');
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadOrders();
    return () => {
      active = false;
      controller.abort();
    };
  }, [restaurantId]);

  const periodBounds = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (dashboardPeriod === 'Aujourd’hui') return { start: today, end: tomorrow };
    if (dashboardPeriod === 'Hier') {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return { start: yesterday, end: today };
    }
    if (dashboardPeriod === 'Cette semaine') {
      const start = startOfWeek(today);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return { start, end };
    }
    if (dashboardPeriod === 'Ce mois') {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { start, end: new Date(today.getFullYear(), today.getMonth() + 1, 1) };
    }
    return { start: new Date(today.getFullYear(), 0, 1), end: new Date(today.getFullYear() + 1, 0, 1) };
  }, [dashboardPeriod]);

  const filteredOrders = useMemo(() => orders.filter((order) => {
    const created = new Date(order.createdAt);
    return !Number.isNaN(created.getTime()) && created >= periodBounds.start && created < periodBounds.end;
  }), [orders, periodBounds]);

  const totalIsKnown = filteredOrders.every((order) => order.total !== null);
  const revenue = filteredOrders.reduce((sum, order) => sum + (order.total ?? 0), 0);
  const average = filteredOrders.length && totalIsKnown ? revenue / filteredOrders.length : null;
  const sentOrders = filteredOrders.filter((order) => order.status?.toLowerCase() === 'sent' && order.source?.toLowerCase() === 'voice').length;
  const hourly = Array.from({ length: 24 }, (_, hour) => {
    return { hour, count: filteredOrders.filter((order) => new Date(order.createdAt).getHours() === hour).length };
  });
  const exportOrders = () => {
    const header = ['Commande', 'Date', 'Heure', 'Source', 'Montant', 'Statut'];
    const rows = filteredOrders.map((order) => [order.ref || order.id, order.dateLabel, order.timeLabel, order.source || '', order.total === null ? '' : currency.format(order.total), order.status || '']);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(';')).join('\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `drivevoice-commandes-${dashboardPeriod.toLowerCase().replaceAll(' ', '-')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[.22em] text-[#ff5a36]">Pilotage restaurant</p>
          <h1 className="mt-2 text-3xl font-black tracking-[-.045em] text-[#132018] md:text-4xl">Tableau de bord opérationnel</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#6f7971]">Indicateurs calculés uniquement à partir des commandes enregistrées pour ce restaurant.</p>
        </div>
        <div className="relative flex gap-2">
          <button onClick={() => setPeriodMenuOpen((open) => !open)} className="rounded-xl border border-[#dfe4dc] bg-white px-4 py-2 text-xs font-black">{dashboardPeriod}⌄</button>
          {periodMenuOpen && <div className="absolute right-[92px] top-11 z-20 w-44 rounded-2xl border border-[#e2e7e0] bg-white p-2 shadow-xl">{dashboardPeriods.map((period) => <button key={period} onClick={() => { setDashboardPeriod(period); setPeriodMenuOpen(false); }} className={`block w-full rounded-xl px-3 py-2.5 text-left text-xs font-black ${dashboardPeriod === period ? 'bg-[#eaf5ec] text-[#27894a]' : 'hover:bg-[#f4f6f2]'}`}>{period}</button>)}</div>}
          <button onClick={exportOrders} disabled={loading || Boolean(loadError)} className="rounded-xl bg-[#0b1f14] px-4 py-2 text-xs font-black text-white transition hover:bg-[#173b27] disabled:cursor-not-allowed disabled:opacity-50">Exporter CSV</button>
        </div>
      </div>
      {loadError && <div role="alert" className="mb-5 rounded-2xl border border-[#f2c9bf] bg-[#fff4f0] px-5 py-4 text-sm font-semibold text-[#a13e29]">{loadError}{requiresLogin && <a href="/login" className="ml-2 inline-block font-black underline underline-offset-4">Se connecter à DriveVoice</a>}</div>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Commandes', loading ? '…' : String(filteredOrders.length), 'Sur la période sélectionnée', '◉'],
          ['Chiffre d’affaires', loading ? '…' : totalIsKnown ? currency.format(revenue) : '—', totalIsKnown ? 'Montants des commandes réelles' : 'Montant indisponible pour certaines commandes', '€'],
          ['Panier moyen', loading ? '…' : average === null ? '—' : currency.format(average), 'Calculé sur les montants connus', '↗'],
          ['Commandes envoyées à HubRise', loading ? '…' : String(sentOrders), 'Source vocale, statut envoyé', '✓'],
        ].map(([label, value, detail, icon]) => (
          <button key={label} onClick={() => label === 'Commandes' && !loading && !loadError && setOrdersOpen(true)} className={`${panelCard} p-5 text-left transition ${label === 'Commandes' ? 'cursor-pointer hover:-translate-y-0.5 hover:border-[#ffb09c]' : 'cursor-default'}`}>
            <div className="flex items-center justify-between"><span className="text-xs font-bold text-[#7e887f]">{label}</span><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#f1f4ef] font-black text-[#ff5a36]">{icon}</span></div>
            <p className="mt-5 text-3xl font-black tracking-[-.05em]">{value}</p>
            <p className="mt-2 text-xs font-semibold text-[#8a948b]">{detail}</p>
            {label === 'Commandes' && <p className="mt-3 text-[10px] font-black text-[#ff5a36]">Voir le détail →</p>}
          </button>
        ))}
      </div>
      <div className="mt-5 grid gap-5">
        <section className={`${panelCard} p-6`}>
          <div className="flex items-start justify-between"><div><h2 className="text-lg font-black">Volume de commandes</h2><p className="mt-1 text-xs text-[#879088]">Répartition réelle par heure sur la période choisie</p></div><span className="rounded-full bg-[#e6f7eb] px-3 py-1 text-xs font-black text-[#248b4a]">{loading ? 'Chargement' : `${filteredOrders.length} commandes`}</span></div>
          <div className="mt-8 flex h-56 items-end gap-2 rounded-2xl bg-[#f7f8f5] px-4 pb-5 pt-8 md:gap-3 md:px-6">
            {hourly.map(({ hour, count }) => <div key={hour} title={`${String(hour).padStart(2, '0')} h : ${count} commande${count === 1 ? '' : 's'}`} className="group flex h-full flex-1 items-end"><div className={`relative w-full rounded-t-lg transition ${count ? 'bg-[#163423] hover:bg-[#ff5a36]' : 'bg-[#e8ece7]'}`} style={{ height: count ? `${Math.max(6, count / Math.max(...hourly.map((entry) => entry.count), 1) * 100)}%` : '2px' }}><span className="absolute -top-7 left-1/2 hidden -translate-x-1/2 rounded bg-[#0b1f14] px-2 py-1 text-[10px] font-bold text-white group-hover:block">{count}</span></div></div>)}
          </div>
          <div className="mt-3 flex justify-between px-1 text-[10px] font-bold text-[#9ba39c]"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
        </section>
      </div>
      <section className={`${panelCard} mt-5 overflow-hidden`}>
        <div className="flex items-center justify-between border-b border-[#e8ebe6] p-6"><div><h2 className="text-lg font-black">Dernières commandes</h2><p className="mt-1 text-xs text-[#879088]">Données enregistrées dans la base du restaurant</p></div><button onClick={() => setOrdersOpen(true)} disabled={loading || Boolean(loadError)} className="text-xs font-black text-[#ff5a36] disabled:opacity-50">Voir toutes →</button></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-[#f8f9f6] text-[10px] uppercase tracking-widest text-[#8d968e]"><tr>{['Commande', 'Date / heure', 'Source', 'Montant', 'Statut'].map((label) => <th key={label} className="px-6 py-3">{label}</th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={5} className="px-6 py-8 text-center text-sm text-[#7b887f]">Chargement des commandes réelles…</td></tr> : loadError ? <tr><td colSpan={5} className="px-6 py-8 text-center text-sm text-[#7b887f]">Les commandes sont indisponibles tant que l’accès n’est pas autorisé.</td></tr> : filteredOrders.length ? filteredOrders.slice(0, 8).map((row) => <tr key={row.id} onClick={() => { setSelectedOrder(row.id); setOrdersOpen(true); }} className="cursor-pointer border-t border-[#edf0eb] hover:bg-[#fafbf8]"><td className="px-6 py-4 font-black">{row.ref || row.id}</td><td className="px-6 py-4 text-[#6f7971]">{row.dateLabel} · {row.timeLabel}</td><td className="px-6 py-4"><span className="rounded-full bg-[#eef2ed] px-3 py-1 text-xs font-bold">{row.source || '—'}</span></td><td className="px-6 py-4 font-black">{row.total === null ? '—' : currency.format(row.total)}</td><td className="px-6 py-4"><span className="text-xs font-black text-[#2e9553]">{orderStatus(row.status)}</span></td></tr>) : <tr><td colSpan={5} className="px-6 py-8 text-center text-sm text-[#7b887f]">{orders.length ? 'Aucune commande réelle pour cette période.' : 'Aucune commande réelle enregistrée.'}</td></tr>}</tbody></table></div>
      </section>
      {ordersOpen && <OrderHistory orders={filteredOrders} selectedId={selectedOrder} onSelect={setSelectedOrder} onClose={() => { setOrdersOpen(false); setSelectedOrder(null); }} />}
    </div>
  );
}
