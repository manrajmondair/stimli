// Cloudflare Pages Function entry point for the Stimli API.
//
// Single onRequest handler that dispatches /api/<path> to the right helper.
// Runs on the Cloudflare Workers runtime, so:
// - request is a Web Request; we return new Response(...) at the end.
// - Multipart parsing uses request.formData() (native).
// - Uploaded files are written to R2 via env.STIMLI_MEDIA.put(...). The
//   frontend always posts multipart to /api/assets and this Worker forwards
//   the bytes to R2 (25 MB upper bound, matching the Pages Functions body
//   limit). Small files are also inlined as base64 in asset metadata so the
//   Modal extractor can read them server-side without a public R2 URL.
// - Crypto: Web Crypto (SHA-256 via crypto.subtle, randomness via
//   crypto.getRandomValues, UUIDs via crypto.randomUUID).
// - Env access flows through the configure*(env) calls on each lib.

import {
  cancelBrainJob,
  compareAssets,
  compareAssetsWithBrain,
  configureAnalysis,
  createPendingComparison,
  extractAssetText,
  generateChallenger,
  getBrainJob,
  newId,
  noteRemoteBrainFailure,
  nowIso,
  providerHealth,
  shouldCreateAsyncComparison,
  startBrainJob
} from "./_lib/analysis.js";
import { authSessionPayload, configureAuth, getAuthContext, permissionsForRole } from "./_lib/auth.js";
import {
  billingStatus,
  configureBilling,
  createCheckoutSession,
  createPortalSession,
  getQuotaForWorkspace,
  handleBillingWebhook
} from "./_lib/billing.js";
import {
  clearDemoAssets,
  configureStore,
  deleteAsset,
  deleteBrandProfile,
  deleteComparison,
  deleteTeamInvite,
  deleteTeamMember,
  getAsset,
  getBrandProfile,
  getComparison,
  getProject,
  getTeam,
  getTeamInviteById,
  countUsageEvents,
  getTeamInviteByTokenHash,
  listAuditEvents,
  listAssets,
  listBenchmarkRuns,
  listBrandProfiles,
  listComparisons,
  listGovernanceRequests,
  listIntegrationJobs,
  listOutcomes,
  listProjects,
  listTeamMembers,
  listTeamsForUser,
  listTeamInvites,
  getShareLink,
  saveAuditEvent,
  saveAsset,
  acceptTeamInviteWithSeatLimit,
  saveBenchmarkRun,
  saveBrandProfile,
  saveComparison,
  saveGovernanceRequest,
  saveIntegrationJob,
  saveOutcome,
  saveProject,
  saveTeamInviteWithSeatLimit,
  saveShareLink,
  saveUsageEventConditional,
  storageHealth,
  updateTeamMemberRole
} from "./_lib/store.js";

const assetTypes = new Set(["script", "landing_page", "image", "audio", "video"]);
const DEMO_SEED_ASSET_UNITS = 3;

export async function onRequest(context) {
  const { request, env } = context;
  configureStore(env);
  configureAuth(env);
  configureAnalysis(env);
  configureBilling(env);

  const maxInlineFileBytes = positiveNumber(env.STIMLI_MAX_INLINE_FILE_BYTES, 8 * 1024 * 1024);
  const maxDirectUploadBytes = positiveNumber(env.STIMLI_MAX_DIRECT_UPLOAD_BYTES, 25 * 1024 * 1024);

  const cookies = new CookieSink();
  const headers = baseHeaders(request, env);
  // Reuse Cloudflare's cf-ray when present so a request id in our logs and the
  // X-Request-Id response header point at the same entry in CF's dashboard;
  // fall back to a UUID for local/test runs. Lets a user who hit "Request
  // failed" hand back an id we can grep for.
  const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
  headers["X-Request-Id"] = requestId;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const url = new URL(request.url);
    const apiPath = url.pathname.replace(/^\/api/, "") || "/";
    const segments = apiPath.split("/").filter(Boolean);

    if (request.method === "GET" && apiPath === "/health") {
      const storage = storageHealth();
      const allowMemory = env.STIMLI_TEST_MODE === "1" || env.STIMLI_ALLOW_MEMORY_STORE === "1";
      const healthy = storage.persistent || allowMemory;
      return sendJson(healthy ? 200 : 503, { status: healthy ? "ok" : "degraded", storage }, headers, cookies);
    }

    if (request.method === "GET" && apiPath === "/brain/providers") {
      return sendJson(200, await providerHealth(), headers, cookies);
    }

    const storage = storageHealth();
    if (!storage.persistent && !memoryStoreAllowed(env)) {
      return sendJson(503, {
        detail: "Persistent storage is not configured. Add POSTGRES_URL to the Pages project or explicitly enable memory store for local/test use.",
        code: "persistence_unavailable",
        storage
      }, headers, cookies);
    }

    const authContext = await getAuthContext(request);
    const workspaceId = authContext.workspace_id || workspaceForRequest(request);

    if (segments[0] === "auth") {
      return await handleAuth(request, cookies, segments, headers);
    }

    if (segments[0] === "billing") {
      return await handleBilling(request, segments, authContext, workspaceId, headers, cookies);
    }

    if (segments[0] === "teams") {
      return await handleTeams(request, segments, authContext, env, headers, cookies);
    }

    if (segments[0] === "invites") {
      return await handleInvites(request, cookies, segments, authContext, headers);
    }

    if (segments[0] === "share") {
      return await handleSharedReport(request, segments, headers, cookies);
    }

    if (segments[0] === "admin") {
      return await handleAdmin(request, segments, authContext, workspaceId, env, headers, cookies);
    }

    if (segments[0] === "audit") {
      return await handleAudit(request, segments, authContext, workspaceId, headers, cookies);
    }

    if (segments[0] === "governance") {
      return await handleGovernance(request, segments, authContext, workspaceId, headers, cookies);
    }

    if (segments[0] === "brand-profiles") {
      return await handleBrandProfiles(request, segments, authContext, workspaceId, headers, cookies);
    }

    if (segments[0] === "library") {
      return await handleLibrary(request, segments, authContext, workspaceId, headers, cookies);
    }

    if (segments[0] === "imports") {
      return await handleImports(request, segments, authContext, workspaceId, headers, cookies);
    }

    if (segments[0] === "validation") {
      return await handleValidation(request, segments, authContext, workspaceId, headers, cookies);
    }

    if (request.method === "POST" && apiPath === "/demo/seed") {
      requirePermission(authContext, "workspace:write", { allowAnonymous: true });
      const payload = await parseJson(request);
      const projectId = await resolveProjectId(payload.project_id, workspaceId);
      const quota = await getQuotaForWorkspace(workspaceId);
      await enforceUsageLimit(request, workspaceId, "asset", quota, authContext, { units: DEMO_SEED_ASSET_UNITS });
      return sendJson(200, await seedDemo(workspaceId, projectId), headers, cookies);
    }

    if (segments[0] === "projects") {
      return await handleProjects(request, segments, workspaceId, authContext, headers, cookies);
    }

    if (segments[0] === "assets") {
      return await handleAssets(request, segments, workspaceId, authContext, env, maxInlineFileBytes, maxDirectUploadBytes, headers, cookies);
    }

    if (segments[0] === "comparisons") {
      return await handleComparisons(request, segments, workspaceId, authContext, headers, cookies);
    }

    if (segments[0] === "reports") {
      return await handleReports(request, segments, workspaceId, authContext, env, headers, cookies);
    }

    if (request.method === "GET" && apiPath === "/learning/summary") {
      const [outcomes, comparisons] = await Promise.all([listOutcomes(null, workspaceId), listComparisons(workspaceId)]);
      return sendJson(200, learningSummary(outcomes, comparisons), headers, cookies);
    }

    if (request.method === "GET" && apiPath === "/outcomes") {
      // Workspace-wide outcomes list with comparison + asset names joined in
      // so the Outcomes view can render a table without N+1 lookups.
      const [outcomes, comparisons] = await Promise.all([
        listOutcomes(null, workspaceId),
        listComparisons(workspaceId)
      ]);
      const comparisonsById = new Map(comparisons.map((c) => [c.id, c]));
      const enriched = outcomes.map((outcome) => {
        const comparison = comparisonsById.get(outcome.comparison_id);
        const variant = comparison?.variants?.find((v) => v.asset?.id === outcome.asset_id);
        return {
          ...outcome,
          comparison_objective: comparison?.objective || null,
          comparison_status: comparison?.status || null,
          asset_name: variant?.asset?.name || null,
          profit:
            Number.isFinite(Number(outcome.revenue)) && Number.isFinite(Number(outcome.spend))
              ? round(Number(outcome.revenue) - Number(outcome.spend), 2)
              : null
        };
      });
      return sendJson(200, enriched, headers, cookies);
    }

    return sendJson(404, { detail: "Not found" }, headers, cookies);
  } catch (error) {
    const status = Number(error.statusCode || error.status || 500);
    const message = status >= 500 ? "Request failed" : error.message;
    if (status >= 500) {
      console.error(`[req ${requestId}]`, error);
    }
    // Pass through structured error metadata (code + details) so the frontend
    // can render quota-specific UX instead of treating every 4xx as a toast.
    const body = { detail: message };
    if (error.code) body.code = error.code;
    if (error.details && typeof error.details === "object") body.details = error.details;
    // Surface the correlation id on opaque 5xx responses so a bug report can be
    // tied back to the logged stack trace.
    if (status >= 500) body.request_id = requestId;
    // Standard HTTP back-off hint on throttle/quota responses so well-behaved
    // clients (and our own retries) wait the right amount instead of hammering.
    const retryAfter = retryAfterSeconds(error);
    const responseHeaders = retryAfter !== null ? { ...headers, "Retry-After": String(retryAfter) } : headers;
    return sendJson(status, body, responseHeaders, cookies);
  }
}

function retryAfterSeconds(error) {
  const details = error?.details;
  if (!details || typeof details !== "object") return null;
  if (error.code === "rate_limited") {
    const windowMs = Number(details.window_ms);
    if (Number.isFinite(windowMs) && windowMs > 0) {
      return Math.max(1, Math.ceil(windowMs / 1000));
    }
    return null;
  }
  if (error.code === "quota_exceeded" && details.reset_at) {
    const resetMs = Date.parse(details.reset_at);
    if (Number.isFinite(resetMs)) {
      return Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
    }
  }
  return null;
}

async function handleProjects(request, segments, workspaceId, authContext, headers, cookies) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(200, await listProjects(workspaceId), headers, cookies);
  }

  if (request.method === "POST" && segments.length === 1) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const payload = await parseJson(request);
    const name = String(payload.name || "").trim();
    if (name.length < 2) {
      throw httpError(400, "Project name is required.");
    }
    const project = {
      id: newId("project"),
      name: name.slice(0, 120),
      description: String(payload.description || "").trim().slice(0, 500),
      status: ["active", "archived"].includes(payload.status) ? payload.status : "active",
      workspace_id: workspaceId,
      created_at: nowIso()
    };
    await saveProject(project);
    await audit(workspaceId, null, "project.created", "project", project.id, { name: project.name });
    return sendJson(200, project, headers, cookies);
  }

  return sendJson(405, { detail: "Method not allowed" }, headers, cookies);
}

async function handleAuth(request, cookies, segments, headers) {
  // Auth is owned by Clerk. The only route the API exposes is /session, which
  // verifies the bearer token and returns the user's team + permissions so the
  // frontend can render the workbench shell with the right scoping.
  if (request.method === "GET" && segments[1] === "session") {
    return sendJson(200, await authSessionPayload(request), headers, cookies);
  }
  return sendJson(404, { detail: "Not found" }, headers, cookies);
}

