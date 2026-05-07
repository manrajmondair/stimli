import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import handler from "../api/[...path].js";
import { nowIso } from "../api/_lib/analysis.js";
import { getTeamMember, saveSession, saveTeam, saveTeamMember, saveUser } from "../api/_lib/store.js";

test("serves health from the Vercel API", async () => {
  const response = await call("GET", "/api/health");

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.status, "ok");
});

test("allows credentialed local CORS without opening arbitrary origins", async () => {
  const local = await call("OPTIONS", "/api/health", null, { origin: "http://localhost:5173" });
  assert.equal(local.statusCode, 204);
  assert.equal(local.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(local.headers["access-control-allow-credentials"], "true");

  const blocked = await call("OPTIONS", "/api/health", null, { origin: "https://example.invalid" });
  assert.equal(blocked.statusCode, 204);
  assert.equal(blocked.headers["access-control-allow-origin"], undefined);
});

test("starts passkey registration without an authenticated session", async () => {
  const session = await call("GET", "/api/auth/session");
  assert.equal(session.statusCode, 200);
  assert.equal(session.json.authenticated, false);

  const options = await call("POST", "/api/auth/register/options", {
    email: `founder-${crypto.randomUUID().slice(0, 8)}@example.com`,
    name: "Founder",
    team_name: "Founding Team"
  });
  assert.equal(options.statusCode, 200);
  assert.ok(options.json.challenge_id);
  assert.ok(options.json.options.challenge);
  assert.equal(options.json.options.rp.name, "Stimli");
});

test("exposes billing and license status", async () => {
  const status = await call("GET", "/api/billing/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.json.current_plan.id, "research");
  assert.equal(status.json.plans.some((plan) => plan.id === "growth"), true);

  const checkout = await call("POST", "/api/billing/checkout", { plan: "growth" });
  assert.equal(checkout.statusCode, 401);
});

test("creates free team invite links and switches invited users into the team", async () => {
  const owner = await testAccount("Owner Team", "owner");
  const invited = await testAccount("Invited Default Team", "member");
  const invite = await call(
    "POST",
    "/api/teams/invites",
    { email: invited.user.email, role: "member" },
    { cookie: owner.cookie, host: "stimli.test", "x-forwarded-proto": "https" }
  );
  assert.equal(invite.statusCode, 200);
  assert.match(invite.json.url, /^https:\/\/stimli\.test\/invite\//);
  assert.equal(invite.json.team_id, owner.team.id);

  const publicInvite = await call("GET", `/api/invites/${invite.json.token}`);
  assert.equal(publicInvite.statusCode, 200);
  assert.equal(publicInvite.json.team_name, owner.team.name);

  const blocked = await call("POST", `/api/invites/${invite.json.token}/accept`);
  assert.equal(blocked.statusCode, 401);

  const accepted = await call("POST", `/api/invites/${invite.json.token}/accept`, null, { cookie: invited.cookie });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json.team.id, owner.team.id);
  assert.equal(accepted.json.teams.some((team) => team.id === owner.team.id), true);
  assert.equal(Boolean(accepted.headers["set-cookie"]), true);
  assert.equal((await getTeamMember(owner.team.id, invited.user.id)).role, "member");
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

test("calibrates predicted winners against logged outcomes", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const seeded = await call("POST", "/api/demo/seed", null, headers);
  const comparison = await call(
    "POST",
    "/api/comparisons",
    {
      asset_ids: seeded.json.slice(0, 2).map((asset) => asset.id),
      objective: "Pick the winner to calibrate."
    },
    headers
  );
  const predicted = comparison.json.recommendation.winner_asset_id;
  const other = comparison.json.variants.find((variant) => variant.asset.id !== predicted).asset.id;
  await call(
    "POST",
    `/api/comparisons/${comparison.json.id}/outcomes`,
    { asset_id: predicted, spend: 100, impressions: 10000, clicks: 500, conversions: 40, revenue: 900, notes: "" },
    headers
  );
  await call(
    "POST",
    `/api/comparisons/${comparison.json.id}/outcomes`,
    { asset_id: other, spend: 100, impressions: 10000, clicks: 200, conversions: 12, revenue: 240, notes: "" },
    headers
  );

  const summary = await call("GET", "/api/learning/summary", null, headers);
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json.calibration.evaluated_comparisons, 1);
  assert.equal(summary.json.calibration.aligned_predictions, 1);
  assert.equal(summary.json.calibration.alignment_rate, 1);
});

test("creates public share links for completed reports", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace, host: "stimli.test", "x-forwarded-proto": "https" };
  const seeded = await call("POST", "/api/demo/seed", null, headers);
  const comparison = await call(
    "POST",
    "/api/comparisons",
    { asset_ids: seeded.json.slice(0, 2).map((asset) => asset.id), objective: "Share this report." },
    headers
  );
  const share = await call("POST", `/api/reports/${comparison.json.id}/share`, null, headers);
  assert.equal(share.statusCode, 200);
  assert.match(share.json.url, /^https:\/\/stimli\.test\/share\//);
  assert.match(share.json.api_path, /^\/api\/share\//);

  const report = await call("GET", share.json.api_path);
  assert.equal(report.statusCode, 200);
  assert.equal(report.json.comparison_id, comparison.json.id);
  assert.equal(report.json.title, "Stimli Creative Decision Report");
});

test("organizes assets and comparisons by project", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const project = await call("POST", "/api/projects", { name: "Launch project" }, headers);
  assert.equal(project.statusCode, 200);

  const projects = await call("GET", "/api/projects", null, headers);
  assert.equal(projects.json.some((item) => item.id === project.json.id), true);

  const seeded = await call("POST", "/api/demo/seed", { project_id: project.json.id }, headers);
  assert.equal(seeded.json.every((asset) => asset.project_id === project.json.id), true);

  const comparison = await call(
    "POST",
    "/api/comparisons",
    {
      asset_ids: seeded.json.slice(0, 2).map((asset) => asset.id),
      objective: "Keep this decision in the launch project.",
      project_id: project.json.id
    },
    headers
  );
  assert.equal(comparison.statusCode, 200);
  assert.equal(comparison.json.project_id, project.json.id);
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

test("creates async comparisons and finalizes completed remote jobs", async () => {
  const originalFetch = globalThis.fetch;
  const previousControlUrl = process.env.TRIBE_CONTROL_URL;
  const previousApiKey = process.env.TRIBE_API_KEY;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const jobs = new Map();
  let jobIndex = 0;

  process.env.TRIBE_CONTROL_URL = "https://modal.test/control";
  process.env.TRIBE_API_KEY = "test-key";
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    if (body.action === "start") {
      jobIndex += 1;
      const job = {
        job_id: `job_${jobIndex}`,
        asset_id: body.asset.id,
        status: "queued",
        provider: "tribe-v2",
        created_at: "2026-05-06T00:00:00Z",
        updated_at: "2026-05-06T00:00:00Z"
      };
      jobs.set(job.job_id, job);
      return jsonResponse(job);
    }
    if (body.action === "status") {
      const job = jobs.get(body.job_id);
      return jsonResponse({
        ...job,
        status: "complete",
        result: {
          provider: "tribe-v2",
          timeline: [
            { second: 0, attention: 0.62, memory: 0.55, cognitive_load: 0.38, note: "Opening response" },
            { second: 3, attention: 0.78, memory: 0.71, cognitive_load: 0.44, note: "Strong middle response" },
            { second: 6, attention: 0.66, memory: 0.74, cognitive_load: 0.4, note: "Stable close" }
          ]
        }
      });
    }
    return jsonResponse({ detail: "not found" }, 404);
  };

  try {
    const project = await call("POST", "/api/projects", { name: "Async project" }, headers);
    const first = await call(
      "POST",
      "/api/assets",
      {
        asset_type: "audio",
        name: "Audio A",
        text: "Stop wasting paid media spend. Try the starter kit today.",
        project_id: project.json.id
      },
      headers
    );
    const second = await call(
      "POST",
      "/api/assets",
      { asset_type: "audio", name: "Audio B", text: "Our brand has a modern solution for everyone.", project_id: project.json.id },
      headers
    );
    const created = await call(
      "POST",
      "/api/comparisons",
      {
        asset_ids: [first.json.asset.id, second.json.asset.id],
        objective: "Pick the stronger audio ad.",
        project_id: project.json.id
      },
      headers
    );
    assert.equal(created.statusCode, 202);
    assert.equal(created.json.status, "processing");
    assert.equal(created.json.project_id, project.json.id);
    assert.equal(created.json.jobs.length, 2);

    const refreshed = await call("GET", `/api/comparisons/${created.json.id}`, null, headers);
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.json.status, "complete");
    assert.equal(refreshed.json.project_id, project.json.id);
    assert.equal(refreshed.json.variants.length, 2);
    assert.equal(refreshed.json.variants[0].analysis.provider, "tribe-remote");
    assert.ok(refreshed.json.recommendation.headline);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("TRIBE_CONTROL_URL", previousControlUrl);
    restoreEnv("TRIBE_API_KEY", previousApiKey);
  }
});

test("cancels processing comparisons and remote jobs", async () => {
  const originalFetch = globalThis.fetch;
  const previousControlUrl = process.env.TRIBE_CONTROL_URL;
  const previousApiKey = process.env.TRIBE_API_KEY;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const jobs = new Map();
  let jobIndex = 0;

  process.env.TRIBE_CONTROL_URL = "https://modal.test/control";
  process.env.TRIBE_API_KEY = "test-key";
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    if (body.action === "start") {
      jobIndex += 1;
      const job = { job_id: `cancel_job_${jobIndex}`, asset_id: body.asset.id, status: "queued", provider: "tribe-v2" };
      jobs.set(job.job_id, job);
      return jsonResponse(job);
    }
    if (body.action === "cancel") {
      const job = { ...jobs.get(body.job_id), status: "cancelled" };
      jobs.set(body.job_id, job);
      return jsonResponse(job);
    }
    return jsonResponse({ detail: "not found" }, 404);
  };

  try {
    const first = await call("POST", "/api/assets", { asset_type: "audio", name: "Cancel A", text: "Try the starter kit today." }, headers);
    const second = await call("POST", "/api/assets", { asset_type: "audio", name: "Cancel B", text: "A soft generic message." }, headers);
    const created = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [first.json.asset.id, second.json.asset.id], objective: "Cancel this comparison." },
      headers
    );
    assert.equal(created.statusCode, 202);
    const cancelled = await call("POST", `/api/comparisons/${created.json.id}/cancel`, null, headers);
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json.status, "cancelled");
    assert.equal(cancelled.json.jobs.every((job) => job.status === "cancelled"), true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("TRIBE_CONTROL_URL", previousControlUrl);
    restoreEnv("TRIBE_API_KEY", previousApiKey);
  }
});

