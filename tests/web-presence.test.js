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

test("robots.txt keeps crawlers out of the API, app, and tokened links", () => {
  const robots = readPublic("robots.txt");
  for (const path of ["/api/", "/app", "/share/", "/invite/"]) {
    assert.match(robots, new RegExp(`^Disallow: ${path.replace(/[/]/g, "\\/")}\\s*$`, "m"), `expected Disallow ${path}`);
  }
  assert.match(robots, /^Sitemap: https:\/\/stimli\.pages\.dev\/sitemap\.xml\s*$/m);
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
  }
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
