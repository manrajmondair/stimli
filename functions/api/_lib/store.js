// Persistence layer for the Stimli API.
//
// Uses @neondatabase/serverless (HTTP transport) so it runs in the Cloudflare
// Workers runtime without raw TCP. JSONB columns are written with
// ${JSON.stringify(x)}::jsonb (the tagged-template helper doesn't expose a
// .json() method). configureStore(env) is called once per request from the
// Pages Function entry so the module-level connection picks up POSTGRES_URL.
// ensureTables batches idempotent bootstrap statements through Neon's HTTP
// transport and records a schema version once heavier backfills have run. When
// no POSTGRES_URL is configured, the store falls back to globalThis-scoped
// in-memory maps so tests and dev sessions work offline.

import { neon } from "@neondatabase/serverless";

const memoryStore = (globalThis.__stimliMemoryStore ??= {
  assets: new Map(),
  comparisons: new Map(),
  outcomes: new Map(),
  projects: new Map(),
  usageEvents: new Map(),
  users: new Map(),
  teams: new Map(),
  teamMembers: new Map(),
  teamInvites: new Map(),
  authenticators: new Map(),
  authChallenges: new Map(),
  sessions: new Map(),
  shareLinks: new Map(),
  auditEvents: new Map(),
  brandProfiles: new Map(),
  governanceRequests: new Map(),
  benchmarkRuns: new Map(),
  integrationJobs: new Map(),
  subscriptions: new Map(),
  billingEvents: new Map()
});

let _databaseUrl = "";
let _sqlClient = null;
let _initPromise = null;
const STORE_SCHEMA_VERSION = "2026-06-04-production-bootstrap-v2";
const STORE_INDEX_VERSION = "2026-06-04-production-indexes-v1";

export function configureStore(env) {
  const url = env?.POSTGRES_URL || env?.DATABASE_URL || "";
  if (url === _databaseUrl) return;
  _databaseUrl = url;
  _sqlClient = url ? neon(url, { fullResults: false }) : null;
  _initPromise = null;
}

export function storageHealth() {
  return {
    mode: _databaseUrl ? "postgres" : "memory",
    persistent: Boolean(_databaseUrl),
    detail: _databaseUrl
      ? "Persistent database is configured."
      : "Using warm-isolate memory. Add POSTGRES_URL to the Pages project for production persistence."
  };
}

function getSql() {
  return _sqlClient;
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
    values (${asset.id}, ${workspaceId}, ${JSON.stringify(asset)}::jsonb, ${asset.created_at})
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

export async function deleteAsset(assetId, workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    const asset = memoryStore.assets.get(assetId) || null;
    if (!asset || workspaceForPayload(asset) !== workspaceId) return false;
    memoryStore.assets.delete(assetId);
    return true;
  }
  await ensureTables(sql);
  const rows = await sql`delete from stimli_assets where id = ${assetId} and workspace_id = ${workspaceId} returning id`;
  return rows.length > 0;
}

