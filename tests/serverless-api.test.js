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
import { readFileSync } from "node:fs";
import test from "node:test";

import { onRequest, UNLIMITED_USAGE_SENTINEL } from "../functions/api/[[path]].js";
import { nowIso, resetRemoteBrainHealth } from "../functions/api/_lib/analysis.js";
import { onInvoiceFailed, onInvoicePaid, onSubscriptionDeleted, stripeIdempotencyKey } from "../functions/api/_lib/billing.js";
import {
  configureStore,
  countUsageEvents,
  ensureTeamWithOwner,
  getSubscription,
  getTeam,
  getTeamMember,
  getUser,
  getUserByEmail,
  listTeamsForUser,
  rebindUserId,
  saveTeam,
  saveTeamMember,
  saveSubscription,
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

test("unlimited usage sentinel stays within Postgres int4 range", () => {
  // The store binds limits into a `count::int + units <= $limit` comparison, so
  // Postgres infers an int4 parameter. A sentinel above the int4 ceiling throws
  // 22003 and 500s any creation that runs the gate without a finite cap (this is
  // invisible in the memory-store tests, hence the explicit bound check here).
  assert.ok(Number.isInteger(UNLIMITED_USAGE_SENTINEL));
  assert.ok(UNLIMITED_USAGE_SENTINEL <= 2147483647, "sentinel must fit a Postgres int4");
  assert.ok(UNLIMITED_USAGE_SENTINEL >= 1_000_000_000, "sentinel must still be effectively unlimited");
});

test("serves health from the Pages API", async () => {
  const response = await call("GET", "/api/health");

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.status, "ok");
});

test("API responses include baseline security headers", async () => {
  const response = await call("GET", "/api/health");

  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["permissions-policy"], "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  // Every response carries a correlation id, exposed for cross-origin reads.
  assert.ok(response.headers["x-request-id"], "expected an X-Request-Id header");
  assert.match(response.headers["access-control-expose-headers"] || "", /X-Request-Id/);
});

test("a forced 5xx echoes the correlation id in the body and header", async () => {
  // Break newId()'s randomUUID so a handler throws an unexpected error and the
  // central catch maps it to an opaque 500. A cf-ray header is supplied so the
  // request id itself (computed before the try) doesn't depend on randomUUID.
  const ray = "test-ray-1234567890";
  const original = globalThis.crypto.randomUUID;
  globalThis.crypto.randomUUID = () => {
    throw new Error("synthetic failure for request-id test");
  };
  try {
    const response = await call(
      "POST",
      "/api/projects",
      { name: "Trigger a 500" },
      { "x-stimli-workspace": "ws_requestid_probe", "cf-ray": ray }
    );
    assert.equal(response.statusCode, 500);
    assert.equal(response.json.detail, "Request failed");
    assert.equal(response.json.request_id, ray, "5xx body should echo the cf-ray request id");
    assert.equal(response.headers["x-request-id"], ray);
  } finally {
    globalThis.crypto.randomUUID = original;
  }
});

test("health reports degraded when production persistence is missing", async () => {
  withEnv({ STIMLI_TEST_MODE: undefined, STIMLI_ALLOW_MEMORY_STORE: undefined });
  try {
    const response = await call("GET", "/api/health");

    assert.equal(response.statusCode, 503);
    assert.equal(response.json.status, "degraded");
    assert.equal(response.json.storage.mode, "memory");
  } finally {
    withEnv({ STIMLI_TEST_MODE: "1" });
  }
});

test("production memory mode fails closed for non-health data routes", async () => {
  withEnv({ STIMLI_TEST_MODE: undefined, STIMLI_ALLOW_MEMORY_STORE: undefined });
  try {
    const response = await call("GET", "/api/projects", null, {
      "x-stimli-workspace": `ws_no_db_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json.code, "persistence_unavailable");
    assert.equal(response.json.storage.mode, "memory");
  } finally {
    withEnv({ STIMLI_TEST_MODE: "1" });
  }
});

test("postgres bootstrap migrates columns used by current production code", () => {
  const source = readFileSync(new URL("../functions/api/_lib/store.js", import.meta.url), "utf8");
  const requiredFragments = [
    "alter table stimli_assets add column if not exists workspace_id",
    "alter table stimli_outcomes add column if not exists comparison_id",
    "alter table stimli_usage_events add column if not exists bucket_key",
    "alter table stimli_team_invites add column if not exists email",
    "alter table stimli_sessions add column if not exists team_id",
    "alter table stimli_share_links add column if not exists comparison_id",
    "alter table stimli_audit_events add column if not exists actor_id",
    "alter table stimli_subscriptions add column if not exists stripe_subscription_id",
    "alter table stimli_subscriptions add column if not exists updated_at",
    "alter table stimli_billing_events add column if not exists team_id",
    "update stimli_subscriptions set stripe_subscription_id",
    "lower(payload->>'cancel_at_period_end') in ('true', 't', '1', 'yes')",
    "stimli_schema_migrations",
    "STORE_SCHEMA_VERSION",
    "STORE_INDEX_VERSION",
    "STORE_INDEX_CLAIM_VERSION",
    "STORE_INDEX_CLAIM_STALE_MS",
    "schemaBackfillQueries(sql)",
    "schemaIndexQueries(sql)",
    "claimSchemaMigration(sql, STORE_INDEX_CLAIM_VERSION, STORE_INDEX_CLAIM_STALE_MS)",
    "select version from stimli_schema_migrations where version = ${STORE_SCHEMA_VERSION}",
    "select version from stimli_schema_migrations where version = ${STORE_INDEX_VERSION}",
    "create index concurrently if not exists",
    "stimli:user-rebind",
    "delete from stimli_team_members old_member",
    "~ '^-?[0-9]+(\\\\.[0-9]+)?$'",
    "insert into stimli_schema_migrations (version, applied_at)"
  ];

  for (const fragment of requiredFragments) {
    assert.ok(source.includes(fragment), `missing schema migration fragment: ${fragment}`);
  }
  assert.equal(source.includes("(payload->>'cancel_at_period_end')::boolean"), false);
  assert.equal(source.includes("(payload->>'last_stripe_event_created')::double precision, -1"), false);
  assert.ok(
    source.indexOf("select version from stimli_schema_migrations") < source.indexOf("schemaBackfillQueries(sql)"),
    "schema ledger should be checked before backfill queries are built into the bootstrap transaction"
  );
  const ensureTablesStart = source.indexOf("async function ensureTables");
  const indexLedgerCheck = source.indexOf("const indexesApplied", ensureTablesStart);
  const schemaTransaction = source.slice(source.indexOf("await sql.transaction([", ensureTablesStart), indexLedgerCheck);
  assert.equal(
    schemaTransaction.includes("schemaIndexQueries(sql)"),
    false,
    "index creation should run outside the request-time bootstrap transaction"
  );
});

test("postgres index bootstrap uses a stale-safe migration claim", () => {
  const source = readFileSync(new URL("../functions/api/_lib/store.js", import.meta.url), "utf8");
  const ensureTablesStart = source.indexOf("async function ensureTables");
  const indexCheck = source.indexOf("const indexesApplied", ensureTablesStart);
  const indexClaim = source.indexOf("claimSchemaMigration(sql, STORE_INDEX_CLAIM_VERSION", indexCheck);
  const indexQueries = source.indexOf("schemaIndexQueries(sql)", indexClaim);
  const finalLedger = source.indexOf("values (${STORE_INDEX_VERSION}", indexQueries);
  const claimCleanup = source.indexOf("delete from stimli_schema_migrations where version = ${STORE_INDEX_CLAIM_VERSION}", finalLedger);

  assert.ok(indexCheck > -1, "missing index ledger check");
  assert.ok(indexClaim > indexCheck, "index claim should follow final ledger check");
  assert.ok(indexQueries > indexClaim, "index creation should run only after claiming");
  assert.ok(finalLedger > indexQueries, "final index ledger should be written after index creation");
  assert.ok(claimCleanup > finalLedger, "claim row should be cleaned after the index pass");
  assert.match(source, /delete from stimli_schema_migrations[\s\S]+where version = \$\{version\} and applied_at < \$\{staleIso\}/);
  assert.match(source, /insert into stimli_schema_migrations \(version, applied_at\)[\s\S]+on conflict \(version\) do nothing/);
});

test("postgres invite acceptance only consumes an invite after seat resolution", () => {
  const source = readFileSync(new URL("../functions/api/_lib/store.js", import.meta.url), "utf8");
  const eligibleIdx = source.indexOf("with eligible as (");
  const resolvedIdx = source.indexOf("resolved as (", eligibleIdx);
  const acceptedIdx = source.indexOf("accepted as (", resolvedIdx);

  assert.ok(eligibleIdx > -1, "missing eligible invite CTE");
  assert.ok(resolvedIdx > eligibleIdx, "member resolution must follow invite eligibility");
  assert.ok(acceptedIdx > resolvedIdx, "invite acceptance must happen after member resolution");
  assert.equal(source.includes("with claimed as (\n      update stimli_team_invites"), false);
});

test("postgres comparison delete cascades in one statement", () => {
  const source = readFileSync(new URL("../functions/api/_lib/store.js", import.meta.url), "utf8");
  const start = source.indexOf("export async function deleteComparison");
  const end = source.indexOf("export async function saveOutcome", start);
  const block = source.slice(start, end);

  assert.match(block, /with deleted as \(/);
  assert.match(block, /delete from stimli_comparisons/);
  assert.match(block, /delete from stimli_outcomes[\s\S]+comparison_id in \(select id from deleted\)/);
  assert.match(block, /delete from stimli_share_links[\s\S]+comparison_id in \(select id from deleted\)/);
  assert.match(block, /select exists\(select 1 from deleted\) as deleted/);
  assert.equal((block.match(/await sql`/g) || []).length, 1);
});

