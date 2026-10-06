import { AppShell } from '@/components/AppShell';
import { UserMenu } from '@/features/auth/UserMenu';

export function HomePage() {
  return (
    <AppShell headerRight={<UserMenu />}>
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h2 className="text-2xl font-semibold">Ask questions about your documents</h2>
        <p className="mt-3 text-muted-foreground">Upload a document and start a conversation.</p>
      </div>
    </AppShell>
  );
}
