export type BucketInfo = { name: string; createdAt: string };

export type ObjectInfo = {
  key: string;
  size: number;
  mtimeMs: number;
  md5: string;
};

export type ListObjectsResult = {
  objects: ObjectInfo[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const s3BucketsQueryKey = ['s3-console', 'buckets'] as const;

export async function fetchBuckets(): Promise<BucketInfo[]> {
  const data = await json<{ buckets: BucketInfo[] }>(
    await fetch('/api/s3-console/buckets', { credentials: 'include' }),
  );
  return data.buckets;
}

export async function createBucket(name: string): Promise<BucketInfo> {
  return json(
    await fetch('/api/s3-console/buckets', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
}

export async function deleteBucket(name: string): Promise<void> {
  await json(
    await fetch(`/api/s3-console/buckets/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      credentials: 'include',
    }),
  );
}

export function s3ObjectsQueryKey(bucket: string, prefix: string) {
  return ['s3-console', 'objects', bucket, prefix] as const;
}

export async function fetchObjects(bucket: string, prefix: string): Promise<ListObjectsResult> {
  const qs = new URLSearchParams({ prefix, delimiter: '/' });
  return json(
    await fetch(`/api/s3-console/buckets/${encodeURIComponent(bucket)}/objects?${qs}`, {
      credentials: 'include',
    }),
  );
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  const qs = new URLSearchParams({ key });
  await json(
    await fetch(`/api/s3-console/buckets/${encodeURIComponent(bucket)}/object?${qs}`, {
      method: 'DELETE',
      credentials: 'include',
    }),
  );
}

export async function createPrefix(bucket: string, prefix: string): Promise<ObjectInfo> {
  return json(
    await fetch(`/api/s3-console/buckets/${encodeURIComponent(bucket)}/prefixes`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefix }),
    }),
  );
}

export async function copyOrMoveObject(input: {
  srcBucket: string;
  srcKey: string;
  dstBucket: string;
  dstKey: string;
  move?: boolean;
}): Promise<ObjectInfo> {
  return json(
    await fetch(`/api/s3-console/buckets/${encodeURIComponent(input.srcBucket)}/copy`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        srcKey: input.srcKey,
        dstBucket: input.dstBucket,
        dstKey: input.dstKey,
        move: input.move ?? false,
      }),
    }),
  );
}

export function objectDownloadUrl(bucket: string, key: string): string {
  const qs = new URLSearchParams({ key });
  return `/api/s3-console/buckets/${encodeURIComponent(bucket)}/object?${qs}`;
}

export function isFolderMarkerKey(key: string): boolean {
  return key === '.keep' || key.endsWith('/.keep');
}

export function uploadObject(
  bucket: string,
  key: string,
  file: Blob,
  onProgress?: (pct: number) => void,
): Promise<ObjectInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ key });
    xhr.open('POST', `/api/s3-console/buckets/${encodeURIComponent(bucket)}/objects?${qs}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (ev) => {
      if (!onProgress || !ev.lengthComputable || ev.total <= 0) return;
      onProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as ObjectInfo);
        } catch {
          reject(new Error('Invalid upload response'));
        }
      } else {
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          reject(new Error(body.error || xhr.statusText));
        } catch {
          reject(new Error(xhr.statusText || 'Upload failed'));
        }
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}
