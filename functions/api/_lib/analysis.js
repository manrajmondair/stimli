// Brain-aware creative analysis for the Stimli API.
//
// configureAnalysis(env) is called once per request from the Pages Function
// entry point so TRIBE_INFERENCE_URL / TRIBE_CONTROL_URL / STIMLI_EXTRACT_URL /
// TRIBE_API_KEY come from the runtime env. UUIDs use globalThis.crypto.randomUUID.
// Otherwise pure analysis code: deterministic heuristic timeline when no
// remote provider is configured, hosted TRIBE timeline when it is.

const ctaWords = new Set(["buy", "shop", "try", "start", "get", "claim", "book", "subscribe", "download", "order"]);
const hookWords = new Set(["stop", "why", "secret", "mistake", "before", "after", "new", "finally", "without", "save"]);
const proofWords = new Set(["proven", "tested", "reviews", "trusted", "clinical", "study", "customers", "results"]);
const brandWords = new Set(["brand", "logo", "name", "signature", "formula", "routine", "system", "kit"]);
const jargonWords = new Set(["synergy", "leverage", "paradigm", "holistic", "revolutionary", "seamless", "ecosystem"]);

let _env = {};

export function configureAnalysis(env) {
  _env = env || {};
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
  const remoteActive = Boolean(remoteUrl);
  return [
    {
      provider: "web-heuristic-brain",
      available: true,
      active: !remoteActive,
      detail: "Deterministic serverless provider for Cloudflare deployments."
    },
    {
      provider: "tribe-remote",
      available: remoteActive,
      active: remoteActive,
      detail: remoteActive
        ? "Remote TRIBE inference endpoint is configured."
        : "Set TRIBE_INFERENCE_URL to use a hosted TRIBE inference service."
    }
  ];
}

export async function compareAssets(comparisonId, objective, assets, createdAt, brief = {}) {
  return compareAssetsWithBrain(comparisonId, objective, assets, createdAt, brief);
}

export async function compareAssetsWithBrain(comparisonId, objective, assets, createdAt, brief = {}, brainByAssetId = {}) {
  const safeBrief = normalizeBrief(brief);
  const analyses = await Promise.all(assets.map((asset) => analyzeAsset(asset, safeBrief, brainByAssetId[asset.id])));
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
  const recommendation = buildRecommendation(variants);
  const suggestions = variants
    .flatMap((variant) => suggestionsForVariant(variant.asset, variant.analysis, safeBrief))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 8);
  return {
    id: comparisonId,
    objective: objective || "Find the variant most likely to earn attention, build memory, and convert.",
    brief: safeBrief,
    status: "complete",
    variants,
    recommendation,
    suggestions,
    created_at: createdAt
  };
}

