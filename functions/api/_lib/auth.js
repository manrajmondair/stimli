// Clerk-backed auth for the Stimli API.
//
// Replaces the prior passkey/WebAuthn flow. The Pages Function reads the
// Authorization: Bearer <jwt> header on each request and verifies it against
// Clerk's JWKS via @clerk/backend. The verified Clerk user id is mapped to a
// row in stimli_users (auto-created on first call) plus a personal team
// (auto-created on first sign-in). Sessions are owned entirely by Clerk —
// the API does not issue or store its own cookies.

import { createClerkClient, verifyToken } from "@clerk/backend";

import { newId, nowIso } from "./analysis.js";
import {
  getTeam,
  getTeamMember,
  getUser,
  getUserByEmail,
  listTeamsForUser,
  rebindUserId,
  saveTeam,
  saveTeamMember,
  saveUser
} from "./store.js";

let _env = {};
let _client = null;

export function configureAuth(env) {
  _env = env || {};
  _client = null; // recreated lazily so a different env (preview vs prod) is honored
}

function clerkClient() {
  if (_client) return _client;
  const secretKey = _env.CLERK_SECRET_KEY;
  if (!secretKey) return null;
  _client = createClerkClient({
    secretKey,
    publishableKey: _env.CLERK_PUBLISHABLE_KEY,
    jwtKey: _env.CLERK_JWT_KEY
  });
  return _client;
}

