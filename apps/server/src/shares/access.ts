import { stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { fileIndex, type ShareLinkRow, shareLink } from '../db/schema';
import { mimeFromName } from '../files/mime';
import { basenameOf } from '../files/paths';
import { absFromRelOrThrow } from '../files/store';
import { ensureShareZip } from './folder-zip';

export type ShareUnavailableReason = 'not_found' | 'expired' | 'revoked' | 'max_downloads';

export type SharePublicMeta = {
  token: string;
  path: string;
  name: string;
  size: number | null;
  mime: string;
  requiresPassword: boolean;
  expiresAt: Date | null;
  maxDownloads: number | null;
  downloadCount: number;
};

export type InspectResult =
  | {
      status: 'unavailable';
      reason: ShareUnavailableReason;
      message: string;
    }
  | {
      status: 'locked';
      requiresPassword: true;
      expiresAt: Date | null;
      maxDownloads: number | null;
      downloadCount: number;
    }
  | ({ status: 'unlocked'; requiresPassword: false } & SharePublicMeta);

type ShareState =
  | { status: 'ok'; row: ShareLinkRow }
  | { status: ShareUnavailableReason; row?: ShareLinkRow };

async function getShareState(token: string): Promise<ShareState> {
  const row = await db
    .select()
    .from(shareLink)
    .where(eq(shareLink.token, token))
    .then((r) => r[0]);
  if (!row) return { status: 'not_found' };
  if (row.revokedAt) return { status: 'revoked', row };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { status: 'expired', row };
  }
  if (row.maxDownloads != null && row.downloadCount >= row.maxDownloads) {
    return { status: 'max_downloads', row };
  }
  return { status: 'ok', row };
}

export function statusMessage(reason: ShareUnavailableReason): string {
  if (reason === 'expired') return 'This share link has expired.';
  if (reason === 'revoked') return 'This share link has been revoked.';
  if (reason === 'max_downloads') return 'This share link reached its download limit.';
  return 'This share link does not exist.';
}

async function buildUnlockedPublicMeta(row: ShareLinkRow): Promise<SharePublicMeta> {
  let isDir = false;
  try {
    isDir = (await stat(absFromRelOrThrow(row.path))).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    const { size } = await ensureShareZip(row.id, row.path);
    return {
      token: row.token,
      path: row.path,
      name: `${basenameOf(row.path)}.zip`,
      size,
      mime: 'application/zip',
      requiresPassword: Boolean(row.passwordHash),
      expiresAt: row.expiresAt,
      maxDownloads: row.maxDownloads,
      downloadCount: row.downloadCount,
    };
  }

  const indexRow = await db
    .select()
    .from(fileIndex)
    .where(eq(fileIndex.path, row.path))
    .then((r) => r[0]);

  return {
    token: row.token,
    path: row.path,
    name: basenameOf(row.path),
    size: indexRow?.size ?? null,
    mime: indexRow?.mime ?? mimeFromName(basenameOf(row.path)),
    requiresPassword: Boolean(row.passwordHash),
    expiresAt: row.expiresAt,
    maxDownloads: row.maxDownloads,
    downloadCount: row.downloadCount,
  };
}

export async function inspect(token: string): Promise<InspectResult> {
  const state = await getShareState(token);
  if (state.status !== 'ok') {
    return {
      status: 'unavailable',
      reason: state.status,
      message: statusMessage(state.status),
    };
  }

  const row = state.row;
  if (row.passwordHash) {
    return {
      status: 'locked',
      requiresPassword: true,
      expiresAt: row.expiresAt,
      maxDownloads: row.maxDownloads,
      downloadCount: row.downloadCount,
    };
  }

  const meta = await buildUnlockedPublicMeta(row);
  return { status: 'unlocked', requiresPassword: false, ...meta };
}

export type VerifyResult =
  | ({ ok: true } & SharePublicMeta)
  | { ok: false; error: 'unavailable'; reason: ShareUnavailableReason; message: string }
  | { ok: false; error: 'unauthorized'; message: string };

export async function verify(token: string, password?: string | null): Promise<VerifyResult> {
  const state = await getShareState(token);
  if (state.status !== 'ok') {
    return {
      ok: false,
      error: 'unavailable',
      reason: state.status,
      message: statusMessage(state.status),
    };
  }
  const row = state.row;
  if (row.passwordHash) {
    if (!password || !(await Bun.password.verify(password, row.passwordHash))) {
      return {
        ok: false,
        error: 'unauthorized',
        message: 'Password required or invalid.',
      };
    }
  }
  const meta = await buildUnlockedPublicMeta(row);
  return { ok: true, ...meta };
}