async function handleTeams(request, segments, authContext, env, headers, cookies) {
  if (!authContext.authenticated) {
    throw httpError(401, "Sign in before managing teams.");
  }
  if (segments[1] === "invites") {
    requirePermission(authContext, "members:manage");
    if (request.method === "GET") {
      const invites = await listTeamInvites(authContext.team.id);
      return sendJson(200, invites.map((invite) => publicInvite(invite, authContext.team)), headers, cookies);
    }
    if (request.method === "POST") {
      const payload = await parseJson(request);
      const role = normalizeRole(payload.role || "analyst");
      assertCanGrantRole(authContext, role);
      const quota = await getQuotaForWorkspace(authContext.team.id);
      const token = randomBase64url(24);
      const invite = {
        id: newId("invite"),
        token_hash: await sha256Hex(token),
        team_id: authContext.team.id,
        team_name: authContext.team.name,
        email: normalizeInviteEmail(payload.email),
        role,
        created_by: authContext.user.id,
        expires_at: new Date(Date.now() + Number(env.STIMLI_INVITE_TTL_DAYS || 14) * 24 * 60 * 60 * 1000).toISOString(),
        created_at: nowIso()
      };
      // Seat enforcement: paid plans cap active members plus unaccepted,
      // unexpired invites. The store performs the count and insert under a
      // team advisory lock so two concurrent invite requests can't both see
      // the same final seat.
      const saved = await saveTeamInviteWithSeatLimit(invite, quota?.plan?.seats);
      if (!saved.ok) {
        if (saved.existing_member) {
          throw httpError(409, "This email already belongs to a team member.");
        }
        if (saved.duplicate_invite) {
          throw httpError(409, "An active invite already exists for this email.");
        }
        throw seatLimitError(quota, saved.used);
      }
      await audit(authContext.team.id, authContext.user, "invite.created", "invite", invite.id, {
        email: invite.email,
        role: invite.role
      });
      const origin = requestOrigin(request, env);
      return sendJson(200, {
        ...publicInvite(saved.invite || invite, authContext.team),
        url: `${origin}/invite/${token}`,
        token
      }, headers, cookies);
    }
    if (request.method === "DELETE" && segments[2]) {
      const inviteId = segments[2];
      const existing = await getTeamInviteById(inviteId, authContext.team.id);
      if (!existing) {
        throw httpError(404, "Invite not found.");
      }
      if (existing.accepted_at) {
        throw httpError(409, "Invite has already been accepted.");
      }
      const removed = await deleteTeamInvite(inviteId, authContext.team.id);
      if (!removed) {
        throw httpError(404, "Invite not found.");
      }
      await audit(authContext.team.id, authContext.user, "invite.revoked", "invite", inviteId, {
        email: existing.email || null
      });
      return sendJson(200, { revoked: inviteId }, headers, cookies);
    }
  }
  if (segments[1] === "members") {
    requirePermission(authContext, "members:manage");
    if (request.method === "GET" && segments.length === 2) {
      const members = await listTeamMembers(authContext.team.id);
      return sendJson(200, members.map(publicMember), headers, cookies);
    }
    if (request.method === "PATCH" && segments[2] && segments[3] === "role") {
      const payload = await parseJson(request);
      const role = normalizeRole(payload.role);
      if (segments[2] === authContext.user.id && role !== "owner") {
        throw httpError(400, "Owners cannot demote their own active session.");
      }
      const result = await updateTeamMemberRole(authContext.team.id, segments[2], role);
      if (result.blocked_last_owner) {
        throw httpError(409, "Can't demote the team's last owner.");
      }
      if (!result.member) {
        throw httpError(404, "Team member not found.");
      }
      await audit(authContext.team.id, authContext.user, "member.role_updated", "user", segments[2], { role });
      return sendJson(200, publicMember(result.member), headers, cookies);
    }
    if (request.method === "DELETE" && segments[2] && segments.length === 3) {
      const targetUserId = segments[2];
      if (targetUserId === authContext.user.id) {
        throw httpError(400, "You can't remove yourself from the team — use account → sign out instead.");
      }
      const result = await deleteTeamMember(authContext.team.id, targetUserId);
      if (result.blocked_last_owner) {
        throw httpError(409, "Can't remove the team's last owner.");
      }
      if (!result.removed) {
        throw httpError(404, "Team member not found.");
      }
      await audit(authContext.team.id, authContext.user, "member.removed", "user", targetUserId, {
        role: result.member?.role || "viewer"
      });
      return sendJson(200, { removed: targetUserId }, headers, cookies);
    }
  }
  return sendJson(404, { detail: "Not found" }, headers, cookies);
}

async function handleInvites(request, cookies, segments, authContext, headers) {
  const token = segments[1] || "";
  const invite = token ? await getTeamInviteByTokenHash(await sha256Hex(token)) : null;
  if (!invite) {
    throw httpError(404, "Invite not found or expired.");
  }
  const team = { id: invite.team_id, name: invite.team_name || "Team" };
  if (request.method === "GET") {
    return sendJson(200, publicInvite(invite, team), headers, cookies);
  }
  if (request.method === "POST" && segments[2] === "accept") {
    if (!authContext.authenticated) {
      throw httpError(401, "Sign in before accepting this invite.");
    }
    if (invite.email && invite.email !== authContext.user.email) {
      throw httpError(403, "This invite belongs to a different email address.");
    }
    // Re-check seats at accept time under the same team advisory lock used by
    // invite creation. That catches stale invites after a downgrade and
    // concurrent accept bursts, while preserving idempotency for users who are
    // already members of the team.
    const quota = await getQuotaForWorkspace(invite.team_id);
    const accepted = await acceptTeamInviteWithSeatLimit(invite, {
      team_id: invite.team_id,
      user_id: authContext.user.id,
      role: invite.role,
      invited_by: invite.created_by || null,
      created_at: nowIso()
    }, quota?.plan?.seats, nowIso());
    if (!accepted.ok) {
      if (accepted.invite_consumed) {
        throw httpError(409, "Invite has already been accepted.");
      }
      throw seatLimitError(quota, accepted.used);
    }
    // Accepting an invite should be idempotent for existing members. The store
    // returns the existing membership when one exists, so a stale/malicious
    // invite cannot upsert a stronger role around normal role-change guards.
    const effectiveRole = accepted.member?.role || invite.role;
    await audit(invite.team_id, authContext.user, "invite.accepted", "invite", invite.id, {
      role: effectiveRole,
      invited_role: invite.role
    });
    // Return a session payload anchored to the team the invite belongs to, so
    // the frontend can switch the active workspace to the freshly-joined team.
    const acceptedTeam = await getTeam(invite.team_id);
    const teams = await listTeamsForUser(authContext.user.id);
    return sendJson(200, {
      authenticated: true,
      user: {
        id: authContext.user.id,
        email: authContext.user.email,
        name: authContext.user.name,
        created_at: authContext.user.created_at
      },
      team: acceptedTeam || teams[0] || null,
      role: effectiveRole,
      permissions: permissionsForRole(effectiveRole),
      teams
    }, headers, cookies);
  }
  return sendJson(405, { detail: "Method not allowed" }, headers, cookies);
}

async function handleBilling(request, segments, authContext, workspaceId, headers, cookies) {
  if (request.method === "GET" && segments[1] === "status") {
    return sendJson(200, await billingStatus(authContext.team), headers, cookies);
  }
  if (request.method === "GET" && segments[1] === "usage") {
    // Usage meter — exposes both the hourly bucket (abuse guard) and the
    // monthly billing-cycle bucket (real SaaS quota) so the frontend can
    // render a clear "33 / 500 comparisons this month, resets May 31" UX.
    const env = globalThis.__stimliEnv || {};
    const windowMs = Number(env.STIMLI_RATE_LIMIT_WINDOW_MS || 60 * 60 * 1000);
    const hourlySince = new Date(Date.now() - windowMs).toISOString();
    const [status, quota, comparisonHour, assetHour] = await Promise.all([
      billingStatus(authContext.team),
      getQuotaForWorkspace(workspaceId),
      countUsageEvents({ kind: "comparison", since: hourlySince, workspaceId }),
      countUsageEvents({ kind: "asset", since: hourlySince, workspaceId })
    ]);
    const [comparisonMonth, assetMonth] = await Promise.all([
      countUsageEvents({ kind: "comparison", since: quota.period.start, workspaceId }),
      countUsageEvents({ kind: "asset", since: quota.period.start, workspaceId })
    ]);
    return sendJson(200, {
      plan: status.current_plan,
      subscription: status.subscription,
      billing_configured: status.billing_configured,
      commercial_use_enabled: status.commercial_use_enabled,
      limits: quota.hourly,
      monthly_limits: quota.monthly,
      period: quota.period,
      usage: {
        window_ms: windowMs,
        comparison: comparisonHour,
        asset: assetHour
      },
      monthly_usage: {
        comparison: comparisonMonth,
        asset: assetMonth
      }
    }, headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "checkout") {
    requirePermission(authContext, "billing:manage");
    const payload = await parseJson(request);
    return sendJson(200, await createCheckoutSession(request, authContext.team, payload.plan), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "portal") {
    requirePermission(authContext, "billing:manage");
    return sendJson(200, await createPortalSession(request, authContext.team), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "webhook") {
    const raw = await request.arrayBuffer();
    return sendJson(200, await handleBillingWebhook(getHeader(request, "stripe-signature"), new Uint8Array(raw)), headers, cookies);
  }
  return sendJson(404, { detail: "Not found" }, headers, cookies);
}

async function handleAdmin(request, segments, authContext, workspaceId, env, headers, cookies) {
  requirePermission(authContext, "jobs:manage");
  if (request.method === "GET" && segments[1] === "summary") {
    const [comparisons, providers, auditEvents] = await Promise.all([
      listComparisons(workspaceId),
      providerHealth(),
      listAuditEvents(workspaceId, 20)
    ]);
    const jobs = comparisonJobs(comparisons);
    return sendJson(200, {
      jobs: jobSummary(jobs),
      providers,
      recent_events: auditEvents,
      storage: storageHealth(),
      inference: {
        remote_configured: Boolean(env.TRIBE_INFERENCE_URL || env.TRIBE_CONTROL_URL),
        control_configured: Boolean(env.TRIBE_CONTROL_URL),
        extractor_configured: Boolean(env.STIMLI_EXTRACT_URL),
        strict_remote: env.STIMLI_BRAIN_PROVIDER === "tribe-remote"
      }
    }, headers, cookies);
  }
  if (request.method === "GET" && segments[1] === "jobs") {
    const status = new URL(request.url).searchParams.get("status");
    const jobs = comparisonJobs(await listComparisons(workspaceId));
    const filtered = status ? jobs.filter((job) => job.status === status) : jobs;
    return sendJson(200, filtered.slice(0, 200), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "jobs" && segments[2] && segments[3] === "retry") {
    const retried = await retryComparisonJob(segments[2], workspaceId, authContext.user, env);
    return sendJson(200, retried, headers, cookies);
  }
  return sendJson(404, { detail: "Not found" }, headers, cookies);
}

async function handleAudit(request, segments, authContext, workspaceId, headers, cookies) {
  requirePermission(authContext, "audit:read");
  if (request.method === "GET" && segments[1] === "events") {
    const limit = Number(new URL(request.url).searchParams.get("limit") || 100);
    return sendJson(200, await listAuditEvents(workspaceId, limit), headers, cookies);
  }
  return sendJson(404, { detail: "Not found" }, headers, cookies);
}

async function handleGovernance(request, segments, authContext, workspaceId, headers, cookies) {
  requirePermission(authContext, "governance:manage");
  if (request.method === "GET" && segments[1] === "export") {
    return sendJson(200, await workspaceExport(workspaceId, authContext), headers, cookies);
  }
  if (request.method === "GET" && segments[1] === "requests") {
    return sendJson(200, await listGovernanceRequests(workspaceId), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "deletion-requests") {
    const payload = await parseJson(request);
    const requestRecord = {
      id: newId("gov"),
      request_type: "deletion",
      target_type: normalizeTargetType(payload.target_type),
      target_id: String(payload.target_id || "").trim().slice(0, 160),
      reason: String(payload.reason || "").trim().slice(0, 1000),
      status: "pending_review",
      requested_by: authContext.user?.id || null,
      workspace_id: workspaceId,
      created_at: nowIso()
    };
    if (!requestRecord.target_id) {
      throw httpError(400, "Deletion target is required.");
    }
    await saveGovernanceRequest(requestRecord);
    await audit(workspaceId, authContext.user, "governance.deletion_requested", requestRecord.target_type, requestRecord.target_id, {
      request_id: requestRecord.id
    });
    return sendJson(200, requestRecord, headers, cookies);
  }
  if (request.method === "GET" && segments[1] === "policy") {
    return sendJson(200, governancePolicy(), headers, cookies);
  }
  return sendJson(404, { detail: "Not found" }, headers, cookies);
}

async function handleBrandProfiles(request, segments, authContext, workspaceId, headers, cookies) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(200, await listBrandProfiles(workspaceId), headers, cookies);
  }
  if (request.method === "POST" && segments.length === 1) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const payload = await parseJson(request);
    const profile = normalizeBrandProfile({ ...payload, id: newId("brand"), created_at: nowIso() }, workspaceId);
    await saveBrandProfile(profile);
    await audit(workspaceId, authContext.user, "brand_profile.created", "brand_profile", profile.id, { name: profile.name });
    return sendJson(200, profile, headers, cookies);
  }
  const profileId = segments[1];
  if (!profileId) {
    return sendJson(404, { detail: "Not found" }, headers, cookies);
  }
  const existing = await getBrandProfile(profileId, workspaceId);
  if (!existing) {
    throw httpError(404, "Brand profile not found.");
  }
  if (request.method === "GET" && segments.length === 2) {
    return sendJson(200, existing, headers, cookies);
  }
  if (request.method === "PATCH" && segments.length === 2) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const payload = await parseJson(request);
    const updated = normalizeBrandProfile({ ...existing, ...payload, id: existing.id, created_at: existing.created_at }, workspaceId);
    updated.updated_at = nowIso();
    await saveBrandProfile(updated);
    await audit(workspaceId, authContext.user, "brand_profile.updated", "brand_profile", updated.id, { name: updated.name });
    return sendJson(200, updated, headers, cookies);
  }
  if (request.method === "GET" && segments[2] === "export") {
    return sendJson(200, {
      schema: "stimli.brand_profile.v1",
      exported_at: nowIso(),
      profile: existing
    }, headers, cookies);
  }
  if (request.method === "DELETE" && segments.length === 2) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const removed = await deleteBrandProfile(existing.id, workspaceId);
    if (!removed) {
      throw httpError(404, "Brand profile not found.");
    }
    await audit(workspaceId, authContext.user, "brand_profile.deleted", "brand_profile", existing.id, {
      name: existing.name
    });
    return sendJson(200, { deleted: existing.id }, headers, cookies);
  }
  return sendJson(405, { detail: "Method not allowed" }, headers, cookies);
}

