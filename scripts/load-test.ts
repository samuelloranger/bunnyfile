#!/usr/bin/env bun
/**
 * Basic load smoke test for BunnyFile.
 *
 * Usage:
 *   SESSION_COOKIE='better-auth.session_token=...' bun scripts/load-test.ts http://localhost:3901
 *
 * Exercises unauthenticated health/metrics plus authenticated file upload and
 * download concurrency. SESSION_COOKIE must be a valid app session cookie.
 */

const base = process.argv[2] ?? 'http://localhost:3901';
const sessionCookie = process.env.SESSION_COOKIE;
const uploadCount = Number(process.env.UPLOAD_COUNT ?? 10);
const downloadCount = Number(process.env.DOWNLOAD_COUNT ?? 100);
const uploadBytes = Number(process.env.UPLOAD_BYTES ?? 1024 * 1024);
const runId = `load-test-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

if (!sessionCookie) {
  throw new Error('SESSION_COOKIE is required for upload/download load testing');
}

async function timed(label: string, fn: () => Promise<void>) {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  console.log(`${label}: ${ms.toFixed(0)}ms`);
}

async function concurrent(label: string, count: number, fn: (i: number) => Promise<void>) {
  const start = performance.now();
  await Promise.all(Array.from({ length: count }, (_, i) => fn(i)));
  const ms = performance.now() - start;
  console.log(`${label} (${count} concurrent): ${ms.toFixed(0)}ms total`);
}

const mem = () => {
  const u = process.memoryUsage();
  return `rss=${(u.rss / 1024 / 1024).toFixed(1)}MB heap=${(u.heapUsed / 1024 / 1024).toFixed(1)}MB`;
};

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('cookie', sessionCookie!);
  return headers;
}

function bytesForFile(i: number): Uint8Array {
  const bytes = new Uint8Array(uploadBytes);
  bytes.fill(i % 251);
  return bytes;
}

async function uploadFile(i: number): Promise<string> {
  const path = `${runId}/upload-${String(i).padStart(2, '0')}.bin`;
  const form = new FormData();
  form.set('path', path);
  form.set(
    'file',
    new Blob([bytesForFile(i)], { type: 'application/octet-stream' }),
    `upload-${i}.bin`,
  );
  const res = await fetch(`${base}/api/files/upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`upload ${path} failed: ${res.status} ${await res.text()}`);
  return path;
}

async function downloadFile(path: string): Promise<void> {
  const res = await fetch(`${base}/api/files/content?path=${encodeURIComponent(path)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`download ${path} failed: ${res.status} ${await res.text()}`);
  const body = await res.arrayBuffer();
  if (body.byteLength !== uploadBytes) {
    throw new Error(`download ${path} returned ${body.byteLength} bytes, expected ${uploadBytes}`);
  }
}

async function deleteFile(path: string): Promise<void> {
  const res = await fetch(`${base}/api/files`, {
    method: 'DELETE',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ path }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`cleanup ${path} failed: ${res.status} ${await res.text()}`);
  }
}

console.log(`Target: ${base}`);
console.log(`Memory before: ${mem()}`);

await timed('health x1', async () => {
  const res = await fetch(`${base}/api/health`);
  if (!res.ok) throw new Error(`health ${res.status}`);
});

await concurrent('health x100', 100, async () => {
  const res = await fetch(`${base}/api/health`);
  if (!res.ok) throw new Error(`health ${res.status}`);
});

await concurrent('metrics x20', 20, async () => {
  const res = await fetch(`${base}/metrics`);
  if (!res.ok) throw new Error(`metrics ${res.status}`);
  const text = await res.text();
  if (!text.includes('bunnyfile_uptime_seconds')) throw new Error('invalid metrics body');
});

const uploaded: string[] = [];
try {
  await concurrent(`uploads x${uploadCount}`, uploadCount, async (i) => {
    uploaded.push(await uploadFile(i));
  });

  await concurrent(`downloads x${downloadCount}`, downloadCount, async (i) => {
    await downloadFile(uploaded[i % uploaded.length]!);
  });
} finally {
  await Promise.allSettled(uploaded.map((path) => deleteFile(path)));
}

console.log(`Memory after: ${mem()}`);
console.log('Done.');
