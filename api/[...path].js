import Busboy from "busboy";
import crypto from "node:crypto";
import { put } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";

import {
  buildChallengerText,
  cancelBrainJob,
  compareAssets,
  compareAssetsWithBrain,
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
  getAuthContext,
  logout,
  registrationOptions,
  switchTeam,
  verifyAuthentication,
  verifyRegistration
} from "./_lib/auth.js";
import {
  billingStatus,
  createCheckoutSession,
  createPortalSession,
  handleBillingWebhook,
  usageLimitsForWorkspace
} from "./_lib/billing.js";
import {
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
const maxInlineFileBytes = Number(process.env.STIMLI_MAX_INLINE_FILE_BYTES || 8 * 1024 * 1024);

export default async function handler(request, response) {
  setBaseHeaders(request, response);
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  try {
    const { pathname } = new URL(request.url || "/", "http://stimli.local");
    const apiPath = pathname.replace(/^\/api/, "") || "/";
    const segments = apiPath.split("/").filter(Boolean);

    if (request.method === "GET" && apiPath === "/health") {
      return sendJson(response, 200, { status: "ok", storage: storageHealth() });
    }

    if (request.method === "GET" && apiPath === "/brain/providers") {
      return sendJson(response, 200, await providerHealth());
    }

    const authContext = await getAuthContext(request);
    const workspaceId = authContext.workspace_id || workspaceForRequest(request);

    if (segments[0] === "auth") {
      return await handleAuth(request, response, segments);
    }

    if (segments[0] === "billing") {
      return await handleBilling(request, response, segments, authContext, workspaceId);
    }

    if (segments[0] === "teams") {
      return await handleTeams(request, response, segments, authContext);
    }

    if (segments[0] === "invites") {
      return await handleInvites(request, response, segments, authContext);
    }

    if (segments[0] === "share") {
      return await handleSharedReport(request, response, segments);
    }

    if (segments[0] === "blob" && segments[1] === "upload") {
      return await handleBlobUpload(request, response, authContext);
    }

    if (segments[0] === "admin") {
      return await handleAdmin(request, response, segments, authContext, workspaceId);
    }

    if (segments[0] === "audit") {
      return await handleAudit(request, response, segments, authContext, workspaceId);
    }

    if (segments[0] === "governance") {
      return await handleGovernance(request, response, segments, authContext, workspaceId);
    }

    if (segments[0] === "brand-profiles") {
      return await handleBrandProfiles(request, response, segments, authContext, workspaceId);
    }

    if (segments[0] === "library") {
      return await handleLibrary(request, response, segments, authContext, workspaceId);
    }

    if (segments[0] === "imports") {
      return await handleImports(request, response, segments, authContext, workspaceId);
    }

    if (segments[0] === "validation") {
      return await handleValidation(request, response, segments, authContext, workspaceId);
    }

    if (request.method === "POST" && apiPath === "/demo/seed") {
      const payload = await parseJson(request);
      const projectId = await resolveProjectId(payload.project_id, workspaceId);
      return sendJson(response, 200, await seedDemo(workspaceId, projectId));
    }

    if (segments[0] === "projects") {
      return await handleProjects(request, response, segments, workspaceId, authContext);
    }

    if (segments[0] === "assets") {
      return await handleAssets(request, response, segments, workspaceId, authContext);
    }

    if (segments[0] === "comparisons") {
      return await handleComparisons(request, response, segments, workspaceId, authContext);
    }

    if (segments[0] === "reports") {
      return await handleReports(request, response, segments, workspaceId, authContext);
    }

    if (request.method === "GET" && apiPath === "/learning/summary") {
      const [outcomes, comparisons] = await Promise.all([listOutcomes(null, workspaceId), listComparisons(workspaceId)]);
      return sendJson(response, 200, learningSummary(outcomes, comparisons));
    }

    return sendJson(response, 404, { detail: "Not found" });
  } catch (error) {
    const status = Number(error.statusCode || error.status || 500);
    const message = status >= 500 ? "Request failed" : error.message;
    if (status >= 500) {
      console.error(error);
    }
    return sendJson(response, status, { detail: message });
  }
}

async function handleProjects(request, response, segments, workspaceId, authContext) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(response, 200, await listProjects(workspaceId));
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
    return sendJson(response, 200, project);
  }

  return sendJson(response, 405, { detail: "Method not allowed" });
}

