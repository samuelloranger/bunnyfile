// Seeds DATA_DIR with a realistic demo file tree for release screenshots.
// Filesystem-first: the server indexes whatever is on disk at boot, so we just
// write files. Run BEFORE starting the server. Usage: DATA_DIR=... bun seed.ts
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR;
if (!DATA_DIR) throw new Error('DATA_DIR env is required');

const WELCOME = `# Welcome to BunnyFile 🐰

> Files, shared. That's it.

This is a **live preview** rendered right in the browser — Markdown, code, images,
PDFs, audio and video all open inline without a download.

## What you can do here

- Browse and organize files with drag-and-drop
- Share any file with a link, password, expiry, and QR code
- Talk S3: point \`rclone\`, \`restic\` or \`kopia\` straight at it
- Dark mode, keyboard nav, drag-and-drop — all built in

\`\`\`ts
// It even highlights code.
export const greet = (name: string) => \`Hello, \${name}!\`;
\`\`\`
`;

const SERVER_TS = `import { Elysia } from 'elysia';

export const app = new Elysia()
  .get('/api/health', () => ({ ok: true }))
  .listen(3901);

console.log('BunnyFile listening on :3901');
`;

const CSV = `month,uploads,downloads,storage_gb
Jan,1180,2104,18.4
Feb,1340,2550,21.9
Mar,1602,3110,26.3
`;

const tree: Record<string, string> = {
  'Welcome.md': WELCOME,
  'server.ts': SERVER_TS,
  'budget-2026.csv': CSV,
  'Documents/Quarterly Report.md': '# Quarterly Report\n\nNumbers go up.\n',
  'Documents/notes.txt': 'Remember to dogfood the share links.\n',
  'Projects/bunnyfile/README.md': '# bunnyfile\n\nThe project that hosts itself.\n',
  'Projects/bunnyfile/config.json': '{\n  "port": 3901,\n  "dataDir": "/data/files"\n}\n',
};

/** Sparse large files — huge st_size, tiny disk usage (for credible storage meter). */
const sparse: Record<string, number> = {
  'demo-reel.mp4': 2 * 1024 * 1024 * 1024, // 2 GiB
  'backups.zip': 512 * 1024 * 1024, // 512 MiB
  'Documents/contract.pdf': 48 * 1024 * 1024, // 48 MiB
  'Photos/holiday.jpg': 12 * 1024 * 1024,
  'Photos/screenshot.png': 8 * 1024 * 1024,
};

async function writeSparse(path: string, size: number) {
  await mkdir(join(path, '..'), { recursive: true });
  const fh = await open(path, 'w');
  try {
    await fh.truncate(size);
  } finally {
    await fh.close();
  }
}

await rm(DATA_DIR, { recursive: true, force: true });
const filesRoot = join(DATA_DIR, 'files');
for (const [rel, content] of Object.entries(tree)) {
  const full = join(filesRoot, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}
for (const [rel, size] of Object.entries(sparse)) {
  await writeSparse(join(filesRoot, rel), size);
  // Tiny real header so MIME sniffing / icons still work for some types
  if (rel.endsWith('.pdf')) {
    const fh = await open(join(filesRoot, rel), 'r+');
    try {
      await fh.write(Buffer.from('%PDF-1.4\n'), 0, 9, 0);
    } finally {
      await fh.close();
    }
  }
}

console.log(
  `[seed] wrote ${Object.keys(tree).length + Object.keys(sparse).length} files into ${filesRoot}`,
);
