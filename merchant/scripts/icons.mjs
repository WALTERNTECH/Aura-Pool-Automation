// Renders the app icons from the mark: a cue ball inside its aura, on an ink tile.
// node scripts/icons.mjs  → public/favicon.svg, icon-192/512, maskable-512, apple-touch-icon, badge-72
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const mark = (size, { radius = 0.25, inset = 0 } = {}) => {
  const s = 64;
  const scale = 1 - inset;
  const c = s / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${size}" height="${size}">
  <rect width="${s}" height="${s}" rx="${s * radius}" fill="#111412"/>
  <g transform="translate(${c} ${c}) scale(${scale}) translate(${-c} ${-c})">
    <circle cx="32" cy="32" r="19" fill="none" stroke="#2f8c5f" stroke-width="3"/>
    <circle cx="32" cy="32" r="12" fill="#fbfbf9"/>
    <circle cx="28" cy="28" r="3.2" fill="#d9ddd8"/>
  </g>
</svg>`;
};

fs.writeFileSync(path.join(out, "favicon.svg"), mark(64));
const png = (svg, size, file) => sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(out, file));
await png(mark(512), 192, "icon-192.png");
await png(mark(512), 512, "icon-512.png");
// Maskable: full-bleed tile, the mark inside the 80% safe zone.
await png(mark(512, { radius: 0, inset: 0.22 }), 512, "maskable-512.png");
await png(mark(512, { radius: 0, inset: 0.12 }), 180, "apple-touch-icon.png");
// Android status-bar badge: white silhouette on transparent.
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="72" height="72"><circle cx="32" cy="32" r="22" fill="none" stroke="#fff" stroke-width="5"/><circle cx="32" cy="32" r="12" fill="#fff"/></svg>`)).png().toFile(path.join(out, "badge-72.png"));
fs.writeFileSync(path.join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
console.log("icons written to", out);