test("allows credentialed local CORS without opening arbitrary origins", async () => {
  const local = await call("OPTIONS", "/api/health", null, { origin: "http://localhost:5173" });
  assert.equal(local.statusCode, 204);
  assert.equal(local.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(local.headers["access-control-allow-credentials"], "true");
  assert.match(local.headers["access-control-allow-headers"], /X-Stimli-Team/);
  assert.equal(local.headers["access-control-max-age"], "86400");

  const blocked = await call("OPTIONS", "/api/health", null, { origin: "https://example.invalid" });
  assert.equal(blocked.statusCode, 204);
  assert.equal(blocked.headers["access-control-allow-origin"], undefined);
});

test("rejects oversized JSON payloads before handler processing", async () => {
  withEnv({ STIMLI_MAX_JSON_BYTES: "80" });
  try {
    const response = await call(
      "POST",
      "/api/projects",
      { name: "Huge JSON", description: "x".repeat(200) },
      { "x-stimli-workspace": `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}` }
    );

    assert.equal(response.statusCode, 413);
    assert.match(response.json.detail, /JSON payload exceeds/);
  } finally {
    withEnv({ STIMLI_MAX_JSON_BYTES: undefined });
  }
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

test("ensureTeamWithOwner is idempotent for first-session personal teams", async () => {
  const userId = `user_personal_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const createdAt = nowIso();
  const firstTeamId = `team_personal_${crypto.randomUUID().slice(0, 8)}`;
  const secondTeamId = `team_personal_${crypto.randomUUID().slice(0, 8)}`;
  const first = await ensureTeamWithOwner(
    { id: firstTeamId, name: "Personal One", created_at: createdAt },
    { team_id: firstTeamId, user_id: userId, role: "owner", created_at: createdAt }
  );
  const second = await ensureTeamWithOwner(
    { id: secondTeamId, name: "Personal Two", created_at: nowIso() },
    { team_id: secondTeamId, user_id: userId, role: "owner", created_at: nowIso() }
  );
  const teams = await listTeamsForUser(userId);

  assert.equal(second.id, first.id);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].id, first.id);
  const owner = await getTeamMember(first.id, userId);
  assert.equal(owner.role, "owner");
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

test("checkout redirects existing subscribers to the billing portal instead of creating duplicates", async () => {
  const account = await testAccount("Existing Subscriber Team", "owner");
  const createdAt = nowIso();
  await saveSubscription({
    team_id: account.team.id,
    stripe_subscription_id: `sub_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    stripe_customer_id: "cus_existing_subscriber",
    plan: "growth",
    status: "active",
    current_period_start: createdAt,
    current_period_end: createdAt,
    cancel_at_period_end: false,
    trial_end: null,
    created_at: createdAt,
    updated_at: createdAt
  });
  const calls = { customers: 0, checkout: 0, portal: 0, portalCustomer: "" };
  globalThis.__stimliStripeClient = {
    customers: {
      create: async () => {
        calls.customers += 1;
        return { id: "cus_new" };
      }
    },
    checkout: {
      sessions: {
        create: async () => {
          calls.checkout += 1;
          return { id: "cs_new", url: "https://checkout.test/new" };
        }
      }
    },
    billingPortal: {
      sessions: {
        create: async (payload) => {
          calls.portal += 1;
          calls.portalCustomer = payload.customer;
          return { url: "https://billing.test/portal" };
        }
      }
    }
  };
  withEnv({
    STRIPE_SECRET_KEY: "sk_test_existing",
    STRIPE_GROWTH_PRICE_ID: "price_growth",
    STIMLI_APP_URL: "https://stimli.test"
  });
  try {
    const response = await call("POST", "/api/billing/checkout", { plan: "growth" }, { cookie: account.cookie });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.url, "https://billing.test/portal");
    assert.equal(response.json.billing_portal, true);
    assert.equal(response.json.existing_subscription.status, "active");
    assert.equal(calls.checkout, 0);
    assert.equal(calls.customers, 0);
    assert.equal(calls.portal, 1);
    assert.equal(calls.portalCustomer, "cus_existing_subscriber");
    assert.equal((await getTeam(account.team.id)).stripe_customer_id, "cus_existing_subscriber");
  } finally {
    delete globalThis.__stimliStripeClient;
    withEnv({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_GROWTH_PRICE_ID: undefined,
      STIMLI_APP_URL: "https://stimli.test"
    });
  }
});

test("inactive Stripe subscriptions do not grant paid quotas", async () => {
  const { billingStatus, configureBilling, getQuotaForWorkspace } = await import("../functions/api/_lib/billing.js");
  const account = await testAccount("Inactive Subscription Team", "owner");
  configureBilling(testEnv);
  await saveSubscription({
    team_id: account.team.id,
    stripe_subscription_id: `sub_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    stripe_customer_id: `cus_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    plan: "growth",
    status: "incomplete",
    current_period_start: "2026-06-01T00:00:00.000Z",
    current_period_end: "2026-07-01T00:00:00.000Z",
    cancel_at_period_end: false,
    trial_end: null,
    created_at: nowIso(),
    updated_at: nowIso()
  });

  const status = await billingStatus(account.team);
  const quota = await getQuotaForWorkspace(account.team.id);

  assert.equal(status.subscription.status, "incomplete");
  assert.equal(status.current_plan.id, "research");
  assert.equal(quota.plan.id, "research");
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
    // The monthly quota block advertises when the cap resets so clients back off.
    assert.ok(Number(blocked.headers["retry-after"]) > 0, "expected a positive Retry-After header");
  } finally {
    withEnv({
      STIMLI_RESEARCH_COMPARISON_LIMIT_PER_MONTH: undefined,
      STIMLI_RESEARCH_COMPARISON_LIMIT_PER_HOUR: undefined
    });
  }
});

test("invalid comparison requests do not consume monthly quota", async () => {
  withEnv({
    STIMLI_RESEARCH_COMPARISON_LIMIT_PER_MONTH: "1",
    STIMLI_RESEARCH_COMPARISON_LIMIT_PER_HOUR: "100"
  });
  const account = await testAccount("Invalid Quota Team", "owner");
  const headers = { cookie: account.cookie, "user-agent": "stimli-invalid-quota-test" };
  try {
    const assetA = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Invalid quota A", text: "Stop weak hooks before launch. Try the starter kit today." },
      headers
    );
    const assetB = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Invalid quota B", text: "Upload creative and compare variants before spend." },
      headers
    );
    assert.equal(assetA.statusCode, 200);
    assert.equal(assetB.statusCode, 200);

    const invalid = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [assetA.json.asset.id], objective: "Invalid should not burn quota." },
      headers
    );
    assert.equal(invalid.statusCode, 400);

    const valid = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [assetA.json.asset.id, assetB.json.asset.id], objective: "This should still have quota." },
      headers
    );
    assert.equal(valid.statusCode, 200);
  } finally {
    withEnv({
      STIMLI_RESEARCH_COMPARISON_LIMIT_PER_MONTH: undefined,
      STIMLI_RESEARCH_COMPARISON_LIMIT_PER_HOUR: undefined
    });
  }
});

