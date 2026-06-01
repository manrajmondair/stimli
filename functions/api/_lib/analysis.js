// Brain-aware creative analysis for the Stimli API.
//
// configureAnalysis(env) is called once per request from the Pages Function
// entry point so TRIBE_INFERENCE_URL / TRIBE_CONTROL_URL / STIMLI_EXTRACT_URL /
// TRIBE_API_KEY come from the runtime env. UUIDs use globalThis.crypto.randomUUID.
// Otherwise pure analysis code: deterministic heuristic timeline when no
// remote provider is configured, hosted TRIBE timeline when it is.
//
// When OPENROUTER_API_KEY is set, the templated edit cards, recommendation
// reasons, and challenger drafts are polished through copy_llm.js (OpenRouter
// → Claude Haiku 4.5 by default). When it's unset, every output path is
// purely deterministic so tests stay reproducible without a paid LLM.

import {
  checkCompliance,
  configureCopyLlm,
  copyLlmProviderHealth,
  generateChallengerText as polishChallengerText,
  isCopyLlmEnabled,
  polishEditsForVariant,
  polishRecommendation
} from "./copy_llm.js";

const ctaWords = new Set(["buy", "shop", "try", "start", "get", "claim", "book", "subscribe", "download", "order"]);
const hookWords = new Set(["stop", "why", "secret", "mistake", "before", "after", "new", "finally", "without", "save"]);
const proofWords = new Set(["proven", "tested", "reviews", "trusted", "clinical", "study", "customers", "results"]);
const brandWords = new Set(["brand", "logo", "name", "signature", "formula", "routine", "system", "kit"]);
const jargonWords = new Set(["synergy", "leverage", "paradigm", "holistic", "revolutionary", "seamless", "ecosystem"]);

// Cross-request ring buffer of recent remote-inference failures. Lets
// providerHealth() report when the hosted TRIBE endpoint is actually degraded
// instead of claiming it's healthy just because a URL is configured. Stores
// system-level codes only (HTTP status / transport class), never response
// bodies, so nothing tenant-specific crosses requests inside a shared isolate.
const BRAIN_ERROR_WINDOW_MS = 5 * 60 * 1000;
const BRAIN_ERROR_LIMIT = 50;
const _recentBrainErrors = [];

// Records a remote-inference failure for health reporting. `code` MUST be a
// short, system-level identifier (e.g. "http 503", "inference timeout"), never
// an upstream response body.
export function noteRemoteBrainFailure(code) {
  const now = Date.now();
  _recentBrainErrors.push({ at: now, code: String(code || "").slice(0, 80) });
  while (_recentBrainErrors.length && now - _recentBrainErrors[0].at > BRAIN_ERROR_WINDOW_MS) {
    _recentBrainErrors.shift();
  }
  while (_recentBrainErrors.length > BRAIN_ERROR_LIMIT) {
    _recentBrainErrors.shift();
  }
}

function recentBrainErrors() {
  const now = Date.now();
  let count60 = 0;
  for (const entry of _recentBrainErrors) {
    if (now - entry.at <= 60 * 1000) count60 += 1;
  }
  const last = _recentBrainErrors.length ? _recentBrainErrors[_recentBrainErrors.length - 1] : null;
  return {
    count_last_60s: count60,
    last_code: last ? last.code : null,
    last_at: last ? last.at : null
  };
}

// Trips the inline circuit breaker once the remote endpoint has failed this many
// times inside the rolling 60s window. Kept low because a comparison fans out
// one inference call per variant, so two failures already means "this endpoint
// is down right now" — stop probing it inline until the window clears. The
// breaker closes automatically as failures age out of the 60s window.
const BRAIN_CIRCUIT_OPEN_THRESHOLD = 2;

function isRemoteBrainCircuitOpen() {
  return recentBrainErrors().count_last_60s >= BRAIN_CIRCUIT_OPEN_THRESHOLD;
}

// Test-only: clears the failure ring so brain-health/circuit-breaker tests can
// assert from a known-clean state regardless of execution order. Harmless in
// production (never called there).
export function resetRemoteBrainHealth() {
  _recentBrainErrors.length = 0;
}

let _env = {};

export function configureAnalysis(env) {
  _env = env || {};
  configureCopyLlm(env);
}

