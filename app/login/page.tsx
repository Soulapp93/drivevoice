'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { isSupabaseConfigured, supabase } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState('');

  const signIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) {
      setNotice('La connexion Supabase n’est pas encore configurée.');
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setNotice('E-mail ou mot de passe incorrect. Pour créer votre accès, utilisez le lien d’activation.');
      return;
    }
    router.push('/');
  };

  const requestAccountLink = async () => {
    if (!supabase || !email.trim()) {
      setNotice('Saisissez votre e-mail professionnel pour recevoir le lien de création.');
      return;
    }
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/login` },
    });
    setNotice(error ? error.message : 'Lien de création envoyé. Consultez votre messagerie professionnelle.');
  };

  return (
    <main className="min-h-screen bg-[#f4f6f1] px-5 py-8 text-[#132018] md:px-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#ff5a36] text-lg font-black text-white">D</span><div><p className="font-black tracking-[-.04em]">DRIVE<span className="text-[#ff5a36]">VOICE</span></p><p className="text-[9px] font-bold uppercase tracking-[.18em] text-[#7c887f]">Platform access</p></div></div>
          <span className="rounded-full bg-[#e5f6e9] px-3 py-2 text-[10px] font-black text-[#27894a]">Connexion sécurisée</span>
        </header>
        <div className="grid gap-8 py-16 lg:grid-cols-[1fr_1.05fr] lg:items-center">
          <section><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">DriveVoice OS</p><h1 className="mt-4 max-w-xl text-5xl font-black leading-[.98] tracking-[-.06em] md:text-7xl">Un accès clair pour chaque équipe.</h1><p className="mt-6 max-w-lg text-lg leading-relaxed text-[#68756c]">Connectez-vous à votre espace restaurant ou à l’administration de la plateforme.</p></section>
          <section className="rounded-[30px] bg-white p-6 shadow-[0_20px_70px_rgba(11,31,20,.08)] md:p-8">
            <p className="text-xs font-black uppercase tracking-widest text-[#8a958d]">Se connecter</p>
            <h2 className="mt-2 text-2xl font-black">Se connecter avec son mot de passe</h2>
            <form onSubmit={signIn} className="mt-6 space-y-4"><label className="block text-xs font-black text-[#68736a]">E-mail professionnel<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" placeholder="vous@restaurant.fr" /></label><label className="block text-xs font-black text-[#68736a]">Mot de passe<input required type="password" minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-4 py-3 text-sm outline-none focus:border-[#ff5a36]" placeholder="Votre mot de passe" /></label><button disabled={!isSupabaseConfigured} className="w-full rounded-xl bg-[#0b1f14] py-3.5 text-sm font-black text-white disabled:opacity-50">Se connecter</button></form>
            <button type="button" onClick={requestAccountLink} disabled={!isSupabaseConfigured} className="mt-4 w-full text-xs font-black text-[#ff5a36] underline-offset-4 hover:underline disabled:opacity-50">Créer ou activer mon compte par e-mail</button>
            {notice && <p role="status" className="mt-4 rounded-xl bg-[#edf7ef] px-4 py-3 text-xs font-bold text-[#287b43]">{notice}</p>}
            <div className="my-7 flex items-center gap-3 text-[10px] font-black uppercase tracking-widest text-[#a0aaa2]"><span className="h-px flex-1 bg-[#e7ebe5]" />Démo<span className="h-px flex-1 bg-[#e7ebe5]" /></div>
            <div className="grid gap-3 sm:grid-cols-2"><button onClick={() => router.push('/')} className="rounded-2xl border border-[#dfe5de] p-4 text-left hover:border-[#ff5a36]"><span className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Compte restaurant</span><p className="mt-2 text-sm font-black">BK Paris République</p><p className="mt-1 text-xs text-[#7d8980]">Espace client restaurant</p></button><button onClick={() => router.push('/admin?demo=true')} className="rounded-2xl bg-[#0b1f14] p-4 text-left text-white"><span className="text-[10px] font-black uppercase tracking-widest text-[#ffc647]">Compte plateforme</span><p className="mt-2 text-sm font-black">Administrateur DriveVoice</p><p className="mt-1 text-xs text-white/50">Back-office global</p></button></div>
          </section>
        </div>
      </div>
    </main>
  );
}