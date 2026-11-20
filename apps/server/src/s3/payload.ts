import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  CHECKSUM_ALGORITHMS,
  type Checksum,
  createChecksum,
  isChecksumAlgorithm,
} from './checksums';

/**
 * Request-body handling for S3 writes: decodes `aws-chunked` bodies and
 * verifies every integrity claim the client made (Content-MD5,
 * x-amz-content-sha256, x-amz-checksum-* headers or trailers, chunk
 * signatures, decoded length). A failed check errors the stream at its end, so
 * callers that write-then-rename never commit the bytes.
 *
 * HTTP `Transfer-Encoding: chunked` is not handled here: Bun decodes it before
 * the handler sees the body.
 */

export class PayloadError extends Error {
  constructor(
    public code:
      | 'BadDigest'
      | 'XAmzContentSHA256Mismatch'
      | 'IncompleteBody'
      | 'InvalidDigest'
      | 'InvalidRequest'
      | 'SignatureDoesNotMatch',
    message: string,
  ) {
    super(message);
  }

  get status(): number {
    return this.code === 'SignatureDoesNotMatch' ? 403 : 400;
  }
}

/** What the SigV4 check of the request headers produced, for chaining chunk signatures. */
export type SigningContext = {
  signingKey: Buffer;
  amzDate: string;
  scope: string;
  seedSignature: string;
};

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const MAX_LINE = 4096;

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Pull-based reader over a byte stream, for parsing the aws-chunked framing. */
class ByteReader {
  private buf: Uint8Array = new Uint8Array(0);
  private ended = false;
  private reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel?(): Promise<void>;
  };

  constructor(source: ReadableStream<Uint8Array>) {
    this.reader = source.getReader();
  }

  private async more(): Promise<boolean> {
    if (this.ended) return false;
    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      return false;
    }
    if (value?.length) {
      const next = new Uint8Array(this.buf.length + value.length);
      next.set(this.buf);
      next.set(value, this.buf.length);
      this.buf = next;
    }
    return true;
  }

  /** Next CRLF-terminated line, without the CRLF. */
  async line(): Promise<string> {
    for (let from = 0; ; ) {
      for (let i = from; i < this.buf.length - 1; i++) {
        if (this.buf[i] === 0x0d && this.buf[i + 1] === 0x0a) {
          const text = new TextDecoder().decode(this.buf.subarray(0, i));
          this.buf = this.buf.subarray(i + 2);
          return text;
        }
      }
      if (this.buf.length > MAX_LINE) {
        throw new PayloadError('InvalidRequest', 'aws-chunked line too long');
      }
      from = Math.max(0, this.buf.length - 1);
      if (!(await this.more())) {
        throw new PayloadError('IncompleteBody', 'request body ended inside aws-chunked framing');
      }
    }
  }

  /** Streams exactly `n` bytes, without buffering them all. */
  async *take(n: number): AsyncGenerator<Uint8Array> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.more())) {
        throw new PayloadError('IncompleteBody', 'request body ended inside an aws-chunked chunk');
      }
      const piece = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(piece.length);
      left -= piece.length;
      yield piece.slice();
    }
  }

  async atEnd(): Promise<boolean> {
    return this.buf.length === 0 && !(await this.more());
  }

  async cancel(): Promise<void> {
    await this.reader.cancel?.().catch(() => {});
  }
}

type ChunkedMode = { signed: boolean; trailer: boolean };

function chunkedMode(request: Request): ChunkedMode | null {
  const contentSha = request.headers.get('x-amz-content-sha256') ?? '';
  const encodings = (request.headers.get('content-encoding') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase());
  if (contentSha.startsWith('STREAMING-AWS4-ECDSA')) {
    throw new PayloadError('InvalidRequest', 'SigV4a streaming payloads are not supported');
  }
  if (contentSha.startsWith('STREAMING-')) {
    return {
      signed: contentSha.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD'),
      trailer: contentSha.endsWith('-TRAILER'),
    };
  }
  if (encodings.includes('aws-chunked')) return { signed: false, trailer: true };
  return null;
}

