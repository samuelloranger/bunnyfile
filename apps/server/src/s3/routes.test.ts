import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-s3-routes-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.S3_ACCESS_KEY_ID = 'test-access-key';
process.env.S3_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.S3_REGION = 'us-east-1';

const [{ app }, { runMigrations }] = await Promise.all([
  import('../index'),
  import('../db/migrate'),
]);

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function deriveSigningKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

// Mirrors sigv4.ts — must stay in sync with the server implementation.
function canonicalUriPath(pathname: string): string {
  return (
    pathname
      .split('/')
      .map((seg) =>
        encodeURIComponent(seg).replace(
          /[!'()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        ),
      )
      .join('/') || '/'
  );
}

function signedRequest({
  method,
  path,
  body,
  signatureSuffix = '',
}: {
  method: string;
  path: string;
  body?: string;
  signatureSuffix?: string;
}): Request {
  const host = 'localhost';
  // Use current time so the 15-minute skew check passes.
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const region = process.env.S3_REGION!;
  const service = 's3';
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const url = new URL(`http://${host}${path}`);
  // Mirror sigv4.ts canonical query sort: by encoded key then encoded value.
  const pairs = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    canonicalUriPath(url.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = deriveSigningKey(
    process.env.S3_SECRET_ACCESS_KEY!,
    dateStamp,
    region,
    service,
  );
  const signature =
    createHmac('sha256', signingKey).update(stringToSign).digest('hex') + signatureSuffix;
  const authorization = `AWS4-HMAC-SHA256 Credential=${process.env.S3_ACCESS_KEY_ID!}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return new Request(`http://${host}${path}`, {
    method,
    body,
    headers: {
      authorization,
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    },
  });
}

function presignedUrl({
  method,
  path,
  expiresSeconds = 3600,
  dateOffsetMs = 0,
}: {
  method: string;
  path: string;
  expiresSeconds?: number;
  dateOffsetMs?: number;
}): string {
  const host = 'localhost';
  const now = new Date(Date.now() + dateOffsetMs);
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const region = process.env.S3_REGION!;
  const service = 's3';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID!;
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${scope}`;
  const signedHeaders = 'host';

  const url = new URL(`http://${host}${path}`);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', credential);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);

  const pairs = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    method,
    canonicalUriPath(url.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = deriveSigningKey(
    process.env.S3_SECRET_ACCESS_KEY!,
    dateStamp,
    region,
    service,
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  url.searchParams.set('X-Amz-Signature', signature);

  return url.toString().replace(`http://${host}`, '');
}

describe('s3 routes', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
  });

  it('accepts valid sigv4 signature on _ping endpoint', async () => {
    const res = await app.handle(signedRequest({ method: 'GET', path: '/api/s3/_ping' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const body = await res.text();
    expect(body).toContain('<PingResult>');
    expect(body).toContain('<Status>ok</Status>');
  });

  it('rejects invalid signature', async () => {
    const res = await app.handle(
      signedRequest({ method: 'GET', path: '/api/s3/_ping', signatureSuffix: 'broken' }),
    );
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('<Code>SignatureDoesNotMatch</Code>');
  });

  it('rejects bucket name with path traversal', async () => {
    const res = await app.handle(signedRequest({ method: 'PUT', path: '/api/s3/..%2Fetc' }));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('<Code>InvalidBucketName</Code>');
  });

  it('rejects key with path traversal', async () => {
    const bucket = `test-bucket-${crypto.randomUUID().slice(0, 8)}`;
    await app.handle(signedRequest({ method: 'PUT', path: `/api/s3/${bucket}` }));
    const res = await app.handle(
      signedRequest({ method: 'PUT', path: `/api/s3/${bucket}/..%2F..%2Fetc%2Fpasswd`, body: 'x' }),
    );
    expect(res.status).toBe(400);
    await app.handle(signedRequest({ method: 'DELETE', path: `/api/s3/${bucket}` }));
  });

  it('supports bucket and object lifecycle + list objects v2', async () => {
    const bucket = `test-bucket-${crypto.randomUUID().slice(0, 8)}`;

    const createBucket = await app.handle(
      signedRequest({ method: 'PUT', path: `/api/s3/${bucket}` }),
    );
    expect(createBucket.status).toBe(200);
    expect(createBucket.headers.get('location')).toBe(`/${bucket}`);

    const listBuckets = await app.handle(signedRequest({ method: 'GET', path: '/api/s3' }));
    expect(listBuckets.status).toBe(200);
    expect(await listBuckets.text()).toContain(`<Name>${bucket}</Name>`);

    const putObject = await app.handle(
      signedRequest({
        method: 'PUT',
        path: `/api/s3/${bucket}/docs/hello.txt`,
        body: 'hello world',
      }),
    );
    expect(putObject.status).toBe(200);
    // PutObject must return ETag so rclone can validate the upload.
    const putEtag = putObject.headers.get('etag');
    expect(putEtag).toBeTruthy();
    expect(putEtag).toMatch(/^"[0-9a-f]{32}"$/);

    const headObject = await app.handle(
      signedRequest({ method: 'HEAD', path: `/api/s3/${bucket}/docs/hello.txt` }),
    );
    expect(headObject.status).toBe(200);
    // ETag from HEAD must match the ETag from PutObject.
    expect(headObject.headers.get('etag')).toBe(putEtag);

    const getObject = await app.handle(
      signedRequest({ method: 'GET', path: `/api/s3/${bucket}/docs/hello.txt` }),
    );
    expect(getObject.status).toBe(200);
    expect(await getObject.text()).toBe('hello world');

    const listObjects = await app.handle(
      signedRequest({
        method: 'GET',
        path: `/api/s3/${bucket}?list-type=2&prefix=docs%2F&delimiter=%2F`,
      }),
    );
    expect(listObjects.status).toBe(200);
    const listedXml = await listObjects.text();
    expect(listedXml).toContain('<ListBucketResult');
    expect(listedXml).toContain('xmlns=');
    expect(listedXml).toContain('<Key>docs/hello.txt</Key>');
    expect(listedXml).toContain('<StorageClass>STANDARD</StorageClass>');
    // ETag in listing must include the sha256 from PutObject. The XML escapes "
    // as &quot; so compare using the escaped form.
    expect(listedXml).toContain(`<ETag>${putEtag!.replaceAll('"', '&quot;')}</ETag>`);

    // Suffix-range: bytes=-5 on "hello world" (11 bytes) should return "world".
    // The range header is not in SignedHeaders so appending it doesn't break the signature.
    const baseGetReq = signedRequest({ method: 'GET', path: `/api/s3/${bucket}/docs/hello.txt` });
    const suffixRangeReq = new Request(baseGetReq.url, {
      method: 'GET',
      headers: new Headers([...baseGetReq.headers.entries(), ['range', 'bytes=-5']]),
    });
    const suffixRes = await app.handle(suffixRangeReq);
    expect(suffixRes.status).toBe(206);
    expect(await suffixRes.text()).toBe('world');

    const deleteObject = await app.handle(
      signedRequest({ method: 'DELETE', path: `/api/s3/${bucket}/docs/hello.txt` }),
    );
    expect(deleteObject.status).toBe(204);

    // After delete, object should 404
    const getAfterDelete = await app.handle(
      signedRequest({ method: 'GET', path: `/api/s3/${bucket}/docs/hello.txt` }),
    );
    expect(getAfterDelete.status).toBe(404);

    const deleteBucket = await app.handle(
      signedRequest({ method: 'DELETE', path: `/api/s3/${bucket}` }),
    );
    expect(deleteBucket.status).toBe(204);
  });

  it('CopyObject copies an object server-side', async () => {
    const bucket = `copy-bucket-${crypto.randomUUID().slice(0, 8)}`;
    await app.handle(signedRequest({ method: 'PUT', path: `/api/s3/${bucket}` }));
    await app.handle(
      signedRequest({
        method: 'PUT',
        path: `/api/s3/${bucket}/original.txt`,
        body: 'original content',
      }),
    );

    const copyReq = signedRequest({ method: 'PUT', path: `/api/s3/${bucket}/copy.txt` });
    const copyReqWithHeader = new Request(copyReq.url, {
      method: 'PUT',
      headers: new Headers([
        ...copyReq.headers.entries(),
        ['x-amz-copy-source', `/${bucket}/original.txt`],
      ]),
    });
    const copyRes = await app.handle(copyReqWithHeader);
    expect(copyRes.status).toBe(200);
    const copyXml = await copyRes.text();
    expect(copyXml).toContain('<CopyObjectResult');
    expect(copyXml).toContain('<ETag>');

    const getRes = await app.handle(
      signedRequest({ method: 'GET', path: `/api/s3/${bucket}/copy.txt` }),
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('original content');

    for (const key of ['original.txt', 'copy.txt']) {
      await app.handle(signedRequest({ method: 'DELETE', path: `/api/s3/${bucket}/${key}` }));
    }
    await app.handle(signedRequest({ method: 'DELETE', path: `/api/s3/${bucket}` }));
  });
});

describe('presigned URLs', () => {
  const presignBucket = `presign-bucket-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await app.handle(signedRequest({ method: 'PUT', path: `/api/s3/${presignBucket}` }));
    await app.handle(
      signedRequest({
        method: 'PUT',
        path: `/api/s3/${presignBucket}/hello.txt`,
        body: 'hello presigned',
      }),
    );
  });

  it('presigned GET downloads an object without Authorization header', async () => {
    const path = presignedUrl({ method: 'GET', path: `/api/s3/${presignBucket}/hello.txt` });
    const res = await app.handle(
      new Request(`http://localhost${path}`, { method: 'GET', headers: { host: 'localhost' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello presigned');
  });

  it('presigned PUT uploads an object without Authorization header', async () => {
    const path = presignedUrl({ method: 'PUT', path: `/api/s3/${presignBucket}/uploaded.txt` });
    const putRes = await app.handle(
      new Request(`http://localhost${path}`, {
        method: 'PUT',
        headers: { host: 'localhost' },
        body: 'uploaded via presigned',
      }),
    );
    expect(putRes.status).toBe(200);
    const getRes = await app.handle(
      signedRequest({ method: 'GET', path: `/api/s3/${presignBucket}/uploaded.txt` }),
    );
    expect(await getRes.text()).toBe('uploaded via presigned');
  });

  it('expired presigned URL returns 400 ExpiredToken', async () => {
    const path = presignedUrl({
      method: 'GET',
      path: `/api/s3/${presignBucket}/hello.txt`,
      expiresSeconds: 60,
      dateOffsetMs: -7200 * 1000,
    });
    const res = await app.handle(
      new Request(`http://localhost${path}`, { method: 'GET', headers: { host: 'localhost' } }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('ExpiredToken');
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