function getEnv(name) {
  return _env[name];
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export async function providerHealth() {
  const remoteUrl = getEnv("TRIBE_INFERENCE_URL") || "";
  const remoteConfigured = Boolean(remoteUrl);
  const recent = recentBrainErrors();
  // Configured AND not in a recent failure burst → genuinely active. Two or
  // more failures inside 60s flips the indicator so /api/brain/providers and
  // the admin panel reflect a real Modal outage instead of lying "active" while
  // every comparison silently falls back to the heuristic.
  const degraded = remoteConfigured && recent.count_last_60s >= 2;
  const remoteActive = remoteConfigured && !degraded;
  return [
    {
      provider: "web-heuristic-brain",
      available: true,
      // The heuristic is the live timeline source whenever the remote isn't
      // (either unconfigured or degraded), so it truthfully picks up the slack.
      active: !remoteActive,
      detail: "Deterministic serverless provider for Cloudflare deployments."
    },
    {
      provider: "tribe-remote",
      available: remoteConfigured,
      active: remoteActive,
      detail: !remoteConfigured
        ? "Set TRIBE_INFERENCE_URL to use a hosted TRIBE inference service."
        : degraded
          ? `Remote TRIBE inference degraded — ${recent.count_last_60s} failures in the last 60s; serving heuristic timelines. Last code: ${recent.last_code || "unknown"}.`
          : "Remote TRIBE inference endpoint is configured.",
      recent_errors: recent
    },
    copyLlmProviderHealth(_env)
  ];
}

export async function compareAssets(comparisonId, objective, assets, createdAt, brief = {}) {
  return compareAssetsWithBrain(comparisonId, objective, assets, createdAt, brief);
}

export async function compareAssetsWithBrain(comparisonId, objective, assets, createdAt, brief = {}, brainByAssetId = {}) {
  // Snapshot the env reference at entry. Module-level _env can be overwritten
  // by a concurrent request's configureAnalysis call between the time we
  // enter compareAssetsWithBrain and the time downstream awaits fire. Threading
  // requestEnv explicitly through analyzeAsset (for TRIBE inference) and the
  // polish stages keeps every async branch on the env that was active when
  // this comparison started, not whatever the module state happens to point
  // at after a yield.
  const requestEnv = _env;
  const safeBrief = normalizeBrief(brief);
  let analyses = await Promise.all(assets.map((asset) => analyzeAsset(asset, safeBrief, brainByAssetId[asset.id], requestEnv)));
  // Fairness: every variant in one comparison must be scored by the same engine.
  // A flaky remote can answer for some variants and time out for others on the
  // inline path, which would pit a neural-scored variant against a heuristic-
  // scored one. If the providers aren't uniform, fall the whole comparison back
  // to the deterministic heuristic so the ranking stays apples-to-apples. (The
  // async path only reaches here once every job is complete, so it's already
  // uniform and this never re-runs it.)
  if (new Set(analyses.map((analysis) => analysis.provider)).size > 1) {
    try { console.warn("[analysis] mixed brain providers in one comparison; normalizing to heuristic for fairness"); } catch {}
    analyses = await Promise.all(
      assets.map((asset) =>
        analyzeAsset(asset, safeBrief, { provider: "web-heuristic-brain", timeline: heuristicTimeline(asset) }, requestEnv)
      )
    );
  }
  const ranked = assets
    .map((asset, index) => [asset, analyses[index]])
    .sort((left, right) => right[1].scores.overall - left[1].scores.overall);
  const bestScore = ranked[0][1].scores.overall;
  const variants = ranked.map(([asset, analysis], index) => ({
    asset,
    analysis,
    rank: index + 1,
    delta_from_best: round(bestScore - analysis.scores.overall, 1)
  }));
  const baseRecommendation = buildRecommendation(variants);
  const winnerVariant = variants[0];
  const rawSuggestions = variants.flatMap((variant) =>
    suggestionsForVariant(variant.asset, variant.analysis, safeBrief, {
      winnerAssetId: winnerVariant.asset.id,
      winnerScores: winnerVariant.analysis.scores,
      winnerTimeline: winnerVariant.analysis.timeline,
      isWinner: variant.asset.id === winnerVariant.asset.id
    })
  );

  // The three LLM stages share no inputs — fan them out in parallel so a slow
  // OpenRouter response in any single stage doesn't compound onto the other
  // two and blow past Cloudflare Pages Functions' wall-clock budget. Each
  // stage is wrapped in a defensive .catch so a thrown error in any one of
  // them degrades to the deterministic fallback for that stage instead of
  // rejecting the whole Promise.all and failing the comparison.
  const [polishedSuggestions, recommendation, compliance] = await Promise.all([
    polishSuggestionsAcrossVariants(rawSuggestions, variants, safeBrief, requestEnv).catch((err) => {
      try { console.warn(`[analysis] polishSuggestions failed: ${err?.message || err}`); } catch {}
      return rawSuggestions;
    }),
    polishRecommendation({
      env: requestEnv,
      variants,
      recommendation: baseRecommendation,
      brief: safeBrief
    }).catch((err) => {
      try { console.warn(`[analysis] polishRecommendation failed: ${err?.message || err}`); } catch {}
      return baseRecommendation;
    }),
    collectCompliance(variants, safeBrief, requestEnv).catch((err) => {
      try { console.warn(`[analysis] collectCompliance failed: ${err?.message || err}`); } catch {}
      return null;
    })
  ]);

  const finalSuggestions = polishedSuggestions
    .sort((a, b) => {
      // Winner's edits first (they're the ones we ship), then by expected lift, then severity.
      if (a.asset_id !== b.asset_id) {
        if (a.asset_id === winnerVariant.asset.id) return -1;
        if (b.asset_id === winnerVariant.asset.id) return 1;
      }
      const liftDelta = (b.expected_lift || 0) - (a.expected_lift || 0);
      if (Math.abs(liftDelta) > 0.05) return liftDelta;
      return severityRank(a.severity) - severityRank(b.severity);
    })
    .slice(0, 8);

  return {
    id: comparisonId,
    objective: objective || "Find the variant most likely to earn attention, build memory, and convert.",
    brief: safeBrief,
    status: "complete",
    variants,
    recommendation,
    suggestions: finalSuggestions,
    compliance,
    created_at: createdAt
  };
}

async function polishSuggestionsAcrossVariants(suggestions, variants, brief, env) {
  if (!isCopyLlmEnabled(env) || !suggestions.length) {
    return suggestions;
  }
  // Group edits by asset so we send one LLM call per variant — that's the right
  // batch boundary: each variant gets a single coherent rewrite pass with its
  // own context, instead of N individual calls per edit card.
  const byAsset = new Map();
  for (const suggestion of suggestions) {
    if (!byAsset.has(suggestion.asset_id)) byAsset.set(suggestion.asset_id, []);
    byAsset.get(suggestion.asset_id).push(suggestion);
  }
  const variantByAssetId = new Map(variants.map((variant) => [variant.asset.id, variant]));
  // Per-variant try/catch so a throw on one variant's polish call doesn't
  // discard the work already completed for sibling variants. polishEditsForVariant
  // catches OpenRouter errors internally and returns passthrough; this wrapper
  // is the defense against a future unexpected sync throw (e.g. JSON.stringify
  // hitting a circular ref in user payload construction).
  const polishedPairs = await Promise.all(
    Array.from(byAsset.entries()).map(async ([assetId, edits]) => {
      const variant = variantByAssetId.get(assetId);
      if (!variant) return [assetId, edits];
      try {
        const polished = await polishEditsForVariant({ env, asset: variant.asset, brief, edits });
        return [assetId, polished];
      } catch (err) {
        try { console.warn(`[analysis] polishEditsForVariant threw for ${assetId}: ${err?.message || err}`); } catch {}
        return [assetId, edits];
      }
    })
  );
  const flat = [];
  for (const [, edits] of polishedPairs) {
    flat.push(...edits);
  }
  return flat;
}

async function collectCompliance(variants, brief, env) {
  if (!isCopyLlmEnabled(env)) return null;
  const required = (brief.required_claims || []).filter(Boolean);
  const forbidden = (brief.forbidden_terms || []).filter(Boolean);
  if (!required.length && !forbidden.length) return null;
  const checks = await Promise.all(
    variants.map(async (variant) => {
      // Skip compliance entirely when extraction yielded nothing — falling
      // back to asset.name would let a filename like
      // "cures-cancer-miracle-drops.mp4" trigger false forbidden-term hits
      // (or worse, mask the real ad content with a clean filename).
      const text = typeof variant.asset.extracted_text === "string" ? variant.asset.extracted_text.trim() : "";
      if (!text) return null;
      const result = await checkCompliance({ env, text, brief });
      if (!result) return null;
      return { asset_id: variant.asset.id, ...result };
    })
  );
  const filtered = checks.filter(Boolean);
  return filtered.length ? filtered : null;
}

export function shouldCreateAsyncComparison(payload = {}, assets = []) {
  // Async routing exists for assets that genuinely need the hosted Modal
  // pipeline (GPU inference + media extraction): audio, video, and large file
  // uploads. With no control-plane URL there's nowhere to enqueue jobs, so we
  // always stay synchronous.
  if (!getEnv("TRIBE_CONTROL_URL")) {
    return false;
  }
  // Explicit opt-out wins over everything — lets a caller (or the
  // STIMLI_SYNC_REMOTE operability switch) force inline analysis even for media.
  if (payload.async === false || payload.inference_mode === "sync" || getEnv("STIMLI_SYNC_REMOTE") === "1") {
    return false;
  }
  // Explicit opt-in from the caller.
  if (payload.async === true || payload.inference_mode === "async") {
    return true;
  }
  // Default: route only media/large uploads to the async pipeline. Text scripts
  // and landing pages are analyzed inline — they don't need the GPU path, and
  // routing every text comparison (including the demo set) through Modal made
  // them fail hard with "Request failed" whenever the Modal app was cold or
  // unavailable. Inline analysis still calls the remote inference endpoint when
  // configured and degrades to the heuristic if it's unreachable.
  return assets.some((asset) => {
    const size = Number(asset.metadata?.blob_size || asset.metadata?.file_size || 0);
    return asset.type === "audio" || asset.type === "video" || size > Number(getEnv("STIMLI_ASYNC_FILE_BYTES") || 20 * 1024 * 1024);
  });
}

export function createPendingComparison(comparisonId, objective, assets, createdAt, brief = {}, jobs = []) {
  const safeBrief = normalizeBrief(brief);
  const jobByAssetId = new Map(jobs.map((job) => [job.asset_id, job]));
  return {
    id: comparisonId,
    objective: objective || "Find the variant most likely to earn attention, build memory, and convert.",
    brief: safeBrief,
    status: "processing",
    variants: assets.map((asset, index) => ({
      asset,
      analysis: pendingAnalysis(asset, jobByAssetId.get(asset.id)),
      rank: index + 1,
      delta_from_best: 0
    })),
    recommendation: {
      winner_asset_id: null,
      verdict: "revise",
      confidence: 0,
      headline: "Analyzing variants with hosted TRIBE inference",
      reasons: ["Stimli is processing media assets and will update this decision when the model results are ready."]
    },
    suggestions: [],
    jobs,
    created_at: createdAt
  };
}

// TRIBE-side helpers take an optional `env` so callers with a per-request
// snapshot can avoid the module-state race; callers without env (legacy
// dispatch sites in [[path]].js) fall back to the same env that
// configureAnalysis just stashed. Both branches go through the same
// resolveTribeEnv path so the read source is consistent.
function resolveTribeEnv(env) {
  return env || _env;
}

function tribeUrl(env) {
  return resolveTribeEnv(env).TRIBE_CONTROL_URL || "";
}

function tribeTimeoutMs(env) {
  return Number(resolveTribeEnv(env).TRIBE_CONTROL_TIMEOUT_MS || 20000);
}

export async function startBrainJob(asset, env) {
  const response = await fetch(tribeUrl(env), {
    method: "POST",
    headers: remoteHeaders(env),
    body: JSON.stringify({ action: "start", asset }),
    signal: AbortSignal.timeout(tribeTimeoutMs(env))
  });
  if (!response.ok) {
    throw new Error(`Remote job provider returned ${response.status}`);
  }
  const payload = await response.json();
  return {
    job_id: payload.job_id,
    asset_id: payload.asset_id || asset.id,
    status: payload.status || "queued",
    provider: payload.provider || "tribe-remote",
    created_at: payload.created_at || nowIso(),
    updated_at: payload.updated_at || nowIso()
  };
}

export async function getBrainJob(jobId, env) {
  const response = await fetch(tribeUrl(env), {
    method: "POST",
    headers: remoteHeaders(env),
    body: JSON.stringify({ action: "status", job_id: jobId }),
    signal: AbortSignal.timeout(tribeTimeoutMs(env))
  });
  if (!response.ok) {
    throw new Error(`Remote job status returned ${response.status}`);
  }
  return response.json();
}

export async function cancelBrainJob(jobId, env) {
  const response = await fetch(tribeUrl(env), {
    method: "POST",
    headers: remoteHeaders(env),
    body: JSON.stringify({ action: "cancel", job_id: jobId }),
    signal: AbortSignal.timeout(tribeTimeoutMs(env))
  });
  if (!response.ok) {
    throw new Error(`Remote job cancel returned ${response.status}`);
  }
  return response.json();
}

export async function extractAssetText(asset, env) {
  const source = resolveTribeEnv(env);
  const extractUrl = source.STIMLI_EXTRACT_URL || "";
  if (!extractUrl) {
    return null;
  }
  try {
    const response = await fetch(extractUrl, {
      method: "POST",
      headers: remoteHeaders(env),
      body: JSON.stringify({ asset }),
      signal: AbortSignal.timeout(Number(source.STIMLI_EXTRACT_TIMEOUT_MS || 25000))
    });
    if (!response.ok) {
      throw new Error(`Extractor returned ${response.status}`);
    }
    const payload = await response.json();
    return {
      text: String(payload.text || "").trim(),
      provider: payload.provider || "stimli-extractor",
      segments: Array.isArray(payload.segments) ? payload.segments : [],
      metadata: payload.metadata || {}
    };
  } catch (error) {
    return {
      text: "",
      provider: "stimli-extractor",
      segments: [],
      metadata: {
        extraction_status: "error",
        extraction_error: error.message
      }
    };
  }
}

export async function analyzeAsset(asset, brief = {}, brainOverride = null, env) {
  const safeBrief = normalizeBrief(brief);
  const text = asset.extracted_text || asset.name || asset.source_url || "";
  const words = tokenize(text);
  let { provider, timeline } = brainOverride ? normalizeBrainOverride(brainOverride) : await predictBrain(asset, env);
  // Guarantee a usable timeline. A remote job can report "complete" with an
  // empty or garbled timeline; rather than throw (which would reject the whole
  // comparison's Promise.all with an opaque 500) or crash the feature-vector
  // math below on a zero-length array, fall back to the deterministic heuristic
  // so the variant still scores. heuristicTimeline always returns >= 3 points.
  if (!Array.isArray(timeline) || timeline.length === 0) {
    if (brainOverride) noteRemoteBrainFailure("empty job timeline");
    provider = "web-heuristic-brain";
    timeline = heuristicTimeline(asset);
  }
  const neuralAttention = average(timeline.map((point) => point.attention));
  const memory = average(timeline.map((point) => point.memory));
  const cognitiveLoad = average(timeline.map((point) => point.cognitive_load));
  const scores = {
    overall: 0,
    hook: hookScore(words),
    clarity: clarityScore(text, words),
    cta: ctaScore(words),
    brand_cue: brandScore(words, asset, safeBrief),
    pacing: pacingScore(asset, words),
    offer_strength: offerScore(words, safeBrief),
    audience_fit: audienceScore(words, safeBrief),
    neural_attention: round(neuralAttention * 100, 1),
    memory: round(memory * 100, 1),
    cognitive_load: round(cognitiveLoad * 100, 1)
  };
  scores.overall = overallScore(scores);
  return {
    asset_id: asset.id,
    provider,
    status: "complete",
    scores,
    timeline,
    feature_vector: {
      word_count: words.length,
      peak_attention: round(Math.max(...timeline.map((point) => point.attention)), 3),
      attention_drop: round(timeline[0].attention - timeline[timeline.length - 1].attention, 3),
      load_peak: round(Math.max(...timeline.map((point) => point.cognitive_load)), 3)
    },
    summary: summarize(asset, scores)
  };
}

export function buildChallengerText(asset, brief = {}, focus = "hook") {
  const safeBrief = normalizeBrief(brief);
  const original = (asset.extracted_text || asset.name || "").trim();
  const brand = safeBrief.brand_name || "the brand";
  const audience = safeBrief.audience || "people with this problem";
  const offer = safeBrief.primary_offer || "the offer";
  const proof = safeBrief.required_claims[0] || "a clearer proof point";

  if (focus === "cta") {
    return `${original}\n\nTry ${offer} today from ${brand}.`;
  }
  if (focus === "offer") {
    return `Stop guessing what will work for ${audience}. ${brand}'s ${offer} gives you ${proof}. Shop the starter option today.`;
  }
  if (focus === "clarity") {
    return `For ${audience}: one problem, one proof point, one next step. ${brand} gives you ${proof} with ${offer}. Try it today.`;
  }
  return `Stop settling for a routine that does not work for ${audience}. ${brand} gives you ${proof} with ${offer}. Try it today.`;
}

// Async variant. Calls the templated builder for the deterministic fallback and
// optionally polishes through the LLM when OPENROUTER_API_KEY is set. Designed
// so the handler can `await` a single call and never has to think about whether
// LLM polish is on.
export async function generateChallenger(asset, brief = {}, focus = "hook") {
  const requestEnv = _env;
  const fallback = buildChallengerText(asset, brief, focus);
  if (!isCopyLlmEnabled(requestEnv)) return fallback;
  return polishChallengerText({ env: requestEnv, asset, brief: normalizeBrief(brief), focus, fallback });
}

async function predictBrain(asset, env) {
  // Prefer the env snapshot threaded from compareAssetsWithBrain; fall back
  // to module-level _env only when this function is called outside the
  // request-scoped path (legacy callers, tests). Reading from a snapshot
  // here keeps TRIBE inference on the same env the polish layer uses, even
  // when a concurrent configureAnalysis has overwritten module state mid-
  // request.
  const source = env || _env;
  const remoteUrl = source.TRIBE_INFERENCE_URL || "";
  // Circuit breaker: once the hosted endpoint has failed repeatedly in the last
  // 60s, stop probing it inline and serve the heuristic immediately. A cold or
  // unreachable Modal app would otherwise cost every comparison a full inference
  // timeout, which — stacked with the LLM polish stage — can exceed the
  // Cloudflare Pages Functions request budget and turn into a hard 500 ("Request
  // failed") before the catch below ever runs. The breaker closes itself once
  // the failures age out of the window.
  if (remoteUrl && !isRemoteBrainCircuitOpen()) {
    try {
      const response = await fetch(remoteUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(source.TRIBE_API_KEY ? { Authorization: `Bearer ${source.TRIBE_API_KEY}` } : {})
        },
        body: JSON.stringify({ asset }),
        // Budget-safe default: the inline path must abort well inside the
        // Cloudflare request window so the catch below (heuristic fallback)
        // actually runs. Genuinely slow GPU jobs belong on the async Modal
        // pipeline, not inline. Override via TRIBE_INFERENCE_TIMEOUT_MS only if
        // the inference endpoint is known-fast.
        signal: AbortSignal.timeout(Number(source.TRIBE_INFERENCE_TIMEOUT_MS || 4000))
      });
      if (!response.ok) {
        throw new Error(`Remote provider returned ${response.status}`);
      }
      const payload = await response.json();
      const timeline = normalizeTimeline(payload.timeline || payload);
      if (timeline.length) {
        return { provider: "tribe-remote", timeline };
      }
      throw new Error("Remote provider returned no timeline.");
    } catch (error) {
      // Degrade to the deterministic heuristic rather than failing the whole
      // comparison. The hosted model is an enhancement, not a hard dependency
      // (see README) — a cold or unreachable Modal app must never turn a text
      // comparison into an opaque "Request failed". The provider field on the
      // returned analysis tells the UI which brain actually produced the
      // timeline, and noteRemoteBrainFailure surfaces the outage in
      // /api/brain/providers so the degradation is observable, not silent.
      noteRemoteBrainFailure(error?.message || "inference error");
      try { console.warn(`[analysis] remote inference unavailable, using heuristic: ${error?.message || error}`); } catch {}
    }
  }
  return { provider: "web-heuristic-brain", timeline: heuristicTimeline(asset) };
}

