import type { App } from '@bunnyfile/server';
import { treaty } from '@elysiajs/eden';

// Always hit the same origin the browser loaded from. In dev, Vite proxies /api
// to the server process (see vite.config.ts). In prod, Elysia serves both /api
// and the SPA from the same host. Never embed a backend URL in the client bundle.
export const api = treaty<App>(
  typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3901',
);
