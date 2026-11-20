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
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  DeleteObjectTaggingCommand,
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
  UploadPartCommand,
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

async function status(send: Promise<unknown>): Promise<number> {
  try {
    await send;
    return 200;
  } catch (err) {
    return (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
  }
}

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

  describe('conditional requests', () => {
    const put = (Key: string, Body: string, extra: { IfNoneMatch?: string; IfMatch?: string }) =>
      s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ...extra }));

    it('If-None-Match: * creates once and then refuses to overwrite', async () => {
      expect(await status(put('lock.json', 'first', { IfNoneMatch: '*' }))).toBe(200);
      expect(await status(put('lock.json', 'second', { IfNoneMatch: '*' }))).toBe(412);
      expect(await text('lock.json')).toBe('first');
    });

    it('lets exactly one of several concurrent If-None-Match: * writes win', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          status(put('race.json', `writer ${i}`, { IfNoneMatch: '*' })),
        ),
      );
      expect(results.filter((r) => r === 200)).toHaveLength(1);
      expect(results.filter((r) => r === 412)).toHaveLength(4);
    });

    it('If-Match replaces only the expected version', async () => {
      const { ETag } = await put('cas.txt', 'v1', {});
      expect(await status(put('cas.txt', 'v2', { IfMatch: '"not-the-etag"' }))).toBe(412);
      expect(await status(put('cas.txt', 'v2', { IfMatch: ETag! }))).toBe(200);
      expect(await text('cas.txt')).toBe('v2');
      expect(await status(put('absent.txt', 'v1', { IfMatch: ETag! }))).toBe(404);
    });

    it('applies If-None-Match: * to CompleteMultipartUpload', async () => {
      await put('mpu-lock.bin', 'existing', {});
      const { UploadId } = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: 'mpu-lock.bin' }),
      );
      const { ETag } = await s3.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: 'mpu-lock.bin',
          UploadId,
          PartNumber: 1,
          Body: 'replacement',
        }),
      );
      const complete = s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: 'mpu-lock.bin',
          UploadId,
          IfNoneMatch: '*',
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag }] },
        }),
      );
      expect(await status(complete)).toBe(412);
      expect(await text('mpu-lock.bin')).toBe('existing');
    });

    it('applies x-amz-copy-source-if-* to the CopyObject source', async () => {
      const { ETag } = await put('copy-src.txt', 'source', {});
      const copy = (extra: object) =>
        s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: 'copy-dst.txt',
            CopySource: `${bucket}/copy-src.txt`,
            ...extra,
          }),
        );
      expect(await status(copy({ CopySourceIfMatch: '"stale"' }))).toBe(412);
      expect(await status(copy({ CopySourceIfNoneMatch: ETag }))).toBe(412);
      expect(await status(copy({ CopySourceIfMatch: ETag }))).toBe(200);
      expect(await text('copy-dst.txt')).toBe('source');
    });

    it('answers conditional GET and HEAD', async () => {
      const { ETag } = await put('cond-read.txt', 'cached', {});
      const get = (extra: object) =>
        s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'cond-read.txt', ...extra }));
      expect(await status(get({ IfNoneMatch: ETag }))).toBe(304);
      expect(await status(get({ IfMatch: '"stale"' }))).toBe(412);
      expect(await status(get({ IfMatch: ETag }))).toBe(200);
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: 'cond-read.txt' }));
      expect(head.LastModified).toBeInstanceOf(Date);
      const later = new Date(head.LastModified!.getTime() + 60_000);
      expect(
        await status(
          s3.send(
            new HeadObjectCommand({ Bucket: bucket, Key: 'cond-read.txt', IfModifiedSince: later }),
          ),
        ),
      ).toBe(304);
    });
  });

  describe('protocol details', () => {
    it('pages through mixed-case keys without skipping any', async () => {
      for (const Key of ['page/a', 'page/B', 'page/c', 'page/D']) {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: 'x' }));
      }
      const seen: string[] = [];
      let ContinuationToken: string | undefined;
      do {
        const res = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'page/',
            MaxKeys: 1,
            ContinuationToken,
          }),
        );
        seen.push(...(res.Contents ?? []).map((c) => c.Key!));
        ContinuationToken = res.NextContinuationToken;
      } while (ContinuationToken);
      expect(seen).toEqual(['page/B', 'page/D', 'page/a', 'page/c']);
    });

    it('counts common prefixes toward MaxKeys and never repeats one', async () => {
      for (const Key of ['delim/a/1', 'delim/a/2', 'delim/a/3', 'delim/b', 'delim/c/1']) {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: 'x' }));
      }
      const pages: string[][] = [];
      let ContinuationToken: string | undefined;
      do {
        const res = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'delim/',
            Delimiter: '/',
            MaxKeys: 2,
            ContinuationToken,
          }),
        );
        pages.push([
          ...(res.CommonPrefixes ?? []).map((p) => p.Prefix!),
          ...(res.Contents ?? []).map((c) => c.Key!),
        ]);
        ContinuationToken = res.NextContinuationToken;
      } while (ContinuationToken);
      expect(pages).toEqual([['delim/a/', 'delim/b'], ['delim/c/']]);
    });

    it('honours StartAfter', async () => {
      const res = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: 'page/', StartAfter: 'page/D' }),
      );
      expect(res.Contents?.map((c) => c.Key)).toEqual(['page/a', 'page/c']);
      expect(res.StartAfter).toBe('page/D');
    });

    it('reports the bucket location and (disabled) versioning', async () => {
      const location = await s3.send(new GetBucketLocationCommand({ Bucket: bucket }));
      expect(location.LocationConstraint ?? '').toBe('');
      const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      expect(versioning.Status).toBeUndefined();
    });

    it('lists in-progress multipart uploads', async () => {
      const { UploadId } = await s3.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: 'pending/upload.bin' }),
      );
      const res = await s3.send(
        new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: 'pending/' }),
      );
      expect(res.Uploads?.map((u) => [u.Key, u.UploadId])).toEqual([
        ['pending/upload.bin', UploadId],
      ]);
    });

    it('rejects unsupported subresources instead of touching the object', async () => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'tagged.txt', Body: 'keep me' }));
      const tag = s3.send(
        new PutObjectTaggingCommand({
          Bucket: bucket,
          Key: 'tagged.txt',
          Tagging: { TagSet: [{ Key: 'k', Value: 'v' }] },
        }),
      );
      expect(await status(tag)).toBe(501);
      expect(
        await status(
          s3.send(new DeleteObjectTaggingCommand({ Bucket: bucket, Key: 'tagged.txt' })),
        ),
      ).toBe(501);
      expect(await text('tagged.txt')).toBe('keep me');
    });

    it('applies response-* header overrides on presigned GET', async () => {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: 'string.txt',
          ResponseContentDisposition: 'attachment; filename="hello.txt"',
          ResponseContentType: 'text/x-custom',
        }),
      );
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="hello.txt"');
      expect(res.headers.get('content-type')).toBe('text/x-custom');
    });

    it('returns NoSuchBucket when deleting from a missing bucket', async () => {
      const del = s3.send(new DeleteObjectCommand({ Bucket: 'no-such-bucket', Key: 'k' }));
      expect(await status(del)).toBe(404);
    });

    it('answers 403 for an unknown access key', async () => {
      const stranger = new S3Client({
        endpoint: await s3.config.endpoint!().then(
          (e) => `${e.protocol}//${e.hostname}:${e.port}${e.path}`,
        ),
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: 'unknown', secretAccessKey: 'nope' },
      });
      expect(await status(stranger.send(new GetBucketLocationCommand({ Bucket: bucket })))).toBe(
        403,
      );
      stranger.destroy();
    });
  });
});
