// Unit coverage for the secret-scanner regex set. The npm test:secrets script
// runs the scanner against tracked files; these tests assert the patterns
// actually catch representative credential shapes (and don't fire on clean
// text) so a future edit to the regexes can't silently weaken the guard.

import assert from "node:assert/strict";
import test from "node:test";

import { SECRET_PATTERNS, findSecrets } from "../scripts/scan-secrets.mjs";

const SAMPLES = {
  "private key": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
  "GitHub token": `ghp_${"a".repeat(36)}`,
  "OpenRouter key": `sk-or-v1-${"a".repeat(40)}`,
  "Stripe secret key": `sk_live_${"a".repeat(24)}`,
  "Postgres URL with password": "postgresql://user:s3cr3t@db.example.com/stimli",
  "Clerk secret key": `sk_test_${"b".repeat(28)}`,
  "Hugging Face token": `hf_${"c".repeat(34)}`,
  "AWS access key id": "AKIAIOSFODNN7EXAMPLE"
};

test("every secret pattern has a representative sample that it catches", () => {
  for (const { name } of SECRET_PATTERNS) {
    assert.ok(name in SAMPLES, `no sample defined for pattern: ${name}`);
    const hits = findSecrets(SAMPLES[name]);
    assert.ok(
      hits.some((hit) => hit.name === name),
      `pattern "${name}" did not match its sample`
    );
  }
});

test("clean text produces no findings", () => {
  const clean = [
    "const apiKey = process.env.OPENROUTER_API_KEY;",
    "// references HF_TOKEN and hf_hub_download without a real token",
    "Bearer <redacted> and sk-or-v1-[A-Za-z0-9_-]{8,} as a pattern literal",
    "an ordinary sentence about shipping creative."
  ].join("\n");
  assert.deepEqual(findSecrets(clean), []);
});

test("findings report the 1-based line of the match", () => {
  const withToken = `line one\nline two\nleak hf_${"d".repeat(34)} here`;
  const hfHit = findSecrets(withToken).find((hit) => hit.name === "Hugging Face token");
  assert.ok(hfHit, "expected the Hugging Face token to be detected");
  assert.equal(hfHit.line, 3);
});