async function handleLibrary(request, segments, authContext, workspaceId, headers, cookies) {
  requirePermission(authContext, "workspace:read", { allowAnonymous: true });
  if (request.method === "GET" && segments[1] === "assets") {
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    const projectId = url.searchParams.get("project_id");
    const assets = (await listAssets(workspaceId))
      .filter((asset) => !type || asset.type === type)
      .filter((asset) => !projectId || asset.project_id === projectId)
      .map((asset) => ({
        ...publicAsset(asset),
        library: {
          text_length: String(asset.extracted_text || "").length,
          extraction_status: asset.metadata?.extraction_status || "provided",
          has_private_blob: Boolean(asset.metadata?.r2_key || asset.metadata?.blob_pathname),
          source: asset.source_url ? "url" : asset.metadata?.original_filename ? "file" : "text"
        }
      }));
    return sendJson(200, { assets, total: assets.length }, headers, cookies);
  }
  return sendJson(404, { detail: "Not found" }, headers, cookies);
}

async function handleImports(request, segments, authContext, workspaceId, headers, cookies) {
  if (request.method === "GET" && segments.length === 1) {
    requirePermission(authContext, "workspace:read", { allowAnonymous: true });
    return sendJson(200, await listIntegrationJobs(workspaceId), headers, cookies);
  }
  if (request.method === "POST" && segments.length === 1) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const payload = await parseJson(request);
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 50) : [];
    if (!items.length) {
      throw httpError(400, "Import items are required.");
    }
    const imported = [];
    const failed = [];
    const quota = await getQuotaForWorkspace(workspaceId);
    for (const item of items) {
      try {
        const assetType = assetTypes.has(item.asset_type) ? item.asset_type : "script";
        const projectId = await resolveProjectId(item.project_id || payload.project_id, workspaceId);
        const sourceUrl = item.url ? requirePublicSourceUrl(item.url) : "";
        await enforceUsageLimit(request, workspaceId, "asset", quota, authContext);
        const asset = {
          id: newId("asset"),
          type: assetType,
          name: String(item.name || sourceUrl || "Imported creative").trim().slice(0, 180),
          source_url: sourceUrl || null,
          file_path: null,
          extracted_text: String(item.text || item.notes || textFromFilename(item.name || sourceUrl || "Imported creative")).trim(),
          duration_seconds: optionalNonNegativeNumber(item.duration_seconds, "duration_seconds", { max: 24 * 60 * 60 }),
          metadata: { import_source: payload.source || "manual", import_platform: payload.platform || "csv" },
          workspace_id: workspaceId,
          project_id: projectId,
          created_at: nowIso()
        };
        await saveAsset(asset);
        imported.push(publicAsset(asset));
      } catch (error) {
        failed.push({ item: safeImportFailureItem(item), error: error.message });
      }
    }
    const job = {
      id: newId("import"),
      platform: normalizePlatform(payload.platform),
      source: payload.source || "manual",
      status: failed.length ? (imported.length ? "partial" : "failed") : "complete",
      total_items: items.length,
      imported_items: imported.length,
      failed_items: failed.length,
      failures: failed.slice(0, 20),
      workspace_id: workspaceId,
      created_at: nowIso()
    };
    await saveIntegrationJob(job);
    await audit(workspaceId, authContext.user, "import.completed", "import", job.id, {
      platform: job.platform,
      imported_items: imported.length,
      failed_items: failed.length
    });
    return sendJson(200, { job, assets: imported }, headers, cookies);
  }
  return sendJson(404, { detail: "Not found" }, headers, cookies);
}

async function handleValidation(request, segments, authContext, workspaceId, headers, cookies) {
  requirePermission(authContext, "validation:manage", { allowAnonymous: true });
  if (request.method === "GET" && segments[1] === "calibration") {
    const [outcomes, comparisons, runs] = await Promise.all([
      listOutcomes(null, workspaceId),
      listComparisons(workspaceId),
      listBenchmarkRuns(workspaceId)
    ]);
    return sendJson(200, {
      learning: learningSummary(outcomes, comparisons),
      confidence_bins: confidenceBins(outcomes, comparisons),
      benchmark_runs: runs.slice(0, 20)
    }, headers, cookies);
  }
  if (request.method === "GET" && segments[1] === "benchmarks") {
    return sendJson(200, benchmarkCatalog(), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "benchmarks" && segments[2] === "run") {
    const payload = await parseJson(request);
    const quota = await getQuotaForWorkspace(workspaceId);
    await enforceUsageLimit(request, workspaceId, "comparison", quota, authContext);
    const run = await runBenchmark(payload.benchmark_id || "dtc-hooks-v1", workspaceId);
    await saveBenchmarkRun(run);
    await audit(workspaceId, authContext.user, "validation.benchmark_run", "benchmark", run.id, {
      benchmark_id: run.benchmark_id,
      accuracy: run.accuracy
    });
    return sendJson(200, run, headers, cookies);
  }
  return sendJson(404, { detail: "Not found" }, headers, cookies);
}

async function handleAssets(request, segments, workspaceId, authContext, env, maxInlineFileBytes, maxDirectUploadBytes, headers, cookies) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(200, (await listAssets(workspaceId)).map(publicAsset), headers, cookies);
  }

  if (request.method === "POST" && segments.length === 1) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const { fields, files } = await parseForm(request, { maxFileBytes: maxDirectUploadBytes });
    const assetType = stringField(fields.asset_type ?? fields.assetType).toLowerCase();
    if (!assetTypes.has(assetType)) {
      throw httpError(400, "asset_type must be script, landing_page, image, audio, or video.");
    }

    const file = files.find((item) => item.fieldname === "file");
    if (file?.bytes?.length > maxDirectUploadBytes) {
      throw httpError(413, `Upload exceeds the ${maxDirectUploadBytes} byte limit.`);
    }
    const assetId = newId("asset");
    const url = stringField(fields.url);
    const resolvedUrl = url ? normalizePublicHttpUrl(url) : { ok: true, url: "" };
    if (url && !resolvedUrl.ok && assetType !== "landing_page") {
      throw httpError(400, `url must be a public http(s) URL (${resolvedUrl.reason}).`);
    }
    const sourceUrl = resolvedUrl.ok ? resolvedUrl.url : "";
    const finalName = stringField(fields.name).trim().slice(0, 180) || sourceUrl || stringField(file?.filename).trim().slice(0, 180) || "Untitled asset";
    const projectId = await resolveProjectId(stringField(fields.project_id ?? fields.projectId), workspaceId);
    const durationSeconds = optionalNonNegativeNumber(fields.duration_seconds, "duration_seconds", { max: 24 * 60 * 60 });
    let extractedText = stringField(fields.text);
    let extractionMetadata = {};

    if (file && assetType === "script" && !extractedText) {
      const maxScriptTextBytes = positiveNumber(env.STIMLI_MAX_SCRIPT_UPLOAD_TEXT_BYTES, 1_000_000);
      if (file.bytes.length > maxScriptTextBytes) {
        throw httpError(413, `Script upload exceeds the ${maxScriptTextBytes} byte text limit.`);
      }
      extractedText = new TextDecoder().decode(file.bytes);
    }
    if (assetType === "script") {
      enforceScriptTextLimit(extractedText, env);
    }

    const quota = await getQuotaForWorkspace(workspaceId);
    await enforceUsageLimit(request, workspaceId, "asset", quota, authContext);

    if (assetType === "landing_page" && url && !extractedText) {
      const extracted = await extractLandingPageText(sourceUrl || url, env);
      extractedText = extracted.text;
      extractionMetadata = extracted.metadata;
    }

    const blobMetadata = file ? await storeUploadedFile(file, workspaceId, assetId, env) : {};
    // Inline the file as base64 in metadata when it fits the limit, even if it's
    // also stored in R2. The extractor (Modal) reads file_base64 server-side and
    // R2 is the durable copy for the report UI. publicAsset() strips the inline
    // bytes from any client-visible response.
    const shouldInlineFile = file?.bytes?.length && file.bytes.length <= maxInlineFileBytes;
    const baseMetadata = {
      original_filename: file?.filename || null,
      file_size: file?.bytes?.length || null,
      content_type: file?.mimeType || null,
      ...(shouldInlineFile
        ? {
            file_base64: bytesToBase64(file.bytes),
            file_encoding: "base64"
          }
        : {}),
      ...(file?.bytes?.length && file.bytes.length > maxInlineFileBytes && !blobMetadata.r2_key
        ? {
            file_omitted: true,
            file_limit_bytes: maxInlineFileBytes
          }
        : {}),
      ...blobMetadata,
      ...extractionMetadata
    };

    if (["image", "audio", "video"].includes(assetType) && !extractedText) {
      const extracted = await extractAssetText({
        id: assetId,
        type: assetType,
        name: finalName,
        source_url: sourceUrl || null,
        extracted_text: "",
        duration_seconds: durationSeconds,
        metadata: baseMetadata
      }, env);
      if (extracted?.text) {
        extractedText = extracted.text;
      }
      if (extracted?.metadata) {
        extractionMetadata = {
          ...extractionMetadata,
          ...extracted.metadata,
          extractor_provider: extracted.provider,
          extraction_segments: extracted.segments
        };
      }
    }

    if (["image", "audio", "video"].includes(assetType) && !extractedText) {
      extractedText = textFromFilename(finalName);
      extractionMetadata.extraction_status ||= "fallback";
    }

    const asset = {
      id: assetId,
      type: assetType,
      name: finalName,
      source_url: sourceUrl || null,
      file_path: null,
      extracted_text: extractedText.trim(),
      duration_seconds: durationSeconds,
      metadata: { ...baseMetadata, ...extractionMetadata },
      workspace_id: workspaceId,
      project_id: projectId,
      created_at: nowIso()
    };
    await saveAsset(asset);
    await audit(workspaceId, authContext.user, "asset.created", "asset", asset.id, {
      name: asset.name,
      type: asset.type,
      project_id: asset.project_id || null
    });
    return sendJson(200, { asset: publicAsset(asset) }, headers, cookies);
  }

  if (request.method === "DELETE" && segments.length === 2 && segments[1]) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const assetId = segments[1];
    const existing = await getAsset(assetId, workspaceId);
    if (!existing) {
      throw httpError(404, "Asset not found.");
    }
    // Best-effort R2 cleanup. If the binding isn't present (R2 disabled) or
    // the key is missing, skip silently — the asset row is the source of
    // truth and that's what gets removed.
    const r2Key = existing.metadata?.r2_key || existing.metadata?.blob_pathname;
    if (r2Key && env?.STIMLI_MEDIA?.delete) {
      try {
        await env.STIMLI_MEDIA.delete(r2Key);
      } catch (e) {
        console.warn("R2 delete failed for", r2Key, e.message);
      }
    }
    const removed = await deleteAsset(assetId, workspaceId);
    if (!removed) {
      throw httpError(404, "Asset not found.");
    }
    await audit(workspaceId, authContext.user, "asset.deleted", "asset", assetId, {
      name: existing.name,
      type: existing.type
    });
    return sendJson(200, { deleted: assetId }, headers, cookies);
  }

  return sendJson(405, { detail: "Method not allowed" }, headers, cookies);
}