test("rejects invalid numeric asset and outcome fields", async () => {
  const workspace = `ws_numbers_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const headers = { "x-stimli-workspace": workspace };
  const invalidAsset = await call(
    "POST",
    "/api/assets",
    {
      asset_type: "script",
      name: "Bad duration",
      text: "Try the starter kit today.",
      duration_seconds: "-5"
    },
    headers
  );
  assert.equal(invalidAsset.statusCode, 400);
  assert.match(invalidAsset.json.detail, /duration_seconds must be a non-negative number/i);

  const seeded = await call("POST", "/api/demo/seed", {}, headers);
  assert.equal(seeded.statusCode, 200);
  const comparison = await call(
    "POST",
    "/api/comparisons",
    { objective: "numeric guard", asset_ids: seeded.json.slice(0, 2).map((asset) => asset.id) },
    headers
  );
  assert.equal(comparison.statusCode, 200);
  const invalidOutcome = await call(
    "POST",
    `/api/comparisons/${comparison.json.id}/outcomes`,
    { asset_id: comparison.json.recommendation.winner_asset_id, clicks: "12.5" },
    headers
  );
  assert.equal(invalidOutcome.statusCode, 400);
  assert.match(invalidOutcome.json.detail, /clicks must be a whole number/i);
});

test("normalizes scalar JSON asset fields without crashing on malformed string fields", async () => {
  const response = await call(
    "POST",
    "/api/assets",
    {
      asset_type: "SCRIPT",
      name: { bad: "shape" },
      text: 123,
      duration_seconds: 0
    },
    { "x-stimli-workspace": `ws_asset_fields_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.asset.name, "Untitled asset");
  assert.equal(response.json.asset.extracted_text, "123");
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

test("duplicate or already-member invites do not consume seats", async () => {
  withEnv({ STIMLI_RESEARCH_SEATS: "3" });
  const owner = await testAccount("Duplicate Invite Team", "owner");
  try {
    const existingMember = await call(
      "POST",
      "/api/teams/invites",
      { email: owner.user.email, role: "analyst" },
      { cookie: owner.cookie }
    );
    assert.equal(existingMember.statusCode, 409);
    assert.match(existingMember.json.detail, /already belongs/i);

    const first = await call(
      "POST",
      "/api/teams/invites",
      { email: "duplicate-seat@example.com", role: "analyst" },
      { cookie: owner.cookie }
    );
    assert.equal(first.statusCode, 200);

    const duplicate = await call(
      "POST",
      "/api/teams/invites",
      { email: "DUPLICATE-SEAT@example.com", role: "viewer" },
      { cookie: owner.cookie }
    );
    assert.equal(duplicate.statusCode, 409);
    assert.match(duplicate.json.detail, /active invite/i);

    const secondRealInvite = await call(
      "POST",
      "/api/teams/invites",
      { email: "real-seat@example.com", role: "viewer" },
      { cookie: owner.cookie }
    );
    assert.equal(secondRealInvite.statusCode, 200);
  } finally {
    withEnv({ STIMLI_RESEARCH_SEATS: undefined });
  }
});

test("requires invite email and re-checks seats when accepting stale invites", async () => {
  withEnv({ STIMLI_RESEARCH_SEATS: "2" });
  const owner = await testAccount("Stale Invite Team", "owner");
  const invited = await testAccount("Stale Invite Default", "member");
  try {
    const missingEmail = await call("POST", "/api/teams/invites", { role: "analyst" }, { cookie: owner.cookie });
    assert.equal(missingEmail.statusCode, 400);
    assert.equal(missingEmail.json.detail, "Invite email is required.");

    const invite = await call(
      "POST",
      "/api/teams/invites",
      { email: invited.user.email, role: "analyst" },
      { cookie: owner.cookie }
    );
    assert.equal(invite.statusCode, 200);

    withEnv({ STIMLI_RESEARCH_SEATS: "1" });
    const blockedAccept = await call("POST", `/api/invites/${invite.json.token}/accept`, null, { cookie: invited.cookie });
    assert.equal(blockedAccept.statusCode, 402);
    assert.equal(blockedAccept.json.code, "seat_limit_reached");
    assert.equal(await getTeamMember(owner.team.id, invited.user.id), null);
    const retryable = await call("GET", `/api/invites/${invite.json.token}`, null, { cookie: invited.cookie });
    assert.equal(retryable.statusCode, 200);
    assert.equal(retryable.json.accepted_at, null);
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

test("conditional usage insert blocks at the limit (atomic quota gate)", async () => {
  // The conditional INSERT is what closes the check-then-insert race: it only
  // records the event when every limit still has headroom. Here we drive the
  // store directly to confirm the gate blocks the Nth+1 write.
  const { saveUsageEventConditional } = await import("../functions/api/_lib/store.js");
  const huge = Number.MAX_SAFE_INTEGER;
  const ws = `ws_quota_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const bucket = `client_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const limits = {
    workspaceId: ws,
    bucketKey: bucket,
    monthlySince: "2026-01-01T00:00:00.000Z",
    monthlyLimit: 2,
    hourlySince: "2026-06-01T00:00:00.000Z",
    hourlyLimit: huge
  };
  const ev = () => ({ id: `usage_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, kind: "comparison", payload: {}, created_at: nowIso() });
  assert.equal(await saveUsageEventConditional(ev(), limits), true, "1st under limit");
  assert.equal(await saveUsageEventConditional(ev(), limits), true, "2nd hits the limit exactly");
  assert.equal(await saveUsageEventConditional(ev(), limits), false, "3rd is blocked");

  // Hourly bucket guard blocks independently of the monthly one.
  const hourly = { ...limits, monthlyLimit: huge, hourlyLimit: 1 };
  const ws2 = `ws_quota2_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const bucket2 = `client2_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const h = { ...hourly, workspaceId: ws2, bucketKey: bucket2 };
  assert.equal(await saveUsageEventConditional(ev(), h), true, "1st hourly under limit");
  assert.equal(await saveUsageEventConditional(ev(), h), false, "2nd blocked by hourly bucket");
});

test("subscription period reads the item level with a root fallback", async () => {
  const { subscriptionPeriodSeconds } = await import("../functions/api/_lib/billing.js");
  // Newer Stripe API: period is on the subscription item.
  const itemLevel = subscriptionPeriodSeconds({
    current_period_start: undefined,
    items: { data: [{ current_period_start: 1000, current_period_end: 2000 }] }
  });
  assert.deepEqual(itemLevel, { start: 1000, end: 2000 });
  // Older Stripe API: period on the root.
  const rootLevel = subscriptionPeriodSeconds({ current_period_start: 50, current_period_end: 99, items: { data: [{}] } });
  assert.deepEqual(rootLevel, { start: 50, end: 99 });
  // Neither present → null so currentPeriod() degrades to the calendar month.
  assert.deepEqual(subscriptionPeriodSeconds({}), { start: null, end: null });
});

test("checkout uses team-scoped Stripe idempotency keys", () => {
  const source = readFileSync(new URL("../functions/api/_lib/billing.js", import.meta.url), "utf8");

  assert.equal(stripeIdempotencyKey("checkout", "team id", "growth", "cus 123"), "stimli:checkout:team-id:growth:cus-123");
  assert.match(source, /stripe\.customers\.create\([\s\S]+idempotencyKey: stripeIdempotencyKey\("customer", team\.id\)/);
  assert.match(source, /stripe\.checkout\.sessions\.create\([\s\S]+idempotencyKey: stripeIdempotencyKey\("checkout", team\.id, plan\.id, customerId\)/);
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

test("older Stripe subscription events cannot overwrite newer billing state", async () => {
  const teamId = `team_stripe_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const createdAt = nowIso();
  await saveSubscription({
    team_id: teamId,
    stripe_subscription_id: "sub_ordering",
    stripe_customer_id: "cus_ordering",
    plan: "research",
    status: "cancelled",
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    trial_end: null,
    last_stripe_event_created: 200,
    created_at: createdAt,
    updated_at: createdAt
  });

  const stale = await saveSubscription({
    team_id: teamId,
    stripe_subscription_id: "sub_ordering",
    stripe_customer_id: "cus_ordering",
    plan: "growth",
    status: "active",
    current_period_start: createdAt,
    current_period_end: createdAt,
    cancel_at_period_end: false,
    trial_end: null,
    last_stripe_event_created: 100,
    created_at: createdAt,
    updated_at: nowIso()
  });

  assert.equal(stale.status, "cancelled");
  assert.equal(stale.plan, "research");
  const stored = await getSubscription(teamId);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.plan, "research");
  assert.equal(stored.last_stripe_event_created, 200);
});

test("same-second Stripe subscription events cannot overwrite existing billing state", async () => {
  const teamId = `team_stripe_same_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const createdAt = nowIso();
  await saveSubscription({
    team_id: teamId,
    stripe_subscription_id: "sub_same_second",
    stripe_customer_id: "cus_same_second",
    plan: "growth",
    status: "active",
    current_period_start: createdAt,
    current_period_end: createdAt,
    cancel_at_period_end: false,
    trial_end: null,
    last_stripe_event_created: 300,
    created_at: createdAt,
    updated_at: createdAt
  });

  const stalePeer = await saveSubscription({
    team_id: teamId,
    stripe_subscription_id: "sub_same_second",
    stripe_customer_id: "cus_same_second",
    plan: "research",
    status: "cancelled",
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    trial_end: null,
    last_stripe_event_created: 300,
    created_at: createdAt,
    updated_at: nowIso()
  });

  assert.equal(stalePeer.last_stripe_write_ignored, true);
  const stored = await getSubscription(teamId);
  assert.equal(stored.status, "active");
  assert.equal(stored.plan, "growth");
  assert.equal(stored.last_stripe_event_created, 300);
});

test("invoice webhooks cannot revive a terminal subscription", async () => {
  const teamId = `team_invoice_terminal_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const createdAt = nowIso();
  await saveSubscription({
    team_id: teamId,
    stripe_subscription_id: "sub_terminal_ordering",
    stripe_customer_id: "cus_terminal_ordering",
    plan: "research",
    status: "cancelled",
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: false,
    trial_end: null,
    last_stripe_event_created: 200,
    created_at: createdAt,
    updated_at: createdAt
  });

  await onInvoicePaid({ customer: "cus_terminal_ordering", subscription: "sub_terminal_ordering", amount_paid: 4900 }, 201);
  let stored = await getSubscription(teamId);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.plan, "research");
  assert.equal(stored.last_invoice_amount_paid, 4900);
  assert.equal(stored.last_invoice_event_created, 201);
  assert.equal(stored.last_stripe_event_created, 200);

  await onInvoiceFailed({ customer: "cus_terminal_ordering", subscription: "sub_terminal_ordering" }, 202);
  stored = await getSubscription(teamId);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.plan, "research");
  assert.ok(stored.last_invoice_failed_at);
  assert.equal(stored.last_invoice_event_created, 202);
  assert.equal(stored.last_stripe_event_created, 200);

  await onInvoicePaid({ customer: "cus_terminal_ordering", subscription: "sub_old_subscription", amount_paid: 9900 }, 203);
  stored = await getSubscription(teamId);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.last_invoice_amount_paid, 4900);
  assert.equal(stored.last_invoice_event_created, 202);
  assert.equal(stored.last_stripe_event_created, 200);
});

test("invoice timestamps do not block subscription cancellations", async () => {
  const teamId = `team_invoice_cancel_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const createdAt = nowIso();
  await saveSubscription({
    team_id: teamId,
    stripe_subscription_id: "sub_invoice_cancel",
    stripe_customer_id: "cus_invoice_cancel",
    plan: "growth",
    status: "active",
    current_period_start: createdAt,
    current_period_end: createdAt,
    cancel_at_period_end: false,
    trial_end: null,
    last_stripe_event_created: 100,
    created_at: createdAt,
    updated_at: createdAt
  });

  await onInvoicePaid({ customer: "cus_invoice_cancel", subscription: "sub_invoice_cancel", amount_paid: 4900 }, 201);
  let stored = await getSubscription(teamId);
  assert.equal(stored.status, "active");
  assert.equal(stored.plan, "growth");
  assert.equal(stored.last_invoice_event_created, 201);
  assert.equal(stored.last_stripe_event_created, 100);

  await onSubscriptionDeleted({
    id: "sub_invoice_cancel",
    customer: "cus_invoice_cancel",
    metadata: { team_id: teamId }
  }, 200);

  stored = await getSubscription(teamId);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.plan, "research");
  assert.equal(stored.last_invoice_event_created, 201);
  assert.equal(stored.last_stripe_event_created, 200);
});

test("subscription cancellations can clear invoice-polluted event ordering", async () => {
  const teamId = `team_polluted_cancel_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const createdAt = nowIso();
  await saveSubscription({
    team_id: teamId,
    stripe_subscription_id: "sub_polluted_cancel",
    stripe_customer_id: "cus_polluted_cancel",
    plan: "growth",
    status: "active",
    current_period_start: createdAt,
    current_period_end: createdAt,
    cancel_at_period_end: false,
    trial_end: null,
    last_invoice_paid_at: createdAt,
    last_invoice_amount_paid: 4900,
    last_stripe_event_created: 201,
    created_at: createdAt,
    updated_at: createdAt
  });

  await onSubscriptionDeleted({
    id: "sub_polluted_cancel",
    customer: "cus_polluted_cancel",
    metadata: { team_id: teamId }
  }, 200);

  const stored = await getSubscription(teamId);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.plan, "research");
  assert.equal(stored.last_invoice_amount_paid, 4900);
  assert.equal(stored.last_stripe_event_created, 200);
});

test("stale subscription deletes cannot cancel a replacement subscription", async () => {
  const teamId = `team_replace_cancel_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const createdAt = nowIso();
  await saveSubscription({
    team_id: teamId,
    stripe_subscription_id: "sub_new_active",
    stripe_customer_id: "cus_replace_cancel",
    plan: "growth",
    status: "active",
    current_period_start: createdAt,
    current_period_end: createdAt,
    cancel_at_period_end: false,
    trial_end: null,
    last_stripe_event_created: 300,
    created_at: createdAt,
    updated_at: createdAt
  });

  await onSubscriptionDeleted({
    id: "sub_old_active",
    customer: "cus_replace_cancel",
    metadata: { team_id: teamId }
  }, 200);

  const stored = await getSubscription(teamId);
  assert.equal(stored.status, "active");
  assert.equal(stored.plan, "growth");
  assert.equal(stored.stripe_subscription_id, "sub_new_active");
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

  const reused = await call("POST", `/api/invites/${invite.json.token}/accept`, null, { cookie: invited.cookie });
  assert.equal(reused.statusCode, 404);
});

test("demo seed consumes asset quota for every seeded asset", async () => {
  withEnv({
    STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: "2",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: "100"
  });
  const account = await testAccount("Demo Seed Quota Team", "owner");
  const headers = { cookie: account.cookie, "user-agent": "stimli-demo-seed-quota-test" };
  try {
    const blocked = await call("POST", "/api/demo/seed", null, headers);
    assert.equal(blocked.statusCode, 402);
    assert.equal(blocked.json.code, "quota_exceeded");
    assert.equal(blocked.json.details.kind, "asset");
    assert.equal(blocked.json.details.limit, 2);
    assert.equal(blocked.json.details.requested, 3);
    assert.equal(await countUsageEvents({ kind: "asset", since: account.team.created_at, workspaceId: account.team.id }), 0);
  } finally {
    withEnv({
      STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: undefined
    });
  }
});

test("demo seed replaces prior demo assets in the workspace", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };

  const first = await call("POST", "/api/demo/seed", null, headers);
  const second = await call("POST", "/api/demo/seed", null, headers);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);

  const firstIds = new Set(first.json.map((asset) => asset.id));
  const secondIds = new Set(second.json.map((asset) => asset.id));
  assert.equal(secondIds.size, 3);
  assert.equal([...firstIds].some((id) => secondIds.has(id)), false);

  const listed = await call("GET", "/api/assets", null, headers);
  assert.equal(listed.statusCode, 200);
  const demoAssets = listed.json.filter((asset) => asset.metadata?.demo === true);
  assert.equal(demoAssets.length, 3);
  assert.deepEqual(new Set(demoAssets.map((asset) => asset.id)), secondIds);
});

test("Pages preview deployments generate links on the request origin", async () => {
  withEnv({
    STIMLI_APP_URL: "https://stimli.pages.dev",
    STIMLI_ORIGIN: "https://stimli.pages.dev"
  });
  const owner = await testAccount("Preview Link Team", "owner");
  try {
    const request = new Request("https://branch-test.stimli.pages.dev/api/teams/invites", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stimli-test-user": owner.user.id
      },
      body: JSON.stringify({ email: "preview-invite@example.com", role: "analyst" })
    });
    const response = await onRequest({ request, env: testEnv, params: {} });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.match(json.url, /^https:\/\/branch-test\.stimli\.pages\.dev\/invite\//);
  } finally {
    withEnv({
      STIMLI_APP_URL: "https://stimli.test",
      STIMLI_ORIGIN: "https://stimli.test"
    });
  }
});

test("admins cannot mint elevated invites or self-promote by accepting one", async () => {
  const owner = await testAccount("Invite Escalation Team", "owner");
  const admin = await testAccount("Invite Escalation Admin Home", "admin");
  await saveTeamMember({ team_id: owner.team.id, user_id: admin.user.id, role: "admin", created_at: nowIso() });
  const adminCookie = await sessionCookie(admin.user.id, owner.team.id);

  const blocked = await call(
    "POST",
    "/api/teams/invites",
    { email: admin.user.email, role: "owner" },
    { cookie: adminCookie }
  );
  assert.equal(blocked.statusCode, 403);

  const ownerInvite = await call(
    "POST",
    "/api/teams/invites",
    { email: admin.user.email, role: "owner" },
    { cookie: owner.cookie }
  );
  assert.equal(ownerInvite.statusCode, 409);
  assert.match(ownerInvite.json.detail, /already belongs/i);
  assert.equal((await getTeamMember(owner.team.id, admin.user.id)).role, "admin");
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

test("demo seed requires team write permission for authenticated team workspaces", async () => {
  const owner = await testAccount("Demo Seed Role Team", "owner");
  const viewer = await testAccount("Demo Seed Viewer Home", "viewer");
  await saveTeamMember({ team_id: owner.team.id, user_id: viewer.user.id, role: "viewer", created_at: nowIso() });
  const viewerCookie = await sessionCookie(viewer.user.id, owner.team.id);

  const blocked = await call("POST", "/api/demo/seed", null, { cookie: viewerCookie });
  assert.equal(blocked.statusCode, 403);
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

test("markdown report escapes pipe characters in variant names", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const a = await call(
    "POST",
    "/api/assets",
    { asset_type: "script", name: "Variant | A", text: "Stop weak hooks before launch. Try the starter kit today." },
    headers
  );
  const b = await call(
    "POST",
    "/api/assets",
    { asset_type: "script", name: "Variant B", text: "Upload creative and compare the strongest variant before spend." },
    headers
  );
  const comparison = await call(
    "POST",
    "/api/comparisons",
    { asset_ids: [a.json.asset.id, b.json.asset.id], objective: "Markdown should stay well-formed." },
    headers
  );
  const markdown = await call("GET", `/api/comparisons/${comparison.json.id}`, null, headers);
  assert.equal(markdown.statusCode, 200);
  const md = await call("GET", `/api/reports/${comparison.json.id}/markdown`, null, headers);
  assert.equal(md.statusCode, 200);
  assert.match(md.headers["content-type"], /text\/markdown/);
  // The pipe in the name must be escaped, never left bare to split the row.
  assert.ok(md.text.includes("Variant \\| A"), "expected the pipe in the variant name to be escaped");
  assert.ok(!md.text.includes("| Variant | A |"), "a bare pipe must not break the table row");
});

test("full journey: seed, compare, report, share, outcome, calibrate, challenger, delete", async () => {
  // One integration test that walks the whole product loop so a regression in
  // how the features compose (not just each in isolation) is caught.
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };

  const seeded = await call("POST", "/api/demo/seed", null, headers);
  assert.equal(seeded.statusCode, 200);

  const comparison = await call(
    "POST",
    "/api/comparisons",
    {
      asset_ids: seeded.json.slice(0, 2).map((a) => a.id),
      objective: "Full journey",
      brief: { brand_name: "Lumina", audience: "skincare buyers", primary_offer: "starter kit" }
    },
    headers
  );
  assert.equal(comparison.statusCode, 200);
  assert.equal(comparison.json.status, "complete");
  const cid = comparison.json.id;
  const winner = comparison.json.recommendation.winner_asset_id;
  assert.ok(winner);

  // Report + markdown + share + anonymous shared report.
  assert.equal((await call("GET", `/api/reports/${cid}`, null, headers)).statusCode, 200);
  assert.equal((await call("GET", `/api/reports/${cid}/markdown`, null, headers)).statusCode, 200);
  const share = await call("POST", `/api/reports/${cid}/share`, null, headers);
  assert.equal(share.statusCode, 200);
  assert.equal((await call("GET", `/api/share/${share.json.token}`)).statusCode, 200);

  // Log an outcome on the predicted winner, then confirm calibration counts it.
  const outcome = await call(
    "POST",
    `/api/comparisons/${cid}/outcomes`,
    { asset_id: winner, spend: 100, impressions: 10000, clicks: 500, conversions: 40, revenue: 900, notes: "" },
    headers
  );
  assert.equal(outcome.statusCode, 200);
  const learning = await call("GET", "/api/learning/summary", null, headers);
  assert.equal(learning.statusCode, 200);
  assert.equal(learning.json.calibration.evaluated_comparisons, 1);
  assert.equal(learning.json.calibration.recent[0].comparison_id, cid);

  // Draft a challenger (creates a new asset), then prune the comparison.
  const challenger = await call("POST", `/api/comparisons/${cid}/challengers`, { source_asset_id: winner, focus: "hook" }, headers);
  assert.equal(challenger.statusCode, 200);
  assert.ok(challenger.json.asset.id);

  const del = await call("DELETE", `/api/comparisons/${cid}`, null, headers);
  assert.equal(del.statusCode, 200);
  // Cascade: comparison, its outcome, and its share link are all gone.
  assert.equal((await call("GET", `/api/comparisons/${cid}`, null, headers)).statusCode, 404);
  assert.equal((await call("GET", `/api/share/${share.json.token}`)).statusCode, 404);
  const outcomesAfter = await call("GET", "/api/outcomes", null, headers);
  assert.equal(outcomesAfter.json.some((o) => o.comparison_id === cid), false);
});

test("invalid challenger requests do not consume asset quota", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const seeded = await call("POST", "/api/demo/seed", null, headers);
  assert.equal(seeded.statusCode, 200);
  const comparison = await call(
    "POST",
    "/api/comparisons",
    {
      asset_ids: seeded.json.slice(0, 2).map((asset) => asset.id),
      objective: "Invalid challenger should not burn quota."
    },
    headers
  );
  assert.equal(comparison.statusCode, 200);
  const before = await countUsageEvents({ kind: "asset", workspaceId: workspace });

  const invalid = await call(
    "POST",
    `/api/comparisons/${comparison.json.id}/challengers`,
    { source_asset_id: "asset_missing", focus: "hook" },
    headers
  );

  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.json.detail, /Source asset must belong to the comparison/i);
  assert.equal(await countUsageEvents({ kind: "asset", workspaceId: workspace }), before);
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

test("confidence bins count every evaluated comparison, not just the recent five", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const seeded = await call("POST", "/api/demo/seed", null, headers);
  const assetIds = seeded.json.slice(0, 2).map((asset) => asset.id);

  // Six comparisons each carrying one logged outcome — more than the
  // calibration summary's 5-row "recent" window, so this exercises the bug
  // where confidence bins were derived from that capped slice.
  const total = 6;
  for (let i = 0; i < total; i += 1) {
    const comparison = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: assetIds, objective: `Calibration run ${i}` },
      headers
    );
    const predicted = comparison.json.recommendation.winner_asset_id;
    await call(
      "POST",
      `/api/comparisons/${comparison.json.id}/outcomes`,
      { asset_id: predicted, spend: 100, impressions: 10000, clicks: 500, conversions: 40, revenue: 900, notes: "" },
      headers
    );
  }

  const summary = await call("GET", "/api/learning/summary", null, headers);
  assert.equal(summary.json.calibration.evaluated_comparisons, total);
  assert.equal(summary.json.calibration.recent.length, 5);

  const calibration = await call("GET", "/api/validation/calibration", null, headers);
  assert.equal(calibration.statusCode, 200);
  const binnedPredictions = calibration.json.confidence_bins.reduce((sum, bin) => sum + bin.predictions, 0);
  assert.equal(binnedPredictions, total);
});

test("deletes a comparison and cascades its outcomes and share link", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const seeded = await call("POST", "/api/demo/seed", null, headers);
  const comparison = await call(
    "POST",
    "/api/comparisons",
    { asset_ids: seeded.json.slice(0, 2).map((a) => a.id), objective: "to be deleted" },
    headers
  );
  const cid = comparison.json.id;
  const winner = comparison.json.recommendation.winner_asset_id;
  await call("POST", `/api/comparisons/${cid}/outcomes`, { asset_id: winner, spend: 10, impressions: 100, clicks: 5, conversions: 1, revenue: 50, notes: "" }, headers);
  const share = await call("POST", `/api/reports/${cid}/share`, null, headers);
  assert.equal(share.statusCode, 200);

  const del = await call("DELETE", `/api/comparisons/${cid}`, null, headers);
  assert.equal(del.statusCode, 200);
  assert.equal(del.json.deleted, cid);

  // Comparison is gone.
  assert.equal((await call("GET", `/api/comparisons/${cid}`, null, headers)).statusCode, 404);
  // It no longer appears in the workspace list.
  const list = await call("GET", "/api/comparisons", null, headers);
  assert.equal(list.json.some((c) => c.id === cid), false);
  // Cascade: the share link no longer resolves and the outcome is gone.
  assert.equal((await call("GET", `/api/share/${share.json.token}`)).statusCode, 404);
  const outcomes = await call("GET", "/api/outcomes", null, headers);
  assert.equal(outcomes.json.some((o) => o.comparison_id === cid), false);

  // Deleting again is a clean 404, and another workspace can't delete it.
  assert.equal((await call("DELETE", `/api/comparisons/${cid}`, null, headers)).statusCode, 404);
});

test("deleting a processing comparison cancels its remote jobs first", async () => {
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const actions = [];
  resetRemoteBrainHealth();
  withEnv({ TRIBE_CONTROL_URL: "https://modal.test/control", TRIBE_API_KEY: "k" });
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    actions.push(body.action);
    if (body.action === "start") {
      return jsonResponse({ job_id: `job_${actions.length}`, asset_id: body.asset.id, status: "queued", provider: "tribe-v2" });
    }
    if (body.action === "cancel") {
      return jsonResponse({ job_id: body.job_id, status: "cancelled" });
    }
    return jsonResponse({ detail: "not found" }, 404);
  };
  try {
    const a = await call("POST", "/api/assets", { asset_type: "audio", name: "Aud A", text: "Stop wasting spend." }, headers);
    const b = await call("POST", "/api/assets", { asset_type: "audio", name: "Aud B", text: "A modern solution." }, headers);
    const created = await call("POST", "/api/comparisons", { asset_ids: [a.json.asset.id, b.json.asset.id], objective: "to delete while processing" }, headers);
    assert.equal(created.statusCode, 202);
    assert.equal(created.json.status, "processing");

    const del = await call("DELETE", `/api/comparisons/${created.json.id}`, null, headers);
    assert.equal(del.statusCode, 200);
    assert.ok(actions.includes("cancel"), "remote jobs should be cancelled before delete");
    assert.equal((await call("GET", `/api/comparisons/${created.json.id}`, null, headers)).statusCode, 404);
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({ TRIBE_CONTROL_URL: undefined, TRIBE_API_KEY: undefined });
  }
});

test("public share link to a non-complete comparison returns 404, not a 409 state leak", async () => {
  // A share token is normally only minted for a complete comparison, but the
  // public endpoint must never reveal internal state. Plant a link to a
  // processing comparison directly and confirm the anonymous fetch is a uniform
  // 404 rather than a 409 "still processing".
  const { saveComparison, saveShareLink } = await import("../functions/api/_lib/store.js");
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const cid = `cmp_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await saveComparison({
    id: cid,
    workspace_id: workspace,
    status: "processing",
    objective: "pending",
    brief: {},
    variants: [],
    recommendation: { winner_asset_id: null, verdict: "revise", confidence: 0, headline: "Analyzing", reasons: [] },
    suggestions: [],
    created_at: nowIso()
  });
  const token = `shr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await saveShareLink({
    token,
    workspace_id: workspace,
    comparison_id: cid,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    created_at: nowIso()
  });
  const res = await call("GET", `/api/share/${token}`);
  assert.equal(res.statusCode, 404);
  assert.match(res.json.detail, /not found/i);
});

test("creates public share links for completed reports", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace, host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" };
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

  const { getShareLink } = await import("../functions/api/_lib/store.js");
  assert.equal(await getShareLink(share.json.token), null, "raw share token must not be a storage key");
  const stored = await getShareLink(sha256HexSync(share.json.token));
  assert.equal(stored.comparison_id, comparison.json.id);
  assert.equal(stored.token, undefined);

  const report = await call("GET", share.json.api_path);
  assert.equal(report.statusCode, 200);
  assert.equal(report.json.comparison_id, comparison.json.id);
  assert.equal(report.json.title, "Stimli Creative Decision Report");
});

test("landing page extraction blocks private URLs without fetching them", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return jsonResponse({ should_not: "be called" });
  };

  try {
    const created = await call(
      "POST",
      "/api/assets",
      {
        asset_type: "landing_page",
        name: "Internal dashboard",
        url: "http://127.0.0.1:8788/admin"
      },
      { "x-stimli-workspace": `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}` }
    );

    assert.equal(created.statusCode, 200);
    assert.equal(fetchCalled, false);
    assert.equal(created.json.asset.source_url, null);
    assert.equal(created.json.asset.metadata.extraction_status, "blocked");
    assert.match(created.json.asset.metadata.extraction_error, /private_or_local_host/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("landing page extraction requires an explicit direct-fetch allowlist", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return jsonResponse({ should_not: "be called" });
  };

  try {
    const created = await call(
      "POST",
      "/api/assets",
      {
        asset_type: "landing_page",
        name: "Public offer",
        url: "https://example.com/offer"
      },
      { "x-stimli-workspace": `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}` }
    );

    assert.equal(created.statusCode, 200);
    assert.equal(fetchCalled, false);
    assert.equal(created.json.asset.source_url, "https://example.com/offer");
    assert.equal(created.json.asset.metadata.extraction_status, "blocked");
    assert.equal(created.json.asset.metadata.extraction_error, "direct_fetch_not_allowed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("landing page extraction validates redirects before following them", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  withEnv({ STIMLI_LANDING_PAGE_FETCH_ALLOWLIST: "example.com" });
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    assert.equal(options.redirect, "manual");
    return new Response("", {
      status: 302,
      headers: { location: "http://127.0.0.1/private" }
    });
  };

  try {
    const created = await call(
      "POST",
      "/api/assets",
      {
        asset_type: "landing_page",
        name: "Redirect trap",
        url: "https://example.com/offer"
      },
      { "x-stimli-workspace": `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}` }
    );

    assert.equal(created.statusCode, 200);
    assert.deepEqual(calls, ["https://example.com/offer"]);
    assert.equal(created.json.asset.metadata.extraction_status, "blocked");
    assert.match(created.json.asset.metadata.extraction_error, /redirect_private_or_local_host/);
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({ STIMLI_LANDING_PAGE_FETCH_ALLOWLIST: undefined });
  }
});

test("landing page extraction blocks redirects outside the direct-fetch allowlist", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  withEnv({ STIMLI_LANDING_PAGE_FETCH_ALLOWLIST: "example.com" });
  globalThis.fetch = async (url, options = {}) => {
    calls.push(String(url));
    assert.equal(options.redirect, "manual");
    return new Response("", {
      status: 302,
      headers: { location: "https://offsite.test/final" }
    });
  };

  try {
    const created = await call(
      "POST",
      "/api/assets",
      {
        asset_type: "landing_page",
        name: "Redirect offsite",
        url: "https://example.com/offer"
      },
      { "x-stimli-workspace": `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}` }
    );

    assert.equal(created.statusCode, 200);
    assert.deepEqual(calls, ["https://example.com/offer"]);
    assert.equal(created.json.asset.metadata.extraction_status, "blocked");
    assert.equal(created.json.asset.metadata.extraction_error, "redirect_direct_fetch_not_allowed");
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({ STIMLI_LANDING_PAGE_FETCH_ALLOWLIST: undefined });
  }
});

test("normalizes stored source URLs and rejects credentialed URLs", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace, "user-agent": "stimli-url-normalization-test" };

  const created = await call(
    "POST",
    "/api/assets",
    {
      asset_type: "script",
      url: "example.com/ad?utm=one&token=private-token&api_key=secret#access-token",
      text: "Stop weak hooks. Try the starter kit today."
    },
    headers
  );
  assert.equal(created.statusCode, 200);
  assert.equal(created.json.asset.source_url, "https://example.com/ad?utm=one");
  assert.equal(JSON.stringify(created.json).includes("private-token"), false);
  assert.equal(JSON.stringify(created.json).includes("api_key"), false);

  const credentialedAsset = await call(
    "POST",
    "/api/assets",
    {
      asset_type: "script",
      url: "https://user:secret@example.com/ad",
      text: "This URL should not be accepted."
    },
    headers
  );
  assert.equal(credentialedAsset.statusCode, 400);
  assert.match(credentialedAsset.json.detail, /credentials_not_allowed/);

  const privateMappedAsset = await call(
    "POST",
    "/api/assets",
    {
      asset_type: "script",
      url: "http://[::ffff:172.16.0.1]/ad",
      text: "IPv6-mapped private addresses should be rejected."
    },
    headers
  );
  assert.equal(privateMappedAsset.statusCode, 400);
  assert.match(privateMappedAsset.json.detail, /private_or_local_host/);

  const publicMappedAsset = await call(
    "POST",
    "/api/assets",
    {
      asset_type: "script",
      url: "https://[::ffff:8.8.8.8]/ad#token",
      text: "IPv6-mapped public addresses should still normalize."
    },
    headers
  );
  assert.equal(publicMappedAsset.statusCode, 200);
  assert.equal(publicMappedAsset.json.asset.source_url, "https://[::ffff:808:808]/ad");

  const imported = await call(
    "POST",
    "/api/imports",
    {
      platform: "csv",
      source: "url-normalization-test",
      items: [
        { asset_type: "script", url: "https://example.com/import?utm_source=csv&x-amz-signature=secret#private", text: "Compare variants before launch." },
        { asset_type: "script", url: "https://user:secret@example.com/import", text: "Reject credentials.", duration_seconds: { secret: "duration-token" } }
      ]
    },
    headers
  );
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json.job.status, "partial");
  assert.equal(imported.json.assets.length, 1);
  assert.equal(imported.json.assets[0].source_url, "https://example.com/import?utm_source=csv");
  assert.equal(JSON.stringify(imported.json.assets[0]).includes("x-amz-signature"), false);
  assert.equal(imported.json.job.failed_items, 1);
  assert.equal(imported.json.job.failures[0].item.url, null);
  assert.equal(imported.json.job.failures[0].item.duration_seconds, null);
  assert.match(imported.json.job.failures[0].error, /credentials_not_allowed/);
  assert.equal(JSON.stringify(imported.json).includes("user:secret"), false);
  assert.equal(JSON.stringify(imported.json).includes("duration-token"), false);

  const jobs = await call("GET", "/api/imports", null, headers);
  assert.equal(jobs.statusCode, 200);
  const storedJob = jobs.json.find((job) => job.id === imported.json.job.id);
  assert.ok(storedJob);
  assert.equal(JSON.stringify(storedJob).includes("user:secret"), false);
  assert.equal(JSON.stringify(storedJob).includes("duration-token"), false);
});

test("oversized direct uploads are rejected before persistence or quota consumption", async () => {
  withEnv({
    STIMLI_MAX_DIRECT_UPLOAD_BYTES: "4",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: "1",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: "100"
  });
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  try {
    const form = new FormData();
    form.append("asset_type", "script");
    form.append("name", "Too big");
    form.append("file", new Blob(["12345"], { type: "text/plain" }), "too-big.txt");
    const request = new Request("http://stimli.test/api/assets", {
      method: "POST",
      headers: { "x-stimli-workspace": workspace, "user-agent": "stimli-upload-limit-test" },
      body: form
    });
    const response = await onRequest({ request, env: testEnv, params: {} });
    assert.equal(response.status, 413);

    const listed = await call("GET", "/api/assets", null, { "x-stimli-workspace": workspace });
    assert.equal(listed.json.length, 0);

    const valid = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Still allowed", text: "Stop weak hooks. Try the kit today." },
      { "x-stimli-workspace": workspace, "user-agent": "stimli-upload-limit-test" }
    );
    assert.equal(valid.statusCode, 200);
  } finally {
    withEnv({
      STIMLI_MAX_DIRECT_UPLOAD_BYTES: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: undefined
    });
  }
});

test("oversized multipart text fields are rejected before persistence", async () => {
  withEnv({ STIMLI_MAX_FORM_FIELD_BYTES: "16" });
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  try {
    const form = new FormData();
    form.append("asset_type", "script");
    form.append("name", "Huge text");
    form.append("text", "x".repeat(32));
    const request = new Request("http://stimli.test/api/assets", {
      method: "POST",
      headers: { "x-stimli-workspace": workspace, "user-agent": "stimli-field-limit-test" },
      body: form
    });

    const response = await onRequest({ request, env: testEnv, params: {} });
    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.match(payload.detail, /Form field 'text' exceeds/);

    const listed = await call("GET", "/api/assets", null, { "x-stimli-workspace": workspace });
    assert.equal(listed.json.length, 0);
  } finally {
    withEnv({ STIMLI_MAX_FORM_FIELD_BYTES: undefined });
  }
});

test("oversized script JSON text is rejected before persistence or quota consumption", async () => {
  withEnv({
    STIMLI_MAX_SCRIPT_UPLOAD_TEXT_BYTES: "4",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: "1",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: "100"
  });
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  try {
    const created = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Too much JSON text", text: "hello" },
      { "x-stimli-workspace": workspace, "user-agent": "stimli-json-script-limit-test" }
    );
    assert.equal(created.statusCode, 413);
    assert.match(created.json.detail, /Script upload exceeds/);

    const listed = await call("GET", "/api/assets", null, { "x-stimli-workspace": workspace });
    assert.equal(listed.json.length, 0);

    const valid = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Still allowed", text: "ok" },
      { "x-stimli-workspace": workspace, "user-agent": "stimli-json-script-limit-test" }
    );
    assert.equal(valid.statusCode, 200);
  } finally {
    withEnv({
      STIMLI_MAX_SCRIPT_UPLOAD_TEXT_BYTES: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: undefined
    });
  }
});

test("oversized script multipart text is rejected before persistence or quota consumption", async () => {
  withEnv({
    STIMLI_MAX_SCRIPT_UPLOAD_TEXT_BYTES: "4",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: "1",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: "100"
  });
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  try {
    const form = new FormData();
    form.append("asset_type", "script");
    form.append("name", "Too much multipart text");
    form.append("text", "hello");
    const request = new Request("http://stimli.test/api/assets", {
      method: "POST",
      headers: { "x-stimli-workspace": workspace, "user-agent": "stimli-multipart-script-limit-test" },
      body: form
    });

    const response = await onRequest({ request, env: testEnv, params: {} });
    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.match(payload.detail, /Script upload exceeds/);

    const listed = await call("GET", "/api/assets", null, { "x-stimli-workspace": workspace });
    assert.equal(listed.json.length, 0);

    const valid = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Still allowed", text: "ok" },
      { "x-stimli-workspace": workspace, "user-agent": "stimli-multipart-script-limit-test" }
    );
    assert.equal(valid.statusCode, 200);
  } finally {
    withEnv({
      STIMLI_MAX_SCRIPT_UPLOAD_TEXT_BYTES: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: undefined
    });
  }
});

test("oversized script file text is rejected before persistence or quota consumption", async () => {
  withEnv({
    STIMLI_MAX_DIRECT_UPLOAD_BYTES: "64",
    STIMLI_MAX_SCRIPT_UPLOAD_TEXT_BYTES: "4",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: "1",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: "100"
  });
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  try {
    const form = new FormData();
    form.append("asset_type", "script");
    form.append("name", "Too much script text");
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "script.txt");
    const request = new Request("http://stimli.test/api/assets", {
      method: "POST",
      headers: { "x-stimli-workspace": workspace, "user-agent": "stimli-script-limit-test" },
      body: form
    });

    const response = await onRequest({ request, env: testEnv, params: {} });
    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.match(payload.detail, /Script upload exceeds/);

    const listed = await call("GET", "/api/assets", null, { "x-stimli-workspace": workspace });
    assert.equal(listed.json.length, 0);

    const valid = await call(
      "POST",
      "/api/assets",
      { asset_type: "script", name: "Still allowed", text: "ok" },
      { "x-stimli-workspace": workspace, "user-agent": "stimli-script-limit-test" }
    );
    assert.equal(valid.statusCode, 200);
  } finally {
    withEnv({
      STIMLI_MAX_DIRECT_UPLOAD_BYTES: undefined,
      STIMLI_MAX_SCRIPT_UPLOAD_TEXT_BYTES: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: undefined
    });
  }
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

test("failed remote job diagnostics are redacted before persistence", async () => {
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const jobs = new Map();
  const fakeStripeKey = `sk_live_${"1234567890abcdef"}`;
  const fakeHfToken = `hf_${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
  let jobIndex = 0;

  withEnv({ TRIBE_CONTROL_URL: "https://modal.test/control", TRIBE_API_KEY: "test-key" });
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    if (body.action === "start") {
      jobIndex += 1;
      const job = { job_id: `failed_job_${jobIndex}`, asset_id: body.asset.id, status: "queued", provider: "tribe-v2" };
      jobs.set(job.job_id, job);
      return jsonResponse(job);
    }
    if (body.action === "status") {
      return jsonResponse({
        ...jobs.get(body.job_id),
        status: "failed",
        error:
          `Failed callback https://user:pass@example.com/callback?token=abc&api_key=secret with ${fakeStripeKey} and ${fakeHfToken}`
      });
    }
    return jsonResponse({ detail: "not found" }, 404);
  };

  try {
    const first = await call("POST", "/api/assets", { asset_type: "audio", name: "Audio A", text: "Stop wasting spend." }, headers);
    const second = await call("POST", "/api/assets", { asset_type: "audio", name: "Audio B", text: "A modern solution." }, headers);
    const created = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [first.json.asset.id, second.json.asset.id], objective: "Failed job secret redaction." },
      headers
    );
    assert.equal(created.statusCode, 202);

    const failed = await call("GET", `/api/comparisons/${created.json.id}`, null, headers);
    assert.equal(failed.statusCode, 200);
    assert.equal(failed.json.status, "failed");
    assert.equal(JSON.stringify(failed.json).includes("user:pass"), false);
    assert.equal(JSON.stringify(failed.json).includes("token=abc"), false);
    assert.equal(JSON.stringify(failed.json).includes("api_key=secret"), false);
    assert.equal(JSON.stringify(failed.json).includes(fakeStripeKey), false);
    assert.equal(JSON.stringify(failed.json).includes(fakeHfToken), false);
    assert.match(failed.json.jobs[0].error, /https:\/\/\[redacted\]@example\.com/);
    assert.match(failed.json.recommendation.reasons[0], /\[redacted\]/);

    const listed = await call("GET", "/api/comparisons", null, headers);
    const stored = listed.json.find((comparison) => comparison.id === created.json.id);
    assert.ok(stored);
    assert.equal(JSON.stringify(stored).includes(fakeStripeKey), false);
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({ TRIBE_CONTROL_URL: undefined, TRIBE_API_KEY: undefined });
  }
});

