import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { S3_ROOT } from '../files/store';

export class BucketError extends Error {
  constructor(
    public code:
      | 'invalid_bucket'
      | 'invalid_key'
      | 'not_found'
      | 'bucket_exists'
      | 'bucket_not_empty'
      | 'is_directory',
    message: string,
  ) {
    super(message);
  }
}

export type BucketInfo = { name: string; createdAt: string };

export function assertBucketName(name: string): void {
  if (!name || name.length > 255) {
    throw new BucketError('invalid_bucket', `invalid bucket name: ${name}`);
  }
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) {
    throw new BucketError('invalid_bucket', `invalid bucket name: ${name}`);
  }
  if (name === '.' || name === '..') {
    throw new BucketError('invalid_bucket', `invalid bucket name: ${name}`);
  }
}

export function assertObjectKey(key: string): void {
  if (!key || key.includes('\0')) {
    throw new BucketError('invalid_key', `invalid object key: ${key}`);
  }
  if (key.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new BucketError('invalid_key', `invalid object key: ${key}`);
  }
}

async function hasAnyFile(dir: string): Promise<boolean> {
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory()) queue.push(resolve(current, entry.name));
    }
  }
  return false;
}

export async function listBuckets(): Promise<BucketInfo[]> {
  await mkdir(S3_ROOT, { recursive: true });
  const entries = await readdir(S3_ROOT, { withFileTypes: true });
  const results = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map(async (e) => {
        const s = await stat(resolve(S3_ROOT, e.name));
        return {
          name: e.name,
          createdAt: new Date(s.birthtimeMs || s.ctimeMs).toISOString(),
        };
      }),
  );
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createBucket(name: string): Promise<BucketInfo> {
  assertBucketName(name);
  await mkdir(S3_ROOT, { recursive: true });
  try {
    await mkdir(join(S3_ROOT, name), { recursive: false });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      throw new BucketError('bucket_exists', `bucket already exists: ${name}`);
    }
    throw err;
  }
  const s = await stat(join(S3_ROOT, name));
  return {
    name,
    createdAt: new Date(s.birthtimeMs || s.ctimeMs).toISOString(),
  };
}

export async function deleteBucket(name: string): Promise<void> {
  assertBucketName(name);
  const bucketDir = join(S3_ROOT, name);
  try {
    const st = await stat(bucketDir);
    if (!st.isDirectory()) {
      throw new BucketError('not_found', `bucket not found: ${name}`);
    }
  } catch (err) {
    if (err instanceof BucketError) throw err;
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new BucketError('not_found', `bucket not found: ${name}`);
    }
    throw err;
  }
  if (await hasAnyFile(bucketDir)) {
    throw new BucketError('bucket_not_empty', `bucket is not empty: ${name}`);
  }
  await rm(bucketDir, { recursive: true, force: true });
}
