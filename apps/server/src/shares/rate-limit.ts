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

export type RequestIpOptions = {
  trustProxy?: boolean;
  /** IPv4 addresses or CIDRs (e.g. 10.0.0.0/8). Empty = any peer when trustProxy. */
  trustedProxies?: string[];
};

const envTrustProxy = Bun.env.TRUST_PROXY === '1' || Bun.env.TRUST_PROXY === 'true';
const envTrustedProxies = (Bun.env.TRUSTED_PROXIES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

/** IPv4-only CIDR/exact match. Non-IPv4 peers never match a CIDR list. */
export function peerIsTrusted(peer: string, trustedProxies: string[]): boolean {
  if (trustedProxies.length === 0) return true;
  const peerInt = ipv4ToInt(peer);
  for (const entry of trustedProxies) {
    if (!entry.includes('/')) {
      if (entry === peer) return true;
      continue;
    }
    if (peerInt == null) continue;
    const [base, bitsStr] = entry.split('/');
    const bits = Number(bitsStr);
    const baseInt = base ? ipv4ToInt(base) : null;
    if (baseInt == null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((peerInt & mask) === (baseInt & mask)) return true;
  }
  return false;
}

export function requestIp(
  request: Request,
  peerAddress?: string | null,
  opts?: RequestIpOptions,
): string {
  const trustProxy = opts?.trustProxy ?? envTrustProxy;
  const trustedProxies = opts?.trustedProxies ?? envTrustedProxies;
  const peer = peerAddress || 'unknown';

  if (trustProxy && peerIsTrusted(peer, trustedProxies)) {
    const xff = request.headers.get('x-forwarded-for');
    if (xff) return xff.split(',')[0]?.trim() || 'unknown';
    const realIp = request.headers.get('x-real-ip');
    if (realIp) return realIp.trim();
  }

  // Fall back to the socket peer address so direct (non-proxied) clients each
  // get their own bucket — otherwise they'd all share the literal 'unknown'
  // key and one client could 429 everyone (global lockout).
  return peer;
}
