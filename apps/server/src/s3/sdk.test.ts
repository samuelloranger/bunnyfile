/**
 * Real-client compatibility: drives the S3 API with the official AWS SDK for
 * JavaScript over HTTPS. Since the 2025 "default data integrity protections",
 * SDKs send streaming bodies as `aws-chunked` with a trailing checksum only
 * over HTTPS, so a plain-HTTP test would miss that path entirely.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-s3-sdk-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.S3_ACCESS_KEY_ID = 'sdk-access-key';
process.env.S3_SECRET_ACCESS_KEY = 'sdk-secret-key';
process.env.S3_REGION = 'us-east-1';
process.env.BETTER_AUTH_SECRET = 'sdk-test-secret-for-s3-integration-tests';
// The test server uses a throwaway self-signed certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const [{ app }, { runMigrations }] = await Promise.all([
  import('../index'),
  import('../db/migrate'),
]);

let s3: S3Client;
const bucket = 'sdk-tests';

async function text(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body!.transformToString();
}

beforeAll(async () => {
  await mkdir(process.env.DATA_DIR!, { recursive: true });
  runMigrations();
  const cert = join(testRoot, 'cert.pem');
  const key = join(testRoot, 'key.pem');
  const gen = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  if (!gen.success) throw new Error(`openssl failed: ${gen.stderr.toString()}`);
  app.listen({ port: 0, hostname: '127.0.0.1', tls: { cert: Bun.file(cert), key: Bun.file(key) } });
  s3 = new S3Client({
    endpoint: `https://127.0.0.1:${app.server!.port}/api/s3`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
}, 30_000);

afterAll(async () => {
  s3?.destroy();
  await app.stop(true);
  await rm(testRoot, { recursive: true, force: true });
});

describe('AWS SDK for JavaScript over HTTPS', () => {
  it('stores a string body byte-exact (checksum sent as a header)', async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'string.txt', Body: 'hello' }));
    expect(await text('string.txt')).toBe('hello');
  });

  it('stores a streamed body byte-exact (aws-chunked with a CRC32 trailer)', async () => {
    const body = 'streamed through aws-chunked';
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: 'stream.txt',
        Body: Readable.from([Buffer.from(body)]),
        ContentLength: body.length,
      }),
    );
    expect(await text('stream.txt')).toBe(body);
  });

  it.each(['CRC32C', 'SHA1', 'SHA256'] as const)(
    'accepts ChecksumAlgorithm %s on a streamed body',
    async (algorithm) => {
      const body = `checksummed with ${algorithm}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `algo-${algorithm}.txt`,
          Body: Readable.from([Buffer.from(body)]),
          ContentLength: body.length,
          ChecksumAlgorithm: algorithm,
        }),
      );
      expect(await text(`algo-${algorithm}.txt`)).toBe(body);
    },
  );

  it('stores a multipart upload byte-exact', async () => {
    const data = crypto.getRandomValues(new Uint8Array(6 * 1024 * 1024 + 321));
    await new Upload({
      client: s3,
      params: { Bucket: bucket, Key: 'multipart.bin', Body: Readable.from([Buffer.from(data)]) },
      partSize: 5 * 1024 * 1024,
    }).done();
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'multipart.bin' }));
    expect(Buffer.from(await res.Body!.transformToByteArray()).equals(Buffer.from(data))).toBe(
      true,
    );
  }, 30_000);

  it('reads back with ChecksumMode enabled', async () => {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: 'string.txt', ChecksumMode: 'ENABLED' }),
    );
    expect(await res.Body!.transformToString()).toBe('hello');
  });

  it('lists with a prefix containing characters SigV4 must percent-encode', async () => {
    const key = "dir/it's (1) *x*! y.txt";
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'x' }));
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "dir/it's (1) *x*!" }),
    );
    expect(res.Contents?.map((c) => c.Key)).toEqual([key]);
  });

  it('serves a presigned GET (the SDK adds x-amz-checksum-mode to the query)', async () => {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: 'string.txt' }));
    expect(url).toContain('x-amz-checksum-mode');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  it('accepts a presigned PUT', async () => {
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: 'presigned-put.txt' }),
    );
    expect((await fetch(url, { method: 'PUT', body: 'via presigned PUT' })).status).toBe(200);
    expect(await text('presigned-put.txt')).toBe('via presigned PUT');
  });

  it('deletes a batch with DeleteObjects, including XML-special keys', async () => {
    const keys = ['batch/a.txt', 'batch/b & <c>.txt', 'batch/it\'s "quoted".txt'];
    for (const Key of keys) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: 'x' }));
    }
    const res = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: [...keys, 'batch/missing.txt'].map((Key) => ({ Key })) },
      }),
    );
    expect(res.Errors ?? []).toEqual([]);
    expect(res.Deleted?.map((d) => d.Key).sort()).toEqual([...keys, 'batch/missing.txt'].sort());
    const left = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'batch/' }));
    expect(left.KeyCount).toBe(0);
  });

  it('omits successful deletes in DeleteObjects quiet mode', async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'quiet.txt', Body: 'x' }));
    const res = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: [{ Key: 'quiet.txt' }], Quiet: true },
      }),
    );
    expect(res.Deleted ?? []).toEqual([]);
    expect(res.Errors ?? []).toEqual([]);
  });
});
