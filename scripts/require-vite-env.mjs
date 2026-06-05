import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_VITE_ENV = ["VITE_CLERK_PUBLISHABLE_KEY"];
export const VITE_ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(source) {
  const values = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

export function resolveViteEnvValue(name, { env = process.env, frontendDir = resolve(repoRoot, "frontend") } = {}) {
  if (typeof env[name] === "string" && env[name].trim()) {
    return { value: env[name].trim(), source: "environment" };
  }
  for (const file of VITE_ENV_FILES) {
    const path = resolve(frontendDir, file);
    if (!existsSync(path)) continue;
    const values = parseEnvFile(readFileSync(path, "utf8"));
    const value = values.get(name);
    if (typeof value === "string" && value.trim()) {
      return { value: value.trim(), source: `frontend/${file}` };
    }
  }
  return null;
}

export function missingRequiredViteEnv(options) {
  return REQUIRED_VITE_ENV.filter((name) => !resolveViteEnvValue(name, options));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = missingRequiredViteEnv();
  if (missing.length > 0) {
    console.error(`Missing required frontend build env: ${missing.join(", ")}`);
    console.error("Set it in the shell or in frontend/.env.production.local before deploying Pages manually.");
    process.exit(1);
  }
}