async function handleComparisons(request, segments, workspaceId, authContext, headers, cookies) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(200, (await listComparisons(workspaceId)).map(publicComparison), headers, cookies);
  }

  if (request.method === "POST" && segments.length === 1) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const payload = await parseJson(request);
    // Dedupe while preserving order: passing the same id twice would otherwise
    // pass the < 2 guard and produce a degenerate "tied with itself" comparison.
    const assetIds = [...new Set(Array.isArray(payload.asset_ids) ? payload.asset_ids : [])];
    if (assetIds.length < 2) {
      throw httpError(400, "At least two distinct asset_ids are required.");
    }

    // Fetch the assets concurrently — each getAsset is a separate Neon HTTP
    // round-trip, so a sequential loop added one round-trip of latency per
    // variant to a request that's already on the slow path.
    const assets = await Promise.all(assetIds.map((assetId) => getAsset(assetId, workspaceId)));
    const missingIndex = assets.findIndex((asset) => !asset);
    if (missingIndex !== -1) {
      throw httpError(404, `Asset not found: ${assetIds[missingIndex]}`);
    }
    // Project resolution and brief resolution are independent Neon lookups —
    // run them together rather than back-to-back.
    const [projectId, brief] = await Promise.all([
      resolveComparisonProjectId(payload.project_id || payload.projectId, assets, workspaceId),
      resolveComparisonBrief(payload, workspaceId)
    ]);
    const quota = await getQuotaForWorkspace(workspaceId);
    await enforceUsageLimit(request, workspaceId, "comparison", quota, authContext);

    const comparisonId = newId("cmp");
    const createdAt = nowIso();
    const rawComparison = shouldCreateAsyncComparison(payload, assets)
      ? await createAsyncComparison(comparisonId, payload.objective, assets, createdAt, brief)
      : await compareAssets(comparisonId, payload.objective, assets, createdAt, brief);
    rawComparison.workspace_id = workspaceId;
    rawComparison.project_id = projectId;
    if (payload.brand_profile_id || payload.brandProfileId) {
      rawComparison.brand_profile_id = payload.brand_profile_id || payload.brandProfileId;
    }
    const comparison = publicComparison(rawComparison);
    // Independent writes to different tables — run them together.
    await Promise.all([
      saveComparison(comparison),
      audit(workspaceId, authContext.user, "comparison.created", "comparison", comparison.id, {
        status: comparison.status,
        asset_count: comparison.variants.length,
        project_id: comparison.project_id || null
      })
    ]);
    return sendJson(comparison.status === "processing" ? 202 : 200, comparison, headers, cookies);
  }

  const comparisonId = segments[1];
  if (!comparisonId) {
    return sendJson(404, { detail: "Not found" }, headers, cookies);
  }

  if (request.method === "GET" && segments.length === 2) {
    return sendJson(200, await requireComparison(comparisonId, workspaceId), headers, cookies);
  }

  if (request.method === "DELETE" && segments.length === 2) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    // If it's still processing, cancel the remote jobs first so deleting the row
    // doesn't orphan Modal work; then remove the comparison and its cascade.
    const existing = await getComparison(comparisonId, workspaceId);
    if (existing && existing.status === "processing") {
      try {
        await cancelComparison(comparisonId, workspaceId, "Comparison deleted.");
      } catch (error) {
        console.warn("cancel-before-delete failed for", comparisonId, error.message);
      }
    }
    const removed = await deleteComparison(comparisonId, workspaceId);
    if (!removed) {
      throw httpError(404, "Comparison not found");
    }
    // audit stays sequential here — it must only run once the delete is
    // confirmed, otherwise a 404 would log a delete that never happened.
    await audit(workspaceId, authContext.user, "comparison.deleted", "comparison", comparisonId, {});
    return sendJson(200, { deleted: comparisonId }, headers, cookies);
  }

  if (request.method === "POST" && segments[2] === "cancel") {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const existing = await getComparison(comparisonId, workspaceId);
    if (!existing) {
      throw httpError(404, "Comparison not found");
    }
    const cancelled = await cancelComparison(comparisonId, workspaceId);
    // Only record a cancel that actually stopped a processing comparison —
    // cancel is a no-op on terminal states, so don't log a phantom event.
    if (existing.status === "processing") {
      await audit(workspaceId, authContext.user, "comparison.cancelled", "comparison", comparisonId, {});
    }
    return sendJson(200, cancelled, headers, cookies);
  }

  if (request.method === "POST" && segments[2] === "challengers") {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    // Always enforce the asset quota — /challengers creates a persistent
    // asset (saveAsset below) just like a direct /assets upload, and we need
    // the hourly abuse-protection bucket regardless of whether LLM polish
    // actually runs. The previous "skip when LLM off" optimization let
    // unauthenticated clients (allowAnonymous: true) flood the workspace
    // with templated asset rows; consistency with /assets POST is the safer
    // default.
    const quota = await getQuotaForWorkspace(workspaceId);
    await enforceUsageLimit(request, workspaceId, "asset", quota, authContext);
    const comparison = await requireCompleteComparison(comparisonId, workspaceId);
    const payload = await parseJson(request);
    const sourceId = payload.source_asset_id || comparison.recommendation.winner_asset_id;
    const sourceVariant = comparison.variants.find((variant) => variant.asset.id === sourceId);
    if (!sourceVariant) {
      throw httpError(400, "Source asset must belong to the comparison.");
    }
    const focus = ["hook", "cta", "offer", "clarity"].includes(payload.focus) ? payload.focus : "hook";
    const asset = {
      id: newId("asset"),
      type: sourceVariant.asset.type,
      name: `${sourceVariant.asset.name} - ${titleCase(focus)} Challenger`,
      source_url: sourceVariant.asset.source_url,
      file_path: null,
      extracted_text: await generateChallenger(sourceVariant.asset, comparison.brief, focus),
      duration_seconds: sourceVariant.asset.duration_seconds,
      metadata: {
        challenger: true,
        source_asset_id: sourceVariant.asset.id,
        comparison_id: comparison.id,
        focus
      },
      workspace_id: workspaceId,
      project_id: comparison.project_id || null,
      created_at: nowIso()
    };
    await saveAsset(asset);
    await audit(workspaceId, authContext.user, "asset.challenger_created", "asset", asset.id, {
      comparison_id: comparison.id,
      source_asset_id: sourceVariant.asset.id,
      focus
    });
    return sendJson(200, { asset: publicAsset(asset), source_asset_id: sourceVariant.asset.id, focus }, headers, cookies);
  }

  if (segments[2] === "outcomes") {
    if (request.method === "GET") {
      await requireComparison(comparisonId, workspaceId);
      return sendJson(200, await listOutcomes(comparisonId, workspaceId), headers, cookies);
    }

    if (request.method === "POST") {
      requirePermission(authContext, "workspace:write", { allowAnonymous: true });
      const comparison = await requireCompleteComparison(comparisonId, workspaceId);
      const payload = await parseJson(request);
      const variantIds = new Set(comparison.variants.map((variant) => variant.asset.id));
      if (!variantIds.has(payload.asset_id)) {
        throw httpError(400, "Outcome asset must belong to the comparison.");
      }
      const outcome = {
        id: newId("outcome"),
        comparison_id: comparisonId,
        asset_id: payload.asset_id,
        spend: outcomeMetric(payload.spend, "spend"),
        impressions: outcomeMetric(payload.impressions, "impressions", { integer: true }),
        clicks: outcomeMetric(payload.clicks, "clicks", { integer: true }),
        conversions: outcomeMetric(payload.conversions, "conversions", { integer: true }),
        revenue: outcomeMetric(payload.revenue, "revenue"),
        notes: payload.notes || "",
        workspace_id: workspaceId,
        created_at: nowIso()
      };
      await saveOutcome(outcome);
      await audit(workspaceId, authContext.user, "outcome.created", "outcome", outcome.id, {
        comparison_id: comparisonId,
        asset_id: outcome.asset_id
      });
      return sendJson(200, outcome, headers, cookies);
    }
  }

  return sendJson(405, { detail: "Method not allowed" }, headers, cookies);
}

async function handleReports(request, segments, workspaceId, authContext, env, headers, cookies) {
  if (request.method === "POST" && segments[1] && segments[2] === "share") {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const link = await createShareLink(request, segments[1], workspaceId, env);
    await audit(workspaceId, authContext.user, "report.shared", "comparison", segments[1], {
      expires_at: link.expires_at
    });
    return sendJson(200, link, headers, cookies);
  }

  if (request.method !== "GET" || !segments[1]) {
    return sendJson(405, { detail: "Method not allowed" }, headers, cookies);
  }
  const report = await buildReport(segments[1], workspaceId);
  if (segments[2] === "markdown") {
    return new Response(reportToMarkdown(report), {
      status: 200,
      headers: applyCookies({ ...headers, "Content-Type": "text/markdown; charset=utf-8" }, cookies)
    });
  }
  return sendJson(200, report, headers, cookies);
}

async function handleSharedReport(request, segments, headers, cookies) {
  if (request.method !== "GET" || !segments[1]) {
    return sendJson(405, { detail: "Method not allowed" }, headers, cookies);
  }
  const link = await getShareLink(await sha256Hex(segments[1]));
  if (!link) {
    throw httpError(404, "Shared report not found");
  }
  try {
    return sendJson(200, await buildReport(link.comparison_id, link.workspace_id), headers, cookies);
  } catch (error) {
    // A public share link must not leak the comparison's internal state. If the
    // underlying comparison isn't complete (409) or has gone missing (404),
    // collapse both to a uniform 404 so an anonymous holder of the token can't
    // distinguish "processing" from "deleted" from "never existed".
    const status = Number(error?.statusCode || error?.status);
    if (status === 409 || status === 404) {
      throw httpError(404, "Shared report not found");
    }
    throw error;
  }
}

async function createShareLink(request, comparisonId, workspaceId, env) {
  await requireCompleteComparison(comparisonId, workspaceId);
  const token = randomBase64url(18);
  const tokenHash = await sha256Hex(token);
  const ttlDays = Number((globalThis.__stimliEnv && globalThis.__stimliEnv.STIMLI_SHARE_LINK_TTL_DAYS) || 14);
  const link = {
    token_hash: tokenHash,
    workspace_id: workspaceId,
    comparison_id: comparisonId,
    expires_at: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString(),
    created_at: nowIso()
  };
  await saveShareLink(link);
  const origin = requestOrigin(request, env);
  return {
    token,
    path: `/share/${token}`,
    api_path: `/api/share/${token}`,
    url: `${origin}/share/${token}`,
    expires_at: link.expires_at
  };
}

async function buildReport(comparisonId, workspaceId) {
  const comparison = await requireCompleteComparison(comparisonId, workspaceId);
  const outcomes = await listOutcomes(comparisonId, workspaceId);
  const learning = learningSummary(outcomes, [comparison]);
  const winner = comparison.variants.find((variant) => variant.asset.id === comparison.recommendation.winner_asset_id);
  const executiveSummary = winner
    ? `${comparison.recommendation.headline}. Confidence is ${Math.round(comparison.recommendation.confidence * 100)}%. The leading variant scored ${winner.analysis.scores.overall}/100.`
    : comparison.recommendation.headline;
  return {
    comparison_id: comparison.id,
    title: "Stimli Creative Decision Report",
    executive_summary: executiveSummary,
    recommendation: comparison.recommendation,
    variants: comparison.variants,
    suggestions: comparison.suggestions,
    brief: comparison.brief,
    compliance: comparison.compliance ?? null,
    learning_summary: learning,
    next_steps: [
      "Apply high-severity edits to the current leader.",
      "Create one focused challenger that changes only the hook.",
      "Launch the winner with a clean post-flight label so outcome data can calibrate future scoring."
    ]
  };
}

async function seedDemo(workspaceId, projectId = null) {
  await clearDemoAssets(workspaceId);
  const samples = [
    {
      id: newId("asset"),
      type: "script",
      name: "Variant A - Pain-led skincare hook",
      extracted_text:
        "Stop wasting money on ten-step routines that still leave your skin dry. The Lumina barrier kit uses one proven morning system to lock in hydration for 24 hours. Thousands of customers switched after seeing calmer skin in seven days. Try the starter kit today.",
      duration_seconds: 28,
      metadata: { demo: true, channel: "paid social" },
      workspace_id: workspaceId,
      project_id: projectId,
      created_at: nowIso()
    },
    {
      id: newId("asset"),
      type: "script",
      name: "Variant B - Generic product story",
      extracted_text:
        "Our skincare brand is a revolutionary ecosystem for modern self care. We combine quality ingredients with a holistic approach designed for everyone. It is simple, premium, and made to fit your lifestyle.",
      duration_seconds: 25,
      metadata: { demo: true, channel: "paid social" },
      workspace_id: workspaceId,
      project_id: projectId,
      created_at: nowIso()
    },
    {
      id: newId("asset"),
      type: "landing_page",
      name: "Landing Page - Offer dense",
      source_url: "https://example.com/lumina",
      extracted_text:
        "Lumina Hydration System. New customer bundle. Save 20 percent today. Dermatologist tested formula with ceramides, peptides, and daily SPF support. Shop the starter kit now and get free shipping.",
      metadata: { demo: true, channel: "landing page" },
      workspace_id: workspaceId,
      project_id: projectId,
      created_at: nowIso()
    }
  ];
  for (const asset of samples) {
    asset.file_path = null;
    asset.duration_seconds ??= null;
    await saveAsset(asset);
  }
  return samples;
}

async function requireComparison(comparisonId, workspaceId) {
  const comparison = await getComparison(comparisonId, workspaceId);
  if (!comparison) {
    throw httpError(404, "Comparison not found");
  }
  return publicComparison(await refreshComparison(comparison, workspaceId));
}

async function requireCompleteComparison(comparisonId, workspaceId) {
  const comparison = await requireComparison(comparisonId, workspaceId);
  if (comparison.status !== "complete") {
    throw httpError(409, "Comparison is still processing.");
  }
  return comparison;
}

