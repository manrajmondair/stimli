import Busboy from "busboy";

import {
  buildChallengerText,
  compareAssets,
  newId,
  nowIso,
  providerHealth
} from "./_lib/analysis.js";
import {
  getAsset,
  getComparison,
  listAssets,
  listComparisons,
  listOutcomes,
  saveAsset,
  saveComparison,
  saveOutcome,
  storageHealth
} from "./_lib/store.js";

const assetTypes = new Set(["script", "landing_page", "image", "audio", "video"]);

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

    if (request.method === "POST" && apiPath === "/demo/seed") {
      return sendJson(response, 200, await seedDemo());
    }

    if (segments[0] === "assets") {
      return handleAssets(request, response, segments);
    }

    if (segments[0] === "comparisons") {
      return handleComparisons(request, response, segments);
    }

    if (segments[0] === "reports") {
      return handleReports(request, response, segments);
    }

    if (request.method === "GET" && apiPath === "/learning/summary") {
      return sendJson(response, 200, learningSummary(await listOutcomes()));
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

async function handleAssets(request, response, segments) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(response, 200, await listAssets());
  }

  if (request.method === "POST" && segments.length === 1) {
    const { fields, files } = await parseForm(request);
    const assetType = fields.asset_type || fields.assetType;
    if (!assetTypes.has(assetType)) {
      throw httpError(400, "asset_type must be script, landing_page, image, audio, or video.");
    }

    const file = files.find((item) => item.fieldname === "file");
    const assetId = newId("asset");
    const url = fields.url || "";
    const finalName = fields.name || url || file?.filename || "Untitled asset";
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

    if (["image", "audio", "video"].includes(assetType) && !extractedText) {
      extractedText = textFromFilename(finalName);
    }

    const asset = {
      id: assetId,
      type: assetType,
      name: finalName,
      source_url: url || null,
      file_path: null,
      extracted_text: extractedText.trim(),
      duration_seconds: fields.duration_seconds ? Number(fields.duration_seconds) : null,
      metadata: {
        original_filename: file?.filename || null,
        file_size: file?.buffer?.length || null,
        content_type: file?.mimeType || null,
        ...extractionMetadata
      },
      created_at: nowIso()
    };
    await saveAsset(asset);
    return sendJson(response, 200, { asset });
  }

  return sendJson(response, 405, { detail: "Method not allowed" });
}

async function handleComparisons(request, response, segments) {
  if (request.method === "GET" && segments.length === 1) {
    return sendJson(response, 200, await listComparisons());
  }

  if (request.method === "POST" && segments.length === 1) {
    const payload = await parseJson(request);
    const assetIds = Array.isArray(payload.asset_ids) ? payload.asset_ids : [];
    if (assetIds.length < 2) {
      throw httpError(400, "At least two asset_ids are required.");
    }

    const assets = [];
    for (const assetId of assetIds) {
      const asset = await getAsset(assetId);
      if (!asset) {
        throw httpError(404, `Asset not found: ${assetId}`);
      }
      assets.push(asset);
    }

    const comparison = await compareAssets(newId("cmp"), payload.objective, assets, nowIso(), payload.brief);
    await saveComparison(comparison);
    return sendJson(response, 200, comparison);
  }

  const comparisonId = segments[1];
  if (!comparisonId) {
    return sendJson(response, 404, { detail: "Not found" });
  }

  if (request.method === "GET" && segments.length === 2) {
    return sendJson(response, 200, await requireComparison(comparisonId));
  }

  if (request.method === "POST" && segments[2] === "challengers") {
    const comparison = await requireComparison(comparisonId);
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
      created_at: nowIso()
    };
    await saveAsset(asset);
    return sendJson(response, 200, { asset, source_asset_id: sourceVariant.asset.id, focus });
  }

  if (segments[2] === "outcomes") {
    if (request.method === "GET") {
      await requireComparison(comparisonId);
      return sendJson(response, 200, await listOutcomes(comparisonId));
    }

    if (request.method === "POST") {
      const comparison = await requireComparison(comparisonId);
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
        created_at: nowIso()
      };
      await saveOutcome(outcome);
      return sendJson(response, 200, outcome);
    }
  }

  return sendJson(response, 405, { detail: "Method not allowed" });
}

async function handleReports(request, response, segments) {
  if (request.method !== "GET" || !segments[1]) {
    return sendJson(response, 405, { detail: "Method not allowed" });
  }
  const report = await buildReport(segments[1]);
  if (segments[2] === "markdown") {
    return sendText(response, 200, reportToMarkdown(report), "text/markdown; charset=utf-8");
  }
  return sendJson(response, 200, report);
}

async function buildReport(comparisonId) {
  const comparison = await requireComparison(comparisonId);
  const outcomes = await listOutcomes(comparisonId);
  const learning = learningSummary(outcomes);
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

async function seedDemo() {
  const samples = [
    {
      id: newId("asset"),
      type: "script",
      name: "Variant A - Pain-led skincare hook",
      extracted_text:
        "Stop wasting money on ten-step routines that still leave your skin dry. The Lumina barrier kit uses one proven morning system to lock in hydration for 24 hours. Thousands of customers switched after seeing calmer skin in seven days. Try the starter kit today.",
      duration_seconds: 28,
      metadata: { demo: true, channel: "paid social" },
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

async function requireComparison(comparisonId) {
  const comparison = await getComparison(comparisonId);
  if (!comparison) {
    throw httpError(404, "Comparison not found");
  }
  return comparison;
}

function learningSummary(outcomes) {
  const totalSpend = round(outcomes.reduce((sum, outcome) => sum + Number(outcome.spend || 0), 0), 2);
  const totalRevenue = round(outcomes.reduce((sum, outcome) => sum + Number(outcome.revenue || 0), 0), 2);
  const totalImpressions = outcomes.reduce((sum, outcome) => sum + Number(outcome.impressions || 0), 0);
  const totalClicks = outcomes.reduce((sum, outcome) => sum + Number(outcome.clicks || 0), 0);
  const totalConversions = outcomes.reduce((sum, outcome) => sum + Number(outcome.conversions || 0), 0);
  const best = outcomes.length
    ? [...outcomes].sort((left, right) => right.revenue - right.spend - (left.revenue - left.spend) || right.conversions - left.conversions || right.clicks - left.clicks)[0]
    : null;
  return {
    outcome_count: outcomes.length,
    total_spend: totalSpend,
    total_revenue: totalRevenue,
    average_ctr: totalImpressions ? round(totalClicks / totalImpressions, 4) : 0,
    average_cvr: totalClicks ? round(totalConversions / totalClicks, 4) : 0,
    best_asset_id: best?.asset_id || null,
    insight: outcomes.length
      ? "Outcome data is ready to compare pre-spend predictions with launch performance."
      : "No launch outcomes logged yet. Add post-flight results after a test campaign."
  };
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
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Cache-Control", "no-store");
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
