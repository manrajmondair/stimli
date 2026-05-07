import assert from "node:assert/strict";
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

async function call(method, url, body = null) {
  const requestBody = body ? JSON.stringify(body) : "";
  const request = Readable.from(requestBody ? [Buffer.from(requestBody)] : []);
  request.method = method;
  request.url = url;
  request.headers = requestBody ? { "content-type": "application/json" } : {};

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
