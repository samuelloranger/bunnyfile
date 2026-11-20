import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Elysia } from 'elysia';
import { mimeFromName } from '../files/mime';
import { basenameOf } from '../files/paths';
import { createFileStream, DATA_ROOT, openStream, readRange, S3_ROOT } from '../files/store';
import { generateAndStoreThumbnail, isThumbnailable } from '../files/thumbnail';
import { lookupS3SecretKey } from './access-keys';
import {
  checkWritePreconditions,
  copySourcePreconditionFails,
  PreconditionError,
  readPreconditionStatus,
} from './conditions';
import {
  assertBucketName,
  BucketError,
  copyObject,
  createBucket,
  currentEtag,
  deleteBucket,
  deleteObject,
  headObject,
  listBuckets,
  listObjects,
  objectEtag,
  objectRel,
  putObject,
} from './library';
import { handleMultipart, listMultipartUploads } from './multipart';
import { PayloadError, payloadStream, payloadText } from './payload';
import { verifyPresigned, verifySigV4 } from './sigv4';
import { s3ErrorXml, unescapeXml, xmlDocument } from './xml';

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

/**
 * S3 can also be served at the root of its own hostname (`S3_DOMAIN`), as
 * clients built on minio-go (restic, kopia, mc) require: they take a bare host
 * as the endpoint and put the bucket first in the path.
 */
export function isS3HostRequest(request: Request): boolean {
  const domain = Bun.env.S3_DOMAIN?.trim().toLowerCase();
  if (!domain) return false;
  const host = (request.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '');
  return host === domain;
}

