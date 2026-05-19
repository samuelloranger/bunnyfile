import { createHash, createHmac } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function deriveSigningKey(
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

/** Mirrors sigv4.ts — must stay in sync with the server implementation. */
export function canonicalUriPath(pathname: string): string {
  return (
    pathname
      .split('/')
      .map((seg) => {
        let decoded: string;
        try {
          decoded = decodeURIComponent(seg);
        } catch {
          decoded = seg;
        }
        return encodeURIComponent(decoded).replace(
          /[!'()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        );
      })
      .join('/') || '/'
  );
}

export type SignedRequestOptions = {
  method: string;
  path: string;
  body?: string | Uint8Array;
  signatureSuffix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
};

export function signedRequest({
  method,
  path,
  body,
  signatureSuffix = '',
  accessKeyId = process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey = process.env.S3_SECRET_ACCESS_KEY!,
  region = process.env.S3_REGION ?? 'us-east-1',
}: SignedRequestOptions): Request {
  const host = 'localhost';
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const url = new URL(`http://${host}${path}`);
  const pairs = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    canonicalUriPath(url.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signature =
    createHmac('sha256', signingKey).update(stringToSign).digest('hex') + signatureSuffix;
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return new Request(`http://${host}${path}`, {
    method,
    body,
    headers: {
      authorization,
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    },
  });
}

export async function sha256OfBytes(data: Uint8Array): Promise<string> {
  const hash = createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}

export async function readResponseBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}