function remoteHeaders(env) {
  const source = resolveTribeEnv(env);
  return {
    "Content-Type": "application/json",
    ...(source.TRIBE_API_KEY ? { Authorization: `Bearer ${source.TRIBE_API_KEY}` } : {})
  };
}

function normalizeBrainOverride(override) {
  // Returns a possibly-empty timeline rather than throwing — analyzeAsset is
  // responsible for falling back to the heuristic when a "complete" job hands
  // back no usable timeline, so this never hard-fails a comparison.
  return {
    provider: override.provider || override.result?.provider || "tribe-remote",
    timeline: normalizeTimeline(override.timeline || override.result?.timeline || [])
  };
}

function pendingAnalysis(asset, job = {}) {
  return {
    asset_id: asset.id,
    provider: job.provider || "tribe-remote",
    status: job.status || "queued",
    scores: emptyScores(),
    timeline: [],
    feature_vector: {},
    summary: "Analysis is queued."
  };
}

function emptyScores() {
  return {
    overall: 0,
    hook: 0,
    clarity: 0,
    cta: 0,
    brand_cue: 0,
    pacing: 0,
    offer_strength: 0,
    audience_fit: 0,
    neural_attention: 0,
    memory: 0,
    cognitive_load: 0
  };
}

function heuristicTimeline(asset) {
  const text = asset.extracted_text || asset.name || "";
  const words = tokenize(text);
  const duration = asset.duration_seconds || (asset.type === "image" || asset.type === "landing_page" ? 8 : Math.max(8, words.length / 2.5));
  const points = Math.max(3, Math.min(12, Math.ceil(duration / 3)));
  const hook = hookScore(words) / 100;
  const clarity = clarityScore(text, words) / 100;
  const cta = ctaScore(words) / 100;
  const memoryBase = (brandScore(words, asset, normalizeBrief({})) + offerScore(words, normalizeBrief({}))) / 200;
  const density = Math.min(1, words.length / Math.max(duration * 3, 1));
  const seed = deterministicSeed(`${asset.id}:${text}:${asset.name}`);

  return Array.from({ length: points }, (_, index) => {
    const progress = index / Math.max(points - 1, 1);
    const pulse = Math.sin((progress + seed) * Math.PI * 2) * 0.07;
    const attention = clamp(0.32 + hook * 0.38 + clarity * 0.12 - progress * 0.1 + pulse, 0.12, 0.96);
    const memory = clamp(0.28 + memoryBase * 0.38 + cta * 0.14 + progress * 0.09 + pulse / 2, 0.1, 0.94);
    const cognitiveLoad = clamp(0.28 + density * 0.32 + (1 - clarity) * 0.22 + Math.abs(pulse), 0.12, 0.95);
    return {
      second: round((duration / Math.max(points - 1, 1)) * index, 1),
      attention: round(attention, 3),
      memory: round(memory, 3),
      cognitive_load: round(cognitiveLoad, 3),
      note: timelineNote(attention, memory, cognitiveLoad)
    };
  });
}

