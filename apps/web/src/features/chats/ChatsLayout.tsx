import { Outlet } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { UserMenu } from '@/features/auth/UserMenu';
import { ChatSidebar } from './ChatSidebar';
import { ChatsProvider } from './ChatsProvider';

export function ChatsLayout() {
  return (
    <ChatsProvider>
      <AppShell headerRight={<UserMenu />} sidebar={<ChatSidebar />}>
        <Outlet />
      </AppShell>
    </ChatsProvider>
  );
}
