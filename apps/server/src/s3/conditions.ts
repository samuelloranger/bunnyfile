/**
 * S3 conditional requests: If-Match / If-None-Match on writes (S3 conditional
 * writes) and the RFC 9110 precondition headers on GET and HEAD.
 */

export class PreconditionError extends Error {
  constructor(
    public status: 404 | 412,
    public code: 'NoSuchKey' | 'PreconditionFailed',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Whether `etag` is listed in an If-Match / If-None-Match header. `strong`
 * (RFC 9110 strong comparison, required for If-Match) ignores weak `W/` tags.
 */
function matches(header: string, etag: string | null, strong = false): boolean {
  if (etag === null) return false;
  return header.split(',').some((raw) => {
    const tag = raw.trim();
    if (tag === '*') return true;
    if (tag.startsWith('W/') && strong) return false;
    return tag.replace(/^W\//, '').replace(/^"|"$/g, '') === etag;
  });
}

/**
 * Checks If-Match / If-None-Match for a write. `currentEtag` is the existing
 * object's ETag without quotes, or null when there is no object. Must run under
 * the commit lock so the answer still holds when the write lands.
 */
export function checkWritePreconditions(request: Request, currentEtag: string | null): void {
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch !== null && currentEtag !== null && matches(ifNoneMatch, currentEtag)) {
    throw new PreconditionError(
      412,
      'PreconditionFailed',
      'At least one of the pre-conditions you specified did not hold',
    );
  }
  const ifMatch = request.headers.get('if-match');
  if (ifMatch !== null) {
    if (currentEtag === null) {
      throw new PreconditionError(404, 'NoSuchKey', 'The specified key does not exist.');
    }
    if (!matches(ifMatch, currentEtag, true)) {
      throw new PreconditionError(
        412,
        'PreconditionFailed',
        'At least one of the pre-conditions you specified did not hold',
      );
    }
  }
}

function parseDate(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Evaluates GET/HEAD preconditions in RFC 9110 order. Returns 412, 304 or null
 * (serve the object). HTTP dates have one-second resolution, so the object's
 * mtime is compared at that granularity.
 */
export function readPreconditionStatus(
  request: Request,
  etag: string,
  lastModifiedMs: number,
): 304 | 412 | null {
  const modified = Math.floor(lastModifiedMs / 1000) * 1000;
  const ifMatch = request.headers.get('if-match');
  if (ifMatch !== null) {
    if (!matches(ifMatch, etag, true)) return 412;
  } else {
    const since = parseDate(request.headers.get('if-unmodified-since'));
    if (since !== null && modified > since) return 412;
  }
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch !== null) {
    if (matches(ifNoneMatch, etag)) return 304;
  } else {
    const since = parseDate(request.headers.get('if-modified-since'));
    if (since !== null && modified <= since) return 304;
  }
  return null;
}

/**
 * CopyObject's `x-amz-copy-source-if-*` headers, evaluated against the source
 * object. S3 answers 412 whenever one fails, including the 304-style ones.
 */
export function copySourcePreconditionFails(
  request: Request,
  sourceEtag: string,
  sourceModifiedMs: number,
): boolean {
  const headers = new Headers();
  for (const name of ['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since']) {
    const value = request.headers.get(`x-amz-copy-source-${name}`);
    if (value !== null) headers.set(name, value);
  }
  const probe = new Request('http://copy-source/', { headers });
  return readPreconditionStatus(probe, sourceEtag, sourceModifiedMs) !== null;
}