function normalizeTimeline(points) {
  if (!Array.isArray(points)) {
    return [];
  }
  return points
    .map((point, index) => ({
      second: Number(point.second ?? point.time ?? index * 2),
      attention: clamp(Number(point.attention ?? point.neural_attention ?? 0.5), 0, 1),
      memory: clamp(Number(point.memory ?? 0.5), 0, 1),
      cognitive_load: clamp(Number(point.cognitive_load ?? point.load ?? 0.45), 0, 1),
      note: String(point.note || timelineNote(Number(point.attention ?? 0.5), Number(point.memory ?? 0.5), Number(point.cognitive_load ?? 0.45)))
    }))
    .filter((point) => Number.isFinite(point.second));
}

function hookScore(words) {
  const first = words.slice(0, 24);
  let base = 44;
  base += Math.min(first.filter((word) => hookWords.has(word)).length * 12, 30);
  base += first.some((word) => /\d/.test(word)) ? 14 : 0;
  base += first.length <= 18 ? 10 : 0;
  return round(Math.min(base, 100), 1);
}

function clarityScore(text, words) {
  if (!words.length) {
    return 48;
  }
  const sentences = Math.max((text.match(/[.!?]/g) || []).length, 1);
  const averageSentence = words.length / sentences;
  const jargonPenalty = Math.min(words.filter((word) => jargonWords.has(word)).length * 8, 24);
  const lengthPenalty = Math.max(0, averageSentence - 18) * 1.6;
  return round(clamp(88 - jargonPenalty - lengthPenalty, 30, 100), 1);
}

