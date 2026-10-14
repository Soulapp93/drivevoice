'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { isSupabaseConfigured, supabase } from '@/lib/supabase/client';

const ADMIN_EMAIL = 'admin@drivevoice.ai';
const ADMIN_PASSWORD = 'Admin2026!';

const subscribeToAuthMode = () => () => undefined;
const getAuthMode = () => new URLSearchParams(window.location.search).get('mode');
const getServerAuthMode = () => null;

export default function LoginPage() {
  const router = useRouter();
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState('');
  const [passwordRecoveryActive, setPasswordRecoveryActive] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const authMode = useSyncExternalStore(subscribeToAuthMode, getAuthMode, getServerAuthMode);
  const resetMode = passwordRecoveryActive || authMode === 'reset' || authMode === 'invite';

  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' && (authMode === 'reset' || authMode === 'invite')) setPasswordRecoveryActive(true);
    });
    return () => data.subscription.unsubscribe();
  }, [authMode]);

  const enterBackOffice = async () => {
    if (!supabase) {
      setNotice('La connexion Supabase n’est pas encore configurée.');
      return;
    }
    setConnecting(true);
    setNotice('');
    const { error } = await supabase.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    if (error) {
      setNotice('Connexion automatique impossible. Veuillez réessayer.');
      setConnecting(false);
      return;
    }
    router.push('/admin');
  };

  const updatePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) {
      setNotice('La connexion Supabase n’est pas encore configurée.');
      return;
    }
    if (newPassword.length < 6) {
      setNotice('Le mot de passe doit contenir au moins 6 caractères.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setNotice('Les deux mots de passe ne correspondent pas.');
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setNotice(error.message);
      return;
    }
    setNotice('Mot de passe mis à jour. Redirection vers le back-office…');
    window.setTimeout(() => router.push('/admin'), 900);
  };

  return (
    <main className="min-h-screen bg-[#f4f6f1] px-5 py-8 text-[#132018] md:px-10">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#ff5a36] text-lg font-black text-white">D</span>
            <div>
              <p className="font-black tracking-[-.04em]">DRIVE<span className="text-[#ff5a36]">VOICE</span></p>
              <p className="text-[9px] font-bold uppercase tracking-[.18em] text-[#7c887f]">Back-office</p>
            </div>
          </div>
          <span className="rounded-full bg-[#e5f6e9] px-3 py-2 text-[10px] font-black text-[#27894a]">Connexion sécurisée</span>
        </header>
        <div className="grid gap-8 py-16 lg:grid-cols-[1fr_1.05fr] lg:items-center">
          <section>
            <p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">DriveVoice OS</p>
            <h1 className="mt-4 max-w-xl text-5xl font-black leading-[.98] tracking-[-.06em] md:text-6xl">Le centre de contrôle DriveVoice.</h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-[#68756c]">Accédez au back-office DriveVoice pour piloter les comptes restaurants clients, le pipeline commercial et la messagerie support.</p>
          </section>
          <section className="rounded-[30px] bg-white p-6 shadow-[0_20px_70px_rgba(11,31,20,.08)] md:p-8">
            {resetMode ? (
              <>
                <p className="text-xs font-black uppercase tracking-widest text-[#8a958d]">Sécurité du compte</p>
                <h2 className="mt-2 text-2xl font-black">Choisir un nouveau mot de passe</h2>
                <p className="mt-2 text-sm leading-relaxed text-[#738078]">Définissez un mot de passe sécurisé pour accéder au back-office DriveVoice.</p>
                <form onSubmit={updatePassword} className="mt-6 space-y-4">
                  <label className="block text-xs font-black text-[#68736a]">
                    Nouveau mot de passe
                    <input required type="password" minLength={6} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" placeholder="6 caractères minimum" />
                  </label>
                  <label className="block text-xs font-black text-[#68736a]">
                    Confirmer le mot de passe
                    <input required type="password" minLength={6} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" placeholder="Répétez votre mot de passe" />
                  </label>
                  <button disabled={!isSupabaseConfigured} className="w-full rounded-xl bg-[#0b1f14] py-3.5 text-sm font-black text-white disabled:opacity-50">Enregistrer le mot de passe</button>
                </form>
              </>
            ) : (
              <>
                <p className="text-xs font-black uppercase tracking-widest text-[#8a958d]">Accès administration</p>
                <h2 className="mt-2 text-2xl font-black">Back-office DriveVoice</h2>
                <p className="mt-2 text-sm leading-relaxed text-[#738078]">Un seul clic pour accéder au centre de contrôle. Les espaces restaurants sont accessibles depuis le back-office.</p>
                <button
                  onClick={enterBackOffice}
                  disabled={connecting || !isSupabaseConfigured}
                  className="mt-6 w-full rounded-xl bg-[#0b1f14] py-3.5 text-sm font-black text-white disabled:opacity-50"
                >
                  {connecting ? 'Connexion en cours…' : 'Accéder au back-office'}
                </button>
              </>
            )}
            {notice && <p role="status" className="mt-4 rounded-xl bg-[#edf7ef] px-4 py-3 text-xs font-bold text-[#287b43]">{notice}</p>}
          </section>
        </div>
      </div>
    </main>
  );
}