async function handleAuth(request, response, segments) {
  const payload = request.method === "POST" ? await parseJson(request) : {};

  if (request.method === "GET" && segments[1] === "session") {
    return sendJson(response, 200, await authSessionPayload(request));
  }
  if (request.method === "POST" && segments[1] === "register" && segments[2] === "options") {
    return sendJson(response, 200, await registrationOptions(request, payload));
  }
  if (request.method === "POST" && segments[1] === "register" && segments[2] === "verify") {
    return sendJson(response, 200, await verifyRegistration(request, response, payload));
  }
  if (request.method === "POST" && segments[1] === "login" && segments[2] === "options") {
    return sendJson(response, 200, await authenticationOptions(request, payload));
  }
  if (request.method === "POST" && segments[1] === "login" && segments[2] === "verify") {
    return sendJson(response, 200, await verifyAuthentication(request, response, payload));
  }
  if (request.method === "POST" && segments[1] === "logout") {
    return sendJson(response, 200, await logout(request, response));
  }
  if (request.method === "POST" && segments[1] === "team") {
    return sendJson(response, 200, await switchTeam(request, response, payload));
  }
  return sendJson(response, 404, { detail: "Not found" });
}

async function handleTeams(request, response, segments, authContext) {
  if (!authContext.authenticated) {
    throw httpError(401, "Sign in before managing teams.");
  }
  if (segments[1] === "invites") {
    requirePermission(authContext, "members:manage");
    if (request.method === "GET") {
      const invites = await listTeamInvites(authContext.team.id);
      return sendJson(response, 200, invites.map((invite) => publicInvite(invite, authContext.team)));
    }
    if (request.method === "POST") {
      const payload = await parseJson(request);
      const token = crypto.randomBytes(24).toString("base64url");
      const invite = {
        id: newId("invite"),
        token_hash: hashToken(token),
        team_id: authContext.team.id,
        team_name: authContext.team.name,
        email: normalizeInviteEmail(payload.email),
        role: normalizeRole(payload.role || "analyst"),
        created_by: authContext.user.id,
        expires_at: new Date(Date.now() + Number(process.env.STIMLI_INVITE_TTL_DAYS || 14) * 24 * 60 * 60 * 1000).toISOString(),
        created_at: nowIso()
      };
      await saveTeamInvite(invite);
      await audit(authContext.team.id, authContext.user, "invite.created", "invite", invite.id, {
        email: invite.email,
        role: invite.role
      });
      const origin = requestOrigin(request);
      return sendJson(response, 200, {
        ...publicInvite(invite, authContext.team),
        url: `${origin}/invite/${token}`,
        token
      });
    }
  }
  if (segments[1] === "members") {
    requirePermission(authContext, "members:manage");
    if (request.method === "GET" && segments.length === 2) {
      const members = await listTeamMembers(authContext.team.id);
      return sendJson(response, 200, members.map(publicMember));
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
      return sendJson(response, 200, publicMember(updated));
    }
  }
  return sendJson(response, 404, { detail: "Not found" });
}

async function handleInvites(request, response, segments, authContext) {
  const token = segments[1] || "";
  const invite = token ? await getTeamInviteByTokenHash(hashToken(token)) : null;
  if (!invite) {
    throw httpError(404, "Invite not found or expired.");
  }
  const team = { id: invite.team_id, name: invite.team_name || "Team" };
  if (request.method === "GET") {
    return sendJson(response, 200, publicInvite(invite, team));
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
    return sendJson(response, 200, await switchTeam(request, response, { team_id: invite.team_id }));
  }
  return sendJson(response, 405, { detail: "Method not allowed" });
}

