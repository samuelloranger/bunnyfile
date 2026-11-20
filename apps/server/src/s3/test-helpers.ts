import { createHash, createHmac } from 'node:crypto';
import { canonicalQuery as canonicalQueryString, canonicalUri } from './sigv4';

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

/** The server's own canonicalization; `sigv4.test.ts` pins it to the spec. */
export { canonicalUri as canonicalUriPath } from './sigv4';

export type SignedRequestOptions = {
  method: string;
  path: string;
  body?: string | Uint8Array;
  signatureSuffix?: string;
  /** Extra unsigned headers (the server only canonicalizes SignedHeaders). */
  headers?: Record<string, string>;
  /** Extra headers included in the signature (lowercase names). */
  signHeaders?: Record<string, string>;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
};

export function signedRequest({
  method,
  path,
  body,
  signatureSuffix = '',
  headers = {},
  signHeaders = {},
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
  const canonicalQuery = canonicalQueryString(url);
  const signed: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...signHeaders,
  };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method,
    canonicalUri(url.pathname),
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
      ...signHeaders,
      ...headers,
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
