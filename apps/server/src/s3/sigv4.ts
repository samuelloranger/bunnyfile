import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type SigV4Config = {
  region: string;
  service: string;
  lookupKey: (accessKeyId: string) => string | null;
};

type SigV4Ok = {
  ok: true;
  accessKeyId: string;
  scope: string;
  signedHeaders: string[];
};

type SigV4Err = {
  ok: false;
  code: string;
  message: string;
};

type SigV4Result = SigV4Ok | SigV4Err;

type ParsedAuthorization = {
  algorithm: string;
  accessKeyId: string;
  scope: string;
  signedHeaders: string[];
  signature: string;
};

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function uriEncodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalUri(pathname: string): string {
  const parts = pathname.split('/').map(uriEncodeSegment);
  return parts.join('/') || '/';
}

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams.entries()) {
    pairs.push([encodeURIComponent(k), encodeURIComponent(v)]);
  }
  pairs.sort((a, b) => {
    if (a[0] === b[0]) return a[1].localeCompare(b[1]);
    return a[0].localeCompare(b[0]);
  });
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function parseAuthorizationHeader(value: string): ParsedAuthorization | null {
  const [algorithm, ...attrs] = value.split(/\s+/);
  if (!algorithm || attrs.length === 0) return null;
  const raw = attrs.join(' ');
  const parts = raw.split(',').map((p) => p.trim());
  const map = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const credential = map.get('Credential');
  const signedHeaders = map.get('SignedHeaders');
  const signature = map.get('Signature');
  if (!credential || !signedHeaders || !signature) return null;
  const slash = credential.indexOf('/');
  if (slash <= 0) return null;
  const accessKeyId = credential.slice(0, slash);
  const scope = credential.slice(slash + 1);
  return {
    algorithm,
    accessKeyId,
    scope,
    signedHeaders: signedHeaders.split(';').filter(Boolean),
    signature,
  };
}

function deriveSigningKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function asErr(code: string, message: string): SigV4Err {
  return { ok: false, code, message };
}

export async function verifySigV4(request: Request, config: SigV4Config): Promise<SigV4Result> {
  const auth = request.headers.get('authorization');
  if (!auth) return asErr('AccessDenied', 'Missing Authorization header');
  const parsed = parseAuthorizationHeader(auth);
  if (!parsed) return asErr('AuthorizationHeaderMalformed', 'Invalid Authorization header format');
  if (parsed.algorithm !== 'AWS4-HMAC-SHA256') {
    return asErr('AuthorizationHeaderMalformed', 'Unsupported signing algorithm');
  }
  const secretAccessKey = config.lookupKey(parsed.accessKeyId);
  if (secretAccessKey === null) {
    return asErr('InvalidAccessKeyId', 'Unknown access key');
  }

  const amzDate = request.headers.get('x-amz-date');
  if (!amzDate || amzDate.length !== 16 || amzDate[8] !== 'T' || !amzDate.endsWith('Z')) {
    return asErr('AccessDenied', 'Missing or invalid x-amz-date');
  }
  const requestTime = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  ).getTime();
  if (Number.isNaN(requestTime) || Math.abs(Date.now() - requestTime) > 15 * 60 * 1000) {
    return asErr('RequestTimeTooSkewed', 'Request timestamp differs too much from server time');
  }
  const dateStamp = amzDate.slice(0, 8);
  const expectedScope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;
  if (parsed.scope !== expectedScope) {
    return asErr(
      'AuthorizationHeaderMalformed',
      'Credential scope does not match expected region/service',
    );
  }

  const payloadHash = request.headers.get('x-amz-content-sha256') ?? 'UNSIGNED-PAYLOAD';
  const signedHeaderNames = [...parsed.signedHeaders].sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => {
      const value = request.headers.get(name);
      return `${name}:${(value ?? '').trim().replace(/\s+/g, ' ')}`;
    })
    .join('\n');

  const url = new URL(request.url);
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url),
    `${canonicalHeaders}\n`,
    signedHeaderNames.join(';'),
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    expectedScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(secretAccessKey, dateStamp, config.region, config.service);
  const expectedSignature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const left = Buffer.from(expectedSignature, 'utf8');
  const right = Buffer.from(parsed.signature, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return asErr('SignatureDoesNotMatch', 'The request signature we calculated does not match');
  }

  return {
    ok: true,
    accessKeyId: parsed.accessKeyId,
    scope: parsed.scope,
    signedHeaders: signedHeaderNames,
  };
}

