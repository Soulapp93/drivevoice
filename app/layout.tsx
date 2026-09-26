import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DriveVoice — Assistant de commande vocal',
  description: 'L’agent vocal qui prend les commandes au drive, naturellement et en temps réel.',
  openGraph: {
    title: 'DriveVoice — Assistant de commande vocal',
    description: 'L’agent vocal qui prend vos commandes en temps réel.',
    images: ['https://drivevoice-commandes.soulsang383.chatgpt.site/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DriveVoice — Assistant de commande vocal',
    description: 'L’agent vocal qui prend vos commandes en temps réel.',
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