async function handleBilling(request, response, segments, authContext) {
  if (request.method === "GET" && segments[1] === "status") {
    return sendJson(response, 200, await billingStatus(authContext.team));
  }
  if (request.method === "POST" && segments[1] === "checkout") {
    requirePermission(authContext, "billing:manage");
    const payload = await parseJson(request);
    return sendJson(response, 200, await createCheckoutSession(request, authContext.team, payload.plan));
  }
  if (request.method === "POST" && segments[1] === "portal") {
    requirePermission(authContext, "billing:manage");
    return sendJson(response, 200, await createPortalSession(request, authContext.team));
  }
  if (request.method === "POST" && segments[1] === "webhook") {
    const raw = await readRaw(request);
    return sendJson(response, 200, await handleBillingWebhook(getHeader(request, "stripe-signature"), raw));
  }
  return sendJson(response, 404, { detail: "Not found" });
}

async function handleAdmin(request, response, segments, authContext, workspaceId) {
  requirePermission(authContext, "jobs:manage");
  if (request.method === "GET" && segments[1] === "summary") {
    const [comparisons, providers, auditEvents] = await Promise.all([
      listComparisons(workspaceId),
      providerHealth(),
      listAuditEvents(workspaceId, 20)
    ]);
    const jobs = comparisonJobs(comparisons);
    return sendJson(response, 200, {
      jobs: jobSummary(jobs),
      providers,
      recent_events: auditEvents,
      storage: storageHealth(),
      inference: {
        remote_configured: Boolean(process.env.TRIBE_INFERENCE_URL || process.env.TRIBE_CONTROL_URL),
        control_configured: Boolean(process.env.TRIBE_CONTROL_URL),
        extractor_configured: Boolean(process.env.STIMLI_EXTRACT_URL),
        strict_remote: process.env.STIMLI_BRAIN_PROVIDER === "tribe-remote"
      }
    });
  }
  if (request.method === "GET" && segments[1] === "jobs") {
    const status = new URL(request.url || "/", "http://stimli.local").searchParams.get("status");
    const jobs = comparisonJobs(await listComparisons(workspaceId));
    const filtered = status ? jobs.filter((job) => job.status === status) : jobs;
    return sendJson(response, 200, filtered.slice(0, 200));
  }
  if (request.method === "POST" && segments[1] === "jobs" && segments[2] && segments[3] === "retry") {
    const retried = await retryComparisonJob(segments[2], workspaceId, authContext.user);
    return sendJson(response, 200, retried);
  }
  return sendJson(response, 404, { detail: "Not found" });
}

async function handleAudit(request, response, segments, authContext, workspaceId) {
  requirePermission(authContext, "audit:read");
  if (request.method === "GET" && segments[1] === "events") {
    const limit = Number(new URL(request.url || "/", "http://stimli.local").searchParams.get("limit") || 100);
    return sendJson(response, 200, await listAuditEvents(workspaceId, limit));
  }
  return sendJson(response, 404, { detail: "Not found" });
}

async function handleGovernance(request, response, segments, authContext, workspaceId) {
  requirePermission(authContext, "governance:manage");
  if (request.method === "GET" && segments[1] === "export") {
    return sendJson(response, 200, await workspaceExport(workspaceId, authContext));
  }
  if (request.method === "GET" && segments[1] === "requests") {
    return sendJson(response, 200, await listGovernanceRequests(workspaceId));
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
    return sendJson(response, 200, requestRecord);
  }
  if (request.method === "GET" && segments[1] === "policy") {
    return sendJson(response, 200, governancePolicy());
  }
  return sendJson(response, 404, { detail: "Not found" });
}

async function handleBrandProfiles(request, response, segments, authContext, workspaceId) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(response, 200, await listBrandProfiles(workspaceId));
  }
  if (request.method === "POST" && segments.length === 1) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const payload = await parseJson(request);
    const profile = normalizeBrandProfile(payload, workspaceId);
    await saveBrandProfile(profile);
    await audit(workspaceId, authContext.user, "brand_profile.created", "brand_profile", profile.id, { name: profile.name });
    return sendJson(response, 200, profile);
  }
  const profileId = segments[1];
  if (!profileId) {
    return sendJson(response, 404, { detail: "Not found" });
  }
  const existing = await getBrandProfile(profileId, workspaceId);
  if (!existing) {
    throw httpError(404, "Brand profile not found.");
  }
  if (request.method === "GET" && segments.length === 2) {
    return sendJson(response, 200, existing);
  }
  if (request.method === "PATCH" && segments.length === 2) {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const payload = await parseJson(request);
    const updated = normalizeBrandProfile({ ...existing, ...payload, id: existing.id, created_at: existing.created_at }, workspaceId);
    updated.updated_at = nowIso();
    await saveBrandProfile(updated);
    await audit(workspaceId, authContext.user, "brand_profile.updated", "brand_profile", updated.id, { name: updated.name });
    return sendJson(response, 200, updated);
  }
  if (request.method === "GET" && segments[2] === "export") {
    return sendJson(response, 200, {
      schema: "stimli.brand_profile.v1",
      exported_at: nowIso(),
      profile: existing
    });
  }
  return sendJson(response, 405, { detail: "Method not allowed" });
}