function splitS3Path(pathname: string, atRoot: boolean): S3PathResult {
  const raw = atRoot ? pathname.replace(/^\//, '') : pathname.replace(/^\/api\/s3\/?/, '');
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

const MAX_DELETE_BODY = 2 * 1024 * 1024;

type DeleteEntry = { key: string; versionId: string | null };

/** Text between the first `<tag>` and its `</tag>` in `xml`, or null. */
function element(xml: string, tag: string): string | null {
  const start = xml.indexOf(`<${tag}>`);
  if (start < 0) return null;
  const end = xml.indexOf(`</${tag}>`, start);
  return end < 0 ? null : xml.slice(start + tag.length + 2, end);
}

/**
 * Parses a DeleteObjects body with a forward-only scan (no backtracking
 * regexes, so a crafted body costs linear time). Null when the body is not a
 * `<Delete>` document listing 1 to 1000 objects.
 */
function parseDeleteBody(xml: string): { quiet: boolean; entries: DeleteEntry[] } | null {
  if (xml.includes('<![CDATA[')) return null;
  const root = xml.indexOf('<Delete');
  if (root < 0 || xml.lastIndexOf('</Delete>') < root) return null;
  const entries: DeleteEntry[] = [];
  for (let pos = root; ; ) {
    let open = xml.indexOf('<Object', pos);
    // Skip longer tag names that merely start with "Object".
    while (open >= 0 && !/[\s>]/.test(xml[open + 7] ?? '')) open = xml.indexOf('<Object', open + 7);
    if (open < 0) break;
    const contentStart = xml.indexOf('>', open) + 1;
    const close = xml.indexOf('</Object>', contentStart);
    if (contentStart === 0 || close < 0) return null;
    const inner = xml.slice(contentStart, close);
    const rawKey = element(inner, 'Key');
    const key = rawKey === null ? null : unescapeXml(rawKey);
    if (key === null) return null;
    const rawVersion = element(inner, 'VersionId');
    entries.push({ key, versionId: rawVersion === null ? null : unescapeXml(rawVersion) });
    if (entries.length > 1000) return null;
    pos = close + '</Object>'.length;
  }
  if (entries.length === 0) return null;
  const quiet = element(xml, 'Quiet')?.trim().toLowerCase() === 'true';
  return { quiet, entries };
}

async function deleteObjects(
  request: Request,
  set: { status?: number | string },
  bucket: string,
  pathname: string,
  signing: Parameters<typeof payloadText>[1],
): Promise<Response> {
  let body: string;
  try {
    body = await payloadText(request, signing, { maxBytes: MAX_DELETE_BODY });
  } catch (err) {
    if (err instanceof PayloadError) return s3Err(set, err.status, err.code, err.message, pathname);
    throw err;
  }
  const parsed = parseDeleteBody(body);
  if (!parsed) {
    return s3Err(set, 400, 'MalformedXML', 'The Delete body must list 1 to 1000 objects', pathname);
  }
  try {
    await listObjects({ bucket, maxKeys: 1 });
  } catch (err) {
    if (err instanceof BucketError) return mapBucketError(set, err, pathname);
    throw err;
  }
  const results = [];
  for (const { key, versionId } of parsed.entries) {
    if (versionId !== null && versionId !== 'null') {
      // No versioning: deleting the current object here would delete the wrong thing.
      results.push({
        name: 'Error',
        children: [
          { name: 'Key', value: key },
          { name: 'VersionId', value: versionId },
          { name: 'Code', value: 'NotImplemented' },
          { name: 'Message', value: 'BunnyFile does not support object versions' },
        ],
      });
      continue;
    }
    try {
      await deleteObject(bucket, key);
      if (!parsed.quiet) results.push({ name: 'Deleted', children: [{ name: 'Key', value: key }] });
    } catch (err) {
      results.push({
        name: 'Error',
        children: [
          { name: 'Key', value: key },
          { name: 'Code', value: err instanceof BucketError ? 'InvalidArgument' : 'InternalError' },
          { name: 'Message', value: err instanceof Error ? err.message : String(err) },
        ],
      });
    }
  }
  return xmlResponse(
    xmlDocument({ name: 'DeleteResult', attributes: { xmlns: S3_XMLNS }, children: results }),
  );
}

// Auth failures S3 reports as 403; malformed auth input stays 400.
const FORBIDDEN_AUTH_CODES = new Set([
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'RequestTimeTooSkewed',
]);

/**
 * S3 subresources BunnyFile does not implement. Without this guard they fell
 * through to the plain object handlers: `PUT ?tagging` overwrote the object
 * with the tagging XML and `DELETE ?tagging` deleted it.
 */
const UNSUPPORTED_SUBRESOURCES = [
  'accelerate',
  'acl',
  'analytics',
  'attributes',
  'cors',
  'encryption',
  'intelligent-tiering',
  'inventory',
  'legal-hold',
  'lifecycle',
  'logging',
  'metadataConfiguration',
  'metrics',
  'notification',
  'object-lock',
  'ownershipControls',
  'policy',
  'policyStatus',
  'publicAccessBlock',
  'renameObject',
  'replication',
  'requestPayment',
  'restore',
  'retention',
  'select',
  'tagging',
  'torrent',
  'versions',
  'website',
];

function unsupportedSubresource(url: URL, method: string, hasKey: boolean): string | null {
  const found = UNSUPPORTED_SUBRESOURCES.find((name) => url.searchParams.has(name));
  if (found) return found;
  const versionId = url.searchParams.get('versionId');
  if (versionId !== null && versionId !== 'null') return 'versionId';
  // Only reading the (never enabled) versioning state is supported.
  if (url.searchParams.has('versioning') && (hasKey || method !== 'GET')) return 'versioning';
  return null;
}

// `response-*` query parameters override these headers on GET and HEAD.
const RESPONSE_OVERRIDES: Record<string, string> = {
  'response-cache-control': 'Cache-Control',
  'response-content-disposition': 'Content-Disposition',
  'response-content-encoding': 'Content-Encoding',
  'response-content-language': 'Content-Language',
  'response-content-type': 'Content-Type',
  'response-expires': 'Expires',
};

/** The requested header overrides, or null when a value is not a valid header value. */
function responseOverrides(url: URL): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [param, header] of Object.entries(RESPONSE_OVERRIDES)) {
    const value = url.searchParams.get(param);
    if (value === null) continue;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the intent
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return null;
    out[header] = value;
  }
  return out;
}

/** True when the URL carries a query parameter other than auth/SDK bookkeeping. */
function hasSubresource(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (!/^x-amz-/i.test(name) && name !== 'x-id') return true;
  }
  return false;
}

