// Web-presence static files served from frontend/public: robots.txt, the
// sitemap, and the RFC 9116 security.txt. These ship verbatim to
// stimli.pages.dev, so guard their key invariants — crawlers must be kept out
// of the API and the private share/invite tokens, and the security contact has
// to stay machine-readable and unexpired.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readPublic(path) {
  return readFileSync(new URL(`../frontend/public/${path}`, import.meta.url), "utf8");
}

function readPublicBytes(path) {
  return readFileSync(new URL(`../frontend/public/${path}`, import.meta.url));
}

function pngDimensions(path) {
  const bytes = readPublicBytes(path);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${path} must be a PNG`);
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR", `${path} must start with an IHDR chunk`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("robots.txt keeps crawlers out of the API, app, and tokened links", () => {
  // Compare against trimmed lines rather than building a regex from each path
  // (which only escaped "/" and tripped CodeQL's incomplete-sanitization rule).
  const lines = readPublic("robots.txt").split(/\r?\n/).map((line) => line.trim());
  // /app is blocked as "/app$" + "/app/" rather than a bare "/app" prefix —
  // the bare rule would also match /apple-touch-icon.png.
  for (const path of ["/api/", "/app$", "/app/", "/share/", "/invite/"]) {
    assert.ok(lines.includes(`Disallow: ${path}`), `expected Disallow ${path}`);
  }
  assert.equal(
    lines.includes("Disallow: /app"),
    false,
    "bare /app prefix rule would also block /apple-touch-icon.png"
  );
  assert.ok(lines.includes("Sitemap: https://stimli.pages.dev/sitemap.xml"));
});

test("sitemap.xml is well-formed and lists the public marketing pages", () => {
  const sitemap = readPublic("sitemap.xml");
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(sitemap, /<loc>https:\/\/stimli\.pages\.dev\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/stimli\.pages\.dev\/legal<\/loc>/);
  // Balanced url tags.
  assert.equal((sitemap.match(/<url>/g) || []).length, (sitemap.match(/<\/url>/g) || []).length);
  // Private surfaces must not be advertised in the sitemap.
  for (const fragment of ["/app", "/share/", "/invite/", "/api/"]) {
    assert.ok(!sitemap.includes(`stimli.pages.dev${fragment}`), `sitemap must not list ${fragment}`);
  }
});

test("web manifest is valid JSON with icons and required fields", () => {
  const manifest = JSON.parse(readPublic("manifest.webmanifest"));
  assert.equal(typeof manifest.name, "string");
  assert.ok(manifest.name.length > 0);
  assert.equal(manifest.start_url, "/");
  assert.ok(["standalone", "minimal-ui", "browser", "fullscreen"].includes(manifest.display));
  assert.match(manifest.theme_color, /^#[0-9a-fA-F]{6}$/);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1);
  for (const icon of manifest.icons) {
    assert.match(icon.sizes, /^\d+x\d+$/);
    assert.equal(icon.type, "image/png");
    assert.match(icon.src, /^\/icon-\d+\.png$/);
    const [width, height] = icon.sizes.split("x").map((value) => Number(value));
    assert.deepEqual(pngDimensions(icon.src.slice(1)), { width, height });
  }
  assert.deepEqual(pngDimensions("apple-touch-icon.png"), { width: 180, height: 180 });
  assert.deepEqual(pngDimensions("og.png"), { width: 1200, height: 630 });
});

test("security.txt has the required RFC 9116 fields and an unexpired Expires", () => {
  const security = readPublic(".well-known/security.txt");
  assert.match(security, /^Contact: https:\/\/github\.com\/manrajmondair\/stimli\/security\/advisories\/new\s*$/m);
  assert.match(security, /^Policy: https:\/\/github\.com\/manrajmondair\/stimli\/blob\/main\/SECURITY\.md\s*$/m);
  assert.match(security, /^Canonical: https:\/\/stimli\.pages\.dev\/\.well-known\/security\.txt\s*$/m);
  const expiresMatch = security.match(/^Expires: (.+)$/m);
  assert.ok(expiresMatch, "security.txt must declare an Expires field (RFC 9116)");
  const expiresAt = Date.parse(expiresMatch[1].trim());
  assert.ok(Number.isFinite(expiresAt), "Expires must be a parseable date");
  assert.ok(expiresAt > Date.now(), "security.txt Expires must be in the future");
});
