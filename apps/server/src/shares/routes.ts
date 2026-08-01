import { stat } from 'node:fs/promises';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { auth } from '../auth/auth';
import { db } from '../db';
import { fileIndex, shareLink } from '../db/schema';
import { absFromRelOrThrow } from '../files/store';
import { userRel } from '../files/user-path';
import {
  beginDownload,
  inspect,
  invalidateFolderArtifact,
  prepareFolderArtifact,
  type SharePublicMeta,
  verify,
} from './access';
import { allowShareRequest, requestIp } from './rate-limit';

function randomToken() {
  return Bun.randomUUIDv7('hex');
}

async function callerFromRequest(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}

async function downloadHandler({
  request,
  params,
  body,
  set,
  server,
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler context is complex to type statically
}: any): Promise<Response | { error: string }> {
  const ip = requestIp(request, server?.requestIP(request)?.address);
  if (!allowShareRequest(ip, params.token)) {
    set.status = 429;
    return { error: 'Too many requests. Try again shortly.' };
  }

  const result = await beginDownload(params.token, body?.password);
  if (!result.ok) {
    if (result.error === 'unauthorized') {
      set.status = 401;
      return { error: result.message };
    }
    if (result.error === 'missing') {
      set.status = 404;
      return { error: result.message };
    }
    set.status = 410;
    return { error: result.message };
  }

  return new Response(result.stream, { headers: result.headers });
}

export const sharesRoutes = new Elysia({ name: 'shares' })
  .post(
    '/api/shares',
    async ({ request, body, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }
      const path = userRel(body.path);
      if (!path) {
        set.status = 400;
        return { error: 'invalid path' as const };
      }

      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(absFromRelOrThrow(path));
      } catch {
        set.status = 404;
        return { error: 'file not found' as const };
      }

      const token = randomToken();
      const id = crypto.randomUUID();
      const passwordHash = body.password ? await Bun.password.hash(body.password) : null;

      if (st.isDirectory()) {
        await prepareFolderArtifact(id, path);
      } else {
        const existing = await db
          .select()
          .from(fileIndex)
          .where(eq(fileIndex.path, path))
          .then((r) => r[0]);
        if (!existing) {
          set.status = 404;
          return { error: 'file not found' as const };
        }
      }

      await db.insert(shareLink).values({
        id,
        token,
        path,
        expiresAt: body.expiresAtMs ? new Date(body.expiresAtMs) : null,
        passwordHash,
        maxDownloads: body.maxDownloads ?? null,
        createdByUserId: s.user.id,
      });

      const origin = new URL(request.url).origin;
      return {
        id,
        token,
        url: `${origin}/s/${token}`,
      };
    },
    {
      body: t.Object({
        path: t.String({ minLength: 1 }),
        expiresAtMs: t.Optional(t.Number({ minimum: 0 })),
        password: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
        maxDownloads: t.Optional(t.Number({ minimum: 1, maximum: 1_000_000 })),
      }),
    },
  )

  .get('/api/shares', async ({ request, set }) => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' as const };
    }

    const rows = await db
      .select({
        id: shareLink.id,
        token: shareLink.token,
        path: shareLink.path,
        expiresAt: shareLink.expiresAt,
        maxDownloads: shareLink.maxDownloads,
        downloadCount: shareLink.downloadCount,
        createdAt: shareLink.createdAt,
        revokedAt: shareLink.revokedAt,
        hasPassword: sql<boolean>`${shareLink.passwordHash} is not null`,
      })
      .from(shareLink)
      .where(and(eq(shareLink.createdByUserId, s.user.id), isNull(shareLink.revokedAt)))
      .orderBy(desc(shareLink.createdAt))
      .limit(100);
    return { entries: rows };
  })

  .delete('/api/shares/:id', async ({ request, params, set }) => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' as const };
    }

    const updated = await db
      .update(shareLink)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareLink.id, params.id), eq(shareLink.createdByUserId, s.user.id)))
      .returning({ id: shareLink.id })
      .then((r) => r[0]);
    if (!updated) {
      set.status = 404;
      return { error: 'not found' as const };
    }
    await invalidateFolderArtifact(params.id);
    return { ok: true as const };
  })

  .get('/api/shares/public/:token', async ({ request, params, set, server }) => {
    const ip = requestIp(request, server?.requestIP(request)?.address);
    if (!allowShareRequest(ip, params.token)) {
      set.status = 429;
      return { error: 'Too many requests. Try again shortly.' };
    }

    const result = await inspect(params.token);
    if (result.status === 'unavailable') {
      set.status = 410;
      return { status: result.reason, message: result.message };
    }
    if (result.status === 'locked') {
      return {
        status: 'ok' as const,
        requiresPassword: true as const,
        expiresAt: result.expiresAt,
        maxDownloads: result.maxDownloads,
        downloadCount: result.downloadCount,
      };
    }
    const { status: _unlocked, requiresPassword: _rp, ...meta } = result;
    return {
      status: 'ok' as const,
      ...meta,
      requiresPassword: false as const,
    };
  })

  .post(
    '/api/shares/public/:token/verify',
    async ({
      request,
      params,
      body,
      set,
      server,
    }): Promise<({ ok: true } & SharePublicMeta) | { error: string }> => {
      const ip = requestIp(request, server?.requestIP(request)?.address);
      if (!allowShareRequest(ip, params.token)) {
        set.status = 429;
        return { error: 'Too many requests. Try again shortly.' };
      }

      const result = await verify(params.token, body.password);
      if (!result.ok) {
        if (result.error === 'unauthorized') {
          set.status = 401;
          return { error: result.message };
        }
        set.status = 410;
        return { error: result.message };
      }
      return { ok: true as const, ...result };
    },
    {
      body: t.Object({
        password: t.Optional(t.String()),
      }),
    },
  )

  .get('/api/shares/public/:token/file', downloadHandler)

  .post('/api/shares/public/:token/file', downloadHandler, {
    body: t.Object({
      password: t.Optional(t.String()),
    }),
  });
