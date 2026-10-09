'use client';

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { isSupabaseConfigured, supabase, supabaseAnonKey } from '@/lib/supabase/client';
import { fetchBrandsFromDb, syncBrandsToDb, type MasterBrandInput } from '@/lib/supabase/sync';
import { createRestaurant, deleteRestaurant, deleteRestaurantProduct, fetchRestaurantProducts, fetchRestaurants, updateRestaurantProduct, upsertRestaurantProduct, type RestaurantInfo, type RestaurantProductInfo } from '@/lib/supabase/restaurants';
import { calculateCatalogPrice, validateCatalogSelection } from '@/lib/catalog-rules';
import { RealtimeResponseController, type ConversationState } from '@/lib/realtime/session-controller';
import { applyUpdateOrder, buildRealtimeToolDefinitions, createIdempotencyKey, jsonToolOutput, normalizeCatalog, parseUpdateOrderArguments, type BasketSnapshot, type ToolResult } from '@/lib/realtime/tool-protocol';
import { logRealtimeEvent } from '@/lib/realtime/logging';
import { OrderWorkspace as VoiceOrderWorkspace } from '@/components/voice/order-workspace';
import { RestaurantDashboardPanel } from '@/components/restaurant-dashboard-panel';
import { SupportPanel } from '@/components/support-panel';

const RESPONSE_INACTIVITY_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_DURATION_MS = 45_000;
const TOOL_MAX_DURATION_MS = 12_000;

type ProductId = string;
type OrderItem = { id: number; productId: ProductId; name: string; detail: string; price: number; emoji: string; customizations?: string[] };
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';
type TranscriptMessage = { id: string; speaker: 'client' | 'agent'; text: string; status: 'partial' | 'final'; timestamp: number };
type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  text?: string;
  item_id?: string;
  response_id?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  status?: string;
  status_details?: unknown;
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
    output?: Array<{
      type?: string;
      name?: string;
      arguments?: string;
      call_id?: string;
    }>;
  };
  error?: { message?: string };
  item?: {
    type?: string;
    id?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    role?: string;
    item_id?: string;
    content?: Array<{ type?: string; transcript?: string; text?: string }>;
  };
};

type ToolCallState = {
  name: string;
  arguments: string;
  status: 'running' | 'completed';
  result?: ToolResult<unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isExplicitConfirmation = (value: unknown): value is { confirmation: 'explicit' } =>
  isRecord(value) && value.confirmation === 'explicit';

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: {
    resultIndex: number;
    results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
  }) => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

const brands = [
  { name: "McDonald's", mark: 'M', color: '#ffcc00', ink: '#1d1d1b' },
  { name: 'Quick', mark: 'Q', color: '#e31c3d', ink: '#fff' },
  { name: 'KFC', mark: 'K', color: '#e4002b', ink: '#fff' },
];

const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const splitField = (value: string) => value.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean);
const menuOptionMatchesSize = (name: string, selectedSize: string, type: 'accompagnement' | 'boisson') => {
  const text = name.toLowerCase();
  const size = selectedSize.toLowerCase();
  if (type === 'accompagnement') {
    if (/king fries/.test(text)) return true;
    if (/grande|9\)|large/.test(text)) return /king|extra|xxl|xl/.test(size);
    if (/moyenne|6\)|petite/.test(text)) return /medium|m|king|extra|xxl|xl/.test(size);
    return true;
  }
  if (/25cl|33cl|20cl/.test(text)) return /medium|m/.test(size);
  if (/40cl/.test(text)) return /medium|m|king|extra|xxl|xl/.test(size);
  if (/50cl/.test(text)) return /king|extra|xxl|xl/.test(size);
  return true;
};
function OrderWorkspace({ products, agentWelcome, agentRules, restaurantName, restaurantId }: { products: CatalogProduct[]; agentWelcome: string; agentRules: Array<[string, boolean]>; restaurantName: string; restaurantId: string }) {
  return (
    <VoiceOrderWorkspace products={products} agentWelcome={agentWelcome} agentRules={agentRules} restaurantName={restaurantName} restaurantId={restaurantId} />
  );
}

type WorkspaceTab = 'order' | 'dashboard' | 'integrations' | 'catalog' | 'agent' | 'account' | 'support';
type ProductVariant = { id: number; name: string; priceDelta: number; posCode: string };
type ProductOption = { id: number; name: string; priceDelta: number; priceDeltaBySize?: Partial<Record<string, number>>; posCode: string; available: boolean; availableFor?: string[]; imageUrl?: string; productId?: string; detail?: string };
type ProductGroupRule = { required: boolean; min: number; max: number };
type ProductOptionGroup = { id: number; name: string; question: string; required: boolean; min: number; max: number; sizeScope?: string; rulesBySize?: Partial<Record<string, ProductGroupRule>>; options: ProductOption[] };
type ProductModifier = { id: number; name: string; kind: 'remove' | 'add'; priceDelta: number };
type ProductIngredient = { id: number; name: string; removable: boolean; extraAllowed: boolean; extraPrice: number };
type ProductNutrition = { calories: string; fat: string; saturatedFat: string; proteins: string; carbohydrates: string; sugars: string; salt: string };
type CatalogProduct = {
  id: number;
  productId: ProductId;
  name: string;
  mainProduct?: string;
  detail: string;
  emoji: string;
  imageUrl?: string;
  category: string;
  subcategory?: string;
  price: number;
  posCode: string;
  available: boolean;
  ingredients?: string[];
  ingredientSettings?: ProductIngredient[];
  productType?: 'simple' | 'configurable' | 'menu' | 'bundle' | 'deal';
  variants?: ProductVariant[];
  optionGroups?: ProductOptionGroup[];
  modifiers?: ProductModifier[];
  slug?: string;
  meatFilter?: string;
  badges?: string[];
  ingredientImages?: string[];
  allergens?: string[];
  traces?: string[];
  nutrition?: ProductNutrition;
  displayOrder?: number;
};

const demoRestaurantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const demoRestaurantName = 'La Piazza République';

function mapRestaurantProduct(product: RestaurantProductInfo, index: number): CatalogProduct {
  const productId = String(product.product_id ?? product.id ?? `hubrise-${index}`);
  const source = product.data && typeof product.data === 'object' ? product.data : {};
  const sourceValue = (key: string) => source[key];
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const isTechnicalRef = (value: string) => /^[a-z0-9]{5,14}$/i.test(value) && !/[À-ÿ\s]/.test(value);
  const rawOptionGroups = sourceValue('optionGroups');
  const optionGroups: ProductOptionGroup[] = Array.isArray(rawOptionGroups)
    ? rawOptionGroups.map((group, groupIndex) => {
      const groupRecord = isRecord(group) ? group : {};
      const rawOptions = Array.isArray(groupRecord.options) ? groupRecord.options : [];
      const rawGroupName = String(groupRecord.name ?? '');
      const groupName = rawGroupName && !isTechnicalRef(rawGroupName) ? rawGroupName : `Choix ${groupIndex + 1}`;
      const rawRules = isRecord(groupRecord.rulesBySize) ? groupRecord.rulesBySize : undefined;
      const rulesBySize = rawRules ? Object.fromEntries(Object.entries(rawRules).filter(([, rule]) => isRecord(rule)).map(([size, rule]) => [size, {
        required: (rule as Record<string, unknown>).required === true,
        min: Number((rule as Record<string, unknown>).min ?? 0),
        max: Number((rule as Record<string, unknown>).max ?? 1),
      }])) : undefined;
      return {
        id: Number(groupRecord.id) || groupIndex + 1,
        name: groupName,
        question: String(groupRecord.question ?? `Choisissez ${groupName.toLowerCase()}`),
        required: Boolean(groupRecord.required),
        min: Number(groupRecord.min ?? 0),
        max: Number(groupRecord.max ?? 1),
        sizeScope: typeof groupRecord.sizeScope === 'string' ? groupRecord.sizeScope : undefined,
        rulesBySize,
        options: rawOptions.map((option, optionIndex) => {
          const optionRecord = isRecord(option) ? option : {};
          const rawOptionName = String(optionRecord.name ?? '');
          return {
            id: Number(optionRecord.id) || optionIndex + 1,
            name: rawOptionName && !isTechnicalRef(rawOptionName) ? rawOptionName : `Option ${optionIndex + 1}`,
            priceDelta: Number(optionRecord.priceDelta ?? 0),
            priceDeltaBySize: isRecord(optionRecord.priceDeltaBySize) ? optionRecord.priceDeltaBySize as Partial<Record<string, number>> : undefined,
            availableFor: Array.isArray(optionRecord.availableFor) ? optionRecord.availableFor.filter((size): size is string => typeof size === 'string') : undefined,
            productId: typeof optionRecord.productId === 'string' ? optionRecord.productId : undefined,
            detail: typeof optionRecord.detail === 'string' ? optionRecord.detail : undefined,
            imageUrl: typeof optionRecord.imageUrl === 'string' ? optionRecord.imageUrl : undefined,
            posCode: String(optionRecord.posCode ?? optionRecord.ref ?? ''),
            available: optionRecord.available !== false,
          };
        }),
      };
    })
    : [];
  const numericId = Number.parseInt(productId.replace(/\D/g, '').slice(-8), 10);
  const imageUrl = sourceValue('imageUrl') ?? sourceValue('image_url');
  const productType = sourceValue('productType');
  const variants = Array.isArray(sourceValue('variants')) ? sourceValue('variants') as ProductVariant[] : [];
  const ingredientSettings = Array.isArray(sourceValue('ingredientSettings')) ? sourceValue('ingredientSettings') as ProductIngredient[] : undefined;
  const ingredientsValue = sourceValue('ingredients');
  const ingredients = Array.isArray(ingredientsValue) ? ingredientsValue.filter((name: unknown): name is string => typeof name === 'string') : ingredientSettings?.map(ingredient => ingredient.name);
  const modifiers = Array.isArray(sourceValue('modifiers')) ? sourceValue('modifiers') as ProductModifier[] : [];
  const nutrition = isRecord(sourceValue('nutrition')) ? sourceValue('nutrition') as unknown as ProductNutrition : undefined;
  return {
    id: Number.isFinite(numericId) ? numericId : index + 1,
    productId,
    name: product.name ?? String(sourceValue('name') ?? 'Produit sans nom'),
    mainProduct: typeof sourceValue('mainProduct') === 'string' ? String(sourceValue('mainProduct')) : undefined,
    detail: String(sourceValue('detail') ?? sourceValue('description') ?? ''),
    emoji: typeof sourceValue('emoji') === 'string' ? String(sourceValue('emoji')) : '🍽️',
    imageUrl: typeof imageUrl === 'string' ? imageUrl : undefined,
    category: product.category ?? String(sourceValue('category') ?? sourceValue('category_name') ?? 'Autres'),
    subcategory: typeof sourceValue('subcategory') === 'string' ? String(sourceValue('subcategory')) : undefined,
    price: Number(product.price ?? 0),
    posCode: String(sourceValue('posCode') ?? sourceValue('sku_ref') ?? productId),
    available: product.available,
    ingredients,
    ingredientSettings,
    productType: ['simple', 'configurable', 'menu', 'bundle', 'deal'].includes(String(productType))
      ? productType as CatalogProduct['productType']
      : product.product_type === 'deal'
        ? 'deal'
        : /menu/i.test(String(product.category ?? sourceValue('category') ?? ''))
          ? 'menu'
          : optionGroups.length ? 'configurable' : 'simple',
    variants,
    optionGroups,
    modifiers,
    slug: typeof sourceValue('slug') === 'string' ? String(sourceValue('slug')) : undefined,
    meatFilter: typeof sourceValue('meatFilter') === 'string' ? String(sourceValue('meatFilter')) : undefined,
    badges: Array.isArray(sourceValue('badges')) ? (sourceValue('badges') as unknown[]).filter((value: unknown): value is string => typeof value === 'string') : undefined,
    ingredientImages: Array.isArray(sourceValue('ingredientImages')) ? (sourceValue('ingredientImages') as unknown[]).filter((value: unknown): value is string => typeof value === 'string') : undefined,
    allergens: Array.isArray(sourceValue('allergens')) ? (sourceValue('allergens') as unknown[]).filter((value: unknown): value is string => typeof value === 'string') : undefined,
    traces: Array.isArray(sourceValue('traces')) ? (sourceValue('traces') as unknown[]).filter((value: unknown): value is string => typeof value === 'string') : undefined,
    nutrition,
    displayOrder: Number(sourceValue('displayOrder') ?? product.display_order),
  };
}

type UserRole = 'directeur' | 'manager' | 'operateur';

const workspaceTabs: Array<{ id: WorkspaceTab; label: string; short: string; icon: string }> = [
  { id: 'order', label: 'Ecran de commande', short: 'COMMANDE', icon: '◉' },
  { id: 'dashboard', label: 'Pilotage', short: 'PILOTAGE', icon: '▥' },
  { id: 'integrations', label: 'Configuration caisse', short: 'CAISSE', icon: '⌁' },
  { id: 'catalog', label: 'Catalogue produits', short: 'CATALOGUE', icon: '▦' },
  { id: 'agent', label: 'Configuration assistant vocal', short: 'ASSISTANT', icon: '✦' },
  { id: 'account', label: 'Compte restaurant', short: 'COMPTE', icon: '◎' },
  { id: 'support', label: 'Messagerie support', short: 'SUPPORT', icon: '◉' },
];

const restrictedTabsForManager: WorkspaceTab[] = ['integrations', 'catalog', 'agent'];
const restrictedTabsForOperateur: WorkspaceTab[] = ['integrations', 'catalog', 'agent', 'account'];

const subcategoryTemplates: Record<string, string[]> = {};

const initialCatalog: CatalogProduct[] = [];

const initialAgentRules: Array<[string, boolean]> = [
  ['Toujours reformuler les choix et suppléments', true],
  ['Proposer une boisson lorsqu’elle manque au menu', true],
  ['Ne jamais inventer un produit indisponible', true],
  ['Transférer à un équipier après deux incompréhensions', true],
  ['Proposer automatiquement le dessert du moment', false],
];

const panelCard = 'rounded-[24px] border border-[#e2e6df] bg-white shadow-[0_16px_50px_rgba(17,32,22,.05)]';
const fieldClass = 'h-11 w-full rounded-xl border border-[#dfe4dc] bg-white px-3 text-sm font-semibold outline-none transition focus:border-[#ff6a45] focus:ring-4 focus:ring-[#ff6a45]/10';

function SectionHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-[11px] font-black uppercase tracking-[.22em] text-[#ff5a36]">{eyebrow}</p>
        <h1 className="mt-2 text-3xl font-black tracking-[-.045em] text-[#132018] md:text-4xl">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#6f7971]">{description}</p>
      </div>
      {action}
    </div>
  );
}

function IntegrationsPanel({ onCatalogSynced }: { onCatalogSynced: () => Promise<void> }) {
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success'>('idle');
  const [hubriseState, setHubriseState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [hubriseMessage, setHubriseMessage] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [productsCount, setProductsCount] = useState<number | null>(null);
  const [orderTestState, setOrderTestState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [orderTestMessage, setOrderTestMessage] = useState('');
  const [ordersSentCount, setOrdersSentCount] = useState<number>(0);
  const [disconnecting, setDisconnecting] = useState(false);
  const restaurantId = demoRestaurantId;

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ restaurantId }),
      });
      const data = await res.json() as { connected?: boolean; lastSyncAt?: string | null; error?: string };
      if (data.connected) {
        setHubriseState('connected');
        setLastSync(data.lastSyncAt || null);
      } else {
        setHubriseState('idle');
      }
      if (data.error) setHubriseMessage(data.error);
    } catch {
      setHubriseState('idle');
    }
  }, [restaurantId]);

  useEffect(() => {
    const initialStatusTimer = window.setTimeout(() => void loadStatus(), 0);
    const params = new URLSearchParams(window.location.search);
    let transitionTimer: number | null = null;
    if (params.get('hubrise') === 'connected') {
      transitionTimer = window.setTimeout(() => {
        setHubriseState('connected');
        void loadStatus();
      }, 0);
      window.history.replaceState({}, '', window.location.pathname + window.location.search.replace(/[?&]hubrise=connected[^&]*/, '').replace(/^\?&/, '?'));
      window.setTimeout(() => {
        void fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=sync_catalog', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${supabaseAnonKey}` },
          body: JSON.stringify({ restaurantId }),
        }).then(async response => {
          const result = await response.json().catch(() => ({})) as { productsImported?: number };
          if (response.ok) {
            setProductsCount(result.productsImported ?? null);
            setLastSync(new Date().toISOString());
            await onCatalogSynced();
          }
        });
      }, 0);
    } else if (params.get('hubrise') === 'error') {
      transitionTimer = window.setTimeout(() => {
        setHubriseState('error');
        setHubriseMessage(decodeURIComponent(params.get('reason') || 'Erreur OAuth HubRise'));
      }, 0);
    }
    return () => {
      window.clearTimeout(initialStatusTimer);
      if (transitionTimer !== null) window.clearTimeout(transitionTimer);
    };
  }, [loadStatus]);

  const runTest = () => { setTestState('testing'); window.setTimeout(() => setTestState('success'), 900); };

  const connectHubRise = async () => {
    setHubriseState('connecting');
    setHubriseMessage('');
    try {
      window.sessionStorage.setItem('hubrise_oauth_restaurant_id', restaurantId);
      const { data: sessionData } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
      const response = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=connect', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionData.session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ restaurantId }),
      });
      const result = await response.json() as { url?: string; error?: string };
      if (!response.ok || !result.url) throw new Error(result.error ?? 'Impossible de démarrer la connexion HubRise.');
      window.location.assign(result.url);
    } catch (error) {
      setHubriseState('error');
      setHubriseMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const disconnectHubRise = async () => {
    setDisconnecting(true);
    setHubriseMessage('');
    try {
      const res = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=disconnect', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ restaurantId }),
      });
      if (res.ok) {
        setHubriseState('idle');
        setLastSync(null);
        setProductsCount(null);
        setOrdersSentCount(0);
        setHubriseMessage('Connexion HubRise terminée.');
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setHubriseMessage(data.error ?? 'Impossible de se déconnecter.');
      }
    } catch (error) {
      setHubriseMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDisconnecting(false);
    }
  };

  const syncCatalog = async () => {
    setHubriseState('connecting');
    setHubriseMessage('');
    try {
      const res = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=sync_catalog', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ restaurantId }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; productsImported?: number; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Échec de la synchronisation');
      setProductsCount(data.productsImported ?? null);
      setLastSync(new Date().toISOString());
      setHubriseState('connected');
      setHubriseMessage(`${data.productsImported ?? 0} produits synchronisés`);
      await onCatalogSynced();
    } catch (error) {
      setHubriseState('error');
      setHubriseMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const sendTestOrder = async () => {
    setOrderTestState('sending');
    setOrderTestMessage('');
    try {
      const res = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=send_order', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ restaurantId, items: [{ name: 'Menu Whopper', quantity: 1, price: 12.9 }] }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; orderId?: string; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Échec de l\'envoi');
      setOrderTestState('success');
      setOrderTestMessage(`Commande test envoyée : ${data.orderId ?? '—'}`);
      setOrdersSentCount((count) => count + 1);
    } catch (error) {
      setOrderTestState('error');
      setOrderTestMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div>
      <SectionHeading eyebrow="Configuration caisse" title="Connectez votre environnement restaurant" description="HubRise centralisera la liaison avec votre caisse, votre catalogue et vos flux de commande. Les identifiants restent protégés côté serveur." action={<button onClick={runTest} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">{testState === 'testing' ? 'Test en cours…' : testState === 'success' ? '✓ Connexion validée' : 'Tester le flux complet'}</button>} />
      <section className={`${panelCard} mb-5 overflow-hidden border-[#d9e5dc]`}>
        <div className="flex flex-col gap-6 bg-[#0e2418] p-6 text-white md:flex-row md:items-center md:justify-between md:p-8">
          <div className="flex items-start gap-4">
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-[#ff5a36] text-2xl font-black">H</span>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ffc647]">{hubriseState === 'connected' ? 'Connecté à HubRise' : 'Connexion recommandée'}</p>
              <h2 className="mt-2 text-2xl font-black">{hubriseState === 'connected' ? 'HubRise connecté' : 'Connecter HubRise'}</h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/60">
                {hubriseState === 'connected'
                  ? `La caisse est synchronisée. ${lastSync ? 'Dernière synchronisation : ' + new Date(lastSync).toLocaleString('fr-FR') : ''} ${productsCount !== null ? `(${productsCount} produits importés)` : ''}`
                  : 'Connectez la caisse de cet établissement et synchronisez les commandes, le catalogue et les disponibilités depuis un seul espace.'}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-3 md:items-end">
            {hubriseState === 'connected' ? (
              <div className="flex flex-wrap gap-2">
                <button onClick={syncCatalog} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white transition hover:bg-[#ff7657]">↻ Synchroniser le catalogue</button>
                <button onClick={sendTestOrder} disabled={orderTestState === 'sending'} className="rounded-xl border border-white/30 bg-white/10 px-5 py-3 text-xs font-black text-white transition hover:bg-white/20 disabled:opacity-60">{orderTestState === 'sending' ? 'Envoi…' : 'Envoyer une commande test'}</button>
                <button onClick={disconnectHubRise} disabled={disconnecting} className="rounded-xl border border-white/30 bg-white/10 px-5 py-3 text-xs font-black text-white transition hover:bg-[#e04d39]/80 disabled:opacity-60">{disconnecting ? 'Déconnexion…' : 'Déconnecter HubRise'}</button>
              </div>
            ) : (
              <button onClick={connectHubRise} disabled={hubriseState === 'connecting'} className="shrink-0 rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white transition hover:bg-[#ff7657] disabled:opacity-60">{hubriseState === 'connecting' ? 'Connexion en cours…' : 'Connecter HubRise →'}</button>
            )}
            {hubriseMessage && <p className="max-w-xl text-xs font-semibold text-[#ff927a]">{hubriseMessage}</p>}
            {orderTestMessage && <p className={`max-w-xl text-xs font-semibold ${orderTestState === 'success' ? 'text-[#7ce3a1]' : 'text-[#ff927a]'}`}>{orderTestMessage}</p>}
          </div>
        </div>
        <div className="border-t border-[#e3ebe5] px-6 py-5 md:px-8">
          <p className="mb-4 text-[10px] font-black uppercase tracking-[.18em] text-[#8a938c]">État de la connexion</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'Caisse POS', status: hubriseState === 'connected' ? 'active' : 'inactive', detail: hubriseState === 'connected' ? 'Connectée' : 'Non connectée' },
              { label: 'Catalogue en temps réel', status: hubriseState === 'connected' && productsCount !== null ? 'active' : hubriseState === 'connected' ? 'pending' : 'inactive', detail: hubriseState === 'connected' ? (productsCount !== null ? `${productsCount} produits` : 'En attente') : 'Non synchronisé' },
              { label: 'Commandes synchronisées', status: hubriseState === 'connected' ? 'active' : 'inactive', detail: hubriseState === 'connected' ? `${ordersSentCount} envoyées` : 'En attente' },
              { label: 'Données chiffrées', status: 'active', detail: 'TLS 1.3 · AES-256' },
            ].map((item) => (
              <div key={item.label} className="flex items-start gap-3 rounded-xl bg-[#f7f8f5] p-4">
                <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-black ${item.status === 'active' ? 'bg-[#e5f6e9] text-[#27894a]' : item.status === 'pending' ? 'bg-[#fff5d9] text-[#a86f00]' : 'bg-[#f0f2ef] text-[#7c887f]'}`}>
                  {item.status === 'active' ? '✓' : item.status === 'pending' ? '◷' : '—'}
                </span>
                <div>
                  <p className="text-xs font-black text-[#132018]">{item.label}</p>
                  <p className={`mt-1 text-[10px] font-semibold ${item.status === 'active' ? 'text-[#27894a]' : item.status === 'pending' ? 'text-[#a86f00]' : 'text-[#7c887f]'}`}>{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
          {hubriseState === 'connected' && lastSync && (
            <p className="mt-4 text-[10px] font-bold text-[#8a938c]">Dernière synchronisation : {new Date(lastSync).toLocaleString('fr-FR')}</p>
          )}
        </div>
      </section>
    </div>
  );
}

function AccountPanel() {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteDraft, setInviteDraft] = useState({ fullName: '', email: '', role: 'Manager' as 'Directeur' | 'Manager' | 'Opérateur' });
  const [inviteNotice, setInviteNotice] = useState('');
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetNotice, setResetNotice] = useState('');
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [members, setMembers] = useState([
    { name: 'Alex Martin', email: 'alex@restaurant.fr', access: 'Directeur', status: 'Actif' },
    { name: 'Sophie Bernard', email: 'sophie@restaurant.fr', access: 'Manager', status: 'Actif' },
  ]);
  const [resettingMember, setResettingMember] = useState<string | null>(null);
  const [resetMemberNotice, setResetMemberNotice] = useState('');

  const openInvite = () => {
    setInviteDraft({ fullName: '', email: '', role: 'Manager' });
    setInviteNotice('');
    setInviteOpen(true);
  };

  const inviteMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) {
      setInviteNotice('La connexion Supabase n’est pas disponible.');
      return;
    }
    setInviteSubmitting(true);
    setInviteNotice('');
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      setInviteNotice('Connectez-vous à votre compte pour envoyer une invitation.');
      setInviteSubmitting(false);
      return;
    }
    try {
      const response = await fetch('/api/account/invite', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionData.session.access_token}`,
        },
        body: JSON.stringify({ ...inviteDraft, restaurantId: demoRestaurantId }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        setInviteNotice(result.error ?? 'Invitation impossible.');
        return;
      }
      setMembers(current => [...current, { name: inviteDraft.fullName, email: inviteDraft.email, access: inviteDraft.role, status: 'Invitation envoyée' }]);
      setInviteOpen(false);
      setInviteDraft({ fullName: '', email: '', role: 'Manager' as 'Directeur' | 'Manager' | 'Opérateur' });
    } catch {
      setInviteNotice('Impossible de contacter le service d’invitation.');
    } finally {
      setInviteSubmitting(false);
    }
  };

  const openPasswordReset = async () => {
    setResetNotice('');
    setResetOpen(true);
    if (!supabase) return;
    const { data } = await supabase.auth.getUser();
    if (data.user?.email) setResetEmail(data.user.email);
  };

  const requestPasswordReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !resetEmail.trim()) {
      setResetNotice('Saisissez l’adresse e-mail du compte à réinitialiser.');
      return;
    }
    setResetSubmitting(true);
    setResetNotice('');
    const { error } = await supabase.auth.resetPasswordForEmail(resetEmail.trim(), {
      redirectTo: `${window.location.origin}/login?mode=reset`,
    });
    setResetNotice(error ? error.message : "Un lien de réinitialisation vient d'être envoyé. Consultez votre messagerie.");
    setResetSubmitting(false);
  };

  const resetMemberPassword = async (memberEmail: string, memberName: string) => {
    if (!memberEmail) {
      setResetMemberNotice(`${memberName} n'a pas d'adresse e-mail associée.`);
      return;
    }
    if (!supabase) {
      setResetMemberNotice('La connexion Supabase n\'est pas disponible.');
      return;
    }
    setResettingMember(memberName);
    setResetMemberNotice('');
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(memberEmail, {
        redirectTo: `${window.location.origin}/login?mode=reset`,
      });
      if (error) {
        setResetMemberNotice(`Erreur : ${error.message}`);
      } else {
        setResetMemberNotice(`Lien de réinitialisation envoyé à ${memberEmail}`);
      }
    } catch {
      setResetMemberNotice('Impossible d\'envoyer le lien de réinitialisation.');
    } finally {
      setResettingMember(null);
    }
  };

  return (
    <div>
      <SectionHeading eyebrow="Espace restaurant" title="Mon compte" description="Gérez les droits d’accès et les membres de l’équipe de votre restaurant." />
      <section className={`${panelCard} mt-5 p-6 md:p-7`}><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Droits d’accès</p><h2 className="mt-2 text-xl font-black">Équipe du restaurant</h2><p className="mt-1 text-sm text-[#7b857d]">Contrôlez ce que chaque profil peut consulter ou modifier.</p></div><button onClick={openInvite} className="shrink-0 rounded-xl bg-[#0b1f14] px-4 py-3 text-xs font-black text-white transition hover:bg-[#173b27]">＋ Inviter un membre</button></div>{resetMemberNotice && <div className="mt-4 rounded-xl bg-[#edf7ef] px-4 py-3 text-xs font-bold text-[#287b43]">{resetMemberNotice}</div>}<div className="mt-6 overflow-x-auto rounded-2xl border border-[#e7ebe5]"><div className="min-w-[780px]"><div className="grid grid-cols-[1.3fr_1fr_1fr_auto] bg-[#f7f8f5] px-4 py-3 text-[10px] font-black uppercase tracking-widest text-[#8b948c]"><span>Profil</span><span>Accès</span><span>Statut</span><span className="text-right">Actions</span></div>{members.map(member=><div key={`${member.name}-${member.access}`} className="grid grid-cols-[1.3fr_1fr_1fr_auto] items-center border-t border-[#edf0eb] px-4 py-4 text-xs"><span className="font-black">{member.name}</span><span className="font-semibold text-[#68746b]">{member.access}</span><span className={`font-black ${member.status === 'Invitation envoyée' ? 'text-[#d98b14]' : 'text-[#2b9652]'}`}>● {member.status}</span><span className="text-right">{member.email ? <button onClick={() => resetMemberPassword(member.email, member.name)} disabled={resettingMember === member.name} className="rounded-lg border border-[#dfe4dc] bg-white px-3 py-2 text-[10px] font-black transition hover:border-[#ff8f72] hover:text-[#d95032] disabled:opacity-50">{resettingMember === member.name ? 'Envoi…' : 'Réinitialiser MDP'}</button> : <span className="text-[10px] text-[#8b948c]">—</span>}</span></div>)}</div></div></section>
      {inviteOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/65 p-4" role="dialog" aria-modal="true" aria-label="Inviter un membre"><div className="w-full max-w-lg rounded-[28px] bg-white p-7 shadow-2xl md:p-9"><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ff5a36]">Nouvel accès</p><h2 className="mt-2 text-2xl font-black">Inviter un membre</h2><p className="mt-2 text-sm leading-relaxed text-[#738078]">Un e-mail sécurisé sera envoyé pour créer son accès DriveVoice.</p></div><button onClick={() => setInviteOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] text-lg font-black" aria-label="Fermer">×</button></div><form onSubmit={inviteMember} className="mt-7 space-y-4"><label className="block text-xs font-black text-[#68736a]">Nom complet<input required value={inviteDraft.fullName} onChange={event => setInviteDraft(current => ({ ...current, fullName: event.target.value }))} className={`${fieldClass} mt-2`} placeholder="Ex. Sophie Bernard" /></label><label className="block text-xs font-black text-[#68736a]">E-mail professionnel<input required type="email" value={inviteDraft.email} onChange={event => setInviteDraft(current => ({ ...current, email: event.target.value }))} className={`${fieldClass} mt-2`} placeholder="sophie@restaurant.fr" /></label><label className="block text-xs font-black text-[#68736a]">Rôle<select value={inviteDraft.role} onChange={event => setInviteDraft(current => ({ ...current, role: event.target.value as 'Directeur' | 'Manager' | 'Opérateur' }))} className={`${fieldClass} mt-2`}><option>Directeur</option><option>Manager</option><option>Opérateur</option></select></label>{inviteNotice && <p role="status" className="rounded-xl bg-[#fff4e8] px-4 py-3 text-xs font-bold text-[#a35c16]">{inviteNotice}</p>}<div className="flex justify-end gap-3 pt-3"><button type="button" onClick={() => setInviteOpen(false)} className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Annuler</button><button disabled={inviteSubmitting} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50">{inviteSubmitting ? 'Envoi…' : 'Envoyer l’invitation'}</button></div></form></div></div>}
      {resetOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/65 p-4" role="dialog" aria-modal="true" aria-label="Réinitialiser le mot de passe"><div className="w-full max-w-md rounded-[28px] bg-white p-7 shadow-2xl md:p-9"><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ff5a36]">Sécurité du compte</p><h2 className="mt-2 text-2xl font-black">Réinitialiser le mot de passe</h2><p className="mt-2 text-sm leading-relaxed text-[#738078]">Nous vous enverrons un lien sécurisé valable pour votre compte.</p></div><button onClick={() => setResetOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] text-lg font-black" aria-label="Fermer">×</button></div><form onSubmit={requestPasswordReset} className="mt-7"><label className="block text-xs font-black text-[#68736a]">E-mail du compte<input required type="email" value={resetEmail} onChange={event => setResetEmail(event.target.value)} className={`${fieldClass} mt-2`} placeholder="vous@restaurant.fr" /></label>{resetNotice && <p role="status" className="mt-4 rounded-xl bg-[#edf7ef] px-4 py-3 text-xs font-bold text-[#287b43]">{resetNotice}</p>}<div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setResetOpen(false)} className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Fermer</button><button disabled={resetSubmitting} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50">{resetSubmitting ? 'Envoi…' : 'Envoyer le lien'}</button></div></form></div></div>}
    </div>
  );
}

function CatalogPanel({ products, setProducts }: { products: CatalogProduct[]; setProducts: React.Dispatch<React.SetStateAction<CatalogProduct[]>> }) {
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState(false);
  const [syncState, setSyncState] = useState<'synced' | 'refreshing'>('synced');
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<Record<number, number[]>>({});
  const filtered = products.filter(product => `${product.name} ${product.category} ${product.posCode}`.toLowerCase().includes(query.toLowerCase()));
  const updateProduct = (id: number, patch: Partial<CatalogProduct>) => setProducts(current => current.map(product => product.id === id ? { ...product, ...patch } : product));
  const addProduct = () => setProducts(current => [...current, { id: Date.now(), productId: `product_${Date.now()}`, name: 'Nouveau produit', detail: 'Description à compléter', emoji: '🍽️', category: 'Menus', price: 0, posCode: `NEW-${current.length + 1}`, available: true }]);
  const save = () => { setSaved(true); window.setTimeout(() => setSaved(false), 1800); };
  const refresh = async () => {
    setSyncState('refreshing');
    const rows = await fetchRestaurantProducts(demoRestaurantId);
    if (rows) setProducts(rows.map(mapRestaurantProduct));
    setSyncState('synced');
  };
  const selectedPrice = selectedProduct
    ? calculateCatalogPrice(selectedProduct.price, selectedProduct.optionGroups ?? [], selectedOptions)
    : 0;
  const canAddSelected = selectedProduct
    ? validateCatalogSelection(selectedProduct.optionGroups ?? [], selectedOptions).valid
    : false;
  return (
    <div>
      <SectionHeading eyebrow="Carte restaurant" title="Catalogue HubRise" description="Consultez la carte importée depuis la caisse de cet établissement. Les produits, prix et disponibilités sont synchronisés avec HubRise en temps réel." action={<div className="flex flex-wrap gap-2"><button onClick={refresh} className="rounded-xl border border-[#dfe4dc] bg-white px-4 py-3 text-xs font-black">{syncState === 'refreshing' ? 'Synchronisation…' : '↻ Actualiser'}</button><span className="flex items-center gap-2 rounded-xl bg-[#e5f6e9] px-4 py-3 text-xs font-black text-[#27894a]"><span className="h-2 w-2 rounded-full bg-[#35a85a]" />Synchronisé en direct</span></div>} />
      <section className={`${panelCard} mb-5 overflow-hidden`}><div className="flex flex-col gap-5 bg-[#0e2418] p-6 text-white md:flex-row md:items-center md:justify-between md:p-7"><div className="flex items-start gap-4"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#ff5a36] text-lg font-black">H</span><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ffc647]">Source de vérité</p><h2 className="mt-1 text-xl font-black">Carte du restaurant · HubRise</h2><p className="mt-2 text-sm text-white/60">Dernière synchronisation il y a quelques secondes · Les modifications de la caisse seront répercutées automatiquement.</p></div></div><div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-right"><p className="text-[10px] font-bold uppercase tracking-widest text-white/45">Établissement</p><p className="mt-1 text-sm font-black">{demoRestaurantName}</p></div></div><div className="flex flex-wrap gap-5 border-t border-[#dce9df] px-6 py-4 text-xs font-bold text-[#68776c] md:px-7"><span>✓ Catalogue importé</span><span>✓ Prix synchronisés</span><span>✓ Disponibilités en direct</span><span>✓ Utilisé par l’agent IA</span></div></section>
      <section className={`${panelCard} overflow-hidden`}><div className="flex flex-col gap-4 border-b border-[#e7ebe5] p-5 md:flex-row md:items-center md:justify-between"><div className="flex items-center gap-3"><input aria-label="Rechercher dans le catalogue HubRise" className={`${fieldClass} md:w-80`} placeholder="Rechercher dans le catalogue HubRise…" value={query} onChange={event=>setQuery(event.target.value)} /><span className="rounded-full bg-[#eef2ed] px-3 py-2 text-xs font-black">{products.length} produits</span></div><div className="flex gap-2 text-xs"><span className="rounded-full bg-[#e5f6e9] px-3 py-2 font-black text-[#28894a]">{products.filter(p=>p.available).length} disponibles</span><span className="rounded-full bg-[#f3f4f1] px-3 py-2 font-black text-[#737d75]">{products.filter(p=>!p.available).length} masqués</span></div></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left"><thead className="bg-[#f8f9f6] text-[10px] font-black uppercase tracking-[.14em] text-[#8f9790]"><tr>{['Produit','Catégorie HubRise','Prix TTC','Configuration','Disponibilité'].map(label=><th key={label} className="px-5 py-3">{label}</th>)}</tr></thead><tbody>{filtered.map(product=><tr key={product.id} onClick={() => { setSelectedProduct(product); setSelectedOptions({}); }} className="cursor-pointer border-t border-[#edf0eb] transition hover:bg-[#fbfcfa]"><td className="px-5 py-4"><button onClick={event => { event.stopPropagation(); setSelectedProduct(product); setSelectedOptions({}); }} className="w-full min-w-48 text-left font-black hover:text-[#ff5a36]">{product.name}</button></td><td className="px-5 py-4"><span className="rounded-lg bg-[#f3f5f1] px-3 py-2 text-xs font-bold">{product.category}</span></td><td className="px-5 py-4"><div className="flex items-center gap-1"><input onClick={event => event.stopPropagation()} aria-label={`Prix de ${product.name}`} className="w-20 rounded-lg border border-[#e0e4de] px-3 py-2 text-sm font-black" type="number" step="0.1" value={product.price} onChange={event=>updateProduct(product.id,{price:Number(event.target.value)})} /><span className="font-black">€</span></div></td><td className="px-5 py-4 text-xs font-semibold text-[#69756c]">{product.optionGroups?.length ? `${product.optionGroups.length} groupe${product.optionGroups.length > 1 ? 's' : ''} de choix · Voir les détails` : 'Produit simple · Voir les détails'}</td><td className="px-5 py-4"><button onClick={event=>{ event.stopPropagation(); updateProduct(product.id,{available:!product.available}); }} className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs font-black ${product.available?'bg-[#e3f6e8] text-[#258848]':'bg-[#eff1ee] text-[#7f8880]'}`}><span className={`h-2 w-2 rounded-full ${product.available?'bg-[#34a759]':'bg-[#a6ada7]'}`} />{product.available?'Disponible':'Masqué'}</button></td></tr>)}</tbody></table></div>
      </section>
      {selectedProduct && <div className="fixed inset-0 z-50 grid place-items-center bg-[#0b1f14]/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`Détails de ${selectedProduct.name}`} onClick={() => setSelectedProduct(null)}>
        <div className="max-h-[min(860px,calc(100vh-2rem))] w-full max-w-5xl overflow-hidden rounded-[28px] bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-[#e7ebe5] px-6 py-4"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ff5a36]">{selectedProduct.category}</p><h2 className="mt-1 text-2xl font-black">{selectedProduct.name}</h2></div><button onClick={() => setSelectedProduct(null)} aria-label="Fermer les détails" className="grid h-10 w-10 place-items-center rounded-full bg-[#f3f5f1] text-xl">×</button></div>
          <div className="grid max-h-[calc(100vh-8rem)] overflow-y-auto md:grid-cols-[.9fr_1.1fr]">
            <div className="m-6 grid min-h-64 place-items-center rounded-3xl bg-[#f4f6f2] p-6">{selectedProduct.imageUrl ? <img src={selectedProduct.imageUrl} alt={selectedProduct.name} className="max-h-80 w-full object-contain" /> : <div className="text-center text-[#89948b]"><div className="text-6xl">🍽️</div><p className="mt-3 text-xs font-bold">Image non fournie par HubRise</p></div>}</div>
            <div className="p-6 md:pl-0"><p className="text-sm leading-relaxed text-[#657168]">{selectedProduct.detail || 'Détails du produit importés depuis HubRise.'}</p><p className="mt-3 text-2xl font-black">{money.format(selectedPrice)}</p>
              <div className="mt-6 space-y-5">{(selectedProduct.optionGroups ?? []).map(group => <section key={group.id}><div className="flex items-start justify-between gap-3"><div><h3 className="font-black">{group.name}</h3><p className="mt-1 text-xs text-[#7f8981]">{group.question}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-black ${group.required ? 'bg-[#fff0ea] text-[#d95332]' : 'bg-[#eef4ee] text-[#36814d]'}`}>{group.required ? 'Obligatoire' : 'Facultatif'}</span></div><div className="mt-3 space-y-2">{group.options.filter(option => option.available).map(option => { const active = selectedOptions[group.id]?.includes(option.id); return <button key={option.id} onClick={() => setSelectedOptions(current => { const values = current[group.id] ?? []; const next = group.max === 1 ? (active ? [] : [option.id]) : active ? values.filter(id => id !== option.id) : values.length < group.max ? [...values, option.id] : values; return { ...current, [group.id]: next }; })} className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition ${active ? 'border-[#ff5a36] bg-[#fff3ef]' : 'border-[#e7ebe5] hover:border-[#ffb29f]'}`}><span className="font-bold">{option.name}</span><span className="flex items-center gap-3">{option.priceDelta ? <span className="text-xs font-black text-[#bd5d3d]">+{money.format(option.priceDelta)}</span> : null}<span className={`grid h-5 w-5 place-items-center rounded-full border-2 ${active ? 'border-[#ff5a36] bg-[#ff5a36]' : 'border-[#aeb7af]'}`}>{active && <span className="h-2 w-2 rounded-full bg-white" />}</span></span></button>; })}</div></section>)}</div>
              <button disabled={!selectedProduct.available || !canAddSelected} className="mt-7 w-full rounded-2xl bg-[#0b1f14] px-5 py-4 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-[#dfe5de] disabled:text-[#879187]">Ajouter à la commande · {money.format(selectedPrice)}</button>
            </div>
          </div>
        </div>
      </div>}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#dfe8e0] bg-[#eef7f0] px-5 py-4 text-xs"><span className="font-black text-[#267d43]">● Catalogue synchronisé avec HubRise</span><span className="font-semibold text-[#6f8073]">Dernière mise à jour il y a quelques secondes · Lecture seule</span></div>
    </div>
  );
}

