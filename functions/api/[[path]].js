// Cloudflare Pages Function entry point for the Stimli API.
//
// Mirrors api/[...path].js (the Vercel handler) one-to-one in behaviour. The
// changes here are runtime-shaped only:
// - The handler is exported as onRequest({ request, env, ... }) instead of
//   the Vercel default(request, response) signature.
// - request is a Web API Request; we return new Response(...) at the end.
// - Multipart parsing uses request.formData() (native to Workers) instead of
//   busboy.
// - Uploaded files are written to R2 via env.ASSETS.put(...) instead of
//   @vercel/blob's put() and handleUpload(). There is no "direct-from-client"
//   token route on Cloudflare; the frontend always sends multipart to
//   /api/assets and the Worker forwards bytes to R2. The 25 MB limit matches
//   what Pages Functions accept for a request body.
// - crypto operations use Web Crypto (SHA-256 via crypto.subtle, randomness
//   via crypto.getRandomValues, UUIDs via crypto.randomUUID).
// - All env access flows through the configure*(env) calls on each lib.

import {
  buildChallengerText,
  cancelBrainJob,
  compareAssets,
  compareAssetsWithBrain,
  configureAnalysis,
  createPendingComparison,
  extractAssetText,
  getBrainJob,
  newId,
  nowIso,
  providerHealth,
  shouldCreateAsyncComparison,
  startBrainJob
} from "./_lib/analysis.js";
import {
  authenticationOptions,
  authSessionPayload,
  configureAuth,
  getAuthContext,
  hashToken,
  logout,
  registrationOptions,
  switchTeam,
  verifyAuthentication,
  verifyRegistration
} from "./_lib/auth.js";
import {
  billingStatus,
  configureBilling,
  createCheckoutSession,
  createPortalSession,
  handleBillingWebhook,
  usageLimitsForWorkspace
} from "./_lib/billing.js";
import {
  configureStore,
  getAsset,
  getBrandProfile,
  getComparison,
  getProject,
  countUsageEvents,
  getTeamInviteByTokenHash,
  getTeamMember,
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
  listTeamInvites,
  getShareLink,
  saveAuditEvent,
  saveAsset,
  saveBenchmarkRun,
  saveBrandProfile,
  saveComparison,
  saveGovernanceRequest,
  saveIntegrationJob,
  saveOutcome,
  saveProject,
  saveTeamInvite,
  saveTeamMember,
  saveShareLink,
  saveUsageEvent,
  storageHealth,
  updateTeamMemberRole
} from "./_lib/store.js";

const assetTypes = new Set(["script", "landing_page", "image", "audio", "video"]);

