import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-s3-library-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret-for-s3-library';

const [{ BucketError, createBucket, deleteBucket, listBuckets }, { runMigrations }, { S3_ROOT }] =
  await Promise.all([import('./library'), import('../db/migrate'), import('../files/store')]);

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
