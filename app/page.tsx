import Link from 'next/link';
import type { ReactNode } from 'react';

type IconName =
  | 'wave'
  | 'clock'
  | 'team'
  | 'chat'
  | 'bolt'
  | 'smile'
  | 'chart'
  | 'star'
  | 'settings'
  | 'shield'
  | 'list'
  | 'check'
  | 'headset'
  | 'store'
  | 'link'
  | 'database'
  | 'lock'
  | 'car'
  | 'arrow'
  | 'play';

const iconArtwork: Record<IconName, ReactNode> = {
  wave: <path d="M4 13v6m5-11v16m5-20v24m5-17v10m5-7v4" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
  team: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-1a6 6 0 0 1 12 0v1H3Zm13-13a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 5" /></>,
  chat: <><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.6 8.6 0 0 1-3.5-.8L4 20l1.5-4A7 7 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" />,
  smile: <><circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></>,
  chart: <><path d="M4 20V11m5 9V5m5 15v-7m5 7V3M2 20h20" /></>,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.6-1.4-2.4L5.5 15a8 8 0 0 1 0-1.9l-1.4-1.2 1.4-2.4 1.7.6a8 8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.6.9l1.7-.6 1.4 2.4-1.4 1.2a8 8 0 0 1-.1 1.9Z" /></>,
  shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  headset: <><path d="M3 13v-2a9 9 0 0 1 18 0v2" /><path d="M5 13h2v6H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2Zm14 0h-2v6h2a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2Zm-7 8h3" /></>,
  store: <><path d="M3 10h18l-2-6H5l-2 6Zm2 0v10h14V10M3 10c0 2 3 3 4 0 1 3 4 3 5 0 1 3 4 3 5 0 1 3 4 2 4 0" /><path d="M9 20v-5h6v5" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 5v2" /></>,
  car: <><path d="m5 11 2-5h10l2 5 2 2v5h-2v2h-2v-2H7v2H5v-2H3v-5l2-2Z" /><path d="M5 11h14M6.5 15h.01M17.5 15h.01" /></>,
  arrow: <><path d="M4 12h15m-6-6 6 6-6 6" /></>,
  play: <><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4V8Z" /></>,
};

function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {iconArtwork[name]}
    </svg>
  );
}

function WaveMark({ inverse = false }: { inverse?: boolean }) {
  return (
    <span className={`grid h-10 w-10 place-items-center rounded-xl ${inverse ? 'bg-white/10 text-[#ff7655]' : 'bg-[#fff0e9] text-[#F06445]'}`}>
      <Icon name="wave" className="h-6 w-6" />
    </span>
  );
}

function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <Link href="/" aria-label="DriveVoice, accueil" className={`flex items-center gap-2.5 ${inverse ? 'text-white' : 'text-[#17392D]'}`}>
      <WaveMark inverse={inverse} />
      <span className="text-[22px] font-extrabold tracking-[-.06em] sm:text-2xl">Drive<span className="text-[#F06445]">Voice</span></span>
    </Link>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  centered = false,
  light = false,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  centered?: boolean;
  light?: boolean;
}) {
  return (
    <div className={`${centered ? 'mx-auto text-center' : ''} max-w-3xl`}>
      <p className={`text-xs font-extrabold uppercase tracking-[.16em] ${light ? 'text-[#ff9478]' : 'text-[#E85D3D]'}`}>{eyebrow}</p>
      <h2 className={`mt-2 text-3xl font-extrabold leading-tight tracking-[-.045em] sm:text-4xl ${light ? 'text-white' : 'text-[#17392D]'}`}>{title}</h2>
      {description && <p className={`mt-4 max-w-2xl text-base leading-7 ${centered ? 'mx-auto' : ''} ${light ? 'text-white/70' : 'text-[#596B63]'}`}>{description}</p>}
    </div>
  );
}

