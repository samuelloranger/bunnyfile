import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { fileIndex, thumbnail, trashItem } from '../db/schema';
import { broadcastFilesChanged } from './events';
import { mimeFromName } from './mime';
import { basenameOf } from './paths';
import { deleteFileSearch, deleteFileSearchPrefix, upsertFileSearch } from './search';
import {
  absFromRelOrThrow,
  createFolder,
  moveFile,
  movePathToTrash,
  openStream,
  removeFile,
  restorePathFromTrash,
  writeUpload,
} from './store';
import { generateAndStoreThumbnail, isThumbnailable } from './thumbnail';

export type LibraryActor = {
  userId: string;
  role?: string | null;
};

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
  const info = await writeUpload(rel, stream);
  const mime = opts.mime || mimeFromName(basenameOf(rel));
  try {
    const existing = await db.select().from(fileIndex).where(eq(fileIndex.path, rel));
    if (existing.length > 0) {
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
    await removeFile(rel).catch(() => {});
    await db
      .delete(fileIndex)
      .where(eq(fileIndex.path, rel))
      .catch(() => {});
    await deleteFileSearch(rel).catch(() => {});
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

    const thumb = db.select().from(thumbnail).where(eq(thumbnail.path, fromRel)).get();
    if (thumb) {
      await db.delete(thumbnail).where(eq(thumbnail.path, fromRel));
      await db.insert(thumbnail).values({ ...thumb, path: toRel });
    }

    broadcastFilesChanged();
  } catch (err) {
    await moveFile(toRel, fromRel).catch(() => {});
    await db
      .delete(fileIndex)
      .where(eq(fileIndex.path, toRel))
      .catch(() => {});
    await deleteFileSearch(toRel).catch(() => {});
    const thumbAtTo = db.select().from(thumbnail).where(eq(thumbnail.path, toRel)).get();
    if (thumbAtTo) {
      await db.delete(thumbnail).where(eq(thumbnail.path, toRel));
      await db.insert(thumbnail).values({ ...thumbAtTo, path: fromRel });
    }
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
      await upsertFileSearch(fromRel);
    }
    throw err;
  }
  return { path: toRel };
}

export async function trashFile(rel: string, deletedByUserId: string): Promise<{ ok: true }> {
  const existingRow = db.select().from(fileIndex).where(eq(fileIndex.path, rel)).get();
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
    await db.delete(thumbnail).where(eq(thumbnail.path, rel));
    broadcastFilesChanged();
  } catch (err) {
    await restorePathFromTrash(moved.trashPath, rel).catch(() => {});
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
    await db
      .delete(thumbnail)
      .where(sql`${thumbnail.path} = ${rel} OR ${thumbnail.path} LIKE ${`${rel}/%`}`);
    broadcastFilesChanged();
  } catch (err) {
    await restorePathFromTrash(moved.trashPath, rel).catch(() => {});
    throw err;
  }
  return { ok: true };
}