async function* decodeAwsChunked(
  source: ReadableStream<Uint8Array>,
  mode: ChunkedMode,
  signing: SigningContext | undefined,
  trailers: Map<string, string>,
): AsyncGenerator<Uint8Array> {
  if (mode.signed && !signing) {
    throw new PayloadError('InvalidRequest', 'signed streaming payload requires header auth');
  }
  const reader = new ByteReader(source);
  try {
    let previous = signing?.seedSignature ?? '';
    const chunkStringToSign = (hash: string) =>
      [
        'AWS4-HMAC-SHA256-PAYLOAD',
        signing!.amzDate,
        signing!.scope,
        previous,
        EMPTY_SHA256,
        hash,
      ].join('\n');

    for (;;) {
      const header = await reader.line();
      const [sizeHex = '', ...exts] = header.split(';');
      if (!/^[0-9a-fA-F]+$/.test(sizeHex.trim())) {
        throw new PayloadError('InvalidRequest', 'invalid aws-chunked chunk size');
      }
      const size = Number.parseInt(sizeHex.trim(), 16);
      if (size > MAX_CHUNK_SIZE)
        throw new PayloadError('InvalidRequest', 'aws-chunked chunk too large');
      const signature = exts
        .map((e) => e.trim())
        .find((e) => e.startsWith('chunk-signature='))
        ?.slice('chunk-signature='.length);
      if (mode.signed && !signature) {
        throw new PayloadError('SignatureDoesNotMatch', 'missing chunk-signature');
      }

      const hash = mode.signed ? createHash('sha256') : null;
      for await (const piece of reader.take(size)) {
        hash?.update(piece);
        yield piece;
      }
      if (mode.signed) {
        const expected = createHmac('sha256', signing!.signingKey)
          .update(chunkStringToSign(hash!.digest('hex')))
          .digest('hex');
        if (!sameHex(expected, signature!)) {
          throw new PayloadError('SignatureDoesNotMatch', 'chunk signature does not match');
        }
        previous = expected;
      }

      if (size === 0) break;
      if ((await reader.line()) !== '') {
        throw new PayloadError('InvalidRequest', 'aws-chunked chunk not followed by CRLF');
      }
    }

    // Trailer section: `name:value` lines, then an empty line. Bodies without a
    // trailer end with that empty line (or, from lenient clients, with EOF).
    if (!mode.trailer && (await reader.atEnd())) return;
    let trailerSignature: string | undefined;
    const signedLines: string[] = [];
    for (;;) {
      if (await reader.atEnd()) break;
      const line = await reader.line();
      if (line === '') break;
      const colon = line.indexOf(':');
      if (colon <= 0) throw new PayloadError('InvalidRequest', 'malformed aws-chunked trailer');
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === 'x-amz-trailer-signature') {
        trailerSignature = value;
      } else {
        trailers.set(name, value);
        signedLines.push(`${name}:${value}\n`);
      }
    }
    if (mode.signed && mode.trailer) {
      const expected = createHmac('sha256', signing!.signingKey)
        .update(
          [
            'AWS4-HMAC-SHA256-TRAILER',
            signing!.amzDate,
            signing!.scope,
            previous,
            sha256Hex(signedLines.join('')),
          ].join('\n'),
        )
        .digest('hex');
      if (!trailerSignature || !sameHex(expected, trailerSignature)) {
        throw new PayloadError('SignatureDoesNotMatch', 'trailer signature does not match');
      }
    }
  } finally {
    // Releases the request body if the consumer stops early.
    await reader.cancel();
  }
}

type Expectation = { label: string; check: Checksum; expected: () => string | undefined };

/**
 * The verified, decoded body of an S3 write. Errors (with a PayloadError) at
 * the end of the stream if any integrity check fails.
 *
 * `checksumHeaders: false` is for CompleteMultipartUpload, where the
 * x-amz-checksum-* headers describe the assembled object, not the XML body.
 */
