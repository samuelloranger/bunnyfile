import { eq } from 'drizzle-orm';
import { db } from '../db';
import { fileIndex, thumbnail } from '../db/schema';
import { broadcastFilesChanged } from './events';
import { mimeFromName } from './mime';
import { basenameOf } from './paths';
import { deleteFileSearch, upsertFileSearch } from './search';
import {
  absFromRelOrThrow,
  createFolder,
  moveFile,
  openStream,
  removeFile,
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
    throw err;
  }
  return { path: toRel };
}
