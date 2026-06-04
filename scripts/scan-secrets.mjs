import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((file) => !file.startsWith("node_modules/") && !file.startsWith("frontend/dist/"));

const patterns = [
  { name: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { name: "OpenRouter key", regex: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Stripe secret key", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "Postgres URL with password", regex: /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i },
  { name: "Clerk secret key", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ }
];

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      findings.push(`${file}:${line} matched ${pattern.name}`);
    }
  }
}

if (findings.length) {
  console.error("Potential secrets found in tracked files:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed (${files.length} tracked files checked).`);
