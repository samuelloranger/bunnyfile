import { sql } from 'drizzle-orm';
import { blob, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Auth schema — matches better-auth's required shape for the Drizzle adapter.
 * Generated from `npx @better-auth/cli generate`; keep in sync by re-running
 * the CLI after changing the auth config (additional fields, plugins, etc.).
 */

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).default(false).notNull(),
  image: text('image'),
  role: text('role', { enum: ['admin', 'user'] })
    .notNull()
    .default('user'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

export type User = typeof user.$inferSelect;
export type Session = typeof session.$inferSelect;
export type Account = typeof account.$inferSelect;

/**
 * File index — a cache over the real filesystem at DATA_DIR.
 * Source of truth is the disk; rows are derived data (size, mime, hash).
 * `path` is relative to DATA_DIR, POSIX-separated, no leading slash.
 */
export const fileIndex = sqliteTable('file_index', {
  path: text('path').primaryKey(),
  size: integer('size').notNull(),
  mtimeMs: integer('mtime_ms').notNull(),
  inode: integer('inode').notNull(),
  sha256: text('sha256'),
  mime: text('mime').notNull(),
  uploadedByUserId: text('uploaded_by_user_id').references(() => user.id, {
    onDelete: 'set null',
  }),
  indexedAt: integer('indexed_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

export type FileIndexRow = typeof fileIndex.$inferSelect;

export const shareLink = sqliteTable(
  'share_link',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    path: text('path').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    passwordHash: text('password_hash'),
    maxDownloads: integer('max_downloads'),
    downloadCount: integer('download_count').notNull().default(0),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('share_link_token_idx').on(t.token),
    index('share_link_created_by_user_id_idx').on(t.createdByUserId),
    index('share_link_expires_at_idx').on(t.expiresAt),
  ],
);

export type ShareLinkRow = typeof shareLink.$inferSelect;

export const s3Object = sqliteTable(
  's3_object',
  {
    path: text('path').primaryKey(),
    bucket: text('bucket').notNull(),
    key: text('key').notNull(),
    size: integer('size').notNull(),
    mtimeMs: integer('mtime_ms').notNull(),
    inode: integer('inode').notNull(),
    md5: text('md5').notNull(),
  },
  (t) => [index('s3_object_bucket_idx').on(t.bucket)],
);

export type S3ObjectRow = typeof s3Object.$inferSelect;

export const s3MultipartUpload = sqliteTable(
  's3_multipart_upload',
  {
    uploadId: text('upload_id').primaryKey(),
    bucket: text('bucket').notNull(),
    key: text('key').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [index('s3_mpu_bucket_key_idx').on(t.bucket, t.key)],
);

export const s3MultipartPart = sqliteTable(
  's3_multipart_part',
  {
    uploadId: text('upload_id')
      .notNull()
      .references(() => s3MultipartUpload.uploadId, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    size: integer('size').notNull(),
    md5: text('md5').notNull(),
    path: text('path').notNull(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.partNumber] })],
);

export const s3AccessKey = sqliteTable(
  's3_access_key',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessKeyId: text('access_key_id').notNull().unique(),
    secretKeyEncrypted: text('secret_key_encrypted').notNull(),
    name: text('name').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [
    index('s3_access_key_user_id_idx').on(t.userId),
    index('s3_access_key_access_key_id_idx').on(t.accessKeyId),
  ],
);

export type S3MultipartUploadRow = typeof s3MultipartUpload.$inferSelect;
export type S3MultipartPartRow = typeof s3MultipartPart.$inferSelect;
export type S3AccessKeyRow = typeof s3AccessKey.$inferSelect;

export const thumbnail = sqliteTable('thumbnail', {
  path: text('path')
    .primaryKey()
    .references(() => fileIndex.path, { onDelete: 'cascade' }),
  data: blob('data', { mode: 'buffer' }).notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
});

export const trashItem = sqliteTable(
  'trash_item',
  {
    id: text('id').primaryKey(),
    originalPath: text('original_path').notNull(),
    trashPath: text('trash_path').notNull().unique(),
    kind: text('kind', { enum: ['file', 'dir'] }).notNull(),
    size: integer('size'),
    mime: text('mime'),
    deletedByUserId: text('deleted_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [
    index('trash_item_deleted_by_user_id_idx').on(t.deletedByUserId),
    index('trash_item_deleted_at_idx').on(t.deletedAt),
  ],
);

export type TrashItemRow = typeof trashItem.$inferSelect;

export type ThumbnailRow = typeof thumbnail.$inferSelect;
