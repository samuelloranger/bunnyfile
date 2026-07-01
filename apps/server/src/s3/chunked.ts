const dec = new TextDecoder();

function concat(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Decodes HTTP/1.1 chunked transfer-encoding from a stream.
 * Needed because Caddy proxies HTTP/2 client requests to BunnyFile's HTTP/1.1
 * backend using chunked encoding, which Bun does not transparently decode.
 */
export function decodeChunkedStream(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let closed = false;

  async function fill(): Promise<boolean> {
    if (closed) return false;
    const { done, value } = await reader.read();
    if (value?.length) buf = concat(buf, value as Uint8Array<ArrayBuffer>);
    if (done) closed = true;
    return !done || buf.length > 0;
  }

  async function fillUntil(n: number): Promise<boolean> {
    while (buf.length < n) {
      if (!(await fill())) return false;
    }
    return true;
  }

  function findCRLF(): number {
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
    }
    return -1;
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          // read until we can find a \r\n for the chunk-size line
          let crlfPos = findCRLF();
          while (crlfPos < 0) {
            if (!(await fill())) {
              controller.close();
              return;
            }
            crlfPos = findCRLF();
          }

          // parse chunk size (ignore optional chunk extensions after ';')
          const sizeLine = dec.decode(buf.slice(0, crlfPos));
          const chunkSize = Number.parseInt((sizeLine.split(';')[0] ?? '').trim(), 16);

          // A negative size (e.g. "-a") parses without NaN and would make the
          // slice bounds below go out of range, desyncing the parser. Reject it.
          if (Number.isNaN(chunkSize) || chunkSize < 0) {
            controller.error(new Error('invalid chunk size in chunked encoding'));
            return;
          }
          if (chunkSize === 0) {
            // Final zero-length chunk — end of body.
            controller.close();
            return;
          }

          const dataStart = crlfPos + 2;
          const dataEnd = dataStart + chunkSize;
          const needed = dataEnd + 2; // trailing \r\n

          if (!(await fillUntil(needed))) {
            // Stream ended mid-chunk: the upload is truncated. Erroring (rather
            // than enqueuing the partial data and closing) ensures the writer
            // aborts and the partial file is never committed as complete.
            controller.error(new Error('chunked stream ended mid-chunk'));
            return;
          }

          controller.enqueue(buf.slice(dataStart, dataEnd));
          buf = buf.slice(needed);
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Returns a decoded body stream. If Transfer-Encoding includes "chunked",
 * wraps the stream with decodeChunkedStream; otherwise returns it as-is.
 */
export function bodyStream(request: Request): ReadableStream<Uint8Array> {
  const empty = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  const raw = request.body ?? empty;
  const te = request.headers.get('transfer-encoding') ?? '';
  const isChunked = te
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes('chunked');
  return isChunked ? decodeChunkedStream(raw) : raw;
}
