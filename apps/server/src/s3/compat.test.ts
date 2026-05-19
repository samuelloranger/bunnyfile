import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResponseBytes, sha256OfBytes, signedRequest } from './test-helpers';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-s3-compat-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.S3_ACCESS_KEY_ID = 'compat-access-key';
process.env.S3_SECRET_ACCESS_KEY = 'compat-secret-key';
process.env.S3_REGION = 'us-east-1';
process.env.BETTER_AUTH_SECRET = 'compat-test-secret-for-s3-integration-tests';

const [{ app }, { runMigrations }] = await Promise.all([
  import('../index'),
  import('../db/migrate'),
]);

async function putObject(bucket: string, key: string, body: string | Uint8Array): Promise<string> {
  const res = await app.handle(
    signedRequest({ method: 'PUT', path: `/api/s3/${bucket}/${key}`, body }),
  );
  expect(res.status).toBe(200);
  const etag = res.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag!;
}

async function getObjectBytes(bucket: string, key: string): Promise<Uint8Array> {
  const res = await app.handle(signedRequest({ method: 'GET', path: `/api/s3/${bucket}/${key}` }));
  expect(res.status).toBe(200);
  return readResponseBytes(res);
}

async function deleteObject(bucket: string, key: string): Promise<void> {
  const res = await app.handle(
    signedRequest({ method: 'DELETE', path: `/api/s3/${bucket}/${key}` }),
  );
  expect(res.status).toBe(204);
}

async function createBucket(bucket: string): Promise<void> {
  const res = await app.handle(signedRequest({ method: 'PUT', path: `/api/s3/${bucket}` }));
  expect(res.status).toBe(200);
}

async function deleteBucket(bucket: string): Promise<void> {
  const res = await app.handle(signedRequest({ method: 'DELETE', path: `/api/s3/${bucket}` }));
  expect(res.status).toBe(204);
}

async function listObjectKeys(bucket: string, prefix = ''): Promise<string[]> {
  const res = await app.handle(
    signedRequest({
      method: 'GET',
      path: `/api/s3/${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`,
    }),
  );
  expect(res.status).toBe(200);
  const xml = await res.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
}

function randomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

async function completeMultipartUpload(
  bucket: string,
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
): Promise<void> {
  const body = `<CompleteMultipartUpload>${parts
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`;
  const res = await app.handle(
    signedRequest({
      method: 'POST',
      path: `/api/s3/${bucket}/${key}?uploadId=${uploadId}`,
      body,
    }),
  );
  expect(res.status).toBe(200);
}

async function hashDirectory(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile()) {
        const bytes = await readFile(join(dir, entry.name));
        out.set(rel, createHash('sha256').update(bytes).digest('hex'));
      } else if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      }
    }
  }
  await walk(root, '');
  return out;
}

const rcloneAvailable = (() => {
  try {
    const proc = Bun.spawnSync(['rclone', 'version'], { stdout: 'pipe', stderr: 'pipe' });
    return proc.success;
  } catch {
    return false;
  }
})();

