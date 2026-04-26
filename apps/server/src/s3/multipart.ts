import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { s3MultipartPart, s3MultipartUpload, s3Object } from '../db/schema';
import { absFromRelOrThrow, DATA_ROOT } from '../files/store';
import { trackUpload } from '../inflight';
import { bodyStream } from './chunked';
import { s3ErrorXml, xmlDocument } from './xml';

const MULTIPART_DIR = resolve(DATA_ROOT, '.multipart');
const S3_XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

function s3Err(
  set: { status?: number | string },
  status: number,
  code: string,
  message: string,
  resource: string,
): Response {
  set.status = status;
  return xmlResponse(s3ErrorXml(code, message, resource), status);
}

function partFilePath(uploadId: string, partNumber: number): string {
  return resolve(MULTIPART_DIR, uploadId, String(partNumber).padStart(5, '0'));
}

async function writePart(
  uploadId: string,
  partNumber: number,
  stream: ReadableStream<Uint8Array>,
): Promise<{ size: number; md5: string; path: string }> {
  const path = partFilePath(uploadId, partNumber);
  await mkdir(dirname(path), { recursive: true });

  const hash = createHash('md5');
  let size = 0;
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  const writer = Bun.file(tmp).writer();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        size += value.byteLength;
        writer.write(value);
      }
    }
    await writer.end();
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await rename(tmp, path);
  return { size, md5: hash.digest('hex'), path };
}