export function shouldCreateAsyncComparison(payload = {}, assets = []) {
  if (!getEnv("TRIBE_CONTROL_URL")) {
    return false;
  }
  if (payload.async === true || payload.inference_mode === "async") {
    return true;
  }
  if (getEnv("STIMLI_BRAIN_PROVIDER") === "tribe-remote" && getEnv("STIMLI_SYNC_REMOTE") !== "1") {
    return true;
  }
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

export async function startBrainJob(asset) {
  const response = await fetch(getEnv("TRIBE_CONTROL_URL"), {
    method: "POST",
    headers: remoteHeaders(),
    body: JSON.stringify({ action: "start", asset }),
    signal: AbortSignal.timeout(Number(getEnv("TRIBE_CONTROL_TIMEOUT_MS") || 20000))
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

export async function getBrainJob(jobId) {
  const response = await fetch(getEnv("TRIBE_CONTROL_URL"), {
    method: "POST",
    headers: remoteHeaders(),
    body: JSON.stringify({ action: "status", job_id: jobId }),
    signal: AbortSignal.timeout(Number(getEnv("TRIBE_CONTROL_TIMEOUT_MS") || 20000))
  });
  if (!response.ok) {
    throw new Error(`Remote job status returned ${response.status}`);
  }
  return response.json();
}

export async function cancelBrainJob(jobId) {
  const response = await fetch(getEnv("TRIBE_CONTROL_URL"), {
    method: "POST",
    headers: remoteHeaders(),
    body: JSON.stringify({ action: "cancel", job_id: jobId }),
    signal: AbortSignal.timeout(Number(getEnv("TRIBE_CONTROL_TIMEOUT_MS") || 20000))
  });
  if (!response.ok) {
    throw new Error(`Remote job cancel returned ${response.status}`);
  }
  return response.json();
}

export async function extractAssetText(asset) {
  const extractUrl = getEnv("STIMLI_EXTRACT_URL") || "";
  if (!extractUrl) {
    return null;
  }
  try {
    const response = await fetch(extractUrl, {
      method: "POST",
      headers: remoteHeaders(),
      body: JSON.stringify({ asset }),
      signal: AbortSignal.timeout(Number(getEnv("STIMLI_EXTRACT_TIMEOUT_MS") || 25000))
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

export async function analyzeAsset(asset, brief = {}, brainOverride = null) {
  const safeBrief = normalizeBrief(brief);
  const text = asset.extracted_text || asset.name || asset.source_url || "";
  const words = tokenize(text);
  const { provider, timeline } = brainOverride ? normalizeBrainOverride(brainOverride) : await predictBrain(asset);
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
    return `For ${audience}: one problem, one proof point, one next step. ${brand} gives you ${proof}. Try ${offer} today.`;
  }
  return `Stop settling for a routine that does not work for ${audience}. ${brand} gives you ${proof} with ${offer}. Try it today.`;
}

async function predictBrain(asset) {
  const remoteUrl = getEnv("TRIBE_INFERENCE_URL") || "";
  if (remoteUrl) {
    try {
      const response = await fetch(remoteUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(getEnv("TRIBE_API_KEY") ? { Authorization: `Bearer ${getEnv("TRIBE_API_KEY")}` } : {})
        },
        body: JSON.stringify({ asset }),
        signal: AbortSignal.timeout(Number(getEnv("TRIBE_INFERENCE_TIMEOUT_MS") || 55000))
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
      if (getEnv("STIMLI_BRAIN_PROVIDER") === "tribe-remote") {
        throw error;
      }
    }
  }
  return { provider: "web-heuristic-brain", timeline: heuristicTimeline(asset) };
}

function remoteHeaders() {
  return {
    "Content-Type": "application/json",
    ...(getEnv("TRIBE_API_KEY") ? { Authorization: `Bearer ${getEnv("TRIBE_API_KEY")}` } : {})
  };
}

function normalizeBrainOverride(override) {
  const timeline = normalizeTimeline(override.timeline || override.result?.timeline || []);
  if (!timeline.length) {
    throw new Error("Remote job returned no timeline.");
  }
  return {
    provider: override.provider || override.result?.provider || "tribe-remote",
    timeline
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
  return {
    winner_asset_id: best.asset.id,
    verdict,
    confidence,
    headline: verdict === "ship" ? `Ship ${best.asset.name}` : `Revise before shipping; ${best.asset.name} is the current leader`,
    reasons: [
      `Highest composite score at ${best.analysis.scores.overall}/100.`,
      largestAdvantage(best, runnerUp),
      "Recommendation is based on relative creative quality, predicted response, and editability before spend."
    ]
  };
}

function largestAdvantage(best, other) {
  const entries = Object.entries(best.analysis.scores)
    .filter(([key]) => key !== "overall")
    .map(([key, value]) => [key, value - other.analysis.scores[key]]);
  const [key, delta] = entries.sort((left, right) => right[1] - left[1])[0];
  if (delta <= 0) {
    return "The leader wins on balance rather than a single dominant signal.";
  }
  return `Biggest edge is ${key.replaceAll("_", " ")}, ahead by ${round(delta, 1)} points.`;
}

function suggestionsForVariant(asset, analysis, brief) {
  const scores = analysis.scores;
  const suggestions = [];
  if (scores.hook < 70) {
    suggestions.push({
      asset_id: asset.id,
      target: "0-3 seconds / opening line",
      severity: "high",
      issue: "The opening does not create enough immediate tension or curiosity.",
      suggested_edit: "Lead with the customer's painful before-state, a specific number, or a surprising claim before explaining the product.",
      expected_effect: "Higher early attention and a clearer reason to keep watching or reading.",
      draft_revision: draftHook(asset, brief)
    });
  }
  if (scores.cta < 66) {
    suggestions.push({
      asset_id: asset.id,
      target: "Final third",
      severity: "medium",
      issue: "The next step is too soft or missing.",
      suggested_edit: "End with one direct action such as 'Try the starter kit today' or 'Shop the routine now'.",
      expected_effect: "Reduces decision friction and improves conversion intent.",
      draft_revision: draftCta(brief)
    });
  }
  if (scores.brand_cue < 62) {
    suggestions.push({
      asset_id: asset.id,
      target: "First half",
      severity: "medium",
      issue: "Brand ownership is weak.",
      suggested_edit: "Add the brand or product name near the first proof point and repeat it close to the CTA.",
      expected_effect: "Improves recall so attention compounds into brand memory.",
      draft_revision: draftBrandLine(brief)
    });
  }
  if (scores.cognitive_load > 66 || scores.clarity < 68) {
    suggestions.push({
      asset_id: asset.id,
      target: "Dense sections",
      severity: "high",
      issue: "The creative asks the audience to process too much at once.",
      suggested_edit: "Split long claims into one idea per beat and remove abstract filler words.",
      expected_effect: "Lowers processing load and makes the strongest claim easier to remember.",
      draft_revision: "Break this section into one claim, one proof point, and one next step."
    });
  }
  if (scores.pacing < 66) {
    suggestions.push({
      asset_id: asset.id,
      target: "Middle section",
      severity: "low",
      issue: "Pacing is likely to feel uneven for the format.",
      suggested_edit: "Shorten setup, move proof earlier, and reserve the final beat for a single CTA.",
      expected_effect: "Keeps attention from flattening after the hook.",
      draft_revision: "Move the strongest proof point into the first half and cut any setup that repeats the same idea."
    });
  }
  if (scores.offer_strength < 68 && brief.primary_offer) {
    suggestions.push({
      asset_id: asset.id,
      target: "Offer beat",
      severity: "medium",
      issue: "The creative does not make the offer feel concrete enough.",
      suggested_edit: `Name the offer directly: ${brief.primary_offer}. Pair it with one proof point or numeric benefit.`,
      expected_effect: "Makes the value exchange easier to understand before the CTA.",
      draft_revision: `${brief.primary_offer}: one simple way to get the benefit without rebuilding your routine.`
    });
  }
  if (scores.audience_fit < 68 && brief.audience) {
    suggestions.push({
      asset_id: asset.id,
      target: "Audience framing",
      severity: "medium",
      issue: "The message is not specific enough to the target audience.",
      suggested_edit: `Rewrite one early line so it directly addresses ${brief.audience}.`,
      expected_effect: "Improves relevance and reduces the feeling of a generic ad.",
      draft_revision: `For ${brief.audience}, this should feel like the easiest next step.`
    });
  }
  return suggestions;
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

function draftHook(asset, brief) {
  const audience = brief.audience || "your target customer";
  const brand = brief.brand_name || asset.name;
  return `Stop making ${audience} work this hard. ${brand} gives them a faster path to the result.`;
}

function draftCta(brief) {
  return `Try ${brief.primary_offer || "the starter option"} today.`;
}

function draftBrandLine(brief) {
  return `${brief.brand_name || "the product"} is the system behind ${brief.required_claims[0] || "the proof point"}.`;
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
