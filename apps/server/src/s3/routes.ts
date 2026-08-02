import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Elysia } from 'elysia';
import { mimeFromName } from '../files/mime';
import { basenameOf } from '../files/paths';
import {
  createFileStream,
  DATA_ROOT,
  openStream,
  readRange,
  S3_ROOT,
} from '../files/store';
import { generateAndStoreThumbnail, isThumbnailable } from '../files/thumbnail';
import { lookupS3SecretKey } from './access-keys';
import {
  assertBucketName,
  BucketError,
  copyObject,
  createBucket,
  deleteBucket,
  deleteObject,
  headObject,
  listBuckets,
  listObjects,
  objectRel,
  putObject,
} from './library';
import { handleMultipart } from './multipart';
import { verifyPresigned, verifySigV4 } from './sigv4';
import { s3ErrorXml, xmlDocument } from './xml';

await mkdir(S3_ROOT, { recursive: true });

function s3Config() {
  return {
    region: Bun.env.S3_REGION ?? 'us-east-1',
    service: 's3',
    lookupKey: lookupS3SecretKey,
  };
}

function validateBucket(name: string): boolean {
  try {
    assertBucketName(name);
    return true;
  } catch {
    return false;
  }
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

function mapBucketError(
  set: { status?: number | string },
  err: BucketError,
  pathname: string,
  kind: 'bucket' | 'key' = 'bucket',
): Response {
  switch (err.code) {
    case 'invalid_bucket':
      return s3Err(set, 400, 'InvalidBucketName', err.message, pathname);
    case 'invalid_key':
      return s3Err(set, 400, 'InvalidArgument', err.message, pathname);
    case 'not_found':
      return s3Err(
        set,
        404,
        kind === 'bucket' ? 'NoSuchBucket' : 'NoSuchKey',
        kind === 'bucket' ? 'Bucket not found' : 'Object not found',
        pathname,
      );
    case 'bucket_exists':
      return s3Err(set, 409, 'BucketAlreadyOwnedByYou', 'Bucket already exists', pathname);
    case 'bucket_not_empty':
      return s3Err(set, 409, 'BucketNotEmpty', 'Bucket is not empty', pathname);
    case 'is_directory':
      return s3Err(set, 404, 'NoSuchKey', 'Object not found', pathname);
    default:
      throw err;
  }
}

const S3_XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

function listResultToXml(
  bucket: string,
  prefix: string,
  maxKeys: number,
  result: Awaited<ReturnType<typeof listObjects>>,
  extra: Array<{ name: string; value: string }> = [],
) {
  return xmlDocument({
    name: 'ListBucketResult',
    attributes: { xmlns: S3_XMLNS },
    children: [
      { name: 'Name', value: bucket },
      { name: 'Prefix', value: prefix },
      { name: 'KeyCount', value: String(result.objects.length + result.prefixes.length) },
      { name: 'MaxKeys', value: String(maxKeys) },
      { name: 'IsTruncated', value: String(result.isTruncated) },
      ...extra,
      ...result.objects.map((item) => ({
        name: 'Contents',
        children: [
          { name: 'Key', value: item.key },
          { name: 'LastModified', value: new Date(item.mtimeMs).toISOString() },
          { name: 'ETag', value: item.md5 ? `"${item.md5}"` : '' },
          { name: 'Size', value: String(item.size) },
          { name: 'StorageClass', value: 'STANDARD' },
        ],
      })),
      ...result.prefixes.map((prefixValue) => ({
        name: 'CommonPrefixes',
        children: [{ name: 'Prefix', value: prefixValue }],
      })),
    ],
  });
}

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
          await createBucket(bucket);
        } catch (err) {
          if (err instanceof BucketError) return mapBucketError(set, err, pathname);
          throw err;
        }
        return new Response(null, {
          status: 200,
          headers: { Location: `/${bucket}` },
        });
      }
      if (request.method === 'DELETE') {
        try {
          await deleteBucket(bucket);
        } catch (err) {
          if (err instanceof BucketError) return mapBucketError(set, err, pathname);
          throw err;
        }
        return new Response(null, { status: 204 });
      }
      if (request.method === 'HEAD') {
        try {
          await listObjects({ bucket, maxKeys: 1 });
        } catch (err) {
          if (err instanceof BucketError && err.code === 'not_found') {
            return new Response(null, { status: 404 });
          }
          if (err instanceof BucketError) return mapBucketError(set, err, pathname);
          throw err;
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
        let result: Awaited<ReturnType<typeof listObjects>>;
        try {
          result = await listObjects({
            bucket,
            prefix,
            delimiter,
            continuationToken,
            maxKeys,
          });
        } catch (err) {
          if (err instanceof BucketError) return mapBucketError(set, err, pathname);
          throw err;
        }
        return xmlResponse(
          listResultToXml(bucket, prefix, maxKeys, result, [
            ...(result.nextContinuationToken
              ? [{ name: 'NextContinuationToken', value: result.nextContinuationToken }]
              : []),
          ]),
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
        let result: Awaited<ReturnType<typeof listObjects>>;
        try {
          result = await listObjects({
            bucket,
            prefix,
            delimiter,
            continuationToken: marker,
            maxKeys,
          });
        } catch (err) {
          if (err instanceof BucketError) return mapBucketError(set, err, pathname);
          throw err;
        }
        return xmlResponse(
          listResultToXml(bucket, prefix, maxKeys, result, [
            { name: 'Marker', value: marker },
            ...(result.isTruncated && result.nextContinuationToken
              ? [{ name: 'NextMarker', value: result.nextContinuationToken }]
              : []),
          ]),
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
        let result: Awaited<ReturnType<typeof copyObject>>;
        try {
          result = await copyObject(srcBucket, srcKey, bucket, key);
        } catch (err) {
          if (err instanceof BucketError) {
            if (err.code === 'not_found') {
              return s3Err(set, 404, 'NoSuchKey', 'Copy source not found', pathname);
            }
            return mapBucketError(set, err, pathname, 'key');
          }
          throw err;
        }
        const lastModified = new Date(result.mtimeMs).toISOString();
        return xmlResponse(
          xmlDocument({
            name: 'CopyObjectResult',
            attributes: { xmlns: S3_XMLNS },
            children: [
              { name: 'ETag', value: `"${result.md5}"` },
              { name: 'LastModified', value: lastModified },
            ],
          }),
        );
      }
      let result: Awaited<ReturnType<typeof putObject>>;
      try {
        result = await putObject(bucket, key, request);
      } catch (err) {
        if (err instanceof BucketError) return mapBucketError(set, err, pathname, 'key');
        return s3Err(
          set,
          400,
          'InvalidRequest',
          err instanceof Error ? err.message : 'Upload failed',
          pathname,
        );
      }
      const mime = mimeFromName(basenameOf(key));
      if (isThumbnailable(mime)) {
        generateAndStoreThumbnail(resolve(DATA_ROOT, rel), rel, mime).catch(() => {});
      }
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
      let info: Awaited<ReturnType<typeof headObject>>;
      try {
        info = await headObject(bucket, key);
      } catch {
        info = {
          key,
          size: opened.stat.size,
          mtimeMs: Math.round(opened.stat.mtimeMs),
          md5: '',
        };
      }
      const etag = info.md5 ? `"${info.md5}"` : `"${info.size}-${info.mtimeMs}"`;
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
      return new Response(createFileStream(opened.path), { status: 200, headers });
    }

    if (request.method === 'DELETE') {
      await deleteObject(bucket, key);
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
