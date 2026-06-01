// Tests for the Cloudflare Pages Function that backs the Stimli API.
//
// The function exports onRequest({ request, env, ... }) and reads its
// configuration from `env` (passed in by the Pages runtime). In tests we drive
// it with a Web Request and a plain `testEnv` object that we mutate per test
// to exercise env-dependent code paths (rate limits, async TRIBE jobs, hosted
// extraction, etc.).
//
// Storage uses the module-level memory fallback in functions/api/_lib/store.js
// (no POSTGRES_URL is set), so the suite never touches a real database.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { onRequest } from "../functions/api/[[path]].js";
import { nowIso, resetRemoteBrainHealth } from "../functions/api/_lib/analysis.js";
import {
  configureStore,
  getTeamMember,
  getUser,
  getUserByEmail,
  rebindUserId,
  saveTeam,
  saveTeamMember,
  saveUser
} from "../functions/api/_lib/store.js";

const testEnv = {
  STIMLI_RP_ID: "stimli.test",
  STIMLI_ORIGIN: "https://stimli.test",
  STIMLI_APP_URL: "https://stimli.test",
  // STIMLI_TEST_MODE turns on the test-only auth bypass in functions/api/_lib/auth.js
  // so we can drive multi-role scenarios via an X-Stimli-Test-User header.
  STIMLI_TEST_MODE: "1"
};

// Activate memory-mode storage for direct calls to saveUser / saveTeam etc.
configureStore(testEnv);

test("serves health from the Pages API", async () => {
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

test("rebindUserId migrates a legacy user row onto a new id and cascades memberships", async () => {
  // Reproduces the regression where ensureStimliUser would INSERT a new row
  // for a Clerk id while a legacy row with the same email already existed,
  // tripping stimli_users_email_key. The fix is to rebind the legacy row
  // in place — this test pins that behavior.
  const legacyId = `legacy_${crypto.randomUUID().slice(0, 8)}`;
  const newId = `user_${crypto.randomUUID().slice(0, 8)}`;
  const email = `${crypto.randomUUID().slice(0, 8)}@migration.test`;
  const team = {
    id: `team_${crypto.randomUUID().slice(0, 8)}`,
    name: "Migration Team",
    created_at: nowIso()
  };

  await saveUser({ id: legacyId, email, name: "Legacy Name", created_at: nowIso() });
  await saveTeam(team);
  await saveTeamMember({ team_id: team.id, user_id: legacyId, role: "owner", created_at: nowIso() });

  const migrated = await rebindUserId(legacyId, newId, { name: "Clerk Name" });
  assert.ok(migrated);
  assert.equal(migrated.id, newId);
  assert.equal(migrated.email, email);
  assert.equal(migrated.name, "Clerk Name");

  // Old id no longer resolves.
  assert.equal(await getUser(legacyId), null);
  // New id resolves to the rebound user.
  const fetched = await getUser(newId);
  assert.equal(fetched?.email, email);
  // Email still unique — getUserByEmail finds exactly the new row.
  const byEmail = await getUserByEmail(email);
  assert.equal(byEmail?.id, newId);
  // Membership cascaded.
  const member = await getTeamMember(team.id, newId);
  assert.equal(member?.role, "owner");
  const orphan = await getTeamMember(team.id, legacyId);
  assert.equal(orphan, null);
});

test("returns an anonymous session without a Clerk JWT", async () => {
  const session = await call("GET", "/api/auth/session");
  assert.equal(session.statusCode, 200);
  assert.equal(session.json.authenticated, false);
  assert.equal(session.json.user, null);
  assert.equal(session.json.team, null);
});

test("synthesizes a test-mode session from the X-Stimli-Test-User header", async () => {
  const account = await testAccount("Synth Test Team", "owner");
  const session = await call("GET", "/api/auth/session", null, { cookie: account.cookie });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json.authenticated, true);
  assert.equal(session.json.user.id, account.user.id);
  assert.equal(session.json.team.id, account.team.id);
});

test("exposes billing and license status", async () => {
  const status = await call("GET", "/api/billing/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.json.current_plan.id, "research");
  assert.equal(status.json.plans.some((plan) => plan.id === "growth"), true);

  const checkout = await call("POST", "/api/billing/checkout", { plan: "growth" });
  assert.equal(checkout.statusCode, 401);
});

test("billing catalog exposes monthly quotas, seats, prices, and features", async () => {
  const status = await call("GET", "/api/billing/status");
  assert.equal(status.statusCode, 200);
  const plans = status.json.plans;
  const research = plans.find((p) => p.id === "research");
  const growth = plans.find((p) => p.id === "growth");
  const scale = plans.find((p) => p.id === "scale");
  for (const plan of [research, growth, scale]) {
    assert.ok(plan, `missing plan: ${plan?.id}`);
    assert.ok(Number.isFinite(plan.comparison_limit_per_month), `${plan.id} missing comparison_limit_per_month`);
    assert.ok(Number.isFinite(plan.asset_limit_per_month), `${plan.id} missing asset_limit_per_month`);
    assert.ok(Number.isFinite(plan.seats), `${plan.id} missing seats`);
    assert.ok(Array.isArray(plan.features), `${plan.id} missing features`);
  }
  // Free tier should price at $0; paid tiers should be > $0.
  assert.equal(research.price_cents_monthly, 0);
  assert.ok(growth.price_cents_monthly > 0);
  assert.ok(scale.price_cents_monthly > growth.price_cents_monthly);
  // Quotas should scale up by tier.
  assert.ok(growth.comparison_limit_per_month > research.comparison_limit_per_month);
  assert.ok(scale.comparison_limit_per_month > growth.comparison_limit_per_month);
});

test("billing usage exposes both hourly and monthly buckets with a reset window", async () => {
  const account = await testAccount("Usage Window Team", "owner");
  const response = await call("GET", "/api/billing/usage", null, { cookie: account.cookie });
  assert.equal(response.statusCode, 200);
  assert.ok(response.json.limits, "missing hourly limits");
  assert.ok(response.json.monthly_limits, "missing monthly limits");
  assert.ok(response.json.monthly_usage, "missing monthly usage");
  assert.ok(response.json.period?.start, "missing period.start");
  assert.ok(response.json.period?.end, "missing period.end");
  assert.equal(response.json.plan.id, "research");
  assert.equal(typeof response.json.monthly_limits.comparison, "number");
  assert.equal(typeof response.json.monthly_usage.comparison, "number");
});

test("returns a structured 402 with quota_exceeded when the monthly cap is reached", async () => {
  // Squeeze the monthly comparison quota down to 1 so a single comparison
  // exhausts it and the second one trips the 402 path. Keep the hourly limit
  // high so we hit the monthly check, not the hourly one.
  withEnv({
    STIMLI_RESEARCH_COMPARISON_LIMIT_PER_MONTH: "1",
    STIMLI_RESEARCH_COMPARISON_LIMIT_PER_HOUR: "100"
  });
  const account = await testAccount("Quota Team", "owner");
  const headers = {
    cookie: account.cookie,
    "x-forwarded-for": "198.51.100.10",
    "user-agent": "stimli-quota-test"
  };
  try {
    const assetA = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Quota A", text: "Stop weak hooks before launch. Try the starter kit today." },
      headers
    );
    const assetB = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Quota B", text: "Upload creative and compare the strongest variant before spend." },
      headers
    );
    assert.equal(assetA.statusCode, 200);
    assert.equal(assetB.statusCode, 200);

    const first = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [assetA.json.asset.id, assetB.json.asset.id], objective: "First should pass." },
      headers
    );
    assert.equal(first.statusCode, 200);

    const blocked = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [assetA.json.asset.id, assetB.json.asset.id], objective: "Should be quota-blocked." },
      headers
    );
    assert.equal(blocked.statusCode, 402);
    assert.equal(blocked.json.code, "quota_exceeded");
    assert.equal(blocked.json.details.kind, "comparison");
    assert.equal(blocked.json.details.limit, 1);
    assert.equal(blocked.json.details.plan, "research");
    assert.ok(blocked.json.details.reset_at, "expected a reset_at timestamp");
    assert.ok(blocked.json.details.upgrade_url, "expected an upgrade_url");
  } finally {
    withEnv({
      STIMLI_RESEARCH_COMPARISON_LIMIT_PER_MONTH: undefined,
      STIMLI_RESEARCH_COMPARISON_LIMIT_PER_HOUR: undefined
    });
  }
});

