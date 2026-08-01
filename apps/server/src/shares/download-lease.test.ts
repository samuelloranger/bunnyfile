import { describe, expect, test } from 'bun:test';
import { attachDownloadLease } from './download-lease';

function bytesStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]!);
    },
  });
}

describe('attachDownloadLease', () => {
  test('calls onComplete after full read', async () => {
    let complete = 0;
    let cancel = 0;
    const stream = attachDownloadLease(bytesStream([new Uint8Array([1, 2]), new Uint8Array([3])]), {
      onComplete: () => {
        complete++;
      },
      onCancel: () => {
        cancel++;
      },
    });
    const reader = stream.getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }
    expect(complete).toBe(1);
    expect(cancel).toBe(0);
  });

  test('calls onCancel when the reader cancels mid-stream', async () => {
    let complete = 0;
    let cancel = 0;
    const stream = attachDownloadLease(
      bytesStream([new Uint8Array(64 * 1024), new Uint8Array(64 * 1024)]),
      {
        onComplete: () => {
          complete++;
        },
        onCancel: () => {
          cancel++;
        },
      },
    );
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(complete).toBe(0);
    expect(cancel).toBe(1);
  });
});
