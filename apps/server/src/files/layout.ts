import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LAYOUT_MARKER = '.bunnyfile-layout-v2';

const INTERNAL_NAMES = new Set([
  'files',
  's3',
  'trash',
  '.trash',
  'shares',
  '.shares',
  'multipart',
  '.multipart',
  LAYOUT_MARKER,
]);

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    try {
      const { stat } = await import('node:fs/promises');
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Ensure DATA_DIR uses the v2 sibling layout (files/, s3/, trash/, shares/, multipart/).
 * Idempotent. Throws on partial failure without writing the marker.
 */
export async function ensureDataLayout(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const filesRoot = join(dataDir, 'files');
  const marker = join(dataDir, LAYOUT_MARKER);

  if (await exists(filesRoot)) {
    if (!(await exists(marker))) {
      await writeFile(marker, `layout=v2\ncreated=${new Date().toISOString()}\n`, 'utf8');
    }
    await mkdir(join(dataDir, 's3'), { recursive: true });
    await mkdir(join(dataDir, 'trash'), { recursive: true });
    await mkdir(join(dataDir, 'shares'), { recursive: true });
    await mkdir(join(dataDir, 'multipart'), { recursive: true });
    return;
  }

  // Legacy → v2 migrate
  await mkdir(filesRoot, { recursive: true });
  const entries = await readdir(dataDir, { withFileTypes: true });
  for (const entry of entries) {
    if (INTERNAL_NAMES.has(entry.name)) continue;
    const from = join(dataDir, entry.name);
    const to = join(filesRoot, entry.name);
    await rename(from, to);
  }

  await renameIfPresent(join(dataDir, '.trash'), join(dataDir, 'trash'));
  await renameIfPresent(join(dataDir, '.shares'), join(dataDir, 'shares'));
  await renameIfPresent(join(dataDir, '.multipart'), join(dataDir, 'multipart'));

  await mkdir(join(dataDir, 's3'), { recursive: true });
  await mkdir(join(dataDir, 'trash'), { recursive: true });
  await mkdir(join(dataDir, 'shares'), { recursive: true });
  await mkdir(join(dataDir, 'multipart'), { recursive: true });

  await writeFile(marker, `layout=v2\ncreated=${new Date().toISOString()}\n`, 'utf8');
}