function BenefitCard({ icon, title, description }: { icon: IconName; title: string; description: string }) {
  return (
    <article className="group rounded-2xl border border-[#e5e9e6] bg-white p-5 shadow-[0_8px_24px_rgba(23,57,45,.035)] transition duration-200 hover:-translate-y-1 hover:border-[#f2c8b9] hover:shadow-[0_18px_36px_rgba(23,57,45,.09)] sm:p-6">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#fff2eb] text-[#E85D3D] transition group-hover:bg-[#F06445] group-hover:text-white">
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <h3 className="mt-5 text-base font-bold text-[#17392D]">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[#65736C]">{description}</p>
    </article>
  );
}

const challenges = [
  { icon: 'clock' as const, title: 'Des files d’attente qui s’allongent', description: 'Les pics d’affluence mettent la rapidité du service à l’épreuve.' },
  { icon: 'team' as const, title: 'Une forte charge pour les équipes', description: 'Vos équipes jonglent entre les commandes, la préparation et l’accueil.' },
  { icon: 'chat' as const, title: 'Des commandes parfois imprécises', description: 'Le bruit et les demandes complexes peuvent compliquer les échanges.' },
];

const benefits = [
  { icon: 'bolt' as const, title: 'Un service plus rapide', description: 'La prise de commande reste fluide, même pendant les périodes chargées.' },
  { icon: 'smile' as const, title: 'Moins d’erreurs', description: 'Chaque demande est reformulée et vérifiée avant sa transmission.' },
  { icon: 'chart' as const, title: 'Des équipes libérées', description: 'Moins de tâches répétitives, plus de temps pour vos clients.' },
  { icon: 'star' as const, title: 'Une expérience client soignée', description: 'Un échange naturel, attentif et disponible à chaque commande.' },
  { icon: 'settings' as const, title: 'Une solution clé en main', description: 'Une expérience simple à prendre en main et adaptée à votre service.' },
  { icon: 'shield' as const, title: 'Un service fiable', description: 'Une technologie conçue pour s’intégrer aux habitudes du restaurant.' },
];

const processSteps = [
  { icon: 'chat' as const, title: 'Le client parle', description: 'Il passe sa commande naturellement.' },
  { icon: 'wave' as const, title: 'L’IA comprend', description: 'Elle analyse et interprète la demande en temps réel.' },
  { icon: 'list' as const, title: 'La commande est vérifiée', description: 'Elle s’appuie sur votre carte et vos options.' },
  { icon: 'check' as const, title: 'Elle est transmise', description: 'La commande rejoint les outils connectés.' },
  { icon: 'team' as const, title: 'L’équipe prépare', description: 'La préparation suit le rythme du service.' },
  { icon: 'car' as const, title: 'Le client reçoit', description: 'Une expérience plus simple, sans friction.' },
];

const faqs = [
  { question: 'Comment fonctionne la commande vocale ?', answer: 'DriveVoice accueille la demande, échange avec le client, vérifie les articles et options disponibles, puis transmet la commande aux outils connectés du restaurant.' },
  { question: 'Faut-il changer de caisse ou de matériel ?', answer: 'L’objectif est de s’intégrer à votre environnement existant. La compatibilité dépend de votre caisse et de vos connecteurs ; l’équipe peut la vérifier avec vous.' },
  { question: 'Que se passe-t-il si la demande est complexe ?', answer: 'Si une situation nécessite une attention particulière, la conversation peut être transférée à un membre de l’équipe pour qu’il reprenne la main.' },
  { question: 'Le catalogue du restaurant peut-il être synchronisé ?', answer: 'Oui. DriveVoice peut s’appuyer sur un catalogue connecté, notamment via HubRise, afin de reprendre les produits et informations disponibles.' },
  { question: 'Comment découvrir DriveVoice ?', answer: 'Demandez une démonstration personnalisée : notre équipe vous recontactera pour échanger sur votre restaurant.' },
];

export default function HomePage() {
  return (
    <main className="overflow-x-clip bg-white text-[#17392D]">
      <header className="sticky top-0 z-40 border-b border-[#e7ebe8] bg-white/95 shadow-[0_2px_12px_rgba(23,57,45,.035)] backdrop-blur-xl">
        <div className="mx-auto flex min-h-[74px] max-w-[1320px] items-center justify-between gap-5 px-5 sm:px-8">
          <Brand />
          <nav aria-label="Navigation principale" className="hidden items-center gap-7 text-[13px] font-semibold text-[#53655C] lg:flex">
            <a href="#avantages" className="transition hover:text-[#E85D3D]">Avantages</a>
            <a href="#fonctionnement" className="transition hover:text-[#E85D3D]">Fonctionnement</a>
            <a href="#integrations" className="transition hover:text-[#E85D3D]">Intégrations</a>
            <a href="#securite" className="transition hover:text-[#E85D3D]">Sécurité</a>
            <a href="#faq" className="transition hover:text-[#E85D3D]">FAQ</a>
          </nav>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <Link href="/login" className="hidden min-h-10 items-center rounded-xl border border-[#dce4df] px-4 text-sm font-bold text-[#17392D] transition hover:border-[#17392D] sm:inline-flex">Se connecter</Link>
            <Link href="/demo-request" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[#F06445] px-3.5 text-xs font-bold text-white shadow-[0_7px_18px_rgba(240,100,69,.2)] transition hover:-translate-y-0.5 hover:bg-[#d95337] sm:px-4 sm:text-sm">Voir une démo <Icon name="arrow" className="h-4 w-4" /></Link>
          </div>
        </div>
        <nav aria-label="Navigation mobile" className="flex gap-5 overflow-x-auto border-t border-[#eef0ed] px-5 py-2.5 text-xs font-semibold text-[#53655C] lg:hidden sm:px-8">
          <a href="#avantages" className="whitespace-nowrap">Avantages</a>
          <a href="#fonctionnement" className="whitespace-nowrap">Fonctionnement</a>
          <a href="#integrations" className="whitespace-nowrap">Intégrations</a>
          <a href="#securite" className="whitespace-nowrap">Sécurité</a>
          <a href="#faq" className="whitespace-nowrap">FAQ</a>
        </nav>
      </header>

      <section className="relative isolate overflow-hidden bg-[#fbfcfa]">
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_5%_20%,rgba(226,237,229,.55),transparent_42%)]" />
        <div className="mx-auto grid max-w-[1320px] items-center gap-9 px-5 py-12 sm:px-8 sm:py-16 lg:min-h-[580px] lg:grid-cols-[.87fr_1.13fr] lg:gap-10 lg:py-12">
          <div className="relative z-10 max-w-[590px]">
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#dfe8e2] bg-white px-3.5 py-2 text-xs font-bold text-[#53655C] shadow-sm">
              <span className="h-2 w-2 rounded-full bg-[#F06445]" />
              La commande au drive, autrement
            </p>
            <h1 className="text-[clamp(2.7rem,5.4vw,5rem)] font-extrabold leading-[.99] tracking-[-.065em] text-[#17392D]">La prise de commande au drive, <span className="text-[#F06445]">plus fluide grâce à la voix.</span></h1>
            <p className="mt-6 max-w-[510px] text-base leading-7 text-[#56695F] sm:text-lg sm:leading-8">Une solution vocale en temps réel, connectée au catalogue de votre restaurant et conçue pour accompagner vos équipes pendant le service.</p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Link href="/demo-request" className="inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-[#F06445] px-5 text-sm font-bold text-white shadow-[0_12px_24px_rgba(240,100,69,.2)] transition hover:-translate-y-0.5 hover:bg-[#d95337]">Voir une démonstration <Icon name="arrow" className="h-4 w-4" /></Link>
              <a href="#fonctionnement" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-[#dce4df] bg-white px-5 text-sm font-bold text-[#17392D] transition hover:border-[#F06445] hover:text-[#d95337]"><Icon name="play" className="h-4 w-4 text-[#F06445]" /> Voir le fonctionnement</a>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-5 gap-y-3 text-xs font-semibold text-[#53655C]">
              <span className="inline-flex items-center gap-2"><Icon name="clock" className="h-4 w-4 text-[#E85D3D]" /> Commande en temps réel</span>
              <span className="inline-flex items-center gap-2"><Icon name="shield" className="h-4 w-4 text-[#E85D3D]" /> Catalogue connecté</span>
              <span className="inline-flex items-center gap-2"><Icon name="link" className="h-4 w-4 text-[#E85D3D]" /> POS et outils compatibles</span>
            </div>
          </div>
          <div className="relative min-h-[340px] sm:min-h-[430px] lg:min-h-[500px]">
            <div className="absolute inset-0 overflow-hidden rounded-[28px] bg-[#e5e9e1] shadow-[0_28px_70px_rgba(23,57,45,.18)]">
              <img src="/drivevoice-hero.jpg" alt="Borne de commande vocale DriveVoice installée au drive d’un restaurant" fetchPriority="high" className="h-full w-full object-cover object-center" />
              <div className="absolute inset-0 bg-gradient-to-r from-[#132b20]/15 via-transparent to-[#132b20]/5" />
            </div>
            <div className="absolute -bottom-4 left-4 flex max-w-[250px] items-center gap-3 rounded-2xl border border-white/80 bg-white/95 p-3.5 shadow-[0_16px_38px_rgba(23,57,45,.16)] sm:bottom-6 sm:-left-8 sm:p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#eaf3ec] text-[#2d7150]"><Icon name="check" className="h-6 w-6" /></span>
              <span><strong className="block text-xs text-[#17392D]">Catalogue connecté</strong><small className="mt-1 block text-[11px] text-[#64736B]">Des commandes alignées sur votre carte</small></span>
            </div>
            <div className="absolute right-3 top-4 inline-flex items-center gap-2 rounded-full border border-white/75 bg-white/95 px-3.5 py-2 text-[11px] font-bold text-[#17392D] shadow-md sm:right-5 sm:top-6"><span className="h-2 w-2 animate-pulse rounded-full bg-[#F06445]" /> Une voix, en temps réel</div>
          </div>
        </div>
      </section>

      <section className="bg-[#f1f5f7] py-14 sm:py-16">
        <div className="mx-auto max-w-[1320px] px-5 sm:px-8">
          <SectionHeading eyebrow="Un constat simple" title="Le drive fait face à de vrais défis au quotidien." description="Quand le rythme s’accélère, chaque étape compte pour garder un service accueillant et efficace." />
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {challenges.map((item) => (
              <article key={item.title} className="flex gap-4 rounded-2xl border border-white bg-white/90 p-5 shadow-[0_8px_24px_rgba(24,43,59,.04)] sm:p-6">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#fff0e9] text-[#E85D3D]"><Icon name={item.icon} className="h-6 w-6" /></span>
                <div><h3 className="text-sm font-bold text-[#17392D]">{item.title}</h3><p className="mt-2 text-sm leading-6 text-[#64736B]">{item.description}</p></div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="avantages" className="scroll-mt-28 bg-[linear-gradient(110deg,#fff8f3_0%,#fffdfb_55%,#f4f8f5_100%)] py-14 sm:py-16">
        <div className="mx-auto max-w-[1320px] px-5 sm:px-8">
          <SectionHeading eyebrow="Des bénéfices concrets" title="Une expérience drive plus simple, plus rapide, plus efficace." description="DriveVoice accompagne la commande et laisse à vos équipes plus de place pour l’essentiel : le service." />
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {benefits.map((item) => <BenefitCard key={item.title} {...item} />)}
          </div>
        </div>
      </section>

      <section id="fonctionnement" className="scroll-mt-28 bg-white py-14 sm:py-16">
        <div className="mx-auto max-w-[1320px] px-5 sm:px-8">
          <SectionHeading eyebrow="Comment ça marche ?" title="De la voix à la commande en 6 étapes." description="Un parcours clair pour le client comme pour l’équipe en cuisine." />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            {processSteps.map((step, index) => (
              <article key={step.title} className="relative rounded-2xl border border-[#e9eeeb] bg-[#fbfcfa] p-4 sm:p-5">
                <span className="absolute -left-1.5 -top-2 grid h-7 w-7 place-items-center rounded-full border-2 border-white bg-[#F06445] text-xs font-extrabold text-white">{index + 1}</span>
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#eaf0f4] text-[#17392D]"><Icon name={step.icon} className="h-6 w-6" /></span>
                <h3 className="mt-4 text-sm font-bold text-[#17392D]">{step.title}</h3>
                <p className="mt-2 text-xs leading-5 text-[#68776F]">{step.description}</p>
                {index < processSteps.length - 1 && <Icon name="arrow" className="absolute -right-3 top-9 z-10 hidden h-5 w-5 text-[#aabac4] xl:block" />}
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-[#f3f6f8] py-14 sm:py-16">
        <div className="mx-auto max-w-[1320px] px-5 sm:px-8">
          <SectionHeading eyebrow="Une conversation naturelle" title="Une prise de commande fluide et naturelle." description="L’assistant écoute, précise la demande si besoin, puis confirme les choix du client." />
          <div className="mt-8 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
            <div className="rounded-[26px] border border-white bg-white p-5 shadow-[0_14px_40px_rgba(23,57,45,.06)] sm:p-7">
              <p className="mb-5 text-[11px] font-bold uppercase tracking-[.12em] text-[#718078]">Exemple d’échange</p>
              <div className="space-y-4">
                <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#edf2f5] text-[#17392D]"><Icon name="car" className="h-5 w-5" /></span><div className="max-w-[88%] rounded-2xl rounded-tl-sm bg-[#edf2f5] px-4 py-3 text-sm leading-6 text-[#344d5d]">Bonjour, je voudrais un menu burger avec une grande frite, s’il vous plaît.</div></div>
                <div className="flex items-start justify-end gap-3"><div className="max-w-[88%] rounded-2xl rounded-tr-sm bg-[#fff0e9] px-4 py-3 text-sm leading-6 text-[#824331]">Bien sûr. Quelle boisson souhaitez-vous avec votre menu ?</div><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#F06445] text-white"><Icon name="wave" className="h-5 w-5" /></span></div>
                <div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#edf2f5] text-[#17392D]"><Icon name="car" className="h-5 w-5" /></span><div className="max-w-[88%] rounded-2xl rounded-tl-sm bg-[#edf2f5] px-4 py-3 text-sm leading-6 text-[#344d5d]">Une eau, merci.</div></div>
                <div className="flex items-start justify-end gap-3"><div className="max-w-[88%] rounded-2xl rounded-tr-sm bg-[#fff0e9] px-4 py-3 text-sm leading-6 text-[#824331]">Parfait, votre commande est enregistrée. Vous pouvez avancer jusqu’au prochain point de service.</div><span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#F06445] text-white"><Icon name="wave" className="h-5 w-5" /></span></div>
              </div>
            </div>
            <aside className="rounded-[26px] border border-white bg-white p-5 shadow-[0_14px_40px_rgba(23,57,45,.06)] sm:p-7">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-[#f5f7f5] px-4 py-3"><span className="inline-flex items-center gap-2 text-xs font-bold text-[#17392D]"><span className="h-2 w-2 rounded-full bg-[#F06445]" /> Panier en temps réel</span><span className="text-[10px] font-semibold text-[#748179]">Exemple</span></div>
              <div className="divide-y divide-[#edf0ed]">
                {[['Menu burger', 'Burger · frites · boisson'], ['Grande frite', 'Format grande'], ['Eau', 'Boisson fraîche']].map(([name, detail], index) => (
                  <div key={name} className="flex items-center gap-3 py-4"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#fff4ed] text-sm font-extrabold text-[#E85D3D]">{index + 1}</span><div><p className="text-sm font-bold text-[#17392D]">{name}</p><p className="mt-1 text-xs text-[#758078]">{detail}</p></div><Icon name="check" className="ml-auto h-5 w-5 text-[#38865c]" /></div>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-3 rounded-xl border border-[#e7ede8] bg-[#fbfcfb] p-3 text-xs leading-5 text-[#637169]"><Icon name="check" className="h-5 w-5 shrink-0 text-[#38865c]" /> Le client peut confirmer ou corriger sa commande avant transmission.</div>
            </aside>
          </div>
        </div>
      </section>

      <section className="bg-white py-14 sm:py-16">
        <div className="mx-auto grid max-w-[1320px] items-center gap-7 px-5 sm:px-8 lg:grid-cols-[.9fr_1.1fr] lg:gap-12">
          <div>
            <SectionHeading eyebrow="Un transfert humain si nécessaire" title="Vos équipes gardent toujours la main." description="En cas de demande particulière ou de situation complexe, un membre de l’équipe peut reprendre l’échange et accompagner le client." />
            <ul className="mt-6 space-y-3 text-sm font-medium text-[#53655C]">
              {['Le contexte de la commande est conservé', 'La prise en charge reste simple et naturelle', 'Vos équipes reprennent la main au bon moment'].map((line) => <li key={line} className="flex items-start gap-3"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#17392D] text-white"><Icon name="check" className="h-3.5 w-3.5" /></span>{line}</li>)}
            </ul>
          </div>
          <div className="relative min-h-[320px] overflow-hidden rounded-[28px] bg-[#e7e8df] shadow-[0_24px_58px_rgba(23,57,45,.16)] sm:min-h-[400px]">
            <img src="/drivevoice-team.jpg" alt="Membre d’une équipe de restaurant à l’écoute avec son casque" loading="lazy" className="absolute inset-0 h-full w-full object-cover object-center" />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#10251b]/85 via-[#10251b]/30 to-transparent p-6 pt-20 sm:p-8 sm:pt-24">
              <div className="max-w-sm rounded-2xl border border-white/20 bg-white/95 p-4 shadow-xl backdrop-blur">
                <span className="inline-flex items-center gap-2 text-xs font-bold text-[#E85D3D]"><Icon name="headset" className="h-4 w-4" /> Relais vers l’équipe</span>
                <p className="mt-2 text-sm font-bold text-[#17392D]">Un service assisté, jamais déconnecté de vos équipes.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="integrations" className="scroll-mt-28 bg-[#f1f5f7] py-14 sm:py-16">
        <div className="mx-auto max-w-[1320px] px-5 sm:px-8">
          <SectionHeading eyebrow="Des intégrations simples" title="Une solution qui s’adapte à votre environnement." description="Connectez le catalogue et les outils de commande que votre restaurant utilise déjà." />
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              { icon: 'store' as const, title: 'Votre caisse et vos écrans', description: 'Les commandes rejoignent les outils compatibles de votre établissement.' },
              { icon: 'link' as const, title: 'Connecteur HubRise', description: 'Un point de connexion pour synchroniser le catalogue et les commandes.' },
              { icon: 'database' as const, title: 'Votre catalogue restaurant', description: 'Produits, options et disponibilités s’appuient sur les données connectées.' },
            ].map((item) => <BenefitCard key={item.title} {...item} />)}
          </div>
          <p className="mt-5 text-xs leading-5 text-[#718078]">Les possibilités de connexion dépendent de votre caisse et de sa compatibilité.</p>
        </div>
      </section>

      <section className="bg-white py-14 sm:py-16">
        <div className="mx-auto grid max-w-[1320px] items-center gap-9 px-5 sm:px-8 lg:grid-cols-[.72fr_1.28fr] lg:gap-12">
          <div>
            <SectionHeading eyebrow="Un suivi en temps réel" title="Toutes vos commandes, dans un tableau de bord unique." description="Retrouvez l’activité du service et les indicateurs disponibles dans votre espace restaurant." />
            <Link href="/restaurant?tab=dashboard" className="mt-6 inline-flex min-h-11 items-center gap-2 text-sm font-bold text-[#d95337] transition hover:gap-3">Découvrir l’espace restaurant <Icon name="arrow" className="h-4 w-4" /></Link>
          </div>
          <div className="overflow-hidden rounded-[24px] border border-[#263e52] bg-[#10283c] p-4 text-white shadow-[0_24px_64px_rgba(16,40,60,.2)] sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
              <div className="flex items-center gap-2.5"><WaveMark inverse /><div><p className="text-sm font-extrabold">DriveVoice</p><p className="mt-0.5 text-[10px] text-white/50">Espace restaurant</p></div></div>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-semibold text-white/65">Aperçu de l’interface</span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {[['Commandes', 'Suivi du service'], ['Catalogue', 'Articles connectés'], ['Activité', 'Vue d’ensemble']].map(([title, detail]) => <div key={title} className="rounded-xl border border-white/10 bg-white/[.06] p-3.5"><p className="text-[10px] font-medium text-white/45">{title}</p><p className="mt-2 text-sm font-bold">{detail}</p><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><span className="block h-full w-2/3 rounded-full bg-[#F06445]" /></div></div>)}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-[1.2fr_.8fr]">
              <div className="rounded-xl border border-white/10 bg-white/[.06] p-4"><div className="flex items-center justify-between"><p className="text-xs font-bold">Activité des commandes</p><span className="text-[10px] text-white/40">Interface illustrée</span></div><div className="mt-5 flex h-28 items-end gap-2 border-b border-l border-white/10 px-2">{[28, 52, 39, 70, 49, 84, 58, 93, 64, 76, 51, 87].map((height, index) => <span key={index} className="flex-1 rounded-t-sm bg-gradient-to-t from-[#F06445] to-[#ffaf83] opacity-90" style={{ height: `${height}%` }} />)}</div><div className="mt-2 flex justify-between text-[9px] text-white/35"><span>Début de service</span><span>En cours</span><span>Fin de service</span></div></div>
              <div className="rounded-xl border border-white/10 bg-white/[.06] p-4"><p className="text-xs font-bold">Suivi en un coup d’œil</p><div className="mt-4 flex items-center gap-3"><span className="grid h-12 w-12 place-items-center rounded-full border-[5px] border-[#F06445] border-r-[#69c9a0] text-[10px] font-bold">Vue</span><p className="text-xs leading-5 text-white/65">Une interface pensée pour suivre l’activité de votre restaurant.</p></div><div className="mt-4 space-y-2"><span className="block h-1.5 w-full rounded-full bg-white/10" /><span className="block h-1.5 w-4/5 rounded-full bg-white/10" /><span className="block h-1.5 w-3/5 rounded-full bg-white/10" /></div></div>
            </div>
            <p className="mt-3 text-[10px] text-white/40">Illustration de l’interface — aucun indicateur chiffré n’est simulé.</p>
          </div>
        </div>
      </section>

      <section id="securite" className="scroll-mt-28 bg-[#f6f8f6] py-14 sm:py-16">
        <div className="mx-auto max-w-[1320px] px-5 sm:px-8">
          <SectionHeading eyebrow="Sécurité et maîtrise" title="Une solution pensée pour votre environnement professionnel." description="Des accès et des échanges conçus pour accompagner les usages du restaurant." />
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              { icon: 'shield' as const, title: 'Échanges protégés', description: 'Une attention particulière portée à la protection des échanges et des données.' },
              { icon: 'lock' as const, title: 'Accès maîtrisés', description: 'Des profils et des accès adaptés aux responsabilités de chaque membre.' },
              { icon: 'list' as const, title: 'Conçu pour le terrain', description: 'Une expérience pensée pour rester claire pendant les moments de forte activité.' },
            ].map((item) => <BenefitCard key={item.title} {...item} />)}
          </div>
        </div>
      </section>

      <section id="demo" className="scroll-mt-28 bg-[#102b22] py-12 text-white sm:py-14">
        <div className="mx-auto grid max-w-[1320px] items-center gap-8 px-5 sm:px-8 lg:grid-cols-[1fr_auto]">
          <div>
            <p className="text-xs font-extrabold uppercase tracking-[.16em] text-[#ff9478]">Votre drive, plus efficace dès demain</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-extrabold leading-tight tracking-[-.04em] sm:text-4xl">Prêt à découvrir la commande vocale ?</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-white/70">Explorez les démonstrations DriveVoice et voyez comment la voix peut s’intégrer à votre service.</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
            <Link href="/demo-request" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#F06445] px-5 text-sm font-bold text-white transition hover:bg-[#d95337]">Demander une démonstration <Icon name="arrow" className="h-4 w-4" /></Link>
            <Link href="/login" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/20 px-5 text-sm font-bold text-white transition hover:border-white hover:bg-white/5">Accéder au back-office</Link>
          </div>
        </div>
      </section>

      <section id="faq" className="scroll-mt-28 bg-white py-14 sm:py-16">
        <div className="mx-auto grid max-w-[1320px] gap-8 px-5 sm:px-8 lg:grid-cols-[.65fr_1.35fr] lg:gap-14">
          <div><SectionHeading eyebrow="Questions fréquentes" title="Vos questions, nos réponses." description="Les points essentiels pour mieux comprendre la solution." /></div>
          <div className="space-y-3">
            {faqs.map((item) => <details key={item.question} className="group rounded-2xl border border-[#e4eae6] bg-[#fbfcfa] px-5 py-4 open:bg-white open:shadow-[0_10px_26px_rgba(23,57,45,.05)]"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-bold text-[#17392D] marker:hidden [&::-webkit-details-marker]:hidden">{item.question}<span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#fff0e9] text-[#E85D3D] transition group-open:rotate-45"><span className="text-lg font-normal leading-none">+</span></span></summary><p className="max-w-3xl pt-3 pr-10 text-sm leading-6 text-[#64736B]">{item.answer}</p></details>)}
          </div>
        </div>
      </section>

      <footer className="border-t border-[#e5eae6] bg-[#fbfcfa]">
        <div className="mx-auto flex max-w-[1320px] flex-col gap-6 px-5 py-7 sm:px-8 md:flex-row md:items-center md:justify-between">
          <div><Brand /><p className="mt-2 text-xs text-[#738078]">La commande au drive, plus fluide grâce à la voix.</p></div>
          <nav aria-label="Navigation de pied de page" className="flex flex-wrap gap-x-5 gap-y-3 text-xs font-semibold text-[#53655C]"><a href="#avantages" className="hover:text-[#E85D3D]">Avantages</a><a href="#fonctionnement" className="hover:text-[#E85D3D]">Fonctionnement</a><a href="#integrations" className="hover:text-[#E85D3D]">Intégrations</a><a href="#securite" className="hover:text-[#E85D3D]">Sécurité</a><a href="#faq" className="hover:text-[#E85D3D]">FAQ</a></nav>
          <Link href="/login" className="inline-flex min-h-10 w-fit items-center gap-2 rounded-xl bg-[#F06445] px-4 text-xs font-bold text-white transition hover:bg-[#d95337]">Se connecter <Icon name="arrow" className="h-4 w-4" /></Link>
        </div>
        <div className="border-t border-[#e5eae6] px-5 py-4 text-center text-[11px] text-[#89938d]">© {new Date().getFullYear()} DriveVoice. Tous droits réservés.</div>
      </footer>
    </main>
  );
}