async function createAsyncComparison(comparisonId, objective, assets, createdAt, brief) {
  // Snapshot the request env at entry so all TRIBE control-plane calls below
  // land on the same TRIBE_CONTROL_URL / TRIBE_API_KEY even if a concurrent
  // request overwrites globalThis.__stimliEnv mid-await.
  const requestEnv = globalThis.__stimliEnv || {};
  try {
    const jobs = await Promise.all(assets.map((asset) => startBrainJob(asset, requestEnv)));
    return createPendingComparison(comparisonId, objective, assets, createdAt, brief, jobs);
  } catch (error) {
    // The hosted Modal control plane couldn't accept the jobs (cold start,
    // scaled to zero, auth, or network failure). Rather than 500 the whole
    // request, fall back to a synchronous in-process comparison so the user
    // still gets a result. compareAssets → predictBrain will itself try the
    // inference endpoint and degrade to the heuristic if that's down too.
    noteRemoteBrainFailure(error?.message || "control-plane enqueue failed");
    try { console.warn(`[comparisons] async enqueue failed, running inline: ${error?.message || error}`); } catch {}
    return compareAssets(comparisonId, objective, assets, createdAt, brief);
  }
}

async function refreshComparison(comparison, workspaceId) {
  // Snapshot env at function entry so every TRIBE control-plane call below
  // hits the same endpoint+key, even if a concurrent request overwrites
  // globalThis.__stimliEnv between the awaits in this function.
  const requestEnv = globalThis.__stimliEnv || {};
  if (comparison.status !== "processing" || !Array.isArray(comparison.jobs) || !requestEnv.TRIBE_CONTROL_URL) {
    return comparison;
  }
  if (comparisonExpired(comparison)) {
    return await cancelComparison(comparison.id, workspaceId, "Analysis timed out before every model job finished.");
  }

  const jobStatuses = await Promise.all(
    comparison.jobs.map(async (job) => {
      try {
        return await getBrainJob(job.job_id, requestEnv);
      } catch (error) {
        return { ...job, status: job.status || "processing", polling_error: error.message };
      }
    })
  );
  const updatedJobs = jobStatuses.map(publicJobStatus);

  if (jobStatuses.some((job) => job.status === "cancelled")) {
    const cancelled = cancelledComparison(comparison, updatedJobs, "Analysis was cancelled.");
    await saveComparison(publicComparison(cancelled));
    return cancelled;
  }

  if (jobStatuses.some((job) => job.status === "failed")) {
    const failureReasons = updatedJobs.map((job) => job.error).filter(Boolean).slice(0, 3);
    const failed = {
      ...comparison,
      status: "failed",
      jobs: updatedJobs,
      variants: withJobStatuses(comparison.variants, updatedJobs),
      recommendation: {
        winner_asset_id: null,
        verdict: "revise",
        confidence: 0,
        headline: "Analysis failed before a shipping recommendation could be made",
        reasons: failureReasons.length ? failureReasons : ["A remote analysis job failed."]
      }
    };
    await saveComparison(publicComparison(failed));
    return failed;
  }

  const completeJobs = jobStatuses.filter((job) => job.status === "complete");
  if (completeJobs.length === comparison.jobs.length) {
    const assets = [];
    for (const variant of comparison.variants) {
      const asset = await getAsset(variant.asset.id, workspaceId);
      if (!asset) {
        throw httpError(404, `Asset not found: ${variant.asset.id}`);
      }
      assets.push(asset);
    }
    const brainByAssetId = Object.fromEntries(
      completeJobs.map((job) => [
        job.asset_id,
        {
          provider: "tribe-remote",
          timeline: job.timeline || job.result?.timeline || []
        }
      ])
    );
    const completed = await compareAssetsWithBrain(
      comparison.id,
      comparison.objective,
      assets,
      comparison.created_at,
      comparison.brief,
      brainByAssetId
    );
    completed.workspace_id = workspaceId;
    completed.project_id = comparison.project_id || null;
    completed.jobs = updatedJobs;
    await saveComparison(publicComparison(completed));
    return completed;
  }

  const processing = {
    ...comparison,
    jobs: updatedJobs,
    variants: withJobStatuses(comparison.variants, updatedJobs)
  };
  await saveComparison(publicComparison(processing));
  return processing;
}

async function cancelComparison(comparisonId, workspaceId, reason = "Analysis was cancelled.") {
  const requestEnv = globalThis.__stimliEnv || {};
  const comparison = await getComparison(comparisonId, workspaceId);
  if (!comparison) {
    throw httpError(404, "Comparison not found");
  }
  // Never overwrite a terminal comparison. Cancelling a completed analysis would
  // wipe its winner and scores, so cancel is a no-op once the comparison has
  // reached complete/failed/cancelled — it just returns the current state.
  if (comparison.status !== "processing") {
    return publicComparison(comparison);
  }
  const jobs = Array.isArray(comparison.jobs) ? comparison.jobs : [];
  const updatedJobs = await Promise.all(
    jobs.map(async (job) => {
      if (!requestEnv.TRIBE_CONTROL_URL || ["complete", "failed", "cancelled"].includes(job.status)) {
        return job;
      }
      try {
        return publicJobStatus(await cancelBrainJob(job.job_id, requestEnv));
      } catch (error) {
        return { ...job, status: "cancelled", error: error.message, updated_at: nowIso() };
      }
    })
  );
  const cancelled = cancelledComparison(comparison, updatedJobs, reason);
  await saveComparison(publicComparison(cancelled));
  return publicComparison(cancelled);
}

function cancelledComparison(comparison, jobs, reason) {
  return {
    ...comparison,
    status: "cancelled",
    jobs,
    variants: withJobStatuses(comparison.variants || [], jobs),
    recommendation: {
      winner_asset_id: null,
      verdict: "revise",
      confidence: 0,
      headline: "Analysis cancelled before a shipping recommendation could be made",
      reasons: [reason]
    }
  };
}

function publicComparison(comparison) {
  return {
    ...comparison,
    variants: (comparison.variants || []).map((variant) => ({
      ...variant,
      asset: publicAsset(variant.asset)
    }))
  };
}

function publicJobStatus(job) {
  return {
    job_id: job.job_id,
    asset_id: job.asset_id,
    status: job.status || "processing",
    provider: job.provider || "tribe-remote",
    error: safeDiagnosticMessage(job.error || job.polling_error) || null,
    attempt: Number.isFinite(Number(job.attempt)) ? Number(job.attempt) : null,
    created_at: job.created_at || null,
    updated_at: job.updated_at || nowIso()
  };
}

function safeDiagnosticMessage(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/g, "$1[redacted]@")
    .replace(
      /([?&][^=\s&]*(?:access[-_]?key|api[-_]?key|authorization|credential|password|passwd|secret|signature|token)[^=\s&]*=)[^&\s]+/gi,
      "$1[redacted]"
    )
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, "[redacted]")
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/g, "[redacted]");
  return text.slice(0, 180);
}

function withJobStatuses(variants, jobs) {
  const jobByAssetId = new Map(jobs.map((job) => [job.asset_id, job]));
  return variants.map((variant) => {
    const job = jobByAssetId.get(variant.asset.id);
    return job
      ? {
          ...variant,
          analysis: {
            ...variant.analysis,
            provider: job.provider || variant.analysis.provider,
            status: job.status || variant.analysis.status
          }
        }
      : variant;
  });
}

function comparisonExpired(comparison) {
  const maxAgeMs = Number(globalThis.__stimliEnv?.STIMLI_COMPARISON_JOB_TIMEOUT_MS || 20 * 60 * 1000);
  const created = Date.parse(comparison.created_at || "");
  return Number.isFinite(created) && Date.now() - created > maxAgeMs;
}

function publicAsset(asset) {
  const metadata = { ...(asset.metadata || {}) };
  delete metadata.file_base64;
  delete metadata.file_encoding;
  delete metadata.blob_url;
  delete metadata.blob_download_url;
  delete metadata.r2_signed_url;
  return { ...asset, metadata };
}

async function storeUploadedFile(file, workspaceId, assetId, env) {
  if (!env?.STIMLI_MEDIA) {
    return {};
  }
  const safeName = safeBlobName(file.filename || `${assetId}.bin`);
  const key = `workspaces/${workspaceId}/assets/${assetId}/${Date.now()}-${safeName}`;
  await env.STIMLI_MEDIA.put(key, file.bytes, {
    httpMetadata: { contentType: file.mimeType || "application/octet-stream" },
    customMetadata: {
      workspace_id: workspaceId,
      asset_id: assetId,
      original_filename: file.filename || ""
    }
  });
  return {
    blob_access: "private",
    blob_pathname: key,
    r2_key: key,
    r2_bucket: "stimli-media",
    blob_content_type: file.mimeType || null,
    blob_size: file.bytes.length,
    original_filename: file.filename || null
  };
}

function safeBlobName(name) {
  const basename = String(name).split(/[\\/]/).pop() || "upload.bin";
  const safe = basename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "upload.bin";
}

function learningSummary(outcomes, comparisons = []) {
  const totalSpend = round(outcomes.reduce((sum, outcome) => sum + Number(outcome.spend || 0), 0), 2);
  const totalRevenue = round(outcomes.reduce((sum, outcome) => sum + Number(outcome.revenue || 0), 0), 2);
  const totalImpressions = outcomes.reduce((sum, outcome) => sum + Number(outcome.impressions || 0), 0);
  const totalClicks = outcomes.reduce((sum, outcome) => sum + Number(outcome.clicks || 0), 0);
  const totalConversions = outcomes.reduce((sum, outcome) => sum + Number(outcome.conversions || 0), 0);
  const best = outcomes.length
    ? [...outcomes].sort((left, right) => right.revenue - right.spend - (left.revenue - left.spend) || right.conversions - left.conversions || right.clicks - left.clicks)[0]
    : null;
  const calibration = calibrationSummary(outcomes, comparisons);
  return {
    outcome_count: outcomes.length,
    total_spend: totalSpend,
    total_revenue: totalRevenue,
    average_ctr: totalImpressions ? round(totalClicks / totalImpressions, 4) : 0,
    average_cvr: totalClicks ? round(totalConversions / totalClicks, 4) : 0,
    best_asset_id: best?.asset_id || null,
    calibration,
    insight: outcomes.length
      ? calibration.evaluated_comparisons
        ? `${calibration.aligned_predictions}/${calibration.evaluated_comparisons} predictions matched the strongest logged outcome.`
        : "Outcome data is ready to compare pre-spend predictions with launch performance."
      : "No launch outcomes logged yet. Add post-flight results after a test campaign."
  };
}

// Pairs every completed comparison that has at least one logged outcome with
// its strongest actual outcome, returning one evaluation per comparison. Shared
// by calibrationSummary (which slices to the 5 most recent for display) and
// confidenceBins (which needs the full set so observed accuracy isn't silently
// capped at 5 samples).
function calibrationEvaluations(outcomes, comparisons) {
  const outcomesByComparison = new Map();
  for (const outcome of outcomes) {
    if (!outcomesByComparison.has(outcome.comparison_id)) {
      outcomesByComparison.set(outcome.comparison_id, []);
    }
    outcomesByComparison.get(outcome.comparison_id).push(outcome);
  }

  return comparisons
    .filter((comparison) => comparison.status === "complete" && comparison.recommendation?.winner_asset_id)
    .map((comparison) => {
      const comparisonOutcomes = outcomesByComparison.get(comparison.id) || [];
      if (!comparisonOutcomes.length) {
        return null;
      }
      const actual = [...comparisonOutcomes].sort(outcomeRank)[0];
      const predicted = comparison.recommendation.winner_asset_id;
      const predictedOutcome = comparisonOutcomes.find((outcome) => outcome.asset_id === predicted) || null;
      return {
        comparison_id: comparison.id,
        predicted_asset_id: predicted,
        actual_best_asset_id: actual.asset_id,
        aligned: actual.asset_id === predicted,
        actual_profit: round(Number(actual.revenue || 0) - Number(actual.spend || 0), 2),
        predicted_profit: predictedOutcome ? round(Number(predictedOutcome.revenue || 0) - Number(predictedOutcome.spend || 0), 2) : null
      };
    })
    .filter(Boolean);
}

function calibrationSummary(outcomes, comparisons) {
  const evaluations = calibrationEvaluations(outcomes, comparisons);
  const aligned = evaluations.filter((evaluation) => evaluation.aligned).length;
  return {
    evaluated_comparisons: evaluations.length,
    aligned_predictions: aligned,
    alignment_rate: evaluations.length ? round(aligned / evaluations.length, 3) : 0,
    recent: evaluations.slice(0, 5)
  };
}

function outcomeRank(left, right) {
  return (
    Number(right.revenue || 0) -
    Number(right.spend || 0) -
    (Number(left.revenue || 0) - Number(left.spend || 0)) ||
    Number(right.conversions || 0) - Number(left.conversions || 0) ||
    Number(right.clicks || 0) - Number(left.clicks || 0)
  );
}

