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
  verifyAuthentication,
  verifyRegistration
} from "./_lib/auth.js";
import {
  getAsset,
  getComparison,
  getProject,
  countUsageEvents,
  listAssets,
  listComparisons,
  listOutcomes,
  listProjects,
  getShareLink,
  saveAsset,
  saveComparison,
  saveOutcome,
  saveProject,
  saveShareLink,
  saveUsageEvent,
  storageHealth
} from "./_lib/store.js";

const assetTypes = new Set(["script", "landing_page", "image", "audio", "video"]);
const maxInlineFileBytes = Number(process.env.STIMLI_MAX_INLINE_FILE_BYTES || 8 * 1024 * 1024);

export default async function handler(request, response) {
  setBaseHeaders(response);
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

    if (segments[0] === "share") {
      return await handleSharedReport(request, response, segments);
    }

    if (segments[0] === "blob" && segments[1] === "upload") {
      return await handleBlobUpload(request, response, authContext);
    }

    if (request.method === "POST" && apiPath === "/demo/seed") {
      const payload = await parseJson(request);
      const projectId = await resolveProjectId(payload.project_id, workspaceId);
      return sendJson(response, 200, await seedDemo(workspaceId, projectId));
    }

    if (segments[0] === "projects") {
      return await handleProjects(request, response, segments, workspaceId);
    }

    if (segments[0] === "assets") {
      return await handleAssets(request, response, segments, workspaceId);
    }

    if (segments[0] === "comparisons") {
      return await handleComparisons(request, response, segments, workspaceId);
    }

    if (segments[0] === "reports") {
      return await handleReports(request, response, segments, workspaceId);
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

async function handleProjects(request, response, segments, workspaceId) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(response, 200, await listProjects(workspaceId));
  }

  if (request.method === "POST" && segments.length === 1) {
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
  return sendJson(response, 404, { detail: "Not found" });
}

async function handleAssets(request, response, segments, workspaceId) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(response, 200, (await listAssets(workspaceId)).map(publicAsset));
  }

  if (request.method === "POST" && segments.length === 1) {
    await enforceUsageLimit(request, workspaceId, "asset", Number(process.env.STIMLI_ASSET_LIMIT_PER_HOUR || 80));
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
        maximumSizeInBytes: Number(process.env.STIMLI_MAX_DIRECT_UPLOAD_BYTES || 250 * 1024 * 1024),
        tokenPayload: JSON.stringify({ workspace_id: workspaceId })
      };
    },
    onUploadCompleted: async () => undefined
  });
  return sendJson(response, 200, result);
}

async function handleComparisons(request, response, segments, workspaceId) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(response, 200, (await listComparisons(workspaceId)).map(publicComparison));
  }

  if (request.method === "POST" && segments.length === 1) {
    await enforceUsageLimit(request, workspaceId, "comparison", Number(process.env.STIMLI_COMPARISON_LIMIT_PER_HOUR || 24));
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
    const rawComparison = shouldCreateAsyncComparison(payload, assets)
      ? await createAsyncComparison(comparisonId, payload.objective, assets, createdAt, payload.brief)
      : await compareAssets(comparisonId, payload.objective, assets, createdAt, payload.brief);
    rawComparison.workspace_id = workspaceId;
    rawComparison.project_id = projectId;
    const comparison = publicComparison(rawComparison);
    await saveComparison(comparison);
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
    return sendJson(response, 200, await cancelComparison(comparisonId, workspaceId));
  }

  if (request.method === "POST" && segments[2] === "challengers") {
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
    return sendJson(response, 200, { asset: publicAsset(asset), source_asset_id: sourceVariant.asset.id, focus });
  }

  if (segments[2] === "outcomes") {
    if (request.method === "GET") {
      await requireComparison(comparisonId, workspaceId);
      return sendJson(response, 200, await listOutcomes(comparisonId, workspaceId));
    }

    if (request.method === "POST") {
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
      return sendJson(response, 200, outcome);
    }
  }

  return sendJson(response, 405, { detail: "Method not allowed" });
}

async function handleReports(request, response, segments, workspaceId) {
  if (request.method === "POST" && segments[1] && segments[2] === "share") {
    return sendJson(response, 200, await createShareLink(request, segments[1], workspaceId));
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

function setBaseHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Stimli-Workspace");
  response.setHeader("Cache-Control", "no-store");
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
