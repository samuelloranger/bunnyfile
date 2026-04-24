export type UploadProgress = {
  current: number;
  total: number;
  percent: number;
};

type ProgressEventLike = {
  lengthComputable: boolean;
  loaded: number;
  total: number;
};

export function toUploadProgress(
  event: ProgressEventLike,
  current: number,
  total: number,
): UploadProgress | null {
  if (!event.lengthComputable || event.total <= 0) return null;
  const rawPercent = Math.round((event.loaded / event.total) * 100);
  const percent = Math.min(Math.max(rawPercent, 0), 100);
  return { current, total, percent };
}

export function uploadButtonLabel(progress: UploadProgress | null): string {
  if (!progress) return 'Upload';
  return `${progress.current}/${progress.total} · ${progress.percent}%`;
}

export function parseUploadErrorMessage(responseText: string): string {
  const fallback = 'Upload failed';
  try {
    const body = JSON.parse(responseText) as { error?: string };
    if (typeof body?.error === 'string' && body.error.trim()) {
      return body.error;
    }
  } catch {
    // Fall through to plain text fallback.
  }
  if (responseText.trim()) return responseText;
  return fallback;
}