export async function verifyPresigned(request: Request, config: SigV4Config): Promise<SigV4Result> {
  const url = new URL(request.url);

  const algorithm = url.searchParams.get('X-Amz-Algorithm');
  if (algorithm !== 'AWS4-HMAC-SHA256') {
    return asErr('AuthorizationQueryParametersError', 'Unsupported algorithm');
  }

  const credential = url.searchParams.get('X-Amz-Credential');
  const amzDate = url.searchParams.get('X-Amz-Date');
  const expiresStr = url.searchParams.get('X-Amz-Expires');
  const signedHeadersParam = url.searchParams.get('X-Amz-SignedHeaders');
  const signature = url.searchParams.get('X-Amz-Signature');

  if (!credential || !amzDate || !expiresStr || !signedHeadersParam || !signature) {
    return asErr('AuthorizationQueryParametersError', 'Missing presigned URL parameter');
  }
  if (amzDate.length !== 16 || amzDate[8] !== 'T' || !amzDate.endsWith('Z')) {
    return asErr('AccessDenied', 'Invalid X-Amz-Date');
  }

  const expiresSeconds = Number.parseInt(expiresStr, 10);
  if (Number.isNaN(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604800) {
    return asErr('AuthorizationQueryParametersError', 'X-Amz-Expires must be 1–604800');
  }

  const requestTime = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T` +
      `${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  ).getTime();
  if (Number.isNaN(requestTime)) {
    return asErr('AccessDenied', 'Unparseable X-Amz-Date');
  }
  const now = Date.now();
  if (now < requestTime - 5 * 60 * 1000) {
    return asErr('RequestTimeTooSkewed', 'Request timestamp is too far in the future');
  }
  if (now > requestTime + expiresSeconds * 1000) {
    return asErr('ExpiredToken', 'Presigned URL has expired');
  }

  const slash = credential.indexOf('/');
  if (slash <= 0) {
    return asErr('AuthorizationQueryParametersError', 'Invalid X-Amz-Credential');
  }
  const accessKeyId = credential.slice(0, slash);
  const scope = credential.slice(slash + 1);
  const dateStamp = amzDate.slice(0, 8);
  const expectedScope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;
  if (scope !== expectedScope) {
    return asErr('AuthorizationQueryParametersError', 'Credential scope mismatch');
  }

  const secretAccessKey = config.lookupKey(accessKeyId);
  if (secretAccessKey === null) {
    return asErr('InvalidAccessKeyId', 'Unknown access key');
  }

  const signedHeaderNames = signedHeadersParam.split(';').filter(Boolean).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => {
      const value = request.headers.get(name);
      return `${name}:${(value ?? '').trim().replace(/\s+/g, ' ')}`;
    })
    .join('\n');

  const filteredParams = new URL(request.url).searchParams;
  filteredParams.delete('X-Amz-Signature');
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of filteredParams.entries()) {
    pairs.push([encodeURIComponent(k), encodeURIComponent(v)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQueryStr = pairs.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryStr,
    `${canonicalHeaders}\n`,
    signedHeaderNames.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    expectedScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(secretAccessKey, dateStamp, config.region, config.service);
  const expectedSignature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const left = Buffer.from(expectedSignature, 'utf8');
  const right = Buffer.from(signature, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return asErr('SignatureDoesNotMatch', 'Signature mismatch');
  }

  return { ok: true, accessKeyId, scope, signedHeaders: signedHeaderNames };
}
