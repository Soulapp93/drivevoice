'use client';

import { useRef, useState } from 'react';
import { useVoice } from '@/lib/voice/use-voice';

const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

export function VoicePanel() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [text, setText] = useState('');
  const { status, transcript, basket, isStarted, start, stop, sendText, confirmOrder } = useVoice({
    brand: 'Burger King',
    restaurantId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  });

  const connectionLabel: Record<string, string> = {
    idle: 'Inactif',
    connecting: 'Connexion…',
    connected: 'Connecté',
    error: 'Erreur',
    disconnected: 'Déconnecté',
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <audio ref={audioRef} autoPlay playsInline className="hidden" />

      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="flex flex-col">
          <span className="text-sm text-gray-500">Connexion</span>
          <span className="font-medium">{connectionLabel[status.connection] ?? status.connection}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-sm text-gray-500">État conversation</span>
          <span className="font-medium capitalize">{status.conversation}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-sm text-gray-500">Total</span>
          <span className="font-medium">{money.format(basket.total)}</span>
        </div>
      </div>

      {status.error && (
        <div className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">{status.error}</div>
      )}

      <div className="flex gap-2">
        {!isStarted ? (
          <button
            type="button"
            onClick={() => start(audioRef.current ?? undefined)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            Démarrer la conversation
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="rounded-lg bg-red-600 px-4 py-2 text-white hover:bg-red-700"
          >
            Arrêter
          </button>
        )}
        <button
          type="button"
          onClick={confirmOrder}
          disabled={!isStarted}
          className="rounded-lg bg-green-600 px-4 py-2 text-white hover:bg-green-700 disabled:opacity-50"
        >
          Confirmer la commande
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          sendText(text);
          setText('');
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Écrire un message à l'agent…"
          disabled={!isStarted}
          className="flex-1 rounded-lg border px-3 py-2"
        />
        <button
          type="submit"
          disabled={!isStarted || !text.trim()}
          className="rounded-lg bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          Envoyer
        </button>
      </form>

      <div className="max-h-80 overflow-y-auto rounded-lg border p-4">
        {transcript.length === 0 && <p className="text-sm text-gray-400">Aucun message pour l’instant.</p>}
        {transcript.map((message) => (
          <div
            key={message.id}
            className={`mb-2 text-sm ${message.speaker === 'client' ? 'text-blue-700' : 'text-gray-700'}`}
          >
            <span className="font-semibold">{message.speaker === 'client' ? 'Client' : 'Agent'} :</span> {message.text}
          </div>
        ))}
      </div>

      {basket.items.length > 0 && (
        <div className="rounded-lg border p-4">
          <h3 className="mb-2 font-semibold">Panier</h3>
          <ul className="space-y-1 text-sm">
            {basket.items.map((item, index) => {
              const typed = item as { name: string; price: number; quantity: number };
              return (
                <li key={index}>{typed.quantity}× {typed.name} — {money.format(typed.price)}</li>
              );
            })}
          </ul>
          <div className="mt-2 border-t pt-2 font-semibold">Total : {money.format(basket.total)}</div>
        </div>
      )}
    </div>
  );
}
