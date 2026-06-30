// Seeds DATA_DIR with a realistic demo file tree for release screenshots.
// Filesystem-first: the server indexes whatever is on disk at boot, so we just
// write files. Run BEFORE starting the server. Usage: DATA_DIR=... bun seed.ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

// Minimal placeholder bytes — enough for the listing to show a typed icon.
const placeholder = (label: string) => `BunnyFile demo placeholder: ${label}\n`;

const tree: Record<string, string> = {
  'Welcome.md': WELCOME,
  'server.ts': SERVER_TS,
  'budget-2026.csv': CSV,
  'demo-reel.mp4': placeholder('video'),
  'backups.zip': placeholder('archive'),
  'Documents/Quarterly Report.md': '# Quarterly Report\n\nNumbers go up.\n',
  'Documents/contract.pdf': placeholder('pdf'),
  'Documents/notes.txt': 'Remember to dogfood the share links.\n',
  'Photos/holiday.jpg': placeholder('image'),
  'Photos/screenshot.png': placeholder('image'),
  'Projects/bunnyfile/README.md': '# bunnyfile\n\nThe project that hosts itself.\n',
  'Projects/bunnyfile/config.json': '{\n  "port": 3901,\n  "dataDir": "/data/files"\n}\n',
};

await rm(DATA_DIR, { recursive: true, force: true });
for (const [rel, content] of Object.entries(tree)) {
  const full = join(DATA_DIR, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

console.log(`[seed] wrote ${Object.keys(tree).length} files into ${DATA_DIR}`);