function ctaScore(words) {
  if (!words.length) {
    return 35;
  }
  const last = words.slice(-40);
  const count = last.filter((word) => ctaWords.has(word)).length;
  return round(Math.min(100, 42 + count * 18 + (count && last.length <= 35 ? 8 : 0)), 1);
}

function brandScore(words, asset, brief) {
  const count = words.filter((word) => brandWords.has(word)).length;
  const nameTokens = tokenize(asset.name || "");
  const brandTerms = tokenize(brief.brand_name || "");
  let named = nameTokens.some((token) => words.includes(token));
  named ||= Boolean(brandTerms.length && brandTerms.slice(0, 3).every((term) => words.includes(term)));
  return round(Math.min(100, 38 + Math.min(count * 14, 42) + (named ? 14 : 0)), 1);
}

function pacingScore(asset, words) {
  if (asset.type === "image" || asset.type === "landing_page") {
    return round(clamp(88 - Math.max(0, words.length - 80) * 0.35, 35, 100), 1);
  }
  const duration = asset.duration_seconds || Math.max(8, words.length / 2.5);
  const wordsPerSecond = words.length / Math.max(duration, 1);
  return round(clamp(92 - Math.abs(wordsPerSecond - 2.5) * 13, 35, 100), 1);
}

function offerScore(words, brief) {
  const offerTerms = tokenize(brief.primary_offer || "");
  const offerHits = offerTerms.filter((term) => words.includes(term)).length;
  const proofHits = words.filter((word) => proofWords.has(word)).length;
  const numberHit = words.some((word) => /\d/.test(word));
  return round(Math.min(100, 44 + Math.min(offerHits * 11, 28) + Math.min(proofHits * 8, 20) + (numberHit ? 10 : 0)), 1);
}

function audienceScore(words, brief) {
  const audienceTerms = tokenize(brief.audience || "").filter((term) => term.length > 2);
  const categoryTerms = tokenize(brief.product_category || "").filter((term) => term.length > 2);
  const requiredTerms = brief.required_claims.flatMap((claim) => tokenize(claim).filter((term) => term.length > 2));
  const forbiddenTerms = brief.forbidden_terms.flatMap((term) => tokenize(term));
  const hits = [...audienceTerms, ...categoryTerms, ...requiredTerms].filter((term) => words.includes(term)).length;
  const misses = forbiddenTerms.filter((term) => words.includes(term)).length;
  let score = 58 + Math.min(hits * 6, 32) - Math.min(misses * 14, 36);
  if (!audienceTerms.length && !categoryTerms.length && !requiredTerms.length) {
    score = 68;
  }
  return round(clamp(score, 25, 100), 1);
}

function overallScore(scores) {
  const value =
    scores.hook * 0.16 +
    scores.clarity * 0.12 +
    scores.cta * 0.12 +
    scores.brand_cue * 0.1 +
    scores.pacing * 0.1 +
    scores.offer_strength * 0.11 +
    scores.audience_fit * 0.09 +
    scores.neural_attention * 0.14 +
    scores.memory * 0.09 -
    Math.max(0, scores.cognitive_load - 62) * 0.08;
  return round(clamp(value, 0, 100), 1);
}

function buildRecommendation(variants) {
  const best = variants[0];
  const runnerUp = variants[1];
  const gap = best.analysis.scores.overall - runnerUp.analysis.scores.overall;
  const verdict = best.analysis.scores.overall >= 68 && gap >= 3 ? "ship" : "revise";
  const confidence = round(Math.min(0.94, 0.58 + gap / 45 + Math.max(0, best.analysis.scores.overall - 65) / 120), 2);
  const reasons = buildRecommendationReasons(best, runnerUp, gap, verdict);
  return {
    winner_asset_id: best.asset.id,
    verdict,
    confidence,
    headline: verdict === "ship" ? `Ship ${best.asset.name}` : `Revise before shipping; ${best.asset.name} is the current leader`,
    reasons
  };
}

