import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { db } from '../db';
import { s3Object } from '../db/schema';
import { mimeFromName } from '../files/mime';
import { basenameOf } from '../files/paths';
import {
  DATA_ROOT,
  hashOnDisk,
  openStream,
  readRange,
  removeFile,
  writeUpload,
} from '../files/store';
import { lookupS3SecretKey } from './access-keys';
import { handleMultipart } from './multipart';
import { verifyPresigned, verifySigV4 } from './sigv4';
import { s3ErrorXml, xmlDocument } from './xml';

const S3_ROOT = resolve(
  Bun.env.DATA_DIR ? Bun.env.DATA_DIR : resolve(import.meta.dir, '../../data/files'),
  's3',
);
await mkdir(S3_ROOT, { recursive: true });

function s3Config() {
  return {
    region: Bun.env.S3_REGION ?? 'us-east-1',
    service: 's3',
    lookupKey: lookupS3SecretKey,
  };
}

function validateBucket(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

function decodePathPart(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

type S3PathResult =
  | { invalid: true; bucket: null; key: null }
  | { invalid?: false; bucket: null; key: null }
  | { invalid?: false; bucket: string; key: null }
  | { invalid?: false; bucket: string; key: string };

function splitS3Path(pathname: string): S3PathResult {
  const raw = pathname.replace(/^\/api\/s3\/?/, '');
  if (!raw) return { bucket: null, key: null };
  const parts = raw.split('/');
  const bucket = decodePathPart(parts[0] ?? '');
  if (!bucket || !validateBucket(bucket)) return { invalid: true, bucket: null, key: null };
  const keyRaw = parts.slice(1).join('/');
  if (!keyRaw) return { bucket, key: null };
  const key = decodePathPart(keyRaw);
  if (!key) return { invalid: true, bucket: null, key: null };
  // Reject path traversal in key segments
  if (key.includes('\0') || key.split('/').some((seg) => seg === '..' || seg === '.')) {
    return { invalid: true, bucket: null, key: null };
  }
  return { bucket, key };
}

function objectRel(bucket: string, key: string): string {
  return `s3/${bucket}/${key}`;
}

async function listBuckets(): Promise<Array<{ name: string; createdAt: string }>> {
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

type ObjectRow = { key: string; size: number; mtime: string; md5: string };

async function walkObjects(bucketDir: string, bucket: string): Promise<ObjectRow[]> {
  const dbRows = await db.select().from(s3Object).where(eq(s3Object.bucket, bucket));
  const md5Map = new Map(dbRows.map((r) => [r.key, r.md5]));

  const out: ObjectRow[] = [];
  const queue: Array<{ dir: string; prefix: string }> = [{ dir: bucketDir, prefix: '' }];
  while (queue.length > 0) {
    const { dir, prefix } = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: abs, prefix: rel });
      } else if (entry.isFile()) {
        const st = await stat(abs);
        out.push({
          key: rel,
          size: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
          md5: md5Map.get(rel) ?? '',
        });
      }
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

async function hasAnyFile(dir: string): Promise<boolean> {
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory()) queue.push(resolve(current, entry.name));
    }
  }
  return false;
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

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

function s3Err(
  set: { status?: number | string },
  status: number,
  code: string,
  message: string,
  resource: string,
): Response {
  set.status = status;
  return xmlResponse(s3ErrorXml(code, message, resource), status);
}

const S3_XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

