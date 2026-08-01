/**
 * Wrap a byte stream so `onComplete` runs when the stream finishes cleanly and
 * `onCancel` runs on cancel/error. Exactly one of the two settles.
 */
export function attachDownloadLease(
  base: ReadableStream<Uint8Array>,
  hooks: {
    onComplete: () => void | Promise<void>;
    onCancel: () => void | Promise<void>;
  },
): ReadableStream<Uint8Array> {
  const reader = base.getReader();
  let settled = false;

  const complete = async () => {
    if (settled) return;
    settled = true;
    await hooks.onComplete();
  };
  const cancel = async () => {
    if (settled) return;
    settled = true;
    await hooks.onCancel();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await complete();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        await cancel();
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await cancel();
    },
  });
}
