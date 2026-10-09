'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase/client';

type SupportMessage = {
  id: string;
  conversation_id: string;
  sender_type: 'platform_admin' | 'restaurant';
  sender_user_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

type RestaurantChoice = { id: string; name: string };
type SupportConversation = {
  id: string;
  restaurant_id: string;
  status: string;
  last_message_at: string | null;
  unreadCount?: number;
  restaurants?: { name: string; city?: string | null; code?: string | null } | Array<{ name: string; city?: string | null; code?: string | null }> | null;
};

async function authenticatedFetch(path: string, init: RequestInit = {}) {
  if (!supabase) throw new Error('Authentification Supabase indisponible.');
  const { data } = await supabase.auth.getSession();
  let token = data.session?.access_token;
  if (!token) {
    const refreshed = await supabase.auth.refreshSession();
    token = refreshed.data.session?.access_token;
    if (refreshed.error || !token) throw refreshed.error ?? new Error('Session expirée.');
  }

  const send = (accessToken: string) => fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  let response = await send(token);
  if (response.status === 401) {
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session?.access_token) throw refreshed.error ?? new Error('Session expirée.');
    response = await send(refreshed.data.session.access_token);
  }
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Opération impossible.');
  return result;
}

function conversationRestaurantName(conversation: SupportConversation | undefined, restaurants: RestaurantChoice[]) {
  const relation = conversation?.restaurants;
  const relatedRestaurant = Array.isArray(relation) ? relation[0] : relation;
  return relatedRestaurant?.name ?? restaurants.find((restaurant) => restaurant.id === conversation?.restaurant_id)?.name ?? 'Restaurant';
}