export function payloadStream(
  request: Request,
  signing?: SigningContext,
  { checksumHeaders = true }: { checksumHeaders?: boolean } = {},
): ReadableStream<Uint8Array> {
  const raw = request.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  const mode = chunkedMode(request);
  const trailers = new Map<string, string>();
  const expectations: Expectation[] = [];

  const contentMd5 = request.headers.get('content-md5')?.trim() ?? null;
  if (contentMd5 !== null) {
    if (Buffer.from(contentMd5, 'base64').length !== 16) {
      throw new PayloadError('InvalidDigest', 'Content-MD5 is not a valid base64 MD5');
    }
    expectations.push({
      label: 'Content-MD5',
      check: createChecksum('md5'),
      expected: () => contentMd5,
    });
  }

  const contentSha = request.headers.get('x-amz-content-sha256') ?? '';
  const signedPayloadHash = /^[0-9a-f]{64}$/i.test(contentSha) ? contentSha.toLowerCase() : null;
  if (signedPayloadHash && mode) {
    throw new PayloadError('InvalidRequest', 'aws-chunked body with a non-streaming payload hash');
  }

  const declaredTrailers = new Set(
    (request.headers.get('x-amz-trailer') ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const name of declaredTrailers) {
    const algorithm = name.replace(/^x-amz-checksum-/, '');
    if (!name.startsWith('x-amz-checksum-') || !isChecksumAlgorithm(algorithm)) {
      throw new PayloadError('InvalidRequest', `unsupported trailer: ${name}`);
    }
    if (!mode)
      throw new PayloadError('InvalidRequest', 'x-amz-trailer requires an aws-chunked body');
  }
  for (const algorithm of CHECKSUM_ALGORITHMS) {
    const header = `x-amz-checksum-${algorithm}`;
    if (!checksumHeaders) continue;
    const inHeader = request.headers.get(header)?.trim() ?? null;
    if (inHeader === null && !declaredTrailers.has(header)) continue;
    expectations.push({
      label: header,
      check: createChecksum(algorithm),
      expected: () => inHeader ?? trailers.get(header),
    });
  }

  const sha = signedPayloadHash ? createHash('sha256') : null;
  const decodedLength = mode ? request.headers.get('x-amz-decoded-content-length') : null;
  const pieces = mode ? decodeAwsChunked(raw, mode, signing, trailers) : streamPieces(raw);
  let size = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await pieces.next();
        if (!done) {
          size += value.length;
          sha?.update(value);
          for (const e of expectations) e.check.update(value);
          controller.enqueue(value);
          return;
        }
        if (decodedLength !== null && String(size) !== decodedLength.trim()) {
          throw new PayloadError(
            'IncompleteBody',
            `decoded body is ${size} bytes, x-amz-decoded-content-length says ${decodedLength}`,
          );
        }
        if (sha && sha.digest('hex') !== signedPayloadHash) {
          throw new PayloadError(
            'XAmzContentSHA256Mismatch',
            'The provided x-amz-content-sha256 header does not match what was computed',
          );
        }
        for (const e of expectations) {
          const expected = e.expected();
          if (expected === undefined) {
            throw new PayloadError('InvalidRequest', `missing ${e.label} trailer`);
          }
          if (e.check.digestBase64() !== expected) {
            throw new PayloadError('BadDigest', `${e.label} does not match the uploaded bytes`);
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      // `raw` is locked by the reader inside `pieces`; ending the generator
      // runs its `finally`, which cancels that reader.
      await pieces.return(undefined).catch(() => {});
    },
  });
}

async function* streamPieces(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Reads a small verified body (XML documents) as text. */
export async function payloadText(
  request: Request,
  signing?: SigningContext,
  options?: { checksumHeaders?: boolean },
): Promise<string> {
  return new Response(payloadStream(request, signing, options)).text();
}