function parseCompleteBody(xml: string): Array<{ partNumber: number; etag: string }> | null {
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const partRe = /<Part\b[^>]*>([\s\S]*?)<\/Part>/g;
  for (;;) {
    const partMatch = partRe.exec(xml);
    if (partMatch === null) break;
    const content = partMatch[1]!;
    const pnMatch = /<PartNumber[^>]*>(\d+)<\/PartNumber>/.exec(content);
    const etagMatch = /<ETag[^>]*>([^<]+)<\/ETag>/.exec(content);
    if (!pnMatch || !etagMatch) return null;
    const partNumber = Number.parseInt(pnMatch[1]!, 10);
    const etag = etagMatch[1]!
      .trim()
      .replace(/&#34;/g, '')
      .replace(/&quot;/g, '')
      .replace(/^"|"$/g, '');
    if (Number.isNaN(partNumber) || partNumber < 1 || partNumber > 10000) return null;
    parts.push({ partNumber, etag });
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

function multipartEtag(parts: Array<{ md5: string }>): string {
  const combined = Buffer.concat(parts.map((p) => Buffer.from(p.md5, 'hex')));
  const hash = createHash('md5').update(combined).digest('hex');
  return `"${hash}-${parts.length}"`;
}

async function createMultipartUpload(
  _set: { status?: number | string },
  bucket: string,
  key: string,
): Promise<Response> {
  const uploadId = crypto.randomUUID();
  await db.insert(s3MultipartUpload).values({ uploadId, bucket, key });
  await mkdir(resolve(MULTIPART_DIR, uploadId), { recursive: true });
  return xmlResponse(
    xmlDocument({
      name: 'InitiateMultipartUploadResult',
      attributes: { xmlns: S3_XMLNS },
      children: [
        { name: 'Bucket', value: bucket },
        { name: 'Key', value: key },
        { name: 'UploadId', value: uploadId },
      ],
    }),
  );
}

async function uploadPart(
  request: Request,
  set: { status?: number | string },
  uploadId: string,
  partNumber: number,
): Promise<Response> {
  const upload = db
    .select({ uploadId: s3MultipartUpload.uploadId })
    .from(s3MultipartUpload)
    .where(eq(s3MultipartUpload.uploadId, uploadId))
    .get();
  if (!upload) return s3Err(set, 404, 'NoSuchUpload', 'Upload not found', uploadId);

  const { size, md5, path } = await writePart(uploadId, partNumber, bodyStream(request));
  db.delete(s3MultipartPart)
    .where(and(eq(s3MultipartPart.uploadId, uploadId), eq(s3MultipartPart.partNumber, partNumber)))
    .run();
  await db.insert(s3MultipartPart).values({ uploadId, partNumber, size, md5, path });
  return new Response(null, { status: 200, headers: { ETag: `"${md5}"` } });
}

async function completeMultipartUpload(
  request: Request,
  set: { status?: number | string },
  bucket: string,
  key: string,
  uploadId: string,
  pathname: string,
): Promise<Response> {
  const upload = db
    .select({ uploadId: s3MultipartUpload.uploadId })
    .from(s3MultipartUpload)
    .where(eq(s3MultipartUpload.uploadId, uploadId))
    .get();
  if (!upload) return s3Err(set, 404, 'NoSuchUpload', 'Upload not found', pathname);

  const bodyText = await request.text();
  const clientParts = parseCompleteBody(bodyText);
  if (!clientParts || clientParts.length === 0) {
    return s3Err(
      set,
      400,
      'MalformedXML',
      'Could not parse CompleteMultipartUpload body',
      pathname,
    );
  }

  const dbParts = db
    .select({
      partNumber: s3MultipartPart.partNumber,
      md5: s3MultipartPart.md5,
      path: s3MultipartPart.path,
      size: s3MultipartPart.size,
    })
    .from(s3MultipartPart)
    .where(eq(s3MultipartPart.uploadId, uploadId))
    .all()
    .sort((a, b) => a.partNumber - b.partNumber);

  for (const cp of clientParts) {
    const dp = dbParts.find((p) => p.partNumber === cp.partNumber);
    if (!dp) return s3Err(set, 400, 'InvalidPart', `Part ${cp.partNumber} not found`, pathname);
    if (dp.md5 !== cp.etag) {
      return s3Err(set, 400, 'InvalidPart', `ETag mismatch for part ${cp.partNumber}`, pathname);
    }
  }

  const destRel = `s3/${bucket}/${key}`;
  const destAbs = absFromRelOrThrow(destRel);
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  const writer = Bun.file(tmp).writer();
  let totalSize = 0;
  for (const part of dbParts) {
    const data = await Bun.file(part.path).arrayBuffer();
    writer.write(new Uint8Array(data));
    totalSize += data.byteLength;
  }
  await writer.end();
  await rename(tmp, destAbs);

  const destStat = await stat(destAbs);
  const etagWithQuotes = multipartEtag(dbParts);
  const etagValue = etagWithQuotes.replace(/^"|"$/g, '');

  await db
    .insert(s3Object)
    .values({
      path: destRel,
      bucket,
      key,
      size: totalSize,
      mtimeMs: Math.round(destStat.mtimeMs),
      inode: Number(destStat.ino),
      md5: etagValue,
    })
    .onConflictDoUpdate({
      target: s3Object.path,
      set: {
        size: totalSize,
        mtimeMs: Math.round(destStat.mtimeMs),
        inode: Number(destStat.ino),
        md5: etagValue,
      },
    });

  for (const part of dbParts) {
    await rm(part.path, { force: true }).catch(() => {});
  }
  const uploadDir = resolve(MULTIPART_DIR, uploadId);
  await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
  await db.delete(s3MultipartUpload).where(eq(s3MultipartUpload.uploadId, uploadId));

  return xmlResponse(
    xmlDocument({
      name: 'CompleteMultipartUploadResult',
      attributes: { xmlns: S3_XMLNS },
      children: [
        { name: 'Location', value: `/${bucket}/${key}` },
        { name: 'Bucket', value: bucket },
        { name: 'Key', value: key },
        { name: 'ETag', value: etagWithQuotes },
      ],
    }),
  );
}

async function abortMultipartUpload(
  _set: { status?: number | string },
  uploadId: string,
): Promise<Response> {
  const parts = db
    .select({ path: s3MultipartPart.path })
    .from(s3MultipartPart)
    .where(eq(s3MultipartPart.uploadId, uploadId))
    .all();
  for (const part of parts) {
    await rm(part.path, { force: true }).catch(() => {});
  }
  const uploadDir = resolve(MULTIPART_DIR, uploadId);
  await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
  await db.delete(s3MultipartUpload).where(eq(s3MultipartUpload.uploadId, uploadId));
  return new Response(null, { status: 204 });
}

async function listParts(
  set: { status?: number | string },
  uploadId: string,
  pathname: string,
): Promise<Response> {
  const upload = db
    .select({ bucket: s3MultipartUpload.bucket, key: s3MultipartUpload.key })
    .from(s3MultipartUpload)
    .where(eq(s3MultipartUpload.uploadId, uploadId))
    .get();
  if (!upload) return s3Err(set, 404, 'NoSuchUpload', 'Upload not found', pathname);

  const parts = db
    .select({
      partNumber: s3MultipartPart.partNumber,
      md5: s3MultipartPart.md5,
      size: s3MultipartPart.size,
    })
    .from(s3MultipartPart)
    .where(eq(s3MultipartPart.uploadId, uploadId))
    .all()
    .sort((a, b) => a.partNumber - b.partNumber);

  return xmlResponse(
    xmlDocument({
      name: 'ListPartsResult',
      attributes: { xmlns: S3_XMLNS },
      children: [
        { name: 'Bucket', value: upload.bucket },
        { name: 'Key', value: upload.key },
        { name: 'UploadId', value: uploadId },
        ...parts.map((p) => ({
          name: 'Part',
          children: [
            { name: 'PartNumber', value: String(p.partNumber) },
            { name: 'ETag', value: `"${p.md5}"` },
            { name: 'Size', value: String(p.size) },
          ],
        })),
      ],
    }),
  );
}

export async function handleMultipart(
  request: Request,
  set: { status?: number | string },
  bucket: string,
  key: string,
  url: URL,
): Promise<Response> {
  const method = request.method;
  const uploadId = url.searchParams.get('uploadId');
  const partNumberStr = url.searchParams.get('partNumber');
  const isInitiate = url.searchParams.has('uploads');

  if (method === 'POST' && isInitiate) return createMultipartUpload(set, bucket, key);

  if (method === 'PUT' && partNumberStr && uploadId) {
    const partNumber = Number.parseInt(partNumberStr, 10);
    if (Number.isNaN(partNumber) || partNumber < 1 || partNumber > 10000) {
      return s3Err(set, 400, 'InvalidArgument', 'Part number must be 1–10000', url.pathname);
    }
    return uploadPart(request, set, uploadId, partNumber);
  }

  if (method === 'POST' && uploadId) {
    return trackUpload(completeMultipartUpload(request, set, bucket, key, uploadId, url.pathname));
  }

  if (method === 'DELETE' && uploadId) return abortMultipartUpload(set, uploadId);

  if (method === 'GET' && uploadId) return listParts(set, uploadId, url.pathname);

  return s3Err(set, 405, 'MethodNotAllowed', 'Method not allowed', url.pathname);
}
