import postgres from "postgres";

const memoryStore = (globalThis.__stimliMemoryStore ??= {
  assets: new Map(),
  comparisons: new Map(),
  outcomes: new Map(),
  usageEvents: new Map()
});

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
let sqlClient;
let initPromise;

export function storageHealth() {
  return {
    mode: databaseUrl ? "postgres" : "memory",
    persistent: Boolean(databaseUrl),
    detail: databaseUrl
      ? "Persistent database is configured."
      : "Using warm-function memory. Add POSTGRES_URL or DATABASE_URL for production persistence."
  };
}

export async function saveAsset(asset) {
  const sql = getSql();
  const workspaceId = workspaceForPayload(asset);
  if (!sql) {
    memoryStore.assets.set(asset.id, asset);
    return asset;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_assets (id, workspace_id, payload, created_at)
    values (${asset.id}, ${workspaceId}, ${sql.json(asset)}, ${asset.created_at})
    on conflict (id) do update
    set workspace_id = excluded.workspace_id,
        payload = excluded.payload,
        created_at = excluded.created_at
  `;
  return asset;
}

export async function listAssets(workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.assets.values()].filter((asset) => workspaceForPayload(asset) === workspaceId).sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_assets where workspace_id = ${workspaceId} order by created_at desc`;
  return rows.map((row) => row.payload);
}

export async function getAsset(assetId, workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    const asset = memoryStore.assets.get(assetId) || null;
    return asset && workspaceForPayload(asset) === workspaceId ? asset : null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_assets where id = ${assetId} and workspace_id = ${workspaceId} limit 1`;
  return rows[0]?.payload || null;
}

export async function saveComparison(comparison) {
  const sql = getSql();
  const workspaceId = workspaceForPayload(comparison);
  if (!sql) {
    memoryStore.comparisons.set(comparison.id, comparison);
    return comparison;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_comparisons (id, workspace_id, payload, created_at)
    values (${comparison.id}, ${workspaceId}, ${sql.json(comparison)}, ${comparison.created_at})
    on conflict (id) do update
    set workspace_id = excluded.workspace_id,
        payload = excluded.payload,
        created_at = excluded.created_at
  `;
  return comparison;
}

export async function listComparisons(workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.comparisons.values()].filter((comparison) => workspaceForPayload(comparison) === workspaceId).sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_comparisons where workspace_id = ${workspaceId} order by created_at desc`;
  return rows.map((row) => row.payload);
}

export async function getComparison(comparisonId, workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    const comparison = memoryStore.comparisons.get(comparisonId) || null;
    return comparison && workspaceForPayload(comparison) === workspaceId ? comparison : null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_comparisons where id = ${comparisonId} and workspace_id = ${workspaceId} limit 1`;
  return rows[0]?.payload || null;
}

