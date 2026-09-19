import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceOrchestrator, type TranscriptMessage, type VoiceStatus } from './voice-orchestrator';
import type { CatalogEntry } from './basket-manager';

export type UseVoiceOptions = {
  brand?: string;
  restaurantId?: string;
  conversationId?: string;
  catalog?: CatalogEntry[];
};

export type OrderResult = { ref: string; status: 'submitted' | 'failed'; message?: string };

export function useVoice(options: UseVoiceOptions = {}) {
  const orchestratorRef = useRef<VoiceOrchestrator | null>(null);
  const [status, setStatus] = useState<VoiceStatus>({ connection: 'idle', conversation: 'idle' });
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [basket, setBasket] = useState<{ items: unknown[]; total: number; status: string }>({ items: [], total: 0, status: 'editing' });
  const [orderResult, setOrderResult] = useState<OrderResult | null>(null);
  const [isStarted, setIsStarted] = useState(false);

  useEffect(() => {
    const orchestrator = new VoiceOrchestrator({
      onStatusChange: setStatus,
      onTranscriptUpdate: setTranscript,
      onBasketUpdate: setBasket,
      onOrderUpdate: setOrderResult,
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
    });
  }, [options.brand, options.restaurantId, options.conversationId, options.catalog]);

  const start = useCallback(async (audioElement?: HTMLAudioElement) => {
    await orchestratorRef.current?.start(audioElement);
    setIsStarted(true);
  }, []);

  const stop = useCallback(() => {
    orchestratorRef.current?.stop();
    setIsStarted(false);
  }, []);

  const sendText = useCallback((text: string) => {
    orchestratorRef.current?.sendText(text);
  }, []);

  const confirmOrder = useCallback(() => {
    orchestratorRef.current?.confirmOrder();
  }, []);

  const resetForNextCustomer = useCallback(() => {
    orchestratorRef.current?.resetForNextCustomer();
    setOrderResult(null);
  }, []);

  return {
    status,
    transcript,
    basket,
    isStarted,
    start,
    stop,
    sendText,
    confirmOrder,
    orderResult,
    resetForNextCustomer,
  };
}
