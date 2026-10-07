import { Outlet } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { UserMenu } from '@/features/auth/UserMenu';
import { DocumentsProvider } from '../documents/DocumentsProvider';
import { ChatSidebar } from './ChatSidebar';
import { ChatsProvider } from './ChatsProvider';

export function ChatsLayout() {
  return (
    <ChatsProvider>
      <DocumentsProvider>
        <AppShell headerRight={<UserMenu />} sidebar={<ChatSidebar />}>
          <Outlet />
        </AppShell>
      </DocumentsProvider>
    </ChatsProvider>
  );
}
