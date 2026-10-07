import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DriveVoice — Commande vocale au drive',
  description: 'Fluidifiez les commandes au drive grâce à une solution vocale en temps réel, connectée au catalogue et aux outils de votre restaurant.',
  openGraph: {
    title: 'DriveVoice — Commande vocale au drive',
    description: 'Fluidifiez les commandes au drive avec une expérience vocale naturelle et connectée.',
    images: ['https://drivevoice-commandes.soulsang383.chatgpt.site/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DriveVoice — Commande vocale au drive',
    description: 'Fluidifiez les commandes au drive avec une expérience vocale naturelle et connectée.',
    images: ['https://drivevoice-commandes.soulsang383.chatgpt.site/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body
        className="antialiased"
      >
        {children}
      </body>
    </html>
  );
}
