import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { fileIndex, thumbnail, trashItem } from '../db/schema';
import { broadcastFilesChanged } from './events';
import { mimeFromName } from './mime';
import { basenameOf } from './paths';
import { scan } from './scanner';
import { deleteFileSearch, deleteFileSearchPrefix, upsertFileSearch } from './search';
import {
  absFromRelOrThrow,
  createFolder,
  moveFile,
  movePathToTrash,
  openStream,
  PathError,
  pathExists,
  removeFile,
  removeTrashPath,
  restorePathFromTrash,
  writeUpload,
} from './store';
import { generateAndStoreThumbnail, isThumbnailable } from './thumbnail';

export type LibraryActor = {
  userId: string;
  role?: string | null;
};

export class LibraryError extends Error {
  constructor(
    public code: 'not_found' | 'forbidden' | 'exists' | 'trashed_missing',
    message: string,
  ) {
    super(message);
  }
}

function ownsTrashItem(row: { deletedByUserId: string | null }, actor: LibraryActor): boolean {
  return actor.role === 'admin' || row.deletedByUserId === actor.userId;
}

export type UploadResult = {
  path: string;
  size: number;
  sha256: string;
  mime: string;
};

export async function upload(
  rel: string,
  stream: ReadableStream<Uint8Array>,
  opts: { mime?: string; uploadedByUserId: string },
): Promise<UploadResult> {
  // Two independent questions, deliberately not conflated:
  //  - `createdBytes`: did this upload bring the file into existence? Only
  //    then may compensation delete the bytes. An overwrite must never remove
  //    the target, and a file present on disk but absent from `file_index`
  //    (out-of-band drop, or not yet scanned) is an overwrite, not a create.
  //  - `createdIndexRow`: did this upload insert the index row? Only then may
  //    compensation delete it.
  const createdBytes = !(await pathExists(rel));
  const info = await writeUpload(rel, stream);
  const mime = opts.mime || mimeFromName(basenameOf(rel));
  const existing = await db.select().from(fileIndex).where(eq(fileIndex.path, rel));
  const createdIndexRow = existing.length === 0;
  try {
    if (!createdIndexRow) {
      await db
        .update(fileIndex)
        .set({
          size: info.size,
          mtimeMs: info.mtimeMs,
          inode: info.inode,
          sha256: info.sha256,
          mime,
          uploadedByUserId: opts.uploadedByUserId,
          indexedAt: new Date(),
        })
        .where(eq(fileIndex.path, rel));
    } else {
      await db.insert(fileIndex).values({
        path: rel,
        size: info.size,
        mtimeMs: info.mtimeMs,
        inode: info.inode,
        sha256: info.sha256,
        mime,
        uploadedByUserId: opts.uploadedByUserId,
      });
    }
    await upsertFileSearch(rel);
    broadcastFilesChanged();
  } catch (err) {
    if (createdBytes) {
      await removeFile(rel).catch(() => {});
    }
    if (createdIndexRow) {
      await db
        .delete(fileIndex)
        .where(eq(fileIndex.path, rel))
        .catch(() => {});
      await deleteFileSearch(rel).catch(() => {});
    }
    throw err;
  }
  if (isThumbnailable(mime)) {
    generateAndStoreThumbnail(absFromRelOrThrow(rel), rel, mime).catch(() => {});
  }
  return { path: rel, size: info.size, sha256: info.sha256, mime };
}

export async function createLibraryFolder(rel: string): Promise<{ path: string }> {
  await createFolder(rel);
  broadcastFilesChanged();
  return { path: rel };
}

