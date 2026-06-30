// Captures README screenshots against a running, seeded BunnyFile instance.
// Assumes the server is already serving the built SPA + API on one origin.
// Usage: SCREENSHOT_URL=http://localhost:3901 bun scripts/screenshot/shots.ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.SCREENSHOT_URL ?? 'http://localhost:3901';
const OUT = join(import.meta.dir, '../../docs/screenshots');
const ADMIN = { name: 'Demo User', email: 'demo@bunnyfile.app', password: 'demo-password-123' };

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

function shot(name: string) {
  return page.screenshot({ path: join(OUT, `${name}.png`) });
}

// --- First-run admin setup -------------------------------------------------
await page.goto(`${BASE}/setup`, { waitUntil: 'networkidle' });
await page.getByPlaceholder('Ada Lovelace').fill(ADMIN.name);
await page.getByPlaceholder('admin@example.com').fill(ADMIN.email);
await page.getByPlaceholder('At least 8 characters').fill(ADMIN.password);
await page.locator('form button[type="submit"]').click();
await page.waitForURL('**/files**', { timeout: 30_000 });

// Prefer list view — that's where row double-click + the actions menu live.
await page.getByRole('button', { name: 'List view' }).click();
await page.getByText('Welcome.md', { exact: true }).waitFor();
await page.waitForTimeout(400); // let thumbnails/layout settle
await shot('browser');

// --- Inline preview --------------------------------------------------------
await page.getByText('Welcome.md', { exact: true }).dblclick();
await page.getByRole('dialog').waitFor();
await page.waitForTimeout(400);
await shot('preview');
await page.keyboard.press('Escape');
await page.getByRole('dialog').waitFor({ state: 'hidden' });

// --- Share dialog ----------------------------------------------------------
await page.getByRole('button', { name: 'More actions for Welcome.md', exact: true }).click();
await page.getByRole('menuitem', { name: /share/i }).click();
await page.getByRole('dialog').waitFor();
await page.waitForTimeout(300);
await shot('share');

await browser.close();
console.log(`[shots] wrote browser.png, preview.png, share.png to ${OUT}`);
