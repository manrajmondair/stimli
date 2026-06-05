import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Credential shapes this project (Stripe, Clerk, OpenRouter, Postgres, GitHub,
// Hugging Face) plus common cloud keys. Each pattern is kept specific enough not
// to match the redaction regexes that live in the source itself — `npm test`
// runs this scan against every tracked file, so a too-greedy pattern would fail
// the suite on our own code.
export const SECRET_PATTERNS = [
  { name: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { name: "OpenRouter key", regex: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Stripe secret key", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "Postgres URL with password", regex: /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i },
  { name: "Clerk secret key", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  // Hugging Face tokens gate the Modal TRIBE checkpoint download; they're the
  // one credential that lives closest to inference code and notebooks.
  { name: "Hugging Face token", regex: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { name: "AWS access key id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ }
];

// Returns one finding per matched pattern: { name, line }. Pure and exported so
// the regex set can be unit-tested without shelling out to git.
export function findSecrets(text) {
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    const match = text.match(pattern.regex);
    if (match) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      hits.push({ name: pattern.name, line });
    }
  }
  return hits;
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.startsWith("node_modules/") && !file.startsWith("frontend/dist/"));
}

function run() {
  const files = trackedFiles();
  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const hit of findSecrets(text)) {
      findings.push(`${file}:${hit.line} matched ${hit.name}`);
    }
  }

  if (findings.length) {
    console.error("Potential secrets found in tracked files:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }

  console.log(`Secret scan passed (${files.length} tracked files checked).`);
}

// Only run the scan when executed directly (npm run test:secrets), not when the
// module is imported by the test suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