export async function move(fromRel: string, toRel: string): Promise<{ path: string }> {
  const existingRow = await db
    .select()
    .from(fileIndex)
    .where(eq(fileIndex.path, fromRel))
    .then((r) => r[0]);
  // `thumbnail.path` is FK'd to `file_index.path` ON DELETE CASCADE, so the
  // row must be captured *before* the index row is deleted below — reading it
  // afterwards always yields undefined and silently drops the thumbnail.
  const existingThumb = db.select().from(thumbnail).where(eq(thumbnail.path, fromRel)).get();

  await moveFile(fromRel, toRel);

  try {
    const { stat: newStat } = await openStream(toRel);
    const mime = existingRow?.mime ?? mimeFromName(basenameOf(toRel));

    await db.delete(fileIndex).where(eq(fileIndex.path, fromRel));
    await deleteFileSearch(fromRel);
    await db.insert(fileIndex).values({
      path: toRel,
      size: newStat.size,
      mtimeMs: Math.round(newStat.mtimeMs),
      inode: Number(newStat.ino),
      sha256: existingRow?.sha256 ?? null,
      mime,
      uploadedByUserId: existingRow?.uploadedByUserId ?? null,
    });
    await upsertFileSearch(toRel);

    if (existingThumb) {
      await db.insert(thumbnail).values({ ...existingThumb, path: toRel });
    }

    broadcastFilesChanged();
  } catch (err) {
    await moveFile(toRel, fromRel).catch(() => {});
    await db
      .delete(fileIndex)
      .where(eq(fileIndex.path, toRel))
      .catch(() => {});
    await deleteFileSearch(toRel).catch(() => {});
    try {
      const fromIndex = db.select().from(fileIndex).where(eq(fileIndex.path, fromRel)).get();
      if (!fromIndex && existingRow) {
        const { stat: restoredStat } = await openStream(fromRel);
        await db.insert(fileIndex).values({
          path: fromRel,
          size: restoredStat.size,
          mtimeMs: Math.round(restoredStat.mtimeMs),
          inode: Number(restoredStat.ino),
          sha256: existingRow.sha256,
          mime: existingRow.mime,
          uploadedByUserId: existingRow.uploadedByUserId,
        });
      }
      // Search is restored whether or not the index row was ours to re-insert;
      // the bytes are back at `fromRel`, so the entry must exist again.
      await upsertFileSearch(fromRel);
      // Re-attach the thumbnail last: its FK requires the index row to be back.
      if (existingThumb) {
        const thumbAtFrom = db.select().from(thumbnail).where(eq(thumbnail.path, fromRel)).get();
        if (!thumbAtFrom) await db.insert(thumbnail).values(existingThumb);
      }
    } catch {
      // Best-effort metadata revert; never mask the original failure.
    }
    throw err;
  }
  return { path: toRel };
}

export async function trashFile(rel: string, deletedByUserId: string): Promise<{ ok: true }> {
  const existingRow = db.select().from(fileIndex).where(eq(fileIndex.path, rel)).get();
  // Captured before the cascading index delete below — see the note in `move`.
  const existingThumb = db.select().from(thumbnail).where(eq(thumbnail.path, rel)).get();
  await openStream(rel);
  const id = crypto.randomUUID();
  const moved = await movePathToTrash(rel, id);
  try {
    await db.insert(trashItem).values({
      id,
      originalPath: rel,
      trashPath: moved.trashPath,
      kind: 'file',
      size: existingRow?.size ?? moved.size,
      mime: existingRow?.mime ?? mimeFromName(basenameOf(rel)),
      deletedByUserId,
    });
    await db.delete(fileIndex).where(eq(fileIndex.path, rel));
    await deleteFileSearch(rel);
    broadcastFilesChanged();
  } catch (err) {
    // Restoring the bytes is not enough: the trash row and the deleted index /
    // search / thumbnail rows must go back too, or the file reappears in the
    // library while a phantom trash entry points at a path that no longer
    // exists.
    await restorePathFromTrash(moved.trashPath, rel).catch(() => {});
    try {
      await db.delete(trashItem).where(eq(trashItem.id, id));
      if (existingRow && !db.select().from(fileIndex).where(eq(fileIndex.path, rel)).get()) {
        await db.insert(fileIndex).values(existingRow);
      }
      await upsertFileSearch(rel);
      if (existingThumb && !db.select().from(thumbnail).where(eq(thumbnail.path, rel)).get()) {
        await db.insert(thumbnail).values(existingThumb);
      }
    } catch {
      // Best-effort metadata revert; never mask the original failure.
    }
    throw err;
  }
  return { ok: true };
}