function listResultToXml(
  bucket: string,
  prefix: string,
  maxKeys: number,
  result: Awaited<ReturnType<typeof listObjects>>,
  extra: Array<{ name: string; value: string }> = [],
  urlEncode = false,
) {
  // encoding-type=url: keys and prefixes are URL-encoded and the response says so.
  const enc = (v: string) => (urlEncode ? encodeURIComponent(v).replace(/%2F/g, '/') : v);
  return xmlDocument({
    name: 'ListBucketResult',
    attributes: { xmlns: S3_XMLNS },
    children: [
      { name: 'Name', value: bucket },
      { name: 'Prefix', value: enc(prefix) },
      { name: 'KeyCount', value: String(result.objects.length + result.prefixes.length) },
      { name: 'MaxKeys', value: String(maxKeys) },
      { name: 'IsTruncated', value: String(result.isTruncated) },
      ...(urlEncode ? [{ name: 'EncodingType', value: 'url' }] : []),
      ...extra.map((e) =>
        ['Delimiter', 'StartAfter', 'Marker', 'NextMarker'].includes(e.name)
          ? { ...e, value: enc(e.value) }
          : e,
      ),
      ...result.objects.map((item) => ({
        name: 'Contents',
        children: [
          { name: 'Key', value: enc(item.key) },
          { name: 'LastModified', value: new Date(item.mtimeMs).toISOString() },
          { name: 'ETag', value: item.md5 ? `"${item.md5}"` : '' },
          { name: 'Size', value: String(item.size) },
          { name: 'StorageClass', value: 'STANDARD' },
        ],
      })),
      ...result.prefixes.map((prefixValue) => ({
        name: 'CommonPrefixes',
        children: [{ name: 'Prefix', value: enc(prefixValue) }],
      })),
    ],
  });
}

