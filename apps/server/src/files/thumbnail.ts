import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  return IMAGE_MIMES.has(mime) || mime === 'application/pdf';
}

async function pdfToBuffer(absPath: string): Promise<Buffer> {
  const tmp = join(tmpdir(), `bunnyfile-thumb-${crypto.randomUUID().slice(0, 8)}`);
  const pngPath = `${tmp}.png`;
  try {
    // stderr: 'ignore' — we only need the exit code. Piping it without draining
    // can fill the OS pipe buffer and deadlock pdftoppm (await never resolves).
    const proc = Bun.spawn(
      ['pdftoppm', '-png', '-r', '72', '-f', '1', '-l', '1', '-singlefile', absPath, tmp],
      { stderr: 'ignore', stdout: 'ignore' },
    );
    const exit = await proc.exited;
    if (exit !== 0) throw new Error(`pdftoppm exited with code ${exit}`);
    const data = await Bun.file(pngPath).arrayBuffer();
    return Buffer.from(data);
  } finally {
    // Always clean up the intermediate PNG, including on failure.
    await rm(pngPath, { force: true }).catch(() => {});
  }
}

export async function generateAndStoreThumbnail(
  absPath: string,
  rel: string,
  mime: string,
): Promise<void> {
  const source = mime === 'application/pdf' ? await pdfToBuffer(absPath) : absPath;

  const buf = await sharp(source)
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
