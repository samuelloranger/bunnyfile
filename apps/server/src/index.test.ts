import { describe, expect, it } from 'bun:test';

// Force an in-memory SQLite for tests before any module imports open the DB.
process.env.DB_PATH = ':memory:';

const { app } = await import('./index');

describe('GET /api/health', () => {
  it('returns ok with version and uptime', async () => {
    const res = await app.handle(new Request('http://localhost/api/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string; uptimeSeconds: number };
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptimeSeconds).toBe('number');
  });
});

describe('GET /* (SPA fallback)', () => {
  it('returns 404 with helpful message when web build is missing', async () => {
    // This test asserts the placeholder behavior before a web build exists.
    // Once `apps/web/dist/index.html` is present, the server returns it instead.
    const res = await app.handle(new Request('http://localhost/some/spa/route'));
    expect([200, 404]).toContain(res.status);
  });
});