async function handleLibrary(request, response, segments, authContext, workspaceId) {
  requirePermission(authContext, "workspace:read", { allowAnonymous: true });
  if (request.method === "GET" && segments[1] === "assets") {
    const url = new URL(request.url || "/", "http://stimli.local");
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
          has_private_blob: Boolean(asset.metadata?.blob_pathname),
          source: asset.source_url ? "url" : asset.metadata?.original_filename ? "file" : "text"
        }
      }));
    return sendJson(response, 200, { assets, total: assets.length });
  }
  return sendJson(response, 404, { detail: "Not found" });
}

async function handleImports(request, response, segments, authContext, workspaceId) {
  if (request.method === "GET" && segments.length === 1) {
    requirePermission(authContext, "workspace:read", { allowAnonymous: true });
    return sendJson(response, 200, await listIntegrationJobs(workspaceId));
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
    return sendJson(response, 200, { job, assets: imported });
  }
  return sendJson(response, 404, { detail: "Not found" });
}

async function handleValidation(request, response, segments, authContext, workspaceId) {
  requirePermission(authContext, "validation:manage", { allowAnonymous: true });
  if (request.method === "GET" && segments[1] === "calibration") {
    const [outcomes, comparisons, runs] = await Promise.all([
      listOutcomes(null, workspaceId),
      listComparisons(workspaceId),
      listBenchmarkRuns(workspaceId)
    ]);
    return sendJson(response, 200, {
      learning: learningSummary(outcomes, comparisons),
      confidence_bins: confidenceBins(outcomes, comparisons),
      benchmark_runs: runs.slice(0, 20)
    });
  }
  if (request.method === "GET" && segments[1] === "benchmarks") {
    return sendJson(response, 200, benchmarkCatalog());
  }
  if (request.method === "POST" && segments[1] === "benchmarks" && segments[2] === "run") {
    const payload = await parseJson(request);
    const run = await runBenchmark(payload.benchmark_id || "dtc-hooks-v1", workspaceId);
    await saveBenchmarkRun(run);
    await audit(workspaceId, authContext.user, "validation.benchmark_run", "benchmark", run.id, {
      benchmark_id: run.benchmark_id,
      accuracy: run.accuracy
    });
    return sendJson(response, 200, run);
  }
  return sendJson(response, 404, { detail: "Not found" });
}

async function handleAssets(request, response, segments, workspaceId, authContext) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(response, 200, (await listAssets(workspaceId)).map(publicAsset));
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
      extractedText = file.buffer.toString("utf8");
    }

    if (assetType === "landing_page" && url && !extractedText) {
      const extracted = await extractLandingPageText(url);
      extractedText = extracted.text;
      extractionMetadata = extracted.metadata;
    }

    const registeredBlob = normalizeRegisteredBlob(fields.blob || fields.blob_metadata, workspaceId);
    const blobMetadata = file ? await storeUploadedFile(file, workspaceId, assetId) : registeredBlob;
    const shouldInlineFile = file?.buffer?.length && !blobMetadata.blob_url && file.buffer.length <= maxInlineFileBytes;
    const baseMetadata = {
      original_filename: file?.filename || blobMetadata.original_filename || null,
      file_size: file?.buffer?.length || blobMetadata.blob_size || blobMetadata.file_size || null,
      content_type: file?.mimeType || blobMetadata.blob_content_type || blobMetadata.content_type || null,
      ...(shouldInlineFile
        ? {
            file_base64: file.buffer.toString("base64"),
            file_encoding: "base64"
          }
        : {}),
      ...(file?.buffer?.length && !blobMetadata.blob_url && file.buffer.length > maxInlineFileBytes
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
    return sendJson(response, 200, { asset: publicAsset(asset) });
  }

  return sendJson(response, 405, { detail: "Method not allowed" });
}