export async function onRequest(context) {
  const { request, env } = context;
  configureStore(env);
  configureAuth(env);
  configureAnalysis(env);
  configureBilling(env);

  const maxInlineFileBytes = Number(env.STIMLI_MAX_INLINE_FILE_BYTES || 8 * 1024 * 1024);

  const cookies = new CookieSink();
  const headers = baseHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const url = new URL(request.url);
    const apiPath = url.pathname.replace(/^\/api/, "") || "/";
    const segments = apiPath.split("/").filter(Boolean);

    if (request.method === "GET" && apiPath === "/health") {
      return sendJson(200, { status: "ok", storage: storageHealth() }, headers, cookies);
    }

    if (request.method === "GET" && apiPath === "/brain/providers") {
      return sendJson(200, await providerHealth(), headers, cookies);
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
      const payload = await parseJson(request);
      const projectId = await resolveProjectId(payload.project_id, workspaceId);
      return sendJson(200, await seedDemo(workspaceId, projectId), headers, cookies);
    }

    if (segments[0] === "projects") {
      return await handleProjects(request, segments, workspaceId, authContext, headers, cookies);
    }

    if (segments[0] === "assets") {
      return await handleAssets(request, segments, workspaceId, authContext, env, maxInlineFileBytes, headers, cookies);
    }

    if (segments[0] === "comparisons") {
      return await handleComparisons(request, segments, workspaceId, authContext, headers, cookies);
    }

    if (segments[0] === "reports") {
      return await handleReports(request, segments, workspaceId, authContext, headers, cookies);
    }

    if (request.method === "GET" && apiPath === "/learning/summary") {
      const [outcomes, comparisons] = await Promise.all([listOutcomes(null, workspaceId), listComparisons(workspaceId)]);
      return sendJson(200, learningSummary(outcomes, comparisons), headers, cookies);
    }

    return sendJson(404, { detail: "Not found" }, headers, cookies);
  } catch (error) {
    const status = Number(error.statusCode || error.status || 500);
    const message = status >= 500 ? "Request failed" : error.message;
    if (status >= 500) {
      console.error(error);
    }
    return sendJson(status, { detail: message }, headers, cookies);
  }
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
  const payload = request.method === "POST" ? await parseJson(request) : {};

  if (request.method === "GET" && segments[1] === "session") {
    return sendJson(200, await authSessionPayload(request), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "register" && segments[2] === "options") {
    return sendJson(200, await registrationOptions(request, payload), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "register" && segments[2] === "verify") {
    return sendJson(200, await verifyRegistration(request, cookies, payload), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "login" && segments[2] === "options") {
    return sendJson(200, await authenticationOptions(request, payload), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "login" && segments[2] === "verify") {
    return sendJson(200, await verifyAuthentication(request, cookies, payload), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "logout") {
    return sendJson(200, await logout(request, cookies), headers, cookies);
  }
  if (request.method === "POST" && segments[1] === "team") {
    return sendJson(200, await switchTeam(request, cookies, payload), headers, cookies);
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
      const token = randomBase64url(24);
      const invite = {
        id: newId("invite"),
        token_hash: await hashToken(token),
        team_id: authContext.team.id,
        team_name: authContext.team.name,
        email: normalizeInviteEmail(payload.email),
        role: normalizeRole(payload.role || "analyst"),
        created_by: authContext.user.id,
        expires_at: new Date(Date.now() + Number(env.STIMLI_INVITE_TTL_DAYS || 14) * 24 * 60 * 60 * 1000).toISOString(),
        created_at: nowIso()
      };
      await saveTeamInvite(invite);
      await audit(authContext.team.id, authContext.user, "invite.created", "invite", invite.id, {
        email: invite.email,
        role: invite.role
      });
      const origin = requestOrigin(request, env);
      return sendJson(200, {
        ...publicInvite(invite, authContext.team),
        url: `${origin}/invite/${token}`,
        token
      }, headers, cookies);
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
      const updated = await updateTeamMemberRole(authContext.team.id, segments[2], role);
      if (!updated) {
        throw httpError(404, "Team member not found.");
      }
      await audit(authContext.team.id, authContext.user, "member.role_updated", "user", segments[2], { role });
      return sendJson(200, publicMember(updated), headers, cookies);
    }
  }
  return sendJson(404, { detail: "Not found" }, headers, cookies);
}

async function handleInvites(request, cookies, segments, authContext, headers) {
  const token = segments[1] || "";
  const invite = token ? await getTeamInviteByTokenHash(await hashToken(token)) : null;
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
    await saveTeamMember({
      team_id: invite.team_id,
      user_id: authContext.user.id,
      role: invite.role,
      invited_by: invite.created_by || null,
      created_at: nowIso()
    });
    await saveTeamInvite({
      ...invite,
      accepted_by: authContext.user.id,
      accepted_at: nowIso()
    });
    await audit(invite.team_id, authContext.user, "invite.accepted", "invite", invite.id, {
      role: invite.role
    });
    return sendJson(200, await switchTeam(request, cookies, { team_id: invite.team_id }), headers, cookies);
  }
  return sendJson(405, { detail: "Method not allowed" }, headers, cookies);
}

async function handleBilling(request, segments, authContext, _workspaceId, headers, cookies) {
  if (request.method === "GET" && segments[1] === "status") {
    return sendJson(200, await billingStatus(authContext.team), headers, cookies);
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
    const profile = normalizeBrandProfile(payload, workspaceId);
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
    for (const item of items) {
      try {
        const assetType = assetTypes.has(item.asset_type) ? item.asset_type : "script";
        const projectId = await resolveProjectId(item.project_id || payload.project_id, workspaceId);
        const asset = {
          id: newId("asset"),
          type: assetType,
          name: String(item.name || item.url || "Imported creative").trim().slice(0, 180),
          source_url: item.url || null,
          file_path: null,
          extracted_text: String(item.text || item.notes || textFromFilename(item.name || item.url || "Imported creative")).trim(),
          duration_seconds: item.duration_seconds ? Number(item.duration_seconds) : null,
          metadata: { import_source: payload.source || "manual", import_platform: payload.platform || "csv" },
          workspace_id: workspaceId,
          project_id: projectId,
          created_at: nowIso()
        };
        await saveAsset(asset);
        imported.push(publicAsset(asset));
      } catch (error) {
        failed.push({ item, error: error.message });
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

async function handleAssets(request, segments, workspaceId, authContext, env, maxInlineFileBytes, headers, cookies) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(200, (await listAssets(workspaceId)).map(publicAsset), headers, cookies);
  }

  if (request.method === "POST" && segments.length === 1) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const limits = await usageLimitsForWorkspace(workspaceId);
    await enforceUsageLimit(request, workspaceId, "asset", limits.asset);
    const { fields, files } = await parseForm(request);
    const assetType = fields.asset_type || fields.assetType;
    if (!assetTypes.has(assetType)) {
      throw httpError(400, "asset_type must be script, landing_page, image, audio, or video.");
    }

    const file = files.find((item) => item.fieldname === "file");
    const assetId = newId("asset");
    const url = fields.url || "";
    const finalName = fields.name || url || file?.filename || "Untitled asset";
    const projectId = await resolveProjectId(fields.project_id || fields.projectId, workspaceId);
    let extractedText = fields.text || "";
    let extractionMetadata = {};

    if (file && assetType === "script" && !extractedText) {
      extractedText = new TextDecoder().decode(file.bytes);
    }

    if (assetType === "landing_page" && url && !extractedText) {
      const extracted = await extractLandingPageText(url);
      extractedText = extracted.text;
      extractionMetadata = extracted.metadata;
    }

    const blobMetadata = file ? await storeUploadedFile(file, workspaceId, assetId, env) : {};
    const shouldInlineFile = file?.bytes?.length && !blobMetadata.blob_url && file.bytes.length <= maxInlineFileBytes;
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
      ...(file?.bytes?.length && !blobMetadata.blob_url && file.bytes.length > maxInlineFileBytes
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
        source_url: url || null,
        extracted_text: "",
        duration_seconds: fields.duration_seconds ? Number(fields.duration_seconds) : null,
        metadata: baseMetadata
      });
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
      source_url: url || null,
      file_path: null,
      extracted_text: extractedText.trim(),
      duration_seconds: fields.duration_seconds ? Number(fields.duration_seconds) : null,
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

  return sendJson(405, { detail: "Method not allowed" }, headers, cookies);
}

async function handleComparisons(request, segments, workspaceId, authContext, headers, cookies) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(200, (await listComparisons(workspaceId)).map(publicComparison), headers, cookies);
  }

  if (request.method === "POST" && segments.length === 1) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const limits = await usageLimitsForWorkspace(workspaceId);
    await enforceUsageLimit(request, workspaceId, "comparison", limits.comparison);
    const payload = await parseJson(request);
    const assetIds = Array.isArray(payload.asset_ids) ? payload.asset_ids : [];
    if (assetIds.length < 2) {
      throw httpError(400, "At least two asset_ids are required.");
    }

    const assets = [];
    for (const assetId of assetIds) {
      const asset = await getAsset(assetId, workspaceId);
      if (!asset) {
        throw httpError(404, `Asset not found: ${assetId}`);
      }
      assets.push(asset);
    }
    const projectId = await resolveComparisonProjectId(payload.project_id || payload.projectId, assets, workspaceId);

    const comparisonId = newId("cmp");
    const createdAt = nowIso();
    const brief = await resolveComparisonBrief(payload, workspaceId);
    const rawComparison = shouldCreateAsyncComparison(payload, assets)
      ? await createAsyncComparison(comparisonId, payload.objective, assets, createdAt, brief)
      : await compareAssets(comparisonId, payload.objective, assets, createdAt, brief);
    rawComparison.workspace_id = workspaceId;
    rawComparison.project_id = projectId;
    if (payload.brand_profile_id || payload.brandProfileId) {
      rawComparison.brand_profile_id = payload.brand_profile_id || payload.brandProfileId;
    }
    const comparison = publicComparison(rawComparison);
    await saveComparison(comparison);
    await audit(workspaceId, authContext.user, "comparison.created", "comparison", comparison.id, {
      status: comparison.status,
      asset_count: comparison.variants.length,
      project_id: comparison.project_id || null
    });
    return sendJson(comparison.status === "processing" ? 202 : 200, comparison, headers, cookies);
  }

  const comparisonId = segments[1];
  if (!comparisonId) {
    return sendJson(404, { detail: "Not found" }, headers, cookies);
  }

  if (request.method === "GET" && segments.length === 2) {
    return sendJson(200, await requireComparison(comparisonId, workspaceId), headers, cookies);
  }

  if (request.method === "POST" && segments[2] === "cancel") {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const cancelled = await cancelComparison(comparisonId, workspaceId);
    await audit(workspaceId, authContext.user, "comparison.cancelled", "comparison", comparisonId, {});
    return sendJson(200, cancelled, headers, cookies);
  }

  if (request.method === "POST" && segments[2] === "challengers") {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
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
      extracted_text: buildChallengerText(sourceVariant.asset, comparison.brief, focus),
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
        spend: Number(payload.spend || 0),
        impressions: Number(payload.impressions || 0),
        clicks: Number(payload.clicks || 0),
        conversions: Number(payload.conversions || 0),
        revenue: Number(payload.revenue || 0),
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

async function handleReports(request, segments, workspaceId, authContext, headers, cookies) {
  if (request.method === "POST" && segments[1] && segments[2] === "share") {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const link = await createShareLink(request, segments[1], workspaceId);
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
  const link = await getShareLink(segments[1]);
  if (!link) {
    throw httpError(404, "Shared report not found");
  }
  return sendJson(200, await buildReport(link.comparison_id, link.workspace_id), headers, cookies);
}

async function createShareLink(request, comparisonId, workspaceId) {
  await requireCompleteComparison(comparisonId, workspaceId);
  const token = randomBase64url(18);
  const ttlDays = Number((globalThis.__stimliEnv && globalThis.__stimliEnv.STIMLI_SHARE_LINK_TTL_DAYS) || 14);
  const link = {
    token,
    workspace_id: workspaceId,
    comparison_id: comparisonId,
    expires_at: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString(),
    created_at: nowIso()
  };
  await saveShareLink(link);
  const origin = requestOriginFromRequest(request);
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
    learning_summary: learning,
    next_steps: [
      "Apply high-severity edits to the current leader.",
      "Create one focused challenger that changes only the hook.",
      "Launch the winner with a clean post-flight label so outcome data can calibrate future scoring."
    ]
  };
}

async function seedDemo(workspaceId, projectId = null) {
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
  const jobs = await Promise.all(assets.map((asset) => startBrainJob(asset)));
  return createPendingComparison(comparisonId, objective, assets, createdAt, brief, jobs);
}

async function refreshComparison(comparison, workspaceId) {
  if (comparison.status !== "processing" || !Array.isArray(comparison.jobs) || !globalThis.__stimliEnv?.TRIBE_CONTROL_URL) {
    return comparison;
  }
  if (comparisonExpired(comparison)) {
    return await cancelComparison(comparison.id, workspaceId, "Analysis timed out before every model job finished.");
  }

  const jobStatuses = await Promise.all(
    comparison.jobs.map(async (job) => {
      try {
        return await getBrainJob(job.job_id);
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
        reasons: jobStatuses.filter((job) => job.error).map((job) => job.error).slice(0, 3)
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
  const comparison = await getComparison(comparisonId, workspaceId);
  if (!comparison) {
    throw httpError(404, "Comparison not found");
  }
  const jobs = Array.isArray(comparison.jobs) ? comparison.jobs : [];
  const updatedJobs = await Promise.all(
    jobs.map(async (job) => {
      if (!globalThis.__stimliEnv?.TRIBE_CONTROL_URL || ["complete", "failed", "cancelled"].includes(job.status)) {
        return job;
      }
      try {
        return publicJobStatus(await cancelBrainJob(job.job_id));
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
    error: job.error || job.polling_error || null,
    attempt: Number.isFinite(Number(job.attempt)) ? Number(job.attempt) : null,
    created_at: job.created_at || null,
    updated_at: job.updated_at || nowIso()
  };
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

function calibrationSummary(outcomes, comparisons) {
  const outcomesByComparison = new Map();
  for (const outcome of outcomes) {
    if (!outcomesByComparison.has(outcome.comparison_id)) {
      outcomesByComparison.set(outcome.comparison_id, []);
    }
    outcomesByComparison.get(outcome.comparison_id).push(outcome);
  }

  const evaluations = comparisons
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

  const aligned = evaluations.filter((evaluation) => evaluation.aligned).length;
  return {
    evaluated_comparisons: evaluations.length,
    aligned_predictions: aligned,
    alignment_rate: evaluations.length ? round(aligned / evaluations.length, 3) : 0,
    recent: evaluations.slice(-5)
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

async function extractLandingPageText(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Stimli creative analyzer" },
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) {
      return {
        text: `Landing page at ${url}. Add page copy or upload a screenshot transcript for deeper scoring.`,
        metadata: { extraction_status: "blocked", status_code: response.status }
      };
    }
    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);
    return {
      text: text || `Landing page at ${url}. Add page copy for deeper scoring.`,
      metadata: { extraction_status: text ? "success" : "empty" }
    };
  } catch (error) {
    return {
      text: `Landing page at ${url}. Add page copy or upload a screenshot transcript for deeper scoring.`,
      metadata: { extraction_status: "error", extraction_error: error.message }
    };
  }
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
      return `| ${variant.rank} | ${variant.asset.name} | ${scores.overall} | ${scores.hook} | ${scores.cta} | ${scores.offer_strength} | ${scores.audience_fit} |`;
    }),
    "",
    "## Edit Cards",
    ""
  ];
  for (const suggestion of report.suggestions) {
    lines.push(
      `### ${suggestion.target}`,
      "",
      `Severity: ${suggestion.severity}`,
      "",
      `Issue: ${suggestion.issue}`,
      "",
      `Edit: ${suggestion.suggested_edit}`,
      "",
      `Draft: ${suggestion.draft_revision || "No draft available."}`,
      ""
    );
  }
  lines.push("## Next Steps", "", ...report.next_steps.map((step) => `- ${step}`), "");
  return lines.join("\n");
}

async function parseJson(request) {
  try {
    const body = await request.text();
    if (!body) return {};
    return JSON.parse(body);
  } catch (err) {
    throw httpError(400, "Invalid JSON payload.");
  }
}

async function parseForm(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    const payload = await parseJson(request);
    return { fields: payload, files: [] };
  }

  const fields = {};
  const files = [];
  const form = await request.formData();
  for (const [name, value] of form.entries()) {
    if (value instanceof File) {
      const bytes = new Uint8Array(await value.arrayBuffer());
      files.push({
        fieldname: name,
        filename: value.name,
        mimeType: value.type || "application/octet-stream",
        bytes
      });
    } else {
      fields[name] = value;
    }
  }
  return { fields, files };
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
  headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Stimli-Workspace";
  headers["Cache-Control"] = "no-store";
  return headers;
}

function allowedCorsOrigin(request, env) {
  const origin = request.headers.get("origin") || "";
  if (!origin) return "*";
  const configured = [
    env.STIMLI_APP_URL,
    env.STIMLI_ORIGIN,
    "https://stimli.pages.dev",
    "https://stimli.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
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
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
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

async function enforceUsageLimit(request, workspaceId, kind, limit) {
  const env = globalThis.__stimliEnv || {};
  if (env.STIMLI_DISABLE_RATE_LIMITS === "1" || !Number.isFinite(limit) || limit <= 0) return;
  const windowMs = Number(env.STIMLI_RATE_LIMIT_WINDOW_MS || 60 * 60 * 1000);
  const since = new Date(Date.now() - windowMs).toISOString();
  const bucketKey = await clientBucketKey(request, workspaceId);
  const [workspaceCount, clientCount] = await Promise.all([
    countUsageEvents({ kind, since, workspaceId }),
    countUsageEvents({ kind, since, bucketKey })
  ]);
  if (Math.max(workspaceCount, clientCount) >= limit) {
    throw httpError(429, "Usage limit reached. Try again later.");
  }
  await saveUsageEvent({
    id: newId("usage"),
    workspace_id: workspaceId,
    bucket_key: bucketKey,
    kind,
    payload: { limit, window_ms: windowMs },
    created_at: nowIso()
  });
}

async function clientBucketKey(request, workspaceId) {
  const forwardedFor = (request.headers.get("x-forwarded-for") || "").split(",")[0]?.trim();
  const realIp = (request.headers.get("x-real-ip") || "").trim();
  const userAgent = (request.headers.get("user-agent") || "").slice(0, 180);
  const source = forwardedFor || realIp ? `${forwardedFor || realIp}|${userAgent}` : `workspace:${workspaceId}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return `client_${bytesToHex(new Uint8Array(buf)).slice(0, 32)}`;
}

function requirePermission(authContext, permission, options = {}) {
  if (options.allowAnonymous && !authContext.authenticated) return;
  if (!authContext.authenticated) throw httpError(401, "Sign in before using this workspace control.");
  if (!authContext.permissions?.includes(permission)) throw httpError(403, "Your role does not allow this action.");
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
  const started = publicJobStatus(await startBrainJob(asset));
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
  const calibration = calibrationSummary(outcomes, comparisons);
  const bins = [
    { label: "50-65%", min: 0.5, max: 0.65, predictions: 0, aligned: 0 },
    { label: "65-80%", min: 0.65, max: 0.8, predictions: 0, aligned: 0 },
    { label: "80-95%", min: 0.8, max: 0.95, predictions: 0, aligned: 0 }
  ];
  for (const evaluation of calibration.recent) {
    const comparison = comparisons.find((item) => item.id === evaluation.comparison_id);
    const confidence = comparison?.recommendation?.confidence || 0;
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
  if (!email) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "Invite email is invalid.");
  return email;
}

function getHeader(request, name) {
  return request.headers.get(name) || "";
}

function requestOrigin(request, env) {
  if (env?.STIMLI_APP_URL) return String(env.STIMLI_APP_URL).replace(/\/$/, "");
  return requestOriginFromRequest(request);
}

function requestOriginFromRequest(request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "stimli.pages.dev";
  const protocol = request.headers.get("x-forwarded-proto") || (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${protocol}://${host.split(",")[0].trim()}`;
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

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
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