async function extractLandingPageText(rawUrl, env = {}) {
  const resolved = normalizePublicHttpUrl(rawUrl);
  const fallbackUrl = resolved.ok ? resolved.url : "";
  if (!resolved.ok) {
    return {
      text: landingPageFallbackText(fallbackUrl),
      metadata: { extraction_status: "blocked", extraction_error: resolved.reason }
    };
  }
  let url = resolved.url;
  const maxBytes = positiveNumber(env.STIMLI_LANDING_PAGE_MAX_BYTES, 1_000_000);
  const maxRedirects = positiveNumber(env.STIMLI_LANDING_PAGE_MAX_REDIRECTS, 5);
  if (!directLandingPageFetchAllowed(url, env)) {
    return {
      text: landingPageFallbackText(url),
      metadata: { extraction_status: "blocked", extraction_error: "direct_fetch_not_allowed" }
    };
  }
  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await fetch(url, {
        headers: { "User-Agent": "Stimli creative analyzer" },
        signal: AbortSignal.timeout(6000),
        redirect: "manual"
      });
      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location") || "";
        if (!location) {
          return {
            text: landingPageFallbackText(url),
            metadata: { extraction_status: "blocked", extraction_error: "redirect_missing_location", status_code: response.status }
          };
        }
        const nextUrl = new URL(location, url).toString();
        const next = normalizePublicHttpUrl(nextUrl);
        if (!next.ok) {
          return {
            text: landingPageFallbackText(fallbackUrl),
            metadata: { extraction_status: "blocked", extraction_error: `redirect_${next.reason}`, status_code: response.status }
          };
        }
        if (!directLandingPageFetchAllowed(next.url, env)) {
          return {
            text: landingPageFallbackText(next.url),
            metadata: { extraction_status: "blocked", extraction_error: "redirect_direct_fetch_not_allowed", status_code: response.status }
          };
        }
        url = next.url;
        continue;
      }
      if (!response.ok) {
        return {
          text: landingPageFallbackText(url),
          metadata: { extraction_status: "blocked", status_code: response.status }
        };
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType && !isReadablePageContentType(contentType)) {
        return {
          text: landingPageFallbackText(url),
          metadata: { extraction_status: "blocked", content_type: contentType.slice(0, 120) }
        };
      }
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        return {
          text: landingPageFallbackText(url),
          metadata: { extraction_status: "blocked", content_length: contentLength, max_bytes: maxBytes }
        };
      }
      const html = await responseTextWithLimit(response, maxBytes);
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 8000);
      return {
        text: text || landingPageFallbackText(url, { short: true }),
        metadata: { extraction_status: text ? "success" : "empty", final_url: url }
      };
    }
    return {
      text: landingPageFallbackText(fallbackUrl),
      metadata: { extraction_status: "blocked", extraction_error: "too_many_redirects" }
    };
  } catch (error) {
    return {
      text: landingPageFallbackText(url),
      metadata: { extraction_status: "error", extraction_error: error.message }
    };
  }
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function requirePublicSourceUrl(rawUrl) {
  const normalized = normalizePublicHttpUrl(rawUrl);
  if (!normalized.ok) {
    throw httpError(400, `url must be a public http(s) URL (${normalized.reason}).`);
  }
  return normalized.url;
}

function directLandingPageFetchAllowed(rawUrl, env = {}) {
  if (env.STIMLI_ALLOW_DIRECT_LANDING_FETCH === "1") return true;
  const allowedHosts = String(env.STIMLI_LANDING_PAGE_FETCH_ALLOWLIST || "")
    .split(",")
    .map((host) => host.trim().replace(/^\*\./, "").toLowerCase())
    .filter(Boolean);
  if (!allowedHosts.length) return false;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function enforceScriptTextLimit(text, env = {}) {
  if (!text) return;
  const maxScriptTextBytes = positiveNumber(env.STIMLI_MAX_SCRIPT_UPLOAD_TEXT_BYTES, 1_000_000);
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > maxScriptTextBytes) {
    throw httpError(413, `Script upload exceeds the ${maxScriptTextBytes} byte text limit.`);
  }
}

function safeImportFailureItem(item = {}) {
  const url = item.url ? normalizePublicHttpUrl(item.url) : { ok: false };
  const duration = Number(item.duration_seconds);
  return {
    asset_type: assetTypes.has(item.asset_type) ? item.asset_type : "script",
    name: String(item.name || "").trim().slice(0, 180) || null,
    url: url.ok ? url.url : null,
    duration_seconds: Number.isFinite(duration) && duration >= 0 ? duration : null
  };
}

function normalizePublicHttpUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return { ok: false, reason: "empty_url" };
  let parsed;
  try {
    parsed = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input) ? input : `https://${input}`);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, reason: "unsupported_scheme" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "credentials_not_allowed" };
  }
  if (isBlockedHostname(parsed.hostname)) {
    return { ok: false, reason: "private_or_local_host" };
  }
  stripSensitiveSearchParams(parsed);
  parsed.hash = "";
  return { ok: true, url: parsed.toString() };
}

function stripSensitiveSearchParams(parsed) {
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveUrlParam(key)) parsed.searchParams.delete(key);
  }
}

function isSensitiveUrlParam(name) {
  const normalized = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "auth" ||
    normalized === "apikey" ||
    normalized === "code" ||
    normalized === "jwt" ||
    normalized === "key" ||
    normalized === "session" ||
    normalized === "sessionid" ||
    normalized === "sid" ||
    normalized === "sig" ||
    normalized.includes("accesskey") ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.includes("password") ||
    normalized.includes("passwd") ||
    normalized.includes("secret") ||
    normalized.includes("signature") ||
    normalized.includes("token")
  );
}

function landingPageFallbackText(url, options = {}) {
  const target = url ? ` at ${url}` : " URL";
  const suffix = options.short ? "Add page copy for deeper scoring." : "Add page copy or upload a screenshot transcript for deeper scoring.";
  return `Landing page${target}. ${suffix}`;
}

function isReadablePageContentType(contentType) {
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  return (
    !type ||
    type.startsWith("text/") ||
    type === "application/xhtml+xml" ||
    type === "application/xml" ||
    type === "application/json"
  );
}

async function responseTextWithLimit(response, maxBytes) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`Landing page response exceeded ${maxBytes} bytes.`);
    return new TextDecoder().decode(bytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`Landing page response exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isBlockedHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "metadata.google.internal") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host);
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4(host) {
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(host) {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  const mappedIpv4 = ipv4FromMappedIpv6(value);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  );
}

function ipv4FromMappedIpv6(value) {
  const prefix = "::ffff:";
  if (!value.startsWith(prefix)) return null;
  const suffix = value.slice(prefix.length);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(suffix)) return suffix;
  const hextets = suffix.split(":");
  if (hextets.length !== 2) return null;
  const [high, low] = hextets.map((part) => Number.parseInt(part, 16));
  if ([high, low].some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

function reportToMarkdown(report) {
  const lines = [
    `# ${report.title}`,
    "",
    report.executive_summary,
    "",
    "## Recommendation",
    "",
    `- Verdict: ${report.recommendation.verdict}`,
    `- Confidence: ${Math.round(report.recommendation.confidence * 100)}%`,
    `- Winner: ${report.recommendation.winner_asset_id || "None"}`,
    "",
    "## Reasons",
    "",
    ...report.recommendation.reasons.map((reason) => `- ${reason}`),
    "",
    "## Variant Scores",
    "",
    "| Rank | Variant | Overall | Hook | CTA | Offer | Audience |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.variants.map((variant) => {
      const scores = variant.analysis.scores;
      // Escape the user-controlled variant name so a "|" in it can't break the
      // Markdown table layout.
      return `| ${variant.rank} | ${mdCell(variant.asset.name)} | ${scores.overall} | ${scores.hook} | ${scores.cta} | ${scores.offer_strength} | ${scores.audience_fit} |`;
    }),
    "",
    "## Edit Cards",
    ""
  ];
  for (const suggestion of report.suggestions) {
    const window = suggestion.evidence_window;
    const evidenceLine = window
      ? `Evidence: ${window.channel.replace("_", " ")} reaches ${Math.round((window.low_value || 0) * 100)}/100 between ${window.start_s.toFixed(1)}s and ${window.end_s.toFixed(1)}s.`
      : null;
    const dimensionLine = suggestion.dimension_score != null
      ? suggestion.compared_score != null && suggestion.compared_to_asset_id
        ? `Dimension score: ${suggestion.dimension_score}/100 (leading variant scores ${suggestion.compared_score}).`
        : `Dimension score: ${suggestion.dimension_score}/100.`
      : null;
    const liftLine = suggestion.expected_lift != null && suggestion.expected_lift > 0
      ? `Expected lift on composite: +${suggestion.expected_lift} pts.`
      : null;
    lines.push(
      `### ${suggestion.target}`,
      "",
      `Severity: ${suggestion.severity}`,
      ""
    );
    if (dimensionLine) lines.push(dimensionLine, "");
    if (evidenceLine) lines.push(evidenceLine, "");
    if (liftLine) lines.push(liftLine, "");
    lines.push(
      `Issue: ${suggestion.issue}`,
      "",
      `Edit: ${suggestion.suggested_edit}`,
      "",
      `Draft: ${suggestion.draft_revision || "No draft available."}`,
      ""
    );
  }
  const complianceReports = Array.isArray(report.compliance) ? report.compliance : [];
  if (complianceReports.length) {
    const variantNameById = new Map(report.variants.map((variant) => [variant.asset.id, variant.asset.name]));
    const flaggedRows = complianceReports.filter(
      (row) => (row.missing_required && row.missing_required.length) || (row.forbidden_hits && row.forbidden_hits.length)
    );
    if (flaggedRows.length) {
      lines.push("## Brief Checks", "");
      for (const row of flaggedRows) {
        const variantLabel = variantNameById.get(row.asset_id) || row.asset_id;
        lines.push(`### ${variantLabel}`, "");
        if (Array.isArray(row.missing_required) && row.missing_required.length) {
          lines.push(`- Missing required: ${row.missing_required.join("; ")}`);
        }
        if (Array.isArray(row.forbidden_hits) && row.forbidden_hits.length) {
          const hits = row.forbidden_hits
            .map((hit) => hit.evidence ? `${hit.term} (“${hit.evidence}”)` : hit.term)
            .join("; ");
          lines.push(`- Forbidden term hits: ${hits}`);
        }
        if (row.truncated) {
          lines.push("- Note: variant text exceeded the brief-check sample window; missing-claim verdicts may be incomplete.");
        }
        lines.push("");
      }
    }
  }
  lines.push("## Next Steps", "", ...report.next_steps.map((step) => `- ${step}`), "");
  return lines.join("\n");
}

async function parseJson(request) {
  try {
    const maxBytes = positiveNumber(globalThis.__stimliEnv?.STIMLI_MAX_JSON_BYTES, 1_000_000);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > maxBytes) {
      throw httpError(413, `JSON payload exceeds the ${maxBytes} byte limit.`);
    }
    const body = await request.text();
    if (!body) return {};
    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > maxBytes) {
      throw httpError(413, `JSON payload exceeds the ${maxBytes} byte limit.`);
    }
    return JSON.parse(body);
  } catch (err) {
    if (err?.statusCode || err?.status) throw err;
    throw httpError(400, "Invalid JSON payload.");
  }
}

async function parseForm(request, options = {}) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    const payload = await parseJson(request);
    return { fields: payload, files: [] };
  }

  const maxFieldBytes = positiveNumber(globalThis.__stimliEnv?.STIMLI_MAX_FORM_FIELD_BYTES, 1_000_000);
  const maxFileBytes = positiveNumber(options.maxFileBytes, Number.POSITIVE_INFINITY);
  const fields = {};
  const files = [];
  const form = await request.formData();
  for (const [name, value] of form.entries()) {
    if (value instanceof File) {
      if (Number.isFinite(maxFileBytes) && value.size > maxFileBytes) {
        throw httpError(413, `Upload exceeds the ${maxFileBytes} byte limit.`);
      }
      const bytes = new Uint8Array(await value.arrayBuffer());
      if (Number.isFinite(maxFileBytes) && bytes.length > maxFileBytes) {
        throw httpError(413, `Upload exceeds the ${maxFileBytes} byte limit.`);
      }
      files.push({
        fieldname: name,
        filename: value.name,
        mimeType: value.type || "application/octet-stream",
        bytes
      });
    } else {
      if (new TextEncoder().encode(String(value)).byteLength > maxFieldBytes) {
        throw httpError(413, `Form field '${name}' exceeds the ${maxFieldBytes} byte limit.`);
      }
      fields[name] = value;
    }
  }
  return { fields, files };
}

function stringField(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function textFromFilename(name) {
  return `Creative asset named ${String(name).replace(/\.[^.]+$/, "").replace(/[-_]/g, " ")}. Add transcript or visual notes for deeper scoring.`;
}

function baseHeaders(request, env) {
  // Stash env globally so the handful of post-response helpers (refreshComparison,
  // comparisonExpired, createShareLink) can read it without threading env through
  // every signature. Safe because Workers serialize requests within an isolate.
  globalThis.__stimliEnv = env;
  const headers = {};
  const allowedOrigin = allowedCorsOrigin(request, env);
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Vary"] = "Origin";
    if (allowedOrigin !== "*") {
      headers["Access-Control-Allow-Credentials"] = "true";
    }
  }
  headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Stimli-Workspace, X-Stimli-Team";
  // Retry-After and X-Request-Id aren't CORS-safelisted response headers, so a
  // cross-origin API consumer can't read our throttle hint or correlation id
  // unless we expose them explicitly.
  headers["Access-Control-Expose-Headers"] = "Retry-After, X-Request-Id";
  headers["Cache-Control"] = "no-store";
  headers["X-Content-Type-Options"] = "nosniff";
  headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
  headers["X-Frame-Options"] = "DENY";
  headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
  return headers;
}