export async function trashFolder(rel: string, deletedByUserId: string): Promise<{ ok: true }> {
  const id = crypto.randomUUID();
  const moved = await movePathToTrash(rel, id);
  try {
    const [summary] = await db
      .select({ size: sql<number>`coalesce(sum(${fileIndex.size}), 0)` })
      .from(fileIndex)
      .where(sql`${fileIndex.path} = ${rel} OR ${fileIndex.path} LIKE ${`${rel}/%`}`);
    await db.insert(trashItem).values({
      id,
      originalPath: rel,
      trashPath: moved.trashPath,
      kind: 'dir',
      size: summary?.size ?? null,
      mime: null,
      deletedByUserId,
    });
    await db
      .delete(fileIndex)
      .where(sql`${fileIndex.path} = ${rel} OR ${fileIndex.path} LIKE ${`${rel}/%`}`);
    await deleteFileSearchPrefix(rel);
    broadcastFilesChanged();
  } catch (err) {
    await restorePathFromTrash(moved.trashPath, rel).catch(() => {});
    try {
      await db.delete(trashItem).where(eq(trashItem.id, id));
      // A subtree's index and search rows are rebuilt from disk rather than
      // buffered in memory — the tree is unbounded in size. Thumbnails were
      // cascade-deleted and regenerate lazily on next request.
      await scan();
    } catch {
      // Best-effort metadata revert; never mask the original failure.
    }
    throw err;
  }
  return { ok: true };
}

export async function restore(trashId: string, actor: LibraryActor): Promise<{ path: string }> {
  const row = db.select().from(trashItem).where(eq(trashItem.id, trashId)).get();
  if (!row || !ownsTrashItem(row, actor)) {
    throw new LibraryError('not_found', 'not found');
  }

  let bytesRestored = false;
  try {
    await restorePathFromTrash(row.trashPath, row.originalPath);
    bytesRestored = true;
    if (row.kind === 'file') {
      const { stat: restoredStat } = await openStream(row.originalPath);
      const mime = row.mime ?? mimeFromName(basenameOf(row.originalPath));
      await db.insert(fileIndex).values({
        path: row.originalPath,
        size: restoredStat.size,
        mtimeMs: Math.round(restoredStat.mtimeMs),
        inode: Number(restoredStat.ino),
        sha256: null,
        mime,
        uploadedByUserId: row.deletedByUserId,
      });
      await upsertFileSearch(row.originalPath);
    } else {
      await scan();
    }
    await db.delete(trashItem).where(eq(trashItem.id, row.id));
    broadcastFilesChanged();
    return { path: row.originalPath };
  } catch (err) {
    // If the bytes made it out of the trash but the metadata work failed, put
    // them back. `movePathToTrash` derives the trash path from the id, so the
    // item lands exactly where its still-present `trash_item` row expects.
    if (bytesRestored) {
      await movePathToTrash(row.originalPath, row.id).catch(() => {});
      try {
        if (row.kind === 'file') {
          await db.delete(fileIndex).where(eq(fileIndex.path, row.originalPath));
          await deleteFileSearch(row.originalPath);
        } else {
          // The failed restore may have run a scan that indexed the subtree;
          // now that the bytes are back in the trash, reconcile it away.
          await scan();
        }
      } catch {
        // Best-effort metadata revert; never mask the original failure.
      }
    }
    if (err instanceof PathError) {
      if (err.code === 'exists') {
        throw new LibraryError('exists', err.message);
      }
      if (err.code === 'not_found') {
        throw new LibraryError('trashed_missing', 'trashed item missing');
      }
    }
    throw err;
  }
}

export async function remove(trashId: string, actor: LibraryActor): Promise<{ ok: true }> {
  const row = db.select().from(trashItem).where(eq(trashItem.id, trashId)).get();
  if (!row || !ownsTrashItem(row, actor)) {
    throw new LibraryError('not_found', 'not found');
  }

  await removeTrashPath(row.trashPath);
  await db.delete(trashItem).where(eq(trashItem.id, row.id));
  return { ok: true };
}

export async function emptyTrash(actor: LibraryActor): Promise<{ removed: number }> {
  const rows = await db
    .select()
    .from(trashItem)
    .where(actor.role === 'admin' ? undefined : eq(trashItem.deletedByUserId, actor.userId));
  // One unremovable path must not strand the rest: drop the rows whose bytes
  // are actually gone and keep the others, so a retry can finish the job
  // instead of leaving trash rows that point at nothing.
  const outcomes = await Promise.allSettled(rows.map((row) => removeTrashPath(row.trashPath)));
  const clearedIds = rows
    .filter((_, i) => outcomes[i]?.status === 'fulfilled')
    .map((row) => row.id);
  if (clearedIds.length > 0) {
    await db.delete(trashItem).where(inArray(trashItem.id, clearedIds));
  }
  const failure = outcomes.find((o) => o.status === 'rejected');
  if (failure) throw failure.reason;
  return { removed: clearedIds.length };
}
