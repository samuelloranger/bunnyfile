type Bucket = {
  tokens: number;
  updatedAtMs: number;
};

const buckets = new Map<string, Bucket>();
const CAPACITY = 30;
const WINDOW_MS = 60_000;
const REFILL_PER_MS = CAPACITY / WINDOW_MS;
const STALE_MS = WINDOW_MS * 10;

function prune(now: number) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAtMs > STALE_MS) buckets.delete(key);
  }
}

export function allowShareRequest(ip: string, token: string): boolean {
  const now = Date.now();
  if (buckets.size > 5000) prune(now);

  const key = `${ip}:${token}`;
  const prev = buckets.get(key) ?? { tokens: CAPACITY, updatedAtMs: now };
  const elapsed = now - prev.updatedAtMs;
  const refilled = Math.min(CAPACITY, prev.tokens + elapsed * REFILL_PER_MS);
  if (refilled < 1) {
    buckets.set(key, { tokens: refilled, updatedAtMs: now });
    return false;
  }

  buckets.set(key, { tokens: refilled - 1, updatedAtMs: now });
  return true;
}

export function requestIp(request: Request, peerAddress?: string | null): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || 'unknown';
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;
  // Fall back to the socket peer address so direct (non-proxied) clients each
  // get their own bucket — otherwise they'd all share the literal 'unknown'
  // key and one client could 429 everyone (global lockout).
  return peerAddress || 'unknown';
}