export async function getAuthContext(request) {
  // Test-only bypass: when STIMLI_TEST_MODE=1, the function honors an
  // X-Stimli-Test-User header and synthesizes an authContext from existing
  // memory-store rows. This env var is never set in any production or preview
  // deployment — it exists so the Node test suite can drive multi-role
  // scenarios without standing up real Clerk JWTs.
  if (_env.STIMLI_TEST_MODE === "1") {
    const testUserId = headerValue(request, "x-stimli-test-user");
    if (testUserId) {
      return synthesizeTestContext(testUserId, request);
    }
  }

  const token = bearerTokenFromRequest(request);
  if (!token) {
    return anonymousContext("no-bearer-token");
  }
  const client = clerkClient();
  if (!client) {
    return anonymousContext("clerk-secret-key-missing");
  }

  let claims;
  try {
    claims = await verifyToken(token, {
      secretKey: _env.CLERK_SECRET_KEY,
      jwtKey: _env.CLERK_JWT_KEY,
      authorizedParties: authorizedPartiesFromEnv()
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return anonymousContext(`verifyToken-failed: ${msg}`);
  }

  const clerkUserId = claims.sub;
  if (!clerkUserId) {
    return anonymousContext("jwt-missing-sub-claim");
  }

  let user;
  try {
    user = await ensureStimliUser(clerkUserId, client);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return anonymousContext(`ensureStimliUser-threw: ${msg}`);
  }
  if (!user) {
    return anonymousContext(`ensureStimliUser-returned-null: ${clerkUserId}`);
  }

  let team;
  try {
    team = await ensurePersonalTeam(user);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return anonymousContext(`ensurePersonalTeam-threw: ${msg}`);
  }
  const membership = await getTeamMember(team.id, user.id);

  return {
    authenticated: true,
    user,
    team,
    membership,
    role: membership?.role || "owner",
    permissions: permissionsForRole(membership?.role || "owner"),
    workspace_id: team.id
  };
}

async function synthesizeTestContext(testUserId, request) {
  const user = await getUser(testUserId);
  if (!user) return anonymousContext();
  const teams = await listTeamsForUser(user.id);
  // Tests can override which team becomes the active workspace by passing
  // X-Stimli-Test-Team. Defaults to the first team the user belongs to.
  const requestedTeamId = headerValue(request, "x-stimli-test-team");
  const team = (requestedTeamId && teams.find((item) => item.id === requestedTeamId)) || teams[0];
  if (!team) return anonymousContext();
  const membership = await getTeamMember(team.id, user.id);
  return {
    authenticated: true,
    user,
    team,
    membership,
    role: membership?.role || "owner",
    permissions: permissionsForRole(membership?.role || "owner"),
    workspace_id: team.id
  };
}

export async function authSessionPayload(request) {
  const context = await getAuthContext(request);
  if (!context.authenticated) {
    return {
      authenticated: false,
      user: null,
      team: null,
      teams: [],
      debug_reason: context.debug_reason || null
    };
  }
  return {
    authenticated: true,
    user: publicUser(context.user),
    team: context.team,
    role: context.role,
    permissions: context.permissions,
    teams: await listTeamsForUser(context.user.id)
  };
}

async function ensureStimliUser(clerkUserId, client) {
  // First try a direct lookup by our internal id (which we set to the Clerk id
  // on first creation). If nothing's there, fetch the Clerk profile, then look
  // up by email (handles the case where a user signed in once on a different
  // device / Clerk session before our DB had a row).
  const direct = await getUser(clerkUserId);
  if (direct) return direct;

  let clerkProfile = null;
  try {
    clerkProfile = await client.users.getUser(clerkUserId);
  } catch {
    return null;
  }

  const email =
    clerkProfile?.primaryEmailAddress?.emailAddress ||
    clerkProfile?.emailAddresses?.[0]?.emailAddress ||
    "";
  const name =
    [clerkProfile?.firstName, clerkProfile?.lastName].filter(Boolean).join(" ") ||
    clerkProfile?.username ||
    (email ? email.split("@")[0] : "Stimli user");

  if (email) {
    const byEmail = await getUserByEmail(email);
    if (byEmail) {
      if (byEmail.id === clerkUserId) return byEmail;
      // Row exists under a different id (legacy id, prior Clerk session,
      // etc.). Rebind the row onto the current Clerk id rather than INSERT a
      // new row — INSERTing would violate stimli_users_email_key. The helper
      // also cascades stimli_team_members.user_id so existing memberships
      // continue to resolve.
      const migrated = await rebindUserId(byEmail.id, clerkUserId, {
        name: name || byEmail.name
      });
      if (migrated) return migrated;
    }
  }

  const user = {
    id: clerkUserId,
    email,
    name,
    created_at: nowIso()
  };
  await saveUser(user);
  return user;
}

async function ensurePersonalTeam(user) {
  const existing = await listTeamsForUser(user.id);
  if (existing.length > 0) return existing[0];

  const teamId = newId("team");
  const createdAt = nowIso();
  const team = {
    id: teamId,
    name: defaultTeamNameFor(user),
    created_at: createdAt
  };
  await saveTeam(team);
  await saveTeamMember({
    team_id: teamId,
    user_id: user.id,
    role: "owner",
    created_at: createdAt
  });
  return team;
}

function defaultTeamNameFor(user) {
  if (user.name) return `${user.name.split(" ")[0]}'s Team`;
  if (user.email) return `${user.email.split("@")[0]}'s Team`;
  return "Personal Team";
}

function bearerTokenFromRequest(request) {
  const header = headerValue(request, "authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

function headerValue(request, name) {
  if (request?.headers?.get && typeof request.headers.get === "function") {
    return request.headers.get(name) || "";
  }
  const headers = request?.headers || {};
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return "";
}

function authorizedPartiesFromEnv() {
  const raw = String(_env.CLERK_AUTHORIZED_PARTIES || _env.STIMLI_APP_URL || "").trim();
  if (!raw) return undefined;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function anonymousContext(debugReason = null) {
  return {
    authenticated: false,
    user: null,
    team: null,
    membership: null,
    role: "anonymous",
    permissions: [],
    workspace_id: null,
    debug_reason: debugReason
  };
}

export function permissionsForRole(role = "viewer") {
  const policies = {
    owner: [
      "workspace:read",
      "workspace:write",
      "members:manage",
      "billing:manage",
      "jobs:manage",
      "audit:read",
      "governance:manage",
      "validation:manage"
    ],
    admin: [
      "workspace:read",
      "workspace:write",
      "members:manage",
      "jobs:manage",
      "audit:read",
      "governance:manage",
      "validation:manage"
    ],
    analyst: ["workspace:read", "workspace:write", "validation:manage"],
    member: ["workspace:read", "workspace:write", "validation:manage"],
    viewer: ["workspace:read"]
  };
  return policies[role] || policies.viewer;
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at
  };
}