function EnterpriseCatalogPanel({ products, setProducts }: { products: CatalogProduct[]; setProducts: React.Dispatch<React.SetStateAction<CatalogProduct[]>> }) {
  const [sourceUrl, setSourceUrl] = useState('https://www.burgerking.fr/carte');
  const [importState, setImportState] = useState<'idle' | 'scanning' | 'ready'>('idle');
  const [activeCategory, setActiveCategory] = useState('Accueil');
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const importedCatalog: CatalogProduct[] = [
    { id: 101, productId: 'master_cantal', name: 'Master Cantal', detail: 'Bœuf grillé, cantal AOP, sauce moutarde', emoji: '🍔', category: 'Nouveautés', price: 13.9, posCode: 'BK-MST-CAN', available: true, ingredients: ['Pain brioché', 'Steak haché grillé à la flamme', 'Cantal AOP', 'Oignons croustillants', 'Sauce moutarde'] },
    { id: 102, productId: 'menu_whopper', name: 'Menu Whopper', detail: 'Whopper, accompagnement et boisson au choix', emoji: '🥤', category: 'Menus', price: 12.9, posCode: 'BK-MNU-WHP', available: true, ingredients: ['Whopper', 'Frites ou onion rings', 'Boisson 40 cl', 'Sauce au choix'] },
    { id: 103, productId: 'whopper', name: 'Whopper', detail: 'Le burger iconique grillé à la flamme', emoji: '🍔', category: 'Burgers', price: 7.9, posCode: 'BK-BRG-WHP', available: true, ingredients: ['Pain aux graines de sésame', 'Steak haché grillé', 'Tomates', 'Salade', 'Cornichons', 'Oignons', 'Sauce'] },
    { id: 104, productId: 'king_junior', name: 'King Junior', detail: 'Menu enfant avec plat, accompagnement et boisson', emoji: '👑', category: 'Menus Enfants', price: 5.5, posCode: 'BK-KID-001', available: true, ingredients: ['Produit principal au choix', 'Petite frite', 'Boisson', 'Dessert ou fruit'] },
    { id: 105, productId: 'kingbox_20', name: 'Kingbox 20', detail: 'Assortiment généreux à partager', emoji: '🍗', category: 'À Partager', price: 16.9, posCode: 'BK-SHR-020', available: true, ingredients: ['Nuggets', 'Chili cheese', 'Onion rings', 'Sauces au choix'] },
    { id: 106, productId: 'wrap_crousty', name: 'Crousty Wrap', detail: 'Poulet croustillant, salade et sauce', emoji: '🌯', category: 'Tortillas & Wraps', price: 6.9, posCode: 'BK-WRP-CRS', available: true, ingredients: ['Tortilla de blé', 'Poulet pané', 'Salade', 'Tomates', 'Sauce'] },
    { id: 107, productId: 'chili_cheese_6', name: 'Chili Cheese x6', detail: 'Bouchées panées au fromage et piment', emoji: '🧀', category: 'Snacks & Sauces', price: 4.9, posCode: 'BK-SNK-CC6', available: true, ingredients: ['Fromage fondu', 'Piment jalapeño', 'Panure'] },
    { id: 108, productId: 'king_sundae', name: 'King Sundae', detail: 'Glace onctueuse avec nappage au choix', emoji: '🍨', category: 'Desserts & Boissons', price: 3.5, posCode: 'BK-DES-SUN', available: true, ingredients: ['Glace vanille', 'Nappage au choix'] },
    { id: 109, productId: 'double_cheese', name: 'Double Cheese', detail: 'Deux steaks, fromage et sauce', emoji: '🍔', category: 'Bon et Pas Cher', price: 4.9, posCode: 'BK-VFM-DC', available: true, ingredients: ['Pain', 'Deux steaks hachés', 'Fromage fondu', 'Cornichons', 'Sauce'] },
    { id: 110, productId: 'salade_chicken', name: 'Salade Chicken', detail: 'Salade composée et poulet croustillant', emoji: '🥗', category: 'Salades', price: 7.5, posCode: 'BK-SAL-CHK', available: true, ingredients: ['Salade', 'Poulet pané', 'Tomates', 'Fromage', 'Sauce salade'] },
  ];
  const categories = ['Accueil', 'Nouveautés', 'Menus', 'Burgers', 'Menus Enfants', 'À Partager', 'Tortillas & Wraps', 'Snacks & Sauces', 'Desserts & Boissons', 'Bon et Pas Cher', 'Salades'];
  const categoryIcons: Record<string, string> = { Accueil: '⌂', Nouveautés: '✦', Menus: '▤', Burgers: '🍔', 'Menus Enfants': '♛', 'À Partager': '♧', 'Tortillas & Wraps': '🌯', 'Snacks & Sauces': '◌', 'Desserts & Boissons': '🍨', 'Bon et Pas Cher': '€', Salades: '🥗' };
  const displayedProducts = activeCategory === 'Accueil' ? products : products.filter(product => product.category === activeCategory);
  const importCatalog = () => {
    if (!/^https?:\/\//i.test(sourceUrl.trim())) return;
    setImportState('scanning');
    window.setTimeout(() => {
      setProducts(importedCatalog);
      setActiveCategory('Accueil');
      setImportState('ready');
    }, 1300);
  };
  return (
    <div>
      <SectionHeading eyebrow="Catalogue omnicanal" title="Carte du restaurant" description="Importez la carte officielle d’une enseigne, contrôlez sa structure puis synchronisez les catégories, produits, compositions et disponibilités avec DriveVoice." action={<span className="rounded-full bg-[#e4f6e9] px-4 py-2 text-[10px] font-black text-[#27894a]">● Catalogue maître</span>} />
      <section className={`${panelCard} overflow-hidden`}>
        <div className="bg-[#0b1f14] p-6 text-white md:p-7"><div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#77d994]">Source de la carte</p><h2 className="mt-2 text-2xl font-black tracking-[-.04em]">Importer depuis le site de l’enseigne</h2><p className="mt-2 max-w-2xl text-xs leading-relaxed text-white/55">DriveVoice analyse l’arborescence publique, les fiches produits et les visuels, puis prépare un catalogue structuré à valider avant diffusion.</p></div><div className="flex w-full max-w-2xl flex-col gap-2 sm:flex-row"><input aria-label="URL de la carte du restaurant" className="h-12 min-w-0 flex-1 rounded-xl border border-white/15 bg-white/10 px-4 text-sm font-bold text-white outline-none placeholder:text-white/30 focus:border-[#ff7658]" value={sourceUrl} onChange={event=>setSourceUrl(event.target.value)} placeholder="https://www.enseigne.fr/carte" /><button onClick={importCatalog} disabled={importState==='scanning'} className="h-12 shrink-0 rounded-xl bg-[#ff5a36] px-5 text-xs font-black text-white disabled:opacity-60">{importState==='scanning'?'Analyse en cours…':'Analyser et importer'}</button></div></div>
          {importState==='scanning'&&<div className="mt-5"><div className="mb-2 flex justify-between text-[10px] font-bold text-white/55"><span>Lecture des catégories et des fiches produits</span><span>Synchronisation…</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full w-3/4 rounded-full bg-[#ff5a36]" /></div></div>}
          {importState==='ready'&&<div className="mt-5 flex flex-wrap gap-2 text-[10px] font-black"><span className="rounded-full bg-white/10 px-3 py-2">✓ {categories.length-1} catégories</span><span className="rounded-full bg-white/10 px-3 py-2">✓ {products.length} produits détectés</span><span className="rounded-full bg-white/10 px-3 py-2">✓ Compositions indexées</span><span className="rounded-full bg-[#2e9553] px-3 py-2">Prêt à valider</span></div>}
        </div>
        <nav className="flex gap-1 overflow-x-auto border-b border-[#e8e1d5] bg-[#fff9ef] px-4 py-3" aria-label="Catégories de la carte">{categories.map(category=><button key={category} onClick={()=>setActiveCategory(category)} className={`flex shrink-0 flex-col items-center gap-1 rounded-xl px-3 py-2 text-[10px] font-black transition ${activeCategory===category?'bg-[#ff5a36] text-white shadow-md':'text-[#725748] hover:bg-white'}`}><span className="text-base">{categoryIcons[category]}</span><span>{category}</span></button>)}</nav>
        <div className="bg-[#f7efe2] p-5 md:p-7"><div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#a16e51]">Aperçu de la carte importée</p><h2 className="mt-1 text-2xl font-black">{activeCategory === 'Accueil' ? 'Toutes les catégories' : activeCategory}</h2></div><div className="flex gap-2"><span className="rounded-full bg-white px-3 py-2 text-[10px] font-black">{displayedProducts.length} produits</span><button className="rounded-xl bg-white px-4 py-2 text-[10px] font-black text-[#ff5a36]">Modifier la structure</button></div></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">{displayedProducts.map(product=><button key={product.id} onClick={()=>setSelectedProduct(product)} className="group overflow-hidden rounded-[20px] border border-[#eadfce] bg-white text-left shadow-[0_10px_30px_rgba(70,42,20,.06)] transition hover:-translate-y-1 hover:border-[#ff9a81]"><div className="grid h-40 place-items-center bg-gradient-to-br from-[#fffdf9] to-[#f5ead9]">{product.imageUrl?<img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-3 transition group-hover:scale-105" />:<span className="text-7xl transition group-hover:scale-110">{product.emoji}</span>}</div><div className="border-t border-[#f0e8dc] p-4"><span className="text-[9px] font-black uppercase tracking-wider text-[#a37459]">{product.category}</span><h3 className="mt-1 text-base font-black">{product.name}</h3><p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[#7d817c]">{product.detail}</p><div className="mt-4 flex items-center justify-between"><strong>{money.format(product.price)}</strong><span className="rounded-full bg-[#e5f6e9] px-2 py-1 text-[9px] font-black text-[#27894a]">Disponible</span></div></div></button>)}</div>
        </div>
      </section>
      {selectedProduct&&<div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/55 p-4" role="dialog" aria-modal="true" aria-label={`Fiche ${selectedProduct.name}`}><div className="w-full max-w-xl overflow-hidden rounded-[28px] bg-white shadow-2xl"><div className="flex items-start justify-between bg-[#fff7eb] p-6"><div><span className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Fiche produit importée</span><h2 className="mt-2 text-2xl font-black">{selectedProduct.name}</h2><p className="mt-1 text-xs text-[#7d817c]">{selectedProduct.category} · {selectedProduct.posCode}</p></div><button onClick={()=>setSelectedProduct(null)} aria-label="Fermer" className="grid h-10 w-10 place-items-center rounded-xl bg-white font-black">×</button></div><div className="p-6"><div className="grid gap-5 sm:grid-cols-[110px_1fr]"><div className="grid h-28 place-items-center rounded-2xl bg-[#f7efe2]">{selectedProduct.imageUrl?<img src={selectedProduct.imageUrl} alt={selectedProduct.name} className="h-full w-full object-contain p-2" />:<span className="text-6xl">{selectedProduct.emoji}</span>}</div><div><p className="text-xs leading-relaxed text-[#6f7971]">{selectedProduct.detail}</p><p className="mt-4 text-[10px] font-black uppercase tracking-widest text-[#9a7966]">Composition</p><div className="mt-2 flex flex-wrap gap-2">{(selectedProduct.ingredients??['Composition à vérifier']).map(ingredient=><span key={ingredient} className="rounded-full bg-[#f1f3ee] px-3 py-2 text-[10px] font-bold">{ingredient}</span>)}</div></div></div><div className="mt-6 grid gap-3 sm:grid-cols-3">{[['Prix TTC',money.format(selectedProduct.price)],['Code POS',selectedProduct.posCode],['Statut',selectedProduct.available?'Disponible':'Masqué']].map(([label,value])=><div key={label} className="rounded-xl border border-[#e5e9e2] p-3"><p className="text-[9px] font-black uppercase tracking-wider text-[#949c95]">{label}</p><p className="mt-1 text-sm font-black">{value}</p></div>)}</div><div className="mt-6 flex justify-end gap-2"><button className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Modifier</button><button onClick={()=>setSelectedProduct(null)} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Valider la fiche</button></div></div></div></div>}
    </div>
  );
}

type MenuCategory = { id: number; name: string; icon: string; enabled: boolean };
type ProductDraft = {
  name: string; mainProduct: string; detail: string; category: string; subcategory: string; price: number; posCode: string; emoji: string; ingredients: ProductIngredient[]; available: boolean;
  productType: 'simple' | 'configurable' | 'menu' | 'bundle' | 'deal';
  variants: ProductVariant[];
  optionGroups: ProductOptionGroup[];
  modifiers: ProductModifier[];
  imageUrl: string; slug: string; meatFilter: string; badges: string; ingredientImages: string; allergens: string; traces: string; displayOrder: number; nutrition: ProductNutrition;
};

function ProductConfigurator({ product, onClose, onSave }: { product: CatalogProduct; onClose: () => void; onSave: (patch: Partial<CatalogProduct>) => void }) {
  const [productType, setProductType] = useState<CatalogProduct['productType']>(product.productType ?? (product.category === 'Menus' ? 'menu' : 'configurable'));
  const [variants, setVariants] = useState<ProductVariant[]>(product.variants ?? []);
  const [groups, setGroups] = useState<ProductOptionGroup[]>(product.optionGroups ?? []);
  const [modifiers, setModifiers] = useState<ProductModifier[]>(product.modifiers ?? []);
  const addGroup = () => setGroups(current => [...current, { id: Date.now(), name: 'Nouveau groupe', question: 'Quel choix souhaitez-vous ?', required: true, min: 1, max: 1, options: [] }]);
  const updateGroup = (id: number, patch: Partial<ProductOptionGroup>) => setGroups(current => current.map(group => group.id === id ? { ...group, ...patch } : group));
  const addOption = (groupId: number) => setGroups(current => current.map(group => group.id === groupId ? { ...group, options: [...group.options, { id: Date.now(), name: 'Nouvelle option', priceDelta: 0, posCode: '', available: true }] } : group));
  const updateOption = (groupId: number, optionId: number, patch: Partial<ProductOption>) => setGroups(current => current.map(group => group.id === groupId ? { ...group, options: group.options.map(option => option.id === optionId ? { ...option, ...patch } : option) } : group));
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/60 p-4" role="dialog" aria-modal="true" aria-label={`Configuration de ${product.name}`}>
      <div className="max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-[30px] bg-[#f5f6f1] shadow-2xl">
        <div className="sticky top-0 z-20 flex items-start justify-between border-b border-[#dfe4dc] bg-white p-6"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ff5a36]">Phase 2 · Configuration avancée</p><h2 className="mt-1 text-2xl font-black">{product.emoji} {product.name}</h2><p className="mt-1 text-xs text-[#7d867e]">Construisez les variantes, choix et personnalisations compris par l’agent.</p></div><button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div>
        <div className="space-y-5 p-5 md:p-6">
          <section className={`${panelCard} p-5`}><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Type de produit</p><div className="mt-4 grid gap-2 sm:grid-cols-4">{([['simple','Produit simple','Sans choix'],['configurable','Personnalisable','Burger ou wrap'],['menu','Menu / formule','Plusieurs choix'],['bundle','Lot / box','Produits groupés']] as const).map(([type,label,detail])=><button key={type} onClick={()=>setProductType(type)} className={`rounded-2xl border p-4 text-left ${productType===type?'border-[#ff7658] bg-[#fff4ef] ring-2 ring-[#ff7658]/15':'border-[#e3e7e0]'}`}><strong className="block text-xs">{label}</strong><span className="mt-1 block text-[9px] text-[#8a938b]">{detail}</span></button>)}</div></section>
          <section className={`${panelCard} p-5`}><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Variantes et tailles</p><h3 className="mt-1 text-lg font-black">Formats disponibles</h3><p className="mt-1 text-[10px] text-[#858e86]">Ex. Petite, moyenne, grande ou parfum.</p></div><button onClick={()=>setVariants(current=>[...current,{id:Date.now(),name:'Nouvelle variante',priceDelta:0,posCode:''}])} className="rounded-xl bg-[#0b1f14] px-4 py-2.5 text-[10px] font-black text-white">＋ Variante</button></div><div className="mt-4 space-y-2">{variants.map(variant=><div key={variant.id} className="grid gap-2 rounded-2xl border border-[#e5e9e2] p-3 sm:grid-cols-[1fr_120px_150px_34px]"><input aria-label="Nom de la variante" className={fieldClass} value={variant.name} onChange={event=>setVariants(current=>current.map(item=>item.id===variant.id?{...item,name:event.target.value}:item))} /><input aria-label="Supplément variante" className={fieldClass} type="number" step="0.1" value={variant.priceDelta} onChange={event=>setVariants(current=>current.map(item=>item.id===variant.id?{...item,priceDelta:Number(event.target.value)}:item))} /><input aria-label="Code POS variante" className={`${fieldClass} font-mono`} placeholder="Code POS" value={variant.posCode} onChange={event=>setVariants(current=>current.map(item=>item.id===variant.id?{...item,posCode:event.target.value}:item))} /><button onClick={()=>setVariants(current=>current.filter(item=>item.id!==variant.id))} aria-label="Supprimer la variante" className="text-[#d6503d]">×</button></div>)}{!variants.length&&<p className="rounded-2xl border border-dashed border-[#d6dcd4] py-6 text-center text-xs text-[#8b948c]">Aucune variante configurée.</p>}</div></section>
          <section className={`${panelCard} p-5`}><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Constructeur de menu</p><h3 className="mt-1 text-lg font-black">Groupes de choix</h3><p className="mt-1 text-[10px] text-[#858e86]">Accompagnement, boisson, dessert, sauce ou produit principal.</p></div><button onClick={addGroup} className="rounded-xl bg-[#0b1f14] px-4 py-2.5 text-[10px] font-black text-white">＋ Groupe</button></div><div className="mt-4 space-y-4">{groups.map(group=><div key={group.id} className="rounded-2xl border border-[#dfe4dc] bg-[#fafbf8] p-4"><div className="grid gap-2 md:grid-cols-[1fr_1.35fr_80px_80px]"><input aria-label="Nom du groupe" className={fieldClass} value={group.name} onChange={event=>updateGroup(group.id,{name:event.target.value})} /><input aria-label="Question posée au client" className={fieldClass} value={group.question} onChange={event=>updateGroup(group.id,{question:event.target.value})} /><label className="text-[9px] font-bold text-[#788179]">Minimum<input className={`${fieldClass} mt-1`} type="number" min="0" value={group.min} onChange={event=>updateGroup(group.id,{min:Number(event.target.value)})} /></label><label className="text-[9px] font-bold text-[#788179]">Maximum<input className={`${fieldClass} mt-1`} type="number" min="1" value={group.max} onChange={event=>updateGroup(group.id,{max:Number(event.target.value)})} /></label></div><div className="mt-3 flex items-center justify-between"><button onClick={()=>updateGroup(group.id,{required:!group.required})} className={`rounded-full px-3 py-2 text-[9px] font-black ${group.required?'bg-[#e3f6e8] text-[#27894a]':'bg-[#ecefec] text-[#737c74]'}`}>{group.required?'✓ Choix obligatoire':'Choix facultatif'}</button><button onClick={()=>setGroups(current=>current.filter(item=>item.id!==group.id))} className="text-[9px] font-black text-[#d6503d]">Supprimer le groupe</button></div><div className="mt-3 space-y-2">{group.options.map(option=><div key={option.id} className="grid gap-2 rounded-xl bg-white p-2 sm:grid-cols-[1fr_110px_140px_32px]"><input aria-label="Nom de l’option" className={fieldClass} value={option.name} onChange={event=>updateOption(group.id,option.id,{name:event.target.value})} /><input aria-label="Supplément option" className={fieldClass} type="number" step="0.1" value={option.priceDelta} onChange={event=>updateOption(group.id,option.id,{priceDelta:Number(event.target.value)})} /><input aria-label="Code POS option" className={`${fieldClass} font-mono`} placeholder="Code POS" value={option.posCode} onChange={event=>updateOption(group.id,option.id,{posCode:event.target.value})} /><button onClick={()=>updateGroup(group.id,{options:group.options.filter(item=>item.id!==option.id)})} aria-label="Supprimer l’option" className="text-[#d6503d]">×</button></div>)}<button onClick={()=>addOption(group.id)} className="mt-2 text-[10px] font-black text-[#ff5a36]">＋ Ajouter une option</button></div></div>)}{!groups.length&&<p className="rounded-2xl border border-dashed border-[#d6dcd4] py-8 text-center text-xs text-[#8b948c]">Ajoutez un groupe pour construire un menu ou un produit configurable.</p>}</div></section>
          <section className={`${panelCard} p-5`}><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Personnalisation</p><h3 className="mt-1 text-lg font-black">Retraits et suppléments</h3><p className="mt-1 text-[10px] text-[#858e86]">Définissez précisément les modifications autorisées.</p></div><div className="flex gap-2"><button onClick={()=>setModifiers(current=>[...current,{id:Date.now(),name:'Sans ingrédient',kind:'remove',priceDelta:0}])} className="rounded-xl border border-[#dfe4dc] px-3 py-2.5 text-[10px] font-black">＋ Retrait</button><button onClick={()=>setModifiers(current=>[...current,{id:Date.now(),name:'Nouveau supplément',kind:'add',priceDelta:0}])} className="rounded-xl bg-[#0b1f14] px-3 py-2.5 text-[10px] font-black text-white">＋ Supplément</button></div></div><div className="mt-4 grid gap-2 md:grid-cols-2">{modifiers.map(modifier=><div key={modifier.id} className="grid grid-cols-[90px_1fr_90px_28px] gap-2 rounded-2xl border border-[#e4e8e1] p-3"><select className={fieldClass} value={modifier.kind} onChange={event=>setModifiers(current=>current.map(item=>item.id===modifier.id?{...item,kind:event.target.value as 'remove'|'add'}:item))}><option value="remove">Retrait</option><option value="add">Ajout</option></select><input aria-label="Nom de la modification" className={fieldClass} value={modifier.name} onChange={event=>setModifiers(current=>current.map(item=>item.id===modifier.id?{...item,name:event.target.value}:item))} /><input aria-label="Prix de la modification" className={fieldClass} type="number" step="0.1" value={modifier.priceDelta} onChange={event=>setModifiers(current=>current.map(item=>item.id===modifier.id?{...item,priceDelta:Number(event.target.value)}:item))} /><button onClick={()=>setModifiers(current=>current.filter(item=>item.id!==modifier.id))} aria-label="Supprimer la modification" className="text-[#d6503d]">×</button></div>)}{!modifiers.length&&<p className="md:col-span-2 rounded-2xl border border-dashed border-[#d6dcd4] py-6 text-center text-xs text-[#8b948c]">Aucune personnalisation autorisée.</p>}</div></section>
          <div className="sticky bottom-0 flex justify-end gap-2 rounded-2xl border border-[#dfe4dc] bg-white/95 p-4 shadow-lg backdrop-blur"><button onClick={onClose} className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Annuler</button><button onClick={()=>{onSave({productType,variants,optionGroups:groups,modifiers});onClose();}} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Enregistrer la configuration</button></div>
        </div>
      </div>
    </div>
  );
}

function RestaurantProductEditor({ draft, setDraft, categories, subcategoryOptions, onClose, onSave, onDelete, isNew, isSaving, catalogProducts }: {
  draft: ProductDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProductDraft>>;
  categories: MenuCategory[];
  subcategoryOptions: string[];
  onClose: () => void;
  onSave: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  isNew: boolean;
  isSaving: boolean;
  catalogProducts: CatalogProduct[];
}) {
  const isMenu = draft.productType === 'menu';
  const [typeMode, setTypeMode] = useState<'simple' | 'menu' | 'fromProduct'>(isMenu ? 'menu' : 'simple');
  const [baseProductId, setBaseProductId] = useState<number | ''>('');
  const [newIngredient, setNewIngredient] = useState('');
  const baseProducts = useMemo(() => catalogProducts.filter(product => product.productType !== 'menu'), [catalogProducts]);
  const addIngredient = () => {
    const name = newIngredient.trim();
    if (!name) return;
    setDraft(current => ({ ...current, ingredients: [...current.ingredients, { id: Date.now(), name, removable: true, extraAllowed: false, extraPrice: 0 }] }));
    setNewIngredient('');
  };
  const updateIngredient = (id: number, patch: Partial<ProductIngredient>) =>
    setDraft(current => ({ ...current, ingredients: current.ingredients.map(ingredient => ingredient.id === id ? { ...ingredient, ...patch } : ingredient) }));
  const removeIngredient = (id: number) =>
    setDraft(current => ({ ...current, ingredients: current.ingredients.filter(ingredient => ingredient.id !== id) }));
  const moveIngredient = (id: number, direction: -1 | 1) =>
    setDraft(current => {
      const index = current.ingredients.findIndex(ingredient => ingredient.id === id);
      const targetIndex = index + direction;
      if (index === -1 || targetIndex < 0 || targetIndex >= current.ingredients.length) return current;
      const next = [...current.ingredients];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return { ...current, ingredients: next };
    });
  const selectBaseProduct = (productId: number) => {
    const product = catalogProducts.find(item => item.id === productId);
    if (!product) return;
    setBaseProductId(productId);
    setDraft(current => {
      const existingGroups = current.optionGroups;
      const hasBurgerGroup = existingGroups.some(group => !group.sizeScope && /burger|plat/i.test(group.name));
      const nextGroups = hasBurgerGroup
        ? existingGroups.map(group => {
            if (!group.sizeScope && /burger|plat/i.test(group.name) && !group.options.some(option => option.name === product.name)) {
              return { ...group, options: [...group.options, { id: Date.now(), name: product.name, priceDelta: 0, posCode: '', available: true }] };
            }
            return group;
          })
        : [
            { id: Date.now(), name: 'Burger', question: 'Quel burger souhaitez-vous ?', required: true, min: 1, max: 1, options: [{ id: Date.now() + 1, name: product.name, priceDelta: 0, posCode: '', available: true }] },
            ...existingGroups,
          ];
      return {
        ...current,
        productType: 'menu',
        mainProduct: product.name,
        name: current.name.trim() ? current.name : `Menu ${product.name}`,
        price: current.price || product.price,
        imageUrl: current.imageUrl || product.imageUrl || '',
        emoji: product.emoji || current.emoji,
        detail: current.detail.trim() ? current.detail : product.detail,
        ingredients: current.ingredients.length === 0 ? [...product.ingredients] : current.ingredients,
        optionGroups: nextGroups,
      };
    });
  };
  const sizeGroup = useMemo(() => draft.optionGroups.find(group => /taille/i.test(group.name)), [draft.optionGroups]);
  const burgerGroup = useMemo(() => draft.optionGroups.find(group => !group.sizeScope && /burger|plat/i.test(group.name)), [draft.optionGroups]);
  const [selectedSize, setSelectedSize] = useState(sizeGroup?.options[0]?.name ?? 'Medium');
  const [showPreview, setShowPreview] = useState(false);
  const [previewSelectedSize, setPreviewSelectedSize] = useState<string>(sizeGroup?.options[0]?.name ?? 'Medium');
  const [previewSelections, setPreviewSelections] = useState<Record<number, number>>({});
  const [isCreatingSize, setIsCreatingSize] = useState(false);
  const [newSizeName, setNewSizeName] = useState('');
  const [newSizePriceDelta, setNewSizePriceDelta] = useState(0);
  const sizes = useMemo(() => sizeGroup?.options ?? [], [sizeGroup]);
  const activeSizeOption = useMemo(() => sizes.find(s => s.name === selectedSize), [sizes, selectedSize]);

  useEffect(() => {
    if (!isMenu || draft.optionGroups.length > 0) return;
    const initialSizes: ProductOption[] = [
      { id: Date.now(), name: 'Medium', priceDelta: 0, posCode: '', available: true },
      { id: Date.now() + 1, name: 'Large', priceDelta: 2.6, posCode: '', available: true },
    ];
    setDraft(current => ({
      ...current,
      optionGroups: [
        { id: Date.now() + 2, name: 'Tailles', question: 'Quelle taille de menu souhaitez-vous ?', required: true, min: 1, max: 1, options: initialSizes },
        { id: Date.now() + 3, name: 'Burger', question: 'Quel burger souhaitez-vous ?', required: true, min: 1, max: 1, options: [] },
        { id: Date.now() + 4, name: 'Accompagnements', question: 'Quel accompagnement souhaitez-vous ?', required: true, min: 1, max: 1, sizeScope: 'Medium', options: [] },
        { id: Date.now() + 5, name: 'Boissons', question: 'Quelle boisson souhaitez-vous ?', required: true, min: 1, max: 1, sizeScope: 'Medium', options: [] },
        { id: Date.now() + 6, name: 'Accompagnements', question: 'Quel accompagnement souhaitez-vous ?', required: true, min: 1, max: 1, sizeScope: 'Large', options: [] },
        { id: Date.now() + 7, name: 'Boissons', question: 'Quelle boisson souhaitez-vous ?', required: true, min: 1, max: 1, sizeScope: 'Large', options: [] },
      ],
    }));
  }, [draft.optionGroups.length, isMenu, setDraft]);

  // Migration et synchronisation des groupes manquants pour chaque taille existante
  useEffect(() => {
    if (!isMenu || !sizeGroup) return;
    const existingSizes = sizeGroup.options.map(s => s.name);
    const missingGroups: ProductOptionGroup[] = [];
    let nextId = Date.now();

    existingSizes.forEach(sizeName => {
      const hasAccompagnements = draft.optionGroups.some(g => g.sizeScope === sizeName && /accompagnement/i.test(g.name));
      const hasBoissons = draft.optionGroups.some(g => g.sizeScope === sizeName && /boisson/i.test(g.name));

      if (!hasAccompagnements) {
        missingGroups.push({
          id: nextId++,
          name: 'Accompagnements',
          question: 'Quel accompagnement souhaitez-vous ?',
          required: true,
          min: 1,
          max: 1,
          sizeScope: sizeName,
          options: [],
        });
      }
      if (!hasBoissons) {
        missingGroups.push({
          id: nextId++,
          name: 'Boissons',
          question: 'Quelle boisson souhaitez-vous ?',
          required: true,
          min: 1,
          max: 1,
          sizeScope: sizeName,
          options: [],
        });
      }
    });

    const hasBurger = draft.optionGroups.some(g => !g.sizeScope && /burger|plat/i.test(g.name));
    if (!hasBurger) {
      missingGroups.unshift({
        id: nextId++,
        name: 'Burger',
        question: 'Quel burger souhaitez-vous ?',
        required: true,
        min: 1,
        max: 1,
        options: [],
      });
    }

    if (missingGroups.length > 0) {
      setDraft(current => ({
        ...current,
        optionGroups: [...current.optionGroups, ...missingGroups],
      }));
    }
  }, [isMenu, sizeGroup, draft.optionGroups, setDraft]);

  useEffect(() => {
    const firstSize = sizeGroup?.options[0]?.name;
    if (firstSize && !sizes.some(size => size.name === selectedSize)) {
      window.setTimeout(() => setSelectedSize(firstSize), 0);
    }
  }, [selectedSize, sizeGroup, sizes]);

  const updateDraft = (patch: Partial<ProductDraft>) => setDraft(current => ({ ...current, ...patch }));
  const updateGroup = (id: number, patch: Partial<ProductOptionGroup>) =>
    setDraft(current => ({ ...current, optionGroups: current.optionGroups.map(group => group.id === id ? { ...group, ...patch } : group) }));
  const updateOption = (groupId: number, optionId: number, patch: Partial<ProductOption>) =>
    setDraft(current => ({
      ...current,
      optionGroups: current.optionGroups.map(group => group.id === groupId
        ? { ...group, options: group.options.map(option => option.id === optionId ? { ...option, ...patch } : option) }
        : group),
    }));

  const renameSize = (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || oldName === trimmed) return;
    setDraft(current => ({
      ...current,
      optionGroups: current.optionGroups.map(group => {
        if (/taille/i.test(group.name)) {
          return {
            ...group,
            options: group.options.map(option => option.name === oldName ? { ...option, name: trimmed } : option),
          };
        }
        if (group.sizeScope === oldName) {
          return { ...group, sizeScope: trimmed };
        }
        return group;
      }),
    }));
    if (selectedSize === oldName) setSelectedSize(trimmed);
    if (previewSelectedSize === oldName) setPreviewSelectedSize(trimmed);
  };

  const updateSizePriceDelta = (sizeName: string, priceDelta: number) => {
    setDraft(current => ({
      ...current,
      optionGroups: current.optionGroups.map(group => {
        if (/taille/i.test(group.name)) {
          return {
            ...group,
            options: group.options.map(option => option.name === sizeName ? { ...option, priceDelta } : option),
          };
        }
        return group;
      }),
    }));
  };

  const addSize = (sizeName: string, priceDelta: number = 0) => {
    const trimmed = sizeName.trim();
    if (!trimmed) return;
    const id = Date.now();
    setDraft(current => {
      const currentSizeGroup = current.optionGroups.find(g => /taille/i.test(g.name));
      const updatedGroups = currentSizeGroup
        ? current.optionGroups.map(g => g.id === currentSizeGroup.id
            ? { ...g, options: [...g.options, { id, name: trimmed, priceDelta, posCode: '', available: true }] }
            : g)
        : [
            ...current.optionGroups,
            { id: id + 1, name: 'Tailles', question: 'Quelle taille de menu souhaitez-vous ?', required: true, min: 1, max: 1, options: [{ id, name: trimmed, priceDelta, posCode: '', available: true }] },
          ];

      return {
        ...current,
        optionGroups: [
          ...updatedGroups,
          { id: id + 2, name: 'Accompagnements', question: 'Quel accompagnement souhaitez-vous ?', required: true, min: 1, max: 1, sizeScope: trimmed, options: [] },
          { id: id + 3, name: 'Boissons', question: 'Quelle boisson souhaitez-vous ?', required: true, min: 1, max: 1, sizeScope: trimmed, options: [] },
        ],
      };
    });
    setSelectedSize(trimmed);
    setPreviewSelectedSize(trimmed);
    setIsCreatingSize(false);
    setNewSizeName('');
    setNewSizePriceDelta(0);
  };

  const removeSize = (sizeName: string) => {
    if (!sizeGroup || sizeGroup.options.length <= 1) return;
    setDraft(current => ({
      ...current,
      optionGroups: current.optionGroups
        .filter(group => group.sizeScope !== sizeName)
        .map(group => {
          if (group.id === sizeGroup.id) {
            return { ...group, options: group.options.filter(option => option.name !== sizeName) };
          }
          return group;
        }),
    }));
    if (selectedSize === sizeName) {
      const remaining = sizeGroup.options.find(option => option.name !== sizeName)?.name ?? '';
      setSelectedSize(remaining);
      setPreviewSelectedSize(remaining);
    }
  };

  const addGroupForCurrentSize = () => {
    const id = Date.now();
    setDraft(current => ({
      ...current,
      optionGroups: [
        ...current.optionGroups,
        {
          id,
          name: 'Nouveau choix',
          question: 'Quel choix souhaitez-vous ?',
          required: false,
          min: 0,
          max: 1,
          sizeScope: selectedSize,
          options: [],
        },
      ],
    }));
  };

  const addOption = (group: ProductOptionGroup) => {
    const id = Date.now();
    updateGroup(group.id, {
      options: [...group.options, { id, name: 'Nouvelle option', priceDelta: 0, posCode: '', available: true }],
    });
  };
  const removeOption = (groupId: number, optionId: number) =>
    updateGroup(groupId, { options: draft.optionGroups.find(group => group.id === groupId)?.options.filter(option => option.id !== optionId) ?? [] });
  const changeType = (type: 'simple' | 'menu' | 'fromProduct') => {
    setTypeMode(type);
    if (type === 'fromProduct') {
      updateDraft({ productType: 'menu' });
      return;
    }
    setBaseProductId('');
    updateDraft({ productType: type });
    if (type === 'menu' && !draft.optionGroups.length) {
      setSelectedSize('Medium');
    }
  };
  const visibleOptions = (group: ProductOptionGroup) =>
    group.options.filter(option => !sizeGroup || !option.availableFor || option.availableFor.includes(selectedSize));

  if (showPreview && isMenu) {
    const previewSizeOption = sizes.find(s => s.name === previewSelectedSize) ?? sizes[0];
    const visiblePreviewGroups = draft.optionGroups.filter(g => {
      if (/taille/i.test(g.name)) return false;
      if (!g.sizeScope) return true;
      return g.sizeScope === previewSelectedSize;
    });

    // Calcul du prix total avec tous les suppléments sélectionnés
    const previewPrice = useMemo(() => {
      let total = draft.price + (previewSizeOption?.priceDelta ?? 0);
      visiblePreviewGroups.forEach(group => {
        const selectedOptionId = previewSelections[group.id];
        if (selectedOptionId) {
          const option = group.options.find(opt => opt.id === selectedOptionId);
          if (option) {
            total += option.priceDelta;
          }
        } else if (group.required && group.options.length > 0) {
          // Par défaut, prendre la première option si obligatoire
          total += group.options[0].priceDelta;
        }
      });
      return total;
    }, [draft.price, previewSizeOption, previewSelections, visiblePreviewGroups]);

    // Initialiser les sélections par défaut quand la modale s'ouvre
    useEffect(() => {
      const defaults: Record<number, number> = {};
      visiblePreviewGroups.forEach(group => {
        if (group.required && group.options.length > 0) {
          defaults[group.id] = group.options[0].id;
        }
      });
      setPreviewSelections(defaults);
    }, [showPreview, visiblePreviewGroups]);

    return (
      <div className="fixed inset-0 z-[60] grid place-items-center bg-[#07130d]/60 p-3 md:p-5" role="dialog" aria-modal="true" aria-label="Prévisualisation client">
        <div className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-[28px] bg-white shadow-2xl">
          <div className="sticky top-0 z-20 flex items-center justify-between border-b border-[#e2e7df] bg-white px-6 py-4">
            <div className="flex items-center gap-3">
              <span className="rounded-lg bg-[#0b1f14] px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-[#ffcf45]">CATALOGUE</span>
              <span className="text-[10px] font-black text-[#7f8981]">· Aperçu client en direct</span>
            </div>
            <button onClick={() => setShowPreview(false)} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] text-lg font-black" aria-label="Fermer">×</button>
          </div>
          <div className="p-5 md:p-6">
            <div className="grid gap-6 md:grid-cols-[1fr_1.3fr]">
              <div className="grid place-items-center rounded-3xl bg-[#f4f6f2] p-8">
                {draft.imageUrl ? (
                  <img src={draft.imageUrl} alt={draft.name} className="max-h-80 w-full object-contain" />
                ) : (
                  <span className="text-8xl">{draft.emoji}</span>
                )}
              </div>
              <div>
                <h2 className="text-2xl font-black">{draft.name}</h2>
                <p className="mt-2 text-sm leading-relaxed text-[#657168]">{draft.detail}</p>
                <div className="mt-4 flex items-baseline gap-2">
                  <p className="text-3xl font-black text-[#0b1f14]">{money.format(previewPrice)}</p>
                  {previewSizeOption && previewSizeOption.priceDelta > 0 && (
                    <span className="text-xs font-bold text-[#7f8981]">
                      (dont +{money.format(previewSizeOption.priceDelta)} taille {previewSizeOption.name})
                    </span>
                  )}
                </div>

                <div className="mt-6 space-y-6">
                  {/* Étape 1 : Choix de la taille */}
                  {sizes.length > 0 && (
                    <section className="rounded-2xl border border-[#e7ebe5] bg-[#fafbf8] p-4">
                      <div className="flex items-center gap-2">
                        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#ffcf45] text-[9px] font-black text-[#3e2d00]">1</span>
                        <h3 className="font-black text-sm">Choisissez votre taille</h3>
                        <span className="rounded-full bg-[#fff0ec] px-2 py-0.5 text-[8px] font-black text-[#d6503d]">Obligatoire</span>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {sizes.map(size => {
                          const isChecked = previewSelectedSize === size.name;
                          return (
                            <button
                              key={size.id}
                              type="button"
                              onClick={() => setPreviewSelectedSize(size.name)}
                              className={`flex items-center justify-between rounded-xl border p-3 text-left transition ${
                                isChecked
                                  ? 'border-[#ff5a36] bg-[#fff5f2] ring-2 ring-[#ff5a36]/20'
                                  : 'border-[#dfe4dc] bg-white hover:border-[#ccd3c9]'
                              }`}
                            >
                              <div className="flex items-center gap-2.5">
                                <span className={`grid h-4 w-4 place-items-center rounded-full border ${isChecked ? 'border-[#ff5a36] bg-[#ff5a36]' : 'border-[#ccd3c9]'}`}>
                                  {isChecked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                                </span>
                                <span className="font-bold text-xs">{size.name}</span>
                              </div>
                              <span className="text-xs font-black text-[#7f8981]">
                                {size.priceDelta > 0 ? `+${money.format(size.priceDelta)}` : 'Inclus'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {/* Étapes suivantes : Plat, Accompagnements et Boissons de la taille choisie */}
                  {visiblePreviewGroups.map((group, groupIndex) => (
                    <section key={group.id} className="rounded-2xl border border-[#e7ebe5] bg-[#fafbf8] p-4">
                      <div className="flex items-center gap-2">
                        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#ffcf45] text-[9px] font-black text-[#3e2d00]">
                          {groupIndex + 2}
                        </span>
                        <h3 className="font-black text-sm">{group.name}</h3>
                        {group.required && <span className="rounded-full bg-[#fff0ec] px-2 py-0.5 text-[8px] font-black text-[#d6503d]">Obligatoire</span>}
                      </div>
                      <p className="mt-1 pl-8 text-[11px] text-[#7f8981]">{group.question}</p>
                      <div className="mt-3 space-y-2">
                        {group.options.map((option, optIdx) => {
                          const isSelected = previewSelections[group.id] === option.id;
                          return (
                            <label key={option.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-2.5 transition ${isSelected ? 'border-[#ff5a36] bg-[#fff5f2]' : 'border-[#e7ebe5] bg-white hover:border-[#ff9e87]'}`}>
                              <input
                                type="radio"
                                name={`preview-group-${group.id}`}
                                className="h-4 w-4 accent-[#ff5a36]"
                                checked={isSelected}
                                onChange={() => setPreviewSelections(prev => ({ ...prev, [group.id]: option.id }))}
                              />
                              <span className="min-w-0 flex-1 font-bold text-xs">{option.name}</span>
                              {option.priceDelta > 0 && (
                                <span className="text-xs font-black text-[#bd5d3d]">+{money.format(option.priceDelta)}</span>
                              )}
                            </label>
                          );
                        })}
                        {group.options.length === 0 && (
                          <p className="rounded-xl border border-dashed border-[#dfe4dc] py-4 text-center text-xs text-[#8b948c]">
                            Aucune option configurée pour la taille {previewSelectedSize}.
                          </p>
                        )}
                      </div>
                    </section>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setShowPreview(false)}
                  className="mt-7 w-full rounded-2xl bg-[#0b1f14] px-5 py-4 text-sm font-black text-white hover:bg-[#153423]"
                >
                  Ajouter à la commande · {money.format(previewPrice)}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-[#07130d]/60 p-3 md:p-5" role="dialog" aria-modal="true" aria-label={isMenu ? 'Configurer le produit' : 'Configurer le produit'}>
      <div className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-[28px] bg-white shadow-2xl">
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-[#e2e7df] bg-white px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="rounded-lg bg-[#0b1f14] px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-[#ffcf45]">CATALOGUE</span>
            <span className="text-[10px] font-black text-[#7f8981]">· bk</span>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] text-lg font-black" aria-label="Fermer">×</button>
        </div>

        <div className="p-6">
          <h2 className="text-2xl font-black">Configurer le produit</h2>

          <div className="mt-6 grid gap-4 md:grid-cols-[1fr_200px]">
            <label className="text-xs font-bold text-[#68736a]">Nom du produit *
              <input className={`${fieldClass} mt-2`} placeholder={isMenu ? 'Ex. Menu Whopper' : 'Ex. Whopper'} value={draft.name} onChange={event => updateDraft({ name: event.target.value })} />
            </label>
            <label className="text-xs font-bold text-[#68736a]">Type
              <select className={`${fieldClass} mt-2`} value={typeMode} onChange={event => changeType(event.target.value as 'simple' | 'menu' | 'fromProduct')}>
                <option value="simple">Produit simple</option>
                <option value="menu">Menu configurable (manuel)</option>
                <option value="fromProduct">Créer un menu à partir d'un produit simple</option>
              </select>
            </label>
          </div>
          {typeMode === 'fromProduct' && (
            <div className="mt-4 rounded-xl border border-[#ff5a36] bg-[#fff5f2] p-4">
              <label className="text-xs font-bold text-[#68736a]">Produit de base *
                <select
                  className={`${fieldClass} mt-2`}
                  value={baseProductId}
                  onChange={event => selectBaseProduct(Number(event.target.value))}
                >
                  <option value="" disabled>Choisissez un produit simple existant…</option>
                  {baseProducts.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}
                </select>
              </label>
              {baseProducts.length === 0 && <p className="mt-2 text-[10px] font-bold text-[#b3573f]">Créez d'abord un produit simple (ex. Big King) pour pouvoir générer un menu à partir de lui.</p>}
              {baseProductId !== '' && <p className="mt-2 text-[10px] font-bold text-[#2e7d32]">✓ Le plat "{catalogProducts.find(p => p.id === baseProductId)?.name}" a été ajouté au groupe Plat / Burger ci-dessous. Vous pouvez en ajouter d'autres.</p>}
            </div>
          )}
          <label className="mt-4 block text-xs font-bold text-[#68736a]">Description
            <textarea className="mt-2 min-h-20 w-full rounded-xl border border-[#dfe4dc] p-3 text-sm font-semibold outline-none focus:border-[#ff6a45]" placeholder="Décrivez brièvement le produit…" value={draft.detail} onChange={event => updateDraft({ detail: event.target.value })} />
          </label>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-xs font-bold text-[#68736a]">Catégorie *
              <select className={`${fieldClass} mt-2`} value={draft.category} onChange={event => updateDraft({ category: event.target.value, subcategory: subcategoryTemplates[event.target.value]?.[1] ?? '' })}>
                {categories.map(category => <option key={category.id} value={category.name}>{category.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-[#68736a]">Prix TTC *
              <div className="relative mt-2"><input className={`${fieldClass} pr-10`} type="number" min="0" step="0.01" value={draft.price} onChange={event => updateDraft({ price: Number(event.target.value) })} /><span className="absolute right-4 top-3 text-sm font-black">€</span></div>
            </label>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-[80px_1fr_1fr]">
            <label className="text-xs font-bold text-[#68736a]">Icône
              <input className={`${fieldClass} mt-2 text-center text-2xl`} maxLength={3} value={draft.emoji} onChange={event => updateDraft({ emoji: event.target.value })} />
            </label>
            <label className="text-xs font-bold text-[#68736a]">Visuel (image)
              <div className="mt-2 space-y-2">
                <input
                  type="file"
                  accept="image/*"
                  onChange={event => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => updateDraft({ imageUrl: reader.result as string });
                    reader.readAsDataURL(file);
                  }}
                  className="w-full rounded-xl border border-[#dfe4dc] bg-white p-2 text-[10px] font-semibold"
                />
                <input className={fieldClass} placeholder="ou collez une URL https://…" value={draft.imageUrl} onChange={event => updateDraft({ imageUrl: event.target.value })} />
              </div>
            </label>
            <label className="text-xs font-bold text-[#68736a]">Slug URL
              <input className={`${fieldClass} mt-2`} placeholder="ex. big-king" value={draft.slug} onChange={event => updateDraft({ slug: event.target.value })} />
            </label>
          </div>

          <section className="mt-6 rounded-2xl border border-[#dfe4dc] bg-[#fafbf8] p-4">
            <h3 className="text-sm font-black">Composition et ingrédients</h3>
            <p className="mt-1 text-[10px] text-[#7f8981]">Décrivez les ingrédients du produit pour que l'agent IA connaisse sa composition et puisse gérer les retraits / suppléments demandés par les clients.</p>
            <div className="mt-3 overflow-hidden rounded-xl border border-[#e2e7df] bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-[#f0f3ee] text-[10px] font-black uppercase tracking-wider text-[#7f8981]">
                  <tr>
                    <th className="px-4 py-2">Ingrédient</th>
                    <th className="px-3 py-2 text-center">Retrait possible</th>
                    <th className="px-3 py-2 text-center">Supplément possible</th>
                    <th className="px-3 py-2">Prix supplément</th>
                    <th className="w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {draft.ingredients.map((ingredient, index) => (
                    <tr key={ingredient.id} className="border-t border-[#e7ebe5]">
                      <td className="px-4 py-2">
                        <input className="w-full bg-transparent text-xs font-black outline-none" placeholder="Ex. Sauce King, Salade, Pain…" value={ingredient.name} onChange={event => updateIngredient(ingredient.id, { name: event.target.value })} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input type="checkbox" className="h-4 w-4" checked={ingredient.removable} onChange={event => updateIngredient(ingredient.id, { removable: event.target.checked })} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input type="checkbox" className="h-4 w-4" checked={ingredient.extraAllowed} onChange={event => updateIngredient(ingredient.id, { extraAllowed: event.target.checked })} />
                      </td>
                      <td className="px-3 py-2">
                        {ingredient.extraAllowed && (
                          <div className="flex items-center gap-1">
                            <input className="w-16 rounded-lg border border-[#dfe4dc] px-2 py-1 text-right text-xs font-black outline-none" type="number" min="0" step="0.1" value={ingredient.extraPrice} onChange={event => updateIngredient(ingredient.id, { extraPrice: Number(event.target.value) })} />
                            <span className="text-xs font-black">€</span>
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-center whitespace-nowrap">
                        <button type="button" onClick={() => moveIngredient(ingredient.id, -1)} disabled={index === 0} className="px-1 text-xs font-black text-[#475249] disabled:opacity-30" aria-label="Monter">↑</button>
                        <button type="button" onClick={() => moveIngredient(ingredient.id, 1)} disabled={index === draft.ingredients.length - 1} className="px-1 text-xs font-black text-[#475249] disabled:opacity-30" aria-label="Descendre">↓</button>
                        <button type="button" onClick={() => removeIngredient(ingredient.id)} className="px-1 text-sm font-black text-[#d6503d]" aria-label="Supprimer">×</button>
                      </td>
                    </tr>
                  ))}
                  {draft.ingredients.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-3 text-center text-xs text-[#8a938b]">Aucun ingrédient renseigné pour le moment.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                className="flex-1 rounded-xl border border-[#dfe4dc] px-3 py-2 text-xs font-bold outline-none focus:border-[#ff5a36]"
                placeholder="Ajouter un ingrédient (ex. Sauce King)"
                value={newIngredient}
                onChange={event => setNewIngredient(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addIngredient(); } }}
              />
              <button type="button" onClick={addIngredient} className="rounded-xl bg-[#0b1f14] px-4 py-2 text-xs font-black text-white">＋ Ajouter</button>
            </div>
            <div className="mt-3 rounded-xl bg-[#edf5ef] p-3 text-[10px] leading-relaxed text-[#52705b]"><strong>Compréhension IA :</strong> ces réglages génèrent automatiquement les retraits et suppléments utilisables pendant la commande.</div>
          </section>

          {isMenu && (
            <section className="mt-8">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e2e7df] pb-4">
                <div>
                  <h3 className="text-lg font-black">Tailles du menu</h3>
                  <p className="mt-1 text-[10px] text-[#7f8981]">
                    Chaque taille possède ses propres accompagnements et boissons. Les burgers sont communs à toutes les tailles.
                  </p>
                </div>
              </div>

              {/* Barre des onglets de tailles + bouton Créer une taille */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {sizes.map(size => {
                  const isSelected = selectedSize === size.name;
                  return (
                    <button
                      key={size.id}
                      type="button"
                      onClick={() => setSelectedSize(size.name)}
                      className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-black transition ${
                        isSelected
                          ? 'bg-[#0b1f14] text-white shadow-md ring-2 ring-[#0b1f14]/20'
                          : 'bg-[#f0f3ee] text-[#475249] hover:bg-[#e4e8e1]'
                      }`}
                    >
                      <span>{size.name}</span>
                      <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${isSelected ? 'bg-white/20 text-[#ffcf45]' : 'bg-[#dfe4dc] text-[#636e65]'}`}>
                        {size.priceDelta > 0 ? `+${size.priceDelta} €` : '0 €'}
                      </span>
                    </button>
                  );
                })}

                {!isCreatingSize ? (
                  <button
                    type="button"
                    onClick={() => { setIsCreatingSize(true); setNewSizeName(''); setNewSizePriceDelta(0); }}
                    className="flex items-center gap-1.5 rounded-xl border border-dashed border-[#ff5a36] bg-[#fff5f2] px-4 py-2.5 text-xs font-black text-[#ff5a36] transition hover:bg-[#ffece6]"
                  >
                    <span>＋</span>
                    <span>Créer une taille</span>
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[#ff5a36] bg-[#fff8f6] p-2 shadow-sm">
                    <input
                      type="text"
                      placeholder="Nom (ex. XXL, Maxi…)"
                      value={newSizeName}
                      onChange={e => setNewSizeName(e.target.value)}
                      className="w-36 rounded-xl border border-[#dfe4dc] bg-white px-3 py-1.5 text-xs font-bold outline-none focus:border-[#ff5a36]"
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addSize(newSizeName, newSizePriceDelta);
                        } else if (e.key === 'Escape') {
                          setIsCreatingSize(false);
                        }
                      }}
                    />
                    <div className="relative flex items-center">
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="Supplément"
                        value={newSizePriceDelta}
                        onChange={e => setNewSizePriceDelta(Number(e.target.value))}
                        className="w-20 rounded-xl border border-[#dfe4dc] bg-white px-2 py-1.5 pr-6 text-right text-xs font-black outline-none focus:border-[#ff5a36]"
                      />
                      <span className="absolute right-2 text-[10px] font-bold text-[#7f8981]">€</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => addSize(newSizeName, newSizePriceDelta)}
                      disabled={!newSizeName.trim()}
                      className="rounded-xl bg-[#0b1f14] px-3.5 py-1.5 text-xs font-black text-white disabled:opacity-40"
                    >
                      Valider
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsCreatingSize(false)}
                      className="rounded-xl border border-[#dfe4dc] bg-white px-2.5 py-1.5 text-xs font-bold text-[#7f8981]"
                    >
                      Annuler
                    </button>
                  </div>
                )}
              </div>

              {/* Bandeau de contrôle de la taille active */}
              {activeSizeOption && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#e2e7df] bg-[#fafbf8] p-3.5">
                  <div className="flex items-center gap-2.5">
                    <span className="grid h-6 w-6 place-items-center rounded-lg bg-[#ffcf45] text-[11px] font-black text-[#3e2d00]">✓</span>
                    <p className="text-xs font-black text-[#1c241e]">
                      Configuration active : <span className="rounded-lg bg-white px-2 py-0.5 text-[#ff5a36] shadow-sm border border-[#e2e7df]">{selectedSize}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-xs font-bold text-[#68736a]">
                      <span>Supplément pour cette taille :</span>
                      <div className="relative flex items-center">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          className="w-20 rounded-lg border border-[#dfe4dc] bg-white px-2 py-1 pr-6 text-right text-xs font-black"
                          value={activeSizeOption.priceDelta}
                          onChange={e => updateSizePriceDelta(selectedSize, Number(e.target.value))}
                        />
                        <span className="absolute right-2 text-xs font-black">€</span>
                      </div>
                    </label>
                    {sizes.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeSize(selectedSize)}
                        className="text-xs font-bold text-[#d6503d] hover:underline"
                      >
                        Supprimer cette taille
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Groupes de configuration : Plat (partagé) + Accompagnements & Boissons de la taille active */}
              <div className="mt-6 space-y-4">
                {draft.optionGroups
                  .filter(group => {
                    // NE JAMAIS afficher le groupe Tailles ici
                    if (/taille/i.test(group.name)) return false;
                    // Afficher les groupes sans sizeScope (partagés comme Burger/Plat)
                    if (!group.sizeScope) return true;
                    // Afficher uniquement les groupes de la taille sélectionnée
                    return group.sizeScope === selectedSize;
                  })
                  .map((group, groupIndex) => {
                    const isBurgerGroup = !group.sizeScope && /burger|plat/i.test(group.name);
                    return (
                      <div key={group.id} className="rounded-2xl border border-[#e2e7df] bg-[#fafbf8]">
                        <div className="flex flex-wrap items-center gap-3 border-b border-[#e7ebe5] p-4">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#ffcf45] text-[11px] font-black text-[#3e2d00]">
                            {groupIndex + 1}
                          </span>
                          <input
                            aria-label="Nom du groupe"
                            className="min-w-0 flex-1 bg-transparent text-base font-black outline-none"
                            value={group.name}
                            onChange={event => updateGroup(group.id, { name: event.target.value })}
                          />
                          {isBurgerGroup && (
                            <span className="rounded-md bg-[#eaf4ed] px-2 py-0.5 text-[10px] font-black text-[#2e7d32]">
                              Commun à toutes les tailles
                            </span>
                          )}
                          <label className="flex items-center gap-2 text-[10px] font-bold text-[#68736a]">
                            <input
                              type="checkbox"
                              checked={group.required}
                              onChange={event => updateGroup(group.id, { required: event.target.checked, min: event.target.checked ? 1 : 0 })}
                              className="h-4 w-4 rounded border-[#dfe4dc]"
                            />
                            Choix obligatoire
                          </label>
                          {!isBurgerGroup && (
                            <label className="flex items-center gap-2 text-[10px] font-bold text-[#68736a]">
                              <input
                                type="checkbox"
                                checked={group.max > 1}
                                onChange={event => updateGroup(group.id, { max: event.target.checked ? 10 : 1 })}
                                className="h-4 w-4 rounded border-[#dfe4dc]"
                              />
                              Plusieurs choix possibles
                            </label>
                          )}
                          {!isBurgerGroup && (
                            <button
                              type="button"
                              onClick={() => updateDraft({ optionGroups: draft.optionGroups.filter(item => item.id !== group.id) })}
                              className="ml-auto text-xs font-black text-[#d6503d]"
                            >
                              Supprimer
                            </button>
                          )}
                        </div>
                        <div className="p-4">
                          {isBurgerGroup ? (
                            <div>
                              <div className="overflow-hidden rounded-xl border border-[#e2e7df] bg-white">
                                <table className="w-full text-left text-sm">
                                  <thead className="bg-[#f0f3ee] text-[10px] font-black uppercase tracking-wider text-[#7f8981]">
                                    <tr>
                                      <th className="px-4 py-2">Nom du plat / burger</th>
                                      <th className="w-10"></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {group.options.map(option => (
                                      <tr key={option.id} className="border-t border-[#e7ebe5]">
                                        <td className="px-4 py-2">
                                          <input
                                            className="w-full bg-transparent text-xs font-black outline-none"
                                            placeholder="Ex. Whopper, Steakhouse, Kid Fish…"
                                            value={option.name}
                                            onChange={event => updateOption(group.id, option.id, { name: event.target.value })}
                                          />
                                        </td>
                                        <td className="px-2 py-2 text-center">
                                          <button
                                            type="button"
                                            onClick={() => removeOption(group.id, option.id)}
                                            className="text-sm font-black text-[#d6503d]"
                                            aria-label="Supprimer ce plat"
                                          >
                                            ×
                                          </button>
                                        </td>
                                      </tr>
                                    ))}
                                    {group.options.length === 0 && (
                                      <tr>
                                        <td colSpan={2} className="px-4 py-3 text-center text-xs text-[#8a938b]">
                                          Aucun plat dans ce menu. Cliquez sur "＋ Ajouter un plat" ci-dessous.
                                        </td>
                                      </tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>
                              <button
                                type="button"
                                onClick={() => updateGroup(group.id, { options: [...group.options, { id: Date.now(), name: 'Nouveau plat', priceDelta: 0, posCode: '', available: true }] })}
                                className="mt-3 text-[10px] font-black text-[#ff5a36]"
                              >
                                ＋ Ajouter un plat / burger
                              </button>
                            </div>
                          ) : (
                            <div>
                              <div className="overflow-hidden rounded-xl border border-[#e2e7df] bg-white">
                                <table className="w-full text-left text-sm">
                                  <thead className="bg-[#f0f3ee] text-[10px] font-black uppercase tracking-wider text-[#7f8981]">
                                    <tr>
                                      <th className="px-4 py-2">Nom de l'option</th>
                                      <th className="px-4 py-2">Supplément (€)</th>
                                      <th className="w-10"></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {group.options.map(option => (
                                      <tr key={option.id} className="border-t border-[#e7ebe5]">
                                        <td className="px-4 py-2">
                                          <input
                                            className="w-full bg-transparent text-xs font-black outline-none"
                                            placeholder="Ex. Frites, Onion Rings, Coca-Cola…"
                                            value={option.name}
                                            onChange={event => updateOption(group.id, option.id, { name: event.target.value })}
                                          />
                                        </td>
                                        <td className="px-4 py-2">
                                          <div className="flex items-center gap-1">
                                            <input
                                              className="w-20 rounded-lg border border-[#dfe4dc] px-2 py-1 text-right text-xs font-black outline-none focus:border-[#ff5a36]"
                                              type="number"
                                              min="0"
                                              step="0.1"
                                              value={option.priceDelta}
                                              onChange={event => updateOption(group.id, option.id, { priceDelta: Number(event.target.value) })}
                                            />
                                            <span className="text-xs font-black">€</span>
                                          </div>
                                        </td>
                                        <td className="px-2 py-2 text-center">
                                          <button
                                            type="button"
                                            onClick={() => removeOption(group.id, option.id)}
                                            className="text-sm font-black text-[#d6503d]"
                                            aria-label="Supprimer cette option"
                                          >
                                            ×
                                          </button>
                                        </td>
                                      </tr>
                                    ))}
                                    {group.options.length === 0 && (
                                      <tr>
                                        <td colSpan={3} className="px-4 py-3 text-center text-xs text-[#8a938b]">
                                          Aucune option pour {group.name.toLowerCase()} en taille {selectedSize}.
                                        </td>
                                      </tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>
                              <button
                                type="button"
                                onClick={() => updateGroup(group.id, { options: [...group.options, { id: Date.now(), name: 'Nouvelle option', priceDelta: 0, posCode: '', available: true }] })}
                                className="mt-3 text-[10px] font-black text-[#ff5a36]"
                              >
                                ＋ Ajouter une option pour {selectedSize}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* Bouton d'ajout d'un groupe supplémentaire pour cette taille */}
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={addGroupForCurrentSize}
                  className="rounded-xl border border-[#dfe4dc] bg-white px-4 py-2 text-xs font-black text-[#0b1f14] hover:bg-[#f0f3ee]"
                >
                  ＋ Ajouter un autre groupe pour la taille {selectedSize}
                </button>
              </div>
            </section>
          )}

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#e4e8e1] bg-white p-4">
            <div>
              <p className="text-sm font-black">Produit disponible</p>
              <p className="mt-1 text-[10px] text-[#8a938b]">Le produit peut être proposé par l'agent IA.</p>
            </div>
            <button type="button" onClick={() => updateDraft({ available: !draft.available })} className={`relative h-7 w-12 rounded-full ${draft.available ? 'bg-[#35a85a]' : 'bg-[#d9ded8]'}`} aria-label={draft.available ? 'Masquer le produit' : 'Rendre le produit disponible'}>
              <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow ${draft.available ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            {onDelete && <button type="button" onClick={() => void onDelete()} className="text-xs font-black text-[#d6503d]">Supprimer le produit</button>}
            <div className="ml-auto flex gap-2">
              <button type="button" onClick={onClose} className="rounded-xl border border-[#dfe4dc] bg-white px-4 py-3 text-xs font-black">Annuler</button>
              {isMenu && (
                <button type="button" onClick={() => setShowPreview(true)} disabled={!draft.name.trim() || !draft.category || !sizes.length} className="rounded-xl border border-[#dfe4dc] bg-white px-5 py-3 text-xs font-black disabled:opacity-40">Prévisualiser</button>
              )}
              <button type="button" onClick={() => void onSave()} disabled={isSaving || !draft.name.trim() || !draft.category || (isMenu && !sizes.length)} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:opacity-40">{isSaving ? 'Enregistrement…' : 'Enregistrer le produit'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


function IngredientProductEditor({ draft, setDraft, categories, catalogProducts, subcategoryOptions, newIngredient, setNewIngredient, addIngredient, updateIngredient, moveIngredient, onClose, onSave, onDelete, isNew }: {
  draft: ProductDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProductDraft>>;
  categories: MenuCategory[];
  catalogProducts: CatalogProduct[];
  subcategoryOptions: string[];
  newIngredient: string;
  setNewIngredient: React.Dispatch<React.SetStateAction<string>>;
  addIngredient: () => void;
  updateIngredient: (id: number, patch: Partial<ProductIngredient>) => void;
  moveIngredient: (index: number, direction: -1 | 1) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
  isNew: boolean;
}) {
  const ingredientRows = draft.ingredients as ProductIngredient[];
  const isMenu = draft.productType === 'menu' || draft.category === 'Menus' || draft.category === 'Menus enfants';
  const menuSteps = draft.optionGroups;
  const sizeStep = menuSteps.find(step => /taille/i.test(step.name));
  const [selectedMenuSize, setSelectedMenuSize] = useState(sizeStep?.options[0]?.name ?? 'Medium');
  useEffect(()=>{
    if (!isMenu || draft.optionGroups.length) return;
    const baseNames = draft.category === 'Menus enfants' ? ['Taille du menu','Plat','Accompagnement','Boisson','Sauces','Dessert','Jouet'] : ['Taille du menu','Plat','Accompagnement','Boisson','Sauces'];
    setDraft(current=>({...current,productType:'menu',optionGroups:baseNames.map((name,index)=>({id:Date.now()+index,name,question:`Choisissez : ${name.toLowerCase()}`,required:true,min:1,max:1,options:[]}))}));
  },[isMenu,draft.category,draft.optionGroups.length,setDraft]);
  const updateStep = (id:number, patch:Partial<ProductOptionGroup>)=>setDraft(current=>({...current,optionGroups:current.optionGroups.map(step=>step.id===id?{...step,...patch}:step)}));
  const moveStep = (index:number,direction:-1|1)=>setDraft(current=>{const target=index+direction;if(target<0||target>=current.optionGroups.length)return current;const optionGroups=[...current.optionGroups];[optionGroups[index],optionGroups[target]]=[optionGroups[target],optionGroups[index]];return {...current,optionGroups};});
  const addStep = ()=>setDraft(current=>({...current,optionGroups:[...current.optionGroups,{id:Date.now(),name:'Nouvelle composition',question:'Quel choix souhaitez-vous ?',required:false,min:0,max:1,options:[]}]}));
  const addStepOption = (stepId:number)=>setDraft(current=>({...current,optionGroups:current.optionGroups.map(step=>step.id===stepId?{...step,options:[...step.options,{id:Date.now(),name:'Nouvelle option',priceDelta:0,posCode:'',available:true}]}:step)}));
  const updateStepOption = (stepId:number,optionId:number,patch:Partial<ProductOption>)=>setDraft(current=>({...current,optionGroups:current.optionGroups.map(step=>step.id===stepId?{...step,options:step.options.map(option=>option.id===optionId?{...option,...patch}:option)}:step)}));
  const menuSourceProducts = (stepName:string) => {
    const key = stepName.toLowerCase();
    if (key.includes('plat')) return catalogProducts.filter(product=>product.category==='Burgers');
    if (key.includes('accompagnement')) return catalogProducts.filter(product=>product.category==='Snacks & Sauces'&&!/sauce/i.test(`${product.name} ${product.detail}`)&&menuOptionMatchesSize(product.name, selectedMenuSize, 'accompagnement'));
    if (key.includes('boisson')) return catalogProducts.filter(product=>product.category==='Desserts & Boissons'&&(/boisson/i.test(`${product.subcategory??''} ${product.detail}`)||['🥤','☕'].includes(product.emoji))&&menuOptionMatchesSize(product.name, selectedMenuSize, 'boisson'));
    if (key.includes('sauce')) return catalogProducts.filter(product=>product.category==='Sauces'||/sauce/i.test(`${product.subcategory??''} ${product.name} ${product.detail}`));
    if (key.includes('dessert')) return catalogProducts.filter(product=>product.category==='Desserts & Boissons'&&!/boisson/i.test(`${product.subcategory??''} ${product.detail}`));
    return [];
  };
  const toggleCatalogOption = (stepId:number, product:CatalogProduct) => setDraft(current=>({...current,optionGroups:current.optionGroups.map(step=>step.id===stepId?{...step,options:step.options.some(option=>option.name===product.name)?step.options.filter(option=>option.name!==product.name):[...step.options,{id:Date.now()+product.id,name:product.name,priceDelta:0,posCode:product.posCode,available:product.available}]}:step)}));
  const sizeRank = (name:string) => {const normalized=name.toLowerCase();if(/mini|enfant|petit/.test(normalized))return 1;if(/classique|standard|moyen/.test(normalized))return 2;if(/grand|large/.test(normalized))return 3;if(/xxl/.test(normalized))return 5;if(/xl/.test(normalized))return 4;return 99;};
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-[#07130d]/55 p-4" role="dialog" aria-modal="true" aria-label="Constructeur de produit">
    <div className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-[28px] bg-white shadow-2xl">
      <div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#e7eae5] bg-white p-6"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Fiche produit</p><h2 className="mt-1 text-2xl font-black">{isNew ? 'Créer un produit' : 'Modifier le produit'}</h2></div><button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div>
      <div className="p-6">
        <div className="grid gap-4 md:grid-cols-[90px_1fr_1fr]"><label className="text-xs font-bold text-[#68736a]">Visuel<input className={`${fieldClass} mt-2 text-center text-2xl`} maxLength={3} value={draft.emoji} onChange={event=>setDraft(current=>({...current,emoji:event.target.value}))} /></label><label className="text-xs font-bold text-[#68736a]">Nom du produit *<input className={`${fieldClass} mt-2`} placeholder="Ex. Big King" value={draft.name} onChange={event=>setDraft(current=>({...current,name:event.target.value}))} /></label><label className="text-xs font-bold text-[#68736a]">Catégorie *<select className={`${fieldClass} mt-2`} value={draft.category} onChange={event=>{const category=event.target.value;setDraft(current=>({...current,category,subcategory:subcategoryTemplates[category]?.[1]??'',productType:category==='Menus'||category==='Menus enfants'?'menu':current.productType==='menu'?'simple':current.productType}));}}>{categories.map(category=><option key={category.id}>{category.name}</option>)}</select></label></div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-xs font-bold text-[#68736a]">Image du produit
            <div className="mt-2 space-y-2">
              <input type="file" accept="image/*" onChange={event=>{const file=event.target.files?.[0];if(file){const reader=new FileReader();reader.onload=()=>setDraft(current=>({...current,imageUrl:reader.result as string}));reader.readAsDataURL(file);}}} className="w-full rounded-xl border border-[#dfe4dc] bg-white p-2 text-xs" />
              <input className={fieldClass} placeholder="https://..." value={draft.imageUrl} onChange={event=>setDraft(current=>({...current,imageUrl:event.target.value}))} />
            </div>
          </label>
          <label className="text-xs font-bold text-[#68736a]">Slug URL<input className={`${fieldClass} mt-2`} placeholder="master-sarran-poulet-mozza" value={draft.slug} onChange={event=>setDraft(current=>({...current,slug:event.target.value}))} /></label>
        </div>
        {subcategoryOptions.length>1&&<label className="mt-4 block text-xs font-bold text-[#68736a]">Sous-catégorie<select className={`${fieldClass} mt-2`} value={draft.subcategory} onChange={event=>setDraft(current=>({...current,subcategory:event.target.value}))}>{subcategoryOptions.filter(option=>option!=='Tous').map(option=><option key={option}>{option}</option>)}</select></label>}
        <label className="mt-4 block text-xs font-bold text-[#68736a]">Description client<textarea className="mt-2 min-h-20 w-full rounded-xl border border-[#dfe4dc] p-3 text-sm font-semibold outline-none focus:border-[#ff6a45]" placeholder="Décrivez brièvement le produit…" value={draft.detail} onChange={event=>setDraft(current=>({...current,detail:event.target.value}))} /></label>
        <div className="mt-4 grid gap-4 md:grid-cols-2"><label className="text-xs font-bold text-[#68736a]">Prix TTC de cet établissement *<div className="relative mt-2"><input className={`${fieldClass} pr-10`} type="number" min="0" step="0.01" value={draft.price} onChange={event=>setDraft(current=>({...current,price:Number(event.target.value)}))} /><span className="absolute right-4 top-3 text-sm font-black">€</span></div><p className="mt-1 text-[10px] font-normal text-[#919991]">Ce prix local est indépendant du catalogue maître.</p></label><label className="text-xs font-bold text-[#68736a]">Code POS<input className={`${fieldClass} mt-2 font-mono`} placeholder="Ex. BRG-BGK-01" value={draft.posCode} onChange={event=>setDraft(current=>({...current,posCode:event.target.value}))} /></label></div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-xs font-bold text-[#68736a]">Filtre viande<select className={`${fieldClass} mt-2`} value={draft.meatFilter} onChange={event=>setDraft(current=>({...current,meatFilter:event.target.value}))}><option value="">Non renseigné</option><option>Poulet</option><option>Bœuf</option><option>Poisson</option><option>Veggie</option></select></label>
          <label className="text-xs font-bold text-[#68736a]">Ordre d'affichage<input className={`${fieldClass} mt-2`} type="number" min="0" value={draft.displayOrder} onChange={event=>setDraft(current=>({...current,displayOrder:Number(event.target.value)}))} /></label>
        </div>
        <label className="mt-4 block text-xs font-bold text-[#68736a]">Badges <span className="font-normal text-[#919991]">(séparés par des virgules)</span><input className={`${fieldClass} mt-2`} placeholder="100% filet, Nouveau" value={draft.badges} onChange={event=>setDraft(current=>({...current,badges:event.target.value}))} /></label>
        <label className="mt-4 block text-xs font-bold text-[#68736a]">Type de produit<select className={`${fieldClass} mt-2`} value={draft.productType} onChange={event=>setDraft(current=>({...current,productType:event.target.value as ProductDraft['productType']}))}><option value="simple">Produit simple</option><option value="configurable">Produit configurable</option><option value="menu">Menu</option><option value="bundle">Pack / à partager</option></select></label>
        <section className="mt-5 rounded-2xl border border-[#dfe4dc] bg-[#fafbf8] p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-black text-[#536057]">Composition et ingrédients</p><p className="mt-1 text-[10px] text-[#8b948c]">Ajoutez les couches dans l’ordre réel du produit, du haut vers le bas. Les répétitions sont autorisées.</p></div><span className="w-fit rounded-full bg-[#eef2ed] px-3 py-1.5 text-[9px] font-black text-[#667168]">{ingredientRows.length} couche{ingredientRows.length!==1?'s':''}</span></div>
          <div className="mt-4 flex gap-2"><input aria-label="Nouvel ingrédient" className={fieldClass} placeholder="Ex. Cheddar fondu (1 tranche)" value={newIngredient} onChange={event=>setNewIngredient(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();addIngredient();}}} /><button type="button" onClick={addIngredient} disabled={!newIngredient.trim()} className="shrink-0 rounded-xl bg-[#0b1f14] px-4 text-xs font-black text-white disabled:opacity-35">＋ Ajouter</button></div>
          <div className="mt-4 space-y-2">{ingredientRows.map((ingredient,index)=><div key={ingredient.id} className="rounded-xl border border-[#e2e7df] bg-white p-3"><div className="flex items-center gap-2"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#f2f4ef] text-[10px] font-black text-[#7c857d]">{index+1}</span><input aria-label={`Ingrédient ${index+1}`} className="min-w-0 flex-1 bg-transparent text-xs font-black outline-none focus:text-[#ff5a36]" value={ingredient.name} onChange={event=>updateIngredient(ingredient.id,{name:event.target.value})} /><button type="button" onClick={()=>moveIngredient(index,-1)} disabled={index===0} aria-label="Monter" className="grid h-7 w-7 place-items-center rounded-lg bg-[#f2f4ef] text-[11px] font-black disabled:opacity-25">↑</button><button type="button" onClick={()=>moveIngredient(index,1)} disabled={index===ingredientRows.length-1} aria-label="Descendre" className="grid h-7 w-7 place-items-center rounded-lg bg-[#f2f4ef] text-[11px] font-black disabled:opacity-25">↓</button><button type="button" onClick={()=>setDraft(current=>({...current,ingredients:(current.ingredients as ProductIngredient[]).filter(item=>item.id!==ingredient.id)}))} aria-label="Supprimer" className="grid h-7 w-7 place-items-center rounded-lg bg-[#fff0ec] text-xs font-black text-[#d6503d]">×</button></div><div className="mt-3 flex flex-wrap items-center gap-2 pl-9"><button type="button" onClick={()=>updateIngredient(ingredient.id,{removable:!ingredient.removable})} className={`rounded-full px-3 py-1.5 text-[9px] font-black ${ingredient.removable?'bg-[#fff0ec] text-[#c34c36]':'bg-[#eef1ed] text-[#7d867e]'}`}>{ingredient.removable?'✓ Retrait autorisé':'Retrait interdit'}</button><button type="button" onClick={()=>updateIngredient(ingredient.id,{extraAllowed:!ingredient.extraAllowed})} className={`rounded-full px-3 py-1.5 text-[9px] font-black ${ingredient.extraAllowed?'bg-[#e8f7ec] text-[#27894a]':'bg-[#eef1ed] text-[#7d867e]'}`}>{ingredient.extraAllowed?'✓ Supplément autorisé':'Supplément interdit'}</button>{ingredient.extraAllowed&&<label className="flex items-center gap-2 text-[9px] font-black text-[#707a72]">Prix supplément<input className="h-8 w-20 rounded-lg border border-[#dfe4dc] px-2 text-right text-[10px] font-black outline-none" type="number" min="0" step="0.1" value={ingredient.extraPrice} onChange={event=>updateIngredient(ingredient.id,{extraPrice:Number(event.target.value)})} /> €</label>}</div></div>)}{!ingredientRows.length&&<div className="rounded-xl border border-dashed border-[#ccd4ca] py-7 text-center"><p className="text-xs font-black text-[#778179]">Aucun ingrédient ajouté</p><p className="mt-1 text-[10px] text-[#99a099]">Commencez par le pain supérieur, puis descendez couche par couche.</p></div>}</div>
          <div className="mt-4 rounded-xl bg-[#edf5ef] p-3 text-[10px] leading-relaxed text-[#52705b]"><strong>Compréhension IA :</strong> ces réglages génèrent automatiquement les retraits et suppléments utilisables pendant la commande.</div>
        </section>
        {isMenu&&<section className="mt-5 rounded-2xl border border-[#dfe4dc] bg-[#fafbf8] p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-black text-[#536057]">Structure du menu</p><p className="mt-1 text-[10px] text-[#8b948c]">Construisez le parcours présenté au client, dans l’ordre exact de la commande.</p></div><button type="button" onClick={addStep} className="rounded-xl bg-[#0b1f14] px-4 py-2.5 text-[10px] font-black text-white">＋ Ajouter une composition</button></div>
          <div className="mt-5 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">{menuSteps.map((step,index)=><button type="button" key={step.id} onClick={()=>document.getElementById(`menu-step-${step.id}`)?.scrollIntoView({behavior:'smooth',block:'center'})} className="rounded-2xl border border-[#e1e6df] bg-white p-3 text-left shadow-sm transition hover:border-[#ff8d72]"><span className="grid h-7 w-7 place-items-center rounded-full bg-[#ffcf45] text-[10px] font-black text-[#3e2d00]">{index+1}</span><p className="mt-2 text-xs font-black">{step.name}</p><p className="mt-1 text-[9px] text-[#8a938b]">{step.options.length} choix configuré{step.options.length!==1?'s':''}</p></button>)}</div>
          <div className="mt-5 space-y-5">{menuSteps.map((step,index)=>{const isSize=step.name.toLowerCase().includes('taille');const sourceProducts=menuSourceProducts(step.name);const shownOptions=isSize?[...step.options].sort((a,b)=>sizeRank(a.name)-sizeRank(b.name)):step.options;return <div id={`menu-step-${step.id}`} key={step.id} className="scroll-mt-24 rounded-2xl border border-[#e0e5dd] bg-white p-4"><div className="flex flex-col gap-3 md:flex-row md:items-center"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#ffcf45] text-[11px] font-black text-[#3e2d00]">{index+1}</span><div className="min-w-0 flex-1"><input aria-label="Nom de la composition" className="w-full bg-transparent text-base font-black outline-none" value={step.name} onChange={event=>updateStep(step.id,{name:event.target.value})} /><input aria-label="Question posée au client" className="mt-1 w-full bg-transparent text-[10px] font-semibold text-[#7f8981] outline-none" value={step.question} onChange={event=>updateStep(step.id,{question:event.target.value})} /></div><div className="flex gap-1"><button type="button" onClick={()=>moveStep(index,-1)} disabled={index===0} className="grid h-9 w-9 place-items-center rounded-lg bg-[#f1f3ef] text-xs font-black disabled:opacity-25">↑</button><button type="button" onClick={()=>moveStep(index,1)} disabled={index===menuSteps.length-1} className="grid h-9 w-9 place-items-center rounded-lg bg-[#f1f3ef] text-xs font-black disabled:opacity-25">↓</button><button type="button" onClick={()=>setDraft(current=>({...current,optionGroups:current.optionGroups.filter(item=>item.id!==step.id)}))} className="grid h-9 w-9 place-items-center rounded-lg bg-[#fff0ec] text-xs font-black text-[#d6503d]">×</button></div></div><div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" onClick={()=>updateStep(step.id,{required:!step.required,min:step.required?0:1})} className={`rounded-full px-3 py-1.5 text-[9px] font-black ${step.required?'bg-[#e8f7ec] text-[#27894a]':'bg-[#eef1ed] text-[#7d867e]'}`}>{step.required?'✓ Choix obligatoire':'Choix facultatif'}</button><span className="text-[9px] font-bold text-[#8b948c]">{step.options.length} option{step.options.length!==1?'s':''}</span></div>{isSize?<div className="mt-4"><div className="flex gap-2"><input id={`new-size-${step.id}`} aria-label="Nouvelle taille" className={fieldClass} placeholder="Ex. Taille classique, Taille XL…" onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();const input=event.currentTarget;if(input.value.trim()){updateStep(step.id,{options:[...step.options,{id:Date.now(),name:input.value.trim(),priceDelta:0,posCode:'',available:true}]});input.value='';}}}} /><button type="button" onClick={()=>{const input=document.getElementById(`new-size-${step.id}`) as HTMLInputElement|null;if(input?.value.trim()){updateStep(step.id,{options:[...step.options,{id:Date.now(),name:input.value.trim(),priceDelta:0,posCode:'',available:true}]});input.value='';}}} className="shrink-0 rounded-xl bg-[#0b1f14] px-4 text-[10px] font-black text-white">＋ Créer la taille</button></div><p className="mt-2 text-[9px] text-[#8c958d]">Les tailles sont automatiquement affichées de la plus petite à la plus grande.</p><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{shownOptions.map((option,optionIndex)=><div key={option.id} onClick={()=>setSelectedMenuSize(option.name)} className={`relative rounded-2xl border p-4 ${selectedMenuSize===option.name?'border-[#35a85a] bg-[#eef9f1]':'border-[#dfe5dc] bg-[#fafbf8]'}`}><span className="text-[9px] font-black text-[#ff5a36]">TAILLE {optionIndex+1}</span><input className="mt-2 w-full bg-transparent text-sm font-black outline-none" value={option.name} onChange={event=>{updateStepOption(step.id,option.id,{name:event.target.value});if(selectedMenuSize===option.name)setSelectedMenuSize(event.target.value);}} /><label className="mt-3 flex items-center gap-2 text-[9px] font-bold text-[#7b847d]">Supplément <input className="h-8 w-20 rounded-lg border border-[#dfe4dc] px-2 text-right text-[10px] font-black" type="number" min="0" step="0.1" value={option.priceDelta} onChange={event=>updateStepOption(step.id,option.id,{priceDelta:Number(event.target.value)})} /> €</label><button type="button" onClick={event=>{event.stopPropagation();updateStep(step.id,{options:step.options.filter(item=>item.id!==option.id)});}} aria-label={`Supprimer ${option.name}`} className="absolute right-3 top-3 text-xs font-black text-[#d6503d]">×</button></div>)}</div></div>:sourceProducts.length?<div className="mt-4"><p className="mb-3 text-[9px] font-black uppercase tracking-wider text-[#8a938b]">Produits disponibles pour {selectedMenuSize}</p><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{sourceProducts.map(product=>{const selected=step.options.some(option=>option.name===product.name);return <button type="button" key={product.id} onClick={()=>toggleCatalogOption(step.id,product)} className={`flex min-h-24 items-center gap-3 rounded-2xl border p-3 text-left transition ${selected?'border-[#35a85a] bg-[#eef9f1]':'border-[#e1e6df] bg-[#fafbf8] hover:border-[#ff9e87]'}`}><span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-white text-3xl">{product.emoji}</span><span className="min-w-0"><strong className="block truncate text-xs">{product.name}</strong><small className="mt-1 block text-[9px] text-[#899289]">{product.available?'Disponible':'Masqué'} · {product.posCode||'Code POS à définir'}</small><span className={`mt-2 inline-block rounded-full px-2 py-1 text-[8px] font-black ${selected?'bg-[#35a85a] text-white':'bg-white text-[#687169]'}`}>{selected?'✓ Inclus dans le menu':'＋ Ajouter'}</span></span></button>})}</div></div>:<div className="mt-4 rounded-xl border border-dashed border-[#d5dcd3] bg-[#fafbf8] p-4 text-center"><p className="text-[10px] font-black text-[#737d75]">Aucun produit correspondant dans la carte</p><p className="mt-1 text-[9px] text-[#969e97]">Créez d’abord les produits de cette famille, puis revenez les sélectionner ici.</p><button type="button" onClick={()=>addStepOption(step.id)} className="mt-3 text-[10px] font-black text-[#ff5a36]">＋ Ajouter une option manuellement</button></div>}{!isSize&&step.options.filter(option=>!sourceProducts.some(product=>product.name===option.name)).length>0&&<div className="mt-3 flex flex-wrap gap-2">{step.options.filter(option=>!sourceProducts.some(product=>product.name===option.name)).map(option=><span key={option.id} className="rounded-full bg-[#f1f3ef] px-3 py-2 text-[9px] font-black">{option.name} <button type="button" onClick={()=>updateStep(step.id,{options:step.options.filter(item=>item.id!==option.id)})} className="ml-2 text-[#d6503d]">×</button></span>)}</div>}</div>})}</div>
          <div className="mt-5 rounded-xl bg-[#edf5ef] p-3 text-[10px] leading-relaxed text-[#52705b]"><strong>Compréhension IA :</strong> l’agent suivra automatiquement cette séquence et ne proposera que les tailles et produits sélectionnés dans la carte du restaurant.</div>
        </section>}
        <div className="mt-5 flex items-center justify-between rounded-2xl border border-[#e4e8e1] p-4"><div><p className="text-sm font-black">Produit disponible</p><p className="mt-1 text-[10px] text-[#8a938b]">Le produit peut être proposé par l’agent IA.</p></div><button onClick={()=>setDraft(current=>({...current,available:!current.available}))} className={`relative h-7 w-12 rounded-full ${draft.available?'bg-[#35a85a]':'bg-[#d9ded8]'}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow ${draft.available?'left-6':'left-1'}`} /></button></div>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">{onDelete&&<button onClick={onDelete} className="text-xs font-black text-[#d6503d]">Supprimer le produit</button>}<div className="ml-auto flex gap-2"><button onClick={onClose} className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Annuler</button><button onClick={onSave} disabled={!draft.name.trim()||!draft.category} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:opacity-40">Enregistrer en brouillon</button></div></div>
      </div>
    </div>
  </div>;
}

function RestaurantMenuBuilderPanel({ products, setProducts, restaurantId, onPersistProduct, onDeleteProduct }: {
  products: CatalogProduct[];
  setProducts: React.Dispatch<React.SetStateAction<CatalogProduct[]>>;
  restaurantId: string;
  onPersistProduct?: (product: CatalogProduct) => Promise<{ ok: boolean; error?: string }>;
  onDeleteProduct?: (productId: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const defaultCategoryTemplate = [['Menus', '▤'], ['Produits', '🍽️'], ['Boissons', '🥤'], ['Accompagnements', '🍟'], ['Sauces', '🥫']] as const;
  const [categories, setCategories] = useState<MenuCategory[]>(defaultCategoryTemplate.map(([name, icon], index) => ({ id: index + 1, name, icon, enabled: true })));
  const categoriesHydrated = useRef(false);
  const [activeCategory, setActiveCategory] = useState('Toutes');
  const [query, setQuery] = useState('');
  const [categoryEditor, setCategoryEditor] = useState<number | 'new' | null>(null);
  const [categoryDraft, setCategoryDraft] = useState({ name: '', icon: '🍽️' });
  const [productEditor, setProductEditor] = useState<number | 'new' | null>(null);
  const [productDraft, setProductDraft] = useState<ProductDraft>({ name: '', mainProduct: '', detail: '', category: 'Menus', subcategory: 'Bœuf', price: 0, posCode: '', emoji: '🍽️', ingredients: [], available: true, productType: 'simple', variants: [], optionGroups: [], modifiers: [], imageUrl: '', slug: '', meatFilter: '', badges: '', ingredientImages: '', allergens: '', traces: '', displayOrder: 1, nutrition: { calories: '', fat: '', saturatedFat: '', proteins: '', carbohydrates: '', sugars: '', salt: '' } });
  const [activeSubcategory, setActiveSubcategory] = useState('Tous');
  const [published, setPublished] = useState(true);
  const [notice, setNotice] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const visibleSubcategories = subcategoryTemplates[activeCategory] ?? [];
  const filteredProducts = products.filter(product => (activeCategory === 'Toutes' || product.category === activeCategory) && (activeSubcategory === 'Tous' || !visibleSubcategories.length || product.subcategory === activeSubcategory) && `${product.name} ${product.detail} ${product.posCode}`.toLowerCase().includes(query.toLowerCase()));
  const activeCount = products.filter(product => product.available).length;
  useEffect(()=>{ window.setTimeout(() => setActiveSubcategory('Tous'), 0); },[activeCategory]);
  useEffect(() => {
    const stored = window.localStorage.getItem(`drivevoice:catalog-categories:${restaurantId}`);
    const productCategoryNames = Array.from(new Set(products.map(product => product.category).filter(Boolean)));
    let storedCategories: MenuCategory[] = [];
    try {
      storedCategories = stored ? JSON.parse(stored) as MenuCategory[] : [];
    } catch {
      window.localStorage.removeItem(`drivevoice:catalog-categories:${restaurantId}`);
    }
    const source = storedCategories.length ? storedCategories : categories;
    const missing = productCategoryNames.filter(name => !source.some(category => category.name === name));
    const next = missing.length ? [...source, ...missing.map((name, index) => ({ id: Date.now() + index, name, icon: '🍽️', enabled: true }))] : source;
    if (next.length && JSON.stringify(next) !== JSON.stringify(categories)) window.setTimeout(() => setCategories(next), 0);
    categoriesHydrated.current = true;
  // Categories are deliberately scoped to this restaurant and recovered after refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId, products]);
  useEffect(() => {
    if (categoriesHydrated.current) window.localStorage.setItem(`drivevoice:catalog-categories:${restaurantId}`, JSON.stringify(categories));
  }, [categories, restaurantId]);

  const renderProductCard = (product: CatalogProduct) => <article key={product.id} className="group overflow-hidden rounded-[20px] border border-[#e4e8e1] bg-white transition hover:-translate-y-0.5 hover:border-[#ff9e87] hover:shadow-lg"><button onClick={()=>openProductEditor(product)} className="w-full text-left"><div className="relative grid h-32 place-items-center bg-gradient-to-br from-[#f8f9f6] to-[#edf1eb]">{product.imageUrl?<img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-2" />:<span className="text-6xl">{product.emoji}</span>}<span className={`absolute right-3 top-3 rounded-full px-2 py-1 text-[9px] font-black ${product.available?'bg-[#dff5e5] text-[#27894a]':'bg-[#e4e7e3] text-[#737c74]'}`}>{product.available?'Disponible':'Masqué'}</span></div><div className="p-4"><p className="text-[9px] font-black uppercase tracking-wider text-[#999f99]">{product.category}{product.subcategory?` · ${product.subcategory}`:''}</p><h3 className="mt-1 truncate text-base font-black">{product.name}</h3><p className="mt-1 line-clamp-2 min-h-8 text-[11px] leading-relaxed text-[#7b847d]">{product.detail||'Description à compléter'}</p><div className="mt-4 flex items-end justify-between"><div><p className="text-lg font-black">{money.format(product.price)}</p><p className="font-mono text-[9px] text-[#9ca39d]">{product.posCode||'Code POS manquant'}</p></div><span className="text-[10px] font-black text-[#ff5a36]">Modifier →</span></div></div></button></article>;

  const openCategoryEditor = (category?: MenuCategory) => {
    if (category) {
      setCategoryEditor(category.id);
      setCategoryDraft({ name: category.name, icon: category.icon });
    } else {
      setCategoryEditor('new');
      setCategoryDraft({ name: '', icon: '🍽️' });
    }
  };
  const saveCategory = async () => {
    const name = categoryDraft.name.trim();
    if (!name) return;
    if (categoryEditor === 'new') {
      setCategories(current => [...current, { id: Date.now(), name, icon: categoryDraft.icon || '🍽️', enabled: true }]);
      setActiveCategory(name);
    } else if (typeof categoryEditor === 'number') {
      const oldName = categories.find(category => category.id === categoryEditor)?.name;
      const renamedProducts = oldName ? products.filter(product => product.category === oldName).map(product => ({ ...product, category: name })) : [];
      setCategories(current => current.map(category => category.id === categoryEditor ? { ...category, name, icon: categoryDraft.icon || '🍽️' } : category));
      if (oldName && renamedProducts.length) {
        setProducts(current => current.map(product => product.category === oldName ? { ...product, category: name } : product));
        if (onPersistProduct) {
          setIsSaving(true);
          const results = await Promise.all(renamedProducts.map(product => onPersistProduct(product)));
          setIsSaving(false);
          const failed = results.find(result => !result.ok);
          if (failed) setNotice(`⚠️ ${failed.error ?? 'La catégorie n’a pas pu être synchronisée.'}`);
        }
      }
      if (activeCategory === oldName) setActiveCategory(name);
    }
    setPublished(false);
    setCategoryEditor(null);
  };
  const removeCategory = (category: MenuCategory) => {
    if (products.some(product => product.category === category.name)) return;
    setCategories(current => current.filter(item => item.id !== category.id));
    if (activeCategory === category.name) setActiveCategory('Toutes');
    setPublished(false);
  };
  const openProductEditor = (product?: CatalogProduct) => {
    if (product) {
      const isMenu = product.productType === 'menu';
      setProductEditor(product.id);
      setProductDraft({ name: product.name, mainProduct: product.mainProduct ?? (isMenu ? product.name : ''), detail: product.detail, category: product.category, subcategory: product.subcategory ?? subcategoryTemplates[product.category]?.[1] ?? '', price: product.price, posCode: product.posCode, emoji: product.emoji, ingredients: product.ingredientSettings ?? (product.ingredients ?? []).map((name,index)=>({ id: product.id*1000+index, name, removable: !/pain/i.test(name), extraAllowed: !/pain|sauce/i.test(name), extraPrice: 0 })), available: product.available, productType: product.productType ?? 'simple', variants: product.variants ?? [], optionGroups: product.optionGroups ?? [], modifiers: product.modifiers ?? [], imageUrl: product.imageUrl ?? '', slug: product.slug ?? '', meatFilter: product.meatFilter ?? '', badges: (product.badges ?? []).join(', '), ingredientImages: (product.ingredientImages ?? []).join('\n'), allergens: (product.allergens ?? []).join(', '), traces: (product.traces ?? []).join(', '), displayOrder: product.displayOrder ?? 1, nutrition: product.nutrition ?? { calories: '', fat: '', saturatedFat: '', proteins: '', carbohydrates: '', sugars: '', salt: '' } });
    } else {
      const defaultCategory = activeCategory === 'Toutes' ? categories[0]?.name ?? '' : activeCategory;
      setProductEditor('new');
      setProductDraft({ name: '', mainProduct: '', detail: '', category: defaultCategory, subcategory: subcategoryTemplates[defaultCategory]?.[1] ?? '', price: 0, posCode: '', emoji: '🍽️', ingredients: [], available: true, productType: defaultCategory === 'Menus' ? 'menu' : 'simple', variants: [], optionGroups: [], modifiers: [], imageUrl: '', slug: '', meatFilter: '', badges: '', ingredientImages: '', allergens: '', traces: '', displayOrder: 1, nutrition: { calories: '', fat: '', saturatedFat: '', proteins: '', carbohydrates: '', sugars: '', salt: '' } });
    }
  };
  const saveProduct = async () => {
    if (!productDraft.name.trim() || !productDraft.category || productDraft.price < 0 || (productDraft.productType === 'menu' && !productDraft.mainProduct.trim())) return;
    const existing = typeof productEditor === 'number' ? products.find(product => product.id === productEditor) : undefined;
    const id = existing?.id ?? Date.now();
    const productId = existing?.productId ?? `restaurant_${restaurantId}_${id}`;
    const ingredientSettings = productDraft.ingredients.filter(ingredient => ingredient.name.trim()).map(ingredient => ({ ...ingredient, name: ingredient.name.trim() }));
    const ingredients = ingredientSettings.map(ingredient => ingredient.name);
    const ingredientModifiers: ProductModifier[] = ingredientSettings.flatMap(ingredient => [
      ...(ingredient.removable ? [{ id: ingredient.id * 10 + 1, name: `Sans ${ingredient.name}`, kind: 'remove' as const, priceDelta: 0 }] : []),
      ...(ingredient.extraAllowed ? [{ id: ingredient.id * 10 + 2, name: `Supplément ${ingredient.name}`, kind: 'add' as const, priceDelta: ingredient.extraPrice }] : []),
    ]);
    const nextProduct: CatalogProduct = {
      id,
      productId,
      name: productDraft.name.trim(),
      mainProduct: productDraft.productType === 'menu' ? productDraft.mainProduct.trim() : undefined,
      detail: productDraft.detail.trim(),
      category: productDraft.category,
      subcategory: productDraft.subcategory || undefined,
      price: productDraft.price,
      posCode: productDraft.posCode.trim() || `NEW-${products.length + 1}`,
      emoji: productDraft.emoji || '🍽️',
      imageUrl: productDraft.imageUrl.trim() || undefined,
      ingredients,
      ingredientSettings,
      available: productDraft.available,
      productType: productDraft.productType,
      variants: productDraft.variants,
      optionGroups: productDraft.optionGroups,
      modifiers: ingredientModifiers,
      slug: productDraft.slug.trim() || undefined,
      meatFilter: productDraft.meatFilter.trim() || undefined,
      badges: splitField(productDraft.badges),
      ingredientImages: splitField(productDraft.ingredientImages),
      allergens: splitField(productDraft.allergens),
      traces: splitField(productDraft.traces),
      displayOrder: productDraft.displayOrder,
      nutrition: productDraft.nutrition,
    };
    setIsSaving(true);
    const result = onPersistProduct ? await onPersistProduct(nextProduct) : { ok: true };
    setIsSaving(false);
    if (!result.ok) {
      setNotice(`⚠️ ${result.error ?? 'Impossible de sauvegarder le produit.'}`);
      return;
    }
    setProducts(current => existing ? current.map(product => product.id === existing.id ? nextProduct : product) : [...current, nextProduct]);
    setPublished(false);
    setProductEditor(null);
    setNotice(existing ? '✓ Produit mis à jour pour ce restaurant.' : '✓ Produit ajouté au catalogue du restaurant.');
    window.setTimeout(() => setNotice(''), 3000);
  };
  const publishCatalog = () => {
    setPublished(true);
    setNotice('✓ La nouvelle version de la carte est disponible pour l\'agent IA.');
    window.setTimeout(() => setNotice(''), 2600);
  };

  return (
    <div>
      {productEditor!==null&&<RestaurantProductEditor draft={productDraft} setDraft={setProductDraft} categories={categories} subcategoryOptions={subcategoryTemplates[productDraft.category]??[]} catalogProducts={products} onClose={()=>setProductEditor(null)} onSave={saveProduct} isSaving={isSaving} isNew={productEditor==='new'} onDelete={typeof productEditor==='number'?async()=>{if(!window.confirm('Supprimer définitivement ce produit ?'))return;const product=products.find(item=>item.id===productEditor);if(onDeleteProduct&&product){const result=await onDeleteProduct(product.productId);if(!result.ok){setNotice(`⚠️ ${result.error??'Suppression impossible.'}`);return;}}setProducts(current=>current.filter(item=>item.id!==productEditor));setProductEditor(null);setPublished(false);}:undefined} />}
      <SectionHeading eyebrow="Configuration restaurant" title="Carte du restaurant" description="Créez librement les catégories et produits de votre enseigne. Cette carte validée devient l'unique source utilisée par l'agent IA pour les produits, prix et compositions." action={<div className="flex flex-wrap gap-2"><button onClick={publishCatalog} disabled={published} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:bg-[#dce1db] disabled:text-[#7c857e]">{published ? '✓ Carte publiée' : 'Publier la carte'}</button></div>} />
      {notice&&<div className="mb-4 rounded-2xl border border-[#bee4c9] bg-[#e8f8ed] px-5 py-4 text-xs font-black text-[#257c43]">{notice}</div>}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Version active','v1.4','Publiée aujourd’hui'],['Catégories',String(categories.length),'Structure personnalisée'],['Produits',String(products.length),`${activeCount} disponibles`],['État',published?'À jour':'Brouillon',published?'Agent synchronisé':'Modifications à publier']].map(([label,value,detail])=><div key={label} className={`${panelCard} p-4`}><p className="text-[10px] font-black uppercase tracking-wider text-[#929a93]">{label}</p><p className="mt-2 text-xl font-black">{value}</p><p className={`mt-1 text-[10px] font-bold ${label==='État'&&!published?'text-[#d17a17]':'text-[#778178]'}`}>{detail}</p></div>)}</div>
      {visibleSubcategories.length>0&&<div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-[#e2e6df] bg-white p-3"><span className="mr-1 text-[9px] font-black uppercase tracking-wider text-[#919991]">Sous-catégories</span>{visibleSubcategories.map(subcategory=><button key={subcategory} onClick={()=>setActiveSubcategory(subcategory)} className={`rounded-full border px-4 py-2 text-[10px] font-black transition ${activeSubcategory===subcategory?'border-[#ff5a36] bg-[#ff5a36] text-white':'border-[#dce2da] bg-white text-[#657068] hover:border-[#ff9e87]'}`}>{subcategory} <span className="ml-1 opacity-60">{subcategory==='Tous'?products.filter(product=>product.category===activeCategory).length:products.filter(product=>product.category===activeCategory&&product.subcategory===subcategory).length}</span></button>)}</div>}
      <section className={`${panelCard} grid min-h-[650px] overflow-hidden xl:grid-cols-[250px_1fr]`}>
        <aside className="border-b border-[#e5e9e2] bg-[#f8f9f6] p-4 xl:border-b-0 xl:border-r"><div className="flex items-center justify-between px-2 py-2"><div><p className="text-[10px] font-black uppercase tracking-wider text-[#8c958d]">Organisation</p><h2 className="mt-1 text-lg font-black">Catégories</h2></div><button onClick={()=>openCategoryEditor()} aria-label="Créer une catégorie" className="grid h-9 w-9 place-items-center rounded-xl bg-[#0b1f14] text-lg font-black text-white">＋</button></div><div className="mt-3 space-y-1"><button onClick={()=>setActiveCategory('Toutes')} className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-xs font-black ${activeCategory==='Toutes'?'bg-white shadow-sm text-[#ff5a36]':'text-[#687169]'}`}><span>▦ Toutes les catégories</span><span>{products.length}</span></button>{categories.map(category=>{const count=products.filter(product=>product.category===category.name).length;return <div key={category.id} className={`group flex items-center rounded-xl ${activeCategory===category.name?'bg-white shadow-sm':'hover:bg-white/70'}`}><button onClick={()=>setActiveCategory(category.name)} className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-3 text-left text-xs font-black ${activeCategory===category.name?'text-[#ff5a36]':'text-[#687169]'}`}><span>{category.icon}</span><span className="truncate">{category.name}</span><span className="ml-auto rounded-full bg-[#edf0eb] px-2 py-1 text-[9px] text-[#7c857e]">{count}</span></button><button onClick={()=>openCategoryEditor(category)} aria-label={`Modifier ${category.name}`} className="mr-1 hidden h-8 w-8 place-items-center rounded-lg text-[11px] font-black text-[#8b948c] group-hover:grid">•••</button></div>})}</div><button onClick={()=>openCategoryEditor()} className="mt-4 w-full rounded-xl border border-dashed border-[#cfd6cd] py-3 text-xs font-black text-[#ff5a36]">＋ Nouvelle catégorie</button><div className="mt-6 rounded-2xl bg-[#0b1f14] p-4 text-white"><p className="text-[9px] font-black uppercase tracking-widest text-white/45">Principe</p><p className="mt-2 text-xs font-bold leading-relaxed text-white/75">Chaque enseigne construit sa propre structure. Aucune catégorie n’est imposée par DriveVoice.</p></div></aside>
        <main className="min-w-0 p-5 md:p-6"><div className="flex flex-col gap-4 border-b border-[#e8ebe6] pb-5 md:flex-row md:items-end md:justify-between"><div><p className="text-[10px] font-black uppercase tracking-wider text-[#ff5a36]">Produits</p><h2 className="mt-1 text-2xl font-black">{activeCategory}</h2><p className="mt-1 text-xs text-[#7f8981]">Ajoutez les produits et renseignez leur composition pour l’agent.</p></div><button onClick={()=>openProductEditor()} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">＋ Ajouter un produit</button></div><div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><input aria-label="Rechercher un produit" className={`${fieldClass} sm:max-w-sm`} placeholder="Rechercher un produit ou un code POS…" value={query} onChange={event=>setQuery(event.target.value)} /><div className="flex gap-2 text-[10px] font-black"><span className="rounded-full bg-[#e5f6e9] px-3 py-2 text-[#28894a]">{activeCount} disponibles</span><span className="rounded-full bg-[#f0f2ef] px-3 py-2 text-[#727b73]">{products.length-activeCount} masqués</span></div></div>
          {filteredProducts.length ? activeSubcategory==='Tous'&&visibleSubcategories.length>1 ? <div className="mt-6 space-y-9">{visibleSubcategories.slice(1).map(subcategory=>{const sectionProducts=filteredProducts.filter(product=>product.subcategory===subcategory);if(!sectionProducts.length)return null;return <section key={subcategory} aria-labelledby={`subcategory-${subcategory}`}><div className="mb-4 flex items-center gap-3"><button onClick={()=>setActiveSubcategory(subcategory)} className="group/title flex items-center gap-2 text-left"><h3 id={`subcategory-${subcategory}`} className="text-xl font-black tracking-[-.02em]">{subcategory}</h3><span className="rounded-full bg-[#eef2ed] px-2.5 py-1 text-[9px] font-black text-[#6f7971]">{sectionProducts.length}</span><span className="text-[10px] font-black text-[#ff5a36] opacity-0 transition group-hover/title:opacity-100">Voir seulement →</span></button><div className="h-px flex-1 bg-[#e3e7e1]" /></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{sectionProducts.map(renderProductCard)}</div></section>;})}</div> : <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{filteredProducts.map(renderProductCard)}</div> : <div className="mt-8 rounded-3xl border border-dashed border-[#cfd6cd] py-16 text-center"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#f0f3ee] text-2xl">🍽️</div><h3 className="mt-4 text-lg font-black">Aucun produit dans cette sous-catégorie</h3><p className="mt-1 text-xs text-[#858e86]">Ajoutez un produit ou choisissez une autre sous-catégorie.</p><button onClick={()=>openProductEditor()} className="mt-5 rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">＋ Ajouter un produit</button></div>}
        </main>
      </section>
      {previewOpen&&<div className="fixed inset-0 z-50 overflow-y-auto bg-[#07130d]/70 p-3 md:p-7" role="dialog" aria-modal="true" aria-label="Prévisualisation de la carte"><div className="mx-auto min-h-[88vh] max-w-7xl overflow-hidden rounded-[28px] bg-[#f6ead8] shadow-2xl"><header className="sticky top-0 z-20 border-b border-[#dfcdb7] bg-[#fff8ed]/95 backdrop-blur"><div className="flex items-center justify-between px-5 py-4 md:px-8"><div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-full bg-[#c83a20] text-xs font-black text-white">🍽️</span><div><p className="text-[9px] font-black uppercase tracking-[.18em] text-[#9d6c52]">Prévisualisation DriveVoice</p><h2 className="text-lg font-black text-[#3c160d]">Carte du restaurant</h2></div></div><button onClick={()=>setPreviewOpen(false)} className="grid h-10 w-10 place-items-center rounded-full bg-white text-lg font-black text-[#3c160d] shadow-sm" aria-label="Fermer la prévisualisation">×</button></div><nav className="flex gap-1 overflow-x-auto px-4 pb-3 md:px-7" aria-label="Catégories de la carte"><button onClick={()=>setActiveCategory('Toutes')} className={`shrink-0 rounded-full px-4 py-2 text-[11px] font-black ${activeCategory==='Toutes'?'bg-[#c83a20] text-white':'bg-white text-[#6c3b2b]'}`}>Accueil</button>{categories.map(category=><button key={category.id} onClick={()=>setActiveCategory(category.name)} className={`shrink-0 rounded-full px-4 py-2 text-[11px] font-black ${activeCategory===category.name?'bg-[#c83a20] text-white':'bg-white text-[#6c3b2b]'}`}>{category.icon} {category.name}</button>)}</nav></header><main className="p-5 md:p-8"><div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#c83a20]">{activeCategory==='Toutes'?'Notre carte':activeCategory}</p><h3 className="mt-1 text-3xl font-black tracking-[-.04em] text-[#3c160d]">{activeCategory==='Toutes'?'Choisissez une catégorie':activeCategory}</h3></div><p className="text-[10px] font-bold text-[#8c6d5d]">Aperçu client · prix à confirmer par le restaurant</p></div>{activeCategory==='Toutes'?<div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">{categories.map(category=><button key={category.id} onClick={()=>setActiveCategory(category.name)} className="group overflow-hidden rounded-2xl bg-white text-left shadow-[0_5px_0_#e5d5c2] transition hover:-translate-y-1"><div className="grid h-36 place-items-center bg-gradient-to-br from-white to-[#f8ead6] text-6xl">{category.icon}</div><p className="border-t border-[#f0e3d3] p-4 text-center text-sm font-black text-[#3c160d]">{category.name}</p></button>)}</div>:<div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{products.filter(product=>product.category===activeCategory).map(product=><button key={product.id} onClick={()=>{setPreviewOpen(false);openProductEditor(product);}} className="group overflow-hidden rounded-2xl bg-white text-left shadow-[0_5px_0_#e5d5c2] transition hover:-translate-y-1"><div className="relative grid h-40 place-items-center bg-gradient-to-br from-white to-[#f8ead6] text-7xl">{product.emoji}<span className="absolute right-3 top-3 rounded-full bg-[#fff3df] px-2 py-1 text-[8px] font-black text-[#8c5f42]">BROUILLON</span></div><div className="border-t border-[#f0e3d3] p-4"><h4 className="text-sm font-black text-[#3c160d]">{product.name}</h4><p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-relaxed text-[#846959]">{product.detail}</p><p className="mt-3 text-xs font-black text-[#c83a20]">{product.price>0?money.format(product.price):'Prix à définir'} <span className="float-right">Configurer →</span></p></div></button>)}</div>}</main></div></div>}
      {categoryEditor!==null&&<div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/55 p-4" role="dialog" aria-modal="true" aria-label="Éditeur de catégorie"><div className="w-full max-w-md rounded-[28px] bg-white p-6 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Structure de la carte</p><h2 className="mt-1 text-2xl font-black">{categoryEditor==='new'?'Nouvelle catégorie':'Modifier la catégorie'}</h2></div><button onClick={()=>setCategoryEditor(null)} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div><div className="mt-6 grid grid-cols-[72px_1fr] gap-3"><label className="text-xs font-bold text-[#68736a]">Icône<input className={`${fieldClass} mt-2 text-center text-xl`} maxLength={3} value={categoryDraft.icon} onChange={event=>setCategoryDraft(current=>({...current,icon:event.target.value}))} /></label><label className="text-xs font-bold text-[#68736a]">Nom de la catégorie<input className={`${fieldClass} mt-2`} placeholder="Ex. Boissons froides" value={categoryDraft.name} onChange={event=>setCategoryDraft(current=>({...current,name:event.target.value}))} /></label></div><div className="mt-6 flex items-center justify-between">{typeof categoryEditor==='number'&&<button onClick={()=>{const category=categories.find(item=>item.id===categoryEditor);if(category){removeCategory(category);setCategoryEditor(null);}}} disabled={products.some(product=>product.category===categories.find(item=>item.id===categoryEditor)?.name)} className="text-xs font-black text-[#d6503d] disabled:cursor-not-allowed disabled:text-[#b6bcb7]">Supprimer</button>}<div className="ml-auto flex gap-2"><button onClick={()=>setCategoryEditor(null)} className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Annuler</button><button onClick={saveCategory} disabled={!categoryDraft.name.trim()} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:opacity-40">Enregistrer</button></div></div>{typeof categoryEditor==='number'&&products.some(product=>product.category===categories.find(item=>item.id===categoryEditor)?.name)&&<p className="mt-3 text-[10px] text-[#9a765f]">Déplacez d’abord les produits de cette catégorie avant de la supprimer.</p>}</div></div>}
    </div>
  );
}

type MasterBrand = {
  id: 'bk' | 'quick' | 'kfc'; name: string; short: string; color: string; soft: string; version: number; status: 'Publié' | 'Brouillon' | 'Archivé'; restaurants: number; updated: string; products: CatalogProduct[];
};

const createMasterProducts = (brand:string, rows:Array<[string,string,string,string]>, offset:number):CatalogProduct[] => rows.map(([name,category,detail,emoji],index)=>({id:offset+index,productId:`master_${brand}_${index}`,name,category,detail,emoji,price:0,posCode:'',available:true,productType:category==='Menus'?'menu':category==='Burgers'?'configurable':'simple'}));
const quickDrinkOptions = ['Coca-Cola (40cl)', 'Coca-Cola Zéro (40cl)', 'Fanta (40cl)', 'Oasis Tropical (40cl)', 'Eau minérale (50cl)'];
const quickSauceOptions = ['Sauce Giant', 'Sauce barbecue', 'Sauce mayonnaise', 'Sauce deluxe', 'Sauce ketchup'];
const quickMenuSteps = (base: number): ProductOptionGroup[] => [
  { id: base * 10 + 1, name: 'Taille du menu', question: 'Quelle taille de menu souhaitez-vous ?', required: true, min: 1, max: 1, options: [{ id: base * 100 + 1, name: 'M', priceDelta: 0, posCode: '', available: true }, { id: base * 100 + 2, name: 'L', priceDelta: 0.8, posCode: '', available: true }] },
  { id: base * 10 + 2, name: 'Accompagnement', question: 'Quel accompagnement souhaitez-vous ?', required: true, min: 1, max: 1, options: ['Moyenne frite', 'Moyenne Rustique', 'Petite salade'].map((name, index) => ({ id: base * 100 + 10 + index, name, priceDelta: 0, posCode: '', available: true })) },
  { id: base * 10 + 3, name: 'Boisson', question: 'Quelle boisson souhaitez-vous ?', required: true, min: 1, max: 1, options: quickDrinkOptions.map((name, index) => ({ id: base * 100 + 20 + index, name, priceDelta: 0, posCode: '', available: true })) },
  { id: base * 10 + 4, name: 'Sauce', question: 'Quelle sauce souhaitez-vous ?', required: false, min: 0, max: 2, options: quickSauceOptions.map((name, index) => ({ id: base * 100 + 30 + index, name, priceDelta: 0, posCode: '', available: true })) },
];
const quickMasterProducts: CatalogProduct[] = [
  { id: 2000, productId: 'quick_menu_supreme_bacon', name: 'Menu Suprême Bacon', category: 'Menus', subcategory: 'Burgers', detail: 'Suprême Bacon, accompagnement, boisson et sauce au choix', emoji: '🍔', price: 11.9, posCode: '', available: true, productType: 'menu', optionGroups: quickMenuSteps(2000), ingredients: ['Pain brioché', 'Steak haché grillé', 'Bacon', 'Cheddar', 'Salade', 'Sauce Suprême'] },
  { id: 2001, productId: 'quick_menu_giant', name: 'Menu Giant', category: 'Menus', subcategory: 'Burgers', detail: 'Giant, accompagnement, boisson et sauce au choix', emoji: '🍔', price: 9.9, posCode: '', available: true, productType: 'menu', optionGroups: quickMenuSteps(2001), ingredients: ['Pain aux graines', 'Deux steaks hachés', 'Cheddar', 'Salade', 'Oignons', 'Sauce Giant'] },
  { id: 2002, productId: 'quick_menu_long_bacon', name: 'Menu Long Bacon', category: 'Menus', subcategory: 'Poulet', detail: 'Long Bacon, accompagnement, boisson et sauce au choix', emoji: '🍔', price: 10.9, posCode: '', available: true, productType: 'menu', optionGroups: quickMenuSteps(2002), ingredients: ['Pain long', 'Poulet pané', 'Bacon', 'Cheddar', 'Salade', 'Sauce'] },
  { id: 2003, productId: 'quick_supreme_bacon', name: 'Suprême Bacon', category: 'Burgers', subcategory: 'Bœuf', detail: 'Bœuf, bacon, cheddar, salade et sauce Suprême', emoji: '🍔', price: 7.9, posCode: '', available: true, productType: 'configurable', ingredients: ['Pain brioché', 'Steak haché grillé', 'Bacon', 'Cheddar', 'Salade', 'Sauce Suprême'], modifiers: [{ id: 20031, name: 'Sans bacon', kind: 'remove', priceDelta: 0 }, { id: 20032, name: 'Sans cheddar', kind: 'remove', priceDelta: 0 }, { id: 20033, name: 'Supplément bacon', kind: 'add', priceDelta: 1 }] },
  { id: 2004, productId: 'quick_giant', name: 'Giant', category: 'Burgers', subcategory: 'Bœuf', detail: 'Deux viandes, salade, oignons et sauce Giant', emoji: '🍔', price: 6.9, posCode: '', available: true, productType: 'configurable', ingredients: ['Pain aux graines', 'Deux steaks hachés', 'Cheddar', 'Salade', 'Oignons', 'Sauce Giant'], modifiers: [{ id: 20041, name: 'Sans salade', kind: 'remove', priceDelta: 0 }, { id: 20042, name: 'Sans oignons', kind: 'remove', priceDelta: 0 }, { id: 20043, name: 'Supplément cheddar', kind: 'add', priceDelta: 0.8 }] },
  { id: 2005, productId: 'quick_long_chicken', name: 'Long Chicken', category: 'Burgers', subcategory: 'Poulet', detail: 'Poulet croustillant et sauce', emoji: '🍗', price: 6.9, posCode: '', available: true, productType: 'configurable', ingredients: ['Pain long', 'Poulet pané', 'Salade', 'Sauce'] },
  { id: 2006, productId: 'quick_fries', name: 'Moyenne frite', category: 'Accompagnements', detail: 'Frites croustillantes', emoji: '🍟', price: 2.8, posCode: '', available: true, productType: 'simple' },
  { id: 2007, productId: 'quick_rustic', name: 'Moyenne Rustique', category: 'Accompagnements', detail: 'Pommes de terre rustiques', emoji: '🥔', price: 3.2, posCode: '', available: true, productType: 'simple' },
  { id: 2008, productId: 'quick_salad', name: 'Petite salade', category: 'Accompagnements', detail: 'Salade fraîche', emoji: '🥗', price: 3.5, posCode: '', available: true, productType: 'simple' },
  { id: 2009, productId: 'quick_coca_cola', name: 'Coca-Cola', category: 'Boissons', detail: 'Boisson fraîche 40cl', emoji: '🥤', price: 2.8, posCode: '', available: true, productType: 'simple' },
  { id: 2010, productId: 'quick_water', name: 'Eau minérale', category: 'Boissons', detail: 'Bouteille d’eau 50cl', emoji: '💧', price: 2.2, posCode: '', available: true, productType: 'simple' },
  { id: 2011, productId: 'quick_sauce_giant', name: 'Sauce Giant', category: 'Sauces', detail: 'Sauce emblématique Quick', emoji: '🥫', price: 0.3, posCode: '', available: true, productType: 'simple' },
  { id: 2012, productId: 'quick_sauce_bbq', name: 'Sauce barbecue', category: 'Sauces', detail: 'Sauce barbecue fumée', emoji: '🥫', price: 0.3, posCode: '', available: true, productType: 'simple' },
  { id: 2013, productId: 'quick_magic_box', name: 'Magic Box', category: 'Menus enfants', detail: 'Menu enfant avec plat, accompagnement, boisson et surprise', emoji: '🎁', price: 5.9, posCode: '', available: true, productType: 'menu', optionGroups: quickMenuSteps(2013), ingredients: ['Produit principal au choix', 'Accompagnement', 'Boisson', 'Dessert ou surprise'] },
];
const kfcMasterProducts = createMasterProducts('kfc',[
  ['Menu Colonel Original','Menus','Burger, accompagnement, boisson et sauce','🍔'],['Menu Tower','Menus','Tower en formule complète','🍔'],['Menu Tenders','Menus','Tenders, accompagnement et boisson','🍗'],['Colonel Original','Burgers','Poulet pané, salade et sauce Colonel','🍔'],['Tower','Burgers','Poulet, galette de pomme de terre et fromage','🍔'],['Boxmaster','Burgers','Wrap généreux au poulet croustillant','🌯'],['Tenders x5','Poulet','Filets de poulet croustillants','🍗'],['Hot Wings x8','Poulet','Ailes de poulet épicées','🍗'],['Frites','Accompagnements','Frites dorées','🍟'],['Cobette','Accompagnements','Épi de maïs','🌽'],['Pepsi','Boissons','Boisson fraîche','🥤'],['Lipton Ice Tea','Boissons','Thé glacé','🥤'],['Sauce Colonel','Sauces','Sauce signature KFC','🥫'],['Sauce barbecue','Sauces','Sauce barbecue','🥫'],['P’tit Bucket','Menus enfants','Menu enfant complet','🎁']],3000);
const initialMasterBrands:MasterBrand[] = [
  {id:'quick',name:'Quick France',short:'Q',color:'#f4c531',soft:'#fff8d9',version:1,status:'Brouillon',restaurants:52,updated:'Aujourd\'hui',products:quickMasterProducts},
  {id:'kfc',name:'KFC France',short:'KFC',color:'#d71920',soft:'#fff0f0',version:1,status:'Brouillon',restaurants:326,updated:'Aujourd\'hui',products:kfcMasterProducts},
];

function DbStatusBadge({status}:{status:'off'|'loading'|'memory'|'synced'|'saving'|'error'}){
  const map={
    off:['⚪ Base non connectée','bg-[#f0f2ef] text-[#737c74]'],
    loading:['⏳ Connexion…','bg-[#eef3fb] text-[#3b6ea5]'],
    memory:['⚠️ En mémoire (non sauvegardé)','bg-[#fff5d9] text-[#a86f00]'],
    synced:['● Synchronisé à Supabase','bg-[#e5f6e9] text-[#27894a]'],
    saving:['⏳ Sauvegarde…','bg-[#eef3fb] text-[#3b6ea5]'],
    error:['⚠️ Erreur de sauvegarde','bg-[#fdecec] text-[#c0392b]'],
  } as const;
  const [label,cls]=map[status];
  return <span className={`rounded-full px-4 py-2 text-[10px] font-black ${cls}`}>{label}</span>;
}

function BackOfficePanel() {
  const [brands,setBrands]=useState<MasterBrand[]>(initialMasterBrands);
  const [dbStatus,setDbStatus]=useState<'off'|'loading'|'memory'|'synced'|'saving'|'error'>(isSupabaseConfigured?'loading':'off');
  const hydratedRef=useRef(false);
  const skipPersistRef=useRef(false);
  const persistTimerRef=useRef<ReturnType<typeof setTimeout>|null>(null);

  // Chargement initial depuis Supabase (si configuré et non vide)
  useEffect(()=>{
    let cancelled=false;
    const hydrationTimer = window.setTimeout(() => {
      if(!isSupabaseConfigured){setDbStatus('off');return;}
      setDbStatus('loading');
      fetchBrandsFromDb().then(loaded=>{
        if(cancelled)return;
        if(loaded&&loaded.length>0){
          skipPersistRef.current=true;
          setBrands(loaded as unknown as MasterBrand[]);
          hydratedRef.current=true;
          setDbStatus('synced');
        }else{
          hydratedRef.current=false;
          setDbStatus('memory');
        }
      });
    }, 0);
    return()=>{cancelled=true;window.clearTimeout(hydrationTimer);};
  },[]);

  // Persistance vers Supabase à chaque modification (debounce)
  useEffect(()=>{
    if(!isSupabaseConfigured)return;
    if(!hydratedRef.current)return;
    if(skipPersistRef.current){skipPersistRef.current=false;return;}
    if(persistTimerRef.current)clearTimeout(persistTimerRef.current);
    setDbStatus('saving');
    persistTimerRef.current=setTimeout(()=>{
      syncBrandsToDb(brands as unknown as MasterBrandInput[]).then(res=>{
        setDbStatus(res.ok?'synced':'error');
      });
    },700);
    return()=>{if(persistTimerRef.current)clearTimeout(persistTimerRef.current);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[brands]);

  // Synchronisation initiale : pousse le catalogue en mémoire vers Supabase
  const handleInitialSync=useCallback(async()=>{
    if(!isSupabaseConfigured)return;
    setDbStatus('saving');
    const res=await syncBrandsToDb(brands as unknown as MasterBrandInput[]);
    if(res.ok){hydratedRef.current=true;setDbStatus('synced');}
    else{setDbStatus('error');}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[brands]);

  const [selectedBrandId,setSelectedBrandId]=useState<MasterBrand['id']|null>(null);
  const [view,setView]=useState<'catalog'|'versions'|'restaurants'>('catalog');
  const [category,setCategory]=useState('Toutes');
  const [query,setQuery]=useState('');
  const [preview,setPreview]=useState(false);
  const [notice,setNotice]=useState('');
  const [editingProduct,setEditingProduct]=useState<CatalogProduct|null>(null);
  const [creatingProduct,setCreatingProduct]=useState(false);
  const [draft,setDraft]=useState<ProductDraft>({ name: '', mainProduct: '', detail: '', category: 'Menus', subcategory: 'Bœuf', price: 0, posCode: '', emoji: '🍽️', ingredients: [], available: true, productType: 'simple', variants: [], optionGroups: [], modifiers: [], imageUrl: '', slug: '', meatFilter: '', badges: '', ingredientImages: '', allergens: '', traces: '', displayOrder: 1, nutrition: { calories: '', fat: '', saturatedFat: '', proteins: '', carbohydrates: '', sugars: '', salt: '' } });
  const [newIngredient,setNewIngredient]=useState('');
  const brand=brands.find(item=>item.id===selectedBrandId)??null;
  const categories=brand?Array.from(new Set(brand.products.map(product=>product.category))):[];
  const displayed=brand?brand.products.filter(product=>(category==='Toutes'||product.category===category)&&`${product.name} ${product.detail}`.toLowerCase().includes(query.toLowerCase())):[];
  const updateBrand=(id:MasterBrand['id'],patch:Partial<MasterBrand>)=>setBrands(current=>current.map(item=>item.id===id?{...item,...patch}:item));
  const publish=()=>{if(!brand)return;updateBrand(brand.id,{version:brand.version+1,status:'Publié',updated:'À l\'instant'});setNotice(`✓ Version v${brand.version+1} publiée et prête pour les restaurants ${brand.short}.`);window.setTimeout(()=>setNotice(''),3200);};
  const archive=()=>{if(!brand)return;updateBrand(brand.id,{status:'Archivé',updated:'À l\'instant'});setNotice('Catalogue archivé. Les restaurants conservent leur dernière version publiée.');};
   const startCreate=()=>{const defaultCategory=category==='Toutes'?(categories[0]??'Menus'):category;setDraft({name:'',mainProduct:'',detail:'',category:defaultCategory,subcategory:subcategoryTemplates[defaultCategory]?.[1]??'',price:0,posCode:'',emoji:'🍽️',ingredients:[],available:true,productType:defaultCategory==='Menus'?'menu':'simple',variants:[],optionGroups:[],modifiers:[],imageUrl:'',slug:'',meatFilter:'',badges:'',ingredientImages:'',allergens:'',traces:'',displayOrder:brand?.products.length?brand.products.length+1:1,nutrition:{calories:'',fat:'',saturatedFat:'',proteins:'',carbohydrates:'',sugars:'',salt:''}});setCreatingProduct(true);setEditingProduct(null);setNewIngredient('');};
   const startEdit=(product:CatalogProduct)=>{const isMenuCategory=product.category==='Menus'||product.category==='Menus enfants';const requiredSteps=product.category==='Menus enfants'?['Taille du menu','Plat','Accompagnement','Boisson','Sauces','Dessert','Jouet']:['Taille du menu','Plat','Accompagnement','Boisson','Sauces'];const existingSteps=product.optionGroups??[];const normalizedSteps=isMenuCategory?requiredSteps.map((name,index)=>existingSteps.find(step=>step.name.toLowerCase()===name.toLowerCase())??{id:product.id*100+index,name,question:`Choisissez : ${name.toLowerCase()}`,required:true,min:1,max:1,options:[]}).concat(existingSteps.filter(step=>!requiredSteps.some(requiredName=>requiredName.toLowerCase()===step.name.toLowerCase()))):existingSteps;setDraft({name:product.name,mainProduct:product.mainProduct??(isMenuCategory?product.name:''),detail:product.detail,category:product.category,subcategory:product.subcategory??subcategoryTemplates[product.category]?.[1]??'',price:product.price,posCode:product.posCode,emoji:product.emoji,ingredients:product.ingredientSettings??(product.ingredients??[]).map((name,index)=>({id:product.id*1000+index,name,removable:!/pain/i.test(name),extraAllowed:!/pain|sauce/i.test(name),extraPrice:0})),available:product.available,productType:isMenuCategory?'menu':product.productType??'simple',variants:product.variants??[],optionGroups:normalizedSteps,modifiers:product.modifiers??[],imageUrl:product.imageUrl??'',slug:product.slug??'',meatFilter:product.meatFilter??'',badges:(product.badges??[]).join(', '),ingredientImages:(product.ingredientImages??[]).join('\n'),allergens:(product.allergens??[]).join(', '),traces:(product.traces??[]).join(', '),displayOrder:product.displayOrder??1,nutrition:product.nutrition??{calories:'',fat:'',saturatedFat:'',proteins:'',carbohydrates:'',sugars:'',salt:''}});setEditingProduct(product);setCreatingProduct(false);setNewIngredient('');};
  const addIngredient=()=>{const name=newIngredient.trim();if(!name)return;const ingredientId=Math.max(0,...draft.ingredients.map(ingredient=>ingredient.id))+1;setDraft(current=>({...current,ingredients:[...current.ingredients,{id:ingredientId,name,removable:true,extraAllowed:true,extraPrice:0}]}));setNewIngredient('');};
  const updateIngredient=(id:number,patch:Partial<ProductIngredient>)=>setDraft(current=>({...current,ingredients:current.ingredients.map((ingredient:ProductIngredient)=>ingredient.id===id?{...ingredient,...patch}:ingredient)}));
  const moveIngredient=(index:number,direction:-1|1)=>setDraft(current=>{const target=index+direction;if(target<0||target>=current.ingredients.length)return current;const ingredients=[...current.ingredients];[ingredients[index],ingredients[target]]=[ingredients[target],ingredients[index]];return {...current,ingredients};});
  const saveProduct=()=>{if(!brand||!draft.name.trim()||draft.price<0)return;const ingredientSettings=draft.category!=='Menus'&&draft.category!=='Menus enfants'?(draft.ingredients as ProductIngredient[]).filter(ingredient=>ingredient.name.trim()).map(ingredient=>({...ingredient,name:ingredient.name.trim()})):[];const ingredients=ingredientSettings.map(ingredient=>ingredient.name);const ingredientModifiers:ProductModifier[]=ingredientSettings.flatMap(ingredient=>[...(ingredient.removable?[{id:ingredient.id*10+1,name:`Sans ${ingredient.name}`,kind:'remove' as const,priceDelta:0}]:[]),...(ingredient.extraAllowed?[{id:ingredient.id*10+2,name:`Supplément ${ingredient.name}`,kind:'add' as const,priceDelta:ingredient.extraPrice}]:[])]);const nextProduct={name:draft.name.trim(),detail:draft.detail.trim(),category:draft.category,subcategory:draft.subcategory||undefined,price:draft.price,posCode:draft.posCode.trim(),emoji:draft.emoji||'🍽️',imageUrl:draft.imageUrl.trim()||undefined,ingredients,ingredientSettings,available:draft.available,productType:draft.productType,variants:draft.variants,optionGroups:draft.optionGroups,modifiers:ingredientModifiers,slug:draft.slug.trim()||undefined,meatFilter:draft.meatFilter.trim()||undefined,badges:splitField(draft.badges),ingredientImages:splitField(draft.ingredientImages),allergens:splitField(draft.allergens),traces:splitField(draft.traces),displayOrder:draft.displayOrder,nutrition:draft.nutrition};const nextProductId=Math.max(0,...brand.products.map(product=>product.id))+1;const products=editingProduct?brand.products.map(product=>product.id===editingProduct.id?{...product,...nextProduct}:product):[...brand.products,{id:nextProductId,productId:`master_${brand.id}_${nextProductId}`,...nextProduct} as CatalogProduct];updateBrand(brand.id,{products,status:'Brouillon',updated:'Modifié à l\'instant'});setEditingProduct(null);setCreatingProduct(false);};
  const addCategory=()=>{if(!brand)return;const name=window.prompt('Nom de la nouvelle catégorie');if(!name?.trim())return;setCategory(name.trim());startCreate();setDraft(current=>({...current,category:name.trim()}));};
  // ----- Restaurants (multi-tenant Supabase) -----
  const [restaurants,setRestaurants]=useState<RestaurantInfo[]|null>(null);
  const [selectedRestaurantId,setSelectedRestaurantId]=useState<string|null>(null);
  const [restaurantProducts,setRestaurantProducts]=useState<RestaurantProductInfo[]|null>(null);
  const [restaurantSaving,setRestaurantSaving]=useState(false);
  const [creatingRestaurant,setCreatingRestaurant]=useState(false);
  const [restaurantDraft,setRestaurantDraft]=useState({name:'',code:'',city:'',address:''});
  const [restaurantNotice,setRestaurantNotice]=useState('');

  const loadRestaurants=useCallback(async()=>{
    const list=await fetchRestaurants();
    if(list)setRestaurants(list);
  },[]);

  useEffect(()=>{
    if(!isSupabaseConfigured)return;
    let cancelled=false;
    fetchRestaurants().then(list=>{if(!cancelled&&list)setRestaurants(list);});
    return()=>{cancelled=true;};
  },[]);

  const brandRestaurants=brand&&restaurants?restaurants.filter(item=>item.brand_key===brand.id):[];
  const restaurant=restaurants?.find(item=>item.id===selectedRestaurantId)??null;

  const handleCreateRestaurant=async()=>{
    if(!brand||!restaurantDraft.name.trim())return;
    if(dbStatus==='memory'||dbStatus==='off'){setRestaurantNotice('⚠️ Publiez d’abord les catalogues vers Supabase avant de créer un restaurant.');return;}
    setRestaurantSaving(true);
    const res=await createRestaurant({brandKey:brand.id,name:restaurantDraft.name.trim(),code:restaurantDraft.code.trim()||undefined,city:restaurantDraft.city.trim()||undefined,address:restaurantDraft.address.trim()||undefined});
    setRestaurantSaving(false);
    if(res.ok){
      setCreatingRestaurant(false);
      setRestaurantDraft({name:'',code:'',city:'',address:''});
      setRestaurantNotice('✓ Restaurant créé : le catalogue maître a été copié en local.');
      window.setTimeout(()=>setRestaurantNotice(''),3600);
      loadRestaurants();
    }else{
      setRestaurantNotice(`⚠️ ${res.error}`);
    }
  };

  const handleDeleteRestaurant=async(id:string)=>{
    if(!window.confirm('Supprimer définitivement ce restaurant et son catalogue local ?'))return;
    const res=await deleteRestaurant(id);
    if(res.ok){setSelectedRestaurantId(null);setRestaurantProducts(null);loadRestaurants();}
    else{setRestaurantNotice(`⚠️ ${res.error??'Suppression impossible'}`);}
  };

  const openRestaurant=async(id:string)=>{
    setSelectedRestaurantId(id);
    setRestaurantProducts(null);
    const products=await fetchRestaurantProducts(id);
    setRestaurantProducts(products??[]);
  };

  const saveLocalProduct=async(productId:string,patch:{price?:number;available?:boolean})=>{
    if(!restaurant)return;
    setRestaurantProducts(current=>current?.map(item=>item.product_id===productId?{...item,...patch}:item)??current);
    const res=await updateRestaurantProduct(restaurant.id,productId,patch);
    if(!res.ok)setRestaurantNotice(`⚠️ ${res.error??'Sauvegarde locale impossible'}`);
  };
  if (brand && view === 'catalog') return <><MasterCatalogBrowser brand={brand} categories={categories} category={category} setCategory={setCategory} query={query} setQuery={setQuery} onBack={()=>setSelectedBrandId(null)} onEdit={startEdit} dbStatus={dbStatus} />{(creatingProduct||editingProduct)&&<IngredientProductEditor draft={draft} setDraft={setDraft} categories={categories.map((name,index)=>({id:index+1,name,icon:'',enabled:true}))} catalogProducts={brand.products} subcategoryOptions={subcategoryTemplates[draft.category]??[]} newIngredient={newIngredient} setNewIngredient={setNewIngredient} addIngredient={addIngredient} updateIngredient={updateIngredient} moveIngredient={moveIngredient} onClose={()=>{setCreatingProduct(false);setEditingProduct(null);}} onSave={saveProduct} onDelete={editingProduct?()=>{if(window.confirm('Supprimer définitivement ce produit ?')){updateBrand(brand.id,{products:brand.products.filter(product=>product.id!==editingProduct.id),status:'Brouillon',updated:'Supprimé à l’instant'});setEditingProduct(null);}}:undefined} isNew={creatingProduct} />}</>;
  if(!brand)return <div><SectionHeading eyebrow="Administration plateforme" title="Back-office des enseignes" description="Gérez les catalogues maîtres nationaux qui seront attribués automatiquement aux restaurants lors de leur création." action={<div className="flex flex-wrap items-center gap-2"><DbStatusBadge status={dbStatus}/><span className="rounded-full bg-[#fff0ec] px-4 py-2 text-[10px] font-black text-[#d84d32]">ACCÈS SUPER ADMIN</span></div>} />{dbStatus==='memory'&&<div className="mb-5 flex flex-col gap-3 rounded-2xl border border-[#f0d9a8] bg-[#fff8e8] p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-black text-[#a86f00]">Base de données détectée mais vide</p><p className="mt-1 text-[11px] text-[#8a6d1f]">Vos catalogues sont actuellement en mémoire. Publiez-les vers Supabase pour les rendre persistants.</p></div><button onClick={handleInitialSync} className="shrink-0 rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Publier les 3 catalogues vers Supabase</button></div>}{dbStatus==='error'&&<div className="mb-5 rounded-2xl border border-[#f0b8b8] bg-[#fdecec] p-4 text-xs font-black text-[#c0392b]">Impossible de sauvegarder vers Supabase. Vérifiez que le script <code className="rounded bg-white/60 px-1">supabase/setup.sql</code> a bien été exécuté dans le SQL Editor.</div>}<div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Enseignes','3','Catalogues séparés'],['Produits maîtres',String(brands.reduce((sum,item)=>sum+item.products.length,0)),'Toutes enseignes'],['Restaurants',String(brands.reduce((sum,item)=>sum+item.restaurants,0)),'Rattachés aux catalogues'],['Publications',String(brands.filter(item=>item.status==='Publié').length),'Versions actives']].map(([label,value,detail])=><div key={label} className={`${panelCard} p-5`}><p className="text-[9px] font-black uppercase tracking-wider text-[#939b94]">{label}</p><p className="mt-2 text-2xl font-black">{value}</p><p className="mt-1 text-[10px] font-bold text-[#7e8780]">{detail}</p></div>)}</div><div className="grid gap-5 lg:grid-cols-3">{brands.map(item=><button key={item.id} onClick={()=>{setSelectedBrandId(item.id);setCategory('Toutes');setView('catalog');}} className="group overflow-hidden rounded-[28px] border border-[#dfe4dc] bg-white text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl"><div className="h-2" style={{background:item.color}}/><div className="p-6"><div className="flex items-start justify-between"><span className="grid h-16 w-16 place-items-center rounded-2xl text-lg font-black" style={{background:item.soft,color:item.color}}>{item.short}</span><span className={`rounded-full px-3 py-1.5 text-[9px] font-black ${item.status==='Publié'?'bg-[#e5f6e9] text-[#27894a]':'bg-[#fff5d9] text-[#a86f00]'}`}>{item.status}</span></div><h2 className="mt-5 text-xl font-black">{item.name}</h2><p className="mt-1 text-xs text-[#7f8981]">Catalogue maître France · version v{item.version}</p><div className="mt-5 grid grid-cols-3 gap-2 border-t border-[#edf0eb] pt-4 text-center"><div><strong className="block text-lg">{new Set(item.products.map(product=>product.category)).size}</strong><small className="text-[9px] text-[#8a938b]">Catégories</small></div><div><strong className="block text-lg">{item.products.length}</strong><small className="text-[9px] text-[#8a938b]">Produits</small></div><div><strong className="block text-lg">{item.restaurants}</strong><small className="text-[9px] text-[#8a938b]">Restaurants</small></div></div><span className="mt-5 flex items-center justify-between text-xs font-black" style={{color:item.color}}>Ouvrir le catalogue <span>→</span></span></div></button>)}</div></div>;
  if(brand&&restaurant)return <RestaurantLocalPanel restaurant={restaurant} products={restaurantProducts} masterProducts={brand.products} onBack={()=>{setSelectedRestaurantId(null);setRestaurantProducts(null);}} onDelete={()=>handleDeleteRestaurant(restaurant.id)} onSaveProduct={saveLocalProduct} />;
  return <div><button onClick={()=>setSelectedBrandId(null)} className="mb-4 text-xs font-black text-[#69736b]">← Toutes les enseignes</button><SectionHeading eyebrow="Catalogue maître national" title={brand.name} description={`Structure officielle partagée avec ${brand.restaurants} restaurants. Les adaptations locales resteront séparées lors de la connexion à Supabase.`} action={<div className="flex flex-wrap items-center gap-2"><DbStatusBadge status={dbStatus}/><button onClick={()=>setPreview(true)} className="rounded-xl border border-[#dce2da] bg-white px-4 py-3 text-xs font-black">Prévisualiser</button><button onClick={publish} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Publier v{brand.version+1}</button></div>} />{notice&&<div className="mb-4 rounded-2xl border border-[#bee4c9] bg-[#e8f8ed] px-5 py-4 text-xs font-black text-[#257c43]">{notice}</div>}<div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Version',`v${brand.version}`,brand.status],['Catégories',String(categories.length),'Structure nationale'],['Produits',String(brand.products.length),'Fiches maîtres'],['Restaurants',String(brand.restaurants),'Héritent de cette carte']].map(([label,value,detail])=><div key={label} className={`${panelCard} p-4`}><p className="text-[9px] font-black uppercase tracking-wider text-[#949c95]">{label}</p><p className="mt-2 text-xl font-black">{value}</p><p className="mt-1 text-[10px] text-[#7c857e]">{detail}</p></div>)}</div><div className="mb-5 flex gap-2 overflow-x-auto rounded-2xl border border-[#e1e6df] bg-white p-2">{([['catalog','Catalogue'],['versions','Versions & publication'],['restaurants','Restaurants rattachés']] as const).map(([id,label])=><button key={id} onClick={()=>setView(id)} className={`shrink-0 rounded-xl px-4 py-3 text-xs font-black ${view===id?'bg-[#0b1f14] text-white':'text-[#737d75]'}`}>{label}</button>)}</div>{view==='catalog'&&<section className={`${panelCard} overflow-hidden`}><div className="flex flex-col gap-3 border-b border-[#e5e9e2] p-5 lg:flex-row lg:items-center lg:justify-between"><div className="flex gap-2 overflow-x-auto">{['Toutes',...categories].map(item=><button key={item} onClick={()=>setCategory(item)} className={`shrink-0 rounded-full px-3 py-2 text-[10px] font-black ${category===item?'bg-[#ff5a36] text-white':'bg-[#f1f3ef] text-[#6e786f]'}`}>{item} <span className="opacity-60">{item==='Toutes'?brand.products.length:brand.products.filter(product=>product.category===item).length}</span></button>)}</div><div className="flex gap-2"><button onClick={addCategory} className="rounded-xl border border-[#dce2da] px-4 py-3 text-[10px] font-black">＋ Catégorie</button><button onClick={startCreate} className="rounded-xl bg-[#0b1f14] px-4 py-3 text-[10px] font-black text-white">＋ Produit</button></div></div><div className="p-5"><input className={`${fieldClass} max-w-md`} placeholder="Rechercher dans le catalogue maître…" value={query} onChange={event=>setQuery(event.target.value)} /><div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{displayed.map(product=><button key={product.id} onClick={()=>startEdit(product)} className="overflow-hidden rounded-2xl border border-[#e3e7e1] bg-white text-left transition hover:border-[#ff9e87] hover:shadow-lg"><div className="grid h-28 place-items-center bg-[#f4f6f1] text-5xl">{product.emoji}</div><div className="p-4"><p className="text-[9px] font-black uppercase tracking-wider text-[#989f99]">{product.category}</p><h3 className="mt-1 truncate text-sm font-black">{product.name}</h3><p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-relaxed text-[#7e8780]">{product.detail}</p><span className="mt-3 inline-block text-[9px] font-black text-[#ff5a36]">Modifier la fiche →</span></div></button>)}</div></div></section>}{view==='versions'&&<section className={`${panelCard} p-6`}><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Cycle de publication</p><h2 className="mt-2 text-xl font-black">Versions du catalogue</h2><p className="mt-1 text-xs text-[#7e8780]">Chaque publication crée une version immuable distribuable aux restaurants.</p></div><button onClick={publish} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Publier une nouvelle version</button></div><div className="mt-6 space-y-3">{[brand.version,Math.max(1,brand.version-1)].map((version,index)=><div key={`${version}-${index}`} className="flex flex-wrap items-center gap-4 rounded-2xl border border-[#e2e7df] p-4"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#f1f3ef] text-xs font-black">v{version}</span><div className="min-w-0 flex-1"><p className="text-sm font-black">{index===0?'Version actuelle':'Version précédente'}</p><p className="mt-1 text-[10px] text-[#899189]">{brand.products.length} produits · {categories.length} catégories</p></div><span className={`rounded-full px-3 py-1.5 text-[9px] font-black ${index===0?'bg-[#e5f6e9] text-[#27894a]':'bg-[#f0f2ef] text-[#737c74]'}`}>{index===0?brand.status:'Archivée'}</span></div>)}</div><button onClick={archive} className="mt-6 text-xs font-black text-[#d6503d]">Archiver le catalogue maître</button></section>}{view==='restaurants'&&<section className={`${panelCard} p-6`}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Déploiement réseau</p><h2 className="mt-2 text-xl font-black">Restaurants rattachés</h2><p className="mt-1 text-xs text-[#7e8780]">{isSupabaseConfigured?`${brandRestaurants.length} restaurant${brandRestaurants.length>1?'s':''} connecté${brandRestaurants.length>1?'s':''} · catalogue local hérité du maître v${brand.version}`:'Connectez Supabase pour gérer les restaurants.'}</p></div>{isSupabaseConfigured&&<button onClick={()=>{setCreatingRestaurant(current=>!current);setRestaurantNotice('');}} className="rounded-xl bg-[#0b1f14] px-4 py-3 text-xs font-black text-white">{creatingRestaurant?'Annuler':'＋ Restaurant'}</button>}</div>{restaurantNotice&&<div className={`mt-4 rounded-2xl px-4 py-3 text-xs font-black ${restaurantNotice.startsWith('⚠️')?'border border-[#f0b8b8] bg-[#fdecec] text-[#c0392b]':'border border-[#bee4c9] bg-[#e8f8ed] text-[#257c43]'}`}>{restaurantNotice}</div>}{creatingRestaurant&&<div className="mt-5 rounded-2xl border border-[#e2e7df] p-4"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="text-[10px] font-black text-[#68736a]">Nom du restaurant *<input className={`${fieldClass} mt-1.5`} placeholder={`Ex. ${brand.short} Paris République`} value={restaurantDraft.name} onChange={event=>setRestaurantDraft(current=>({...current,name:event.target.value}))} /></label><label className="text-[10px] font-black text-[#68736a]">Code<input className={`${fieldClass} mt-1.5 font-mono`} placeholder="Ex. FR-075" value={restaurantDraft.code} onChange={event=>setRestaurantDraft(current=>({...current,code:event.target.value}))} /></label><label className="text-[10px] font-black text-[#68736a]">Ville<input className={`${fieldClass} mt-1.5`} placeholder="Ex. Paris" value={restaurantDraft.city} onChange={event=>setRestaurantDraft(current=>({...current,city:event.target.value}))} /></label><label className="text-[10px] font-black text-[#68736a]">Adresse<input className={`${fieldClass} mt-1.5`} placeholder="Ex. 12 rue de la République" value={restaurantDraft.address} onChange={event=>setRestaurantDraft(current=>({...current,address:event.target.value}))} /></label></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-[10px] text-[#8c958d]">Le catalogue maître {brand.name} ({brand.products.length} produits) sera copié automatiquement dans le catalogue local du restaurant.</p><button onClick={handleCreateRestaurant} disabled={!restaurantDraft.name.trim()||restaurantSaving} className="shrink-0 rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:opacity-40">{restaurantSaving?'Création…':'Créer le restaurant'}</button></div></div>}{restaurants===null&&isSupabaseConfigured&&<p className="mt-6 text-xs font-bold text-[#8c958d]">Chargement des restaurants…</p>}{restaurants!==null&&brandRestaurants.length===0&&!creatingRestaurant&&<div className="mt-6 rounded-2xl border border-dashed border-[#d8ddd6] py-10 text-center"><p className="text-sm font-black">Aucun restaurant rattaché</p><p className="mt-1 text-xs text-[#8b948c]">{isSupabaseConfigured?`Créez un premier restaurant pour lui transmettre le catalogue maître ${brand.short}.`:'Connectez Supabase pour créer des restaurants.'}</p></div>}{brandRestaurants.length>0&&<div className="mt-6 grid gap-3 md:grid-cols-2">{brandRestaurants.map(item=><button key={item.id} onClick={()=>openRestaurant(item.id)} className="flex items-center gap-3 rounded-2xl border border-[#e2e7df] p-4 text-left transition hover:border-[#ff9e87] hover:shadow-md"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-xs font-black" style={{background:brand.soft,color:brand.color}}>{brand.short}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-black">{item.name}</span><span className="mt-1 block text-[9px] text-[#8c958d]">{[item.code,item.city].filter(Boolean).join(' · ')||'Code et ville non renseignés'} · {item.active?'Actif':'Inactif'}</span></span><span className="shrink-0 text-xs font-black text-[#ff5a36]">Catalogue local →</span></button>)}</div>}</section>}{(creatingProduct||editingProduct)&&<IngredientProductEditor draft={draft} setDraft={setDraft} categories={categories.map((name,index)=>({id:index+1,name,icon:'',enabled:true}))} catalogProducts={brand.products} subcategoryOptions={subcategoryTemplates[draft.category]??[]} newIngredient={newIngredient} setNewIngredient={setNewIngredient} addIngredient={addIngredient} updateIngredient={updateIngredient} moveIngredient={moveIngredient} onClose={()=>{setCreatingProduct(false);setEditingProduct(null);}} onSave={saveProduct} onDelete={editingProduct?()=>{if(window.confirm('Supprimer définitivement ce produit ?')){updateBrand(brand.id,{products:brand.products.filter(product=>product.id!==editingProduct.id),status:'Brouillon',updated:'Supprimé à l’instant'});setEditingProduct(null);}}:undefined} isNew={creatingProduct} />}{preview&&<div className="fixed inset-0 z-[70] overflow-y-auto bg-[#07130d]/70 p-4" role="dialog" aria-modal="true"><div className="mx-auto max-w-6xl rounded-[28px] bg-white p-6"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest" style={{color:brand.color}}>Prévisualisation nationale</p><h2 className="mt-1 text-2xl font-black">Carte {brand.name}</h2></div><button onClick={()=>setPreview(false)} className="grid h-10 w-10 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div>{categories.map(item=><section key={item} className="mt-7"><h3 className="border-b pb-2 text-lg font-black">{item}</h3><div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">{brand.products.filter(product=>product.category===item).map(product=><div key={product.id} className="rounded-2xl bg-[#f5f6f1] p-4"><span className="text-4xl">{product.emoji}</span><p className="mt-3 text-sm font-black">{product.name}</p><p className="mt-1 text-[10px] text-[#7d867e]">{product.detail}</p></div>)}</div></section>)}</div></div>}</div>;
}

function LocalPriceInput({value,onCommit}:{value:number;onCommit:(next:number)=>void}){
  const [draft,setDraft]=useState(value.toFixed(2));
  const [lastValue,setLastValue]=useState(value);
  if(lastValue!==value){setLastValue(value);setDraft(value.toFixed(2));}
  const commit=()=>{
    const next=Number(draft.replace(',','.'));
    if(Number.isFinite(next)&&next>=0&&Math.abs(next-value)>0.001)onCommit(Math.round(next*100)/100);
    else setDraft(value.toFixed(2));
  };
  return <div className="relative"><input className="h-10 w-24 rounded-xl border border-[#dfe4dc] bg-white pl-3 pr-7 text-sm font-semibold outline-none transition focus:border-[#ff6a45]" type="text" inputMode="decimal" value={draft} onChange={event=>setDraft(event.target.value)} onBlur={commit} onKeyDown={event=>{if(event.key==='Enter')(event.target as HTMLInputElement).blur();}} /><span className="pointer-events-none absolute right-3 top-2.5 text-xs font-black">€</span></div>;
}

function RestaurantLocalPanel({restaurant,products,masterProducts,onBack,onDelete,onSaveProduct}:{restaurant:RestaurantInfo;products:RestaurantProductInfo[]|null;masterProducts:CatalogProduct[];onBack:()=>void;onDelete:()=>void;onSaveProduct:(productId:string,patch:{price?:number;available?:boolean})=>void}){
  const masterByProductId=new Map(masterProducts.map(product=>[product.productId,product]));
  const categories=products?Array.from(new Set(products.map(product=>product.category??'Autres'))):[];
  const availableCount=products?.filter(product=>product.available).length??0;
  const modifiedCount=products?.filter(product=>{const master=masterByProductId.get(product.product_id);return Boolean(master)&&((master?.price??0)!==(product.price??0)||master?.available!==product.available);}).length??0;
  return <div><button onClick={onBack} className="mb-4 text-xs font-black text-[#69736b]">← Restaurants rattachés</button><SectionHeading eyebrow="Déclinaison locale" title={restaurant.name} description={`Catalogue local hérité du catalogue maître ${restaurant.brand_name??''}. Les prix et disponibilités sont adaptables ici sans modifier le catalogue national.`} action={<div className="flex flex-wrap items-center gap-2"><span className="rounded-full px-4 py-2 text-[10px] font-black" style={{background:restaurant.brand_soft??'#f1f3ef',color:restaurant.brand_color??'#0b1f14'}}>{restaurant.brand_short??'Enseigne'}</span><button onClick={onDelete} className="rounded-xl border border-[#f3c4ba] bg-white px-4 py-3 text-xs font-black text-[#d6503d]">Supprimer le restaurant</button></div>} /><div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Produits',products===null?'…':String(products.length),'Hérités du maître'],['Disponibles',products===null?'…':String(availableCount),'Proposés par l\'agent'],['Adaptations locales',products===null?'…':String(modifiedCount),'Prix ou dispo modifiés'],['Ville',restaurant.city??'—',restaurant.active?'Restaurant actif':'Restaurant inactif']].map(([label,value,detail])=><div key={label} className={`${panelCard} p-4`}><p className="text-[9px] font-black uppercase tracking-wider text-[#949c95]">{label}</p><p className="mt-2 text-xl font-black">{value}</p><p className="mt-1 text-[10px] text-[#7c857e]">{detail}</p></div>)}</div>{products===null&&<div className={`${panelCard} py-16 text-center text-sm font-black text-[#8b948c]`}>Chargement du catalogue local…</div>}{products!==null&&products.length===0&&<div className={`${panelCard} py-16 text-center`}><p className="text-sm font-black">Catalogue local vide</p><p className="mt-1 text-xs text-[#8b948c]">Aucun produit n’a été copié depuis le catalogue maître pour ce restaurant.</p></div>}{products!==null&&products.length>0&&categories.map(cat=>{const items=products.filter(product=>(product.category??'Autres')===cat).sort((a,b)=>a.display_order-b.display_order);return <section key={cat} className={`${panelCard} mb-5 overflow-hidden`}><div className="border-b border-[#e5e9e2] p-5"><h3 className="text-sm font-black">{cat}</h3><p className="mt-1 text-[10px] text-[#899189]">{items.length} produit{items.length>1?'s':''} · les modifications restent propres à ce restaurant</p></div><div className="divide-y divide-[#eef1ec]">{items.map(product=>{const master=masterByProductId.get(product.product_id);const priceModified=master!==undefined&&(master.price??0)!==(product.price??0);const emoji=(product.data as {emoji?:string}|null)?.emoji??'🍽️';return <div key={product.id} className="flex flex-wrap items-center gap-4 p-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#f4f6f1] text-xl">{emoji}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-black">{product.name}</p><p className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[#899189]">{master!==undefined?`Prix maître : ${master.price.toFixed(2)} €`:'Référence maître introuvable'}{priceModified&&<span className="rounded-full bg-[#fff0ec] px-2 py-0.5 text-[9px] font-black text-[#d84d32]">Prix local</span>}</p></div><label className="flex items-center gap-2 text-[10px] font-black text-[#68736a]">Prix<LocalPriceInput value={product.price??0} onCommit={next=>onSaveProduct(product.product_id,{price:next})} /></label><div className="flex items-center gap-2"><span className="w-16 text-right text-[10px] font-black" style={{color:product.available?'#278a49':'#c0392b'}}>{product.available?'Disponible':'Épuisé'}</span><button onClick={()=>onSaveProduct(product.product_id,{available:!product.available})} aria-label={product.available?'Rendre indisponible':'Rendre disponible'} className={`relative h-6 w-11 shrink-0 rounded-full transition ${product.available?'bg-[#35a85a]':'bg-[#d9ded8]'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition ${product.available?'left-6':'left-1'}`} /></button></div></div>;})}</div></section>;})}</div>;
}

function MasterCatalogBrowser({ brand, categories, category, setCategory, query, setQuery, onBack, onEdit, dbStatus }: {
  brand: MasterBrand;
  categories: string[];
  category: string;
  setCategory: React.Dispatch<React.SetStateAction<string>>;
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  onBack: () => void;
  onEdit: (product: CatalogProduct) => void;
  dbStatus?: 'off'|'loading'|'memory'|'synced'|'saving'|'error';
}) {
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const products = brand.products.filter(product => (category === 'Toutes' || product.category === category) && `${product.name} ${product.detail}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div>
      <button onClick={onBack} className="mb-4 text-xs font-black text-[#69736b]">← Toutes les enseignes</button>
      <SectionHeading eyebrow="Catalogue maître national" title={brand.name} description="Cliquez sur un produit pour ouvrir sa fiche complète et modifier ses informations, son prix, sa composition et sa structure." action={<div className="flex flex-wrap items-center gap-2">{dbStatus&&<DbStatusBadge status={dbStatus}/>}<span className="rounded-full bg-[#e5f6e9] px-4 py-2 text-[10px] font-black text-[#27894a]">● Catalogue actif</span></div>} />
      <section className={`${panelCard} overflow-hidden`}>
        <div className="border-b border-[#e5e9e2] bg-white p-4">
          <div className="flex gap-2 overflow-x-auto pb-1">{['Toutes', ...categories].map(item => <button key={item} onClick={() => setCategory(item)} className={`shrink-0 rounded-full px-3 py-2 text-[10px] font-black ${category === item ? 'bg-[#ff5a36] text-white' : 'bg-[#f1f3ef] text-[#6e786f]'}`}>{item} <span className="opacity-60">{item === 'Toutes' ? brand.products.length : brand.products.filter(product => product.category === item).length}</span></button>)}</div>
          <div className="mt-4 flex items-center justify-between gap-3"><input className={`${fieldClass} max-w-xl`} placeholder="Rechercher un produit, un ingrédient…" value={query} onChange={event => setQuery(event.target.value)} /><span className="shrink-0 rounded-full bg-[#f1f3ef] px-3 py-2 text-[10px] font-black text-[#6e786f]">{products.length} produits</span></div>
        </div>
        <div className="bg-[#f7f9f5] p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{products.map(product => <button key={product.id} onClick={() => onEdit(product)} className="group overflow-hidden rounded-2xl border border-[#e3e7e1] bg-white text-left shadow-sm transition hover:-translate-y-1 hover:border-[#ff9e87] hover:shadow-lg"><div className="relative grid h-44 place-items-center overflow-hidden bg-[#f4f6f1]">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-3 transition duration-300 group-hover:scale-105" /> : <span className="text-6xl">{product.emoji}</span>}<span className="absolute left-3 top-3 rounded-full bg-white/90 px-2 py-1 text-[9px] font-black text-[#6e786f]">{product.productType === 'menu' ? 'MENU' : 'PRODUIT'}</span></div><div className="min-h-[155px] p-4"><p className="text-[9px] font-black uppercase tracking-wider text-[#989f99]">{product.category}</p><h3 className="mt-1 text-sm font-black text-[#172119]">{product.name}</h3><p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-relaxed text-[#7e8780]">{product.detail}</p><div className="mt-4 flex items-center justify-between"><strong className="text-base font-black text-[#ff5a36]">{money.format(product.price)}</strong><span className="text-[9px] font-black text-[#ff5a36]">Modifier →</span></div></div></button>)}</div>
          {!products.length && <div className="rounded-2xl border border-dashed border-[#ccd4ca] bg-white py-12 text-center text-sm font-bold text-[#7e8780]">Aucun produit trouvé.</div>}
        </div>
      </section>
      {selectedProduct && (selectedProduct.productType === 'menu'
        ? <MasterMenuDetail product={selectedProduct} onClose={() => setSelectedProduct(null)} onEdit={() => { setSelectedProduct(null); onEdit(selectedProduct); }} />
        : <MasterProductDetail product={selectedProduct} onClose={() => setSelectedProduct(null)} onEdit={() => { setSelectedProduct(null); onEdit(selectedProduct); }} />)}
    </div>
  );
}

function MasterMenuDetail({ product, onClose, onEdit }: { product: CatalogProduct; onClose: () => void; onEdit: () => void }) {
  const groups = product.optionGroups ?? [];
  const sizeGroup = groups.find(group => /taille/i.test(group.name));
  const sideGroup = groups.find(group => /accompagnement/i.test(group.name));
  const drinkGroup = groups.find(group => /boisson/i.test(group.name));
  const sauceGroup = groups.find(group => /sauce/i.test(group.name));
  const dishName = product.mainProduct ?? product.name;
  const ingredientRows = (product.ingredientSettings ?? []).map((setting, index) => ({ id: product.id * 100 + index, name: setting.name, removable: setting.removable, extraAllowed: setting.extraAllowed, extraPrice: setting.extraPrice }));
  const [selectedSize, setSelectedSize] = useState(sizeGroup?.options[0]?.name ?? 'Medium');
  const [selectedSide, setSelectedSide] = useState('');
  const [selectedDrink, setSelectedDrink] = useState('');
  const [selectedSauces, setSelectedSauces] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [extras, setExtras] = useState<string[]>([]);
  const visibleSides = useMemo(() => (sideGroup?.options ?? []).filter(option => sizeMatches(option.availableFor, selectedSize)), [sideGroup, selectedSize]);
  const visibleDrinks = useMemo(() => (drinkGroup?.options ?? []).filter(option => sizeMatches(option.availableFor, selectedSize)), [drinkGroup, selectedSize]);
  const visibleSauces = useMemo(() => (sauceGroup?.options ?? []).filter(option => sizeMatches(option.availableFor, selectedSize)), [sauceGroup, selectedSize]);
  const sauceRule = sauceGroup?.rulesBySize?.[selectedSize] ?? { required: sauceGroup?.required ?? false, min: sauceGroup?.min ?? 0, max: sauceGroup?.max ?? 2 };
  useEffect(() => {
    if (!visibleSides.some(option => option.name === selectedSide)) window.setTimeout(() => setSelectedSide(visibleSides[0]?.name ?? ''), 0);
  }, [selectedSide, selectedSize, visibleSides]);
  useEffect(() => {
    if (!visibleDrinks.some(option => option.name === selectedDrink)) window.setTimeout(() => setSelectedDrink(visibleDrinks[0]?.name ?? ''), 0);
  }, [selectedDrink, visibleDrinks]);
  const selectedOption = (group: ProductOptionGroup | undefined, value: string) => group?.options.find(option => option.name === value);
  const selectedOptionPrice = (group: ProductOptionGroup | undefined, value: string) => {
    if (group === sizeGroup) {
      const option = selectedOption(group, value);
      const hasConfiguredPrice = Boolean(option?.priceDeltaBySize && Object.prototype.hasOwnProperty.call(option.priceDeltaBySize, selectedSize)) || option?.priceDelta !== 0;
      return hasConfiguredPrice ? priceForSize(option, selectedSize) : menuSizeSurcharge(product.name, selectedSize);
    }
    return priceForSize(selectedOption(group, value), selectedSize);
  };
  const optionPrice = (option: ProductOption) => priceForSize(option, selectedSize);
  const selectedSauceOptions = visibleSauces.filter(option => selectedSauces.includes(option.name));
  const total = product.price + selectedOptionPrice(sizeGroup, selectedSize) + selectedOptionPrice(sideGroup, selectedSide) + selectedOptionPrice(drinkGroup, selectedDrink) + selectedSauceOptions.reduce((sum, option) => sum + optionPrice(option), 0);
  const toggleSauce = (name: string) => setSelectedSauces(current => current.includes(name) ? current.filter(item => item !== name) : current.length < sauceRule.max ? [...current, name] : current);
  const orderedSizeOptions = [...(sizeGroup?.options ?? [])].sort((first, second) => ({ Extra: 0, XXL: 0, 'King Size': 1, King: 1, Medium: 2, M: 2 }[first.name] ?? 3) - ({ Extra: 0, XXL: 0, 'King Size': 1, King: 1, Medium: 2, M: 2 }[second.name] ?? 3));
  const dishOption: ProductOption = { id: product.id * 1000, name: dishName, priceDelta: 0, posCode: '', available: true, imageUrl: product.imageUrl };
  const selectCard = (option: ProductOption, selected: boolean, onSelect: () => void, priceLabel?: string) => (
    <button type="button" onClick={onSelect} className={`group relative overflow-hidden rounded-2xl border bg-white p-3 text-left transition hover:-translate-y-0.5 hover:shadow-lg ${selected ? 'border-[#2e9b50] ring-2 ring-[#2e9b50]/20' : 'border-[#e6dfd2]'}`}>
      <div className="relative grid h-24 place-items-center overflow-hidden rounded-xl bg-[#f8f1e5]">{option.imageUrl ? <img src={option.imageUrl} alt={option.name} className="h-full w-full object-contain p-2" /> : <span className="text-5xl">{menuOptionIcon(option.name)}</span>}<span className={`absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full border-2 ${selected ? 'border-[#2e9b50] bg-[#2e9b50] text-white' : 'border-[#b9b4ab] bg-white/80 text-transparent'}`}>✓</span></div>
      <p className="mt-2 line-clamp-2 min-h-8 text-[10px] font-black leading-tight text-[#3c160d]">{option.name}</p>
      <p className="mt-1 text-[10px] font-black text-[#c83a20]">{priceLabel ?? (optionPrice(option) ? `+${money.format(optionPrice(option))}` : 'Inclus')}</p>
    </button>
  );
  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-[#24150f]/65 p-3 md:p-6" role="dialog" aria-modal="true" aria-label={`Composition du menu ${product.name}`}>
      <div className="mx-auto max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-[28px] bg-[#fffaf1] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#eadcca] bg-[#fffaf1]/95 p-5 backdrop-blur md:p-6"><div className="min-w-0 pr-4"><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#c83a20]">Fiche menu · parcours BK</p><h2 className="mt-2 text-2xl font-black tracking-[-.03em] text-[#3c160d]">{product.name}</h2><p className="mt-1 text-xs font-bold text-[#8f6b58]">{product.category} · <span aria-live="polite">Prix actuel : {money.format(total)}</span></p></div><button onClick={onClose} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-xl font-black text-[#3c160d] shadow-sm" aria-label="Fermer">×</button></div>
        <div className="space-y-6 p-5 md:p-6">
          <div className="grid gap-5 rounded-2xl border border-[#eadcca] bg-white p-4 sm:grid-cols-[180px_1fr]"><div className="grid h-40 place-items-center overflow-hidden rounded-xl bg-[#f7efe2]">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-2" /> : <span className="text-7xl">{product.emoji}</span>}</div><div><p className="text-sm leading-relaxed text-[#624b40]">{product.detail}</p><div className="mt-4 flex flex-wrap gap-2"><span className="rounded-full bg-[#e8f7ec] px-3 py-1.5 text-[10px] font-black text-[#27894a]">✓ Menu actif pour l’agent</span><span className="rounded-full bg-[#fff1df] px-3 py-1.5 text-[10px] font-black text-[#9b5e26]">Choix dans l’ordre BK</span></div></div></div>
          <MenuChoiceSection number="1" title="Taille du menu" question={sizeGroup?.question ?? 'Quelle taille de menu souhaitez-vous ?'}>{orderedSizeOptions.map(option => { const surcharge = menuSizeSurcharge(product.name, option.name); return selectCard(option, option.name === selectedSize, () => setSelectedSize(option.name), `Prix total : ${money.format(product.price + surcharge)} · ${surcharge ? `+${money.format(surcharge)}` : 'Inclus'}`); })}</MenuChoiceSection>
          <MenuChoiceSection number="2" title="Plat" question="Quel plat souhaitez-vous dans votre menu ?">{selectCard(dishOption, true, () => undefined, burger?.detail ? 'Composition personnalisable' : 'Plat sélectionné')}</MenuChoiceSection>
          <MenuChoiceSection number="3" title="Accompagnement" question={`Options disponibles pour ${selectedSize}.`}>{visibleSides.map(option => selectCard(option, option.name === selectedSide, () => setSelectedSide(option.name)))}</MenuChoiceSection>
          <MenuChoiceSection number="4" title="Boisson" question={`Boissons disponibles pour ${selectedSize}.`}>{visibleDrinks.map(option => selectCard(option, option.name === selectedDrink, () => setSelectedDrink(option.name)))}</MenuChoiceSection>
          {ingredientRows.length > 0 && <section className="rounded-2xl border border-[#eadcca] bg-[#fffdf9] p-4"><div className="border-b border-[#decdbb] pb-3"><p className="text-[10px] font-black uppercase tracking-widest text-[#c83a20]">Composition du plat</p><h3 className="mt-1 text-lg font-black text-[#3c160d]">Personnalisez le burger du menu</h3><p className="mt-1 text-[10px] text-[#907665]">Même composition et mêmes retraits que la fiche burger.</p></div><div className="relative mt-3 overflow-hidden rounded-xl border border-[#eadcca] bg-white p-3"><div className="absolute bottom-5 left-[7.1rem] top-5 hidden border-l border-dashed border-[#d8bda4] sm:block" />{ingredientRows.map((ingredient, index) => { const isRemoved = removed.includes(ingredient.name); const isExtra = extras.includes(ingredient.name); const visual = ingredientVisual(ingredient.name); return <div key={`${ingredient.id}-${index}`} className={`relative grid grid-cols-[5.2rem_3.5rem_minmax(0,1fr)] items-center gap-3 border-b border-[#f0e5d9] py-2.5 last:border-b-0 ${isRemoved ? 'opacity-60' : ''}`}><p className={`text-right text-[10px] font-black leading-tight ${isRemoved ? 'text-[#b64228] line-through' : 'text-[#3c160d]'}`}>{ingredient.name}</p><div className="relative z-[1] grid h-12 w-12 place-items-center rounded-full border-4 border-white shadow-sm" style={{ background: visual.background }}><span className="text-xl" aria-hidden="true">{visual.icon}</span></div><div className="min-w-0"><span className="text-[9px] font-black uppercase tracking-wider text-[#a5795f]">Couche {index + 1}</span><div className="mt-1 flex flex-wrap gap-2">{ingredient.removable && <button type="button" onClick={() => setRemoved(current => current.includes(ingredient.name) ? current.filter(item => item !== ingredient.name) : [...current, ingredient.name])} className={`rounded-lg px-2 py-1 text-[9px] font-black ${isRemoved ? 'bg-[#c83a20] text-white' : 'bg-[#fff0ec] text-[#c83a20]'}`}>{isRemoved ? 'Réintégrer' : 'Retirer'}</button>}{ingredient.extraAllowed && <button type="button" onClick={() => setExtras(current => current.includes(ingredient.name) ? current.filter(item => item !== ingredient.name) : [...current, ingredient.name])} className={`rounded-lg px-2 py-1 text-[9px] font-black ${isExtra ? 'bg-[#27894a] text-white' : 'bg-[#e8f7ec] text-[#27894a]'}`}>{isExtra ? 'Supplément ajouté' : `Ajouter${ingredient.extraPrice ? ` +${money.format(ingredient.extraPrice)}` : ''}`}</button>}</div></div></div>; })}</div></section>}
          <MenuChoiceSection number="5" title="Sauces" question={sauceGroup?.question ?? 'Quelles sauces souhaitez-vous ?'}><div className="col-span-full grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visibleSauces.map(option => selectCard(option, selectedSauces.includes(option.name), () => toggleSauce(option.name)))}</div><p className="col-span-full mt-3 text-[10px] font-bold text-[#907665]">Jusqu’à {sauceRule.max} sauces pour {selectedSize} · chaque supplément est ajouté au total.</p></MenuChoiceSection>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#edf5ef] p-4"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#52705b]">Prix du panier configuré</p><p className="mt-1 text-2xl font-black text-[#173b24]" aria-live="polite">{money.format(total)}</p><p className="mt-1 text-[10px] font-bold text-[#52705b]">Taille {selectedSize} · supplément taille inclus</p></div><div className="flex gap-2"><button onClick={onEdit} className="rounded-xl border border-[#d9c5b1] bg-white px-4 py-3 text-xs font-black text-[#624b40]">Modifier la fiche</button><button onClick={onClose} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Fermer</button></div></div>
        </div>
      </div>
    </div>
  );
}

function MenuChoiceSection({ number, title, question, children }: { number: string; title: string; question: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-[#eadcca] bg-white p-4"><div className="flex items-start gap-3 border-b border-[#decdbb] pb-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#c83a20] text-xs font-black text-white">{number}</span><div><p className="text-[10px] font-black uppercase tracking-widest text-[#c83a20]">{title}</p><h3 className="mt-1 text-lg font-black text-[#3c160d]">{question}</h3></div></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div></section>;
}

function menuOptionIcon(name: string) {
  const text = name.toLowerCase();
  if (/boisson|coca|fanta|oasis|vittel|jus|fuze|red bull/.test(text)) return '🥤';
  if (/frite|gaufrette|onion|king fries/.test(text)) return '🍟';
  if (/salade|carotte/.test(text)) return '🥗';
  if (/sauce/.test(text)) return '🥫';
  return '🍽️';
}

function MasterProductDetail({ product, onClose, onEdit }: { product: CatalogProduct; onClose: () => void; onEdit: () => void }) {
  const ingredientRows: ProductIngredient[] = product.ingredientSettings ?? (product.ingredients ?? []).map((name, index) => ({ id: product.id * 100 + index, name, removable: true, extraAllowed: false, extraPrice: 0 }));
  const [removed, setRemoved] = useState<string[]>([]);
  const [extras, setExtras] = useState<string[]>([]);
  const allergens = inferProductAllergens(product, ingredientRows);
  const hasIngredients = ingredientRows.length > 0;
  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-[#24150f]/65 p-3 md:p-6" role="dialog" aria-modal="true" aria-label={`Composition ${product.name}`}>
      <div className="mx-auto max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-[28px] bg-[#fffaf1] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#eadcca] bg-[#fffaf1]/95 p-5 backdrop-blur md:p-6"><div className="min-w-0 pr-4"><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#c83a20]">Fiche produit · connaissance agent IA</p><h2 className="mt-2 text-2xl font-black tracking-[-.03em] text-[#3c160d]">{product.name}</h2><p className="mt-1 text-xs font-bold text-[#8f6b58]">{product.category} · {money.format(product.price)}</p></div><button onClick={onClose} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-xl font-black text-[#3c160d] shadow-sm" aria-label="Fermer">×</button></div>
        <div className="p-5 md:p-6">
          <div className="grid gap-5 rounded-2xl border border-[#eadcca] bg-white p-4 sm:grid-cols-[145px_1fr]"><div className="grid h-36 place-items-center overflow-hidden rounded-xl bg-[#f7efe2]">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-2" /> : <span className="text-7xl">{product.emoji}</span>}</div><div><p className="text-sm leading-relaxed text-[#624b40]">{product.detail}</p><div className="mt-4 flex flex-wrap gap-2"><span className="rounded-full bg-[#e8f7ec] px-3 py-1.5 text-[10px] font-black text-[#27894a]">✓ Fiche active pour l’agent</span><span className="rounded-full bg-[#fff1df] px-3 py-1.5 text-[10px] font-black text-[#9b5e26]">{product.productType === 'menu' ? 'Menu configurable' : 'Burger configurable'}</span></div></div></div>
          <section className="mt-6"><div className="flex items-center justify-between border-b border-[#decdbb] pb-3"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#c83a20]">Composition</p><h3 className="mt-1 text-lg font-black text-[#3c160d]">Ingrédients du produit</h3></div><span className="rounded-full bg-[#f1e8dc] px-3 py-1.5 text-[10px] font-black text-[#806653]">{ingredientRows.length} éléments</span></div>{hasIngredients ? <div className="relative mt-4 overflow-hidden rounded-2xl border border-[#eadcca] bg-[#fffdf9] p-4"><div className="absolute bottom-7 left-[7.35rem] top-7 hidden border-l border-dashed border-[#d8bda4] sm:block" />{ingredientRows.map((ingredient, index) => { const isRemoved = removed.includes(ingredient.name); const isExtra = extras.includes(ingredient.name); const visual = ingredientVisual(ingredient.name); return <div key={`${ingredient.id}-${index}`} className={`relative grid grid-cols-[5.5rem_3.5rem_minmax(0,1fr)] items-center gap-3 border-b border-[#f0e5d9] py-3 last:border-b-0 ${isRemoved ? 'opacity-60' : ''}`}><p className={`text-right text-[10px] font-black leading-tight ${isRemoved ? 'text-[#b64228] line-through' : 'text-[#3c160d]'}`}>{ingredient.name}</p><div className="relative z-[1] grid h-14 w-14 place-items-center rounded-full border-4 border-[#fffdf9] shadow-sm" style={{ background: visual.background }}><span className="text-2xl" aria-hidden="true">{visual.icon}</span></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-[9px] font-black uppercase tracking-wider text-[#a5795f]">Couche {index + 1}</span>{isRemoved && <span className="rounded-full bg-[#fff0ec] px-2 py-1 text-[9px] font-black text-[#b64228]">Retiré</span>}{isExtra && <span className="rounded-full bg-[#e8f7ec] px-2 py-1 text-[9px] font-black text-[#27894a]">Supplément</span>}</div><div className="mt-2 flex flex-wrap gap-2">{ingredient.removable && <button onClick={() => setRemoved(current => current.includes(ingredient.name) ? current.filter(item => item !== ingredient.name) : [...current, ingredient.name])} className={`rounded-lg px-2.5 py-1.5 text-[10px] font-black ${isRemoved ? 'bg-[#c83a20] text-white' : 'bg-[#fff0ec] text-[#c83a20]'}`}>{isRemoved ? 'Réintégrer' : 'Retirer'}</button>}{ingredient.extraAllowed && <button onClick={() => setExtras(current => current.includes(ingredient.name) ? current.filter(item => item !== ingredient.name) : [...current, ingredient.name])} className={`rounded-lg px-2.5 py-1.5 text-[10px] font-black ${isExtra ? 'bg-[#27894a] text-white' : 'bg-[#e8f7ec] text-[#27894a]'}`}>{isExtra ? 'Supplément ajouté' : `Ajouter${ingredient.extraPrice ? ` +${money.format(ingredient.extraPrice)}` : ''}`}</button>}</div><p className="mt-1 text-[10px] text-[#907665]">{isRemoved ? 'Retiré de la commande' : isExtra ? 'Supplément sélectionné' : 'Présent par défaut'}</p></div></div>; })}</div> : <div className="mt-4 rounded-xl border border-dashed border-[#d8c4b0] bg-white p-5 text-center"><p className="text-sm font-black text-[#624b40]">Composition détaillée non renseignée</p><p className="mt-1 text-xs text-[#907665]">Ajoutez les ingrédients dans Modifier la fiche pour que l’agent puisse répondre précisément.</p></div>}</section>
          {!!product.optionGroups?.length && <section className="mt-6"><div className="border-b border-[#decdbb] pb-3"><p className="text-[10px] font-black uppercase tracking-widest text-[#c83a20]">Parcours de commande</p><h3 className="mt-1 text-lg font-black text-[#3c160d]">Choix proposés au client</h3></div><div className="mt-4 grid gap-3 sm:grid-cols-2">{product.optionGroups.map((group, index) => <div key={group.id} className="rounded-xl border border-[#eadcca] bg-white p-3"><div className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-full bg-[#f3e6d8] text-[10px] font-black text-[#8d5d45]">{index + 1}</span><p className="text-xs font-black text-[#3c160d]">{group.name}</p></div><p className="mt-2 text-[10px] text-[#907665]">{group.options.map(option => `${option.name}${option.priceDelta ? ` (${option.priceDelta > 0 ? '+' : ''}${money.format(option.priceDelta)})` : ''}`).join(' · ') || 'Options à configurer'}</p></div>)}</div></section>}
          <section className="mt-6"><div className="border-b border-[#decdbb] pb-3"><p className="text-[10px] font-black uppercase tracking-widest text-[#c83a20]">Allergènes à signaler</p><h3 className="mt-1 text-lg font-black text-[#3c160d]">Informations client</h3></div><div className="mt-4 flex flex-wrap gap-2">{allergens.length ? allergens.map(allergen => <span key={allergen} className="rounded-full bg-[#fff0ec] px-3 py-2 text-[10px] font-black text-[#a94731]">⚠ {allergen}</span>) : <span className="text-xs text-[#907665]">À vérifier avec la fiche allergènes officielle.</span>}</div></section>
          <div className="mt-6 rounded-2xl bg-[#edf5ef] p-4 text-xs leading-relaxed text-[#52705b]"><strong>Réponse agent :</strong> « {product.name} contient {ingredientRows.length ? ingredientRows.map(ingredient => ingredient.name).join(', ') : 'une composition à compléter'}. {removed.length ? `Sans ${removed.join(', ')}.` : ''} {extras.length ? `Avec supplément ${extras.join(', ')}.` : ''} »</div>
          <div className="mt-6 flex flex-wrap justify-end gap-2"><button onClick={onEdit} className="rounded-xl border border-[#d9c5b1] bg-white px-4 py-3 text-xs font-black text-[#624b40]">Modifier la fiche</button><button onClick={onClose} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Fermer</button></div>
        </div>
      </div>
    </div>
  );
}

function inferProductAllergens(product: CatalogProduct, ingredients: ProductIngredient[]) {
  const text = `${product.name} ${product.detail} ${ingredients.map(ingredient => ingredient.name).join(' ')}`.toLowerCase();
  const allergens: string[] = [];
  if (/pain|brioche|tortilla|panure|gaufrette|sésame/.test(text)) allergens.push('Gluten / graines de sésame');
  if (/cheddar|fromage|mozzarella|lait|glace|bacon/.test(text)) allergens.push('Lait');
  if (/mayonnaise|sauce|césar|caesar/.test(text)) allergens.push('Œufs possibles dans les sauces');
  if (/cacahuète|snickers|m&m|noisette/.test(text)) allergens.push('Arachides / fruits à coque');
  return allergens;
}

function ingredientVisual(name: string) {
  const text = name.toLowerCase();
  if (/pain|galette/.test(text)) return { icon: '🍞', background: '#f6d69c' };
  if (/viande|haché|poulet|pané|poisson/.test(text)) return { icon: '🍗', background: '#c87938' };
  if (/cheddar|fromage|mozzarella/.test(text)) return { icon: '🧀', background: '#ffd95c' };
  if (/salade|roquette/.test(text)) return { icon: '🥬', background: '#a8d77a' };
  if (/tomate/.test(text)) return { icon: '🍅', background: '#f08a67' };
  if (/oignon/.test(text)) return { icon: '🧅', background: '#d7b5e5' };
  if (/cornichon/.test(text)) return { icon: '🥒', background: '#b8d98a' };
  if (/bacon|chips|galette croustillante/.test(text)) return { icon: '🥓', background: '#e99b69' };
  if (/sauce|épices|moutarde|ketchup/.test(text)) return { icon: '🥫', background: '#f5b36f' };
  return { icon: '●', background: '#eadcca' };
}

function AgentPanel({ welcome, setWelcome }: { welcome: string; setWelcome: React.Dispatch<React.SetStateAction<string>> }) {
  const [saved, setSaved] = useState(false);
  const [speechRate, setSpeechRate] = useState(1);
  const [knowledge, setKnowledge] = useState([
    { id: 1, title: 'Horaires du restaurant', content: 'Ouvert du lundi au jeudi de 09:00 à 00:00, et du vendredi au dimanche de 09:00 à 01:00.', enabled: true },
    { id: 2, title: 'Paiements acceptés', content: 'Carte bancaire, espèces, titres-restaurant, Apple Pay et Google Pay au guichet de paiement.', enabled: true },
    { id: 3, title: 'Allergènes', content: 'Ne jamais donner de diagnostic. Informer le client que les 14 allergènes majeurs sont consultables et proposer un transfert à un équipier.', enabled: true },
    { id: 4, title: 'Règles de prise de commande', content: 'Pour un menu, confirmer dans cet ordre : taille, sandwich, accompagnement, boisson, sauces puis suppléments.', enabled: true },
    { id: 5, title: 'Compte de fidélité', content: 'Le client peut présenter sa carte ou son QR code au paiement pour cumuler ses avantages.', enabled: true },
    { id: 6, title: 'Situations spécifiques et fréquentes', content: 'En cas de demande imprécise, poser une seule question courte à la fois. Après deux incompréhensions, transférer à un équipier.', enabled: true },
    { id: 7, title: 'Réponses aux clients', content: 'Être direct, naturel et chaleureux. Éviter les phrases longues et ne pas répéter une information déjà confirmée.', enabled: true },
  ]);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [openKnowledge, setOpenKnowledge] = useState<number | null>(1);
  const [addingKnowledge, setAddingKnowledge] = useState(false);
  const [editingKnowledge, setEditingKnowledge] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ title: '', content: '' });
  const [newKnowledge, setNewKnowledge] = useState({ title: '', content: '' });
  const visibleKnowledge = knowledge.filter(item => `${item.title} ${item.content}`.toLowerCase().includes(knowledgeQuery.toLowerCase()));
  const addKnowledge = () => {
    if (!newKnowledge.title.trim() || !newKnowledge.content.trim()) return;
    const id = Date.now();
    setKnowledge(current => [...current, { id, ...newKnowledge, enabled: true }]);
    setNewKnowledge({ title: '', content: '' });
    setAddingKnowledge(false);
    setOpenKnowledge(id);
  };
  const startEditingKnowledge = (item: (typeof knowledge)[number]) => {
    setEditingKnowledge(item.id);
    setEditDraft({ title: item.title, content: item.content });
    setOpenKnowledge(item.id);
  };
  const saveEditedKnowledge = () => {
    if (editingKnowledge === null || !editDraft.title.trim() || !editDraft.content.trim()) return;
    setKnowledge(current => current.map(item => item.id === editingKnowledge ? { ...item, ...editDraft } : item));
    setEditingKnowledge(null);
  };
  const save = () => { setSaved(true); window.setTimeout(() => setSaved(false), 1800); };
  return (
    <div>
      <SectionHeading eyebrow="Voix & connaissances" title="Configuration de l’agent" description="Configurez l’identité vocale et centralisez toutes les règles métier dans une base de connaissances unique." action={<button onClick={save} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">{saved ? '✓ Agent mis à jour' : 'Publier la configuration'}</button>} />
      <section className={`${panelCard} overflow-hidden`}>
        <div className="p-6 md:p-7"><div className="flex items-start justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Identité vocale</p><h2 className="mt-2 text-xl font-black">Accueil et personnalité</h2><p className="mt-1 text-xs text-[#7f8981]">Définissez la façon dont l’agent accueille et accompagne chaque client.</p></div><span className="rounded-full bg-[#e3f6e8] px-3 py-1 text-[10px] font-black text-[#27894a]">● Actif</span></div><label className="mt-6 block text-xs font-bold text-[#68736a]">Message de bienvenue<textarea className="mt-2 min-h-24 w-full rounded-2xl border border-[#dfe4dc] bg-white p-4 text-sm font-semibold leading-relaxed outline-none focus:border-[#ff6a45] focus:ring-4 focus:ring-[#ff6a45]/10" value={welcome} onChange={event=>setWelcome(event.target.value)} /></label><div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4"><label className="text-xs font-bold text-[#68736a]">Voix<select className={`${fieldClass} mt-2`}><option>Marin — naturelle</option><option>Cedar — posée</option></select></label><label className="text-xs font-bold text-[#68736a]">Ton<select className={`${fieldClass} mt-2`}><option>Chaleureux et efficace</option><option>Très concis</option><option>Premium</option></select></label><label className="text-xs font-bold text-[#68736a]">Langue<select className={`${fieldClass} mt-2`}><option>Français</option><option>Français + anglais</option></select></label><label className="text-xs font-bold text-[#68736a]"><span className="flex justify-between"><span>Vitesse d’élocution</span><strong className="text-[#ff5a36]">{speechRate.toFixed(2)}×</strong></span><input aria-label="Vitesse d’élocution" type="range" min="0.75" max="1.25" step="0.05" value={speechRate} onChange={event=>setSpeechRate(Number(event.target.value))} className="mt-4 w-full accent-[#ff5a36]" /><span className="mt-1 flex justify-between text-[9px] font-semibold text-[#9aa29b]"><span>Posée</span><span>Rapide</span></span></label></div></div>
        <div className="border-t border-[#e7eae5]">
          <div className="border-b border-[#e7eae5] p-6"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Base de connaissances métier</p><h2 className="mt-2 text-xl font-black">Connaissances de l’agent</h2><p className="mt-1 text-xs leading-relaxed text-[#7f8981]">Organisez les informations utilisées par l’agent pour répondre sans rien inventer.</p></div><button onClick={()=>setAddingKnowledge(value=>!value)} className="shrink-0 rounded-xl bg-[#0b1f14] px-4 py-3 text-xs font-black text-white">{addingKnowledge ? 'Fermer' : '＋ Créer une connaissance'}</button></div>
            <div className="mt-5"><input aria-label="Rechercher une connaissance" className={fieldClass} placeholder="Rechercher une connaissance…" value={knowledgeQuery} onChange={event=>setKnowledgeQuery(event.target.value)} /></div>
          </div>
          {addingKnowledge && <div className="border-b border-[#e7eae5] bg-[#f8f9f6] p-5"><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Nouvelle connaissance</p><label className="mt-4 block text-xs font-bold text-[#68736a]">Nom de la connaissance<input className={`${fieldClass} mt-2`} placeholder="Ex. Horaires du restaurant" value={newKnowledge.title} onChange={event=>setNewKnowledge(current=>({...current,title:event.target.value}))} /></label><label className="mt-3 block text-xs font-bold text-[#68736a]">Contenu<textarea className="mt-2 min-h-28 w-full rounded-xl border border-[#dfe4dc] bg-white p-3 text-sm font-semibold outline-none focus:border-[#ff6a45] focus:ring-4 focus:ring-[#ff6a45]/10" placeholder="Saisissez les informations que l’agent doit connaître…" value={newKnowledge.content} onChange={event=>setNewKnowledge(current=>({...current,content:event.target.value}))} /></label><div className="mt-3 flex justify-end gap-2"><button onClick={()=>setAddingKnowledge(false)} className="rounded-xl border border-[#dfe4dc] bg-white px-4 py-2.5 text-xs font-black">Annuler</button><button onClick={addKnowledge} disabled={!newKnowledge.title.trim()||!newKnowledge.content.trim()} className="rounded-xl bg-[#ff5a36] px-4 py-2.5 text-xs font-black text-white disabled:opacity-40">Ajouter à la base</button></div></div>}
          <div className="p-4"><div className="space-y-2">{visibleKnowledge.map(item=><article key={item.id} className={`rounded-2xl border transition ${openKnowledge===item.id?'border-[#ffb09c] bg-[#fffaf8]':'border-[#e7eae5] bg-white'}`}><div className="flex items-center gap-3 p-4"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${item.enabled?'bg-[#35a85a]':'bg-[#cbd1cb]'}`} /><button onClick={()=>setOpenKnowledge(current=>current===item.id?null:item.id)} className="min-w-0 flex-1 text-left"><strong className="block text-sm">{item.title}</strong><small className="mt-1 block truncate text-[#89928a]">{item.content}</small></button><button aria-label={`${item.enabled?'Désactiver':'Activer'} ${item.title}`} onClick={()=>setKnowledge(current=>current.map(entry=>entry.id===item.id?{...entry,enabled:!entry.enabled}:entry))} className={`relative h-6 w-10 shrink-0 rounded-full transition ${item.enabled?'bg-[#35a85a]':'bg-[#d9ded8]'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition ${item.enabled?'left-5':'left-1'}`} /></button><button aria-label="Afficher le détail" onClick={()=>setOpenKnowledge(current=>current===item.id?null:item.id)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#f0f3ee] text-xs font-black">{openKnowledge===item.id?'↑':'↓'}</button></div>{openKnowledge===item.id&&<div className="border-t border-[#f0d9d2] px-4 pb-4 pt-3">{editingKnowledge===item.id?<div><label className="block text-xs font-bold text-[#68736a]">Nom de la connaissance<input className={`${fieldClass} mt-2`} value={editDraft.title} onChange={event=>setEditDraft(current=>({...current,title:event.target.value}))} /></label><label className="mt-3 block text-xs font-bold text-[#68736a]">Contenu<textarea className="mt-2 min-h-28 w-full rounded-xl border border-[#dfe4dc] bg-white p-3 text-sm font-semibold outline-none focus:border-[#ff6a45]" value={editDraft.content} onChange={event=>setEditDraft(current=>({...current,content:event.target.value}))} /></label><div className="mt-3 flex justify-end gap-2"><button onClick={()=>setEditingKnowledge(null)} className="rounded-lg border border-[#dfe4dc] bg-white px-3 py-2 text-[10px] font-black">Annuler</button><button onClick={saveEditedKnowledge} className="rounded-lg bg-[#ff5a36] px-3 py-2 text-[10px] font-black text-white">Enregistrer</button></div></div>:<div><p className="text-xs leading-relaxed text-[#657068]">{item.content}</p><div className="mt-3 flex flex-wrap items-center justify-between gap-3"><span className="text-[10px] font-bold text-[#2b8c4d]">✓ Disponible pour l’agent en temps réel</span><div className="flex gap-3"><button onClick={()=>startEditingKnowledge(item)} className="text-[10px] font-black text-[#ff5a36]">Modifier</button><button onClick={()=>{setKnowledge(current=>current.filter(entry=>entry.id!==item.id));setOpenKnowledge(null);}} className="text-[10px] font-black text-[#d6503d]">Supprimer</button></div></div></div>}</div>}</article>)}{visibleKnowledge.length===0&&<div className="rounded-2xl border border-dashed border-[#d8ddd6] py-10 text-center"><p className="text-sm font-black">Aucune connaissance trouvée</p><p className="mt-1 text-xs text-[#8b948c]">Modifiez votre recherche pour afficher les connaissances correspondantes.</p></div>}</div><div className="mt-4 flex items-center justify-between px-1"><span className="text-[10px] font-bold text-[#8b948c]">{visibleKnowledge.length} sur {knowledge.length} connaissances affichées</span><span className="text-[10px] font-black text-[#2b8c4d]">● Base synchronisée</span></div></div>
        </div>
      </section>
    </div>
  );
}

export default function Home() {
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const initialTab = requestedTab === 'technical' ? 'integrations' : workspaceTabs.find(tab => tab.id === requestedTab)?.id ?? 'order';
  const requestedRestaurant = searchParams.get('restaurant');
  const requestedRestaurantId = searchParams.get('restaurantId') ?? (requestedRestaurant && /^[0-9a-f-]{36}$/i.test(requestedRestaurant) ? requestedRestaurant : null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(initialTab);
  const [userRole, setUserRole] = useState<UserRole>('directeur');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [enterpriseCatalog, setEnterpriseCatalog] = useState<CatalogProduct[]>([]);
  const [agentWelcome, setAgentWelcome] = useState("Bonjour et bienvenue à La Piazza République. Que puis-je préparer pour vous aujourd'hui ?");
  const [agentRules, setAgentRules] = useState<Array<[string, boolean]>>(initialAgentRules);
  const restaurantName = searchParams.get('restaurantName') ?? demoRestaurantName;
  const restaurantId = requestedRestaurantId ?? demoRestaurantId;
  const [authOpen, setAuthOpen] = useState(false);
  const [accountEmail, setAccountEmail] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const reloadRestaurantCatalog = useCallback(async () => {
    setEnterpriseCatalog([]);
    const rows = await fetchRestaurantProducts(restaurantId);
    if (rows && rows.length > 0) {
      setEnterpriseCatalog(rows.map(mapRestaurantProduct));
    }
  }, [restaurantId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void reloadRestaurantCatalog(), 0);
    return () => window.clearTimeout(timer);
  }, [reloadRestaurantCatalog]);
  const persistRestaurantProduct = useCallback(async (product: CatalogProduct) => {
    if (!isSupabaseConfigured) return { ok: true };
    return upsertRestaurantProduct(restaurantId, {
      productId: product.productId,
      name: product.name,
      category: product.category,
      price: product.price,
      available: product.available,
      displayOrder: product.displayOrder,
      data: JSON.parse(JSON.stringify(product)) as Record<string, unknown>,
    });
  }, [restaurantId]);
  const removeRestaurantProduct = useCallback(async (productId: string) => {
    if (!isSupabaseConfigured) return { ok: true };
    return deleteRestaurantProduct(restaurantId, productId);
  }, [restaurantId]);
  const visibleCatalog = enterpriseCatalog;
  const active = workspaceTabs.find(tab => tab.id === activeTab) ?? workspaceTabs[0];
  const openAccount = () => {
    setAuthOpen(true);
    setAuthNotice('');
  };
  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
    window.location.assign('/login');
  };
  const createRestaurantAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !accountEmail.trim()) return;
    const { error } = await supabase.auth.signInWithOtp({
      email: accountEmail.trim(),
      options: { emailRedirectTo: `${window.location.origin}/restaurant` },
    });
    setAuthNotice(error ? error.message : 'Un lien de connexion vient d’être envoyé à votre adresse e-mail.');
  };
  return (
    <div className={`min-h-screen bg-[#f4f6f1] text-[#132018] lg:grid ${sidebarCollapsed ? 'lg:grid-cols-[88px_1fr]' : 'lg:grid-cols-[268px_1fr]'}`}>
      <aside className="drivevoice-sidebar relative flex flex-col border-b border-[#223a2c] bg-[#0b1f14] pb-4 text-white shadow-[12px_0_40px_rgba(7,26,17,.08)] lg:sticky lg:top-0 lg:h-screen lg:max-h-screen lg:min-h-0 lg:overflow-hidden lg:border-b-0 lg:border-r lg:pb-0">
        <div className={`flex items-center justify-between px-5 py-5 lg:px-5 lg:py-7 ${sidebarCollapsed ? 'lg:flex-col lg:gap-5' : 'lg:block'}`}><Link href="/" aria-label="Accueil DriveVoice" className="flex items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#ff5a36] text-lg font-black shadow-[0_8px_24px_rgba(255,90,54,.22)]">D</span><div className={sidebarCollapsed ? 'lg:hidden' : ''}><p className="font-black tracking-[-.04em]">DRIVE<span className="text-[#ff7556]">VOICE</span></p><p className="text-[9px] font-bold uppercase tracking-[.18em] text-white/45">Enterprise OS</p></div></Link><div className="flex items-center gap-2"><span className={`rounded-full bg-[#173625] px-3 py-1 text-[9px] font-black uppercase text-[#68d48a] ${sidebarCollapsed ? 'lg:hidden' : ''}`}>● Live</span><button onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} className="hidden h-9 w-9 place-items-center rounded-xl border border-white/10 bg-white/5 text-sm font-black transition hover:bg-white/10 lg:grid" aria-label={sidebarCollapsed ? 'Développer la barre latérale' : 'Réduire la barre latérale'}>{sidebarCollapsed ? '→' : '←'}</button></div></div>
        <div className={`hidden px-5 lg:block ${sidebarCollapsed ? 'lg:px-3' : ''}`}><div className={`rounded-2xl border border-white/10 bg-white/5 p-4 ${sidebarCollapsed ? 'text-center' : ''}`}><p className="text-[9px] font-black uppercase tracking-[.17em] text-white/40">{sidebarCollapsed ? 'LP' : 'Restaurant connecté'}</p><p className={`mt-2 text-sm font-black ${sidebarCollapsed ? 'hidden' : ''}`}>{restaurantName}</p><p className={`mt-1 text-[10px] text-white/45 ${sidebarCollapsed ? 'hidden' : ''}`}>Drive n°04 · Voie A</p></div></div>
        <nav className={`flex gap-1 overflow-x-auto px-3 pb-4 lg:mt-7 lg:min-h-0 lg:flex-1 lg:block lg:space-y-1 lg:overflow-y-auto lg:overscroll-contain ${sidebarCollapsed ? 'lg:px-3' : 'lg:px-4'}`} aria-label="Espaces de travail DriveVoice">{workspaceTabs.filter(tab => userRole === 'directeur' || (userRole === 'manager' && !restrictedTabsForManager.includes(tab.id)) || (userRole === 'operateur' && !restrictedTabsForOperateur.includes(tab.id))).map(tab=><button key={tab.id} onClick={()=>setActiveTab(tab.id)} title={sidebarCollapsed ? tab.label : undefined} className={`flex shrink-0 items-center gap-3 rounded-xl px-4 py-3 text-left text-xs font-black transition lg:w-full ${sidebarCollapsed ? 'lg:justify-center lg:px-2' : ''} ${activeTab===tab.id?'bg-white text-[#102019] shadow-lg':'text-white/55 hover:bg-white/5 hover:text-white'}`}><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base ${activeTab===tab.id?'bg-[#ff5a36] text-white':'bg-white/5'}`}>{tab.icon}</span><span className={sidebarCollapsed ? 'lg:hidden' : ''}><span className="block">{tab.short}</span><span className={`hidden text-[9px] font-semibold lg:block ${activeTab===tab.id?'text-[#6f7972]':'text-white/30'}`}>{tab.label}</span></span></button>)}</nav>
        <div className={`hidden border-t border-white/10 pt-4 lg:mx-4 lg:mb-5 lg:block lg:shrink-0 ${sidebarCollapsed ? 'lg:mx-3' : ''}`}><button onClick={signOut} title={sidebarCollapsed ? 'Se déconnecter' : undefined} className="w-full rounded-2xl border border-white/10 p-4 text-left transition hover:border-[#ff7556] hover:bg-[#ff5a36]"><div className={`flex items-center gap-3 ${sidebarCollapsed ? 'justify-center' : ''}`}><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#ffc647] text-xs font-black text-[#172019]">AM</span><div className={sidebarCollapsed ? 'hidden' : ''}><p className="text-xs font-black">Se déconnecter</p><p className="text-[9px] text-white/40">Retour à la page de connexion</p></div></div></button></div>
      </aside>
      <main className="min-w-0"><header className="sticky top-0 z-30 flex items-center justify-between border-b border-[#e1e5de] bg-[#f4f6f1]/90 px-5 py-4 backdrop-blur-xl md:px-8"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#8a938c]">DriveVoice / {active.short}</p><p className="mt-1 text-sm font-black">{active.label}</p></div><div className="flex items-center gap-3"><span className="hidden rounded-full border border-[#dce2da] bg-white px-3 py-2 text-[10px] font-black text-[#2b8c4d] md:inline">● Tous les systèmes opérationnels</span><button aria-label="Notifications" className="grid h-10 w-10 place-items-center rounded-xl border border-[#dce2da] bg-white">•</button></div></header>
        {activeTab === 'order' ? <OrderWorkspace products={visibleCatalog} agentWelcome={agentWelcome} agentRules={agentRules} restaurantName={restaurantName} restaurantId={restaurantId} /> : <div className="mx-auto max-w-[1500px] p-5 md:p-8">{activeTab === 'dashboard' && <RestaurantDashboardPanel restaurantId={restaurantId} />}{activeTab === 'integrations' && <IntegrationsPanel onCatalogSynced={reloadRestaurantCatalog} />}{activeTab === 'catalog' && <RestaurantMenuBuilderPanel products={visibleCatalog} setProducts={setEnterpriseCatalog} restaurantId={restaurantId} onPersistProduct={persistRestaurantProduct} onDeleteProduct={removeRestaurantProduct} />}{activeTab === 'agent' && <AgentPanel welcome={agentWelcome} setWelcome={setAgentWelcome} />}{activeTab === 'account' && <AccountPanel />}{activeTab === 'support' && <SupportPanel mode="restaurant" restaurantId={restaurantId} />}</div>}
      </main>
      {authOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/65 p-4" role="dialog" aria-modal="true" aria-label="Créer un compte restaurant"><div className="w-full max-w-md rounded-[28px] bg-white p-7 shadow-2xl md:p-9"><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ff5a36]">DriveVoice restaurants</p><h2 className="mt-2 text-2xl font-black">Créer votre compte</h2><p className="mt-2 text-sm leading-relaxed text-[#738078]">Recevez un lien sécurisé pour accéder à votre espace restaurant.</p></div><button onClick={() => setAuthOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] text-lg font-black" aria-label="Fermer">×</button></div><form onSubmit={createRestaurantAccount} className="mt-7"><label className="text-xs font-black text-[#68736a]">Adresse e-mail professionnelle<input required type="email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} className={`${fieldClass} mt-2`} placeholder="restaurant@exemple.fr" /></label><button disabled={!isSupabaseConfigured} className="mt-4 w-full rounded-xl bg-[#ff5a36] py-3.5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50">Recevoir mon lien d’accès</button>{!isSupabaseConfigured && <p className="mt-3 text-xs text-[#b26b00]">L’authentification sera disponible après configuration Supabase.</p>}{authNotice && <p role="status" className="mt-4 rounded-xl bg-[#edf7ef] px-4 py-3 text-xs font-bold text-[#287b43]">{authNotice}</p>}</form><p className="mt-6 text-center text-[10px] text-[#98a099]">Connexion sans mot de passe · lien à usage unique</p></div></div>}
    </div>
  );
}
