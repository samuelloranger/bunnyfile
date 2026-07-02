import { stat } from 'node:fs/promises';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { auth } from '../auth/auth';
import { db } from '../db';
import { fileIndex, type ShareLinkRow, shareLink } from '../db/schema';
import { mimeFromName } from '../files/mime';
import { basenameOf, safeRelPath } from '../files/paths';
import { SAFE_CONTENT_HEADERS } from '../files/routes';
import { absFromRelOrThrow, openStream, PathError, removeShareZip } from '../files/store';
import { buildShareZip, ensureShareZip } from './folder-zip';
import { allowShareRequest, requestIp } from './rate-limit';

function randomToken() {
  return Bun.randomUUIDv7('hex');
}

async function callerFromRequest(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}

type ShareStatus = 'ok' | 'not_found' | 'expired' | 'revoked' | 'max_downloads';
type ShareState =
  | { status: 'ok'; row: ShareLinkRow }
  | { status: Exclude<ShareStatus, 'ok'>; row?: ShareLinkRow };

async function getShareState(token: string): Promise<ShareState> {
  const row = await db
    .select()
    .from(shareLink)
    .where(eq(shareLink.token, token))
    .then((r) => r[0]);
  if (!row) return { status: 'not_found' };
  if (row.revokedAt) return { status: 'revoked', row };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { status: 'expired', row };
  }
  if (row.maxDownloads != null && row.downloadCount >= row.maxDownloads) {
    return { status: 'max_downloads', row };
  }
  return { status: 'ok', row };
}

function statusToMessage(status: ShareStatus): string {
  if (status === 'expired') return 'This share link has expired.';
  if (status === 'revoked') return 'This share link has been revoked.';
  if (status === 'max_downloads') return 'This share link reached its download limit.';
  return 'This share link does not exist.';
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
      const path = safeRelPath(body.path);
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
        // Folder share: materialize a cached zip at .shares/<id>/<name>.zip.
        await buildShareZip(id, path);
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
    // Delete the cached zip if this was a folder share (no-op for file shares).
    await removeShareZip(params.id);
    return { ok: true as const };
  })

  .get('/api/shares/public/:token', async ({ request, params, set, server }) => {
    const ip = requestIp(request, server?.requestIP(request)?.address);
    if (!allowShareRequest(ip, params.token)) {
      set.status = 429;
      return { error: 'Too many requests. Try again shortly.' };
    }

    const state = await getShareState(params.token);
    if (state.status !== 'ok') {
      set.status = 410;
      return { status: state.status, message: statusToMessage(state.status) };
    }

    let isDir = false;
    try {
      isDir = (await stat(absFromRelOrThrow(state.row.path))).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      const { size } = await ensureShareZip(state.row.id, state.row.path);
      return {
        status: 'ok' as const,
        token: state.row.token,
        path: state.row.path,
        name: `${basenameOf(state.row.path)}.zip`,
        size,
        mime: 'application/zip',
        requiresPassword: Boolean(state.row.passwordHash),
        expiresAt: state.row.expiresAt,
        maxDownloads: state.row.maxDownloads,
        downloadCount: state.row.downloadCount,
      };
    }

    const indexRow = await db
      .select()
      .from(fileIndex)
      .where(eq(fileIndex.path, state.row.path))
      .then((r) => r[0]);

    return {
      status: 'ok' as const,
      token: state.row.token,
      path: state.row.path,
      name: basenameOf(state.row.path),
      size: indexRow?.size ?? null,
      mime: indexRow?.mime ?? mimeFromName(basenameOf(state.row.path)),
      requiresPassword: Boolean(state.row.passwordHash),
      expiresAt: state.row.expiresAt,
      maxDownloads: state.row.maxDownloads,
      downloadCount: state.row.downloadCount,
    };
  })

  .post(
    '/api/shares/public/:token/file',
    async ({ request, params, body, set, server }): Promise<Response | { error: string }> => {
      const ip = requestIp(request, server?.requestIP(request)?.address);
      if (!allowShareRequest(ip, params.token)) {
        set.status = 429;
        return { error: 'Too many requests. Try again shortly.' };
      }

      const state = await getShareState(params.token);
      if (state.status !== 'ok') {
        set.status = 410;
        return { error: statusToMessage(state.status) };
      }

      const row = state.row;
      if (row.passwordHash) {
        if (!body.password || !(await Bun.password.verify(body.password, row.passwordHash))) {
          set.status = 401;
          return { error: 'Password required or invalid.' };
        }
      }

      try {
        const target = absFromRelOrThrow(row.path);
        let isDir = false;
        try {
          isDir = (await stat(target)).isDirectory();
        } catch {
          isDir = false;
        }

        let fileAbs: string;
        let byteSize: number;
        let mime: string;
        let downloadName: string;
        if (isDir) {
          const z = await ensureShareZip(row.id, row.path);
          fileAbs = z.abs;
          byteSize = z.size;
          mime = 'application/zip';
          downloadName = `${basenameOf(row.path)}.zip`;
        } else {
          const opened = await openStream(row.path);
          fileAbs = opened.path;
          byteSize = opened.stat.size;
          mime = await db
            .select({ mime: fileIndex.mime })
            .from(fileIndex)
            .where(eq(fileIndex.path, row.path))
            .then((r) => r[0]?.mime ?? mimeFromName(basenameOf(row.path)));
          downloadName = basenameOf(row.path);
        }

        if (row.maxDownloads != null) {
          const updated = await db
            .update(shareLink)
            .set({ downloadCount: sql`${shareLink.downloadCount} + 1` })
            .where(
              and(
                eq(shareLink.id, row.id),
                sql`${shareLink.downloadCount} < ${shareLink.maxDownloads}`,
              ),
            )
            .returning({ id: shareLink.id });
          if (updated.length === 0) {
            set.status = 410;
            return { error: statusToMessage('max_downloads') };
          }
        } else {
          await db
            .update(shareLink)
            .set({ downloadCount: sql`${shareLink.downloadCount} + 1` })
            .where(eq(shareLink.id, row.id));
        }

        // Strip control chars (incl. CR/LF) before putting the name in a
        // header value to avoid response-header injection; then escape quotes.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
        const headerName = downloadName.replace(/[\x00-\x1f\x7f]/g, '_');
        const quoted = headerName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return new Response(Bun.file(fileAbs).stream(), {
          headers: {
            ...SAFE_CONTENT_HEADERS,
            'Content-Type': mime,
            'Content-Length': String(byteSize),
            'Content-Disposition': `attachment; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
          },
        });
      } catch (err) {
        if (err instanceof PathError) {
          set.status = 404;
          return { error: 'file missing' };
        }
        throw err;
      }
    },
    {
      body: t.Object({
        password: t.Optional(t.String()),
      }),
    },
  );
