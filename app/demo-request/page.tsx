'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';

type DemoRequestDraft = {
  fullName: string;
  email: string;
  phone: string;
  restaurantName: string;
  restaurantCount: string;
  role: string;
  message: string;
  website: string;
};

const initialDraft: DemoRequestDraft = {
  fullName: '',
  email: '',
  phone: '',
  restaurantName: '',
  restaurantCount: '1',
  role: '',
  message: '',
  website: '',
};

const inputClassName = 'mt-2 w-full rounded-xl border border-[#dce4df] bg-white px-4 py-3 text-sm text-[#17392D] outline-none transition placeholder:text-[#a2aca6] focus:border-[#F06445] focus:ring-4 focus:ring-[#F06445]/10';

export default function DemoRequestPage() {
  const [draft, setDraft] = useState(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const updateField = (field: keyof DemoRequestDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const submitRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const response = await fetch('/api/demo-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...draft, restaurantCount: Number(draft.restaurantCount) }),
      });
      const result = await response.json() as { error?: string; success?: boolean };
      if (!response.ok || !result.success) throw new Error(result.error || 'Votre demande n’a pas pu être envoyée.');
      setSubmitted(true);
      setDraft(initialDraft);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Une erreur est survenue. Réessayez.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f5f7f5] px-4 py-8 text-[#17392D] sm:px-6 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <Link href="/" className="inline-flex items-center gap-2 text-sm font-bold text-[#53655C] transition hover:text-[#E85D3D]">← Accueil DriveVoice</Link>
        <div className="mt-7 grid overflow-hidden rounded-[28px] bg-white shadow-[0_24px_70px_rgba(23,57,45,.1)] lg:grid-cols-[.8fr_1.2fr]">
          <aside className="relative overflow-hidden bg-[#102b22] p-7 text-white sm:p-10 lg:p-12">
            <div aria-hidden="true" className="absolute -right-24 -top-20 h-72 w-72 rounded-full bg-[#F06445]/20 blur-3xl" />
            <div className="relative">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[.06] px-3 py-2 text-[10px] font-extrabold uppercase tracking-[.16em] text-[#ffb19c]">Parlons de votre projet</span>
              <h1 className="mt-6 text-4xl font-extrabold leading-tight tracking-[-.05em] sm:text-5xl">Découvrez DriveVoice dans votre restaurant.</h1>
              <p className="mt-5 text-sm leading-7 text-white/70">Présentez-nous votre établissement et vos besoins. Notre équipe vous recontactera pour préparer une démonstration adaptée.</p>
              <div className="mt-9 space-y-4 text-sm text-white/80">
                <p className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#F06445] text-xs font-black">1</span>Quelques informations sur votre restaurant</p>
                <p className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#F06445] text-xs font-black">2</span>Une démonstration adaptée à vos besoins</p>
                <p className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#F06445] text-xs font-black">3</span>Un échange avec notre équipe</p>
              </div>
            </div>
          </aside>

          <section className="p-6 sm:p-9 lg:p-12">
            {submitted ? (
              <div role="status" className="flex min-h-[420px] flex-col items-start justify-center">
                <span className="grid h-14 w-14 place-items-center rounded-2xl bg-[#e9f5ed] text-2xl font-black text-[#38865c]">✓</span>
                <p className="mt-6 text-xs font-extrabold uppercase tracking-[.16em] text-[#38865c]">Demande envoyée</p>
                <h2 className="mt-2 text-3xl font-extrabold tracking-[-.04em]">Merci pour votre intérêt.</h2>
                <p className="mt-4 max-w-md text-sm leading-6 text-[#65736C]">Votre demande de démonstration a bien été transmise à notre équipe. Nous reviendrons vers vous prochainement.</p>
                <Link href="/" className="mt-7 inline-flex min-h-11 items-center rounded-xl bg-[#F06445] px-5 text-sm font-bold text-white transition hover:bg-[#d95337]">Retour à l’accueil</Link>
              </div>
            ) : (
              <>
                <p className="text-xs font-extrabold uppercase tracking-[.16em] text-[#E85D3D]">Demande de démonstration</p>
                <h2 className="mt-2 text-2xl font-extrabold tracking-[-.04em] sm:text-3xl">Parlez-nous de votre activité</h2>
                <p className="mt-3 text-sm leading-6 text-[#65736C]">Les champs marqués d’un astérisque sont obligatoires.</p>
                <form onSubmit={submitRequest} className="mt-7 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block text-xs font-bold text-[#53655C]">Nom et prénom *
                      <input required minLength={2} maxLength={120} autoComplete="name" value={draft.fullName} onChange={(event) => updateField('fullName', event.target.value)} className={inputClassName} placeholder="Camille Martin" />
                    </label>
                    <label className="block text-xs font-bold text-[#53655C]">Adresse e-mail *
                      <input required type="email" maxLength={254} autoComplete="email" value={draft.email} onChange={(event) => updateField('email', event.target.value)} className={inputClassName} placeholder="camille@restaurant.fr" />
                    </label>
                    <label className="block text-xs font-bold text-[#53655C]">Téléphone *
                      <input required type="tel" minLength={6} maxLength={40} autoComplete="tel" value={draft.phone} onChange={(event) => updateField('phone', event.target.value)} className={inputClassName} placeholder="06 12 34 56 78" />
                    </label>
                    <label className="block text-xs font-bold text-[#53655C]">Restaurant ou enseigne *
                      <input required maxLength={160} autoComplete="organization" value={draft.restaurantName} onChange={(event) => updateField('restaurantName', event.target.value)} className={inputClassName} placeholder="Nom de votre établissement" />
                    </label>
                    <label className="block text-xs font-bold text-[#53655C]">Nombre de restaurants *
                      <input required type="number" min={1} max={10000} step={1} value={draft.restaurantCount} onChange={(event) => updateField('restaurantCount', event.target.value)} className={inputClassName} />
                    </label>
                    <label className="block text-xs font-bold text-[#53655C]">Votre fonction *
                      <select required value={draft.role} onChange={(event) => updateField('role', event.target.value)} className={`${inputClassName} bg-white`}>
                        <option value="">Sélectionner une fonction</option>
                        <option>Propriétaire / franchisé</option>
                        <option>Directeur / directrice</option>
                        <option>Responsable réseau</option>
                        <option>Autre</option>
                      </select>
                    </label>
                  </div>
                  <label className="block text-xs font-bold text-[#53655C]">Comment pouvons-nous vous aider ? *
                    <textarea required minLength={10} maxLength={4000} rows={5} value={draft.message} onChange={(event) => updateField('message', event.target.value)} className={`${inputClassName} resize-y`} placeholder="Décrivez votre besoin, vos questions ou votre projet d’intégration…" />
                  </label>
                  <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
                    <label>Ne pas remplir<input tabIndex={-1} autoComplete="off" value={draft.website} onChange={(event) => updateField('website', event.target.value)} /></label>
                  </div>
                  {error && <p role="alert" className="rounded-xl bg-[#fff0e9] px-4 py-3 text-sm font-semibold text-[#a53d27]">{error}</p>}
                  <button type="submit" disabled={submitting} className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[#F06445] px-5 text-sm font-extrabold text-white shadow-[0_10px_22px_rgba(240,100,69,.2)] transition hover:bg-[#d95337] disabled:cursor-wait disabled:opacity-60">{submitting ? 'Envoi en cours…' : 'Envoyer ma demande'}</button>
                  <p className="text-center text-[11px] leading-5 text-[#89938d]">Vos informations servent uniquement à traiter votre demande de démonstration.</p>
                </form>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