test("a flaky remote that answers some variants but not others normalizes to one engine", async () => {
  // Fairness: if the inline remote answers for one variant and times out for
  // another, the whole comparison must fall back to the heuristic so variants
  // aren't scored by different engines.
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };

  resetRemoteBrainHealth();
  withEnv({ STIMLI_BRAIN_PROVIDER: "tribe-remote", TRIBE_INFERENCE_URL: "https://modal.test/inference", TRIBE_API_KEY: "k" });
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    const name = body?.asset?.name || "";
    if (name.includes("Lucky")) {
      return jsonResponse({
        timeline: [
          { second: 0, attention: 0.7, memory: 0.6, cognitive_load: 0.4 },
          { second: 3, attention: 0.8, memory: 0.7, cognitive_load: 0.45 },
          { second: 6, attention: 0.66, memory: 0.72, cognitive_load: 0.4 }
        ]
      });
    }
    return new Response("upstream down", { status: 503 });
  };

  try {
    const a = await call("POST", "/api/assets", { asset_type: "script", name: "Lucky variant", text: "Stop weak hooks. Try the starter kit today." }, headers);
    const b = await call("POST", "/api/assets", { asset_type: "script", name: "Unlucky variant", text: "A modern solution for everyone, holistic and seamless." }, headers);
    const cmp = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [a.json.asset.id, b.json.asset.id], objective: "Mixed engine test." },
      headers
    );
    assert.equal(cmp.statusCode, 200);
    assert.equal(cmp.json.status, "complete");
    const providers = new Set(cmp.json.variants.map((v) => v.analysis.provider));
    assert.equal(providers.size, 1, "all variants must share one engine");
    assert.equal([...providers][0], "web-heuristic-brain", "mixed result normalizes to the heuristic");
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({ STIMLI_BRAIN_PROVIDER: undefined, TRIBE_INFERENCE_URL: undefined, TRIBE_API_KEY: undefined });
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

