// Passkey + session auth for the Stimli API.
//
// All crypto is Web Crypto: crypto.subtle.digest for SHA-256, crypto.getRandomValues
// for session tokens, TextEncoder for WebAuthn userID bytes. hashToken is async.
// configureAuth(env) is called once per request from the Pages Function entry
// point so STIMLI_RP_ID and STIMLI_ORIGIN come from the runtime env bindings.
// Cookies are written via a CookieSink passed in by the entry point (collects
// Set-Cookie values that get appended to the final Response headers).

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";

import { newId, nowIso } from "./analysis.js";
import {
  deleteAuthChallenge,
  deleteSessionByHash,
  getAuthChallenge,
  getAuthenticatorByCredentialId,
  getSessionByHash,
  getTeam,
  getTeamMember,
  getUser,
  getUserByEmail,
  listAuthenticatorsForUser,
  listTeamsForUser,
  saveAuthChallenge,
  saveAuthenticator,
  saveSession,
  saveTeam,
  saveTeamMember,
  saveUser,
  updateAuthenticatorCounter
} from "./store.js";

const sessionCookie = "stimli_session";
const sessionDays = 30;

let _env = {};

export function configureAuth(env) {
  _env = env || {};
}

export async function getAuthContext(request) {
  const token = cookiesForRequest(request)[sessionCookie];
  if (!token) {
    return anonymousContext();
  }
  const session = await getSessionByHash(await hashToken(token));
  if (!session) {
    return anonymousContext();
  }
  const [user, team, membership] = await Promise.all([
    getUser(session.user_id),
    getTeam(session.team_id),
    getTeamMember(session.team_id, session.user_id)
  ]);
  if (!user || !team || !membership) {
    return anonymousContext();
  }
  return {
    authenticated: true,
    user,
    team,
    membership,
    role: membership.role || "viewer",
    permissions: permissionsForRole(membership.role),
    workspace_id: team.id
  };
}

export async function authSessionPayload(request) {
  const context = await getAuthContext(request);
  if (!context.authenticated) {
    return { authenticated: false, user: null, team: null, teams: [] };
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

export async function registrationOptions(request, payload) {
  const email = normalizeEmail(payload.email);
  const name = cleanName(payload.name) || email.split("@")[0];
  const teamName = cleanName(payload.team_name || payload.teamName) || `${name}'s Team`;
  if (!email) {
    throw httpError(400, "Email is required.");
  }
  const existing = await getUserByEmail(email);
  if (existing) {
    throw httpError(409, "Account already exists. Sign in instead.");
  }

  const rp = relyingParty(request);
  const userId = newId("user");
  const options = await generateRegistrationOptions({
    rpName: "Stimli",
    rpID: rp.id,
    userID: new TextEncoder().encode(userId),
    userName: email,
    userDisplayName: name,
    timeout: 90000,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred"
    },
    preferredAuthenticatorType: "localDevice"
  });
  const challenge = {
    id: newId("challenge"),
    type: "registration",
    email,
    challenge: options.challenge,
    user_id: userId,
    name,
    team_name: teamName,
    rp_id: rp.id,
    origin: rp.origin,
    expires_at: expiresInMinutes(10),
    created_at: nowIso()
  };
  await saveAuthChallenge(challenge);
  return { challenge_id: challenge.id, options };
}

export async function verifyRegistration(request, response, payload) {
  const challenge = await validChallenge(payload.challenge_id, "registration");
  const rp = relyingParty(request, challenge);
  const verification = await verifyRegistrationResponse({
    response: payload.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: false
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw httpError(400, "Passkey registration could not be verified.");
  }
  if (await getUserByEmail(challenge.email)) {
    throw httpError(409, "Account already exists. Sign in instead.");
  }

  const createdAt = nowIso();
  const team = {
    id: newId("team"),
    name: challenge.team_name,
    created_at: createdAt
  };
  const user = {
    id: challenge.user_id,
    email: challenge.email,
    name: challenge.name,
    created_at: createdAt
  };
  await saveUser(user);
  await saveTeam(team);
  await saveTeamMember({
    team_id: team.id,
    user_id: user.id,
    role: "owner",
    created_at: createdAt
  });
  await saveCredential(user.id, verification.registrationInfo);
  await deleteAuthChallenge(challenge.id);
  await issueSession(response, request, user.id, team.id);
  return {
    authenticated: true,
    user: publicUser(user),
    team,
    role: "owner",
    permissions: permissionsForRole("owner"),
    teams: [team]
  };
}

export async function authenticationOptions(request, payload) {
  const email = normalizeEmail(payload.email);
  if (!email) {
    throw httpError(400, "Email is required.");
  }
  const user = await getUserByEmail(email);
  if (!user) {
    throw httpError(404, "Account not found.");
  }
  const authenticators = await listAuthenticatorsForUser(user.id);
  if (!authenticators.length) {
    throw httpError(404, "No passkeys are registered for this account.");
  }

  const rp = relyingParty(request);
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    timeout: 90000,
    userVerification: "preferred",
    allowCredentials: authenticators.map((authenticator) => ({
      id: authenticator.credential_id,
      transports: authenticator.transports || []
    }))
  });
  const challenge = {
    id: newId("challenge"),
    type: "authentication",
    email,
    challenge: options.challenge,
    user_id: user.id,
    rp_id: rp.id,
    origin: rp.origin,
    expires_at: expiresInMinutes(10),
    created_at: nowIso()
  };
  await saveAuthChallenge(challenge);
  return { challenge_id: challenge.id, options };
}

