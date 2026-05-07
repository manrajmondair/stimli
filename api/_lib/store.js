import postgres from "postgres";

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
  shareLinks: new Map()
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
    values (${project.id}, ${workspaceId}, ${sql.json(project)}, ${project.created_at})
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

export async function saveUser(user) {
  const sql = getSql();
  if (!sql) {
    memoryStore.users.set(user.id, user);
    return user;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_users (id, email, name, payload, created_at)
    values (${user.id}, ${user.email}, ${user.name}, ${sql.json(user)}, ${user.created_at})
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

export async function saveTeam(team) {
  const sql = getSql();
  if (!sql) {
    memoryStore.teams.set(team.id, team);
    return team;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_teams (id, name, payload, created_at)
    values (${team.id}, ${team.name}, ${sql.json(team)}, ${team.created_at})
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
    values (${member.team_id}, ${member.user_id}, ${member.role}, ${sql.json(member)}, ${member.created_at})
    on conflict (team_id, user_id) do update
    set role = excluded.role,
        payload = excluded.payload
  `;
  return member;
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

export async function listTeamsForUser(userId) {
  const sql = getSql();
  if (!sql) {
    return [...memoryStore.teamMembers.values()]
      .filter((member) => member.user_id === userId)
      .map((member) => memoryStore.teams.get(member.team_id))
      .filter(Boolean);
  }
  await ensureTables(sql);
  const rows = await sql`
    select t.payload from stimli_team_members m
    join stimli_teams t on t.id = m.team_id
    where m.user_id = ${userId}
    order by m.created_at asc
  `;
  return rows.map((row) => row.payload);
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
    values (${invite.token_hash}, ${invite.team_id}, ${invite.email}, ${invite.role}, ${sql.json(invite)}, ${invite.expires_at}, ${invite.created_at})
    on conflict (token_hash) do update
    set payload = excluded.payload,
        expires_at = excluded.expires_at
  `;
  return invite;
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

export async function saveAuthenticator(authenticator) {
  const sql = getSql();
  if (!sql) {
    memoryStore.authenticators.set(authenticator.credential_id, authenticator);
    return authenticator;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_authenticators (credential_id, user_id, payload, counter, created_at)
    values (${authenticator.credential_id}, ${authenticator.user_id}, ${sql.json(authenticator)}, ${authenticator.counter}, ${authenticator.created_at})
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
    values (${challenge.id}, ${challenge.email}, ${challenge.type}, ${sql.json(challenge)}, ${challenge.expires_at}, ${challenge.created_at})
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
    values (${session.token_hash}, ${session.user_id}, ${session.team_id}, ${sql.json(session)}, ${session.expires_at}, ${session.created_at})
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
  if (!sql) {
    memoryStore.shareLinks.set(link.token, link);
    return link;
  }
  await ensureTables(sql);
  await sql`
    insert into stimli_share_links (token, workspace_id, comparison_id, payload, expires_at, created_at)
    values (${link.token}, ${link.workspace_id}, ${link.comparison_id}, ${sql.json(link)}, ${link.expires_at}, ${link.created_at})
    on conflict (token) do update
    set payload = excluded.payload,
        expires_at = excluded.expires_at
  `;
  return link;
}

export async function getShareLink(token) {
  const sql = getSql();
  if (!sql) {
    const link = memoryStore.shareLinks.get(token) || null;
    return link && link.expires_at > new Date().toISOString() ? link : null;
  }
  await ensureTables(sql);
  const rows = await sql`select payload from stimli_share_links where token = ${token} and expires_at > ${new Date().toISOString()} limit 1`;
  return rows[0]?.payload || null;
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
      create table if not exists stimli_projects (
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
    await tx`
      create table if not exists stimli_users (
        id text primary key,
        email text not null unique,
        name text not null,
        payload jsonb not null,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_teams (
        id text primary key,
        name text not null,
        payload jsonb not null,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_team_members (
        team_id text not null,
        user_id text not null,
        role text not null,
        payload jsonb not null,
        created_at text not null,
        primary key (team_id, user_id)
      )
    `;
    await tx`
      create table if not exists stimli_team_invites (
        token_hash text primary key,
        team_id text not null,
        email text not null,
        role text not null,
        payload jsonb not null,
        expires_at text not null,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_authenticators (
        credential_id text primary key,
        user_id text not null,
        payload jsonb not null,
        counter integer not null default 0,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_auth_challenges (
        id text primary key,
        email text not null,
        type text not null,
        payload jsonb not null,
        expires_at text not null,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_sessions (
        token_hash text primary key,
        user_id text not null,
        team_id text not null,
        payload jsonb not null,
        expires_at text not null,
        created_at text not null
      )
    `;
    await tx`
      create table if not exists stimli_share_links (
        token text primary key,
        workspace_id text not null,
        comparison_id text not null,
        payload jsonb not null,
        expires_at text not null,
        created_at text not null
      )
    `;
    await tx`alter table stimli_assets add column if not exists workspace_id text not null default 'public'`;
    await tx`alter table stimli_projects add column if not exists workspace_id text not null default 'public'`;
    await tx`alter table stimli_comparisons add column if not exists workspace_id text not null default 'public'`;
    await tx`alter table stimli_outcomes add column if not exists workspace_id text not null default 'public'`;
    await tx`alter table stimli_usage_events add column if not exists workspace_id text not null default 'public'`;
    await tx`create index if not exists stimli_assets_workspace_idx on stimli_assets (workspace_id, created_at desc)`;
    await tx`create index if not exists stimli_projects_workspace_idx on stimli_projects (workspace_id, created_at desc)`;
    await tx`create index if not exists stimli_comparisons_workspace_idx on stimli_comparisons (workspace_id, created_at desc)`;
    await tx`create index if not exists stimli_outcomes_workspace_idx on stimli_outcomes (workspace_id, created_at desc)`;
    await tx`create index if not exists stimli_outcomes_comparison_idx on stimli_outcomes (comparison_id)`;
    await tx`create index if not exists stimli_usage_workspace_idx on stimli_usage_events (workspace_id, kind, created_at desc)`;
    await tx`create index if not exists stimli_usage_bucket_idx on stimli_usage_events (bucket_key, kind, created_at desc)`;
    await tx`create index if not exists stimli_team_members_user_idx on stimli_team_members (user_id, created_at asc)`;
    await tx`create index if not exists stimli_team_invites_team_idx on stimli_team_invites (team_id, created_at desc)`;
    await tx`create index if not exists stimli_authenticators_user_idx on stimli_authenticators (user_id, created_at asc)`;
    await tx`create index if not exists stimli_auth_challenges_email_idx on stimli_auth_challenges (email, type, created_at desc)`;
    await tx`create index if not exists stimli_sessions_user_idx on stimli_sessions (user_id, expires_at desc)`;
    await tx`create index if not exists stimli_share_links_comparison_idx on stimli_share_links (comparison_id, created_at desc)`;
  });
  return initPromise;
}

function workspaceForPayload(payload) {
  return payload.workspace_id || "public";
}

function descCreatedAt(a, b) {
  return String(b.created_at).localeCompare(String(a.created_at));
}
