import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readProjectFile(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function parseHeadersFile(source) {
  const blocks = [];
  let current = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(rawLine)) {
      current = { pattern: line.trim(), headers: new Map() };
      blocks.push(current);
      continue;
    }
    assert.ok(current, `header without a route block: ${line}`);
    const match = line.trim().match(/^([^:]+):\s*(.*)$/);
    assert.ok(match, `invalid header line: ${line}`);
    current.headers.set(match[1], match[2]);
  }
  return blocks;
}

function routeBlock(blocks, pattern) {
  const block = blocks.find((candidate) => candidate.pattern === pattern);
  assert.ok(block, `missing _headers block for ${pattern}`);
  return block;
}

test("Cloudflare Pages headers keep SPA shell fresh and add baseline security headers", () => {
  const blocks = parseHeadersFile(readProjectFile("frontend/public/_headers"));
  const global = routeBlock(blocks, "/*");
  assert.equal(global.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(global.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(global.headers.get("X-Frame-Options"), "DENY");
  assert.equal(global.headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  assert.equal(global.headers.has("Content-Security-Policy"), false);

  const assets = routeBlock(blocks, "/assets/*");
  assert.equal(assets.headers.get("Cache-Control"), "public, max-age=31536000, immutable");

  for (const path of ["/", "/index.html", "/app", "/app/*", "/legal", "/share/*", "/invite/*"]) {
    const block = routeBlock(blocks, path);
    assert.equal(block.headers.get("Cache-Control"), "no-cache, must-revalidate, max-age=0");
  }
});

test("Cloudflare deploy workflow verifies API health and SPA deep links", () => {
  const workflow = readProjectFile(".github/workflows/deploy-pages.yml");
  assert.match(workflow, /Verify production health/);
  assert.match(workflow, /https:\/\/stimli\.pages\.dev\/api\/health/);
  assert.match(workflow, /Verify production app shell/);
  for (const secret of ["POSTGRES_URL", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY"]) {
    assert.ok(workflow.includes(secret), `missing required runtime secret check: ${secret}`);
  }
  assert.doesNotMatch(workflow, /required=\([^)]*TRIBE_INFERENCE_URL/);
  for (const path of ["/app/team", "/share/deploy-smoke", "/invite/deploy-smoke"]) {
    assert.ok(workflow.includes(path), `missing app shell smoke path: ${path}`);
  }
  assert.match(workflow, /<div id="root"/);
});

test("GitHub workflows opt into the current JavaScript action runtime", () => {
  for (const file of [".github/workflows/ci.yml", ".github/workflows/deploy-pages.yml"]) {
    const workflow = readProjectFile(file);
    assert.match(workflow, /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24:\s*true/, `${file} should opt actions into Node 24`);
    assert.doesNotMatch(workflow, /actions\/checkout@v4|actions\/setup-node@v4|actions\/setup-python@v5/);
  }
  assert.match(readProjectFile(".github/workflows/deploy-pages.yml"), /cloudflare\/wrangler-action@v4/);
});

test("Cloudflare runtime secret check matches Wrangler secret list output", () => {
  const workflow = readProjectFile(".github/workflows/deploy-pages.yml");
  assert.match(workflow, /\^\[\[:space:\]\]\*-\[\[:space:\]\]\+\$\{name\}:/);
});
