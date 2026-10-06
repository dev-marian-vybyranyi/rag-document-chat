import { AppShell } from './components/AppShell';

export function App() {
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h2 className="text-2xl font-semibold">Ask questions about your documents</h2>
        <p className="mt-3 text-slate-600">Upload a document and start a conversation.</p>
      </div>
    </AppShell>
  );
}
