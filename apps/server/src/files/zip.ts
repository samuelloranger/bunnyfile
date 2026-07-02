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
  let closed = false;
  let readStreamToCleanup: ReturnType<typeof createReadStream> | null = null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const fail = (err: unknown) => {
        if (!closed) {
          closed = true;
          try {
            controller.error(err instanceof Error ? err : new Error(String(err)));
          } catch (_) {}
        }
      };
      const zip = new Zip((err, chunk, final) => {
        if (err) return fail(err);
        if (!closed) {
          try {
            controller.enqueue(chunk);
          } catch (_) {
            closed = true;
          }
        }
        if (final && !closed) {
          closed = true;
          try {
            controller.close();
          } catch (_) {}
        }
      });
      try {
        for (const f of await walkFiles(absRoot)) {
          if (closed) break;
          const entry = new ZipPassThrough(f.name);
          zip.add(entry);
          await new Promise<void>((resolve, reject) => {
            if (closed) return resolve();
            const rs = createReadStream(f.abs);
            readStreamToCleanup = rs;
            rs.on('data', (c) => {
              if (closed) {
                rs.destroy();
                resolve();
                return;
              }
              entry.push(c as Uint8Array);
            });
            rs.on('end', () => {
              readStreamToCleanup = null;
              if (!closed) {
                entry.push(new Uint8Array(0), true);
              }
              resolve();
            });
            rs.on('error', (err) => {
              readStreamToCleanup = null;
              reject(err);
            });
          });
        }
        if (!closed) {
          zip.end();
        }
      } catch (err) {
        fail(err);
      }
    },
    cancel() {
      closed = true;
      if (readStreamToCleanup) {
        try {
          readStreamToCleanup.destroy();
        } catch (_) {}
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
