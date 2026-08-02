import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-s3-library-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret-for-s3-library';

const [
  {
    BucketError,
    copyObject,
    createBucket,
    createPrefix,
    deleteBucket,
    deleteObject,
    headObject,
    listBuckets,
    listObjects,
    moveObject,
    openObjectStream,
    putObject,
  },
  { runMigrations },
  { S3_ROOT },
] = await Promise.all([import('./library'), import('../db/migrate'), import('../files/store')]);

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(S3_ROOT, { recursive: true, force: true });
  await mkdir(S3_ROOT, { recursive: true });
});

describe('Bucket Library buckets', () => {
  test('createBucket + listBuckets', async () => {
    const info = await createBucket('photos');
    expect(info.name).toBe('photos');
    expect(info.createdAt).toMatch(/^\d{4}-/);
    const all = await listBuckets();
    expect(all.map((b) => b.name)).toEqual(['photos']);
  });

  test('rejects invalid bucket name', async () => {
    await expect(createBucket('../x')).rejects.toBeInstanceOf(BucketError);
    await expect(createBucket('a/b')).rejects.toBeInstanceOf(BucketError);
  });

  test('createBucket on existing → bucket_exists', async () => {
    await createBucket('dup');
    try {
      await createBucket('dup');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BucketError);
      expect((err as BucketError).code).toBe('bucket_exists');
    }
  });

  test('deleteBucket succeeds when empty', async () => {
    await createBucket('empty');
    await deleteBucket('empty');
    expect(await listBuckets()).toEqual([]);
  });

  test('deleteBucket refuses non-empty', async () => {
    await createBucket('full');
    await mkdir(join(S3_ROOT, 'full'), { recursive: true });
    await writeFile(join(S3_ROOT, 'full', 'x.txt'), 'data');
    try {
      await deleteBucket('full');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BucketError);
      expect((err as BucketError).code).toBe('bucket_not_empty');
    }
  });

  test('deleteBucket missing → not_found', async () => {
    try {
      await deleteBucket('nope');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BucketError);
      expect((err as BucketError).code).toBe('not_found');
    }
  });
});

describe('Bucket Library objects', () => {
  test('putObject then openObjectStream is byte-exact', async () => {
    await createBucket('b');
    const body = new TextEncoder().encode('hello-s3');
    const put = await putObject('b', 'a/hi.txt', new Blob([body]).stream());
    expect(put.size).toBe(body.byteLength);
    expect(put.md5.length).toBe(32);
    const { stream, info } = await openObjectStream('b', 'a/hi.txt');
    expect(info.size).toBe(body.byteLength);
    expect(info.md5).toBe(put.md5);
    const got = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(got).toEqual(body);
  });

  test('rejects key with .. segment', async () => {
    await createBucket('b');
    await expect(putObject('b', 'a/../b', new Blob(['x']).stream())).rejects.toBeInstanceOf(
      BucketError,
    );
  });

  test('headObject and deleteObject', async () => {
    await createBucket('b');
    await putObject('b', 'gone.txt', new Blob(['bye']).stream());
    const head = await headObject('b', 'gone.txt');
    expect(head.size).toBe(3);
    await deleteObject('b', 'gone.txt');
    await expect(headObject('b', 'gone.txt')).rejects.toBeInstanceOf(BucketError);
    await deleteObject('b', 'gone.txt'); // idempotent
  });

  test('listObjects with delimiter returns prefixes', async () => {
    await createBucket('b');
    await putObject('b', 'docs/a.txt', new Blob(['a']).stream());
    const listed = await listObjects({ bucket: 'b', prefix: '', delimiter: '/' });
    expect(listed.prefixes).toContain('docs/');
    expect(listed.objects.some((o) => o.key === 'docs/a.txt')).toBe(false);
  });

  test('createPrefix shows as empty folder via delimiter', async () => {
    await createBucket('b');
    await createPrefix('b', 'empty');
    const listed = await listObjects({ bucket: 'b', delimiter: '/' });
    expect(listed.prefixes).toContain('empty/');
  });

  test('copyObject and moveObject', async () => {
    await createBucket('b1');
    await createBucket('b2');
    await putObject('b1', 'x.txt', new Blob(['z']).stream());
    await copyObject('b1', 'x.txt', 'b2', 'y.txt');
    expect((await headObject('b2', 'y.txt')).size).toBe(1);
    await moveObject('b2', 'y.txt', 'b2', 'z.txt');
    await expect(headObject('b2', 'y.txt')).rejects.toBeInstanceOf(BucketError);
    const { stream } = await openObjectStream('b2', 'z.txt');
    expect(await new Response(stream).text()).toBe('z');
  });
});
