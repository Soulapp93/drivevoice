'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { isSupabaseConfigured, supabase } from '@/lib/supabase/client';

const subscribeToAuthMode = () => () => undefined;
const getAuthMode = () => new URLSearchParams(window.location.search).get('mode');
const getServerAuthMode = () => null;

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordRecoveryActive, setPasswordRecoveryActive] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [notice, setNotice] = useState('');
  const authMode = useSyncExternalStore(subscribeToAuthMode, getAuthMode, getServerAuthMode);
  const resetMode = passwordRecoveryActive || authMode === 'reset' || authMode === 'invite';

  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' && (authMode === 'reset' || authMode === 'invite')) setPasswordRecoveryActive(true);
    });
    return () => data.subscription.unsubscribe();
  }, [authMode]);

  const signIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) {
      setNotice('La connexion Supabase n’est pas encore configurée.');
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setNotice('E-mail ou mot de passe incorrect.');
      return;
    }
    router.push(authMode === 'admin' ? '/admin' : '/restaurant');
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
    setNotice('Mot de passe mis à jour. Redirection vers votre espace…');
    window.setTimeout(() => router.push('/restaurant'), 900);
  };

  return (
    <main className="min-h-screen bg-[#f4f6f1] px-5 py-8 text-[#132018] md:px-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#ff5a36] text-lg font-black text-white">D</span>
            <div>
              <p className="font-black tracking-[-.04em]">DRIVE<span className="text-[#ff5a36]">VOICE</span></p>
              <p className="text-[9px] font-bold uppercase tracking-[.18em] text-[#7c887f]">Platform access</p>
            </div>
          </div>
          <span className="rounded-full bg-[#e5f6e9] px-3 py-2 text-[10px] font-black text-[#27894a]">Connexion sécurisée</span>
        </header>
        <div className="grid gap-8 py-16 lg:grid-cols-[1fr_1.05fr] lg:items-center">
          <section>
            <p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">DriveVoice OS</p>
            <h1 className="mt-4 max-w-xl text-5xl font-black leading-[.98] tracking-[-.06em] md:text-7xl">Un accès clair pour chaque équipe.</h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-[#68756c]">Connectez-vous à votre espace restaurant ou à l’administration de la plateforme.</p>
          </section>
          <section className="rounded-[30px] bg-white p-6 shadow-[0_20px_70px_rgba(11,31,20,.08)] md:p-8">
            {resetMode ? (
              <>
                <p className="text-xs font-black uppercase tracking-widest text-[#8a958d]">Sécurité du compte</p>
                <h2 className="mt-2 text-2xl font-black">Choisir un nouveau mot de passe</h2>
                <p className="mt-2 text-sm leading-relaxed text-[#738078]">Définissez un mot de passe sécurisé pour accéder à votre espace DriveVoice.</p>
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
                <p className="text-xs font-black uppercase tracking-widest text-[#8a958d]">Se connecter</p>
                <h2 className="mt-2 text-2xl font-black">Se connecter avec son mot de passe</h2>
                <form onSubmit={signIn} className="mt-6 space-y-4">
                  <label className="block text-xs font-black text-[#68736a]">
                    E-mail professionnel
                    <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" placeholder="vous@restaurant.fr" />
                  </label>
                  <label className="block text-xs font-black text-[#68736a]">
                    Mot de passe
                    <input required type="password" minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" placeholder="Votre mot de passe" />
                  </label>
                  <button disabled={!isSupabaseConfigured} className="w-full rounded-xl bg-[#0b1f14] py-3.5 text-sm font-black text-white disabled:opacity-50">Se connecter</button>
                </form>
              </>
            )}
            {notice && <p role="status" className="mt-4 rounded-xl bg-[#edf7ef] px-4 py-3 text-xs font-bold text-[#287b43]">{notice}</p>}
            <div className="my-7 flex items-center gap-3 text-[10px] font-black uppercase tracking-widest text-[#a0aaa2]">
              <span className="h-px flex-1 bg-[#e7ebe5]" />Accès plateforme<span className="h-px flex-1 bg-[#e7ebe5]" />
            </div>
            <div className="grid gap-3">
              <button onClick={() => router.push('/login?mode=admin')} className="rounded-2xl border border-[#dfe5de] bg-white p-4 text-left transition hover:border-[#ff5a36] hover:shadow-md">
                <span className="text-[10px] font-black uppercase tracking-widest text-[#7b8b81]">Compte plateforme</span>
                <p className="mt-2 text-sm font-black text-[#132018]">Administrateur DriveVoice</p>
                <p className="mt-1 text-xs text-[#7d8980]">Connexion administrateur sécurisée</p>
              </button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