describe('S3 client compatibility', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
  });

  describe('sync round-trip (SigV4 API)', () => {
    const bucket = `compat-api-${crypto.randomUUID().slice(0, 8)}`;
    const srcBucket = `compat-src-${crypto.randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
      await createBucket(bucket);
      await createBucket(srcBucket);
    });

    afterAll(async () => {
      for (const key of await listObjectKeys(bucket)) {
        await deleteObject(bucket, key);
      }
      for (const key of await listObjectKeys(srcBucket)) {
        await deleteObject(srcBucket, key);
      }
      await deleteBucket(bucket);
      await deleteBucket(srcBucket);
    });

    it('uploads, lists, downloads, and deletes objects with byte-exact integrity', async () => {
      const files = new Map<string, Uint8Array>([
        ['readme.txt', new TextEncoder().encode('hello bunnyfile')],
        ['nested/data.bin', randomBytes(4096)],
        ['photos/vacation.jpg', randomBytes(8192)],
      ]);

      for (const [key, body] of files) {
        await putObject(bucket, key, body);
      }

      const listed = await listObjectKeys(bucket);
      expect(listed.sort()).toEqual([...files.keys()].sort());

      for (const [key, expected] of files) {
        const downloaded = await getObjectBytes(bucket, key);
        expect(await sha256OfBytes(downloaded)).toBe(await sha256OfBytes(expected));
      }

      await deleteObject(bucket, 'photos/vacation.jpg');
      expect(await listObjectKeys(bucket)).not.toContain('photos/vacation.jpg');
    });

    it('CopyObject copies across keys and buckets', async () => {
      const body = new TextEncoder().encode('copy me');
      await putObject(srcBucket, 'source.txt', body);

      const copyReq = signedRequest({ method: 'PUT', path: `/api/s3/${bucket}/copied.txt` });
      const copyRes = await app.handle(
        new Request(copyReq.url, {
          method: 'PUT',
          headers: new Headers([
            ...copyReq.headers.entries(),
            ['x-amz-copy-source', `/${srcBucket}/source.txt`],
          ]),
        }),
      );
      expect(copyRes.status).toBe(200);
      expect(await copyRes.text()).toContain('<CopyObjectResult');

      const downloaded = await getObjectBytes(bucket, 'copied.txt');
      expect(new TextDecoder().decode(downloaded)).toBe('copy me');
    });

    it('multipart upload preserves bytes for larger payloads', async () => {
      const key = 'large/multipart.bin';
      const part1 = randomBytes(512 * 1024);
      const part2 = randomBytes(512 * 1024);
      const expected = new Uint8Array(part1.length + part2.length);
      expected.set(part1, 0);
      expected.set(part2, part1.length);

      const initRes = await app.handle(
        signedRequest({ method: 'POST', path: `/api/s3/${bucket}/${key}?uploads` }),
      );
      expect(initRes.status).toBe(200);
      const uploadId = (await initRes.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1]!;

      const etags: string[] = [];
      for (const [idx, part] of [part1, part2].entries()) {
        const partRes = await app.handle(
          signedRequest({
            method: 'PUT',
            path: `/api/s3/${bucket}/${key}?partNumber=${idx + 1}&uploadId=${uploadId}`,
            body: part,
          }),
        );
        expect(partRes.status).toBe(200);
        etags.push(partRes.headers.get('etag')!);
      }

      await completeMultipartUpload(
        bucket,
        key,
        uploadId,
        etags.map((etag, i) => ({ partNumber: i + 1, etag })),
      );

      const downloaded = await getObjectBytes(bucket, key);
      expect(await sha256OfBytes(downloaded)).toBe(await sha256OfBytes(expected));
    });

    it('ListObjectsV2 paginates with continuation tokens', async () => {
      const pageBucket = `compat-page-${crypto.randomUUID().slice(0, 8)}`;
      await createBucket(pageBucket);
      try {
        for (let i = 0; i < 5; i++) {
          await putObject(pageBucket, `obj-${i}.txt`, `payload-${i}`);
        }

        const collected: string[] = [];
        let token = '';
        for (let page = 0; page < 3; page++) {
          const path = token
            ? `/api/s3/${pageBucket}?list-type=2&max-keys=2&continuation-token=${encodeURIComponent(token)}`
            : `/api/s3/${pageBucket}?list-type=2&max-keys=2`;
          const res = await app.handle(signedRequest({ method: 'GET', path }));
          expect(res.status).toBe(200);
          const xml = await res.text();
          collected.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!));
          const truncated = xml.includes('<IsTruncated>true</IsTruncated>');
          const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
          if (!truncated) break;
          expect(next).toBeTruthy();
          token = next!;
        }

        expect(new Set(collected).size).toBe(5);
        expect(collected.sort()).toEqual(
          ['obj-0.txt', 'obj-1.txt', 'obj-2.txt', 'obj-3.txt', 'obj-4.txt'].sort(),
        );
      } finally {
        for (const key of await listObjectKeys(pageBucket)) {
          await deleteObject(pageBucket, key);
        }
        await deleteBucket(pageBucket);
      }
    });
  });

  describe('rclone integration', () => {
    let serverProc: ReturnType<typeof Bun.spawn> | null = null;
    let port = 0;
    let rcloneConfig = '';
    const localRoot = join(testRoot, 'rclone-local');
    const remoteRoot = join(testRoot, 'rclone-remote');
    const serverRoot = join(testRoot, 'rclone-server');

    async function startServer(): Promise<number> {
      await mkdir(serverRoot, { recursive: true });
      const port = 35_000 + Math.floor(Math.random() * 5_000);
      serverProc = Bun.spawn({
        cmd: ['bun', 'run', 'src/index.ts'],
        cwd: join(import.meta.dir, '../..'),
        env: {
          ...process.env,
          DB_PATH: join(serverRoot, 'test.sqlite'),
          DATA_DIR: join(serverRoot, 'data'),
          SERVER_PORT: String(port),
          SERVER_HOST: '127.0.0.1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (res.ok) return port;
        } catch {
          // server still booting
        }
        await Bun.sleep(100);
      }
      serverProc.kill();
      throw new Error(`server did not start on port ${port} within 15s`);
    }

    beforeAll(async () => {
      if (!rcloneAvailable) return;
      port = await startServer();
      rcloneConfig = join(testRoot, 'rclone.conf');
      await writeFile(
        rcloneConfig,
        [
          '[bunnyfile]',
          'type = s3',
          'provider = Other',
          'env_auth = false',
          `access_key_id = ${process.env.S3_ACCESS_KEY_ID}`,
          `secret_access_key = ${process.env.S3_SECRET_ACCESS_KEY}`,
          `endpoint = http://127.0.0.1:${port}/api/s3`,
          'region = us-east-1',
          'force_path_style = true',
          '',
        ].join('\n'),
      );
    }, 20_000);

    afterAll(async () => {
      if (serverProc) {
        serverProc.kill();
        await Promise.race([serverProc.exited, Bun.sleep(2000)]);
      }
    }, 10_000);

    it.skipIf(!rcloneAvailable)(
      'rclone sync round-trip preserves every byte',
      async () => {
        const bucket = `rclone-${crypto.randomUUID().slice(0, 8)}`;
        await rm(localRoot, { recursive: true, force: true });
        await rm(remoteRoot, { recursive: true, force: true });
        await mkdir(join(localRoot, 'nested'), { recursive: true });

        await writeFile(join(localRoot, 'hello.txt'), 'hello rclone');
        await writeFile(join(localRoot, 'nested', 'deep.bin'), randomBytes(16_384));
        await writeFile(join(localRoot, 'large.bin'), randomBytes(6 * 1024 * 1024));

        const syncUp = Bun.spawnSync(
          ['rclone', '--config', rcloneConfig, 'sync', localRoot, `bunnyfile:${bucket}`, '-v'],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        if (!syncUp.success) {
          throw new Error(
            `rclone sync up failed:\n${syncUp.stderr.toString()}\n${syncUp.stdout.toString()}`,
          );
        }

        const syncDown = Bun.spawnSync(
          ['rclone', '--config', rcloneConfig, 'sync', `bunnyfile:${bucket}`, remoteRoot, '-v'],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        if (!syncDown.success) {
          throw new Error(
            `rclone sync down failed:\n${syncDown.stderr.toString()}\n${syncDown.stdout.toString()}`,
          );
        }

        const localHashes = await hashDirectory(localRoot);
        const remoteHashes = await hashDirectory(remoteRoot);
        expect(remoteHashes.size).toBe(localHashes.size);
        for (const [path, hash] of localHashes) {
          expect(remoteHashes.get(path)).toBe(hash);
        }
      },
      30_000,
    );
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
