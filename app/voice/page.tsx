import { VoicePanel } from '@/components/voice/voice-panel';

export default function VoicePage() {
  return (
    <main className="min-h-screen bg-gray-50 py-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-6 text-center text-2xl font-bold">DriveVoice — Agent vocal</h1>
        <VoicePanel />
      </div>
    </main>
  );
}