function createS3Handler() {
  return async ({ request, set }: { request: Request; set: { status?: number | string } }) => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const isPresigned = url.searchParams.has('X-Amz-Signature');
    const verification = isPresigned
      ? await verifyPresigned(request, s3Config())
      : await verifySigV4(request, s3Config());
    if (!verification.ok) {
      return s3Err(
        set,
        verification.code === 'SignatureDoesNotMatch' ? 403 : 400,
        verification.code,
        verification.message,
        pathname,
      );
    }

    // Internal health/debug endpoint — not in the S3 bucket namespace.
    if (pathname === '/api/s3/_ping' && request.method === 'GET') {
      return xmlResponse(
        xmlDocument({
          name: 'PingResult',
          children: [
            { name: 'Status', value: 'ok' },
            { name: 'AccessKeyId', value: verification.accessKeyId },
            { name: 'Scope', value: verification.scope },
          ],
        }),
      );
    }

    const parsed = splitS3Path(pathname);
    if (parsed.invalid) {
      return s3Err(
        set,
        400,
        'InvalidBucketName',
        'The specified bucket name is not valid',
        pathname,
      );
    }
    const { bucket, key } = parsed;

    if (!bucket) {
      if (request.method !== 'GET') {
        return s3Err(set, 405, 'MethodNotAllowed', 'Method not allowed', pathname);
      }
      const buckets = await listBuckets();
      return xmlResponse(
        xmlDocument({
          name: 'ListAllMyBucketsResult',
          attributes: { xmlns: S3_XMLNS },
          children: [
            { name: 'Owner', children: [{ name: 'ID', value: 'bunnyfile' }] },
            {
              name: 'Buckets',
              children: buckets.map(({ name, createdAt }) => ({
                name: 'Bucket',
                children: [
                  { name: 'Name', value: name },
                  { name: 'CreationDate', value: createdAt },
                ],
              })),
            },
          ],
        }),
      );
    }

    if (!key) {
      if (request.method === 'PUT') {
        try {
          await mkdir(S3_ROOT, { recursive: true });
          await mkdir(resolve(S3_ROOT, bucket), { recursive: false });
        } catch (err) {
          if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
            return s3Err(set, 409, 'BucketAlreadyOwnedByYou', 'Bucket already exists', pathname);
          }
          throw err;
        }
        return new Response(null, {
          status: 200,
          headers: { Location: `/${bucket}` },
        });
      }
      if (request.method === 'DELETE') {
        try {
          const bucketDir = resolve(S3_ROOT, bucket);
          const st = await stat(bucketDir);
          if (!st.isDirectory()) {
            return s3Err(set, 404, 'NoSuchBucket', 'Bucket not found', pathname);
          }
          if (await hasAnyFile(bucketDir)) {
            return s3Err(set, 409, 'BucketNotEmpty', 'Bucket is not empty', pathname);
          }
          await rm(bucketDir, { recursive: true, force: true });
        } catch (err) {
          if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
            return s3Err(set, 404, 'NoSuchBucket', 'Bucket not found', pathname);
          }
          throw err;
        }
        return new Response(null, { status: 204 });
      }
      if (request.method === 'HEAD') {
        try {
          const st = await stat(resolve(S3_ROOT, bucket));
          if (!st.isDirectory()) return new Response(null, { status: 404 });
        } catch {
          return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 200 });
      }
      if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const delimiter = url.searchParams.get('delimiter') ?? '';
        const continuationToken = url.searchParams.get('continuation-token') ?? '';
        const maxKeys = Math.min(
          Math.max(Number.parseInt(url.searchParams.get('max-keys') ?? '1000', 10) || 1000, 1),
          1000,
        );
        const bucketDir = resolve(S3_ROOT, bucket);
        try {
          await stat(bucketDir);
        } catch {
          return s3Err(set, 404, 'NoSuchBucket', 'Bucket not found', pathname);
        }
        const all = (await walkObjects(bucketDir, bucket)).filter((item) =>
          item.key.startsWith(prefix),
        );
        const filtered = continuationToken
          ? all.filter((item) => item.key > continuationToken)
          : all;
        const page = filtered.slice(0, maxKeys);
        const isTruncated = filtered.length > page.length;
        const nextToken = isTruncated ? (page[page.length - 1]?.key ?? '') : '';
        const commonPrefixes = new Set<string>();
        const contents: ObjectRow[] = [];
        for (const item of page) {
          if (delimiter) {
            const rest = item.key.slice(prefix.length);
            const idx = rest.indexOf(delimiter);
            if (idx >= 0) {
              commonPrefixes.add(item.key.slice(0, prefix.length + idx + delimiter.length));
              continue;
            }
          }
          contents.push(item);
        }

        return xmlResponse(
          xmlDocument({
            name: 'ListBucketResult',
            attributes: { xmlns: S3_XMLNS },
            children: [
              { name: 'Name', value: bucket },
              { name: 'Prefix', value: prefix },
              { name: 'KeyCount', value: String(contents.length + commonPrefixes.size) },
              { name: 'MaxKeys', value: String(maxKeys) },
              { name: 'IsTruncated', value: String(isTruncated) },
              ...contents.map((item) => ({
                name: 'Contents',
                children: [
                  { name: 'Key', value: item.key },
                  { name: 'LastModified', value: item.mtime },
                  { name: 'ETag', value: item.md5 ? `"${item.md5}"` : '' },
                  { name: 'Size', value: String(item.size) },
                  { name: 'StorageClass', value: 'STANDARD' },
                ],
              })),
              ...[...commonPrefixes]
                .sort((a, b) => a.localeCompare(b))
                .map((prefixValue) => ({
                  name: 'CommonPrefixes',
                  children: [{ name: 'Prefix', value: prefixValue }],
                })),
              ...(nextToken ? [{ name: 'NextContinuationToken', value: nextToken }] : []),
            ],
          }),
        );
      }
      // ListObjects v1 (no list-type=2 param)
      if (request.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const delimiter = url.searchParams.get('delimiter') ?? '';
        const marker = url.searchParams.get('marker') ?? '';
        const maxKeys = Math.min(
          Math.max(Number.parseInt(url.searchParams.get('max-keys') ?? '1000', 10) || 1000, 1),
          1000,
        );
        const bucketDir = resolve(S3_ROOT, bucket);
        try {
          await stat(bucketDir);
        } catch {
          return s3Err(set, 404, 'NoSuchBucket', 'Bucket not found', pathname);
        }
        const all = (await walkObjects(bucketDir, bucket)).filter((item) =>
          item.key.startsWith(prefix),
        );
        const filtered = marker ? all.filter((item) => item.key > marker) : all;
        const page = filtered.slice(0, maxKeys);
        const isTruncated = filtered.length > page.length;
        const commonPrefixes = new Set<string>();
        const contents: ObjectRow[] = [];
        for (const item of page) {
          if (delimiter) {
            const rest = item.key.slice(prefix.length);
            const idx = rest.indexOf(delimiter);
            if (idx >= 0) {
              commonPrefixes.add(item.key.slice(0, prefix.length + idx + delimiter.length));
              continue;
            }
          }
          contents.push(item);
        }
        return xmlResponse(
          xmlDocument({
            name: 'ListBucketResult',
            attributes: { xmlns: S3_XMLNS },
            children: [
              { name: 'Name', value: bucket },
              { name: 'Prefix', value: prefix },
              { name: 'Marker', value: marker },
              { name: 'MaxKeys', value: String(maxKeys) },
              { name: 'IsTruncated', value: String(isTruncated) },
              ...contents.map((item) => ({
                name: 'Contents',
                children: [
                  { name: 'Key', value: item.key },
                  { name: 'LastModified', value: item.mtime },
                  { name: 'ETag', value: item.md5 ? `"${item.md5}"` : '' },
                  { name: 'Size', value: String(item.size) },
                  { name: 'StorageClass', value: 'STANDARD' },
                ],
              })),
              ...[...commonPrefixes]
                .sort((a, b) => a.localeCompare(b))
                .map((prefixValue) => ({
                  name: 'CommonPrefixes',
                  children: [{ name: 'Prefix', value: prefixValue }],
                })),
              ...(isTruncated
                ? [{ name: 'NextMarker', value: page[page.length - 1]?.key ?? '' }]
                : []),
            ],
          }),
        );
      }
      return s3Err(set, 405, 'MethodNotAllowed', 'Method not allowed', pathname);
    }

    const rel = objectRel(bucket, key);
    if (
      url.searchParams.has('uploads') ||
      url.searchParams.has('uploadId') ||
      url.searchParams.has('partNumber')
    ) {
      return handleMultipart(request, set, bucket, key, url);
    }
    if (request.method === 'PUT') {
      const copySource = request.headers.get('x-amz-copy-source');
      if (copySource) {
        const decoded = decodePathPart(
          copySource.startsWith('/') ? copySource.slice(1) : copySource,
        );
        if (!decoded)
          return s3Err(set, 400, 'InvalidArgument', 'Invalid x-amz-copy-source', pathname);
        const slashIdx = decoded.indexOf('/');
        if (slashIdx <= 0)
          return s3Err(
            set,
            400,
            'InvalidArgument',
            'x-amz-copy-source must be /bucket/key',
            pathname,
          );
        const srcBucket = decoded.slice(0, slashIdx);
        const srcKey = decoded.slice(slashIdx + 1);
        if (!validateBucket(srcBucket) || !srcKey) {
          return s3Err(set, 400, 'InvalidArgument', 'Invalid copy source', pathname);
        }
        if (srcKey.includes('\0') || srcKey.split('/').some((s) => s === '..' || s === '.')) {
          return s3Err(set, 400, 'InvalidArgument', 'Invalid copy source key', pathname);
        }
        const srcRel = objectRel(srcBucket, srcKey);
        try {
          await openStream(srcRel);
        } catch {
          return s3Err(set, 404, 'NoSuchKey', 'Copy source not found', pathname);
        }
        const srcDbRow = db
          .select({ md5: s3Object.md5 })
          .from(s3Object)
          .where(eq(s3Object.path, srcRel))
          .get();
        const srcMd5 = srcDbRow?.md5 ?? (await hashOnDisk(srcRel, 'md5'));
        const srcAbs = resolve(DATA_ROOT, srcRel);
        const destAbs = resolve(DATA_ROOT, rel);
        await mkdir(dirname(destAbs), { recursive: true });
        const tmp = `${destAbs}.tmp-${crypto.randomUUID().slice(0, 8)}`;
        await copyFile(srcAbs, tmp);
        await rename(tmp, destAbs);
        const destStat = await stat(destAbs);
        await db
          .insert(s3Object)
          .values({
            path: rel,
            bucket,
            key,
            size: destStat.size,
            mtimeMs: Math.round(destStat.mtimeMs),
            inode: Number(destStat.ino),
            md5: srcMd5,
          })
          .onConflictDoUpdate({
            target: s3Object.path,
            set: {
              size: destStat.size,
              mtimeMs: Math.round(destStat.mtimeMs),
              inode: Number(destStat.ino),
              md5: srcMd5,
            },
          });
        const lastModified = new Date(destStat.mtimeMs).toISOString();
        return xmlResponse(
          xmlDocument({
            name: 'CopyObjectResult',
            attributes: { xmlns: S3_XMLNS },
            children: [
              { name: 'ETag', value: `"${srcMd5}"` },
              { name: 'LastModified', value: lastModified },
            ],
          }),
        );
      }
      let result: { size: number; md5: string; mtimeMs: number; inode: number };
      try {
        await mkdir(resolve(S3_ROOT, bucket), { recursive: true });
        result = await writeUpload(
          rel,
          request.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        );
      } catch (err) {
        return s3Err(
          set,
          400,
          'InvalidRequest',
          err instanceof Error ? err.message : 'Upload failed',
          pathname,
        );
      }
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
      return new Response(null, {
        status: 200,
        headers: { ETag: `"${result.md5}"` },
      });
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      let opened: Awaited<ReturnType<typeof openStream>>;
      try {
        opened = await openStream(rel);
      } catch {
        return s3Err(set, 404, 'NoSuchKey', 'Object not found', pathname);
      }
      const dbRow = db
        .select({ md5: s3Object.md5 })
        .from(s3Object)
        .where(eq(s3Object.path, rel))
        .get();
      const etag = dbRow?.md5
        ? `"${dbRow.md5}"`
        : `"${opened.stat.size}-${Math.round(opened.stat.mtimeMs)}"`;
      const contentType = mimeFromName(basenameOf(key));
      const headers = {
        'Content-Length': String(opened.stat.size),
        'Content-Type': contentType,
        ETag: etag,
      };
      if (request.method === 'HEAD') {
        return new Response(Bun.file(opened.path), {
          status: 200,
          headers: {
            ...headers,
            'Last-Modified': new Date(opened.stat.mtimeMs).toUTCString(),
          },
        });
      }
      const range = request.headers.get('range');
      if (range) {
        const m = /^bytes=(\d+)?-(\d+)?$/.exec(range);
        if (!m || (m[1] === undefined && m[2] === undefined)) {
          return new Response(null, { status: 416 });
        }
        let start: number;
        let end: number;
        if (m[1] === undefined) {
          // Suffix range: bytes=-N → last N bytes
          const suffixLen = Number.parseInt(m[2]!, 10);
          start = Math.max(0, opened.stat.size - suffixLen);
          end = opened.stat.size - 1;
        } else {
          start = Number.parseInt(m[1], 10);
          end = m[2] !== undefined ? Number.parseInt(m[2], 10) : opened.stat.size - 1;
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= opened.stat.size) {
          return new Response(null, { status: 416 });
        }
        return new Response(readRange(opened.path, start, end), {
          status: 206,
          headers: {
            ...headers,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${opened.stat.size}`,
          },
        });
      }
      return new Response(Bun.file(opened.path).stream(), { status: 200, headers });
    }

    if (request.method === 'DELETE') {
      const bucketDir = resolve(S3_ROOT, bucket);
      const absObject = resolve(S3_ROOT, bucket, key);
      try {
        await removeFile(rel);
        await pruneEmptyParents(dirname(absObject), bucketDir);
      } catch {
        // DELETE is idempotent.
      }
      // Remove from DB regardless of whether the file existed on disk.
      db.delete(s3Object).where(eq(s3Object.path, rel));
      return new Response(null, { status: 204 });
    }

    return s3Err(set, 405, 'MethodNotAllowed', 'Method not allowed', pathname);
  };
}

const s3Handler = createS3Handler();

export const s3Routes = new Elysia({ name: 's3' })
  .get('/api/s3', s3Handler)
  .get('/api/s3/_ping', s3Handler)
  .get('/api/s3/*', s3Handler)
  .post('/api/s3/*', s3Handler)
  .put('/api/s3/*', s3Handler)
  .delete('/api/s3/*', s3Handler)
  .head('/api/s3/*', s3Handler);
