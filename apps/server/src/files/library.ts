import { eq } from 'drizzle-orm';
import { db } from '../db';
import { fileIndex } from '../db/schema';
import { broadcastFilesChanged } from './events';
import { mimeFromName } from './mime';
import { basenameOf } from './paths';
import { upsertFileSearch } from './search';
import { absFromRelOrThrow, createFolder, removeFile, writeUpload } from './store';
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
