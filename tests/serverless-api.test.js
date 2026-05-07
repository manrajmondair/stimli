import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import handler from "../api/[...path].js";

test("serves health from the Vercel API", async () => {
  const response = await call("GET", "/api/health");

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.status, "ok");
});

test("seeds assets and creates a comparison", async () => {
  const seeded = await call("POST", "/api/demo/seed");
  assert.equal(seeded.statusCode, 200);
  assert.equal(seeded.json.length, 3);

  const comparison = await call("POST", "/api/comparisons", {
    asset_ids: seeded.json.slice(0, 2).map((asset) => asset.id),
    objective: "Pick the stronger paid social hook.",
    brief: {
      brand_name: "Lumina",
      audience: "busy skincare buyers",
      primary_offer: "starter kit"
    }
  });

  assert.equal(comparison.statusCode, 200);
  assert.equal(comparison.json.status, "complete");
  assert.equal(comparison.json.variants.length, 2);
  assert.ok(comparison.json.recommendation.headline);
  assert.ok(comparison.json.suggestions.length > 0);
});

test("scopes persistent objects by workspace header", async () => {
  const workspaceA = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const workspaceB = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headersA = { "x-stimli-workspace": workspaceA };
  const headersB = { "x-stimli-workspace": workspaceB };

  const first = await call(
    "POST",
    "/api/assets",
    { asset_type: "script", name: "Scoped A", text: "Stop weak hooks before launch. Try the focused starter kit today." },
    headersA
  );
  const second = await call(
    "POST",
    "/api/assets",
    { asset_type: "script", name: "Scoped B", text: "Upload creative and review the variant before paid media spend." },
    headersA
  );
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);

  const visibleToA = await call("GET", "/api/assets", null, headersA);
  const visibleToB = await call("GET", "/api/assets", null, headersB);
  assert.equal(visibleToA.json.some((asset) => asset.id === first.json.asset.id), true);
  assert.equal(visibleToB.json.some((asset) => asset.id === first.json.asset.id), false);

  const blockedComparison = await call(
    "POST",
    "/api/comparisons",
    { asset_ids: [first.json.asset.id, second.json.asset.id], objective: "Should not cross workspaces." },
    headersB
  );
  assert.equal(blockedComparison.statusCode, 404);

  const comparison = await call(
    "POST",
    "/api/comparisons",
    { asset_ids: [first.json.asset.id, second.json.asset.id], objective: "Pick the stronger scoped creative." },
    headersA
  );
  assert.equal(comparison.statusCode, 200);

  const comparisonsA = await call("GET", "/api/comparisons", null, headersA);
  const comparisonsB = await call("GET", "/api/comparisons", null, headersB);
  assert.equal(comparisonsA.json.some((item) => item.id === comparison.json.id), true);
  assert.equal(comparisonsB.json.some((item) => item.id === comparison.json.id), false);
});

async function call(method, url, body = null, headers = {}) {
  const requestBody = body ? JSON.stringify(body) : "";
  const request = Readable.from(requestBody ? [Buffer.from(requestBody)] : []);
  request.method = method;
  request.url = url;
  request.headers = requestBody ? { "content-type": "application/json", ...headers } : headers;

  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  response.headers = {};
  response.statusCode = 200;
  response.setHeader = (key, value) => {
    response.headers[key.toLowerCase()] = value;
  };
  response.end = (chunk) => {
    if (chunk) {
      chunks.push(Buffer.from(chunk));
    }
    Writable.prototype.end.call(response);
  };

  await handler(request, response);
  const text = Buffer.concat(chunks).toString("utf8");
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    text,
    json: text ? JSON.parse(text) : null
  };
}
