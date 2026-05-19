import { count, sql } from 'drizzle-orm';
import { db } from './db';
import { fileIndex, user } from './db/schema';
import { activeUploadCount } from './inflight';

const startedAt = Date.now();
let httpRequestsTotal = 0;

export function recordHttpRequest(): void {
  httpRequestsTotal++;
}

export async function prometheusMetrics(): Promise<string> {
  const uptimeSeconds = (Date.now() - startedAt) / 1000;
  const version = Bun.env.APP_VERSION ?? '0.0.1';

  const usage = db
    .select({
      fileCount: sql<number>`count(*)`,
      usedBytes: sql<number>`coalesce(sum(${fileIndex.size}), 0)`,
    })
    .from(fileIndex)
    .get();

  const userCount = db.select({ c: count() }).from(user).get()?.c ?? 0;

  const lines = [
    '# HELP bunnyfile_info Static build metadata.',
    '# TYPE bunnyfile_info gauge',
    `bunnyfile_info{version="${version}"} 1`,
    '# HELP bunnyfile_uptime_seconds Seconds since process start.',
    '# TYPE bunnyfile_uptime_seconds gauge',
    `bunnyfile_uptime_seconds ${uptimeSeconds.toFixed(3)}`,
    '# HELP bunnyfile_http_requests_total Total HTTP requests handled.',
    '# TYPE bunnyfile_http_requests_total counter',
    `bunnyfile_http_requests_total ${httpRequestsTotal}`,
    '# HELP bunnyfile_uploads_inflight Active file uploads being written.',
    '# TYPE bunnyfile_uploads_inflight gauge',
    `bunnyfile_uploads_inflight ${activeUploadCount()}`,
    '# HELP bunnyfile_files_total Indexed files in the filesystem cache.',
    '# TYPE bunnyfile_files_total gauge',
    `bunnyfile_files_total ${usage?.fileCount ?? 0}`,
    '# HELP bunnyfile_storage_used_bytes Total bytes indexed in file_index.',
    '# TYPE bunnyfile_storage_used_bytes gauge',
    `bunnyfile_storage_used_bytes ${usage?.usedBytes ?? 0}`,
    '# HELP bunnyfile_users_total Registered users.',
    '# TYPE bunnyfile_users_total gauge',
    `bunnyfile_users_total ${userCount}`,
  ];

  return `${lines.join('\n')}\n`;
}
