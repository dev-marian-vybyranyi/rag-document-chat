import { Navigate, Route, Routes } from 'react-router';
import { ChatsLayout } from './features/chats/ChatsLayout';
import { LoginPage } from './features/auth/LoginPage';
import { RegisterPage } from './features/auth/RegisterPage';
import { RedirectIfAuthenticated, RequireAuth } from './features/auth/RouteGuards';
import { ChatPage } from './pages/ChatPage';
import { HomePage } from './pages/HomePage';

export function App() {
  return (
    <Routes>
      <Route element={<RequireAuth />}>
        <Route element={<ChatsLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/chats/:chatId" element={<ChatPage />} />
        </Route>
      </Route>
      <Route element={<RedirectIfAuthenticated />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
