import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { s3Object } from '../db/schema';
import {
  createFileStream,
  openStream,
  PathError,
  removeFile,
  S3_ROOT,
  writeUpload,
} from '../files/store';

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

export function objectRel(bucket: string, key: string): string {
  return `s3/${bucket}/${key}`;
}

export type ObjectInfo = {
  key: string;
  size: number;
  mtimeMs: number;
  md5: string;
};

async function ensureBucketExists(bucket: string): Promise<void> {
  assertBucketName(bucket);
  const bucketDir = join(S3_ROOT, bucket);
  try {
    const st = await stat(bucketDir);
    if (!st.isDirectory()) {
      throw new BucketError('not_found', `bucket not found: ${bucket}`);
    }
  } catch (err) {
    if (err instanceof BucketError) throw err;
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new BucketError('not_found', `bucket not found: ${bucket}`);
    }
    throw err;
  }
}

async function pruneEmptyParents(start: string, stopAt: string): Promise<void> {
  let current = start;
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      await rm(current, { recursive: false });
    } catch {
      return;
    }
    current = dirname(current);
  }
}

async function readObjectInfo(bucket: string, key: string): Promise<ObjectInfo> {
  const rel = objectRel(bucket, key);
  let opened: Awaited<ReturnType<typeof openStream>>;
  try {
    opened = await openStream(rel);
  } catch (err) {
    if (err instanceof PathError && err.code === 'not_found') {
      throw new BucketError('not_found', `object not found: ${bucket}/${key}`);
    }
    if (err instanceof PathError && err.code === 'is_directory') {
      throw new BucketError('is_directory', `is a directory: ${bucket}/${key}`);
    }
    throw err;
  }
  const row = db.select({ md5: s3Object.md5 }).from(s3Object).where(eq(s3Object.path, rel)).get();
  return {
    key,
    size: opened.stat.size,
    mtimeMs: Math.round(opened.stat.mtimeMs),
    md5: row?.md5 ?? '',
  };
}

export async function putObject(
  bucket: string,
  key: string,
  stream: ReadableStream<Uint8Array>,
): Promise<ObjectInfo> {
  assertBucketName(bucket);
  assertObjectKey(key);
  await mkdir(join(S3_ROOT, bucket), { recursive: true });
  const rel = objectRel(bucket, key);
  const result = await writeUpload(rel, stream);
  await db
    .insert(s3Object)
    .values({
      path: rel,
      bucket,
      key,
      size: result.size,
      mtimeMs: result.mtimeMs,
      inode: result.inode,
      md5: result.md5,
    })
    .onConflictDoUpdate({
      target: s3Object.path,
      set: {
        size: result.size,
        mtimeMs: result.mtimeMs,
        inode: result.inode,
        md5: result.md5,
      },
    });
  return {
    key,
    size: result.size,
    mtimeMs: result.mtimeMs,
    md5: result.md5,
  };
}

export async function headObject(bucket: string, key: string): Promise<ObjectInfo> {
  assertBucketName(bucket);
  assertObjectKey(key);
  await ensureBucketExists(bucket);
  return readObjectInfo(bucket, key);
}

export async function openObjectStream(
  bucket: string,
  key: string,
): Promise<{ info: ObjectInfo; stream: ReadableStream<Uint8Array> }> {
  assertBucketName(bucket);
  assertObjectKey(key);
  await ensureBucketExists(bucket);
  const rel = objectRel(bucket, key);
  let opened: Awaited<ReturnType<typeof openStream>>;
  try {
    opened = await openStream(rel);
  } catch (err) {
    if (err instanceof PathError && err.code === 'not_found') {
      throw new BucketError('not_found', `object not found: ${bucket}/${key}`);
    }
    if (err instanceof PathError && err.code === 'is_directory') {
      throw new BucketError('is_directory', `is a directory: ${bucket}/${key}`);
    }
    throw err;
  }
  const info = await readObjectInfo(bucket, key);
  return { info, stream: createFileStream(opened.path) };
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  assertBucketName(bucket);
  assertObjectKey(key);
  const rel = objectRel(bucket, key);
  const bucketDir = join(S3_ROOT, bucket);
  const absObject = join(S3_ROOT, bucket, key);
  try {
    await removeFile(rel);
    await pruneEmptyParents(dirname(absObject), bucketDir);
  } catch {
    // DELETE is idempotent
  }
  await db.delete(s3Object).where(eq(s3Object.path, rel));
}