export async function saveOutcome(outcome) {
  const sql = getSql();
  const workspaceId = workspaceForPayload(outcome);
  if (!sql) {
    memoryStore.outcomes.set(outcome.id, outcome);
    return outcome;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_outcomes (id, workspace_id, comparison_id, asset_id, payload, created_at)
    values (${outcome.id}, ${workspaceId}, ${outcome.comparison_id}, ${outcome.asset_id}, ${sql.json(outcome)}, ${outcome.created_at})
    on conflict (id) do update
    set workspace_id = excluded.workspace_id,
        comparison_id = excluded.comparison_id,
        asset_id = excluded.asset_id,
        payload = excluded.payload,
        created_at = excluded.created_at
  `;
  return outcome;
}

export async function listOutcomes(comparisonId = null, workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    const outcomes = [...memoryStore.outcomes.values()];
    return outcomes
      .filter((outcome) => workspaceForPayload(outcome) === workspaceId)
      .filter((outcome) => !comparisonId || outcome.comparison_id === comparisonId)
      .sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = comparisonId
    ? await sql`select payload from stimli_outcomes where comparison_id = ${comparisonId} and workspace_id = ${workspaceId} order by created_at desc`
    : await sql`select payload from stimli_outcomes where workspace_id = ${workspaceId} order by created_at desc`;
  return rows.map((row) => row.payload);
}

export async function saveUsageEvent(event) {
  const sql = getSql();
  if (!sql) {
    memoryStore.usageEvents.set(event.id, event);
    return event;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_usage_events (id, workspace_id, bucket_key, kind, payload, created_at)
    values (${event.id}, ${event.workspace_id}, ${event.bucket_key}, ${event.kind}, ${sql.json(event)}, ${event.created_at})
    on conflict (id) do nothing
  `;
  return event;
}

export async function countUsageEvents({ kind, since, workspaceId = null, bucketKey = null }) {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.usageEvents.values()].filter((event) => {
      if (event.kind !== kind || event.created_at < since) {
        return false;
      }
      if (workspaceId && event.workspace_id !== workspaceId) {
        return false;
      }
      if (bucketKey && event.bucket_key !== bucketKey) {
        return false;
      }
      return true;
    }).length;
  }
  await ensureTables(sql);
  if (workspaceId && bucketKey) {
    const rows = await sql`
      select count(*)::int as count from stimli_usage_events
      where kind = ${kind} and created_at >= ${since} and workspace_id = ${workspaceId} and bucket_key = ${bucketKey}
    `;
    return rows[0]?.count || 0;
  }
  if (workspaceId) {
    const rows = await sql`
      select count(*)::int as count from stimli_usage_events
      where kind = ${kind} and created_at >= ${since} and workspace_id = ${workspaceId}
    `;
    return rows[0]?.count || 0;
  }
  if (bucketKey) {
    const rows = await sql`
      select count(*)::int as count from stimli_usage_events
      where kind = ${kind} and created_at >= ${since} and bucket_key = ${bucketKey}
    `;
    return rows[0]?.count || 0;
  }
  const rows = await sql`
    select count(*)::int as count from stimli_usage_events
    where kind = ${kind} and created_at >= ${since}
  `;
  return rows[0]?.count || 0;
}

function getSql() {
  if (!databaseUrl) {
    return null;
  }
  sqlClient ??= postgres(databaseUrl, {
    max: 1,
    prepare: false,
    ssl: databaseUrl.includes("sslmode=disable") ? false : "require"
  });
  return sqlClient;
}

async function ensureTables(sql) {
  initPromise ??= sql.begin(async (tx) => {
    await tx`
      create table if not exists stimli_assets (
        id text primary key,
        workspace_id text not null default 'public',
        payload jsonb not null,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_comparisons (
        id text primary key,
        workspace_id text not null default 'public',
        payload jsonb not null,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_outcomes (
        id text primary key,
        workspace_id text not null default 'public',
        comparison_id text not null,
        asset_id text not null,
        payload jsonb not null,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_usage_events (
        id text primary key,
        workspace_id text not null default 'public',
        bucket_key text not null,
        kind text not null,
        payload jsonb not null,
        created_at text not null
      )
    `;
    await tx`alter table stimli_assets add column if not exists workspace_id text not null default 'public'`;
    await tx`alter table stimli_comparisons add column if not exists workspace_id text not null default 'public'`;
    await tx`alter table stimli_outcomes add column if not exists workspace_id text not null default 'public'`;
    await tx`alter table stimli_usage_events add column if not exists workspace_id text not null default 'public'`;
    await tx`create index if not exists stimli_assets_workspace_idx on stimli_assets (workspace_id, created_at desc)`;
    await tx`create index if not exists stimli_comparisons_workspace_idx on stimli_comparisons (workspace_id, created_at desc)`;
    await tx`create index if not exists stimli_outcomes_workspace_idx on stimli_outcomes (workspace_id, created_at desc)`;
    await tx`create index if not exists stimli_outcomes_comparison_idx on stimli_outcomes (comparison_id)`;
    await tx`create index if not exists stimli_usage_workspace_idx on stimli_usage_events (workspace_id, kind, created_at desc)`;
    await tx`create index if not exists stimli_usage_bucket_idx on stimli_usage_events (bucket_key, kind, created_at desc)`;
  });
  return initPromise;
}

function workspaceForPayload(payload) {
  return payload.workspace_id || "public";
}

function descCreatedAt(a, b) {
  return String(b.created_at).localeCompare(String(a.created_at));
}
