import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testRoot = await mkdtemp(join(tmpdir(), 'bunnyfile-metrics-test-'));
process.env.DB_PATH = join(testRoot, 'test.sqlite');
process.env.DATA_DIR = join(testRoot, 'data');

const { runMigrations } = await import('./db/migrate');
const { prometheusMetrics, recordHttpRequest } = await import('./metrics');

describe('prometheus metrics', () => {
  beforeAll(async () => {
    await mkdir(process.env.DATA_DIR!, { recursive: true });
    runMigrations();
  });

  it('exports prometheus text format', async () => {
    recordHttpRequest();
    const body = await prometheusMetrics();
    expect(body).toContain('# TYPE bunnyfile_uptime_seconds gauge');
    expect(body).toContain('bunnyfile_http_requests_total');
    expect(body).toContain('bunnyfile_files_total');
  });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});
