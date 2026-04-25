let active = 0;

export function trackUpload<T>(p: Promise<T>): Promise<T> {
  active++;
  return p.finally(() => {
    active--;
  });
}

export async function drainUploads(timeoutMs = 30_000): Promise<void> {
  if (active === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (active > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (active > 0) {
    console.warn(`[shutdown] timed out with ${active} upload(s) still in progress`);
  }
}
