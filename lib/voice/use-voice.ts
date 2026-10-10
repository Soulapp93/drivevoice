import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceOrchestrator, type VoiceAuditSnapshot, type VoiceStatus } from './voice-orchestrator';
import type { CatalogEntry } from './basket-manager';
import { logRealtimeEvent } from '@/lib/realtime/logging';

export type UseVoiceOptions = {
  brand?: string;
  restaurantId?: string;
  conversationId?: string;
  catalog?: CatalogEntry[];
  onOrderUpdate?: (order: { ref: string; status: 'submitted' | 'failed'; message?: string }) => void;
  onAudit?: (audit: VoiceAuditSnapshot) => void;
};

export type OrderResult = { ref: string; status: 'submitted' | 'failed'; message?: string };

export function useVoice(options: UseVoiceOptions = {}) {
  const orchestratorRef = useRef<VoiceOrchestrator | null>(null);
  const [status, setStatus] = useState<VoiceStatus>({ connection: 'idle', conversation: 'idle' });
  const [basket, setBasket] = useState<{ items: unknown[]; total: number; status: string }>({ items: [], total: 0, status: 'editing' });
  const [orderResult, setOrderResult] = useState<OrderResult | null>(null);
  const [isStarted, setIsStarted] = useState(false);

  useEffect(() => {
    const orchestrator = new VoiceOrchestrator({
      onStatusChange: (nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus.connection === 'connected') {
          setIsStarted(true);
        } else if (nextStatus.connection === 'idle') {
          setIsStarted(false);
        }
      },
      onBasketUpdate: setBasket,
      onOrderUpdate: (order) => setOrderResult(order),
    });
    orchestratorRef.current = orchestrator;
    return () => {
      orchestrator.stop();
      orchestratorRef.current = null;
    };
  }, []);

  useEffect(() => {
    orchestratorRef.current?.updateConfig({
      brand: options.brand,
      restaurantId: options.restaurantId,
      conversationId: options.conversationId,
      catalog: options.catalog,
      onAudit: options.onAudit,
    });
  }, [options.brand, options.restaurantId, options.conversationId, options.catalog, options.onAudit]);

  const start = useCallback(async (audioElement?: HTMLAudioElement) => {
    setIsStarted(true);
    const started = await orchestratorRef.current?.start(audioElement);
    if (started !== true) setIsStarted(false);
  }, []);

  const stop = useCallback(() => {
    orchestratorRef.current?.stop();
    setIsStarted(false);
  }, []);

  const sendText = useCallback((text: string) => {
    orchestratorRef.current?.sendText(text);
  }, []);

  const interrupt = useCallback(() => {
    orchestratorRef.current?.interrupt();
  }, []);

  const confirmOrder = useCallback(() => {
    orchestratorRef.current?.confirmOrder();
  }, []);

  const resetForNextCustomer = useCallback(() => {
    const traceId = `reset-${Date.now()}`;
    logRealtimeEvent('reset.started', { traceId });

    // Séquence atomique : orchestrator stop + state updates batched
    orchestratorRef.current?.resetForNextCustomer();
    setOrderResult(null);
    setIsStarted(false);

    logRealtimeEvent('reset.completed', { traceId });
  }, []);

  return {
    status,
    basket,
    isStarted,
    start,
    stop,
    sendText,
    interrupt,
    confirmOrder,
    orderResult,
    resetForNextCustomer,
  };
}