async function handleBlobUpload(request, response, authContext) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { detail: "Method not allowed" });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw httpError(503, "Blob storage is not configured.");
  }
  const body = await parseJson(request);
  const result = await handleUpload({
    body,
    request,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      const workspaceId = workspaceFromClientPayload(clientPayload);
      if (authContext.authenticated && workspaceId !== authContext.workspace_id) {
        throw httpError(400, "Upload path does not belong to this team.");
      }
      const prefix = `workspaces/${workspaceId}/uploads/`;
      if (!String(pathname).startsWith(prefix)) {
        throw httpError(400, "Upload path does not belong to this workspace.");
      }
      return {
        addRandomSuffix: true,
        allowedContentTypes: ["text/*", "image/*", "audio/*", "video/*", "application/pdf", "application/octet-stream"],
        maximumSizeInBytes: Number(process.env.STIMLI_MAX_DIRECT_UPLOAD_BYTES || 25 * 1024 * 1024),
        tokenPayload: JSON.stringify({ workspace_id: workspaceId })
      };
    },
    onUploadCompleted: async () => undefined
  });
  return sendJson(response, 200, result);
}

async function handleComparisons(request, response, segments, workspaceId, authContext) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(response, 200, (await listComparisons(workspaceId)).map(publicComparison));
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
    return sendJson(response, comparison.status === "processing" ? 202 : 200, comparison);
  }

  const comparisonId = segments[1];
  if (!comparisonId) {
    return sendJson(response, 404, { detail: "Not found" });
  }

  if (request.method === "GET" && segments.length === 2) {
    return sendJson(response, 200, await requireComparison(comparisonId, workspaceId));
  }

  if (request.method === "POST" && segments[2] === "cancel") {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const cancelled = await cancelComparison(comparisonId, workspaceId);
    await audit(workspaceId, authContext.user, "comparison.cancelled", "comparison", comparisonId, {});
    return sendJson(response, 200, cancelled);
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
    return sendJson(response, 200, { asset: publicAsset(asset), source_asset_id: sourceVariant.asset.id, focus });
  }

  if (segments[2] === "outcomes") {
    if (request.method === "GET") {
      await requireComparison(comparisonId, workspaceId);
      return sendJson(response, 200, await listOutcomes(comparisonId, workspaceId));
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
      return sendJson(response, 200, outcome);
    }
  }

  return sendJson(response, 405, { detail: "Method not allowed" });
}

async function handleReports(request, response, segments, workspaceId, authContext) {
  if (request.method === "POST" && segments[1] && segments[2] === "share") {
    requirePermission(authContext, "workspace:write", { allowAnonymous: true });
    const link = await createShareLink(request, segments[1], workspaceId);
    await audit(workspaceId, authContext.user, "report.shared", "comparison", segments[1], {
      expires_at: link.expires_at
    });
    return sendJson(response, 200, link);
  }

  if (request.method !== "GET" || !segments[1]) {
    return sendJson(response, 405, { detail: "Method not allowed" });
  }
  const report = await buildReport(segments[1], workspaceId);
  if (segments[2] === "markdown") {
    return sendText(response, 200, reportToMarkdown(report), "text/markdown; charset=utf-8");
  }
  return sendJson(response, 200, report);
}

async function handleSharedReport(request, response, segments) {
  if (request.method !== "GET" || !segments[1]) {
    return sendJson(response, 405, { detail: "Method not allowed" });
  }
  const link = await getShareLink(segments[1]);
  if (!link) {
    throw httpError(404, "Shared report not found");
  }
  return sendJson(response, 200, await buildReport(link.comparison_id, link.workspace_id));
}

