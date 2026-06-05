// Regenerates the binary image assets in frontend/public from their sources so
// they're reproducible rather than hand-made one-offs:
//
//   - og.png             rasterized from frontend/public/og.svg (social cards;
//                        Twitter/Facebook/LinkedIn/Slack don't render SVG OG).
//   - apple-touch-icon.png, icon-192.png, icon-512.png  rendered from the
//                        brand mark (the brain blob on a cream square).
//
// Not wired into the build — `sharp` is a heavy native dependency we don't want
// in the deploy path. Run it manually after changing og.svg or the brand mark:
//
//   npm i -D sharp && node scripts/generate-images.mjs
//
// Keep the brand-mark path below in sync with the favicon in frontend/index.html
// and the BrainBlob path in frontend/src/art.tsx.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "frontend", "public");

const BRAIN_PATH =
  "M 110 14 C 138 10 162 22 174 42 C 196 44 208 66 204 92 C 214 110 210 136 196 150 " +
  "C 198 176 176 198 150 196 C 138 210 116 212 102 202 C 84 212 60 206 50 188 " +
  "C 28 188 12 168 18 144 C 6 128 8 100 24 86 C 22 60 42 38 68 38 C 80 22 96 14 110 14 Z";
const CREAM = "#F4F1E6";
const TOMATO = "#E96A3D";
const INK = "#1F1E1A";

const appIcon =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220" width="220" height="220">` +
  `<rect width="220" height="220" fill="${CREAM}"/>` +
  `<path d="${BRAIN_PATH}" fill="${TOMATO}" stroke="${INK}" stroke-width="5"/></svg>`;

async function main() {
  let sharp;
  try {
    ({ default: sharp } = await import("sharp"));
  } catch {
    console.error("sharp is not installed. Run: npm i -D sharp && node scripts/generate-images.mjs");
    process.exit(1);
  }

  const iconBuffer = Buffer.from(appIcon);
  const jobs = [
    // Icons stay full-RGBA PNGs (small enough, crisp edges).
    { out: "apple-touch-icon.png", svg: iconBuffer, size: 180, density: 288 },
    { out: "icon-192.png", svg: iconBuffer, size: 192, density: 288 },
    { out: "icon-512.png", svg: iconBuffer, size: 512, density: 600 },
    // The OG card is palette-quantized (quality: 90) to keep it small for fast
    // social-scraper fetches.
    { out: "og.png", file: "og.svg", width: 1200, height: 630, density: 144, quality: 90 }
  ];

  for (const job of jobs) {
    const input = job.file ? readFileSync(resolve(publicDir, job.file)) : job.svg;
    const pipeline = sharp(input, { density: job.density });
    if (job.width) {
      pipeline.resize(job.width, job.height, { fit: "fill" });
    } else {
      pipeline.resize(job.size, job.size);
    }
    const info = await pipeline.png(job.quality ? { quality: job.quality } : {}).toFile(resolve(publicDir, job.out));
    console.log(`generated ${job.out} (${info.width}x${info.height}, ${info.size}B)`);
  }
}

main();
