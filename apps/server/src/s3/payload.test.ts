import { describe, expect, it } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { createChecksum } from './checksums';
import { PayloadError, payloadStream, type SigningContext } from './payload';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

function put(body: string | Uint8Array, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/s3/b/k', { method: 'PUT', body, headers });
}

async function read(request: Request, signing?: SigningContext): Promise<string> {
  return new Response(payloadStream(request, signing)).text();
}

async function failure(request: Request, signing?: SigningContext): Promise<PayloadError> {
  try {
    await read(request, signing);
  } catch (err) {
    if (err instanceof PayloadError) return err;
    throw err;
  }
  throw new Error('expected the payload to be rejected');
}

function checksum(algorithm: Parameters<typeof createChecksum>[0], data: string): string {
  const c = createChecksum(algorithm);
  c.update(new TextEncoder().encode(data));
  return c.digestBase64();
}

const unsignedTrailer = {
  'content-encoding': 'aws-chunked',
  'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
  'x-amz-trailer': 'x-amz-checksum-crc32',
  'x-amz-decoded-content-length': '11',
};

describe('checksums', () => {
  it.each([
    ['crc32', 'cbf43926'],
    ['crc32c', 'e3069283'],
    ['crc64nvme', 'ae8b14860a799888'],
  ] as const)('%s matches the catalogue check value', (algorithm, hex) => {
    const value = Buffer.from(checksum(algorithm, '123456789'), 'base64').toString('hex');
    expect(value).toBe(hex);
  });
});

describe('payloadStream', () => {
  it('passes a plain body through unchanged', async () => {
    // Bun decodes Transfer-Encoding: chunked itself; the body must not be
    // decoded a second time (that used to store an empty object).
    expect(await read(put('plain body', { 'transfer-encoding': 'chunked' }))).toBe('plain body');
  });

  it('decodes aws-chunked with a CRC32 trailer, as AWS SDKs send it over HTTPS', async () => {
    const crc = checksum('crc32', 'hello world');
    const body = `5\r\nhello\r\n6\r\n world\r\n0\r\nx-amz-checksum-crc32:${crc}\r\n\r\n`;
    expect(await read(put(body, unsignedTrailer))).toBe('hello world');
  });

  it('rejects a trailer checksum that does not match the bytes', async () => {
    const body = '5\r\nhello\r\n6\r\n world\r\n0\r\nx-amz-checksum-crc32:AAAAAA==\r\n\r\n';
    expect((await failure(put(body, unsignedTrailer))).code).toBe('BadDigest');
  });

  it('rejects a body shorter than x-amz-decoded-content-length', async () => {
    const crc = checksum('crc32', 'hello');
    const body = `5\r\nhello\r\n0\r\nx-amz-checksum-crc32:${crc}\r\n\r\n`;
    expect((await failure(put(body, unsignedTrailer))).code).toBe('IncompleteBody');
  });

  it('rejects a body that ends mid-chunk', async () => {
    const headers = { 'content-encoding': 'aws-chunked' };
    expect((await failure(put('a\r\nhel', headers))).code).toBe('IncompleteBody');
  });

  it('rejects an invalid chunk size', async () => {
    const headers = { 'content-encoding': 'aws-chunked' };
    expect((await failure(put('-a\r\nXX\r\n0\r\n\r\n', headers))).code).toBe('InvalidRequest');
  });

  it('verifies Content-MD5', async () => {
    const md5 = createHash('md5').update('data').digest('base64');
    expect(await read(put('data', { 'content-md5': md5 }))).toBe('data');
    expect((await failure(put('tampered', { 'content-md5': md5 }))).code).toBe('BadDigest');
  });

  it('verifies a signed x-amz-content-sha256', async () => {
    const sha = createHash('sha256').update('data').digest('hex');
    expect(await read(put('data', { 'x-amz-content-sha256': sha }))).toBe('data');
    expect((await failure(put('tampered', { 'x-amz-content-sha256': sha }))).code).toBe(
      'XAmzContentSHA256Mismatch',
    );
  });

  it('verifies x-amz-checksum-* request headers', async () => {
    const value = checksum('crc64nvme', 'data');
    expect(await read(put('data', { 'x-amz-checksum-crc64nvme': value }))).toBe('data');
    const bad = put('tampered', { 'x-amz-checksum-crc64nvme': value });
    expect((await failure(bad)).code).toBe('BadDigest');
  });

  describe('signed chunks', () => {
    const signing: SigningContext = {
      signingKey: Buffer.from('k'.repeat(32)),
      amzDate: '20261120T000000Z',
      scope: '20261120/us-east-1/s3/aws4_request',
      seedSignature: 'a'.repeat(64),
    };

    function signedBody(chunks: string[], trailer?: string): string {
      let previous = signing.seedSignature;
      let out = '';
      for (const data of [...chunks, '']) {
        const sts = [
          'AWS4-HMAC-SHA256-PAYLOAD',
          signing.amzDate,
          signing.scope,
          previous,
          EMPTY_SHA256,
          createHash('sha256').update(data).digest('hex'),
        ].join('\n');
        previous = createHmac('sha256', signing.signingKey).update(sts).digest('hex');
        out += `${data.length.toString(16)};chunk-signature=${previous}\r\n${data}${data ? '\r\n' : ''}`;
      }
      if (trailer === undefined) return `${out}\r\n`;
      const sts = [
        'AWS4-HMAC-SHA256-TRAILER',
        signing.amzDate,
        signing.scope,
        previous,
        createHash('sha256').update(`${trailer}\n`).digest('hex'),
      ].join('\n');
      const sig = createHmac('sha256', signing.signingKey).update(sts).digest('hex');
      return `${out}${trailer}\r\nx-amz-trailer-signature:${sig}\r\n\r\n`;
    }

    const headers = {
      'content-encoding': 'aws-chunked',
      'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
      'x-amz-decoded-content-length': '11',
    };

    it('accepts correctly chained chunk signatures', async () => {
      expect(await read(put(signedBody(['hello', ' world']), headers), signing)).toBe(
        'hello world',
      );
    });

    it('rejects a chunk whose bytes were changed', async () => {
      const body = signedBody(['hello', ' world']).replace('hello', 'HELLO');
      expect((await failure(put(body, headers), signing)).code).toBe('SignatureDoesNotMatch');
    });

    it('verifies a signed trailer', async () => {
      const crc = checksum('crc32', 'hello world');
      const trailerHeaders = {
        ...headers,
        'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER',
        'x-amz-trailer': 'x-amz-checksum-crc32',
      };
      const body = signedBody(['hello', ' world'], `x-amz-checksum-crc32:${crc}`);
      expect(await read(put(body, trailerHeaders), signing)).toBe('hello world');
      const forged = body.replace(crc, checksum('crc32', 'other'));
      expect((await failure(put(forged, trailerHeaders), signing)).code).toBe(
        'SignatureDoesNotMatch',
      );
    });
  });
});