test("polling a processing comparison stays consistent across repeated reads", async () => {
  const originalFetch = globalThis.fetch;
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const started = new Map();
  let jobIndex = 0;
  resetRemoteBrainHealth();
  withEnv({ TRIBE_CONTROL_URL: "https://modal.test/control", TRIBE_API_KEY: "k" });
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    if (body.action === "start") {
      jobIndex += 1;
      const job = { job_id: `poll_job_${jobIndex}`, asset_id: body.asset.id, status: "queued", provider: "tribe-v2" };
      started.set(job.job_id, job);
      return jsonResponse(job);
    }
    if (body.action === "status") {
      // Stable "running" on every poll — the job never advances.
      return jsonResponse({ ...started.get(body.job_id), status: "running" });
    }
    return jsonResponse({ detail: "not found" }, 404);
  };
  try {
    const a = await call("POST", "/api/assets", { asset_type: "audio", name: "Poll A", text: "Stop wasting spend." }, headers);
    const b = await call("POST", "/api/assets", { asset_type: "audio", name: "Poll B", text: "A modern solution." }, headers);
    const created = await call(
      "POST",
      "/api/comparisons",
      { asset_ids: [a.json.asset.id, b.json.asset.id], objective: "Poll consistency." },
      headers
    );
    assert.equal(created.statusCode, 202);

    // First read advances queued -> running (a real change, persisted); the
    // second read sees no change and returns the same state via the write-skip
    // fast path. Both must report identical processing job state.
    const first = await call("GET", `/api/comparisons/${created.json.id}`, null, headers);
    const second = await call("GET", `/api/comparisons/${created.json.id}`, null, headers);
    assert.equal(first.json.status, "processing");
    assert.equal(second.json.status, "processing");
    assert.deepEqual(
      first.json.jobs.map((job) => job.status),
      second.json.jobs.map((job) => job.status)
    );
    assert.ok(second.json.jobs.every((job) => job.status === "running"));
  } finally {
    globalThis.fetch = originalFetch;
    withEnv({ TRIBE_CONTROL_URL: undefined, TRIBE_API_KEY: undefined });
  }
});