function buildRecommendationReasons(best, runnerUp, gap, verdict) {
  const reasons = [];
  // Reason 1 — headline composite score with the actual gap and winning-margin context.
  reasons.push(
    gap > 0
      ? `Composite ${best.analysis.scores.overall}/100, ahead of ${runnerUp.asset.name} by ${round(gap, 1)} pts.`
      : `Composite ${best.analysis.scores.overall}/100; tied with ${runnerUp.asset.name}.`
  );

  // Reason 2 — the strongest dimension the winner is winning on, with both
  // sides' actual scores so the user can verify the claim.
  const margins = Object.entries(best.analysis.scores)
    .filter(([key]) => key !== "overall")
    .map(([key, value]) => [key, value - (runnerUp.analysis.scores[key] ?? value)])
    .filter(([, delta]) => Number.isFinite(delta));
  margins.sort((a, b) => b[1] - a[1]);
  const [topKey, topDelta] = margins[0] || [null, 0];
  if (topKey && topDelta > 0.5) {
    const label = DIMENSION_LABEL[topKey] || topKey.replaceAll("_", " ");
    const bestVal = best.analysis.scores[topKey];
    const otherVal = runnerUp.analysis.scores[topKey];
    reasons.push(
      `Biggest edge is ${label} (${round(bestVal, 1)} vs ${round(otherVal, 1)}, +${round(topDelta, 1)} pts).`
    );
  } else {
    reasons.push("The winner takes it on balance, not on a single dimension.");
  }

  // Reason 3 — point to the actual predicted-response peak the user can see
  // on the timeline chart, so the recommendation grounds in the data instead
  // of empty rhetoric.
  const peak = findAttentionPeak(best.analysis.timeline);
  if (peak) {
    reasons.push(
      `Predicted attention peaks at ${Math.round(peak.value * 100)}/100 around ${peak.second.toFixed(1)}s — that's where the hook is landing.`
    );
  }

  // Reason 4 — context-aware caveat, depending on the verdict.
  if (verdict === "revise") {
    const weakest = Object.entries(best.analysis.scores)
      .filter(([key]) => key !== "overall" && key !== "cognitive_load")
      .sort((a, b) => a[1] - b[1])[0];
    if (weakest) {
      const label = DIMENSION_LABEL[weakest[0]] || weakest[0].replaceAll("_", " ");
      reasons.push(
        `Worth fixing the ${label} (${round(weakest[1], 1)}/100) before shipping — see the edit list below.`
      );
    } else {
      reasons.push("Tighten the items in the edit list before allocating spend.");
    }
  } else if (best.analysis.scores.cognitive_load > 62) {
    reasons.push(
      `Cognitive load is at ${round(best.analysis.scores.cognitive_load, 1)}/100 — keep an eye on the dense beats in the edit list.`
    );
  } else {
    reasons.push("Edits below would push the composite further, but none are launch blockers.");
  }

  return reasons;
}

function findAttentionPeak(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) return null;
  let best = null;
  for (const point of timeline) {
    const value = Number(point.attention);
    if (!Number.isFinite(value)) continue;
    if (!best || value > best.value) {
      best = { value, second: Number(point.second) || 0 };
    }
  }
  return best;
}

// Dimension weights in overallScore — used to compute expected lift from a
// per-dimension improvement. Must stay aligned with overallScore() above.
const DIMENSION_WEIGHTS = {
  hook: 0.16,
  clarity: 0.12,
  cta: 0.12,
  brand_cue: 0.1,
  pacing: 0.1,
  offer_strength: 0.11,
  audience_fit: 0.09,
  neural_attention: 0.14,
  memory: 0.09,
  cognitive_load: 0.08
};

// Acceptable floor per dimension. Anything below the floor is a candidate edit.
const DIMENSION_FLOOR = {
  hook: 72,
  clarity: 70,
  cta: 70,
  brand_cue: 66,
  pacing: 66,
  offer_strength: 70,
  audience_fit: 70,
  neural_attention: 64,
  memory: 62
};

const DIMENSION_LABEL = {
  hook: "hook",
  clarity: "clarity",
  cta: "CTA",
  brand_cue: "brand cue",
  pacing: "pacing",
  offer_strength: "offer",
  audience_fit: "audience fit",
  neural_attention: "attention",
  memory: "memory",
  cognitive_load: "cognitive load"
};

const DIMENSION_KIND = {
  hook: "hook",
  clarity: "clarity",
  cta: "cta",
  brand_cue: "brand",
  pacing: "pacing",
  offer_strength: "offer",
  audience_fit: "audience",
  neural_attention: "hook", // attention dips are usually hook/early problems
  memory: "memory",
  cognitive_load: "load"
};

// Timeline channels that map to a given dimension. Used to locate the
// specific second-range in the predicted brain response that is dragging the
// dimension score down.
const DIMENSION_TO_CHANNEL = {
  hook: { channel: "attention", region: "first_third" },
  cta: { channel: "memory", region: "last_third" },
  brand_cue: { channel: "memory", region: "first_half" },
  clarity: { channel: "cognitive_load", region: "global", invert: true },
  cognitive_load: { channel: "cognitive_load", region: "global", invert: true },
  pacing: { channel: "attention", region: "middle" },
  offer_strength: { channel: "memory", region: "middle" },
  audience_fit: { channel: "memory", region: "first_half" },
  neural_attention: { channel: "attention", region: "global" },
  memory: { channel: "memory", region: "global" }
};

function findEvidenceWindow(timeline, channel, region, invert = false) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return null;
  }
  const indexes = timeline.map((_, i) => i);
  let candidates = indexes;
  const n = timeline.length;
  if (region === "first_third") {
    candidates = indexes.slice(0, Math.max(2, Math.ceil(n / 3)));
  } else if (region === "first_half") {
    candidates = indexes.slice(0, Math.max(2, Math.ceil(n / 2)));
  } else if (region === "last_third") {
    candidates = indexes.slice(Math.floor(n * 2 / 3));
  } else if (region === "middle") {
    candidates = indexes.slice(Math.floor(n / 3), Math.ceil(n * 2 / 3));
  }
  if (!candidates.length) candidates = indexes;
  // Find the worst (lowest, or highest if inverted) point in the region; expand
  // a small window around it so the user sees a span, not a single instant.
  let worstIdx = candidates[0];
  let worstValue = invert ? -Infinity : Infinity;
  for (const i of candidates) {
    const v = Number(timeline[i][channel]);
    if (!Number.isFinite(v)) continue;
    if (invert ? v > worstValue : v < worstValue) {
      worstValue = v;
      worstIdx = i;
    }
  }
  const span = Math.max(1, Math.round(n / 6));
  const lo = Math.max(0, worstIdx - Math.floor(span / 2));
  const hi = Math.min(n - 1, lo + span);
  const startSecond = Number(timeline[lo].second);
  const endSecond = Number(timeline[hi].second);
  return {
    start_s: round(Math.min(startSecond, endSecond), 1),
    end_s: round(Math.max(startSecond, endSecond), 1),
    low_value: round(worstValue, 3),
    channel
  };
}