async function createShareLink(request, comparisonId, workspaceId) {
  await requireCompleteComparison(comparisonId, workspaceId);
  const token = crypto.randomBytes(18).toString("base64url");
  const link = {
    token,
    workspace_id: workspaceId,
    comparison_id: comparisonId,
    expires_at: new Date(Date.now() + Number(process.env.STIMLI_SHARE_LINK_TTL_DAYS || 14) * 24 * 60 * 60 * 1000).toISOString(),
    created_at: nowIso()
  };
  await saveShareLink(link);
  const origin = requestOrigin(request);
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
  if (comparison.status !== "processing" || !Array.isArray(comparison.jobs) || !process.env.TRIBE_CONTROL_URL) {
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
      if (!process.env.TRIBE_CONTROL_URL || ["complete", "failed", "cancelled"].includes(job.status)) {
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
  const maxAgeMs = Number(process.env.STIMLI_COMPARISON_JOB_TIMEOUT_MS || 20 * 60 * 1000);
  const created = Date.parse(comparison.created_at || "");
  return Number.isFinite(created) && Date.now() - created > maxAgeMs;
}

function publicAsset(asset) {
  const metadata = { ...(asset.metadata || {}) };
  delete metadata.file_base64;
  delete metadata.file_encoding;
  delete metadata.blob_url;
  delete metadata.blob_download_url;
  return { ...asset, metadata };
}

function normalizeRegisteredBlob(blob, workspaceId) {
  if (!blob || typeof blob !== "object") {
    return {};
  }
  const pathname = String(blob.pathname || "");
  if (!pathname.startsWith(`workspaces/${workspaceId}/`)) {
    throw httpError(400, "Blob asset does not belong to this workspace.");
  }
  return {
    blob_access: "private",
    blob_url: String(blob.url || ""),
    blob_download_url: String(blob.downloadUrl || blob.download_url || ""),
    blob_pathname: pathname,
    blob_content_type: String(blob.contentType || blob.content_type || blob.contentType || "application/octet-stream"),
    blob_size: Number(blob.size || blob.file_size || 0) || null,
    blob_etag: blob.etag ? String(blob.etag) : null,
    original_filename: blob.original_filename ? String(blob.original_filename) : null
  };
}

async function storeUploadedFile(file, workspaceId, assetId) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return {};
  }
  const safeName = safeBlobName(file.filename || `${assetId}.bin`);
  const pathname = `workspaces/${workspaceId}/assets/${assetId}/${safeName}`;
  const blob = await put(pathname, file.buffer, {
    access: "private",
    addRandomSuffix: true,
    contentType: file.mimeType || "application/octet-stream",
    token: process.env.BLOB_READ_WRITE_TOKEN
  });
  return {
    blob_access: "private",
    blob_url: blob.url,
    blob_download_url: blob.downloadUrl,
    blob_pathname: blob.pathname,
    blob_content_type: blob.contentType || file.mimeType || null,
    blob_size: file.buffer.length,
    blob_etag: blob.etag || null
  };
}

function safeBlobName(name) {
  const basename = String(name).split(/[\\/]/).pop() || "upload.bin";
  const safe = basename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "upload.bin";
}

function workspaceFromClientPayload(clientPayload) {
  let payload = {};
  try {
    payload = clientPayload ? JSON.parse(clientPayload) : {};
  } catch {
    throw httpError(400, "Invalid upload payload.");
  }
  const workspaceId = String(payload.workspace_id || "").trim();
  if (!/^[A-Za-z0-9_-]{3,96}$/.test(workspaceId)) {
    throw httpError(400, "Invalid workspace id.");
  }
  return workspaceId;
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
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  const raw = await readRaw(request);
  if (!raw.length) {
    return {};
  }
  return JSON.parse(raw.toString("utf8"));
}

async function parseForm(request) {
  const contentType = request.headers["content-type"] || request.headers["Content-Type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    const payload = await parseJson(request);
    return { fields: payload, files: [] };
  }

  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const parser = Busboy({ headers: request.headers, limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

    parser.on("field", (name, value) => {
      fields[name] = value;
    });
    parser.on("file", (fieldname, file, info) => {
      const chunks = [];
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("limit", () => reject(httpError(413, "Uploaded file is too large.")));
      file.on("end", () => {
        files.push({
          fieldname,
          filename: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks)
        });
      });
    });
    parser.on("error", reject);
    parser.on("close", () => resolve({ fields, files }));
    request.pipe(parser);
  });
}

