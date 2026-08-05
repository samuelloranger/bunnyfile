import { stat, statfs } from 'node:fs/promises';
import { desc, eq, sql } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { auth } from '../auth/auth';
import { db } from '../db';
import { fileIndex, thumbnail, trashItem } from '../db/schema';
import { addSseClient, removeSseClient } from './events';
import {
  createLibraryFolder,
  emptyTrash,
  LibraryError,
  move,
  remove,
  restore,
  trashFile,
  trashFolder,
  upload,
} from './library';
import { mimeFromName } from './mime';
import { basenameOf } from './paths';
import { scan } from './scanner';
import { searchFiles } from './search';
import {
  absFromRelOrThrow,
  createFileStream,
  DATA_ROOT,
  listImmediateDirectories,
  openStream,
  PathError,
  readRange,
} from './store';
import { generateAndStoreThumbnail, isThumbnailable } from './thumbnail';
import { userRel } from './user-path';
import { createFolderZipStream } from './zip';

// Stored-XSS neutralizer for user-controlled bytes: `sandbox` stops any script
// execution if the file is navigated to or iframed (e.g. an uploaded .html),
// and `nosniff` makes the browser trust the declared type instead of guessing.
// Images/video/pdf preview still work — CSP only governs documents.
export const SAFE_CONTENT_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': 'sandbox',
} as const;

type FileEntry = {
  kind: 'file';
  name: string;
  path: string;
  size: number;
  mime: string;
  mtimeMs: number;
  sha256: string | null;
};

type DirEntry = {
  kind: 'dir';
  name: string;
  path: string;
  itemCount: number;
};

type ListEntry = FileEntry | DirEntry;

type RecentFileEntry = {
  path: string;
  size: number;
  mime: string;
  mtimeMs: number;
};

type MutationErrorSet = { status?: number | string };