function expectedLiftFor(scoreKey, currentScore, targetScore) {
  const weight = DIMENSION_WEIGHTS[scoreKey] ?? 0.05;
  // Cognitive load contributes via the penalty term (above 62), not directly.
  if (scoreKey === "cognitive_load") {
    const currentPenalty = Math.max(0, currentScore - 62) * 0.08;
    const targetPenalty = Math.max(0, targetScore - 62) * 0.08;
    return round(Math.max(0, currentPenalty - targetPenalty), 1);
  }
  return round(Math.max(0, (targetScore - currentScore) * weight), 1);
}

function severityFromGap(gap) {
  if (gap >= 14) return "high";
  if (gap >= 6) return "medium";
  return "low";
}

function suggestionsForVariant(asset, analysis, brief, ctx = {}) {
  const scores = analysis.scores;
  const timeline = analysis.timeline || [];
  const { winnerScores = scores, winnerAssetId = asset.id, isWinner = false } = ctx;

  // For each dimension, compute (a) gap to the floor, (b) gap to the winner.
  // The bigger of the two is the headline gap. A loser variant primarily
  // wants edits that close the gap to the winner; a winner variant wants
  // edits that close the gap to the floor.
  const dimensionEntries = Object.keys(DIMENSION_FLOOR)
    .map((key) => {
      const current = Number(scores[key] ?? 0);
      const winnerVal = Number(winnerScores[key] ?? current);
      const floor = DIMENSION_FLOOR[key];
      const gapToFloor = Math.max(0, floor - current);
      const gapToWinner = isWinner ? 0 : Math.max(0, winnerVal - current);
      const target = isWinner ? Math.max(floor, current + gapToFloor) : Math.max(floor, winnerVal);
      const gap = Math.max(gapToFloor, gapToWinner);
      const lift = expectedLiftFor(key, current, target);
      return { key, current, winnerVal, floor, gap, gapToFloor, gapToWinner, target, lift };
    })
    .filter((entry) => entry.gap > 1.5 && entry.lift > 0.2);

  // Special cognitive_load handling — only flag it if it's actually above the
  // pain threshold of 62, where it starts to subtract from overall.
  if (scores.cognitive_load > 62) {
    const current = Number(scores.cognitive_load);
    const winnerVal = Number(winnerScores.cognitive_load ?? current);
    const target = Math.min(current, Math.min(60, winnerVal));
    const gap = Math.max(0, current - target);
    const lift = expectedLiftFor("cognitive_load", current, target);
    if (gap > 1.5 && lift > 0.2) {
      dimensionEntries.push({
        key: "cognitive_load",
        current,
        winnerVal,
        floor: 62,
        gap,
        gapToFloor: Math.max(0, current - 62),
        gapToWinner: Math.max(0, current - winnerVal),
        target,
        lift
      });
    }
  }

  // Order edits by expected lift first — that's the answer to "what should I
  // fix to move the overall score the most".
  dimensionEntries.sort((a, b) => b.lift - a.lift);

  const out = [];
  // Cap per-variant — a winner deserves up to 4 edits, losers get 2 so the
  // overall list stays focused on what we're shipping.
  const cap = isWinner ? 4 : 2;
  for (const entry of dimensionEntries.slice(0, cap)) {
    const channelInfo = DIMENSION_TO_CHANNEL[entry.key];
    const evidence = channelInfo
      ? findEvidenceWindow(timeline, channelInfo.channel, channelInfo.region, Boolean(channelInfo.invert))
      : null;
    const detail = buildEditDetail(entry, asset, brief, evidence);
    out.push({
      asset_id: asset.id,
      score_key: entry.key,
      target_kind: DIMENSION_KIND[entry.key] || entry.key,
      target: detail.target,
      severity: severityFromGap(entry.gap),
      dimension_score: round(entry.current, 1),
      compared_to_asset_id: isWinner ? null : winnerAssetId,
      compared_score: isWinner ? null : round(entry.winnerVal, 1),
      evidence_window: evidence,
      expected_lift: entry.lift,
      issue: detail.issue,
      suggested_edit: detail.suggested_edit,
      expected_effect: detail.expected_effect,
      draft_revision: detail.draft_revision
    });
  }
  return out;
}

function formatWindow(evidence) {
  if (!evidence) return null;
  const same = Math.abs(evidence.end_s - evidence.start_s) < 0.05;
  if (same) return `${evidence.start_s.toFixed(1)}s`;
  return `${evidence.start_s.toFixed(1)}s–${evidence.end_s.toFixed(1)}s`;
}

