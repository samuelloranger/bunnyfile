import { Elysia, t } from 'elysia';
import { auth } from '../auth/auth';
import {
  BucketError,
  copyObject,
  createBucket,
  createPrefix,
  deleteBucket,
  deleteObject,
  deletePrefix,
  listBuckets,
  listObjects,
  moveObject,
  openObjectStream,
  putObject,
} from './library';

async function requireSession(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}

function mapBucketError(err: unknown, set: { status?: number | string }): { error: string } {
  if (err instanceof BucketError) {
    switch (err.code) {
      case 'not_found':
        set.status = 404;
        break;
      case 'bucket_exists':
      case 'bucket_not_empty':
        set.status = 409;
        break;
      default:
        set.status = 400;
    }
    return { error: err.message };
  }
  throw err;
}

export const s3ConsoleRoutes = new Elysia({ name: 's3-console' })
  .get('/api/s3-console/buckets', async ({ request, set }) => {
    const session = await requireSession(request);
    if (!session?.user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    return { buckets: await listBuckets() };
  })
  .post(
    '/api/s3-console/buckets',
    async ({ request, set, body }) => {
      const session = await requireSession(request);
      if (!session?.user) {
        set.status = 401;
        return { error: 'Unauthorized' };
      }
      try {
        return await createBucket(body.name);
      } catch (err) {
        return mapBucketError(err, set);
      }
    },
    { body: t.Object({ name: t.String({ minLength: 1, maxLength: 255 }) }) },
  )
  .delete('/api/s3-console/buckets/:bucket', async ({ request, set, params }) => {
    const session = await requireSession(request);
    if (!session?.user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    try {
      await deleteBucket(params.bucket);
      set.status = 204;
      return null;
    } catch (err) {
      return mapBucketError(err, set);
    }
  })
  .get('/api/s3-console/buckets/:bucket/objects', async ({ request, set, params }) => {
    const session = await requireSession(request);
    if (!session?.user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    const url = new URL(request.url);
    try {
      const input: {
        bucket: string;
        prefix: string;
        delimiter: string;
        continuationToken?: string;
        maxKeys?: number;
      } = {
        bucket: params.bucket,
        prefix: url.searchParams.get('prefix') ?? '',
        delimiter: url.searchParams.get('delimiter') ?? '/',
      };
      const token = url.searchParams.get('continuationToken');
      if (token) input.continuationToken = token;
      if (url.searchParams.has('maxKeys')) {
        input.maxKeys = Number.parseInt(url.searchParams.get('maxKeys')!, 10);
      }
      return await listObjects(input);
    } catch (err) {
      return mapBucketError(err, set);
    }
  })
  .post('/api/s3-console/buckets/:bucket/objects', async ({ request, set, params }) => {
    const session = await requireSession(request);
    if (!session?.user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (!key) {
      set.status = 400;
      return { error: 'key query parameter is required' };
    }
    if (!request.body) {
      set.status = 400;
      return { error: 'body is required' };
    }
    try {
      return await putObject(params.bucket, key, request.body);
    } catch (err) {
      return mapBucketError(err, set);
    }
  })
  .get('/api/s3-console/buckets/:bucket/object', async ({ request, set, params }) => {
    const session = await requireSession(request);
    if (!session?.user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    const key = new URL(request.url).searchParams.get('key');
    if (!key) {
      set.status = 400;
      return { error: 'key query parameter is required' };
    }
    try {
      const { info, stream } = await openObjectStream(params.bucket, key);
      const filename = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(info.size),
          'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
          etag: info.md5 ? `"${info.md5}"` : '',
        },
      });
    } catch (err) {
      return mapBucketError(err, set);
    }
  })
  .delete('/api/s3-console/buckets/:bucket/object', async ({ request, set, params }) => {
    const session = await requireSession(request);
    if (!session?.user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    const key = new URL(request.url).searchParams.get('key');
    if (!key) {
      set.status = 400;
      return { error: 'key query parameter is required' };
    }
    try {
      await deleteObject(params.bucket, key);
      set.status = 204;
      return null;
    } catch (err) {
      return mapBucketError(err, set);
    }
  })
  .post(
    '/api/s3-console/buckets/:bucket/prefixes',
    async ({ request, set, params, body }) => {
      const session = await requireSession(request);
      if (!session?.user) {
        set.status = 401;
        return { error: 'Unauthorized' };
      }
      try {
        return await createPrefix(params.bucket, body.prefix);
      } catch (err) {
        return mapBucketError(err, set);
      }
    },
    { body: t.Object({ prefix: t.String({ minLength: 1, maxLength: 1024 }) }) },
  )
  .post(
    '/api/s3-console/buckets/:bucket/copy',
    async ({ request, set, params, body }) => {
      const session = await requireSession(request);
      if (!session?.user) {
        set.status = 401;
        return { error: 'Unauthorized' };
      }
      try {
        if (body.move) {
          return await moveObject(params.bucket, body.srcKey, body.dstBucket, body.dstKey);
        }
        return await copyObject(params.bucket, body.srcKey, body.dstBucket, body.dstKey);
      } catch (err) {
        return mapBucketError(err, set);
      }
    },
    {
      body: t.Object({
        srcKey: t.String({ minLength: 1 }),
        dstBucket: t.String({ minLength: 1 }),
        dstKey: t.String({ minLength: 1 }),
        move: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/api/s3-console/buckets/:bucket/prefixes', async ({ request, set, params }) => {
    const session = await requireSession(request);
    if (!session?.user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    const prefix = new URL(request.url).searchParams.get('prefix');
    if (!prefix) {
      set.status = 400;
      return { error: 'prefix query parameter is required' };
    }
    try {
      await deletePrefix(params.bucket, prefix);
      set.status = 204;
      return null;
    } catch (err) {
      return mapBucketError(err, set);
    }
  });
