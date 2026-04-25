import sharp from 'sharp';
import { db } from '../db';
import { thumbnail } from '../db/schema';

const THUMB_SIZE = 256;
const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
]);

export function isThumbnailable(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
}

export async function generateAndStoreThumbnail(absPath: string, rel: string): Promise<void> {
  const buf = await sharp(absPath)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'attention' })
    .webp({ quality: 80 })
    .toBuffer();

  const meta = await sharp(buf).metadata();

  await db
    .insert(thumbnail)
    .values({
      path: rel,
      data: buf,
      width: meta.width ?? THUMB_SIZE,
      height: meta.height ?? THUMB_SIZE,
    })
    .onConflictDoUpdate({
      target: thumbnail.path,
      set: { data: buf, width: meta.width ?? THUMB_SIZE, height: meta.height ?? THUMB_SIZE },
    });
}
