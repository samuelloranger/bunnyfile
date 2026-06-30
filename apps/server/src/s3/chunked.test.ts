import { describe, expect, it } from 'bun:test';
import { decodeChunkedStream } from './chunked';

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(out);
}

describe('decodeChunkedStream', () => {
  it('decodes a well-formed chunked body', async () => {
    const body = '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n';
    expect(await collect(decodeChunkedStream(streamFromString(body)))).toBe('hello world');
  });

  it('errors on a negative chunk size instead of corrupting the stream', async () => {
    const body = '-a\r\nXXXXXXXXXX\r\n0\r\n\r\n';
    expect(collect(decodeChunkedStream(streamFromString(body)))).rejects.toThrow();
  });

  it('errors when the stream ends mid-chunk (truncated upload)', async () => {
    // Declares 10 bytes but only sends 3, then ends.
    const body = 'a\r\nhel';
    expect(collect(decodeChunkedStream(streamFromString(body)))).rejects.toThrow();
  });
});
