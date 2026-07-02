import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';

/** All files under `absRoot`, with POSIX names relative to it, sorted. */
async function walkFiles(absRoot: string): Promise<{ abs: string; name: string }[]> {
  const out: { abs: string; name: string }[] = [];
  async function rec(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await rec(abs);
      else if (e.isFile()) out.push({ abs, name: relative(absRoot, abs).split(sep).join('/') });
    }
  }
  await rec(absRoot);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Store-level (uncompressed) zip of every file under `absRoot`.
 * ponytail: fflate pushes synchronously and does not honor ReadableStream
 * backpressure — fine for a single-process homelab host. Revisit with a
 * pull-based zipper only if huge folders + slow clients cause memory pressure.
 */
export function createFolderZipStream(absRoot: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const fail = (err: unknown) => {
        if (!closed) {
          closed = true;
          controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      };
      const zip = new Zip((err, chunk, final) => {
        if (err) return fail(err);
        if (!closed) controller.enqueue(chunk);
        if (final && !closed) {
          closed = true;
          controller.close();
        }
      });
      try {
        for (const f of await walkFiles(absRoot)) {
          const entry = new ZipPassThrough(f.name);
          zip.add(entry);
          await new Promise<void>((resolve, reject) => {
            const rs = createReadStream(f.abs);
            rs.on('data', (c) => entry.push(c as Uint8Array));
            rs.on('end', () => {
              entry.push(new Uint8Array(0), true);
              resolve();
            });
            rs.on('error', reject);
          });
        }
        zip.end();
      } catch (err) {
        fail(err);
      }
    },
  });
}

/** Write the folder zip to `destAbs` via a temp file + atomic rename. */
export async function zipFolderToFile(absRoot: string, destAbs: string): Promise<void> {
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.tmp.${crypto.randomUUID()}`;
  // ponytail: Bun.write(path, new Response(stream)) never resolves for a
  // custom (non-Bun-native) ReadableStream on Bun 1.3.14 — verified hang via
  // isolated repro. Drain the reader into a FileSink manually instead; same
  // write-then-rename guarantee, just without the broken convenience path.
  const sink = Bun.file(tmp).writer();
  const reader = createFolderZipStream(absRoot).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.write(value);
    }
    await sink.end();
  } catch (err) {
    await Promise.resolve(sink.end()).catch(() => {});
    throw err;
  }
  await rename(tmp, destAbs);
}
