import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-s3-mpu-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.S3_ACCESS_KEY_ID = 'mpu-access-key';
process.env.S3_SECRET_ACCESS_KEY = 'mpu-secret-key';
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
function deriveSigningKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}
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
}: {
  method: string;
  path: string;
  body?: string | Uint8Array;
}): Request {
  const host = 'localhost';
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const region = process.env.S3_REGION!;
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const url = new URL(`http://${host}${path}`);
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
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = deriveSigningKey(process.env.S3_SECRET_ACCESS_KEY!, dateStamp, region, 's3');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
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

const mpuBucket = `mpu-bucket-${crypto.randomUUID().slice(0, 8)}`;

describe('multipart uploads', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
    await app.handle(signedRequest({ method: 'PUT', path: `/api/s3/${mpuBucket}` }));
  });

  it('CreateMultipartUpload returns UploadId', async () => {
    const res = await app.handle(
      signedRequest({ method: 'POST', path: `/api/s3/${mpuBucket}/file.bin?uploads` }),
    );
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<InitiateMultipartUploadResult');
    expect(xml).toContain('<UploadId>');
  });

  it('full lifecycle: initiate → 3 parts → complete → download', async () => {
    const initRes = await app.handle(
      signedRequest({ method: 'POST', path: `/api/s3/${mpuBucket}/multi.txt?uploads` }),
    );
    const initXml = await initRes.text();
    const uploadId = initXml.match(/<UploadId>([^<]+)<\/UploadId>/)![1]!;

    const parts = ['hello ', 'world', '!'];
    const etags: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const partRes = await app.handle(
        signedRequest({
          method: 'PUT',
          path: `/api/s3/${mpuBucket}/multi.txt?partNumber=${i + 1}&uploadId=${uploadId}`,
          body: parts[i]!,
        }),
      );
      expect(partRes.status).toBe(200);
      const etag = partRes.headers.get('etag');
      expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
      etags.push(etag!);
    }

    const listRes = await app.handle(
      signedRequest({ method: 'GET', path: `/api/s3/${mpuBucket}/multi.txt?uploadId=${uploadId}` }),
    );
    expect(listRes.status).toBe(200);
    expect(await listRes.text()).toContain('<ListPartsResult');

    const completeBody = `<CompleteMultipartUpload>${parts
      .map((_, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etags[i]}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`;
    const completeRes = await app.handle(
      signedRequest({
        method: 'POST',
        path: `/api/s3/${mpuBucket}/multi.txt?uploadId=${uploadId}`,
        body: completeBody,
      }),
    );
    expect(completeRes.status).toBe(200);
    const completeXml = await completeRes.text();
    expect(completeXml).toContain('<CompleteMultipartUploadResult');
    expect(completeXml).toMatch(/-3(&quot;|")/);

    const getRes = await app.handle(
      signedRequest({ method: 'GET', path: `/api/s3/${mpuBucket}/multi.txt` }),
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('hello world!');
  });

  it('AbortMultipartUpload cleans up temp parts', async () => {
    const initRes = await app.handle(
      signedRequest({ method: 'POST', path: `/api/s3/${mpuBucket}/aborted.bin?uploads` }),
    );
    const uploadId = (await initRes.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]!;
    await app.handle(
      signedRequest({
        method: 'PUT',
        path: `/api/s3/${mpuBucket}/aborted.bin?partNumber=1&uploadId=${uploadId}`,
        body: 'data',
      }),
    );
    const abortRes = await app.handle(
      signedRequest({
        method: 'DELETE',
        path: `/api/s3/${mpuBucket}/aborted.bin?uploadId=${uploadId}`,
      }),
    );
    expect(abortRes.status).toBe(204);

    const completeRes = await app.handle(
      signedRequest({
        method: 'POST',
        path: `/api/s3/${mpuBucket}/aborted.bin?uploadId=${uploadId}`,
        body: '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"abc"</ETag></Part></CompleteMultipartUpload>',
      }),
    );
    expect(completeRes.status).toBe(404);
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