test("cancelling a completed comparison is a no-op and preserves the result", async () => {
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace };
  const seeded = await call("POST", "/api/demo/seed", null, headers);
  // No TRIBE_CONTROL_URL is set, so text comparisons complete synchronously.
  const created = await call(
    "POST",
    "/api/comparisons",
    { asset_ids: seeded.json.slice(0, 2).map((asset) => asset.id), objective: "Should complete then resist cancel." },
    headers
  );
  assert.equal(created.statusCode, 200);
  assert.equal(created.json.status, "complete");
  const winner = created.json.recommendation.winner_asset_id;
  assert.ok(winner, "expected a winner on the completed comparison");

  const cancelled = await call("POST", `/api/comparisons/${created.json.id}/cancel`, null, headers);
  assert.equal(cancelled.statusCode, 200);
  // The completed result must survive — cancel must not wipe status or winner.
  assert.equal(cancelled.json.status, "complete");
  assert.equal(cancelled.json.recommendation.winner_asset_id, winner);

  // And the stored comparison is still complete on a fresh read.
  const reread = await call("GET", `/api/comparisons/${created.json.id}`, null, headers);
  assert.equal(reread.json.status, "complete");
  assert.equal(reread.json.recommendation.winner_asset_id, winner);
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
    // Hourly throttle responses carry a Retry-After hint derived from the window.
    assert.ok(Number(blocked.headers["retry-after"]) > 0, "expected a positive Retry-After header");
  } finally {
    withEnv({ STIMLI_COMPARISON_LIMIT_PER_HOUR: undefined });
  }
});

