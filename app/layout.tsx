import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

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
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
