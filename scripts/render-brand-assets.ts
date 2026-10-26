/**
 * Renders the raster brand assets in public/ from the clover mark:
 *
 *   npm run brand:render
 *
 * apple-touch-icon.png (180), icon-192.png, icon-512.png, icon-maskable-512.png
 * and og-image.png (1200x630 social preview). The leaf path and colours match
 * src/components/BrandMark.tsx; public/favicon.svg is hand-written.
 * Uses the Playwright Chromium that the browser tests already install.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const LEAF = 'M17 14 V8.5 A6.5 6.5 0 0 1 23.5 2 A6.5 6.5 0 0 1 30 8.5 A6.5 6.5 0 0 1 23.5 15 H18 A1 1 0 0 1 17 14 Z';
const COLORS = ['#ef9a94', '#efc95e', '#86cc9e', '#bb93e2'];
const CLOVER = COLORS.map((c, i) => `<path d="${LEAF}" fill="${c}" transform="rotate(${String(i * 90)} 16 16)"/>`).join('');

/** A soft white-to-pale-purple tile with the clover centred; `inset` is the share of the tile the clover spans. */
const tile = (size: number, { radius, inset }: { radius: number; inset: number }) => {
  const s = (size * inset) / 28; // the clover spans 28 units of the 32-unit grid
  const t = size / 2 - 16 * s;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}" viewBox="0 0 ${String(size)} ${String(size)}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f3ecfa"/></linearGradient></defs>
    <rect width="${String(size)}" height="${String(size)}" rx="${String(size * radius)}" fill="url(#g)"/>
    <g transform="translate(${String(t)} ${String(t)}) scale(${String(s)})">${CLOVER}</g>
  </svg>`;
};

const OG = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; }
  body {
    width: 1200px; height: 630px; box-sizing: border-box; padding: 72px 88px;
    display: flex; flex-direction: column; justify-content: space-between;
    color: #1d1a20; font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
    background:
      radial-gradient(900px 420px at 30% -10%, #f3ecfa, transparent 65%),
      radial-gradient(700px 380px at 100% 110%, #fdf6dc, transparent 70%),
      #faf9fb;
  }
  .brand { display: flex; align-items: center; gap: 16px; font-weight: 700; font-size: 44px; letter-spacing: -0.035em; }
  h1 { margin: 0; font-weight: 700; font-size: 84px; line-height: 1.04; letter-spacing: -0.035em; }
  .foot { display: flex; justify-content: space-between; align-items: center; font-size: 26px; color: #5e5862; font-weight: 500; }
  .pill { padding: 10px 22px; border-radius: 999px; background: #f3ecfa; color: #6a3596; font-weight: 600; }
</style></head><body>
  <div class="brand"><svg width="56" height="56" viewBox="0 0 32 32">${CLOVER}</svg>even odds</div>
  <h1>Registration is a lottery,<br>not a race.</h1>
  <div class="foot"><span>Frozen inputs · public randomness · a draw anyone can replay</span><span class="pill">Verifiable lottery</span></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
const shoot = async (file: string, html: string, width: number, height: number) => {
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate('document.fonts.ready');
  await writeFile(`public/${file}`, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height } }));
  console.log(`public/${file}`);
};
const page0 = (svg: string) => `<!doctype html><html><body style="margin:0">${svg}</body></html>`;

await shoot('apple-touch-icon.png', page0(tile(180, { radius: 0, inset: 0.62 })), 180, 180); // iOS rounds the corners itself
await shoot('icon-192.png', page0(tile(192, { radius: 0.225, inset: 0.62 })), 192, 192);
await shoot('icon-512.png', page0(tile(512, { radius: 0.225, inset: 0.62 })), 512, 512);
await shoot('icon-maskable-512.png', page0(tile(512, { radius: 0, inset: 0.48 })), 512, 512); // inside the 80% safe zone
await shoot('og-image.png', OG, 1200, 630);
await browser.close();