test("enforces plan seat limits when creating team invites", async () => {
  // Force Research down to a single seat so an owner alone fills the plan and
  // the first invite is blocked with a structured 402.
  withEnv({ STIMLI_RESEARCH_SEATS: "1" });
  const owner = await testAccount("Seat Limit Team", "owner");
  try {
    const blocked = await call(
      "POST",
      "/api/teams/invites",
      { email: "second-seat@example.com", role: "analyst" },
      { cookie: owner.cookie }
    );
    assert.equal(blocked.statusCode, 402);
    assert.equal(blocked.json.code, "seat_limit_reached");
    assert.equal(blocked.json.details.kind, "seat");
    assert.equal(blocked.json.details.limit, 1);
    assert.equal(blocked.json.details.plan, "research");
  } finally {
    withEnv({ STIMLI_RESEARCH_SEATS: undefined });
  }
});

test("billing webhook short-circuits on a replayed Stripe event id", async () => {
  // We don't run real Stripe signature verification in tests (no secret key),
  // so this test exercises the idempotency store directly: writing the same
  // event id twice returns false on the second insert so the webhook handler
  // can safely no-op on retries.
  const { recordBillingEvent } = await import("../functions/api/_lib/store.js");
  const event = {
    id: `evt_${crypto.randomUUID().slice(0, 12)}`,
    type: "customer.subscription.updated",
    team_id: "team_test",
    payload: { livemode: false },
    created_at: nowIso()
  };
  const first = await recordBillingEvent(event);
  const second = await recordBillingEvent(event);
  assert.equal(first, true, "first insert should record the event");
  assert.equal(second, false, "replayed event should be ignored");
});

test("releasing a billing event claim lets the same event be reprocessed", async () => {
  // When webhook processing fails after the idempotency claim, the handler
  // deletes the claim so Stripe's retry reprocesses instead of being dropped.
  const { recordBillingEvent, deleteBillingEvent } = await import("../functions/api/_lib/store.js");
  const event = {
    id: `evt_${crypto.randomUUID().slice(0, 12)}`,
    type: "customer.subscription.updated",
    team_id: "team_test",
    payload: { livemode: false },
    created_at: nowIso()
  };
  assert.equal(await recordBillingEvent(event), true, "first claim succeeds");
  assert.equal(await recordBillingEvent(event), false, "still claimed on retry");
  assert.equal(await deleteBillingEvent(event.id), true, "claim released after failed processing");
  assert.equal(await recordBillingEvent(event), true, "retry can reclaim and reprocess");
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
  // Clerk owns the session cookie now; the API no longer issues its own.
  assert.equal((await getTeamMember(owner.team.id, invited.user.id)).role, "analyst");
});

