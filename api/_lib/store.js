import postgres from "postgres";

const memoryStore = (globalThis.__stimliMemoryStore ??= {
  assets: new Map(),
  comparisons: new Map(),
  outcomes: new Map()
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
  if (!sql) {
    memoryStore.assets.set(asset.id, asset);
    return asset;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_assets (id, payload, created_at)
    values (${asset.id}, ${sql.json(asset)}, ${asset.created_at})
    on conflict (id) do update
    set payload = excluded.payload, created_at = excluded.created_at
  `;
  return asset;
}

export async function listAssets() {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.assets.values()].sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_assets order by created_at desc`;
  return rows.map((row) => row.payload);
}

export async function getAsset(assetId) {
  const sql = getSql();
  if (!sql) {
    return memoryStore.assets.get(assetId) || null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_assets where id = ${assetId} limit 1`;
  return rows[0]?.payload || null;
}

export async function saveComparison(comparison) {
  const sql = getSql();
  if (!sql) {
    memoryStore.comparisons.set(comparison.id, comparison);
    return comparison;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_comparisons (id, payload, created_at)
    values (${comparison.id}, ${sql.json(comparison)}, ${comparison.created_at})
    on conflict (id) do update
    set payload = excluded.payload, created_at = excluded.created_at
  `;
  return comparison;
}

export async function listComparisons() {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.comparisons.values()].sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_comparisons order by created_at desc`;
  return rows.map((row) => row.payload);
}

export async function getComparison(comparisonId) {
  const sql = getSql();
  if (!sql) {
    return memoryStore.comparisons.get(comparisonId) || null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_comparisons where id = ${comparisonId} limit 1`;
  return rows[0]?.payload || null;
}

export async function saveOutcome(outcome) {
  const sql = getSql();
  if (!sql) {
    memoryStore.outcomes.set(outcome.id, outcome);
    return outcome;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_outcomes (id, comparison_id, asset_id, payload, created_at)
    values (${outcome.id}, ${outcome.comparison_id}, ${outcome.asset_id}, ${sql.json(outcome)}, ${outcome.created_at})
    on conflict (id) do update
    set comparison_id = excluded.comparison_id,
        asset_id = excluded.asset_id,
        payload = excluded.payload,
        created_at = excluded.created_at
  `;
  return outcome;
}

export async function listOutcomes(comparisonId = null) {
  const sql = getSql();
  if (!sql) {
    const outcomes = [...memoryStore.outcomes.values()];
    return outcomes.filter((outcome) => !comparisonId || outcome.comparison_id === comparisonId).sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = comparisonId
    ? await sql`select payload from stimli_outcomes where comparison_id = ${comparisonId} order by created_at desc`
    : await sql`select payload from stimli_outcomes order by created_at desc`;
  return rows.map((row) => row.payload);
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
        payload jsonb not null,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_comparisons (
        id text primary key,
        payload jsonb not null,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_outcomes (
        id text primary key,
        comparison_id text not null,
        asset_id text not null,
        payload jsonb not null,
        created_at text not null
      )
    `;
    await tx`create index if not exists stimli_outcomes_comparison_idx on stimli_outcomes (comparison_id)`;
  });
  return initPromise;
}

function descCreatedAt(a, b) {
  return String(b.created_at).localeCompare(String(a.created_at));
}
