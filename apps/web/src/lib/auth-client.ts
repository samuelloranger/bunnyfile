import type { Auth } from '@bunnyfile/server';
import { inferAdditionalFields } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  // Same-origin in prod and dev (Vite proxies /api to the server).
  baseURL: typeof window !== 'undefined' ? `${window.location.origin}/api/auth` : '/api/auth',
  plugins: [inferAdditionalFields<Auth>()],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  getSession,
  requestPasswordReset,
  resetPassword,
} = authClient;