test("enforces granular team roles for workspace writes", async () => {
  const owner = await testAccount("Role Owner Team", "owner");
  const viewer = await testAccount("Viewer Default Team", "viewer");
  await saveTeamMember({
    team_id: owner.team.id,
    user_id: viewer.user.id,
    role: "viewer",
    created_at: nowIso()
  });
  const viewerCookie = await sessionCookie(viewer.user.id, owner.team.id);

  const blocked = await call(
    "POST",
    "/api/assets",
    { asset_type: "script", name: "Viewer write", text: "Try the starter kit today." },
    { cookie: viewerCookie }
  );
  assert.equal(blocked.statusCode, 403);

  const analyst = await testAccount("Analyst Default Team", "analyst");
  await saveTeamMember({
    team_id: owner.team.id,
    user_id: analyst.user.id,
    role: "analyst",
    created_at: nowIso()
  });
  const analystCookie = await sessionCookie(analyst.user.id, owner.team.id);
  const allowed = await call(
    "POST",
    "/api/assets",
    { asset_type: "script", name: "Analyst write", text: "Stop weak hooks before launch. Try the starter kit today." },
    { cookie: analystCookie }
  );
  assert.equal(allowed.statusCode, 200);
});

test("a multi-team member can act on a selected team and is scoped to it", async () => {
  // Build a user who owns their personal team AND is an analyst on a second
  // team, then drive the production team-selection headers (X-Stimli-Team and a
  // team_* X-Stimli-Workspace) to confirm the active team — and its role — are
  // resolved from the selection, not pinned to the personal team.
  const teamB = await testAccount("Shared Team B", "owner");
  const user = await testAccount("Multi Team Member", "owner");
  await saveTeamMember({ team_id: teamB.team.id, user_id: user.user.id, role: "analyst", created_at: nowIso() });

  // Acting on the personal team (no selection header).
  const personalAsset = await call(
    "POST",
    "/api/assets",
    { asset_type: "script", name: "Personal asset", text: "Stop weak hooks before launch. Try the starter kit today." },
    { cookie: user.cookie }
  );
  assert.equal(personalAsset.statusCode, 200);

  // Acting on team B via the dedicated X-Stimli-Team header (analyst can write).
  const teamBAsset = await call(
    "POST",
    "/api/assets",
    { asset_type: "script", name: "Team B asset", text: "Upload creative and review the variant before paid media spend." },
    { cookie: user.cookie, "x-stimli-team": teamB.team.id }
  );
  assert.equal(teamBAsset.statusCode, 200);

  // Scoping: team B's view sees the team B asset, not the personal one.
  const teamBView = await call("GET", "/api/assets", null, { cookie: user.cookie, "x-stimli-team": teamB.team.id });
  assert.equal(teamBView.json.some((a) => a.id === teamBAsset.json.asset.id), true);
  assert.equal(teamBView.json.some((a) => a.id === personalAsset.json.asset.id), false);

  // The team_* X-Stimli-Workspace header resolves the same way.
  const viaWorkspaceHeader = await call("GET", "/api/assets", null, {
    cookie: user.cookie,
    "x-stimli-workspace": teamB.team.id
  });
  assert.equal(viaWorkspaceHeader.json.some((a) => a.id === teamBAsset.json.asset.id), true);

  // Role is resolved from the selected team: analyst on B cannot manage members.
  const blockedManage = await call("GET", "/api/teams/members", null, {
    cookie: user.cookie,
    "x-stimli-team": teamB.team.id
  });
  assert.equal(blockedManage.statusCode, 403);

  // Selecting a team the user does NOT belong to falls back to the personal team.
  const intruderTeam = `team_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const fallback = await call("GET", "/api/assets", null, { cookie: user.cookie, "x-stimli-team": intruderTeam });
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.json.some((a) => a.id === personalAsset.json.asset.id), true);
  assert.equal(fallback.json.some((a) => a.id === teamBAsset.json.asset.id), false);
});

test("blocks demoting the team's last owner via a role change", async () => {
  const owner = await testAccount("Last Owner Team", "owner");
  // An admin has members:manage but is not an owner, so they could otherwise
  // demote the sole owner and leave the team with none.
  const admin = await testAccount("Admin Default Team", "admin");
  await saveTeamMember({ team_id: owner.team.id, user_id: admin.user.id, role: "admin", created_at: nowIso() });
  const adminCookie = await sessionCookie(admin.user.id, owner.team.id);

  const blocked = await call(
    "PATCH",
    `/api/teams/members/${owner.user.id}/role`,
    { role: "viewer" },
    { cookie: adminCookie }
  );
  assert.equal(blocked.statusCode, 409);
  // The owner keeps their role.
  assert.equal((await getTeamMember(owner.team.id, owner.user.id)).role, "owner");
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

  // Every suggestion must be grounded in a measured dimension, not just a
  // free-text 'target' that the frontend has to guess about.
  const knownScoreKeys = new Set([
    "hook",
    "clarity",
    "cta",
    "brand_cue",
    "pacing",
    "offer_strength",
    "audience_fit",
    "neural_attention",
    "memory",
    "cognitive_load"
  ]);
  const knownTargetKinds = new Set([
    "hook",
    "cta",
    "brand",
    "offer",
    "clarity",
    "load",
    "pacing",
    "audience",
    "memory"
  ]);
  for (const suggestion of comparison.json.suggestions) {
    assert.ok(suggestion.score_key, "suggestion is missing score_key");
    assert.ok(
      knownScoreKeys.has(suggestion.score_key),
      `unexpected score_key ${suggestion.score_key}`
    );
    assert.ok(suggestion.target_kind, "suggestion is missing target_kind");
    assert.ok(
      knownTargetKinds.has(suggestion.target_kind),
      `unexpected target_kind ${suggestion.target_kind}`
    );
    assert.equal(typeof suggestion.expected_lift, "number");
    assert.ok(suggestion.expected_lift >= 0);
    assert.equal(typeof suggestion.dimension_score, "number");
    // evidence_window may be null for legacy paths but the heuristic timeline
    // always has at least 3 points, so we expect one here.
    assert.ok(
      suggestion.evidence_window,
      `suggestion ${suggestion.score_key} is missing evidence_window`
    );
    assert.ok(suggestion.evidence_window.end_s >= suggestion.evidence_window.start_s);
    assert.ok(["attention", "memory", "cognitive_load"].includes(suggestion.evidence_window.channel));
  }

  // The merged list must be sorted winner-first; the first suggestion
  // should be about the variant we are actually recommending.
  const winnerId = comparison.json.recommendation.winner_asset_id;
  assert.ok(winnerId, "expected a winning variant");
  assert.equal(
    comparison.json.suggestions[0].asset_id,
    winnerId,
    "expected the first edit to target the winning variant"
  );
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

test("rejects anonymous access to a team-scoped workspace via the header", async () => {
  // An anonymous request (no session) must not be able to target another
  // tenant's data by setting X-Stimli-Workspace to a team id.
  const teamWorkspace = `team_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const read = await call("GET", "/api/assets", null, { "x-stimli-workspace": teamWorkspace });
  assert.equal(read.statusCode, 403);
  const write = await call(
    "POST",
    "/api/assets",
    { asset_type: "script", name: "Intruder", text: "Trying to write into a team workspace anonymously." },
    { "x-stimli-workspace": teamWorkspace }
  );
  assert.equal(write.statusCode, 403);
  // A normal anonymous ws_* workspace still works.
  const ok = await call("GET", "/api/assets", null, {
    "x-stimli-workspace": `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
  });
  assert.equal(ok.statusCode, 200);
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
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const jobs = new Map();
  let jobIndex = 0;

  withEnv({ TRIBE_CONTROL_URL: "https://modal.test/control", TRIBE_API_KEY: "test-key" });
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
    withEnv({ TRIBE_CONTROL_URL: undefined, TRIBE_API_KEY: undefined });
  }
});

test("text comparison stays synchronous and completes when the hosted brain is configured but unreachable", async () => {
  // Reproduces the production "Request failed" bug: with STIMLI_BRAIN_PROVIDER=
  // tribe-remote and the TRIBE URLs configured, every text comparison (the demo
  // set) used to be forced through the Modal job queue and 500 when Modal was
  // cold. Text must now run inline and degrade to the heuristic instead.
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  let inferenceCalls = 0;
  let controlCalls = 0;

  // Start from a clean failure ring so the inline circuit breaker is closed and
  // both variants actually probe the (stubbed-failing) inference endpoint.
  resetRemoteBrainHealth();
  withEnv({
    STIMLI_BRAIN_PROVIDER: "tribe-remote",
    TRIBE_CONTROL_URL: "https://modal.test/control",
    TRIBE_INFERENCE_URL: "https://modal.test/inference",
    TRIBE_API_KEY: "test-key"
  });
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/inference")) {
      inferenceCalls += 1;
      return new Response("upstream down", { status: 503 });
    }
    if (target.includes("/control")) {
      controlCalls += 1;
      return new Response("upstream down", { status: 503 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const seeded = await call("POST", "/api/demo/seed", null, headers);
    assert.equal(seeded.statusCode, 200);
    const comparison = await call(
      "POST",
      "/api/comparisons",
      {
        asset_ids: seeded.json.slice(0, 2).map((asset) => asset.id),
        objective: "Demo run with a dead Modal endpoint."
      },
      headers
    );
    // The whole point: no 500, no "Request failed".
    assert.equal(comparison.statusCode, 200);
    assert.equal(comparison.json.status, "complete");
    assert.equal(comparison.json.variants.length, 2);
    assert.ok(comparison.json.recommendation.headline);
    // Text never touches the async control plane; it tries inference inline and
    // falls back to the deterministic heuristic when that 503s.
    assert.equal(controlCalls, 0);
    assert.ok(inferenceCalls >= 2, "expected inline inference attempts for each variant");
    for (const variant of comparison.json.variants) {
      assert.equal(variant.analysis.provider, "web-heuristic-brain");
    }
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({
      STIMLI_BRAIN_PROVIDER: undefined,
      TRIBE_CONTROL_URL: undefined,
      TRIBE_INFERENCE_URL: undefined,
      TRIBE_API_KEY: undefined
    });
  }
});

test("async job that completes with no timeline degrades to the heuristic instead of 500", async () => {
  // A Modal job can report status:"complete" with an empty/garbled timeline.
  // That must not reject the whole comparison's Promise.all with an opaque 500.
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const jobs = new Map();
  let jobIndex = 0;

  resetRemoteBrainHealth();
  withEnv({ TRIBE_CONTROL_URL: "https://modal.test/control", TRIBE_API_KEY: "test-key" });
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    if (body.action === "start") {
      jobIndex += 1;
      const job = { job_id: `empty_job_${jobIndex}`, asset_id: body.asset.id, status: "queued", provider: "tribe-v2" };
      jobs.set(job.job_id, job);
      return jsonResponse(job);
    }
    if (body.action === "status") {
      // "complete" but with an empty timeline — the degenerate case.
      return jsonResponse({ ...jobs.get(body.job_id), status: "complete", result: { provider: "tribe-v2", timeline: [] } });
    }
    return jsonResponse({ detail: "not found" }, 404);
  };

  try {
    const first = await call("POST", "/api/assets", { asset_type: "audio", name: "Audio A", text: "Stop wasting spend." }, headers);
    const second = await call("POST", "/api/assets", { asset_type: "audio", name: "Audio B", text: "A modern solution." }, headers);
    const created = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [first.json.asset.id, second.json.asset.id], objective: "Empty timeline job." },
      headers
    );
    assert.equal(created.statusCode, 202);
    const refreshed = await call("GET", `/api/comparisons/${created.json.id}`, null, headers);
    // No 500: the comparison finalizes via the heuristic.
    assert.equal(refreshed.statusCode, 200);
    assert.equal(refreshed.json.status, "complete");
    assert.equal(refreshed.json.variants.length, 2);
    for (const variant of refreshed.json.variants) {
      assert.equal(variant.analysis.provider, "web-heuristic-brain");
      assert.ok(variant.analysis.timeline.length >= 3, "heuristic timeline should backfill the empty job result");
    }
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({ TRIBE_CONTROL_URL: undefined, TRIBE_API_KEY: undefined });
  }
});

test("async media enqueue failure falls back to a synchronous comparison instead of 500", async () => {
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };

  // Control plane is configured but rejects every enqueue (cold Modal app).
  withEnv({ TRIBE_CONTROL_URL: "https://modal.test/control", TRIBE_API_KEY: "test-key" });
  globalThis.fetch = async () => new Response("scaled to zero", { status: 503 });

  try {
    const first = await call(
      "POST",
      "/api/assets",
      { asset_type: "audio", name: "Audio A", text: "Stop wasting paid media spend. Try the starter kit today." },
      headers
    );
    const second = await call(
      "POST",
      "/api/assets",
      { asset_type: "audio", name: "Audio B", text: "Our brand has a modern solution for everyone." },
      headers
    );
    const created = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [first.json.asset.id, second.json.asset.id], objective: "Pick the stronger audio ad." },
      headers
    );
    // Falls back to an inline heuristic comparison — a degraded but real result.
    assert.equal(created.statusCode, 200);
    assert.equal(created.json.status, "complete");
    assert.equal(created.json.variants.length, 2);
    assert.ok(created.json.recommendation.winner_asset_id);
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({ TRIBE_CONTROL_URL: undefined, TRIBE_API_KEY: undefined });
  }
});

test("brain provider health reports degraded after repeated remote inference failures", async () => {
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };

  resetRemoteBrainHealth();
  withEnv({
    STIMLI_BRAIN_PROVIDER: "tribe-remote",
    TRIBE_INFERENCE_URL: "https://modal.test/inference",
    TRIBE_API_KEY: "test-key"
  });
  globalThis.fetch = async () => new Response("upstream down", { status: 503 });

  try {
    const seeded = await call("POST", "/api/demo/seed", null, headers);
    await call(
      "POST",
      "/api/comparisons",
      { asset_ids: seeded.json.slice(0, 2).map((asset) => asset.id), objective: "Trigger inference failures." },
      headers
    );
    const providers = await call("GET", "/api/brain/providers");
    assert.equal(providers.statusCode, 200);
    const tribe = providers.json.find((p) => p.provider === "tribe-remote");
    assert.ok(tribe, "tribe-remote provider missing from health");
    assert.equal(tribe.available, true);
    assert.equal(tribe.active, false, "tribe-remote should report degraded after failures");
    assert.ok(tribe.recent_errors.count_last_60s >= 2, "recent inference failures should be tracked");
    const heuristic = providers.json.find((p) => p.provider === "web-heuristic-brain");
    assert.equal(heuristic.active, true, "heuristic should be the active brain while remote is degraded");
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({ STIMLI_BRAIN_PROVIDER: undefined, TRIBE_INFERENCE_URL: undefined, TRIBE_API_KEY: undefined });
  }
});

test("cancels processing comparisons and remote jobs", async () => {
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const jobs = new Map();
  let jobIndex = 0;

  withEnv({ TRIBE_CONTROL_URL: "https://modal.test/control", TRIBE_API_KEY: "test-key" });
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
    withEnv({ TRIBE_CONTROL_URL: undefined, TRIBE_API_KEY: undefined });
  }
});

test("rate limits comparison creation per workspace and client", async () => {
  withEnv({ STIMLI_COMPARISON_LIMIT_PER_HOUR: "1" });
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
    withEnv({ STIMLI_COMPARISON_LIMIT_PER_HOUR: undefined });
  }
});

test("uses hosted extraction for media assets before filename fallback", async () => {
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  withEnv({ STIMLI_EXTRACT_URL: "https://extract.test/run", TRIBE_API_KEY: "test-key" });
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
    withEnv({ STIMLI_EXTRACT_URL: undefined, TRIBE_API_KEY: undefined });
  }
});

test("exposes enterprise controls for brands, governance, validation, imports, and audit", async () => {
  const owner = await testAccount("Enterprise Team", "owner");
  const headers = { cookie: owner.cookie };
  const brand = await call(
    "POST",
    "/api/brand-profiles",
    {
      name: "Lumina",
      brief: {
        brand_name: "Lumina",
        audience: "busy skincare buyers",
        product_category: "hydration kit",
        primary_offer: "starter kit",
        required_claims: ["24 hour hydration"],
        forbidden_terms: ["miracle cure"]
      },
      voice_rules: ["specific before abstract"]
    },
    headers
  );
  assert.equal(brand.statusCode, 200);
  assert.equal(brand.json.brief.brand_name, "Lumina");

  const imported = await call(
    "POST",
    "/api/imports",
    {
      platform: "meta",
      source: "csv",
      items: [
        { asset_type: "script", name: "Import A", text: "Stop dry skin by lunch. Try the starter kit today." },
        { asset_type: "script", name: "Import B", text: "Our product is a modern ecosystem for everyone." }
      ]
    },
    headers
  );
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json.job.status, "complete");
  assert.equal(imported.json.assets.length, 2);

  const comparison = await call(
    "POST",
    "/api/comparisons",
    {
      asset_ids: imported.json.assets.map((asset) => asset.id),
      objective: "Use the saved brand profile.",
      brand_profile_id: brand.json.id
    },
    headers
  );
  assert.equal(comparison.statusCode, 200);
  assert.equal(comparison.json.brief.brand_name, "Lumina");
  assert.equal(comparison.json.brand_profile_id, brand.json.id);

  const library = await call("GET", "/api/library/assets", null, headers);
  assert.equal(library.statusCode, 200);
  assert.equal(library.json.total >= 2, true);

  const deletion = await call(
    "POST",
    "/api/governance/deletion-requests",
    { target_type: "asset", target_id: imported.json.assets[0].id, reason: "Customer removal request" },
    headers
  );
  assert.equal(deletion.statusCode, 200);
  assert.equal(deletion.json.status, "pending_review");

  const benchmark = await call("POST", "/api/validation/benchmarks/run", { benchmark_id: "dtc-hooks-v1" }, headers);
  assert.equal(benchmark.statusCode, 200);
  assert.equal(benchmark.json.case_count, 3);

  const admin = await call("GET", "/api/admin/summary", null, headers);
  assert.equal(admin.statusCode, 200);
  assert.equal(admin.json.inference.control_configured, false);

  const exported = await call("GET", "/api/governance/export", null, headers);
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.json.brand_profiles.some((profile) => profile.id === brand.json.id), true);
  assert.equal(exported.json.governance_requests.some((item) => item.id === deletion.json.id), true);

  const audit = await call("GET", "/api/audit/events", null, headers);
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json.some((event) => event.action === "brand_profile.created"), true);
  assert.equal(audit.json.some((event) => event.action === "validation.benchmark_run"), true);
});

test("deletes an asset and removes it from the library listing", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const created = await call(
    "POST",
    "/api/assets",
    { asset_type: "script", name: "Soon to delete", text: "Stop weak hooks before launch. Try the starter kit today." },
    headers
  );
  assert.equal(created.statusCode, 200);
  const before = await call("GET", "/api/assets", null, headers);
  assert.equal(before.json.some((a) => a.id === created.json.asset.id), true);

  const removed = await call("DELETE", `/api/assets/${created.json.asset.id}`, null, headers);
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json.deleted, created.json.asset.id);

  const after = await call("GET", "/api/assets", null, headers);
  assert.equal(after.json.some((a) => a.id === created.json.asset.id), false);

  const notFound = await call("DELETE", `/api/assets/${created.json.asset.id}`, null, headers);
  assert.equal(notFound.statusCode, 404);
});

test("deletes a brand profile", async () => {
  const owner = await testAccount("Brand Delete Team", "owner");
  const headers = { cookie: owner.cookie };
  const profile = await call(
    "POST",
    "/api/brand-profiles",
    {
      name: "Disposable",
      brief: { brand_name: "Disposable", audience: "test", product_category: "demo", primary_offer: "test" }
    },
    headers
  );
  assert.equal(profile.statusCode, 200);
  const removed = await call("DELETE", `/api/brand-profiles/${profile.json.id}`, null, headers);
  assert.equal(removed.statusCode, 200);
  const list = await call("GET", "/api/brand-profiles", null, headers);
  assert.equal(list.json.some((p) => p.id === profile.json.id), false);
});

test("revokes an unaccepted invite", async () => {
  const owner = await testAccount("Revoke Team", "owner");
  const headers = { cookie: owner.cookie, host: "stimli.test", "x-forwarded-proto": "https" };
  const invite = await call("POST", "/api/teams/invites", { email: "newhire@example.com", role: "analyst" }, headers);
  assert.equal(invite.statusCode, 200);

  const revoked = await call("DELETE", `/api/teams/invites/${invite.json.id}`, null, headers);
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json.revoked, invite.json.id);

  // Looking up the token should now fail.
  const lookup = await call("GET", `/api/invites/${invite.json.token}`);
  assert.equal(lookup.statusCode, 404);
});

test("removes a team member but blocks self-removal and last-owner removal", async () => {
  const owner = await testAccount("Remove Team", "owner");
  const member = await testAccount("Member Default Team", "analyst");
  await saveTeamMember({
    team_id: owner.team.id,
    user_id: member.user.id,
    role: "analyst",
    created_at: nowIso()
  });
  const ownerHeaders = { cookie: owner.cookie };

  // Can't remove yourself
  const selfRemoval = await call("DELETE", `/api/teams/members/${owner.user.id}`, null, ownerHeaders);
  assert.equal(selfRemoval.statusCode, 400);

  // Remove the member
  const removeOther = await call("DELETE", `/api/teams/members/${member.user.id}`, null, ownerHeaders);
  assert.equal(removeOther.statusCode, 200);

  // Removing already-gone member is 404
  const notFound = await call("DELETE", `/api/teams/members/${member.user.id}`, null, ownerHeaders);
  assert.equal(notFound.statusCode, 404);
});

test("/api/outcomes returns workspace-wide outcomes joined with comparison + asset", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const seeded = await call("POST", "/api/demo/seed", null, headers);
  const cmp = await call(
    "POST",
    "/api/comparisons",
    { asset_ids: seeded.json.slice(0, 2).map((a) => a.id), objective: "outcome listing" },
    headers
  );
  const winner = cmp.json.recommendation.winner_asset_id;
  await call(
    "POST",
    `/api/comparisons/${cmp.json.id}/outcomes`,
    { asset_id: winner, spend: 150, impressions: 12000, clicks: 600, conversions: 30, revenue: 1200 },
    headers
  );

  const list = await call("GET", "/api/outcomes", null, headers);
  assert.equal(list.statusCode, 200);
  assert.equal(Array.isArray(list.json), true);
  assert.equal(list.json.length >= 1, true);
  const row = list.json.find((r) => r.asset_id === winner);
  assert.ok(row, "winner outcome row present");
  assert.equal(row.comparison_id, cmp.json.id);
  assert.equal(row.profit, 1050);
  assert.ok(row.asset_name, "asset_name joined in");
});

test("retries failed hosted inference jobs from admin controls", async () => {
  const originalFetch = globalThis.fetch;
  const owner = await testAccount("Retry Team", "owner");
  const headers = { cookie: owner.cookie };
  const jobs = new Map();
  let jobIndex = 0;

  withEnv({ TRIBE_CONTROL_URL: "https://modal.test/control", TRIBE_API_KEY: "test-key" });
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    if (body.action === "start") {
      jobIndex += 1;
      const job = { job_id: `retry_job_${jobIndex}`, asset_id: body.asset.id, status: "queued", provider: "tribe-v2" };
      jobs.set(job.job_id, job);
      return jsonResponse(job);
    }
    if (body.action === "status") {
      const job = jobs.get(body.job_id);
      return jsonResponse({ ...job, status: "failed", error: "GPU worker failed" });
    }
    return jsonResponse({ detail: "not found" }, 404);
  };

  try {
    const first = await call("POST", "/api/assets", { asset_type: "audio", name: "Retry A", text: "Try the starter kit today." }, headers);
    const second = await call("POST", "/api/assets", { asset_type: "audio", name: "Retry B", text: "A generic message." }, headers);
    const created = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [first.json.asset.id, second.json.asset.id], objective: "Retry this comparison." },
      headers
    );
    assert.equal(created.statusCode, 202);
    const failed = await call("GET", `/api/comparisons/${created.json.id}`, null, headers);
    assert.equal(failed.json.status, "failed");

    const failedJob = failed.json.jobs[0];
    const retried = await call("POST", `/api/admin/jobs/${failedJob.job_id}/retry`, null, headers);
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json.status, "processing");
    assert.equal(retried.json.jobs.some((job) => job.previous_job_id === failedJob.job_id && job.attempt === 1), true);
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({ TRIBE_CONTROL_URL: undefined, TRIBE_API_KEY: undefined });
  }
});

test("comparison polishes edits, recommendation, and compliance when OpenRouter is enabled", async () => {
  // Drives a real comparison through onRequest with the OpenRouter copy-polish
  // path active. The actual upstream is stubbed via globalThis.fetch so the
  // test stays hermetic; what we're verifying is the wiring:
  //   • polished issue/suggested_edit/draft_revision come through on suggestions
  //   • the recommendation gets the polished headline/reasons
  //   • compliance issues from the LLM make it onto comparison.compliance
  //   • providerHealth lists the openrouter provider when active
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };

  withEnv({
    OPENROUTER_API_KEY: "test-openrouter-key",
    STIMLI_LLM_MODEL: "anthropic/claude-haiku-4.5",
    STIMLI_LLM_TIMEOUT_MS: "5000"
  });

  let editCallCount = 0;
  let reasonsCalled = false;
  let complianceCalled = false;
  globalThis.fetch = async (url, options = {}) => {
    if (typeof url !== "string" || !url.includes("openrouter.ai")) {
      return new Response(JSON.stringify({ detail: "not stubbed" }), { status: 404 });
    }
    const body = JSON.parse(String(options.body || "{}"));
    const userMsg = body.messages?.[1]?.content || "";
    // copy_llm wraps the user JSON in <input>…</input> for anti-injection;
    // peel it off (with a graceful fallback to the legacy unwrapped shape).
    const userJsonText = userMsg.match(/<input>\n([\s\S]*?)\n<\/input>/)?.[1]
      ?? userMsg.split("\n\nRespond with strict JSON")[0];
    if (userMsg.includes("\"template_issue\"") || userMsg.includes("template_issue")) {
      editCallCount += 1;
      // The user payload contains a list of templated edits; echo them back as polished.
      const payload = JSON.parse(userJsonText);
      const polishedEdits = (payload.edits || []).map((edit) => ({
        score_key: edit.score_key,
        issue: `Polished issue for ${edit.score_key} on variant ${payload.variant?.name || "?"}.`,
        suggested_edit: `Polished edit (${edit.score_key}): lead with the painful moment then Calmcap.`,
        draft_revision: edit.score_key === "cognitive_load" ? null : `Draft for ${edit.score_key}.`
      }));
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ edits: polishedEdits }) } }]
      });
    }
    if (userMsg.includes("\"template_headline\"") || userMsg.includes("template_headline")) {
      reasonsCalled = true;
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                headline: "Ship Strong Variant on the strength of the first beat.",
                reasons: [
                  "Composite leads runner-up by the expected margin.",
                  "Opening hook holds attention through the first three seconds."
                ]
              })
            }
          }
        ]
      });
    }
    if (userMsg.includes("\"required_claims\"") && userMsg.includes("\"forbidden_terms\"")) {
      complianceCalled = true;
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                required_claims: [{ claim: "clinically tested", present: false, evidence: null }],
                forbidden_terms: [{ term: "miracle", present: false, evidence: null }]
              })
            }
          }
        ]
      });
    }
    return jsonResponse({ choices: [{ message: { content: "{}" } }] });
  };

  try {
    // providerHealth should now report openrouter as active.
    const providers = await call("GET", "/api/brain/providers");
    const openrouter = providers.json.find((entry) => entry.provider === "openrouter");
    assert.ok(openrouter, "openrouter provider should be in providerHealth");
    assert.equal(openrouter.active, true);

    const project = await call("POST", "/api/projects", { name: "Polish Project" }, headers);
    const strong = await call(
      "POST",
      "/api/assets",
      {
        asset_type: "script",
        name: "Strong Variant",
        text: "Stop tossing all night. Calmcap helps you fall asleep in twelve minutes. Try the starter kit today.",
        project_id: project.json.id
      },
      headers
    );
    const soft = await call(
      "POST",
      "/api/assets",
      {
        asset_type: "script",
        name: "Soft Variant",
        text: "Our brand has a modern solution for everyone.",
        project_id: project.json.id
      },
      headers
    );
    const created = await call(
      "POST",
      "/api/comparisons",
      {
        asset_ids: [strong.json.asset.id, soft.json.asset.id],
        objective: "Pick the stronger sleep ad.",
        brief: {
          brand_name: "Calmcap",
          audience: "thirty-something insomniacs",
          primary_offer: "starter kit",
          required_claims: ["clinically tested"],
          forbidden_terms: ["miracle"]
        },
        project_id: project.json.id
      },
      headers
    );
    assert.equal(created.statusCode, 200);
    assert.equal(created.json.status, "complete");

    // At least one edit should be polished (the winner gets up to 4 edits, so
    // at least one LLM call should have fired against the OpenRouter endpoint).
    assert.ok(editCallCount > 0, "expected at least one edit polish LLM call");
    const polishedSuggestion = created.json.suggestions.find((entry) => entry.llm_polished);
    assert.ok(polishedSuggestion, "expected at least one suggestion with llm_polished=true");
    assert.match(polishedSuggestion.issue, /Polished issue/);

    // Recommendation should have the polished headline+reasons.
    assert.equal(reasonsCalled, true);
    assert.equal(created.json.recommendation.llm_polished, true);
    assert.match(created.json.recommendation.headline, /strength of the first beat/);
    assert.equal(created.json.recommendation.reasons.length, 2);

    // Compliance result should attach when the brief carries required/forbidden lists.
    assert.equal(complianceCalled, true);
    assert.ok(Array.isArray(created.json.compliance));
    assert.ok(created.json.compliance.length > 0);
    const firstReport = created.json.compliance[0];
    assert.ok(Array.isArray(firstReport.missing_required));
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({
      OPENROUTER_API_KEY: undefined,
      STIMLI_LLM_MODEL: undefined,
      STIMLI_LLM_TIMEOUT_MS: undefined
    });
  }
});

async function call(method, url, body = null, headers = {}) {
  const hasBody = body !== null && body !== undefined && method !== "GET" && method !== "HEAD";
  // testAccount() and sessionCookie() return a Clerk user id wrapped as
  // `cookie`. Translate it to the test-mode auth header so the new auth.js
  // synthesizes the right context.
  const normalized = { ...headers };
  if (normalized.cookie && !String(normalized.cookie).includes("=")) {
    const [userId, teamId] = String(normalized.cookie).split("::");
    normalized["x-stimli-test-user"] = userId;
    if (teamId) normalized["x-stimli-test-team"] = teamId;
    delete normalized.cookie;
  }
  const init = {
    method,
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...normalized }
  };
  if (hasBody) {
    init.body = JSON.stringify(body);
  }
  const request = new Request(`http://stimli.test${url}`, init);
  const response = await onRequest({ request, env: testEnv, params: {} });
  const flat = {};
  for (const [k, v] of response.headers) {
    flat[k.toLowerCase()] = v;
  }
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (cookies.length) {
    flat["set-cookie"] = cookies.length === 1 ? cookies[0] : cookies;
  }
  const text = await response.text();
  return {
    statusCode: response.status,
    headers: flat,
    text,
    json: text ? safeJson(text) : null
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  await saveUser(user);
  await saveTeam(team);
  await saveTeamMember({ team_id: team.id, user_id: user.id, role: "owner", created_at: createdAt });
  // In Clerk production, requests carry an Authorization: Bearer JWT. In tests,
  // STIMLI_TEST_MODE makes the API honor an X-Stimli-Test-User header. We store
  // the value under the `cookie` field for naming continuity with the old
  // passkey tests; call() translates it transparently.
  return { user, team, cookie: user.id };
}

async function sessionCookie(userId, teamId) {
  // Encodes both ids so call() can drive the test-only auth header AND override
  // the active team. Tests use this when a user belongs to multiple teams.
  return teamId ? `${userId}::${teamId}` : userId;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function withEnv(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete testEnv[key];
    } else {
      testEnv[key] = value;
    }
  }
}