async function bucketMissing(
  set: { status?: number | string },
  bucket: string,
  pathname: string,
): Promise<Response | null> {
  try {
    await listObjects({ bucket, maxKeys: 1 });
    return null;
  } catch (err) {
    if (err instanceof BucketError) return mapBucketError(set, err, pathname);
    throw err;
  }
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
        FORBIDDEN_AUTH_CODES.has(verification.code) ? 403 : 400,
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

    const parsed = splitS3Path(pathname, isS3HostRequest(request));
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

    const unsupported = unsupportedSubresource(url, request.method, key !== null);
    if (unsupported) {
      return s3Err(
        set,
        501,
        'NotImplemented',
        `BunnyFile does not implement the ${unsupported} subresource`,
        pathname,
      );
    }

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
      // Bucket PUT/DELETE take no subresources here; anything else (?cors,
      // ?policy, ...) must not create or delete the bucket.
      if ((request.method === 'PUT' || request.method === 'DELETE') && hasSubresource(url)) {
        return s3Err(
          set,
          501,
          'NotImplemented',
          'This bucket subresource is not implemented',
          pathname,
        );
      }
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
      if (request.method === 'POST' && url.searchParams.has('delete')) {
        return deleteObjects(request, set, bucket, pathname, verification.signing);
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
      if (request.method === 'GET' && url.searchParams.has('location')) {
        const missing = await bucketMissing(set, bucket, pathname);
        if (missing) return missing;
        // us-east-1 is reported as an empty LocationConstraint, like S3.
        const region = s3Config().region;
        return xmlResponse(
          xmlDocument({
            name: 'LocationConstraint',
            attributes: { xmlns: S3_XMLNS },
            value: region === 'us-east-1' ? '' : region,
          }),
        );
      }
      if (request.method === 'GET' && url.searchParams.has('versioning')) {
        const missing = await bucketMissing(set, bucket, pathname);
        if (missing) return missing;
        // Versioning was never enabled: S3 answers with an empty configuration.
        return xmlResponse(
          xmlDocument({ name: 'VersioningConfiguration', attributes: { xmlns: S3_XMLNS } }),
        );
      }
      if (request.method === 'GET' && url.searchParams.has('uploads')) {
        const missing = await bucketMissing(set, bucket, pathname);
        if (missing) return missing;
        return listMultipartUploads(bucket, url.searchParams.get('prefix') ?? '');
      }
      if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const delimiter = url.searchParams.get('delimiter') ?? '';
        const continuationToken = url.searchParams.get('continuation-token') ?? '';
        const startAfter = url.searchParams.get('start-after') ?? '';
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
            startAfter,
            maxKeys,
          });
        } catch (err) {
          if (err instanceof BucketError) return mapBucketError(set, err, pathname);
          throw err;
        }
        return xmlResponse(
          listResultToXml(
            bucket,
            prefix,
            maxKeys,
            result,
            [
              ...(delimiter ? [{ name: 'Delimiter', value: delimiter }] : []),
              ...(continuationToken
                ? [{ name: 'ContinuationToken', value: continuationToken }]
                : []),
              ...(startAfter ? [{ name: 'StartAfter', value: startAfter }] : []),
              ...(result.nextContinuationToken
                ? [{ name: 'NextContinuationToken', value: result.nextContinuationToken }]
                : []),
            ],
            url.searchParams.get('encoding-type') === 'url',
          ),
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
          listResultToXml(
            bucket,
            prefix,
            maxKeys,
            result,
            [
              ...(delimiter ? [{ name: 'Delimiter', value: delimiter }] : []),
              { name: 'Marker', value: marker },
              ...(result.isTruncated && result.nextContinuationToken
                ? [{ name: 'NextMarker', value: result.nextContinuationToken }]
                : []),
            ],
            url.searchParams.get('encoding-type') === 'url',
          ),
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
      return handleMultipart(request, set, bucket, key, url, verification.signing);
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
          const source = await headObject(srcBucket, srcKey);
          if (copySourcePreconditionFails(request, objectEtag(source), source.mtimeMs)) {
            return s3Err(
              set,
              412,
              'PreconditionFailed',
              'At least one of the pre-conditions you specified did not hold',
              pathname,
            );
          }
          const precondition = (etag: string | null) => checkWritePreconditions(request, etag);
          precondition(await currentEtag(bucket, key));
          result = await copyObject(srcBucket, srcKey, bucket, key, precondition);
        } catch (err) {
          if (err instanceof PreconditionError) {
            return s3Err(set, err.status, err.code, err.message, pathname);
          }
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
        // Checked up front to fail fast, and again under the commit lock.
        const precondition = (etag: string | null) => checkWritePreconditions(request, etag);
        precondition(await currentEtag(bucket, key));
        result = await putObject(
          bucket,
          key,
          payloadStream(request, verification.signing),
          precondition,
        );
      } catch (err) {
        if (err instanceof BucketError) return mapBucketError(set, err, pathname, 'key');
        if (err instanceof PayloadError || err instanceof PreconditionError) {
          return s3Err(set, err.status, err.code, err.message, pathname);
        }
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
        opened = await openStream(rel, DATA_ROOT);
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
      const etag = `"${objectEtag(info)}"`;
      const lastModified = new Date(opened.stat.mtimeMs).toUTCString();
      const precondition = readPreconditionStatus(request, objectEtag(info), opened.stat.mtimeMs);
      if (precondition === 304) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Last-Modified': lastModified },
        });
      }
      if (precondition === 412) {
        if (request.method === 'HEAD') return new Response(null, { status: 412 });
        return s3Err(
          set,
          412,
          'PreconditionFailed',
          'At least one of the pre-conditions you specified did not hold',
          pathname,
        );
      }
      const overrides = responseOverrides(url);
      if (!overrides) {
        return s3Err(set, 400, 'InvalidArgument', 'Invalid response-* header override', pathname);
      }
      const contentType = mimeFromName(basenameOf(key));
      const headers = {
        'Content-Length': String(opened.stat.size),
        'Content-Type': contentType,
        ETag: etag,
        'Last-Modified': lastModified,
        ...overrides,
      };
      if (request.method === 'HEAD') {
        return new Response(Bun.file(opened.path), { status: 200, headers });
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
      try {
        await deleteObject(bucket, key);
      } catch (err) {
        if (err instanceof BucketError) return mapBucketError(set, err, pathname);
        throw err;
      }
      return new Response(null, { status: 204 });
    }

    return s3Err(set, 405, 'MethodNotAllowed', 'Method not allowed', pathname);
  };
}

export const s3Handler = createS3Handler();

export const s3Routes = new Elysia({ name: 's3' })
  .get('/api/s3', s3Handler)
  .get('/api/s3/_ping', s3Handler)
  .get('/api/s3/*', s3Handler)
  .post('/api/s3/*', s3Handler)
  .put('/api/s3/*', s3Handler)
  .delete('/api/s3/*', s3Handler)
  .head('/api/s3/*', s3Handler);