function mapMutationError(
  err: unknown,
  set: MutationErrorSet,
): { error: string } | { error: 'not found' } | { error: 'trashed item missing' } {
  if (err instanceof LibraryError) {
    if (err.code === 'not_found') {
      set.status = 404;
      return { error: 'not found' };
    }
    if (err.code === 'exists') {
      set.status = 409;
      return { error: err.message };
    }
    if (err.code === 'trashed_missing') {
      set.status = 404;
      return { error: 'trashed item missing' };
    }
    set.status = 400;
    return { error: err.message };
  }
  if (err instanceof PathError) {
    if (err.code === 'not_found') {
      set.status = 404;
      return { error: 'not found' };
    }
    if (err.code === 'exists') {
      set.status = 409;
      return { error: err.message };
    }
    set.status = 400;
    return { error: err.message };
  }
  throw err;
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

async function callerFromRequest(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}

function libraryActor(user: { id: string; role?: string | null | undefined }): {
  userId: string;
  role?: string | null;
} {
  return user.role === undefined ? { userId: user.id } : { userId: user.id, role: user.role };
}

/**
 * Compose a directory listing from the flat index, without storing directory
 * rows. For `prefix = "docs"` we return:
 *   - files whose parent is exactly `docs`
 *   - synthesized dir entries for every immediate child subdir that contains
 *     at least one indexed file
 */
async function listPrefix(prefix: string): Promise<ListEntry[]> {
  // Files whose parent is exactly `prefix` — one `LIKE` scan over the PK.
  // Given `prefix = 'a/b'`, descendants are rows where path LIKE 'a/b/%'.
  // Immediate children have no further `/` after the prefix, so we filter
  // in-memory — simpler than a regex query.
  const likeExpr = prefix ? `${escapeLike(prefix)}/%` : '%';
  const descendants = await db
    .select()
    .from(fileIndex)
    .where(sql`${fileIndex.path} LIKE ${likeExpr} ESCAPE '\\'`);

  const files: FileEntry[] = [];
  const dirCounts = new Map<string, number>();

  for (const row of descendants) {
    const rest = prefix ? row.path.slice(prefix.length + 1) : row.path;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push({
        kind: 'file',
        name: rest,
        path: row.path,
        size: row.size,
        mime: row.mime,
        mtimeMs: row.mtimeMs,
        sha256: row.sha256,
      });
    } else {
      const childDir = rest.slice(0, slash);
      dirCounts.set(childDir, (dirCounts.get(childDir) ?? 0) + 1);
    }
  }

  const diskDirs = await listImmediateDirectories(prefix);
  for (const name of diskDirs) {
    if (!dirCounts.has(name)) {
      dirCounts.set(name, 0);
    }
  }

  const dirs: DirEntry[] = [...dirCounts.entries()]
    .map(([name, itemCount]) => ({
      kind: 'dir' as const,
      name,
      path: prefix ? `${prefix}/${name}` : name,
      itemCount,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

function paginate<T>(items: T[], offset: number, limit: number) {
  const total = items.length;
  const entries = items.slice(offset, offset + limit);
  return {
    entries,
    total,
    offset,
    limit,
    hasMore: offset + entries.length < total,
  };
}

export const filesRoutes = new Elysia({ name: 'files' })
  .get(
    '/api/files',
    async ({ request, query, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }
      const prefix = userRel(query.prefix ?? '');
      if (prefix == null) {
        set.status = 400;
        return { error: 'invalid prefix' as const };
      }
      const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
      const offset = Math.max(query.offset ?? 0, 0);
      const listing = await listPrefix(prefix);
      const page = paginate(listing, offset, limit);
      return {
        prefix,
        ...page,
      };
    },
    {
      query: t.Object({
        prefix: t.Optional(t.String()),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 500 })),
        offset: t.Optional(t.Numeric({ minimum: 0 })),
      }),
    },
  )

  .post('/api/files/rescan', async ({ request, set }) => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' as const };
    }
    if (s.user.role !== 'admin') {
      set.status = 403;
      return { error: 'forbidden' as const };
    }
    return await scan();
  })

  .get('/api/files/usage', async ({ request, set }) => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' as const };
    }

    const [row] = await db
      .select({
        usedBytes: sql<number>`coalesce(sum(${fileIndex.size}), 0)`,
        fileCount: sql<number>`count(*)`,
      })
      .from(fileIndex);

    let totalBytes: number | null = null;
    let freeBytes: number | null = null;
    try {
      const fs = await statfs(DATA_ROOT);
      const rawTotal = fs.bsize * fs.blocks;
      const rawFree = fs.bsize * fs.bavail;
      totalBytes = rawTotal > 0 ? rawTotal : null;
      freeBytes = rawFree >= 0 ? rawFree : null;
    } catch {
      // Best-effort: some filesystems may not support statfs.
    }

    return {
      usedBytes: row?.usedBytes ?? 0,
      fileCount: row?.fileCount ?? 0,
      totalBytes,
      freeBytes,
    };
  })

  .get(
    '/api/files/recent',
    async ({ request, query, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }

      const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
      const rows = await db
        .select({
          path: fileIndex.path,
          size: fileIndex.size,
          mime: fileIndex.mime,
          mtimeMs: fileIndex.mtimeMs,
        })
        .from(fileIndex)
        .orderBy(desc(fileIndex.mtimeMs))
        .limit(limit);

      return { entries: rows as RecentFileEntry[] };
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })),
      }),
    },
  )

  .get(
    '/api/files/search',
    async ({ request, query, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }
      const q = query.q?.trim() ?? '';
      if (q.length < 2) {
        set.status = 400;
        return { error: 'query too short' as const };
      }
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const entries = await searchFiles(q, limit);
      return { query: q, entries };
    },
    {
      query: t.Object({
        q: t.String({ minLength: 2, maxLength: 200 }),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
      }),
    },
  )

  .post(
    '/api/files/folder',
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
      try {
        await createLibraryFolder(path);
        return { ok: true as const, path };
      } catch (err) {
        if (err instanceof PathError || err instanceof LibraryError) {
          return mapMutationError(err, set);
        }
        set.status = 500;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        path: t.String({ minLength: 1 }),
      }),
    },
  )

  .delete(
    '/api/files/folder',
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
      try {
        await trashFolder(path, s.user.id);
        return { ok: true as const };
      } catch (err) {
        return mapMutationError(err, set);
      }
    },
    {
      body: t.Object({ path: t.String({ minLength: 1 }) }),
    },
  )

  // SSE stream — pushes a `files-changed` event whenever the index changes.
  .get('/api/files/events', async ({ request, set }): Promise<Response | { error: string }> => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' };
    }

    const enc = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let heartbeat: ReturnType<typeof setInterval>;

    const cleanup = () => {
      clearInterval(heartbeat);
      removeSseClient(ctrl);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        addSseClient(ctrl);
        // Comment frames keep the connection alive through proxies.
        heartbeat = setInterval(() => {
          try {
            ctrl.enqueue(enc.encode(': heartbeat\n\n'));
          } catch {
            cleanup();
          }
        }, 25_000);
      },
      cancel: cleanup,
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  })

  // Upload a file. Accepts multipart form-data with fields:
  //   - file: the blob
  //   - path: target path (folders auto-created)
  .post(
    '/api/files/upload',
    async ({ request, body, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }

      const target = userRel(body.path);
      if (!target) {
        set.status = 400;
        return { error: 'invalid path' as const };
      }

      // Optional: disallow overwriting an existing file without a flag.
      // For now, overwrite silently and let the scanner reconcile — easier
      // to reason about for drag-drop flows.

      try {
        return await upload(target, body.file.stream(), {
          ...(body.file.type ? { mime: body.file.type } : {}),
          uploadedByUserId: s.user.id,
        });
      } catch (err) {
        if (err instanceof PathError || err instanceof LibraryError) {
          return mapMutationError(err, set);
        }
        set.status = 500;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        file: t.File(),
        path: t.String({ minLength: 1 }),
      }),
      type: 'multipart/form-data',
    },
  )

  // Stream the bytes. Supports Range requests for partial content.
  .get(
    '/api/files/content',
    async ({ request, query, set }): Promise<Response | { error: string }> => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' };
      }
      const path = userRel(query.path);
      if (!path) {
        set.status = 404;
        return { error: 'not found' };
      }
      try {
        const { path: abs, stat: st } = await openStream(path);
        const row = await db
          .select()
          .from(fileIndex)
          .where(eq(fileIndex.path, path))
          .then((r) => r[0]);
        const mime = row?.mime ?? mimeFromName(basenameOf(path));
        const size = st.size;

        const range = request.headers.get('range');
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          if (!m) {
            return new Response('invalid range', { status: 416 });
          }
          const startStr = m[1] ?? '';
          const endStr = m[2] ?? '';
          let start: number;
          let end: number;
          if (startStr === '' && endStr !== '') {
            // Suffix range `bytes=-N`: the last N bytes of the file.
            const n = Number.parseInt(endStr, 10);
            start = Math.max(0, size - n);
            end = size - 1;
          } else {
            start = startStr ? Number.parseInt(startStr, 10) : 0;
            end = endStr ? Number.parseInt(endStr, 10) : size - 1;
          }
          if (
            startStr === '' &&
            endStr === ''
            // `bytes=-` with no number is malformed.
          ) {
            return new Response('invalid range', { status: 416 });
          }
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
            return new Response('unsatisfiable range', {
              status: 416,
              headers: { 'Content-Range': `bytes */${size}` },
            });
          }
          return new Response(readRange(abs, start, end), {
            status: 206,
            headers: {
              ...SAFE_CONTENT_HEADERS,
              'Accept-Ranges': 'bytes',
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Content-Length': String(end - start + 1),
              'Content-Type': mime,
            },
          });
        }

        return new Response(createFileStream(abs), {
          headers: {
            ...SAFE_CONTENT_HEADERS,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(size),
            'Content-Type': mime,
          },
        });
      } catch (err) {
        if (err instanceof PathError) {
          if (err.code === 'not_found') {
            set.status = 404;
            return { error: 'not found' };
          }
          set.status = 400;
          return { error: err.message };
        }
        throw err;
      }
    },
    {
      query: t.Object({ path: t.String() }),
    },
  )

  .get(
    '/api/files/archive',
    async ({ request, query, set }): Promise<Response | { error: string }> => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }
      const path = userRel(query.path);
      if (!path) {
        set.status = 400;
        return { error: 'invalid path' as const };
      }
      const abs = absFromRelOrThrow(path);
      let isDir = false;
      try {
        isDir = (await stat(abs)).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        set.status = 404;
        return { error: 'not a folder' as const };
      }
      const name = `${basenameOf(path)}.zip`;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
      const headerName = name.replace(/[\x00-\x1f\x7f]/g, '_');
      const quoted = headerName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return new Response(createFolderZipStream(abs), {
        headers: {
          ...SAFE_CONTENT_HEADERS,
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        },
      });
    },
    {
      query: t.Object({ path: t.String({ minLength: 1 }) }),
    },
  )

  .get(
    '/api/files/thumbnail',
    async ({ request, query, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return new Response('unauthorized', { status: 401 });
      }
      const rel = userRel(query.path);
      if (!rel) {
        set.status = 400;
        return new Response('invalid path', { status: 400 });
      }
      const row = db.select().from(thumbnail).where(eq(thumbnail.path, rel)).get();
      if (!row) {
        return new Response(null, { status: 204 });
      }
      return new Response(row.data as unknown as ArrayBuffer, {
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=86400' },
      });
    },
    { query: t.Object({ path: t.String() }) },
  )

  .get('/api/trash', async ({ request, set }) => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' as const };
    }

    const rows = await db
      .select({
        id: trashItem.id,
        originalPath: trashItem.originalPath,
        kind: trashItem.kind,
        size: trashItem.size,
        mime: trashItem.mime,
        deletedAt: trashItem.deletedAt,
      })
      .from(trashItem)
      .where(s.user.role === 'admin' ? undefined : eq(trashItem.deletedByUserId, s.user.id))
      .orderBy(desc(trashItem.deletedAt))
      .limit(200);

    return { entries: rows };
  })

  .post('/api/trash/:id/restore', async ({ request, params, set }) => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' as const };
    }

    try {
      const { path: restoredPath } = await restore(params.id, libraryActor(s.user));
      return { ok: true as const, path: restoredPath };
    } catch (err) {
      return mapMutationError(err, set);
    }
  })

  .delete('/api/trash/:id', async ({ request, params, set }) => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' as const };
    }

    try {
      await remove(params.id, libraryActor(s.user));
      return { ok: true as const };
    } catch (err) {
      return mapMutationError(err, set);
    }
  })

  .delete('/api/trash', async ({ request, set }) => {
    const s = await callerFromRequest(request);
    if (!s?.user) {
      set.status = 401;
      return { error: 'unauthorized' as const };
    }

    const { removed } = await emptyTrash(libraryActor(s.user));
    return { ok: true as const, removed };
  })

  .post(
    '/api/files/thumbnail',
    async ({ request, query, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }
      const rel = userRel(query.path);
      if (!rel) {
        set.status = 400;
        return { error: 'invalid path' as const };
      }
      const row = await db
        .select({ mime: fileIndex.mime })
        .from(fileIndex)
        .where(eq(fileIndex.path, rel));
      if (!row[0]) {
        set.status = 404;
        return { error: 'file not found' as const };
      }
      const { mime } = row[0];
      if (!isThumbnailable(mime)) {
        set.status = 400;
        return { error: 'not thumbnailable' as const };
      }
      await generateAndStoreThumbnail(absFromRelOrThrow(rel), rel, mime);
      return { ok: true as const };
    },
    { query: t.Object({ path: t.String() }) },
  )

  .patch(
    '/api/files',
    async ({ request, body, set }) => {
      const s = await callerFromRequest(request);
      if (!s?.user) {
        set.status = 401;
        return { error: 'unauthorized' as const };
      }
      const path = userRel(body.path);
      const newPath = userRel(body.newPath);
      if (!path || !newPath) {
        set.status = 400;
        return { error: 'invalid path' as const };
      }
      try {
        const { path: movedPath } = await move(path, newPath);
        return { ok: true as const, path: movedPath };
      } catch (err) {
        return mapMutationError(err, set);
      }
    },
    {
      body: t.Object({
        path: t.String(),
        newPath: t.String(),
      }),
    },
  )

  .delete(
    '/api/files',
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
      try {
        await trashFile(path, s.user.id);
        return { ok: true as const };
      } catch (err) {
        return mapMutationError(err, set);
      }
    },
    {
      body: t.Object({ path: t.String() }),
    },
  );

export { DATA_ROOT };