function buildEditDetail(entry, asset, brief, evidence) {
  const { key, current, winnerVal, gap, gapToWinner, lift } = entry;
  const window = formatWindow(evidence);
  const label = DIMENSION_LABEL[key] || key;
  const isAsset = asset.type === "image" || asset.type === "landing_page";

  // Generic, evidence-grounded scaffolding that every edit gets.
  const evidenceClause = window
    ? key === "cognitive_load"
      ? `Predicted load peaks at ${window} (${Math.round((evidence.low_value || 0) * 100)}/100).`
      : `Predicted ${evidence.channel.replace("_", " ")} dips to ${Math.round((evidence.low_value || 0) * 100)}/100 around ${window}.`
    : `Current ${label} score is ${round(current, 1)}/100.`;
  const comparisonClause = gapToWinner > 2
    ? ` Leading variant scores ${round(winnerVal, 1)}.`
    : "";

  switch (key) {
    case "hook":
      return {
        target: window ? `Opening · ${window}` : "Opening (first three seconds)",
        issue: `${evidenceClause} The opening isn't earning attention fast enough.${comparisonClause}`,
        suggested_edit: isAsset
          ? "Lead with the painful before-state or a specific number above the fold — not the product name."
          : "Lead with the customer's pain or a specific number in the first beat, before explaining the product.",
        expected_effect: `Earlier attention; +${lift} pts on the composite score.`,
        draft_revision: hookDraft(asset, brief)
      };
    case "neural_attention":
      return {
        target: window ? `Attention dip · ${window}` : "Attention curve",
        issue: `${evidenceClause} Predicted viewer engagement drops here.${comparisonClause}`,
        suggested_edit: "Tighten or cut the section above — re-cut to a payoff moment within two seconds.",
        expected_effect: `Smoother attention curve; +${lift} pts on the composite score.`,
        draft_revision: null
      };
    case "cta":
      return {
        target: window ? `Close · ${window}` : "Closing beat",
        issue: `${evidenceClause} The next step is too soft, too late, or missing.${comparisonClause}`,
        suggested_edit: brief.primary_offer
          ? `Close with one direct action that names the offer (\"${brief.primary_offer}\") and the action verb.`
          : "Close with one direct verb-led action (\"Try…\", \"Shop…\", \"Start…\") rather than a soft tagline.",
        expected_effect: `Lower decision friction; +${lift} pts on the composite score.`,
        draft_revision: ctaDraft(brief)
      };
    case "brand_cue":
      return {
        target: window ? `Brand window · ${window}` : "Brand introduction",
        issue: `${evidenceClause} Brand ownership is weak — the message could be running for any competitor.${comparisonClause}`,
        suggested_edit: brief.brand_name
          ? `Plant \"${brief.brand_name}\" inside the first proof beat and again near the CTA.`
          : "Plant the brand or product name in the first proof beat and again near the CTA.",
        expected_effect: `Better recall on attention spend; +${lift} pts on the composite score.`,
        draft_revision: brandDraft(brief)
      };
    case "clarity":
      return {
        target: window ? `Dense beat · ${window}` : "Dense passages",
        issue: `${evidenceClause} The audience is being asked to process too much per beat.${comparisonClause}`,
        suggested_edit: "Reduce each beat to one claim, one proof, one next step. Remove abstract filler.",
        expected_effect: `Easier comprehension; +${lift} pts on the composite score.`,
        draft_revision: null
      };
    case "cognitive_load":
      return {
        target: window ? `Load peak · ${window}` : "Highest-load section",
        issue: `${evidenceClause} The audience is stacked on too many simultaneous claims here.${comparisonClause}`,
        suggested_edit: "Split this section: move one supporting claim earlier and let this beat carry only the headline idea.",
        expected_effect: `Lower processing load; reclaims ${lift} pts the load penalty was taking.`,
        draft_revision: null
      };
    case "pacing":
      return {
        target: window ? `Middle · ${window}` : "Middle section",
        issue: `${evidenceClause} The middle drags or compresses too much to land cleanly.${comparisonClause}`,
        suggested_edit: "Shorten setup, move the strongest proof earlier, reserve the final beat for one CTA.",
        expected_effect: `Holds attention through the close; +${lift} pts on the composite score.`,
        draft_revision: null
      };
    case "offer_strength":
      return {
        target: window ? `Offer beat · ${window}` : "Offer beat",
        issue: `${evidenceClause} The offer doesn't feel concrete — what someone gets isn't crisp.${comparisonClause}`,
        suggested_edit: brief.primary_offer
          ? `Name the offer (\"${brief.primary_offer}\") and pair it with one numeric benefit or proof point.`
          : "Name the offer explicitly and pair it with one numeric benefit or proof point.",
        expected_effect: `Clearer value exchange; +${lift} pts on the composite score.`,
        draft_revision: brief.primary_offer
          ? `${brief.primary_offer} — paired with one proof point that names the benefit in numbers.`
          : null
      };
    case "audience_fit":
      return {
        target: window ? `Framing · ${window}` : "Audience framing",
        issue: `${evidenceClause} The message isn't specific enough to who you're talking to.${comparisonClause}`,
        suggested_edit: brief.audience
          ? `Rewrite one early line so it directly names ${brief.audience} or their situation.`
          : "Rewrite one early line so it directly names the audience or their situation.",
        expected_effect: `Improves relevance; +${lift} pts on the composite score.`,
        draft_revision: brief.audience ? `For ${brief.audience}, here's the easiest next step.` : null
      };
    case "memory":
      return {
        target: window ? `Memory low · ${window}` : "Memory encoding",
        issue: `${evidenceClause} Nothing in this stretch is sticky enough to retain.${comparisonClause}`,
        suggested_edit: "Anchor one beat to a repeatable phrase, a number, or a visual signature so it can be recalled later.",
        expected_effect: `Stronger recall; +${lift} pts on the composite score.`,
        draft_revision: null
      };
    default:
      return {
        target: window ? `${label} · ${window}` : label,
        issue: `${evidenceClause}${comparisonClause}`,
        suggested_edit: `Improve ${label}.`,
        expected_effect: `+${lift} pts on the composite score.`,
        draft_revision: null
      };
  }
}

function hookDraft(asset, brief) {
  if (!brief.audience && !brief.brand_name) return null;
  const audience = brief.audience || "your customer";
  const brand = brief.brand_name || asset.name;
  return `Stop making ${audience} work this hard. ${brand} gives them a faster path to the result.`;
}

function ctaDraft(brief) {
  if (!brief.primary_offer) return null;
  return `Try ${brief.primary_offer} today.`;
}

function brandDraft(brief) {
  if (!brief.brand_name) return null;
  const proof = brief.required_claims[0];
  return proof ? `${brief.brand_name} — ${proof}.` : `${brief.brand_name}: the system behind the result.`;
}

function summarize(asset, scores) {
  const strengths = [];
  if (scores.hook >= 72) strengths.push("opens with a strong hook");
  if (scores.cta >= 72) strengths.push("makes the next action clear");
  if (scores.neural_attention >= 66) strengths.push("sustains predicted attention");
  if (scores.memory >= 64) strengths.push("has memorable proof or brand cues");
  if (!strengths.length) strengths.push("needs a sharper first impression");
  return `${asset.name} ${strengths.join(", ")}.`;
}

function timelineNote(attention, memory, load) {
  if (attention >= 0.7 && memory >= 0.62) return "Predicted high attention with useful memory encoding";
  if (load >= 0.68) return "Processing load may be too high";
  if (attention < 0.45) return "Attention risk in this section";
  return "Predicted response is stable";
}

function normalizeBrief(brief = {}) {
  return {
    brand_name: brief.brand_name || "",
    audience: brief.audience || "",
    product_category: brief.product_category || "",
    primary_offer: brief.primary_offer || "",
    required_claims: Array.isArray(brief.required_claims) ? brief.required_claims.filter(Boolean) : [],
    forbidden_terms: Array.isArray(brief.forbidden_terms) ? brief.forbidden_terms.filter(Boolean) : []
  };
}

function tokenize(text = "") {
  return String(text).toLowerCase().match(/[a-zA-Z0-9']+/g) || [];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function severityRank(severity) {
  return { high: 0, medium: 1, low: 2 }[severity] ?? 3;
}

function deterministicSeed(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
