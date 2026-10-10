'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVoice } from '@/lib/voice/use-voice';
import { supabaseAnonKey } from '@/lib/supabase/client';

const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const demoRestaurantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const demoRestaurantName = 'La Piazza République';

type ProductId = string;

type CatalogProduct = {
  id: number;
  productId: ProductId;
  name: string;
  detail: string;
  emoji: string;
  imageUrl?: string;
  category: string;
  subcategory?: string;
  price: number;
  posCode: string;
  available: boolean;
};

type BasketItem = {
  productId: string;
  name?: string;
  quantity: number;
  price?: number;
  customizations?: string[];
};

export function OrderWorkspace({ products, agentWelcome, restaurantName = demoRestaurantName, restaurantId = demoRestaurantId }: { products: CatalogProduct[]; agentWelcome: string; agentRules: Array<[string, boolean]>; restaurantName?: string; restaurantId?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const catalog = useMemo(
    () => products.map((product) => ({ productId: product.productId, name: product.name, price: product.price })),
    [products],
  );
  const { status, basket, isStarted, start, sendText, interrupt, orderResult, resetForNextCustomer } = useVoice({
    brand: restaurantName,
    restaurantId,
    catalog,
    onAudit: async (audit) => {
      try {
        await fetch('/api/conversations/audit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: audit.conversationId || `${restaurantId}-${Date.now()}`,
            restaurantId: audit.restaurantId || restaurantId,
            startedAt: audit.startedAt,
            endedAt: audit.endedAt,
            messages: audit.messages,
            usage: audit.usage,
          }),
        });
      } catch {
        // audit non bloquant
      }
    },
  });

  const [pricing, setPricing] = useState<{ acceptingOrders: boolean; discountTotal: number; total: number } | null>(null);
  const [countdown, setCountdown] = useState<number>(10);

  const confirmed = orderResult?.status === 'submitted';

  useEffect(() => {
    if (orderResult?.status !== 'submitted') {
      return;
    }

    const interval = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          window.clearInterval(interval);
          resetForNextCustomer();
          return 10;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [orderResult?.status, resetForNextCustomer]);

  const total = useMemo(() => basket.total, [basket.total]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-pricing', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${supabaseAnonKey}` },
        body: JSON.stringify({ restaurantId, subtotal: total }),
      })
        .then(async (response) => {
          const result = (await response.json().catch(() => ({}))) as { acceptingOrders?: boolean; discountTotal?: number; total?: number };
          if (response.ok) setPricing({ acceptingOrders: result.acceptingOrders !== false, discountTotal: result.discountTotal ?? 0, total: result.total ?? total });
        })
        .catch(() => setPricing(null));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [restaurantId, total]);

  const finalTotal = pricing?.total ?? total;

  const listening = status.conversation === 'user_speaking' || status.conversation === 'listening';
  const speaking = status.conversation === 'assistant_speaking';
  const connecting = status.connection === 'connecting';

  const statusLabel =
    status.connection === 'error' || status.connection === 'disconnected'
      ? 'Connexion interrompue'
      : connecting
        ? 'Connexion…'
        : status.connection === 'connected'
          ? 'En ligne'
          : 'Inactif';

  const mappedItems = useMemo(() => {
    return (basket.items as BasketItem[]).flatMap((item) => {
      const product = products.find((entry) => entry.productId === item.productId);
      const name = item.name || product?.name || item.productId;
      const price = typeof item.price === 'number' ? item.price : product?.price ?? 0;
      const detail = product?.detail ?? '';
      const emoji = product?.emoji ?? '🍽️';

      return Array.from({ length: item.quantity }, (_, index) => ({
        id: `${item.productId}-${index}`,
        productId: item.productId,
        name,
        detail,
        price,
        emoji,
        available: product?.available ?? true,
        category: product?.category ?? 'Articles',
        posCode: product?.posCode ?? item.productId,
        customizations: item.customizations ?? [],
      }));
    });
  }, [basket.items, products]);

  const handleRestart = () => {
    setCountdown(10);
    resetForNextCustomer();
    void start(audioRef.current ?? undefined);
  };

  const handleCancel = () => {
    setCountdown(10);
    resetForNextCustomer();
  };

  const handleRemove = (name: string) => {
    sendText(`Retire un ${name} de ma commande.`);
  };

  return (
    <main className="min-h-screen bg-[#f4f5ef] text-[#142018]">
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      <header className="mx-auto flex max-w-[1540px] items-center justify-between px-5 py-5 md:px-10">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#0b1f14] text-lg font-black text-white">D</span>
          <div>
            <p className="text-lg font-black tracking-[-0.04em]">DRIVE<span className="text-[#ff5a36]">VOICE</span></p>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#6b766e]">{restaurantName} · Assistant de commande</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-[#dce1d8] bg-white px-4 py-2 text-xs font-bold">
          <span className={`h-2 w-2 rounded-full ${status.connection === 'error' || status.connection === 'disconnected' ? 'bg-[#e74d3c]' : connecting ? 'animate-pulse bg-[#ffc647]' : status.connection === 'connected' ? 'animate-pulse bg-[#39b76a]' : 'bg-[#9aa19a]'}`} /> {statusLabel}
        </div>
      </header>

      <section className={`mx-auto grid max-w-[1540px] gap-5 px-5 pb-8 md:px-10 ${isStarted ? 'xl:grid-cols-[1.2fr_1fr]' : 'grid-cols-1'}`}>
        <div className="relative flex min-h-[720px] flex-col overflow-hidden rounded-[32px] bg-[#0b1f14] p-7 text-white md:p-11">
          <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-[#ff5a36]" />
          <div className="pointer-events-none absolute right-28 top-20 h-24 w-24 rounded-full bg-[#ffc647]" />

          <div className="relative z-10 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold">FR · LIVE</span>
              <span className="text-xs text-white/55">Drive n°04 · Voie A</span>
            </div>
          </div>

          {!isStarted ? (
            <div className="relative z-10 my-auto max-w-3xl py-16">
              <h1 className="max-w-2xl text-[clamp(2.7rem,6vw,6rem)] font-black leading-[.9] tracking-[-0.07em]">
                Prêt à passer votre commande<span className="text-[#ff5a36]"> ?</span>
              </h1>
              <p className="mt-7 max-w-xl text-base font-semibold leading-relaxed text-white/70 md:text-lg">
                Veuillez cliquer sur le bouton « Passer ma commande » pour commencer votre commande.
              </p>
              {status.error ? (
                <div role="alert" className="mt-6 max-w-xl rounded-2xl border border-[#ffc647]/30 bg-[#ffc647]/10 px-4 py-3 text-sm font-semibold text-[#ffe099]">
                  {status.error}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="relative z-10 my-auto py-8">
              <div className="mb-8 flex items-center gap-5">
                <button
                  onClick={interrupt}
                  disabled={status.connection !== 'connected'}
                  aria-label="Interrompre l’agent et parler"
                  className={`voice-orb grid h-24 w-24 shrink-0 place-items-center rounded-full border-[10px] text-3xl shadow-2xl transition md:h-32 md:w-32 ${listening ? 'border-[#ffc647]/25 bg-[#ffc647] text-[#142018]' : speaking ? 'border-[#ff5a36]/25 bg-[#ff5a36]' : 'border-white/10 bg-white/10'} disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {connecting ? '···' : listening ? '●' : speaking ? '◖' : '◎'}
                </button>
                <div>
                  <p className="text-xs font-bold uppercase tracking-[.22em] text-[#ffc647]">
                    {connecting ? 'Ouverture de la ligne' : listening ? 'Je vous écoute en direct' : speaking ? 'DriveVoice vous parle' : 'À vous de parler'}
                  </p>
                  <div className="mt-3 flex h-8 items-center gap-1" aria-hidden="true">
                    {[14, 26, 38, 22, 44, 31, 18, 36, 24, 15].map((height, index) => (
                      <span
                        key={index}
                        className={`wave-bar w-1.5 rounded-full transition-colors ${listening ? 'bg-[#ffc647]' : speaking ? 'bg-[#ff5a36]' : 'bg-white/20'}`}
                        style={{ height }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="max-w-3xl rounded-[28px] bg-white/8 p-6 backdrop-blur md:p-8">
                <div className="flex items-center gap-4">
                  <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-xs font-black text-[#142018] ${listening ? 'bg-[#ffc647]' : speaking ? 'bg-[#ff5a36] text-white' : 'bg-white/20 text-white'}`}>
                    {listening ? 'VOUS' : speaking ? 'DV' : '•••'}
                  </span>
                  <div>
                    <p className="text-xl font-bold leading-snug md:text-3xl">{listening ? 'Le client parle' : speaking ? 'DriveVoice vous répond' : 'Conversation vocale active'}</p>
                    <p className="mt-2 text-sm text-white/50">{speaking ? 'Je traite votre demande…' : listening ? 'Je vous écoute…' : agentWelcome}</p>
                  </div>
                </div>
              </div>

              {status.error && (
                <p role="alert" className="mt-4 max-w-3xl rounded-2xl border border-[#ffc647]/30 bg-[#ffc647]/10 px-4 py-3 text-sm text-[#ffe099]">
                  {status.error}
                </p>
              )}
            </div>
          )}

          {!isStarted ? (
            <button
              onClick={() => void start(audioRef.current ?? undefined)}
              disabled={pricing?.acceptingOrders === false}
              className="relative z-10 flex w-full items-center justify-between rounded-2xl bg-[#ff5a36] px-6 py-5 text-left transition hover:-translate-y-0.5 hover:bg-[#ff6c4d] disabled:cursor-not-allowed disabled:opacity-50 md:w-[440px]"
            >
              <span>
                <strong className="block text-lg">{pricing?.acceptingOrders === false ? 'Commandes temporairement fermées' : 'Passer ma commande'}</strong>
                <small className="text-white/70">{pricing?.acceptingOrders === false ? 'Le restaurant est actuellement fermé ou en pause.' : 'Autorisez le micro, l’agent démarre en direct'}</small>
              </span>
              <span className="grid h-12 w-12 place-items-center rounded-full bg-white text-2xl text-[#ff5a36]">●</span>
            </button>
          ) : (
            <div className="relative z-10 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-5">
              <p className="text-xs text-white/45">Vous pouvez parler par-dessus l’agent ou toucher le cercle pour l’interrompre.</p>
              <div className="flex items-center gap-4">
                <button onClick={handleRestart} className="text-xs font-bold text-white/60 underline decoration-white/20 underline-offset-4">Recommencer</button>
                <button onClick={handleCancel} className="rounded-xl border border-[#ff927a]/40 px-3 py-2 text-xs font-black text-[#ffb09c] transition hover:border-[#ff927a] hover:bg-[#ff5a36]/15">Annuler la commande</button>
              </div>
            </div>
          )}
        </div>

        {isStarted && (
          <aside className="flex min-h-[720px] flex-col rounded-[32px] bg-white p-8 shadow-sm md:p-10 xl:sticky xl:top-24 xl:h-fit">
          <div className="flex items-center justify-between border-b border-[#e7eae4] pb-7">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.18em] text-[#899189]">Commande · {restaurantName}</p>
              <h2 className="mt-1 text-2xl font-black tracking-[-0.04em]">Votre panier</h2>
            </div>
            <span className="rounded-full bg-[#f1f3ee] px-3 py-1.5 text-xs font-bold">{mappedItems.length} article{mappedItems.length !== 1 ? 's' : ''}</span>
          </div>

          {confirmed ? (
            <div className="grid flex-1 place-items-center text-center">
              <div>
                <div className="mx-auto mb-5 grid h-24 w-24 place-items-center rounded-full bg-[#dff6e5] text-4xl">✓</div>
                <p className="text-xs font-bold uppercase tracking-[.18em] text-[#38a55f]">Commande confirmée</p>
                {orderResult?.ref ? <p className="mt-2 text-7xl font-black tracking-[-.08em]">{orderResult.ref}</p> : null}
                <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#edf6ef] px-4 py-1.5 text-xs font-bold text-[#2a8747]">
                  <span className="h-2 w-2 rounded-full animate-pulse bg-[#35a85a]" />
                  Réinitialisation automatique dans {countdown}s
                </div>
                <p className="mt-4 max-w-xs text-sm leading-relaxed text-[#758077]">Avancez jusqu’à la prochaine fenêtre. Votre commande a été transmise en cuisine.</p>
                {orderResult?.status === 'failed' && orderResult.message ? (
                  <p className="mt-3 text-xs font-bold text-[#bd5d3d]">{orderResult.message}</p>
                ) : null}
                <button
                  onClick={resetForNextCustomer}
                  className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[#0b1f14] px-5 py-2.5 text-xs font-black text-white transition hover:bg-[#153623]"
                >
                  Client suivant →
                </button>
              </div>
            </div>
          ) : mappedItems.length ? (
            <div className="flex-1 space-y-3 overflow-auto py-6">
              {mappedItems.map((item, index) => (
                <div key={item.id} className="group flex items-center gap-4 rounded-2xl border border-[#edf0ea] p-4 transition hover:border-[#d9ded5]">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[#f3f5f0] text-2xl">{item.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-black">{index + 1}. {item.name}</p>
                    <p className="truncate text-xs text-[#8a938b]">{item.detail}</p>
                    {item.customizations?.length ? <p className="mt-1 text-[10px] font-bold text-[#bd5d3d]">{item.customizations.join(' · ')}</p> : null}
                  </div>
                  <div className="text-right">
                    <p className="font-black">{money.format(item.price)}</p>
                    <button onClick={() => handleRemove(item.name)} className="mt-1 text-[11px] font-bold text-[#ff5a36] opacity-70 hover:opacity-100">Retirer</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid flex-1 place-items-center text-center">
              <div className="max-w-[250px]">
                <div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-[#f3f5f0] text-3xl">🎙️</div>
                <h3 className="text-xl font-black">Prêt à vous écouter</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#7b847d]">Le panier se met à jour pendant votre conversation avec l’agent.</p>
              </div>
            </div>
          )}

          <div className="border-t border-[#e7eae4] pt-6">
            <div className="flex items-end justify-between">
              <div>
                <span className="text-sm font-bold text-[#717a73]">Total TTC</span>
                {pricing?.discountTotal ? <small className="mt-1 block text-xs font-bold text-[#bd5d3d]">Remise HubRise : −{money.format(pricing.discountTotal)}</small> : null}
              </div>
              <strong className="text-4xl font-black tracking-[-0.05em]">{money.format(finalTotal)}</strong>
            </div>
            {orderResult?.status === 'failed' && !confirmed ? (
              <p className="mt-3 text-center text-[11px] font-bold text-[#bd5d3d]">
                {orderResult.message ?? "La commande n'a pas pu être transmise. Réessayez ou appelez un équipier."}
              </p>
            ) : null}
            <p className="mt-4 text-center text-[11px] text-[#9aa19a]">Paiement à la prochaine fenêtre · Dites &laquo; c&apos;est tout &raquo; pour envoyer la commande</p>
          </div>
          </aside>
        )}
      </section>
    </main>
  );
}