test("rate limiting prefers Cloudflare client IP over spoofable forwarded headers", async () => {
  withEnv({ STIMLI_COMPARISON_LIMIT_PER_HOUR: "1" });
  const workspaceA = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const workspaceB = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const base = { "cf-connecting-ip": "203.0.113.77", "user-agent": "stimli-cf-rate-test" };
  const headersA = { ...base, "x-stimli-workspace": workspaceA, "x-forwarded-for": "198.51.100.1" };
  const headersB = { ...base, "x-stimli-workspace": workspaceB, "x-forwarded-for": "198.51.100.2" };

  try {
    const a1 = await call("POST", "/api/assets", { asset_type: "script", name: "A1", text: "Stop weak hooks. Try the kit today." }, headersA);
    const a2 = await call("POST", "/api/assets", { asset_type: "script", name: "A2", text: "Compare variants before launch." }, headersA);
    const b1 = await call("POST", "/api/assets", { asset_type: "script", name: "B1", text: "Stop weak hooks. Try the kit today." }, headersB);
    const b2 = await call("POST", "/api/assets", { asset_type: "script", name: "B2", text: "Compare variants before launch." }, headersB);
    assert.equal(a1.statusCode, 200);
    assert.equal(a2.statusCode, 200);
    assert.equal(b1.statusCode, 200);
    assert.equal(b2.statusCode, 200);

    const allowed = await call("POST", "/api/comparisons", { asset_ids: [a1.json.asset.id, a2.json.asset.id], objective: "First client comparison." }, headersA);
    const blocked = await call("POST", "/api/comparisons", { asset_ids: [b1.json.asset.id, b2.json.asset.id], objective: "Same CF client should be blocked." }, headersB);

    assert.equal(allowed.statusCode, 200);
    assert.equal(blocked.statusCode, 429);
  } finally {
    withEnv({ STIMLI_COMPARISON_LIMIT_PER_HOUR: undefined });
  }
});