function allowedCorsOrigin(request, env) {
  const origin = request.headers.get("origin") || "";
  if (!origin) return "*";
  const configured = [
    env.STIMLI_APP_URL,
    env.STIMLI_ORIGIN,
    "https://stimli.pages.dev"
  ];
  const extra = String(env.STIMLI_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if ([...configured, ...extra].filter(Boolean).includes(origin)) {
    return origin;
  }
  try {
    const parsed = new URL(origin);
    const allowLocal = env.STIMLI_TEST_MODE === "1" || env.STIMLI_ALLOW_LOCAL_ORIGINS === "1";
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (!allowLocal && isLocal) return "";
    if (isLocal && ["3000", "5173", "8000", "8788"].includes(parsed.port)) {
      return origin;
    }
  } catch {
    return "";
  }
  return "";
}

function workspaceForRequest(request) {
  const raw = request.headers.get("x-stimli-workspace") || "";
  if (!raw) return "public";
  const workspaceId = String(raw).trim();
  if (!/^[A-Za-z0-9_-]{3,96}$/.test(workspaceId)) {
    throw httpError(400, "Invalid workspace id.");
  }
  // This fallback is only reached for requests with no authenticated session
  // (the caller short-circuits on authContext.workspace_id first). team_*
  // workspaces are server-issued and belong to a real tenant; reaching one here
  // means an anonymous client is trying to read/write another team's data by
  // setting the X-Stimli-Workspace header to a team id. Reject it — team data
  // is only reachable through an authenticated session whose membership
  // resolves to that team.
  if (/^team_/i.test(workspaceId)) {
    throw httpError(403, "This workspace requires sign-in.");
  }
  return workspaceId;
}

async function resolveProjectId(rawProjectId, workspaceId) {
  const projectId = String(rawProjectId || "").trim();
  if (!projectId || projectId === "all") return null;
  if (!/^[A-Za-z0-9_-]{3,96}$/.test(projectId)) {
    throw httpError(400, "Invalid project id.");
  }
  const project = await getProject(projectId, workspaceId);
  if (!project) throw httpError(404, "Project not found.");
  return project.id;
}

async function resolveComparisonProjectId(rawProjectId, assets, workspaceId) {
  const explicitProjectId = await resolveProjectId(rawProjectId, workspaceId);
  if (explicitProjectId) return explicitProjectId;
  const assetProjectIds = [...new Set(assets.map((asset) => asset.project_id).filter(Boolean))];
  return assetProjectIds.length === 1 ? assetProjectIds[0] : null;
}

async function resolveComparisonBrief(payload, workspaceId) {
  const profileId = payload.brand_profile_id || payload.brandProfileId || "";
  const explicitBrief = payload.brief || {};
  if (!profileId) return explicitBrief;
  const profile = await getBrandProfile(profileId, workspaceId);
  if (!profile) throw httpError(404, "Brand profile not found.");
  return {
    ...(profile.brief || {}),
    ...explicitBrief,
    required_claims: mergeLists(profile.brief?.required_claims, explicitBrief.required_claims),
    forbidden_terms: mergeLists(profile.brief?.forbidden_terms, explicitBrief.forbidden_terms),
    voice_rules: mergeLists(profile.voice_rules, explicitBrief.voice_rules)
  };
}

async function enforceUsageLimit(request, workspaceId, kind, quota, authContext = null, options = {}) {
  const env = globalThis.__stimliEnv || {};
  if (env.STIMLI_DISABLE_RATE_LIMITS === "1") return;
  const units = Math.max(1, Math.floor(Number(options.units) || 1));

  const hourlyLimit = quota?.hourly?.[kind];
  const monthlyLimit = quota?.monthly?.[kind];
  const windowMs = Number(env.STIMLI_RATE_LIMIT_WINDOW_MS || 60 * 60 * 1000);
  const hourlySince = new Date(Date.now() - windowMs).toISOString();
  const bucketKey = await clientBucketKey(request, workspaceId, authContext);

  // Hourly bucket is abuse protection — checked against both the workspace and
  // a per-client hash so a flood from one IP can't drain a paid quota. Monthly
  // bucket is the real SaaS quota; we tie it to the billing cycle start so
  // upgrades or renewal resets work cleanly.
  const queries = [];
  if (Number.isFinite(hourlyLimit) && hourlyLimit > 0) {
    queries.push(countUsageEvents({ kind, since: hourlySince, workspaceId }));
    queries.push(countUsageEvents({ kind, since: hourlySince, bucketKey }));
  } else {
    queries.push(Promise.resolve(0), Promise.resolve(0));
  }
  if (Number.isFinite(monthlyLimit) && monthlyLimit > 0 && quota?.period?.start) {
    queries.push(countUsageEvents({ kind, since: quota.period.start, workspaceId }));
  } else {
    queries.push(Promise.resolve(0));
  }
  const [hourlyWorkspace, hourlyClient, monthlyWorkspace] = await Promise.all(queries);

  // Fast path: pre-check the counts so the common over-limit case returns a
  // precise 402/429 with good detail before we attempt the write.
  throwIfOverLimit({ hourlyWorkspace, hourlyClient, monthlyWorkspace }, { kind, hourlyLimit, monthlyLimit, windowMs, quota, units });

  // Atomic gate: record the usage event only if every limit still has headroom.
  // Disabled tiers pass a huge limit so they never block. This closes the
  // check-then-insert race — without it two concurrent requests both pass the
  // pre-check and both write, overshooting the quota.
  const huge = Number.MAX_SAFE_INTEGER;
  const effMonthlyLimit = Number.isFinite(monthlyLimit) && monthlyLimit > 0 && quota?.period?.start ? monthlyLimit : huge;
  const effHourlyLimit = Number.isFinite(hourlyLimit) && hourlyLimit > 0 ? hourlyLimit : huge;
  const recorded = await saveUsageEventConditional(
    {
      id: newId("usage"),
      kind,
      payload: {
        hourly_limit: hourlyLimit || null,
        monthly_limit: monthlyLimit || null,
        window_ms: windowMs,
        plan: quota.plan?.id || null,
        units
      },
      created_at: nowIso()
    },
    {
      workspaceId,
      bucketKey,
      monthlySince: quota?.period?.start || hourlySince,
      monthlyLimit: effMonthlyLimit,
      hourlySince,
      hourlyLimit: effHourlyLimit
    }
  );

  if (!recorded) {
    // Lost the race: another request consumed the last of the quota between our
    // pre-check and our conditional insert. Re-read the counts to report the
    // limit that actually blocked us.
    const [hw, hc, mw] = await Promise.all([
      Number.isFinite(hourlyLimit) && hourlyLimit > 0 ? countUsageEvents({ kind, since: hourlySince, workspaceId }) : Promise.resolve(0),
      Number.isFinite(hourlyLimit) && hourlyLimit > 0 ? countUsageEvents({ kind, since: hourlySince, bucketKey }) : Promise.resolve(0),
      Number.isFinite(monthlyLimit) && monthlyLimit > 0 && quota?.period?.start
        ? countUsageEvents({ kind, since: quota.period.start, workspaceId })
        : Promise.resolve(0)
    ]);
    throwIfOverLimit({ hourlyWorkspace: hw, hourlyClient: hc, monthlyWorkspace: mw }, { kind, hourlyLimit, monthlyLimit, windowMs, quota, units });
    // The guard blocked the insert but a re-read shows headroom (rare clock/
    // window edge). Treat as a transient rate-limit rather than silently
    // allowing an unrecorded request through.
    const err = httpError(429, "Rate limit reached. Try again in a few minutes.");
    err.code = "rate_limited";
    err.details = { kind, limit: hourlyLimit || monthlyLimit || null, window_ms: windowMs, plan: quota.plan?.id || null, units };
    throw err;
  }
}

function throwIfOverLimit({ hourlyWorkspace, hourlyClient, monthlyWorkspace }, { kind, hourlyLimit, monthlyLimit, windowMs, quota, units = 1 }) {
  if (Number.isFinite(monthlyLimit) && monthlyLimit > 0 && monthlyWorkspace + units > monthlyLimit) {
    // 402 is the right status for a billing-quota block — the client should
    // surface an upgrade CTA, not a generic retry-later message.
    const err = httpError(
      402,
      `Monthly ${kind} quota reached on the ${quota.plan?.name || "current"} plan. Upgrade to keep shipping.`
    );
    err.code = "quota_exceeded";
    err.details = {
      kind,
      limit: monthlyLimit,
      used: monthlyWorkspace,
      requested: units,
      plan: quota.plan?.id || null,
      reset_at: quota.period?.end || null,
      upgrade_url: "/?billing=upgrade"
    };
    throw err;
  }

  if (Number.isFinite(hourlyLimit) && hourlyLimit > 0 && Math.max(hourlyWorkspace, hourlyClient) + units > hourlyLimit) {
    const err = httpError(429, "Hourly rate limit reached. Try again in a few minutes.");
    err.code = "rate_limited";
    err.details = {
      kind,
      limit: hourlyLimit,
      used: Math.max(hourlyWorkspace, hourlyClient),
      requested: units,
      window_ms: windowMs,
      plan: quota.plan?.id || null
    };
    throw err;
  }
}

function memoryStoreAllowed(env) {
  return env.STIMLI_TEST_MODE === "1" || env.STIMLI_ALLOW_MEMORY_STORE === "1";
}

function seatLimitError(quota, used = 0) {
  const seats = Number(quota?.plan?.seats);
  const err = httpError(
    402,
    `Seat limit reached on the ${quota?.plan?.name || "current"} plan (${seats || 0} seats). Upgrade to invite more teammates.`
  );
  err.code = "seat_limit_reached";
  err.details = {
    kind: "seat",
    limit: Number.isFinite(seats) ? seats : 0,
    used: Number.isFinite(Number(used)) ? Number(used) : 0,
    plan: quota?.plan?.id || null,
    upgrade_url: "/?billing=upgrade"
  };
  return err;
}

async function clientBucketKey(request, workspaceId, authContext = null) {
  if (authContext?.authenticated && authContext.user?.id) {
    return `client_user_${workspaceId}_${authContext.user.id}`.slice(0, 180);
  }
  const cfIp = (request.headers.get("cf-connecting-ip") || "").trim();
  const allowForwardedFallback = globalThis.__stimliEnv?.STIMLI_TEST_MODE === "1" || globalThis.__stimliEnv?.STIMLI_TRUST_FORWARDED_FOR === "1";
  const forwardedFor = allowForwardedFallback ? (request.headers.get("x-forwarded-for") || "").split(",")[0]?.trim() : "";
  const realIp = allowForwardedFallback ? (request.headers.get("x-real-ip") || "").trim() : "";
  const userAgent = (request.headers.get("user-agent") || "").slice(0, 180);
  const source = cfIp || forwardedFor || realIp ? `${cfIp || forwardedFor || realIp}|${userAgent}` : `workspace:${workspaceId}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return `client_${bytesToHex(new Uint8Array(buf)).slice(0, 32)}`;
}

function requirePermission(authContext, permission, options = {}) {
  if (options.allowAnonymous && !authContext.authenticated) return;
  if (!authContext.authenticated) throw httpError(401, "Sign in before using this workspace control.");
  if (!authContext.permissions?.includes(permission)) throw httpError(403, "Your role does not allow this action.");
}

function assertCanGrantRole(authContext, role) {
  if (["owner", "admin"].includes(role) && authContext.role !== "owner") {
    throw httpError(403, "Only owners can grant owner or admin roles.");
  }
}

async function audit(workspaceId, actor, action, targetType, targetId, details = {}) {
  await saveAuditEvent({
    id: newId("audit"),
    workspace_id: workspaceId,
    actor_id: actor?.id || "",
    actor_email: actor?.email || "",
    action,
    target_type: targetType || "",
    target_id: targetId || "",
    details,
    created_at: nowIso()
  });
}

function publicMember(member) {
  const user = member.user || {};
  return {
    user_id: member.user_id,
    role: member.role || "viewer",
    email: user.email || "",
    name: user.name || "",
    created_at: member.created_at,
    updated_at: member.updated_at || null
  };
}

function normalizeRole(value) {
  let role = String(value || "").trim().toLowerCase();
  if (role === "member") role = "analyst";
  if (!["owner", "admin", "analyst", "viewer"].includes(role)) {
    throw httpError(400, "Role must be owner, admin, analyst, or viewer.");
  }
  return role;
}

function comparisonJobs(comparisons) {
  return comparisons.flatMap((comparison) =>
    (comparison.jobs || []).map((job) => {
      const variant = (comparison.variants || []).find((item) => item.asset?.id === job.asset_id);
      return {
        ...job,
        comparison_id: comparison.id,
        comparison_status: comparison.status,
        asset_name: variant?.asset?.name || job.asset_id,
        objective: comparison.objective,
        project_id: comparison.project_id || null
      };
    })
  );
}

function jobSummary(jobs) {
  const counts = { total: jobs.length, queued: 0, processing: 0, running: 0, retrying: 0, complete: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) {
    const status = job.status || "processing";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

async function retryComparisonJob(jobId, workspaceId, actor, env) {
  if (!env.TRIBE_CONTROL_URL) throw httpError(503, "Hosted job control is not configured.");
  const comparisons = await listComparisons(workspaceId);
  const comparison = comparisons.find((item) => (item.jobs || []).some((job) => job.job_id === jobId));
  if (!comparison) throw httpError(404, "Job not found.");
  const job = comparison.jobs.find((item) => item.job_id === jobId);
  if (!["failed", "cancelled"].includes(job.status)) throw httpError(409, "Only failed or cancelled jobs can be retried.");
  const maxRetries = Number(env.STIMLI_MODAL_JOB_RETRIES || 2);
  const attempt = Number(job.attempt || 0) + 1;
  if (attempt > maxRetries) throw httpError(409, "Retry limit reached for this job.");
  const asset = await getAsset(job.asset_id, workspaceId);
  if (!asset) throw httpError(404, "Job asset was deleted or is unavailable.");
  const started = publicJobStatus(await startBrainJob(asset, env));
  const retryJob = { ...started, attempt, previous_job_id: job.job_id, status: started.status || "queued", updated_at: nowIso() };
  const jobs = comparison.jobs.map((item) => (item.job_id === jobId ? retryJob : item));
  const updated = {
    ...comparison,
    status: "processing",
    jobs,
    variants: withJobStatuses(comparison.variants || [], jobs),
    recommendation: {
      winner_asset_id: null,
      verdict: "revise",
      confidence: 0,
      headline: "Retrying hosted inference",
      reasons: ["A failed inference job was restarted and this decision will refresh when the hosted model returns."]
    }
  };
  await saveComparison(publicComparison(updated));
  await audit(workspaceId, actor, "job.retried", "job", retryJob.job_id, {
    comparison_id: comparison.id,
    previous_job_id: job.job_id,
    attempt
  });
  return publicComparison(updated);
}

async function workspaceExport(workspaceId, authContext) {
  const [projects, assets, comparisons, outcomes, audits, brands, requests, benchmarkRuns, imports, members] = await Promise.all([
    listProjects(workspaceId),
    listAssets(workspaceId),
    listComparisons(workspaceId),
    listOutcomes(null, workspaceId),
    listAuditEvents(workspaceId, 500),
    listBrandProfiles(workspaceId),
    listGovernanceRequests(workspaceId),
    listBenchmarkRuns(workspaceId),
    listIntegrationJobs(workspaceId),
    authContext.team ? listTeamMembers(authContext.team.id) : []
  ]);
  return {
    schema: "stimli.workspace_export.v1",
    exported_at: nowIso(),
    workspace_id: workspaceId,
    policy: governancePolicy(),
    projects,
    assets: assets.map(publicAsset),
    comparisons: comparisons.map(publicComparison),
    outcomes,
    audit_events: audits,
    brand_profiles: brands,
    governance_requests: requests,
    benchmark_runs: benchmarkRuns,
    imports,
    members: members.map(publicMember)
  };
}

function governancePolicy() {
  const env = globalThis.__stimliEnv || {};
  return {
    private_uploads: true,
    public_share_links: true,
    share_link_ttl_days: Number(env.STIMLI_SHARE_LINK_TTL_DAYS || 14),
    deletion_workflow: "request_review",
    export_scope: "workspace",
    retention_days: Number(env.STIMLI_RETENTION_DAYS || 365),
    commercial_license_mode: env.STIMLI_TRIBE_COMMERCIAL_LICENSE === "1" ? "commercial-ready" : "research-only"
  };
}

function normalizeTargetType(value) {
  const type = String(value || "asset").trim().toLowerCase();
  return ["asset", "comparison", "project", "workspace", "user"].includes(type) ? type : "asset";
}

function normalizeBrandProfile(payload, workspaceId) {
  const name = String(payload.name || payload.brief?.brand_name || "").trim();
  if (name.length < 2) throw httpError(400, "Brand profile name is required.");
  const brief = payload.brief || payload;
  const createdAt = payload.created_at || nowIso();
  return {
    id: payload.id || newId("brand"),
    name: name.slice(0, 120),
    brief: {
      brand_name: String(brief.brand_name || name).trim().slice(0, 120),
      audience: String(brief.audience || "").trim().slice(0, 500),
      product_category: String(brief.product_category || "").trim().slice(0, 240),
      primary_offer: String(brief.primary_offer || "").trim().slice(0, 240),
      required_claims: cleanStringList(brief.required_claims),
      forbidden_terms: cleanStringList(brief.forbidden_terms)
    },
    voice_rules: cleanStringList(payload.voice_rules),
    compliance_notes: cleanStringList(payload.compliance_notes),
    workspace_id: workspaceId,
    created_at: createdAt,
    updated_at: payload.updated_at || createdAt
  };
}

function cleanStringList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return raw.map((item) => String(item).trim()).filter(Boolean).slice(0, 25);
}

function mergeLists(first, second) {
  return [...new Set([...cleanStringList(first), ...cleanStringList(second)])];
}

function normalizePlatform(value) {
  const platform = String(value || "manual").trim().toLowerCase();
  return ["manual", "meta", "tiktok", "youtube", "google", "csv", "urls"].includes(platform) ? platform : "manual";
}

function benchmarkCatalog() {
  return [
    {
      id: "dtc-hooks-v1",
      name: "DTC hook and offer benchmark",
      description: "Pairs strong pain-led hooks against generic product stories to validate winner selection.",
      cases: 3
    }
  ];
}

async function runBenchmark(benchmarkId, workspaceId) {
  const benchmark = benchmarkCatalog().find((item) => item.id === benchmarkId) || benchmarkCatalog()[0];
  const cases = [
    {
      expected: "A",
      assets: [
        { label: "A", text: "Stop wasting budget on ads people skip after three seconds. Try the starter kit with free shipping today." },
        { label: "B", text: "Our brand is an innovative ecosystem for modern people who want quality and convenience." }
      ]
    },
    {
      expected: "A",
      assets: [
        { label: "A", text: "Dry skin by lunch? This 24 hour hydration kit locks moisture in before your morning commute." },
        { label: "B", text: "We make premium skincare with thoughtful ingredients for your everyday lifestyle." }
      ]
    },
    {
      expected: "B",
      assets: [
        { label: "A", text: "A skincare ecosystem designed for all your needs with a holistic approach to modern beauty." },
        { label: "B", text: "Before you buy another serum, fix the barrier problem first. Start with the tested hydration kit." }
      ]
    }
  ];
  const results = [];
  for (const testCase of cases) {
    const assets = testCase.assets.map((item) => ({
      id: newId("bench_asset"),
      type: "script",
      name: `Benchmark ${item.label}`,
      extracted_text: item.text,
      source_url: null,
      file_path: null,
      metadata: { benchmark: true },
      workspace_id: workspaceId,
      created_at: nowIso()
    }));
    const comparison = await compareAssets(newId("bench_cmp"), "Pick the stronger benchmark creative.", assets, nowIso(), {
      brand_name: "Lumina",
      audience: "DTC paid social shoppers",
      primary_offer: "starter kit"
    });
    const winner = comparison.variants.find((variant) => variant.asset.id === comparison.recommendation.winner_asset_id);
    const predictedLabel = winner?.asset.name.endsWith("A") ? "A" : "B";
    results.push({
      expected: testCase.expected,
      predicted: predictedLabel,
      aligned: predictedLabel === testCase.expected,
      confidence: comparison.recommendation.confidence,
      winner_score: winner?.analysis.scores.overall || 0
    });
  }
  const aligned = results.filter((item) => item.aligned).length;
  return {
    id: newId("bench"),
    benchmark_id: benchmark.id,
    benchmark_name: benchmark.name,
    case_count: results.length,
    aligned,
    accuracy: results.length ? round(aligned / results.length, 3) : 0,
    average_confidence: results.length ? round(results.reduce((sum, item) => sum + item.confidence, 0) / results.length, 3) : 0,
    results,
    workspace_id: workspaceId,
    created_at: nowIso()
  };
}

function confidenceBins(outcomes, comparisons) {
  // Bin every evaluated comparison, not just the 5 most recent — observed
  // accuracy per confidence band is only meaningful across the full history.
  const evaluations = calibrationEvaluations(outcomes, comparisons);
  const confidenceByComparison = new Map(
    comparisons.map((item) => [item.id, item?.recommendation?.confidence || 0])
  );
  const bins = [
    { label: "50-65%", min: 0.5, max: 0.65, predictions: 0, aligned: 0 },
    { label: "65-80%", min: 0.65, max: 0.8, predictions: 0, aligned: 0 },
    { label: "80-95%", min: 0.8, max: 0.95, predictions: 0, aligned: 0 }
  ];
  for (const evaluation of evaluations) {
    const confidence = confidenceByComparison.get(evaluation.comparison_id) || 0;
    const bin = bins.find((item) => confidence >= item.min && confidence < item.max) || bins[bins.length - 1];
    bin.predictions += 1;
    bin.aligned += evaluation.aligned ? 1 : 0;
  }
  return bins.map((bin) => ({
    ...bin,
    observed_accuracy: bin.predictions ? round(bin.aligned / bin.predictions, 3) : 0
  }));
}

function publicInvite(invite, team) {
  return {
    id: invite.id,
    team_id: invite.team_id,
    team_name: team.name || invite.team_name || "Team",
    email: invite.email || "",
    role: invite.role || "member",
    expires_at: invite.expires_at,
    accepted_at: invite.accepted_at || null,
    created_at: invite.created_at
  };
}

function normalizeInviteEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email) throw httpError(400, "Invite email is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "Invite email is invalid.");
  return email;
}

function getHeader(request, name) {
  return request.headers.get(name) || "";
}

function requestOrigin(request, env) {
  if (env?.STIMLI_APP_URL) {
    const configured = String(env.STIMLI_APP_URL).replace(/\/$/, "");
    return pagesPreviewOrigin(request, configured) || configured;
  }
  if (env?.STIMLI_ORIGIN) {
    const configured = String(env.STIMLI_ORIGIN).replace(/\/$/, "");
    return pagesPreviewOrigin(request, configured) || configured;
  }
  return requestOriginFromRequest(request);
}

function pagesPreviewOrigin(request, configuredOrigin) {
  try {
    const configured = new URL(configuredOrigin);
    const actual = new URL(request.url);
    if (configured.hostname !== "stimli.pages.dev") return "";
    if (actual.protocol !== "https:") return "";
    if (actual.hostname === configured.hostname || actual.hostname.endsWith(`.${configured.hostname}`)) {
      return actual.origin;
    }
  } catch {
    return "";
  }
  return "";
}

function requestOriginFromRequest(request) {
  try {
    return new URL(request.url).origin;
  } catch {
    return "https://stimli.pages.dev";
  }
}

function applyCookies(headers, cookies) {
  const merged = new Headers(headers);
  for (const cookie of cookies.values()) {
    merged.append("Set-Cookie", cookie);
  }
  return merged;
}

function sendJson(status, payload, headers, cookies) {
  const merged = applyCookies({ ...headers, "Content-Type": "application/json; charset=utf-8" }, cookies);
  return new Response(JSON.stringify(payload), { status, headers: merged });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function titleCase(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

// Render a value safely inside a Markdown table cell: collapse newlines and
// escape pipe characters so user-controlled text can't break the table.
function mdCell(value) {
  return String(value ?? "").replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalNonNegativeNumber(value, label, options = {}) {
  if (value === undefined || value === null || value === "") return null;
  const cleaned = String(value).replace(/[,$\s]/g, "");
  const parsed = Number(cleaned);
  if (!cleaned || !Number.isFinite(parsed) || parsed < 0) {
    throw httpError(400, `${label} must be a non-negative number.`);
  }
  if (options.integer && !Number.isInteger(parsed)) {
    throw httpError(400, `${label} must be a whole number.`);
  }
  const max = Number(options.max);
  if (Number.isFinite(max) && parsed > max) {
    throw httpError(400, `${label} is too large.`);
  }
  return parsed;
}

function outcomeMetric(value, label, options = {}) {
  return optionalNonNegativeNumber(value, label, { max: 1_000_000_000_000, ...options }) ?? 0;
}

function randomBase64url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64url(bytes);
}

function bytesToBase64url(bytes) {
  const b64 = bytesToBase64(bytes);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

async function sha256Hex(token) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token || "")));
  return bytesToHex(new Uint8Array(buf));
}

class CookieSink {
  constructor() {
    this._cookies = [];
  }
  setHeader(name, value) {
    if (String(name).toLowerCase() === "set-cookie") {
      this._cookies.push(value);
    }
  }
  values() {
    return this._cookies;
  }
}
