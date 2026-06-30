import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_NAME, type HealthStatus } from '@bunnyfile/shared';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { count } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { auth } from './auth/auth';
import { isTrustedOrigin } from './auth/origins';
import { db } from './db';
import { runMigrations } from './db/migrate';
import { user } from './db/schema';
import { filesCron } from './files/cron';
import { filesRoutes } from './files/routes';
import { rebuildFileSearchIndex } from './files/search';
import { filesWatcher } from './files/watcher';
import { drainUploads } from './inflight';
import { prometheusMetrics, recordHttpRequest } from './metrics';
import { accessKeyRoutes } from './s3/access-keys';
import { s3Routes } from './s3/routes';
import { allowShareRequest, requestIp } from './shares/rate-limit';
import { sharesRoutes } from './shares/routes';
import { usersRoutes } from './users/routes';

const startedAt = Date.now();
const version = Bun.env.APP_VERSION ?? '0.0.1';

const WEB_DIST = resolve(import.meta.dir, '../../web/dist');
const INDEX_HTML = join(WEB_DIST, 'index.html');

export const app = new Elysia({ serve: { maxRequestBodySize: 50 * 1024 ** 3 } })
  .onRequest(() => {
    recordHttpRequest();
  })
  .use(
    swagger({
      path: '/api/docs',
      documentation: {
        info: { title: 'BunnyFile API', version },
        tags: [
          { name: 'files', description: 'File operations' },
          { name: 'shares', description: 'Share links' },
          { name: 'users', description: 'User management' },
          { name: 'settings', description: 'Settings and access keys' },
        ],
      },
      exclude: [/^\/api\/s3/, /^\/api\/auth/],
    }),
  )
  .use(
    cors({
      // Accept localhost / RFC1918 / env-allowed origins (see auth/origins.ts).
      origin: (request) => isTrustedOrigin(request.headers.get('origin')),
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  )
  // better-auth handles every /api/auth/* route. Register per-method so the
  // GET handler doesn't lose to the SPA fallback `.get('/*', ...)` below.
  .get('/api/auth/*', ({ request }) => auth.handler(request))
  .post('/api/auth/*', async ({ request, set }) => {
    const path = new URL(request.url).pathname;
    // Block public self-registration once the instance is set up. The first
    // user (admin) is created during /setup; afterwards new accounts come only
    // from admin invites, which call auth.api server-side and bypass this HTTP
    // route. Without this, /api/auth/sign-up/email is open to anyone.
    if (path.endsWith('/sign-up/email')) {
      const [row] = await db.select({ c: count() }).from(user);
      if ((row?.c ?? 0) > 0) {
        set.status = 403;
        return { error: 'public sign-up is disabled — ask an admin for an invite' };
      }
    }
    // Throttle credential endpoints to slow password brute-force and
    // reset-email spam / enumeration. ponytail: reuse the share token-bucket
    // (≈30/min per IP, keyed per path); tighten if abuse shows up.
    const RATE_LIMITED = ['/sign-in/email', '/request-password-reset', '/forget-password'];
    if (RATE_LIMITED.some((suffix) => path.endsWith(suffix))) {
      if (!allowShareRequest(requestIp(request), path)) {
        set.status = 429;
        return { error: 'too many requests' };
      }
    }
    return auth.handler(request);
  })
  .use(usersRoutes)
  .use(filesRoutes)
  .use(sharesRoutes)
  .use(accessKeyRoutes)
  .use(s3Routes)
  .use(filesCron)
  .use(filesWatcher)
  .get('/metrics', async () => {
    const body = await prometheusMetrics();
    return new Response(body, {
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
    });
  })
  .group('/api', (api) =>
    api
      .get(
        '/health',
        (): HealthStatus => ({
          status: 'ok',
          version,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        }),
        {
          response: t.Object({
            status: t.Literal('ok'),
            version: t.String(),
            uptimeSeconds: t.Number(),
          }),
        },
      )
      .get(
        '/setup/status',
        async () => {
          const [row] = await db.select({ c: count() }).from(user);
          return { needsSetup: (row?.c ?? 0) === 0 };
        },
        {
          response: t.Object({ needsSetup: t.Boolean() }),
        },
      ),
  )
  .get('/*', ({ request, set }) => {
    const url = new URL(request.url);
    // Never let the SPA fallback swallow an unhandled API route — it should
    // 404 as JSON, not serve index.html.
    if (url.pathname.startsWith('/api/')) {
      set.status = 404;
      return { error: 'not found', path: url.pathname };
    }
    const candidate = join(WEB_DIST, url.pathname);
    // Defense-in-depth against path traversal: `join` collapses `..`, so any
    // attempt to escape the bundle dir lands outside WEB_DIST — refuse it and
    // fall through to the SPA index.
    const escapesDist = candidate !== WEB_DIST && !candidate.startsWith(`${WEB_DIST}/`);
    try {
      if (!escapesDist && statSync(candidate).isFile()) {
        if (url.pathname.startsWith('/assets/')) {
          set.headers['cache-control'] = 'public, max-age=31536000, immutable';
        } else {
          set.headers['cache-control'] = 'no-cache';
        }
        return Bun.file(candidate);
      }
    } catch {
      // fall through to SPA index
    }
    if (existsSync(INDEX_HTML)) {
      set.headers['cache-control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
      return Bun.file(INDEX_HTML);
    }
    set.status = 404;
    return { error: 'web build not found — run `bun run build` in apps/web' };
  });

export type App = typeof app;
export type { Auth } from './auth/auth';

if (import.meta.main) {
  runMigrations();
  rebuildFileSearchIndex()
    .then((count) => {
      if (count > 0) console.log(`[search] indexed ${count} files`);
    })
    .catch((err) => console.warn('[search] index rebuild failed', err));

  const port = Number(Bun.env.SERVER_PORT ?? 3901);
  const host = Bun.env.SERVER_HOST ?? '0.0.0.0';
  const server = app.listen({ port, hostname: host }, ({ hostname, port: p }) => {
    console.log(`${APP_NAME} server ready on http://${hostname}:${p}`);
  });

  const shutdown = async () => {
    console.log('[shutdown] stopping server...');
    server.stop();
    await drainUploads();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