test("project and brand-profile creation are rate limited per client", async () => {
  withEnv({ STIMLI_PROJECT_LIMIT_PER_HOUR: "2", STIMLI_BRAND_PROFILE_LIMIT_PER_HOUR: "2" });
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace, "cf-connecting-ip": "203.0.113.91", "user-agent": "stimli-create-rate-test" };
  try {
    assert.equal((await call("POST", "/api/projects", { name: "Project One" }, headers)).statusCode, 200);
    assert.equal((await call("POST", "/api/projects", { name: "Project Two" }, headers)).statusCode, 200);
    const blockedProject = await call("POST", "/api/projects", { name: "Project Three" }, headers);
    assert.equal(blockedProject.statusCode, 429);
    assert.equal(blockedProject.json.code, "rate_limited");
    assert.ok(Number(blockedProject.headers["retry-after"]) > 0);

    assert.equal((await call("POST", "/api/brand-profiles", { name: "Brand One" }, headers)).statusCode, 200);
    assert.equal((await call("POST", "/api/brand-profiles", { name: "Brand Two" }, headers)).statusCode, 200);
    const blockedBrand = await call("POST", "/api/brand-profiles", { name: "Brand Three" }, headers);
    assert.equal(blockedBrand.statusCode, 429);
    assert.equal(blockedBrand.json.code, "rate_limited");
  } finally {
    withEnv({ STIMLI_PROJECT_LIMIT_PER_HOUR: undefined, STIMLI_BRAND_PROFILE_LIMIT_PER_HOUR: undefined });
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

test("imports consume asset quota per imported asset", async () => {
  withEnv({
    STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: "1",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: "100"
  });
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace, "user-agent": "stimli-import-quota-test" };
  try {
    const imported = await call(
      "POST",
      "/api/imports",
      {
        platform: "csv",
        source: "quota-test",
        items: [
          { asset_type: "script", name: "Import quota A", text: "Stop weak hooks. Try the starter kit today." },
          { asset_type: "script", name: "Import quota B", text: "Compare variants before spend." }
        ]
      },
      headers
    );

    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json.job.status, "partial");
    assert.equal(imported.json.assets.length, 1);
    assert.equal(imported.json.job.failed_items, 1);
    assert.match(imported.json.job.failures[0].error, /Monthly asset quota reached/);
  } finally {
    withEnv({
      STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: undefined
    });
  }
});

test("failed import rows do not consume asset quota", async () => {
  withEnv({
    STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: "1",
    STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: "100"
  });
  const workspace = `ws_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const headers = { "x-stimli-workspace": workspace, "user-agent": "stimli-import-invalid-quota-test" };
  try {
    const failed = await call(
      "POST",
      "/api/imports",
      {
        platform: "csv",
        source: "invalid-quota-test",
        items: [{ asset_type: "script", name: "Bad import", text: "Should fail before quota.", duration_seconds: "nope" }]
      },
      headers
    );

    assert.equal(failed.statusCode, 200);
    assert.equal(failed.json.job.status, "failed");
    assert.equal(failed.json.assets.length, 0);
    assert.match(failed.json.job.failures[0].error, /duration_seconds must be a non-negative number/i);
    assert.equal(await countUsageEvents({ kind: "asset", workspaceId: workspace }), 0);

    const imported = await call(
      "POST",
      "/api/imports",
      {
        platform: "csv",
        source: "invalid-quota-test",
        items: [{ asset_type: "script", name: "Good import", text: "This valid row should still fit." }]
      },
      headers
    );

    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json.job.status, "complete");
    assert.equal(imported.json.assets.length, 1);
  } finally {
    withEnv({
      STIMLI_RESEARCH_ASSET_LIMIT_PER_MONTH: undefined,
      STIMLI_RESEARCH_ASSET_LIMIT_PER_HOUR: undefined
    });
  }
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

test("brand profile create ignores client ids and cannot steal another workspace profile", async () => {
  const ownerA = await testAccount("Brand Workspace A", "owner");
  const ownerB = await testAccount("Brand Workspace B", "owner");
  const suppliedId = `brand_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

  const createdA = await call(
    "POST",
    "/api/brand-profiles",
    { id: suppliedId, name: "Workspace A Brand", brief: { audience: "A buyers" } },
    { cookie: ownerA.cookie }
  );
  assert.equal(createdA.statusCode, 200);
  assert.notEqual(createdA.json.id, suppliedId);

  const createdB = await call(
    "POST",
    "/api/brand-profiles",
    { id: createdA.json.id, name: "Workspace B Brand", brief: { audience: "B buyers" } },
    { cookie: ownerB.cookie }
  );
  assert.equal(createdB.statusCode, 200);
  assert.notEqual(createdB.json.id, createdA.json.id);

  const fetchedA = await call("GET", `/api/brand-profiles/${createdA.json.id}`, null, { cookie: ownerA.cookie });
  assert.equal(fetchedA.statusCode, 200);
  assert.equal(fetchedA.json.name, "Workspace A Brand");
  assert.equal(fetchedA.json.workspace_id, ownerA.team.id);

  const blockedCrossRead = await call("GET", `/api/brand-profiles/${createdA.json.id}`, null, { cookie: ownerB.cookie });
  assert.equal(blockedCrossRead.statusCode, 404);
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

function sha256HexSync(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
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