function readRaw(request) {
  if (Buffer.isBuffer(request.body)) {
    return Promise.resolve(request.body);
  }
  if (typeof request.body === "string") {
    return Promise.resolve(Buffer.from(request.body));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function textFromFilename(name) {
  return `Creative asset named ${String(name).replace(/\.[^.]+$/, "").replace(/[-_]/g, " ")}. Add transcript or visual notes for deeper scoring.`;
}

function setBaseHeaders(request, response) {
  const allowedOrigin = allowedCorsOrigin(request);
  if (allowedOrigin) {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader("Vary", "Origin");
    if (allowedOrigin !== "*") {
      response.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Stimli-Workspace");
  response.setHeader("Cache-Control", "no-store");
}

function allowedCorsOrigin(request) {
  const origin = getHeader(request, "origin");
  if (!origin) {
    return "*";
  }
  const configured = [
    process.env.STIMLI_APP_URL,
    process.env.STIMLI_ORIGIN,
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "",
    "https://stimli.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ];
  const extra = String(process.env.STIMLI_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if ([...configured, ...extra].filter(Boolean).includes(origin)) {
    return origin;
  }
  try {
    const parsed = new URL(origin);
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (isLocal && ["3000", "5173", "8000"].includes(parsed.port)) {
      return origin;
    }
  } catch {
    return "";
  }
  return "";
}

function workspaceForRequest(request) {
  const raw = getHeader(request, "x-stimli-workspace");
  if (!raw) {
    return "public";
  }
  const workspaceId = String(raw).trim();
  if (!/^[A-Za-z0-9_-]{3,96}$/.test(workspaceId)) {
    throw httpError(400, "Invalid workspace id.");
  }
  return workspaceId;
}

async function resolveProjectId(rawProjectId, workspaceId) {
  const projectId = String(rawProjectId || "").trim();
  if (!projectId || projectId === "all") {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{3,96}$/.test(projectId)) {
    throw httpError(400, "Invalid project id.");
  }
  const project = await getProject(projectId, workspaceId);
  if (!project) {
    throw httpError(404, "Project not found.");
  }
  return project.id;
}

async function resolveComparisonProjectId(rawProjectId, assets, workspaceId) {
  const explicitProjectId = await resolveProjectId(rawProjectId, workspaceId);
  if (explicitProjectId) {
    return explicitProjectId;
  }
  const assetProjectIds = [...new Set(assets.map((asset) => asset.project_id).filter(Boolean))];
  return assetProjectIds.length === 1 ? assetProjectIds[0] : null;
}

async function resolveComparisonBrief(payload, workspaceId) {
  const profileId = payload.brand_profile_id || payload.brandProfileId || "";
  const explicitBrief = payload.brief || {};
  if (!profileId) {
    return explicitBrief;
  }
  const profile = await getBrandProfile(profileId, workspaceId);
  if (!profile) {
    throw httpError(404, "Brand profile not found.");
  }
  return {
    ...(profile.brief || {}),
    ...explicitBrief,
    required_claims: mergeLists(profile.brief?.required_claims, explicitBrief.required_claims),
    forbidden_terms: mergeLists(profile.brief?.forbidden_terms, explicitBrief.forbidden_terms),
    voice_rules: mergeLists(profile.voice_rules, explicitBrief.voice_rules)
  };
}

async function enforceUsageLimit(request, workspaceId, kind, limit) {
  if (process.env.STIMLI_DISABLE_RATE_LIMITS === "1" || !Number.isFinite(limit) || limit <= 0) {
    return;
  }
  const windowMs = Number(process.env.STIMLI_RATE_LIMIT_WINDOW_MS || 60 * 60 * 1000);
  const since = new Date(Date.now() - windowMs).toISOString();
  const bucketKey = clientBucketKey(request, workspaceId);
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
    payload: {
      limit,
      window_ms: windowMs
    },
    created_at: nowIso()
  });
}

function clientBucketKey(request, workspaceId) {
  const forwardedFor = getHeader(request, "x-forwarded-for").split(",")[0]?.trim();
  const realIp = getHeader(request, "x-real-ip").trim();
  const userAgent = getHeader(request, "user-agent").slice(0, 180);
  const source = forwardedFor || realIp ? `${forwardedFor || realIp}|${userAgent}` : `workspace:${workspaceId}`;
  return `client_${crypto.createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}

function requirePermission(authContext, permission, options = {}) {
  if (options.allowAnonymous && !authContext.authenticated) {
    return;
  }
  if (!authContext.authenticated) {
    throw httpError(401, "Sign in before using this workspace control.");
  }
  if (!authContext.permissions?.includes(permission)) {
    throw httpError(403, "Your role does not allow this action.");
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
  if (role === "member") {
    role = "analyst";
  }
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
  const counts = {
    total: jobs.length,
    queued: 0,
    processing: 0,
    running: 0,
    retrying: 0,
    complete: 0,
    failed: 0,
    cancelled: 0
  };
  for (const job of jobs) {
    const status = job.status || "processing";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

async function retryComparisonJob(jobId, workspaceId, actor) {
  if (!process.env.TRIBE_CONTROL_URL) {
    throw httpError(503, "Hosted job control is not configured.");
  }
  const comparisons = await listComparisons(workspaceId);
  const comparison = comparisons.find((item) => (item.jobs || []).some((job) => job.job_id === jobId));
  if (!comparison) {
    throw httpError(404, "Job not found.");
  }
  const job = comparison.jobs.find((item) => item.job_id === jobId);
  if (!["failed", "cancelled"].includes(job.status)) {
    throw httpError(409, "Only failed or cancelled jobs can be retried.");
  }
  const maxRetries = Number(process.env.STIMLI_MODAL_JOB_RETRIES || 2);
  const attempt = Number(job.attempt || 0) + 1;
  if (attempt > maxRetries) {
    throw httpError(409, "Retry limit reached for this job.");
  }
  const asset = await getAsset(job.asset_id, workspaceId);
  if (!asset) {
    throw httpError(404, "Job asset was deleted or is unavailable.");
  }
  const started = publicJobStatus(await startBrainJob(asset));
  const retryJob = {
    ...started,
    attempt,
    previous_job_id: job.job_id,
    status: started.status || "queued",
    updated_at: nowIso()
  };
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
  return {
    private_uploads: true,
    public_share_links: true,
    share_link_ttl_days: Number(process.env.STIMLI_SHARE_LINK_TTL_DAYS || 14),
    deletion_workflow: "request_review",
    export_scope: "workspace",
    retention_days: Number(process.env.STIMLI_RETENTION_DAYS || 365),
    commercial_license_mode: process.env.STIMLI_TRIBE_COMMERCIAL_LICENSE === "1" ? "commercial-ready" : "research-only"
  };
}

function normalizeTargetType(value) {
  const type = String(value || "asset").trim().toLowerCase();
  return ["asset", "comparison", "project", "workspace", "user"].includes(type) ? type : "asset";
}

function normalizeBrandProfile(payload, workspaceId) {
  const name = String(payload.name || payload.brief?.brand_name || "").trim();
  if (name.length < 2) {
    throw httpError(400, "Brand profile name is required.");
  }
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
        {
          label: "A",
          text: "Stop wasting budget on ads people skip after three seconds. Try the starter kit with free shipping today."
        },
        {
          label: "B",
          text: "Our brand is an innovative ecosystem for modern people who want quality and convenience."
        }
      ]
    },
    {
      expected: "A",
      assets: [
        {
          label: "A",
          text: "Dry skin by lunch? This 24 hour hydration kit locks moisture in before your morning commute."
        },
        {
          label: "B",
          text: "We make premium skincare with thoughtful ingredients for your everyday lifestyle."
        }
      ]
    },
    {
      expected: "B",
      assets: [
        {
          label: "A",
          text: "A skincare ecosystem designed for all your needs with a holistic approach to modern beauty."
        },
        {
          label: "B",
          text: "Before you buy another serum, fix the barrier problem first. Start with the tested hydration kit."
        }
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
  if (!email) {
    return "";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, "Invite email is invalid.");
  }
  return email;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getHeader(request, name) {
  const headers = request.headers || {};
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return "";
}

function requestOrigin(request) {
  const host = getHeader(request, "x-forwarded-host") || getHeader(request, "host") || "stimli.vercel.app";
  const protocol = getHeader(request, "x-forwarded-proto") || (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${protocol}://${host.split(",")[0].trim()}`;
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text, contentType) {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.end(text);
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