test("rate limits comparison creation per workspace and client", async () => {
  const previousLimit = process.env.STIMLI_COMPARISON_LIMIT_PER_HOUR;
  process.env.STIMLI_COMPARISON_LIMIT_PER_HOUR = "1";
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = {
    "x-stimli-workspace": workspace,
    "x-forwarded-for": "203.0.113.42",
    "user-agent": "stimli-test"
  };

  try {
    const first = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Limit A", text: "Stop weak hooks before launch. Try the starter kit today." },
      headers
    );
    const second = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Limit B", text: "Upload creative and compare the strongest variant before spend." },
      headers
    );
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);

    const allowed = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [first.json.asset.id, second.json.asset.id], objective: "First comparison should be allowed." },
      headers
    );
    const blocked = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [first.json.asset.id, second.json.asset.id], objective: "Second comparison should be blocked." },
      headers
    );
    assert.equal(allowed.statusCode, 200);
    assert.equal(blocked.statusCode, 429);
  } finally {
    restoreEnv("STIMLI_COMPARISON_LIMIT_PER_HOUR", previousLimit);
  }
});

test("uses hosted extraction for media assets before filename fallback", async () => {
  const originalFetch = globalThis.fetch;
  const previousExtractUrl = process.env.STIMLI_EXTRACT_URL;
  const previousApiKey = process.env.TRIBE_API_KEY;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  process.env.STIMLI_EXTRACT_URL = "https://extract.test/run";
  process.env.TRIBE_API_KEY = "test-key";
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    assert.equal(body.asset.type, "image");
    return jsonResponse({
      provider: "stimli-extractor",
      text: "Save 20 percent today. Shop the starter kit.",
      segments: [{ type: "ocr", start: 0, end: 0, text: "Save 20 percent today." }],
      metadata: { extraction_status: "success", segment_count: 1 }
    });
  };

  try {
    const created = await call(
      "POST",
      "/api/assets",
      {
        asset_type: "image",
        name: "Offer Screenshot",
        blob: {
          pathname: `workspaces/${workspace}/uploads/offer.png`,
          url: "https://blob.test/offer.png",
          downloadUrl: "https://blob.test/offer.png?download=1",
          contentType: "image/png",
          size: 1234,
          original_filename: "offer.png"
        }
      },
      { "x-stimli-workspace": workspace }
    );
    assert.equal(created.statusCode, 200);
    assert.equal(created.json.asset.extracted_text, "Save 20 percent today. Shop the starter kit.");
    assert.equal(created.json.asset.metadata.extraction_status, "success");
    assert.equal(created.json.asset.metadata.extractor_provider, "stimli-extractor");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("STIMLI_EXTRACT_URL", previousExtractUrl);
    restoreEnv("TRIBE_API_KEY", previousApiKey);
  }
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

async function testAccount(teamName, role) {
  const createdAt = nowIso();
  const user = {
    id: `user_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    email: `${crypto.randomUUID().slice(0, 8)}@example.com`,
    name: role === "owner" ? "Owner" : "Member",
    created_at: createdAt
  };
  const team = {
    id: `team_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    name: teamName,
    created_at: createdAt
  };
  const token = crypto.randomBytes(32).toString("base64url");
  await saveUser(user);
  await saveTeam(team);
  await saveTeamMember({ team_id: team.id, user_id: user.id, role: "owner", created_at: createdAt });
  await saveSession({
    token_hash: crypto.createHash("sha256").update(token).digest("hex"),
    user_id: user.id,
    team_id: team.id,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_at: createdAt
  });
  return { user, team, cookie: `stimli_session=${token}` };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