export function SupportPanel({ mode, restaurantId, restaurants = [] }: {
  mode: 'admin' | 'restaurant';
  restaurantId?: string;
  restaurants?: RestaurantChoice[];
}) {
  const [conversations, setConversations] = useState<SupportConversation[]>([]);
  const [selectedRestaurantId, setSelectedRestaurantId] = useState(restaurantId ?? '');
  const [messageState, setMessageState] = useState<{ restaurantId: string; messages: SupportMessage[]; loaded: boolean } | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const activeRestaurantId = mode === 'restaurant' ? restaurantId ?? '' : selectedRestaurantId;
  const messages = messageState?.restaurantId === activeRestaurantId ? messageState.messages : [];
  const loading = Boolean(activeRestaurantId) && (messageState?.restaurantId !== activeRestaurantId || !messageState.loaded);
  const selectedConversation = useMemo(() => conversations.find((conversation) => conversation.restaurant_id === activeRestaurantId), [conversations, activeRestaurantId]);

  const loadInbox = useCallback(async () => {
    if (mode !== 'admin') return;
    try {
      const result = await authenticatedFetch('/api/admin/support');
      setConversations(Array.isArray(result.conversations) ? result.conversations as SupportConversation[] : []);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Impossible de charger la boîte de réception.');
    }
  }, [mode]);

  const loadMessages = useCallback(async () => {
    if (!activeRestaurantId) return;
    try {
      const query = new URLSearchParams({ restaurantId: activeRestaurantId });
      const result = mode === 'admin'
        ? await authenticatedFetch(`/api/admin/support?${query}`)
        : await authenticatedFetch(`/api/restaurant/support?${query}`);
      setMessageState({ restaurantId: activeRestaurantId, messages: Array.isArray(result.messages) ? result.messages as SupportMessage[] : [], loaded: true });
      if (mode === 'admin' && result.conversation) {
        setConversations((current) => {
          const conversation = result.conversation as SupportConversation;
          const existing = current.find((item) => item.id === conversation.id);
          return existing ? current.map((item) => item.id === conversation.id ? { ...item, ...conversation, unreadCount: 0 } : item) : [{ ...conversation, unreadCount: 0 }, ...current];
        });
      }
      setError('');
    } catch (loadError) {
      setMessageState((current) => current?.restaurantId === activeRestaurantId ? { ...current, loaded: true } : { restaurantId: activeRestaurantId, messages: [], loaded: true });
      setError(loadError instanceof Error ? loadError.message : 'Impossible de charger les messages.');
    }
  }, [activeRestaurantId, mode]);

  useEffect(() => {
    if (mode !== 'admin') return;
    const timeout = window.setTimeout(() => void loadInbox(), 0);
    const interval = window.setInterval(() => void loadInbox(), 15000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [loadInbox, mode]);

  useEffect(() => {
    if (!activeRestaurantId) return;
    const timeout = window.setTimeout(() => void loadMessages(), 0);
    const interval = window.setInterval(() => void loadMessages(), 15000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [activeRestaurantId, loadMessages]);

  const sendMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!activeRestaurantId || !text || sending) return;
    setSending(true);
    setError('');
    try {
      const path = mode === 'admin' ? '/api/admin/support' : '/api/restaurant/support';
      const result = await authenticatedFetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ restaurantId: activeRestaurantId, body: text }),
      });
      if (result.message) {
        const message = result.message as SupportMessage;
        setMessageState((current) => current?.restaurantId === activeRestaurantId
          ? { ...current, messages: [...current.messages, message], loaded: true }
          : { restaurantId: activeRestaurantId, messages: [message], loaded: true });
      }
      setDraft('');
      await loadInbox();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Impossible d’envoyer ce message.');
    } finally {
      setSending(false);
    }
  };

  const activeRestaurantName = conversationRestaurantName(selectedConversation, restaurants.filter((restaurant) => restaurant.id === activeRestaurantId));
  const chat = <div className="flex min-h-[520px] flex-col rounded-3xl border border-[#e2e7df] bg-white shadow-sm">
    <div className="border-b border-[#edf0eb] px-5 py-4">
      <p className="text-[10px] font-black uppercase tracking-[.18em] text-[#ff5a36]">{mode === 'admin' ? 'Assistance DriveVoice' : 'Support DriveVoice'}</p>
      <h3 className="mt-1 text-lg font-black">{mode === 'admin' ? activeRestaurantId ? activeRestaurantName : 'Sélectionnez un restaurant' : 'Messagerie support'}</h3>
      <p className="mt-1 text-xs text-[#839087]">Échange direct et historique conservé.</p>
    </div>
    <div className="flex-1 space-y-3 overflow-y-auto bg-[#f8faf7] p-4">
      {!activeRestaurantId ? <p className="py-12 text-center text-sm text-[#879188]">Choisissez un restaurant pour consulter ou démarrer une conversation.</p> : loading && !messages.length ? <p className="py-12 text-center text-sm text-[#879188]">Chargement des messages…</p> : messages.length ? messages.map((message) => {
        const mine = mode === 'admin' ? message.sender_type === 'platform_admin' : message.sender_type === 'restaurant';
        return <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}><article className={`max-w-[85%] rounded-2xl px-4 py-3 ${mine ? 'bg-[#0b1f14] text-white' : 'border border-[#e5e9e2] bg-white text-[#26372c]'}`}><p className="whitespace-pre-wrap text-sm leading-relaxed">{message.body}</p><time className={`mt-2 block text-right text-[9px] ${mine ? 'text-white/50' : 'text-[#89948b]'}`}>{new Date(message.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</time></article></div>;
      }) : activeRestaurantId ? <p className="py-12 text-center text-sm text-[#879188]">Aucun message. Envoyez le premier message pour démarrer.</p> : null}
    </div>
    {activeRestaurantId && <form onSubmit={sendMessage} className="flex gap-2 border-t border-[#edf0eb] p-4"><textarea aria-label="Votre message" rows={2} maxLength={5000} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Écrire un message…" className="min-h-12 flex-1 resize-y rounded-xl border border-[#dfe5de] px-3 py-2 text-sm outline-none focus:border-[#ff5a36]" /><button disabled={sending || !draft.trim()} className="self-end rounded-xl bg-[#ff5a36] px-4 py-3 text-xs font-black text-white disabled:opacity-50">{sending ? 'Envoi…' : 'Envoyer'}</button></form>}
    {error && <p role="alert" className="border-t border-[#f2d0c8] bg-[#fff2ee] px-4 py-3 text-xs font-bold text-[#a5442c]">{error}</p>}
  </div>;

  if (mode === 'restaurant') return <section><div className="mb-5"><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ff5a36]">Équipe DriveVoice</p><h2 className="mt-2 text-3xl font-black">Contacter le support</h2><p className="mt-2 text-sm text-[#738078]">Posez vos questions à l’équipe DriveVoice. Vos échanges restent accessibles ici.</p></div>{chat}</section>;

  return <section>
    <div className="mb-6"><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Opérations client</p><h2 className="mt-2 text-4xl font-black tracking-[-.05em]">Messagerie support</h2><p className="mt-3 text-sm text-[#738078]">Conversations directes avec les restaurants clients, actualisées automatiquement.</p></div>
    <div className="grid gap-5 xl:grid-cols-[320px_1fr]">
      <aside className="rounded-3xl border border-[#e2e7df] bg-white p-4 shadow-sm">
        <label className="block text-[10px] font-black uppercase tracking-wider text-[#89948b]">Démarrer une conversation
          <select value={restaurants.some((restaurant) => restaurant.id === selectedRestaurantId) ? selectedRestaurantId : ''} onChange={(event) => setSelectedRestaurantId(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfe5de] bg-white px-3 py-3 text-xs font-bold">
            <option value="">Choisir un restaurant…</option>{restaurants.map((restaurant) => <option key={restaurant.id} value={restaurant.id}>{restaurant.name}</option>)}
          </select>
        </label>
        <div className="mt-5 border-t border-[#edf0eb] pt-4"><p className="mb-2 text-[10px] font-black uppercase tracking-wider text-[#89948b]">Boîte de réception</p>{conversations.length ? <div className="space-y-1">{conversations.map((conversation) => <button key={conversation.id} onClick={() => setSelectedRestaurantId(conversation.restaurant_id)} className={`w-full rounded-xl px-3 py-3 text-left transition ${activeRestaurantId === conversation.restaurant_id ? 'bg-[#0b1f14] text-white' : 'hover:bg-[#f4f6f1]'}`}><span className="flex items-center justify-between gap-2"><span className="truncate text-xs font-black">{conversationRestaurantName(conversation, restaurants)}</span>{Boolean(conversation.unreadCount) && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#ff5a36] px-1 text-[9px] font-black text-white">{conversation.unreadCount}</span>}</span><span className={`mt-1 block text-[10px] ${activeRestaurantId === conversation.restaurant_id ? 'text-white/55' : 'text-[#89948b]'}`}>{conversation.last_message_at ? new Date(conversation.last_message_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'Conversation ouverte'}</span></button>)}</div> : <p className="py-5 text-xs text-[#89948b]">Aucune conversation pour le moment.</p>}</div>
      </aside>
      {chat}
    </div>
  </section>;
}