export async function verifyAuthentication(request, response, payload) {
  const challenge = await validChallenge(payload.challenge_id, "authentication");
  const user = await getUser(challenge.user_id);
  if (!user) {
    throw httpError(404, "Account not found.");
  }
  const authenticator = await getAuthenticatorByCredentialId(payload.response?.id);
  if (!authenticator || authenticator.user_id !== user.id) {
    throw httpError(400, "Passkey is not registered for this account.");
  }

  const rp = relyingParty(request, challenge);
  const verification = await verifyAuthenticationResponse({
    response: payload.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: false,
    credential: {
      id: authenticator.credential_id,
      publicKey: base64urlToBytes(authenticator.public_key),
      counter: authenticator.counter || 0,
      transports: authenticator.transports || []
    }
  });
  if (!verification.verified) {
    throw httpError(400, "Passkey sign in could not be verified.");
  }
  await updateAuthenticatorCounter(authenticator.credential_id, verification.authenticationInfo.newCounter);
  await deleteAuthChallenge(challenge.id);
  const teams = await listTeamsForUser(user.id);
  const team = teams[0];
  if (!team) {
    throw httpError(500, "No team is attached to this account.");
  }
  await issueSession(response, request, user.id, team.id);
  return {
    authenticated: true,
    user: publicUser(user),
    team,
    role: roleForTeam(team.id, teams, "viewer"),
    permissions: permissionsForRole(roleForTeam(team.id, teams, "viewer")),
    teams
  };
}

export async function logout(request, response) {
  const token = cookiesForRequest(request)[sessionCookie];
  if (token) {
    await deleteSessionByHash(await hashToken(token));
  }
  clearSessionCookie(response, request);
  return { authenticated: false };
}

export async function switchTeam(request, response, payload) {
  const context = await getAuthContext(request);
  if (!context.authenticated) {
    throw httpError(401, "Sign in before switching teams.");
  }
  const teamId = String(payload.team_id || payload.teamId || "").trim();
  const membership = await getTeamMember(teamId, context.user.id);
  const team = membership ? await getTeam(teamId) : null;
  if (!team) {
    throw httpError(403, "You do not have access to this team.");
  }
  const token = cookiesForRequest(request)[sessionCookie];
  if (token) {
    await deleteSessionByHash(await hashToken(token));
  }
  await issueSession(response, request, context.user.id, team.id);
  return {
    authenticated: true,
    user: publicUser(context.user),
    team,
    role: membership.role || "viewer",
    permissions: permissionsForRole(membership.role),
    teams: await listTeamsForUser(context.user.id)
  };
}

function anonymousContext() {
  return {
    authenticated: false,
    user: null,
    team: null,
    membership: null,
    role: "anonymous",
    permissions: [],
    workspace_id: null
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

function roleForTeam(teamId, teams, fallback) {
  const team = teams.find((item) => item.id === teamId);
  return team?.role || team?.membership?.role || fallback;
}

async function saveCredential(userId, registrationInfo) {
  const credential = registrationInfo.credential;
  await saveAuthenticator({
    credential_id: credential.id,
    user_id: userId,
    public_key: bytesToBase64url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    credential_device_type: registrationInfo.credentialDeviceType,
    credential_backed_up: registrationInfo.credentialBackedUp,
    created_at: nowIso()
  });
}

async function issueSession(response, request, userId, teamId) {
  const token = randomBase64url(32);
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
  await saveSession({
    token_hash: await hashToken(token),
    user_id: userId,
    team_id: teamId,
    expires_at: expiresAt,
    created_at: nowIso()
  });
  setCookie(response, request, sessionCookie, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: sessionDays * 24 * 60 * 60
  });
}

function clearSessionCookie(response, request) {
  setCookie(response, request, sessionCookie, "", {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 0
  });
}

function setCookie(response, request, name, value, options = {}) {
  const parts = [`${name}=${value}`, `Path=${options.path || "/"}`, `Max-Age=${options.maxAge ?? 0}`, `SameSite=${options.sameSite || "Lax"}`];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (isSecureRequest(request)) {
    parts.push("Secure");
  }
  response.setHeader("Set-Cookie", parts.join("; "));
}

async function validChallenge(challengeId, type) {
  const challenge = challengeId ? await getAuthChallenge(challengeId) : null;
  if (!challenge || challenge.type !== type) {
    throw httpError(400, "Authentication challenge expired. Try again.");
  }
  if (challenge.expires_at <= nowIso()) {
    await deleteAuthChallenge(challenge.id);
    throw httpError(400, "Authentication challenge expired. Try again.");
  }
  return challenge;
}

function relyingParty(request, challenge = {}) {
  const host = header(request, "x-forwarded-host") || header(request, "host") || "localhost";
  const cleanHost = host.split(",")[0].trim();
  const hostname = cleanHost.split(":")[0];
  const protocol = header(request, "x-forwarded-proto") || (cleanHost.includes("localhost") || cleanHost.startsWith("127.") ? "http" : "https");
  return {
    id: _env.STIMLI_RP_ID || challenge.rp_id || hostname,
    origin: _env.STIMLI_ORIGIN || challenge.origin || `${protocol}://${cleanHost}`
  };
}

function isSecureRequest(request) {
  const protocol = header(request, "x-forwarded-proto");
  const host = header(request, "x-forwarded-host") || header(request, "host") || "";
  return protocol === "https" || (!host.includes("localhost") && !host.startsWith("127."));
}

function cookiesForRequest(request) {
  const raw = header(request, "cookie");
  return Object.fromEntries(
    raw
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) {
          return [part, ""];
        }
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function header(request, name) {
  // Adapter for both Web Request (Headers) and Node IncomingMessage shape.
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

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function cleanName(value) {
  return String(value || "").trim().slice(0, 120);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at
  };
}

function bytesToBase64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i += 1) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(value) {
  const str = String(value || "");
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function randomBase64url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64url(bytes);
}

export async function hashToken(token) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token || "")));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function expiresInMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
