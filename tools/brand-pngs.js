// Renders public/brand/fabric-icon.svg (made by tools/brand-icon.py) to the PNG sizes the web app,
// the PWA manifest and the desktop shell use: a white rounded square, corner radius 19.5%.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const brand = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'brand');
const svg = fs.readFileSync(path.join(brand, 'fabric-icon.svg'), 'utf8');
const r = (72 * 0.195).toFixed(2);
const rounded = Buffer.from(svg.replace('<rect x="18" y="18" width="72" height="72"', `<rect x="18" y="18" width="72" height="72" rx="${r}"`));
for (const n of [32, 180, 192, 512]) {
  await sharp(rounded, { density: Math.ceil((n / 72) * 72 * 4) }).resize(n, n).png({ compressionLevel: 9 }).toFile(path.join(brand, `icon-${n}.png`));
  console.log(`wrote public/brand/icon-${n}.png`);
}
