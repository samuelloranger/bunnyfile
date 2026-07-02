import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-share-sweep-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');
process.env.BETTER_AUTH_SECRET = 'test-secret';

const [{ runMigrations }, { db }, { shareLink }, { absFromRelOrThrow }, { sweepShareZips }] =
  await Promise.all([
    import('../db/migrate'),
    import('../db'),
    import('../db/schema'),
    import('./store'),
    import('./cron'),
  ]);

async function seedZipDir(id: string) {
  await mkdir(absFromRelOrThrow(`.shares/${id}`), { recursive: true });
  await writeFile(absFromRelOrThrow(`.shares/${id}/x.zip`), 'z');
}

describe('sweepShareZips', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
  });

  it('removes orphaned/revoked/expired zips, keeps active ones', async () => {
    const active = crypto.randomUUID();
    const revoked = crypto.randomUUID();
    const expired = crypto.randomUUID();
    const orphan = crypto.randomUUID();

    await db.insert(shareLink).values({ id: active, token: `t-${active}`, path: 'folderA' });
    await db
      .insert(shareLink)
      .values({ id: revoked, token: `t-${revoked}`, path: 'folderB', revokedAt: new Date() });
    await db.insert(shareLink).values({
      id: expired,
      token: `t-${expired}`,
      path: 'folderC',
      expiresAt: new Date(Date.now() - 1000),
    });
    await seedZipDir(active);
    await seedZipDir(revoked);
    await seedZipDir(expired);
    await seedZipDir(orphan); // no share row at all

    await sweepShareZips();

    expect((await stat(absFromRelOrThrow(`.shares/${active}`))).isDirectory()).toBe(true);
    await expect(stat(absFromRelOrThrow(`.shares/${revoked}`))).rejects.toThrow();
    await expect(stat(absFromRelOrThrow(`.shares/${expired}`))).rejects.toThrow();
    await expect(stat(absFromRelOrThrow(`.shares/${orphan}`))).rejects.toThrow();
  });
});