export async function saveProject(project) {
  const sql = getSql();
  const workspaceId = workspaceForPayload(project);
  if (!sql) {
    memoryStore.projects.set(project.id, project);
    return project;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_projects (id, workspace_id, payload, created_at)
    values (${project.id}, ${workspaceId}, ${JSON.stringify(project)}::jsonb, ${project.created_at})
    on conflict (id) do update
    set workspace_id = excluded.workspace_id,
        payload = excluded.payload,
        created_at = excluded.created_at
  `;
  return project;
}

export async function listProjects(workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.projects.values()].filter((project) => workspaceForPayload(project) === workspaceId).sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_projects where workspace_id = ${workspaceId} order by created_at desc`;
  return rows.map((row) => row.payload);
}

export async function getProject(projectId, workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    const project = memoryStore.projects.get(projectId) || null;
    return project && workspaceForPayload(project) === workspaceId ? project : null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_projects where id = ${projectId} and workspace_id = ${workspaceId} limit 1`;
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
    values (${comparison.id}, ${workspaceId}, ${JSON.stringify(comparison)}::jsonb, ${comparison.created_at})
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

export async function deleteComparison(comparisonId, workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    const comparison = memoryStore.comparisons.get(comparisonId) || null;
    if (!comparison || workspaceForPayload(comparison) !== workspaceId) return false;
    memoryStore.comparisons.delete(comparisonId);
    // Cascade: drop the comparison's outcomes and share links so nothing dangles.
    for (const [id, outcome] of memoryStore.outcomes.entries()) {
      if (outcome.comparison_id === comparisonId) memoryStore.outcomes.delete(id);
    }
    for (const [token, link] of memoryStore.shareLinks.entries()) {
      if (link.comparison_id === comparisonId) memoryStore.shareLinks.delete(token);
    }
    return true;
  }
  await ensureTables(sql);
  const rows = await sql`
    with deleted as (
      delete from stimli_comparisons
      where id = ${comparisonId} and workspace_id = ${workspaceId}
      returning id
    ),
    deleted_outcomes as (
      delete from stimli_outcomes
      where comparison_id in (select id from deleted) and workspace_id = ${workspaceId}
      returning id
    ),
    deleted_share_links as (
      delete from stimli_share_links
      where comparison_id in (select id from deleted) and workspace_id = ${workspaceId}
      returning token
    )
    select exists(select 1 from deleted) as deleted
  `;
  return Boolean(rows[0]?.deleted);
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
    values (${outcome.id}, ${workspaceId}, ${outcome.comparison_id}, ${outcome.asset_id}, ${JSON.stringify(outcome)}::jsonb, ${outcome.created_at})
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

export async function countUsageEvents({ kind, since, workspaceId = null, bucketKey = null }) {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.usageEvents.values()].reduce((total, event) => {
      if (event.kind !== kind || event.created_at < since) {
        return total;
      }
      if (workspaceId && event.workspace_id !== workspaceId) {
        return total;
      }
      if (bucketKey && event.bucket_key !== bucketKey) {
        return total;
      }
      return total + usageUnits(event);
    }, 0);
  }
  await ensureTables(sql);
  if (workspaceId && bucketKey) {
    const rows = await sql`
      select coalesce(sum(case when payload ? 'units' and payload->>'units' ~ '^[0-9]+$' then greatest((payload->>'units')::int, 1) else 1 end), 0)::int as count
      from stimli_usage_events
      where kind = ${kind} and created_at >= ${since} and workspace_id = ${workspaceId} and bucket_key = ${bucketKey}
    `;
    return rows[0]?.count || 0;
  }
  if (workspaceId) {
    const rows = await sql`
      select coalesce(sum(case when payload ? 'units' and payload->>'units' ~ '^[0-9]+$' then greatest((payload->>'units')::int, 1) else 1 end), 0)::int as count
      from stimli_usage_events
      where kind = ${kind} and created_at >= ${since} and workspace_id = ${workspaceId}
    `;
    return rows[0]?.count || 0;
  }
  if (bucketKey) {
    const rows = await sql`
      select coalesce(sum(case when payload ? 'units' and payload->>'units' ~ '^[0-9]+$' then greatest((payload->>'units')::int, 1) else 1 end), 0)::int as count
      from stimli_usage_events
      where kind = ${kind} and created_at >= ${since} and bucket_key = ${bucketKey}
    `;
    return rows[0]?.count || 0;
  }
  const rows = await sql`
    select coalesce(sum(case when payload ? 'units' and payload->>'units' ~ '^[0-9]+$' then greatest((payload->>'units')::int, 1) else 1 end), 0)::int as count
    from stimli_usage_events
    where kind = ${kind} and created_at >= ${since}
  `;
  return rows[0]?.count || 0;
}

// Atomically records a usage event only if all provided limits still have
// headroom. The SQL path takes transaction-scoped advisory locks for the
// workspace and client buckets before running the conditional INSERT, so
// concurrent requests at the same quota boundary serialize. Returns true if
// recorded, false if a limit blocked it. Disabled tiers should pass a huge
// limit so they never block.
export async function saveUsageEventConditional(event, limits) {
  const { workspaceId, bucketKey, monthlySince, monthlyLimit, hourlySince, hourlyLimit } = limits;
  const units = usageUnits(event);
  const sql = getSql();
  if (!sql) {
    // Memory mode is single-threaded in tests, so count-then-insert is race-free.
    const countSince = (since, field, value) =>
      [...memoryStore.usageEvents.values()].reduce(
        (total, e) => e.kind === event.kind && e.created_at >= since && e[field] === value ? total + usageUnits(e) : total,
        0
      );
    if (countSince(monthlySince, "workspace_id", workspaceId) + units > monthlyLimit) return false;
    if (countSince(hourlySince, "workspace_id", workspaceId) + units > hourlyLimit) return false;
    if (countSince(hourlySince, "bucket_key", bucketKey) + units > hourlyLimit) return false;
    // Persist workspace_id/bucket_key on the stored row so later counts (quota
    // checks, /billing/usage) can filter on them — the SQL path sets these as
    // columns from the same limits.
    memoryStore.usageEvents.set(event.id, { ...event, workspace_id: workspaceId, bucket_key: bucketKey });
    return true;
  }
  await ensureTables(sql);
  const lockKeys = [
    `stimli:usage:${event.kind}:workspace:${workspaceId}`,
    `stimli:usage:${event.kind}:bucket:${bucketKey}`
  ].filter(Boolean).sort();
  const insertQuery = sql`
    insert into stimli_usage_events (id, workspace_id, bucket_key, kind, payload, created_at)
    select ${event.id}, ${workspaceId}, ${bucketKey}, ${event.kind}, ${JSON.stringify(event.payload || {})}::jsonb, ${event.created_at}
    where (
        select coalesce(sum(case when payload ? 'units' and payload->>'units' ~ '^[0-9]+$' then greatest((payload->>'units')::int, 1) else 1 end), 0)::int
        from stimli_usage_events
        where workspace_id = ${workspaceId} and kind = ${event.kind} and created_at >= ${monthlySince}
      ) + ${units} <= ${monthlyLimit}
      and (
        select coalesce(sum(case when payload ? 'units' and payload->>'units' ~ '^[0-9]+$' then greatest((payload->>'units')::int, 1) else 1 end), 0)::int
        from stimli_usage_events
        where workspace_id = ${workspaceId} and kind = ${event.kind} and created_at >= ${hourlySince}
      ) + ${units} <= ${hourlyLimit}
      and (
        select coalesce(sum(case when payload ? 'units' and payload->>'units' ~ '^[0-9]+$' then greatest((payload->>'units')::int, 1) else 1 end), 0)::int
        from stimli_usage_events
        where bucket_key = ${bucketKey} and kind = ${event.kind} and created_at >= ${hourlySince}
      ) + ${units} <= ${hourlyLimit}
    returning id
  `;
  const results = await sql.transaction([
    ...lockKeys.map((key) => sql`select pg_advisory_xact_lock(786271, hashtext(${key}))`),
    insertQuery
  ]);
  const rows = results[results.length - 1] || [];
  return rows.length > 0;
}

function usageUnits(event) {
  const units = Number(event?.payload?.units);
  return Number.isFinite(units) && units > 0 ? Math.max(1, Math.floor(units)) : 1;
}

export async function saveUser(user) {
  const sql = getSql();
  if (!sql) {
    memoryStore.users.set(user.id, user);
    return user;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_users (id, email, name, payload, created_at)
    values (${user.id}, ${user.email}, ${user.name}, ${JSON.stringify(user)}::jsonb, ${user.created_at})
    on conflict (id) do update
    set email = excluded.email,
        name = excluded.name,
        payload = excluded.payload
  `;
  return user;
}

export async function getUser(userId) {
  const sql = getSql();
  if (!sql) {
    return memoryStore.users.get(userId) || null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_users where id = ${userId} limit 1`;
  return rows[0]?.payload || null;
}

export async function getUserByEmail(email) {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.users.values()].find((user) => user.email === email) || null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_users where email = ${email} limit 1`;
  return rows[0]?.payload || null;
}

// Move an existing user row (matched by `oldId`) onto `newId` and cascade to
// the only foreign-key-like reference we care about for auth (team
// memberships). The audit log keeps its historical actor_id values — those
// are append-only history, not consulted for live access control.
//
// Why this exists: when the auth backend switched from passkeys to Clerk,
// stimli_users rows already existed keyed by the legacy id. On the next sign
// in we see a Clerk user id that doesn't match anything in the table; the
// email lookup finds the existing row, and we want to attach the row to the
// Clerk id so subsequent direct lookups by id succeed.
export async function rebindUserId(oldId, newId, patch = {}) {
  if (!oldId || !newId || oldId === newId) {
    return await getUser(newId);
  }
  const sql = getSql();
  if (!sql) {
    const existing = memoryStore.users.get(oldId);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id: newId };
    memoryStore.users.delete(oldId);
    memoryStore.users.set(newId, updated);
    // The teamMembers map keys on `${team_id}:${user_id}`, so we have to
    // re-key any matching rows rather than mutating their user_id in place.
    const reKeys = [];
    for (const [key, member] of memoryStore.teamMembers.entries()) {
      if (member.user_id === oldId) reKeys.push({ key, member });
    }
    for (const { key, member } of reKeys) {
      memoryStore.teamMembers.delete(key);
      const next = { ...member, user_id: newId };
      memoryStore.teamMembers.set(`${next.team_id}:${newId}`, next);
    }
    return updated;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_users where id = ${oldId} limit 1`;
  const existing = rows[0]?.payload;
  if (!existing) return null;
  const updated = { ...existing, ...patch, id: newId };
  await sql.transaction([
    sql`select pg_advisory_xact_lock(786271, hashtext(${`stimli:user-rebind:${oldId}:${newId}`}))`,
    sql`
    update stimli_users
    set id = ${newId},
        name = ${updated.name},
        payload = ${JSON.stringify(updated)}::jsonb
    where id = ${oldId}
    `,
    sql`
      update stimli_team_members old_member
      set user_id = ${newId},
          payload = payload || ${JSON.stringify({ user_id: newId })}::jsonb
      where old_member.user_id = ${oldId}
        and not exists (
          select 1
          from stimli_team_members current_member
          where current_member.team_id = old_member.team_id
            and current_member.user_id = ${newId}
        )
    `,
    sql`
      delete from stimli_team_members old_member
      where old_member.user_id = ${oldId}
        and exists (
          select 1
          from stimli_team_members current_member
          where current_member.team_id = old_member.team_id
            and current_member.user_id = ${newId}
        )
    `
  ]);
  return updated;
}

export async function saveTeam(team) {
  const sql = getSql();
  if (!sql) {
    memoryStore.teams.set(team.id, team);
    return team;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_teams (id, name, payload, created_at)
    values (${team.id}, ${team.name}, ${JSON.stringify(team)}::jsonb, ${team.created_at})
    on conflict (id) do update
    set name = excluded.name,
        payload = excluded.payload
  `;
  return team;
}

export async function getTeam(teamId) {
  const sql = getSql();
  if (!sql) {
    return memoryStore.teams.get(teamId) || null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_teams where id = ${teamId} limit 1`;
  return rows[0]?.payload || null;
}

export async function saveTeamMember(member) {
  const sql = getSql();
  const key = `${member.team_id}:${member.user_id}`;
  if (!sql) {
    memoryStore.teamMembers.set(key, member);
    return member;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_team_members (team_id, user_id, role, payload, created_at)
    values (${member.team_id}, ${member.user_id}, ${member.role}, ${JSON.stringify(member)}::jsonb, ${member.created_at})
    on conflict (team_id, user_id) do update
    set role = excluded.role,
        payload = excluded.payload
  `;
  return member;
}

export async function ensureTeamWithOwner(team, member) {
  const sql = getSql();
  const key = `${member.team_id}:${member.user_id}`;
  if (!sql) {
    const existing = [...memoryStore.teamMembers.values()]
      .filter((candidate) => candidate.user_id === member.user_id)
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
      .map((candidate) => memoryStore.teams.get(candidate.team_id))
      .find(Boolean);
    if (existing) return existing;
    memoryStore.teams.set(team.id, team);
    memoryStore.teamMembers.set(key, member);
    return team;
  }
  await ensureTables(sql);
  const mutation = sql`
    with existing as (
      select t.payload as team_payload
      from stimli_team_members m
      join stimli_teams t on t.id = m.team_id
      where m.user_id = ${member.user_id}
      order by m.created_at asc
      limit 1
    ),
    inserted_team as (
      insert into stimli_teams (id, name, payload, created_at)
      select ${team.id}, ${team.name}, ${JSON.stringify(team)}::jsonb, ${team.created_at}
      where not exists (select 1 from existing)
      on conflict (id) do nothing
      returning payload
    ),
    inserted_member as (
      insert into stimli_team_members (team_id, user_id, role, payload, created_at)
      select ${member.team_id}, ${member.user_id}, ${member.role}, ${JSON.stringify(member)}::jsonb, ${member.created_at}
      where exists (select 1 from inserted_team)
      on conflict (team_id, user_id) do nothing
      returning payload
    )
    select
      coalesce((select team_payload from existing limit 1), (select payload from inserted_team limit 1)) as team_payload,
      (select count(*)::int from inserted_member) as inserted_member_count
  `;
  const results = await sql.transaction([
    sql`select pg_advisory_xact_lock(786271, hashtext(${`stimli:personal-team:${member.user_id}`}))`,
    mutation
  ]);
  const row = results[1]?.[0] || {};
  return row.team_payload || (await listTeamsForUser(member.user_id))[0] || null;
}

export async function getTeamMember(teamId, userId) {
  const sql = getSql();
  const key = `${teamId}:${userId}`;
  if (!sql) {
    return memoryStore.teamMembers.get(key) || null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_team_members where team_id = ${teamId} and user_id = ${userId} limit 1`;
  return rows[0]?.payload || null;
}

export async function updateTeamMemberRole(teamId, userId, role) {
  const updatedAt = new Date().toISOString();
  const sql = getSql();
  const key = `${teamId}:${userId}`;
  if (!sql) {
    const member = memoryStore.teamMembers.get(key) || null;
    if (!member) {
      return { member: null, blocked_last_owner: false };
    }
    if (role !== "owner" && member.role === "owner" && countTeamOwnersInMemory(teamId) <= 1) {
      return { member, blocked_last_owner: true };
    }
    const updated = { ...member, role, updated_at: updatedAt };
    memoryStore.teamMembers.set(key, updated);
    return { member: updated, blocked_last_owner: false };
  }
  await ensureTables(sql);
  const mutation = sql`
    with target as (
      select role from stimli_team_members where team_id = ${teamId} and user_id = ${userId}
    ),
    owner_count as (
      select count(*)::int as count from stimli_team_members where team_id = ${teamId} and role = 'owner'
    ),
    updated as (
      update stimli_team_members
      set role = ${role},
          payload = payload || ${JSON.stringify({ role, updated_at: updatedAt })}::jsonb
      where team_id = ${teamId}
        and user_id = ${userId}
        and not (
          ${role !== "owner"}
          and exists (select 1 from target where role = 'owner')
          and (select count from owner_count) <= 1
        )
      returning payload
    )
    select
      (select count(*)::int from target) as target_count,
      (
        ${role !== "owner"}
        and exists (select 1 from target where role = 'owner')
        and (select count from owner_count) <= 1
      ) as blocked_last_owner,
      (select payload from updated limit 1) as member
  `;
  const results = await sql.transaction([teamSeatLockQuery(sql, teamId), mutation]);
  const row = results[1]?.[0] || {};
  return {
    member: row.member || null,
    blocked_last_owner: Boolean(row.blocked_last_owner),
    found: Number(row.target_count || 0) > 0
  };
}

export async function listTeamsForUser(userId) {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.teamMembers.values()]
      .filter((member) => member.user_id === userId)
      .map((member) => {
        const team = memoryStore.teams.get(member.team_id);
        return team ? { ...team, role: member.role || "viewer" } : null;
      })
      .filter(Boolean);
  }
  await ensureTables(sql);
  const rows = await sql`
    select t.payload as team_payload, m.payload as member_payload, m.role
    from stimli_team_members m
    join stimli_teams t on t.id = m.team_id
    where m.user_id = ${userId}
    order by m.created_at asc
  `;
  return rows.map((row) => ({
    ...row.team_payload,
    role: row.role || row.member_payload?.role || "viewer"
  }));
}

export async function listTeamMembers(teamId) {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.teamMembers.values()]
      .filter((member) => member.team_id === teamId)
      .map((member) => ({
        ...member,
        user: memoryStore.users.get(member.user_id) || null
      }))
      .sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`
    select m.payload, u.payload as user_payload
    from stimli_team_members m
    left join stimli_users u on u.id = m.user_id
    where m.team_id = ${teamId}
    order by m.created_at asc
  `;
  return rows.map((row) => ({
    ...row.payload,
    user: row.user_payload || null
  }));
}

export async function saveTeamInvite(invite) {
  const sql = getSql();
  if (!sql) {
    memoryStore.teamInvites.set(invite.token_hash, invite);
    return invite;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_team_invites (token_hash, team_id, email, role, payload, expires_at, created_at)
    values (${invite.token_hash}, ${invite.team_id}, ${invite.email}, ${invite.role}, ${JSON.stringify(invite)}::jsonb, ${invite.expires_at}, ${invite.created_at})
    on conflict (token_hash) do update
    set payload = excluded.payload,
        expires_at = excluded.expires_at
  `;
  return invite;
}

export async function saveTeamInviteWithSeatLimit(invite, seats) {
  const limit = Number(seats);
  const hasLimit = Number.isFinite(limit) && limit > 0;
  const safeLimit = hasLimit ? limit : 0;
  const now = new Date().toISOString();
  const email = String(invite.email || "").toLowerCase();
  const sql = getSql();
  if (!sql) {
    const alreadyMember = [...memoryStore.teamMembers.values()].some((member) => {
      const user = memoryStore.users.get(member.user_id);
      return member.team_id === invite.team_id && String(user?.email || "").toLowerCase() === email;
    });
    if (alreadyMember) {
      return { ok: false, existing_member: true, used: countTeamSeatsInMemory(invite.team_id, now) };
    }
    const duplicateInvite = [...memoryStore.teamInvites.values()].some((candidate) => (
      candidate.team_id === invite.team_id
      && String(candidate.email || "").toLowerCase() === email
      && candidate.expires_at > now
      && !candidate.accepted_at
    ));
    if (duplicateInvite) {
      return { ok: false, duplicate_invite: true, used: countTeamSeatsInMemory(invite.team_id, now) };
    }
    const used = countTeamSeatsInMemory(invite.team_id, now);
    if (hasLimit && used >= limit) {
      return { ok: false, used };
    }
    memoryStore.teamInvites.set(invite.token_hash, invite);
    return { ok: true, invite, used: used + 1 };
  }
  await ensureTables(sql);
  const mutation = sql`
    with existing_member as (
      select 1
      from stimli_team_members member
      join stimli_users users on users.id = member.user_id
      where member.team_id = ${invite.team_id}
        and lower(users.email) = lower(${invite.email})
      limit 1
    ),
    existing_invite as (
      select 1
      from stimli_team_invites
      where team_id = ${invite.team_id}
        and lower(email) = lower(${invite.email})
        and expires_at > ${now}
        and (payload->>'accepted_at') is null
      limit 1
    ),
    seat_usage as (
      select (
        (select count(*)::int from stimli_team_members where team_id = ${invite.team_id})
        +
        (select count(*)::int from stimli_team_invites
          where team_id = ${invite.team_id}
            and expires_at > ${now}
            and (payload->>'accepted_at') is null)
      )::int as used
    ),
    inserted as (
      insert into stimli_team_invites (token_hash, team_id, email, role, payload, expires_at, created_at)
      select ${invite.token_hash}, ${invite.team_id}, ${invite.email}, ${invite.role}, ${JSON.stringify(invite)}::jsonb, ${invite.expires_at}, ${invite.created_at}
      where not exists (select 1 from existing_member)
        and not exists (select 1 from existing_invite)
        and (${!hasLimit} or (select used from seat_usage) < ${safeLimit})
      on conflict (token_hash) do nothing
      returning payload
    )
    select
      exists (select 1 from existing_member) as existing_member,
      exists (select 1 from existing_invite) as duplicate_invite,
      (select used from seat_usage) as used,
      (select payload from inserted limit 1) as invite_payload
  `;
  const results = await sql.transaction([
    teamSeatLockQuery(sql, invite.team_id),
    mutation
  ]);
  const row = results[1]?.[0] || {};
  const used = Number(row.used || 0);
  if (!row.invite_payload) {
    return {
      ok: false,
      used,
      existing_member: Boolean(row.existing_member),
      duplicate_invite: Boolean(row.duplicate_invite)
    };
  }
  return { ok: true, invite: row.invite_payload || invite, used: used + 1 };
}

export async function getTeamInviteByTokenHash(tokenHash) {
  const sql = getSql();
  const now = new Date().toISOString();
  if (!sql) {
    const invite = memoryStore.teamInvites.get(tokenHash) || null;
    return invite && invite.expires_at > now && !invite.accepted_at ? invite : null;
  }
  await ensureTables(sql);
  const rows = await sql`
    select payload from stimli_team_invites
    where token_hash = ${tokenHash} and expires_at > ${now}
    limit 1
  `;
  const invite = rows[0]?.payload || null;
  return invite && !invite.accepted_at ? invite : null;
}

export async function listTeamInvites(teamId) {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.teamInvites.values()].filter((invite) => invite.team_id === teamId).sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_team_invites where team_id = ${teamId} order by created_at desc`;
  return rows.map((row) => row.payload);
}

export async function getTeamInviteById(inviteId, teamId) {
  const sql = getSql();
  if (!sql) {
    const match = [...memoryStore.teamInvites.values()].find(
      (invite) => invite.id === inviteId && invite.team_id === teamId
    );
    return match || null;
  }
  await ensureTables(sql);
  const rows = await sql`
    select payload from stimli_team_invites
    where team_id = ${teamId} and payload->>'id' = ${inviteId}
    limit 1
  `;
  return rows[0]?.payload || null;
}

export async function deleteTeamInvite(inviteId, teamId) {
  const sql = getSql();
  if (!sql) {
    let removedHash = null;
    for (const [hash, invite] of memoryStore.teamInvites.entries()) {
      if (invite.id === inviteId && invite.team_id === teamId) {
        removedHash = hash;
        break;
      }
    }
    if (!removedHash) return false;
    memoryStore.teamInvites.delete(removedHash);
    return true;
  }
  await ensureTables(sql);
  const rows = await sql`
    delete from stimli_team_invites
    where team_id = ${teamId} and payload->>'id' = ${inviteId}
    returning token_hash
  `;
  return rows.length > 0;
}

export async function acceptTeamInviteWithSeatLimit(invite, member, seats, acceptedAt = new Date().toISOString()) {
  const limit = Number(seats);
  const acceptedInvite = {
    ...invite,
    accepted_by: member.user_id,
    accepted_at: acceptedAt
  };
  const sql = getSql();
  const key = `${member.team_id}:${member.user_id}`;
  if (!sql) {
    const currentInvite = memoryStore.teamInvites.get(invite.token_hash) || null;
    if (!currentInvite || currentInvite.accepted_at || currentInvite.expires_at <= acceptedAt) {
      return { ok: false, used: countTeamMembersInMemory(member.team_id), invite_consumed: true };
    }
    const existing = memoryStore.teamMembers.get(key) || null;
    if (!existing && Number.isFinite(limit) && limit > 0) {
      const used = countTeamMembersInMemory(member.team_id);
      if (used >= limit) {
        return { ok: false, used };
      }
    }
    const resolvedMember = existing || member;
    if (!existing) {
      memoryStore.teamMembers.set(key, member);
    }
    memoryStore.teamInvites.set(invite.token_hash, acceptedInvite);
    return {
      ok: true,
      member: resolvedMember,
      invite: acceptedInvite,
      created_member: !existing
    };
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    const current = await getTeamInviteByTokenHash(invite.token_hash);
    if (!current) {
      return { ok: false, used: null, invite_consumed: true };
    }
    const existing = await getTeamMember(member.team_id, member.user_id);
    const resolvedMember = existing || await saveTeamMember(member);
    await saveTeamInvite(acceptedInvite);
    return { ok: true, member: resolvedMember, invite: acceptedInvite, created_member: !existing };
  }
  await ensureTables(sql);
  const acceptQuery = sql`
    with eligible as (
      select payload
      from stimli_team_invites
      where token_hash = ${invite.token_hash}
        and expires_at > ${acceptedAt}
        and (payload->>'accepted_at') is null
      for update
    ),
    existing as (
      select payload
      from stimli_team_members
      where team_id = ${member.team_id} and user_id = ${member.user_id}
        and exists (select 1 from eligible)
    ),
    inserted as (
      insert into stimli_team_members (team_id, user_id, role, payload, created_at)
      select ${member.team_id}, ${member.user_id}, ${member.role}, ${JSON.stringify(member)}::jsonb, ${member.created_at}
      where exists (select 1 from eligible)
        and not exists (select 1 from existing)
        and (select count(*) from stimli_team_members where team_id = ${member.team_id}) < ${limit}
      on conflict (team_id, user_id) do nothing
      returning payload
    ),
    resolved as (
      select payload, false as created_member from existing
      union all
      select payload, true as created_member from inserted
    ),
    accepted as (
      update stimli_team_invites
      set payload = ${JSON.stringify(acceptedInvite)}::jsonb
      where token_hash = ${invite.token_hash}
        and exists (select 1 from resolved)
      returning payload
    )
    select
      (select count(*) from eligible)::int as eligible_count,
      (select count(*) from resolved)::int as resolved_count,
      (select count(*) from inserted)::int as inserted_count,
      (select payload from resolved limit 1) as member_payload,
      (select payload from accepted limit 1) as invite_payload,
      (select count(*)::int from stimli_team_members where team_id = ${member.team_id}) as used
  `;
  const results = await sql.transaction([
    teamSeatLockQuery(sql, member.team_id),
    acceptQuery
  ]);
  const row = results[1]?.[0] || {};
  if (!Number(row.eligible_count || 0)) {
    return { ok: false, used: Number(row.used || 0), invite_consumed: true };
  }
  if (!Number(row.resolved_count || 0)) {
    return { ok: false, used: Number(row.used || limit) };
  }
  return {
    ok: true,
    member: row.member_payload || member,
    invite: row.invite_payload || acceptedInvite,
    created_member: Number(row.inserted_count || 0) > 0
  };
}

export async function deleteTeamMember(teamId, userId) {
  const sql = getSql();
  const key = `${teamId}:${userId}`;
  if (!sql) {
    const member = memoryStore.teamMembers.get(key) || null;
    if (!member) return { removed: false, member: null, blocked_last_owner: false };
    if (member.role === "owner" && countTeamOwnersInMemory(teamId) <= 1) {
      return { removed: false, member, blocked_last_owner: true };
    }
    memoryStore.teamMembers.delete(key);
    return { removed: true, member, blocked_last_owner: false };
  }
  await ensureTables(sql);
  const mutation = sql`
    with target as (
      select role, payload from stimli_team_members where team_id = ${teamId} and user_id = ${userId}
    ),
    owner_count as (
      select count(*)::int as count from stimli_team_members where team_id = ${teamId} and role = 'owner'
    ),
    deleted as (
      delete from stimli_team_members
      where team_id = ${teamId}
        and user_id = ${userId}
        and not (
          exists (select 1 from target where role = 'owner')
          and (select count from owner_count) <= 1
        )
      returning payload
    )
    select
      (select count(*)::int from target) as target_count,
      (
        exists (select 1 from target where role = 'owner')
        and (select count from owner_count) <= 1
      ) as blocked_last_owner,
      (select payload from target limit 1) as target_member,
      (select payload from deleted limit 1) as deleted_member
  `;
  const results = await sql.transaction([teamSeatLockQuery(sql, teamId), mutation]);
  const row = results[1]?.[0] || {};
  return {
    removed: Boolean(row.deleted_member),
    member: row.deleted_member || row.target_member || null,
    blocked_last_owner: Boolean(row.blocked_last_owner),
    found: Number(row.target_count || 0) > 0
  };
}

function countTeamMembersInMemory(teamId) {
  return [...memoryStore.teamMembers.values()].filter((member) => member.team_id === teamId).length;
}

function countTeamOwnersInMemory(teamId) {
  return [...memoryStore.teamMembers.values()].filter(
    (member) => member.team_id === teamId && member.role === "owner"
  ).length;
}

function countTeamSeatsInMemory(teamId, nowIsoValue) {
  const pendingInvites = [...memoryStore.teamInvites.values()].filter((invite) => {
    if (invite.team_id !== teamId || invite.accepted_at) return false;
    const expiresAt = Date.parse(invite.expires_at || "");
    return !Number.isFinite(expiresAt) || invite.expires_at > nowIsoValue;
  }).length;
  return countTeamMembersInMemory(teamId) + pendingInvites;
}

function teamSeatLockQuery(sql, teamId) {
  return sql`select pg_advisory_xact_lock(786272, hashtext(${`stimli:team-seats:${teamId}`}))`;
}

export async function saveAuthenticator(authenticator) {
  const sql = getSql();
  if (!sql) {
    memoryStore.authenticators.set(authenticator.credential_id, authenticator);
    return authenticator;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_authenticators (credential_id, user_id, payload, counter, created_at)
    values (${authenticator.credential_id}, ${authenticator.user_id}, ${JSON.stringify(authenticator)}::jsonb, ${authenticator.counter}, ${authenticator.created_at})
    on conflict (credential_id) do update
    set payload = excluded.payload,
        counter = excluded.counter
  `;
  return authenticator;
}

export async function getAuthenticatorByCredentialId(credentialId) {
  const sql = getSql();
  if (!sql) {
    return memoryStore.authenticators.get(credentialId) || null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_authenticators where credential_id = ${credentialId} limit 1`;
  return rows[0]?.payload || null;
}

export async function listAuthenticatorsForUser(userId) {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.authenticators.values()].filter((authenticator) => authenticator.user_id === userId);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_authenticators where user_id = ${userId} order by created_at asc`;
  return rows.map((row) => row.payload);
}

export async function updateAuthenticatorCounter(credentialId, counter) {
  const authenticator = await getAuthenticatorByCredentialId(credentialId);
  if (!authenticator) {
    return null;
  }
  authenticator.counter = counter;
  authenticator.last_used_at = new Date().toISOString();
  await saveAuthenticator(authenticator);
  return authenticator;
}

export async function saveAuthChallenge(challenge) {
  const sql = getSql();
  if (!sql) {
    memoryStore.authChallenges.set(challenge.id, challenge);
    return challenge;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_auth_challenges (id, email, type, payload, expires_at, created_at)
    values (${challenge.id}, ${challenge.email}, ${challenge.type}, ${JSON.stringify(challenge)}::jsonb, ${challenge.expires_at}, ${challenge.created_at})
    on conflict (id) do update
    set payload = excluded.payload,
        expires_at = excluded.expires_at
  `;
  return challenge;
}

export async function getAuthChallenge(challengeId) {
  const sql = getSql();
  if (!sql) {
    return memoryStore.authChallenges.get(challengeId) || null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_auth_challenges where id = ${challengeId} limit 1`;
  return rows[0]?.payload || null;
}

export async function deleteAuthChallenge(challengeId) {
  const sql = getSql();
  if (!sql) {
    memoryStore.authChallenges.delete(challengeId);
    return;
  }
  await ensureTables(sql);
  await sql`delete from stimli_auth_challenges where id = ${challengeId}`;
}

export async function saveSession(session) {
  const sql = getSql();
  if (!sql) {
    memoryStore.sessions.set(session.token_hash, session);
    return session;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_sessions (token_hash, user_id, team_id, payload, expires_at, created_at)
    values (${session.token_hash}, ${session.user_id}, ${session.team_id}, ${JSON.stringify(session)}::jsonb, ${session.expires_at}, ${session.created_at})
    on conflict (token_hash) do update
    set payload = excluded.payload,
        expires_at = excluded.expires_at
  `;
  return session;
}

export async function getSessionByHash(tokenHash) {
  const sql = getSql();
  if (!sql) {
    const session = memoryStore.sessions.get(tokenHash) || null;
    return session && session.expires_at > new Date().toISOString() ? session : null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_sessions where token_hash = ${tokenHash} and expires_at > ${new Date().toISOString()} limit 1`;
  return rows[0]?.payload || null;
}

export async function deleteSessionByHash(tokenHash) {
  const sql = getSql();
  if (!sql) {
    memoryStore.sessions.delete(tokenHash);
    return;
  }
  await ensureTables(sql);
  await sql`delete from stimli_sessions where token_hash = ${tokenHash}`;
}

export async function saveShareLink(link) {
  const sql = getSql();
  const tokenHash = link.token_hash || (link.token ? await sha256Hex(link.token) : "");
  if (!tokenHash) {
    throw new Error("Share link token hash is required.");
  }
  const payload = { ...link, token_hash: tokenHash };
  delete payload.token;
  if (!sql) {
    memoryStore.shareLinks.set(tokenHash, payload);
    return payload;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_share_links (token, workspace_id, comparison_id, payload, expires_at, created_at)
    values (${tokenHash}, ${link.workspace_id}, ${link.comparison_id}, ${JSON.stringify(payload)}::jsonb, ${link.expires_at}, ${link.created_at})
    on conflict (token) do update
    set payload = excluded.payload,
        expires_at = excluded.expires_at
  `;
  return payload;
}

export async function getShareLink(tokenHash) {
  const sql = getSql();
  if (!sql) {
    const link = memoryStore.shareLinks.get(tokenHash) || null;
    return link && link.expires_at > new Date().toISOString() ? link : null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_share_links where token = ${tokenHash} and expires_at > ${new Date().toISOString()} limit 1`;
  return rows[0]?.payload || null;
}

export async function saveAuditEvent(event) {
  const sql = getSql();
  const workspaceId = workspaceForPayload(event);
  if (!sql) {
    memoryStore.auditEvents.set(event.id, event);
    return event;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_audit_events (id, workspace_id, actor_id, action, target_type, target_id, payload, created_at)
    values (${event.id}, ${workspaceId}, ${event.actor_id || ""}, ${event.action}, ${event.target_type || ""}, ${event.target_id || ""}, ${JSON.stringify(event)}::jsonb, ${event.created_at})
    on conflict (id) do nothing
  `;
  return event;
}

export async function listAuditEvents(workspaceId = "public", limit = 100) {
  const sql = getSql();
  const maxRows = Math.max(1, Math.min(Number(limit) || 100, 500));
  if (!sql) {
    return [...memoryStore.auditEvents.values()]
      .filter((event) => workspaceForPayload(event) === workspaceId)
      .sort(descCreatedAt)
      .slice(0, maxRows);
  }
  await ensureTables(sql);
  const rows = await sql`
    select payload from stimli_audit_events
    where workspace_id = ${workspaceId}
    order by created_at desc
    limit ${maxRows}
  `;
  return rows.map((row) => row.payload);
}

export async function saveBrandProfile(profile) {
  const sql = getSql();
  const workspaceId = workspaceForPayload(profile);
  if (!sql) {
    const existing = memoryStore.brandProfiles.get(profile.id);
    if (existing && workspaceForPayload(existing) !== workspaceId) {
      return null;
    }
    memoryStore.brandProfiles.set(profile.id, profile);
    return profile;
  }
  await ensureTables(sql);
  const rows = await sql`
    insert into stimli_brand_profiles (id, workspace_id, payload, created_at)
    values (${profile.id}, ${workspaceId}, ${JSON.stringify(profile)}::jsonb, ${profile.created_at})
    on conflict (id) do update
    set payload = excluded.payload
    where stimli_brand_profiles.workspace_id = excluded.workspace_id
    returning payload
  `;
  return rows[0]?.payload || null;
}

export async function listBrandProfiles(workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.brandProfiles.values()].filter((profile) => workspaceForPayload(profile) === workspaceId).sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_brand_profiles where workspace_id = ${workspaceId} order by created_at desc`;
  return rows.map((row) => row.payload);
}

export async function getBrandProfile(profileId, workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    const profile = memoryStore.brandProfiles.get(profileId) || null;
    return profile && workspaceForPayload(profile) === workspaceId ? profile : null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_brand_profiles where id = ${profileId} and workspace_id = ${workspaceId} limit 1`;
  return rows[0]?.payload || null;
}

export async function deleteBrandProfile(profileId, workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    const profile = memoryStore.brandProfiles.get(profileId) || null;
    if (!profile || workspaceForPayload(profile) !== workspaceId) return false;
    memoryStore.brandProfiles.delete(profileId);
    return true;
  }
  await ensureTables(sql);
  const rows = await sql`delete from stimli_brand_profiles where id = ${profileId} and workspace_id = ${workspaceId} returning id`;
  return rows.length > 0;
}

export async function saveGovernanceRequest(request) {
  const sql = getSql();
  const workspaceId = workspaceForPayload(request);
  if (!sql) {
    memoryStore.governanceRequests.set(request.id, request);
    return request;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_governance_requests (id, workspace_id, request_type, payload, created_at)
    values (${request.id}, ${workspaceId}, ${request.request_type}, ${JSON.stringify(request)}::jsonb, ${request.created_at})
    on conflict (id) do update
    set payload = excluded.payload
  `;
  return request;
}

export async function listGovernanceRequests(workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.governanceRequests.values()]
      .filter((request) => workspaceForPayload(request) === workspaceId)
      .sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_governance_requests where workspace_id = ${workspaceId} order by created_at desc`;
  return rows.map((row) => row.payload);
}

export async function saveBenchmarkRun(run) {
  const sql = getSql();
  const workspaceId = workspaceForPayload(run);
  if (!sql) {
    memoryStore.benchmarkRuns.set(run.id, run);
    return run;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_benchmark_runs (id, workspace_id, benchmark_id, payload, created_at)
    values (${run.id}, ${workspaceId}, ${run.benchmark_id}, ${JSON.stringify(run)}::jsonb, ${run.created_at})
    on conflict (id) do update
    set payload = excluded.payload
  `;
  return run;
}

export async function listBenchmarkRuns(workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.benchmarkRuns.values()].filter((run) => workspaceForPayload(run) === workspaceId).sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_benchmark_runs where workspace_id = ${workspaceId} order by created_at desc`;
  return rows.map((row) => row.payload);
}

export async function saveIntegrationJob(job) {
  const sql = getSql();
  const workspaceId = workspaceForPayload(job);
  if (!sql) {
    memoryStore.integrationJobs.set(job.id, job);
    return job;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_integration_jobs (id, workspace_id, platform, payload, created_at)
    values (${job.id}, ${workspaceId}, ${job.platform}, ${JSON.stringify(job)}::jsonb, ${job.created_at})
    on conflict (id) do update
    set payload = excluded.payload
  `;
  return job;
}

export async function listIntegrationJobs(workspaceId = "public") {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.integrationJobs.values()].filter((job) => workspaceForPayload(job) === workspaceId).sort(descCreatedAt);
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_integration_jobs where workspace_id = ${workspaceId} order by created_at desc`;
  return rows.map((row) => row.payload);
}

// Subscriptions are 1:1 with teams (a team has at most one active Stripe
// subscription at a time). Storing them in a dedicated row, rather than in the
// stimli_teams payload, gives us a sane place to track current_period_end,
// cancel_at_period_end, trial_end, and the raw price id without rewriting the
// team blob on every webhook.
export async function saveSubscription(subscription) {
  const sql = getSql();
  const eventCreated = Number(subscription.last_stripe_event_created);
  const hasEventCreated = Number.isFinite(eventCreated);
  if (!sql) {
    const existing = memoryStore.subscriptions.get(subscription.team_id) || null;
    const existingEventCreated = Number(existing?.last_stripe_event_created);
    if (hasEventCreated && Number.isFinite(existingEventCreated) && eventCreated <= existingEventCreated) {
      return existing ? { ...existing, last_stripe_write_ignored: true } : existing;
    }
    memoryStore.subscriptions.set(subscription.team_id, subscription);
    return subscription;
  }
  await ensureTables(sql);
  const rows = hasEventCreated
    ? await sql`
      insert into stimli_subscriptions (
        team_id, stripe_subscription_id, stripe_customer_id, plan, status,
        current_period_start, current_period_end, cancel_at_period_end, trial_end,
        payload, created_at, updated_at
      ) values (
        ${subscription.team_id},
        ${subscription.stripe_subscription_id || ""},
        ${subscription.stripe_customer_id || ""},
        ${subscription.plan},
        ${subscription.status},
        ${subscription.current_period_start || null},
        ${subscription.current_period_end || null},
        ${subscription.cancel_at_period_end ? 1 : 0},
        ${subscription.trial_end || null},
        ${JSON.stringify(subscription)}::jsonb,
        ${subscription.created_at},
        ${subscription.updated_at || subscription.created_at}
      )
      on conflict (team_id) do update
      set stripe_subscription_id = excluded.stripe_subscription_id,
          stripe_customer_id = excluded.stripe_customer_id,
          plan = excluded.plan,
          status = excluded.status,
          current_period_start = excluded.current_period_start,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end,
          trial_end = excluded.trial_end,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      where coalesce(
        case
          when (stimli_subscriptions.payload->>'last_stripe_event_created') ~ '^-?[0-9]+(\\.[0-9]+)?$'
            then (stimli_subscriptions.payload->>'last_stripe_event_created')::double precision
          else -1
        end,
        -1
      ) < ${eventCreated}
      returning payload
    `
    : await sql`
      insert into stimli_subscriptions (
        team_id, stripe_subscription_id, stripe_customer_id, plan, status,
        current_period_start, current_period_end, cancel_at_period_end, trial_end,
        payload, created_at, updated_at
      ) values (
        ${subscription.team_id},
        ${subscription.stripe_subscription_id || ""},
        ${subscription.stripe_customer_id || ""},
        ${subscription.plan},
        ${subscription.status},
        ${subscription.current_period_start || null},
        ${subscription.current_period_end || null},
        ${subscription.cancel_at_period_end ? 1 : 0},
        ${subscription.trial_end || null},
        ${JSON.stringify(subscription)}::jsonb,
        ${subscription.created_at},
        ${subscription.updated_at || subscription.created_at}
      )
      on conflict (team_id) do update
      set stripe_subscription_id = excluded.stripe_subscription_id,
          stripe_customer_id = excluded.stripe_customer_id,
          plan = excluded.plan,
          status = excluded.status,
          current_period_start = excluded.current_period_start,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end,
          trial_end = excluded.trial_end,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      returning payload
    `;
  if (rows[0]?.payload) return rows[0].payload;
  const existing = await getSubscription(subscription.team_id);
  return existing ? { ...existing, last_stripe_write_ignored: true } : existing;
}

export async function getSubscription(teamId) {
  if (!teamId) return null;
  const sql = getSql();
  if (!sql) {
    return memoryStore.subscriptions.get(teamId) || null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_subscriptions where team_id = ${teamId} limit 1`;
  return rows[0]?.payload || null;
}

export async function getSubscriptionByStripeId(stripeSubscriptionId) {
  if (!stripeSubscriptionId) return null;
  const sql = getSql();
  if (!sql) {
    for (const sub of memoryStore.subscriptions.values()) {
      if (sub.stripe_subscription_id === stripeSubscriptionId) return sub;
    }
    return null;
  }
  await ensureTables(sql);
  const rows = await sql`
    select payload from stimli_subscriptions
    where stripe_subscription_id = ${stripeSubscriptionId}
    limit 1
  `;
  return rows[0]?.payload || null;
}

export async function getSubscriptionByCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  const sql = getSql();
  if (!sql) {
    for (const sub of memoryStore.subscriptions.values()) {
      if (sub.stripe_customer_id === stripeCustomerId) return sub;
    }
    return null;
  }
  await ensureTables(sql);
  const rows = await sql`
    select payload from stimli_subscriptions
    where stripe_customer_id = ${stripeCustomerId}
    limit 1
  `;
  return rows[0]?.payload || null;
}

// Idempotency log for Stripe webhooks. We key by the Stripe event id so a
// replayed delivery never double-applies a plan change or invoice.
// Releases an idempotency claim made by recordBillingEvent. Called when webhook
// processing fails after the claim, so Stripe's retry can reprocess the event
// instead of being short-circuited as a duplicate.
export async function deleteBillingEvent(eventId) {
  const sql = getSql();
  if (!sql) {
    return memoryStore.billingEvents.delete(eventId);
  }
  await ensureTables(sql);
  const rows = await sql`delete from stimli_billing_events where id = ${eventId} returning id`;
  return rows.length > 0;
}

export async function recordBillingEvent(event) {
  const sql = getSql();
  if (!sql) {
    if (memoryStore.billingEvents.has(event.id)) return false;
    memoryStore.billingEvents.set(event.id, event);
    return true;
  }
  await ensureTables(sql);
  const rows = await sql`
    insert into stimli_billing_events (id, type, team_id, payload, created_at)
    values (${event.id}, ${event.type}, ${event.team_id || ""}, ${JSON.stringify(event)}::jsonb, ${event.created_at})
    on conflict (id) do nothing
    returning id
  `;
  return rows.length > 0;
}

export async function listBillingEvents(teamId, limit = 50) {
  const sql = getSql();
  const maxRows = Math.max(1, Math.min(Number(limit) || 50, 200));
  if (!sql) {
    return [...memoryStore.billingEvents.values()]
      .filter((event) => !teamId || event.team_id === teamId)
      .sort(descCreatedAt)
      .slice(0, maxRows);
  }
  await ensureTables(sql);
  if (teamId) {
    const rows = await sql`
      select payload from stimli_billing_events
      where team_id = ${teamId}
      order by created_at desc
      limit ${maxRows}
    `;
    return rows.map((row) => row.payload);
  }
  const rows = await sql`
    select payload from stimli_billing_events
    order by created_at desc
    limit ${maxRows}
  `;
  return rows.map((row) => row.payload);
}

async function ensureTables(sql) {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    await sql`create table if not exists stimli_schema_migrations (version text primary key, applied_at text not null)`;
    const applied = await sql`select version from stimli_schema_migrations where version = ${STORE_SCHEMA_VERSION} limit 1`;
    if (applied.length === 0) {
      // Neon's HTTP transport does ONE network round-trip per query. Batch the
      // table/bootstrap/backfill work into a single transaction and mark it in
      // a ledger so future cold isolates only do tiny migration-table checks.
      await sql.transaction([
        sql`select pg_advisory_xact_lock(786271, hashtext(${`stimli:schema:${STORE_SCHEMA_VERSION}`}))`,
        ...schemaBootstrapQueries(sql),
        ...schemaBackfillQueries(sql),
        sql`
          insert into stimli_schema_migrations (version, applied_at)
          values (${STORE_SCHEMA_VERSION}, ${new Date().toISOString()})
          on conflict (version) do update set applied_at = excluded.applied_at
        `
      ]);
    }

    const indexesApplied = await sql`select version from stimli_schema_migrations where version = ${STORE_INDEX_VERSION} limit 1`;
    if (indexesApplied.length > 0) return;
    for (const query of schemaIndexQueries(sql)) {
      await query;
    }
    await sql`
      insert into stimli_schema_migrations (version, applied_at)
      values (${STORE_INDEX_VERSION}, ${new Date().toISOString()})
      on conflict (version) do update set applied_at = excluded.applied_at
    `;
  })();
  try {
    return await _initPromise;
  } catch (error) {
    // Never cache a rejected init promise. A single transient Neon error during
    // the first call would otherwise poison every subsequent store operation in
    // this isolate (they'd all await the same rejected promise). Reset so the
    // next request retries the initialization from scratch.
    _initPromise = null;
    throw error;
  }
}

function schemaBootstrapQueries(sql) {
  return [
    sql`create table if not exists stimli_assets (id text primary key, workspace_id text not null default 'public', payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_projects (id text primary key, workspace_id text not null default 'public', payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_comparisons (id text primary key, workspace_id text not null default 'public', payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_outcomes (id text primary key, workspace_id text not null default 'public', comparison_id text not null, asset_id text not null, payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_usage_events (id text primary key, workspace_id text not null default 'public', bucket_key text not null, kind text not null, payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_users (id text primary key, email text not null unique, name text not null, payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_teams (id text primary key, name text not null, payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_team_members (team_id text not null, user_id text not null, role text not null, payload jsonb not null, created_at text not null, primary key (team_id, user_id))`,
    sql`create table if not exists stimli_team_invites (token_hash text primary key, team_id text not null, email text not null, role text not null, payload jsonb not null, expires_at text not null, created_at text not null)`,
    sql`create table if not exists stimli_authenticators (credential_id text primary key, user_id text not null, payload jsonb not null, counter integer not null default 0, created_at text not null)`,
    sql`create table if not exists stimli_auth_challenges (id text primary key, email text not null, type text not null, payload jsonb not null, expires_at text not null, created_at text not null)`,
    sql`create table if not exists stimli_sessions (token_hash text primary key, user_id text not null, team_id text not null, payload jsonb not null, expires_at text not null, created_at text not null)`,
    sql`create table if not exists stimli_share_links (token text primary key, workspace_id text not null, comparison_id text not null, payload jsonb not null, expires_at text not null, created_at text not null)`,
    sql`create table if not exists stimli_audit_events (id text primary key, workspace_id text not null, actor_id text not null default '', action text not null, target_type text not null default '', target_id text not null default '', payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_brand_profiles (id text primary key, workspace_id text not null default 'public', payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_governance_requests (id text primary key, workspace_id text not null default 'public', request_type text not null, payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_benchmark_runs (id text primary key, workspace_id text not null default 'public', benchmark_id text not null, payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_integration_jobs (id text primary key, workspace_id text not null default 'public', platform text not null, payload jsonb not null, created_at text not null)`,
    sql`create table if not exists stimli_subscriptions (team_id text primary key, stripe_subscription_id text not null default '', stripe_customer_id text not null default '', plan text not null, status text not null, current_period_start text, current_period_end text, cancel_at_period_end smallint not null default 0, trial_end text, payload jsonb not null, created_at text not null, updated_at text not null)`,
    sql`create table if not exists stimli_billing_events (id text primary key, type text not null, team_id text not null default '', payload jsonb not null, created_at text not null)`,
    // CREATE TABLE IF NOT EXISTS does not migrate already-created Neon tables.
    // Keep these ALTERs idempotent so production databases from earlier
    // releases pick up the columns this branch reads/writes before indexes or
    // inserts touch them.
    sql`alter table stimli_assets add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_projects add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_comparisons add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_outcomes add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_outcomes add column if not exists comparison_id text not null default ''`,
    sql`alter table stimli_outcomes add column if not exists asset_id text not null default ''`,
    sql`alter table stimli_usage_events add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_usage_events add column if not exists bucket_key text not null default ''`,
    sql`alter table stimli_team_invites add column if not exists email text not null default ''`,
    sql`alter table stimli_sessions add column if not exists team_id text not null default ''`,
    sql`alter table stimli_share_links add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_share_links add column if not exists comparison_id text not null default ''`,
    sql`alter table stimli_audit_events add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_audit_events add column if not exists actor_id text not null default ''`,
    sql`alter table stimli_audit_events add column if not exists target_type text not null default ''`,
    sql`alter table stimli_audit_events add column if not exists target_id text not null default ''`,
    sql`alter table stimli_brand_profiles add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_governance_requests add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_benchmark_runs add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_integration_jobs add column if not exists workspace_id text not null default 'public'`,
    sql`alter table stimli_subscriptions add column if not exists stripe_subscription_id text not null default ''`,
    sql`alter table stimli_subscriptions add column if not exists stripe_customer_id text not null default ''`,
    sql`alter table stimli_subscriptions add column if not exists current_period_start text`,
    sql`alter table stimli_subscriptions add column if not exists current_period_end text`,
    sql`alter table stimli_subscriptions add column if not exists cancel_at_period_end smallint not null default 0`,
    sql`alter table stimli_subscriptions add column if not exists trial_end text`,
    sql`alter table stimli_subscriptions add column if not exists updated_at text not null default ''`,
    sql`alter table stimli_billing_events add column if not exists team_id text not null default ''`
  ];
}

function schemaBackfillQueries(sql) {
  return [
    sql`update stimli_assets set workspace_id = payload->>'workspace_id' where payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id'`,
    sql`update stimli_projects set workspace_id = payload->>'workspace_id' where payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id'`,
    sql`update stimli_comparisons set workspace_id = payload->>'workspace_id' where payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id'`,
    sql`update stimli_outcomes set workspace_id = coalesce(nullif(payload->>'workspace_id', ''), workspace_id), comparison_id = coalesce(nullif(payload->>'comparison_id', ''), comparison_id), asset_id = coalesce(nullif(payload->>'asset_id', ''), asset_id) where (payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id') or (payload ? 'comparison_id' and payload->>'comparison_id' <> '' and comparison_id is distinct from payload->>'comparison_id') or (payload ? 'asset_id' and payload->>'asset_id' <> '' and asset_id is distinct from payload->>'asset_id')`,
    sql`update stimli_usage_events set workspace_id = coalesce(nullif(payload->>'workspace_id', ''), workspace_id), bucket_key = coalesce(nullif(payload->>'bucket_key', ''), bucket_key) where (payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id') or (payload ? 'bucket_key' and payload->>'bucket_key' <> '' and bucket_key is distinct from payload->>'bucket_key')`,
    sql`update stimli_team_invites set email = payload->>'email' where payload ? 'email' and payload->>'email' <> '' and email is distinct from payload->>'email'`,
    sql`update stimli_sessions set team_id = payload->>'team_id' where payload ? 'team_id' and payload->>'team_id' <> '' and team_id is distinct from payload->>'team_id'`,
    sql`update stimli_share_links set workspace_id = coalesce(nullif(payload->>'workspace_id', ''), workspace_id), comparison_id = coalesce(nullif(payload->>'comparison_id', ''), comparison_id) where (payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id') or (payload ? 'comparison_id' and payload->>'comparison_id' <> '' and comparison_id is distinct from payload->>'comparison_id')`,
    sql`update stimli_audit_events set workspace_id = coalesce(nullif(payload->>'workspace_id', ''), workspace_id), actor_id = coalesce(nullif(payload->>'actor_id', ''), actor_id), target_type = coalesce(nullif(payload->>'target_type', ''), target_type), target_id = coalesce(nullif(payload->>'target_id', ''), target_id) where (payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id') or (payload ? 'actor_id' and payload->>'actor_id' <> '' and actor_id is distinct from payload->>'actor_id') or (payload ? 'target_type' and payload->>'target_type' <> '' and target_type is distinct from payload->>'target_type') or (payload ? 'target_id' and payload->>'target_id' <> '' and target_id is distinct from payload->>'target_id')`,
    sql`update stimli_brand_profiles set workspace_id = payload->>'workspace_id' where payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id'`,
    sql`update stimli_governance_requests set workspace_id = payload->>'workspace_id' where payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id'`,
    sql`update stimli_benchmark_runs set workspace_id = payload->>'workspace_id' where payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id'`,
    sql`update stimli_integration_jobs set workspace_id = payload->>'workspace_id' where payload ? 'workspace_id' and payload->>'workspace_id' <> '' and workspace_id is distinct from payload->>'workspace_id'`,
    sql`update stimli_subscriptions set stripe_subscription_id = coalesce(nullif(payload->>'stripe_subscription_id', ''), stripe_subscription_id), stripe_customer_id = coalesce(nullif(payload->>'stripe_customer_id', ''), stripe_customer_id), current_period_start = coalesce(nullif(payload->>'current_period_start', ''), current_period_start), current_period_end = coalesce(nullif(payload->>'current_period_end', ''), current_period_end), cancel_at_period_end = case when payload ? 'cancel_at_period_end' then case when lower(payload->>'cancel_at_period_end') in ('true', 't', '1', 'yes') then 1 when lower(payload->>'cancel_at_period_end') in ('false', 'f', '0', 'no') then 0 else cancel_at_period_end end else cancel_at_period_end end, trial_end = coalesce(nullif(payload->>'trial_end', ''), trial_end), updated_at = coalesce(nullif(payload->>'updated_at', ''), nullif(updated_at, ''), created_at, '') where payload ?| array['stripe_subscription_id', 'stripe_customer_id', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'trial_end', 'updated_at']`,
    sql`update stimli_billing_events set team_id = payload->>'team_id' where payload ? 'team_id' and payload->>'team_id' <> '' and team_id is distinct from payload->>'team_id'`
  ];
}

function schemaIndexQueries(sql) {
  return [
    sql`create index concurrently if not exists stimli_assets_workspace_idx on stimli_assets (workspace_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_projects_workspace_idx on stimli_projects (workspace_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_comparisons_workspace_idx on stimli_comparisons (workspace_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_outcomes_workspace_idx on stimli_outcomes (workspace_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_outcomes_comparison_idx on stimli_outcomes (comparison_id)`,
    sql`create index concurrently if not exists stimli_usage_workspace_idx on stimli_usage_events (workspace_id, kind, created_at desc)`,
    sql`create index concurrently if not exists stimli_usage_bucket_idx on stimli_usage_events (bucket_key, kind, created_at desc)`,
    sql`create index concurrently if not exists stimli_team_members_user_idx on stimli_team_members (user_id, created_at asc)`,
    sql`create index concurrently if not exists stimli_team_invites_team_idx on stimli_team_invites (team_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_authenticators_user_idx on stimli_authenticators (user_id, created_at asc)`,
    sql`create index concurrently if not exists stimli_auth_challenges_email_idx on stimli_auth_challenges (email, type, created_at desc)`,
    sql`create index concurrently if not exists stimli_sessions_user_idx on stimli_sessions (user_id, expires_at desc)`,
    sql`create index concurrently if not exists stimli_share_links_comparison_idx on stimli_share_links (comparison_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_audit_events_workspace_idx on stimli_audit_events (workspace_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_brand_profiles_workspace_idx on stimli_brand_profiles (workspace_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_governance_requests_workspace_idx on stimli_governance_requests (workspace_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_benchmark_runs_workspace_idx on stimli_benchmark_runs (workspace_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_integration_jobs_workspace_idx on stimli_integration_jobs (workspace_id, created_at desc)`,
    sql`create index concurrently if not exists stimli_subscriptions_stripe_idx on stimli_subscriptions (stripe_subscription_id)`,
    sql`create index concurrently if not exists stimli_subscriptions_customer_idx on stimli_subscriptions (stripe_customer_id)`,
    sql`create index concurrently if not exists stimli_billing_events_team_idx on stimli_billing_events (team_id, created_at desc)`
  ];
}

function workspaceForPayload(payload) {
  return payload.workspace_id || "public";
}

function descCreatedAt(a, b) {
  return String(b.created_at).localeCompare(String(a.created_at));
}

async function sha256Hex(value) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  return [...new Uint8Array(buf)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
