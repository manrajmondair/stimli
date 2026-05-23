// OpenRouter-backed copy polish for Stimli analysis output.
//
// Sits behind a feature flag (OPENROUTER_API_KEY). When the key is unset, every
// exported function returns the deterministic templated input unchanged, so the
// rest of the analysis pipeline behaves exactly like it did before this module
// landed. That's what keeps existing tests deterministic and keeps the free
// tier from being forced into a paid LLM dependency.
//
// Runs on the Cloudflare Workers runtime: globalThis.fetch, AbortSignal, no
// node:* imports. configureCopyLlm(env) is called once per request from the
// Pages Function entry point.

const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
const DEFAULT_TIMEOUT_MS = 8000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

let _env = {};

export function configureCopyLlm(env) {
  _env = env || {};
}

function getEnv(name) {
  return _env[name];
}

export function isCopyLlmEnabled() {
  return Boolean(getEnv("OPENROUTER_API_KEY"));
}

export function copyLlmProviderHealth() {
  const enabled = isCopyLlmEnabled();
  return {
    provider: "openrouter",
    available: enabled,
    active: enabled,
    detail: enabled
      ? `OpenRouter copy polish on (${getEnv("STIMLI_LLM_MODEL") || DEFAULT_MODEL}).`
      : "Set OPENROUTER_API_KEY to enable LLM-polished edit cards, reasons, and challengers."
  };
}

export function copyLlmStatus() {
  return {
    enabled: isCopyLlmEnabled(),
    model: getEnv("STIMLI_LLM_MODEL") || DEFAULT_MODEL
  };
}

async function callOpenRouter({ system, user, schemaHint, maxTokens = 900 }) {
  const apiKey = getEnv("OPENROUTER_API_KEY");
  if (!apiKey) return null;
  const model = getEnv("STIMLI_LLM_MODEL") || DEFAULT_MODEL;
  const timeoutMs = Number(getEnv("STIMLI_LLM_TIMEOUT_MS") || DEFAULT_TIMEOUT_MS);
  const referer = getEnv("STIMLI_APP_URL") || getEnv("STIMLI_ORIGIN") || "https://stimli.pages.dev";
  const userPrompt = schemaHint
    ? `${user}\n\nRespond with strict JSON only. Schema:\n${schemaHint}`
    : user;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("openrouter timeout")), timeoutMs);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "Stimli"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const raw = payload?.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== "string") return null;
    return safeJsonParse(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function safeJsonParse(text) {
  const stripped = String(text)
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// --- Edit-card polish -------------------------------------------------------

const EDIT_SCHEMA_HINT = `{
  "edits": [
    {
      "score_key": "<one of: hook, clarity, cta, brand_cue, pacing, offer_strength, audience_fit, neural_attention, memory, cognitive_load>",
      "issue": "<one sentence: what's wrong, grounded in the actual variant text or evidence window>",
      "suggested_edit": "<one actionable instruction; reference the brand/audience/offer when relevant>",
      "draft_revision": "<a concrete rewrite the user can paste, OR null if a literal rewrite doesn't apply (e.g. pacing/load)>"
    }
  ]
}`;

const EDIT_SYSTEM_PROMPT = `You are a senior DTC creative strategist editing ad copy with the same precision a performance marketer uses on a Friday review.
You receive an extracted ad variant, the brief, and templated edit cards that point to weak dimensions in the predicted brain response.
Rewrite each edit card so it:
- Quotes or paraphrases the actual offending text from the variant when possible.
- Names the specific dimension that's failing and the evidence window if provided.
- Gives one concrete next move (not a vague principle).
- Stays under 32 words per field, no fluff, no headlines, no emoji, no exclamation points.
- Uses brand/audience/offer terms from the brief verbatim when they're set.
For draft_revision, write the actual rewritten copy snippet the user can paste - not instructions about how to write it. Return null if the dimension is structural (pacing, cognitive_load) rather than copy-rewritable.
Return ONLY valid JSON matching the schema. Preserve every score_key from the input - never invent or drop edits.`;

export async function polishEditsForVariant({ asset, brief, edits }) {
  if (!isCopyLlmEnabled() || !Array.isArray(edits) || !edits.length) {
    return edits;
  }
  const text = String(asset?.extracted_text || asset?.name || "").trim();
  if (!text) {
    return edits;
  }

  const userPayload = {
    variant: {
      name: asset.name || "",
      type: asset.type || "script",
      source_url: asset.source_url || null,
      extracted_text: clampText(text, 2400)
    },
    brief: {
      brand_name: brief?.brand_name || null,
      audience: brief?.audience || null,
      product_category: brief?.product_category || null,
      primary_offer: brief?.primary_offer || null,
      required_claims: brief?.required_claims || [],
      forbidden_terms: brief?.forbidden_terms || []
    },
    edits: edits.map((edit) => ({
      score_key: edit.score_key,
      target_kind: edit.target_kind,
      dimension_score: edit.dimension_score,
      compared_score: edit.compared_score ?? null,
      evidence_window: edit.evidence_window || null,
      template_issue: edit.issue,
      template_suggested_edit: edit.suggested_edit,
      template_draft_revision: edit.draft_revision || null,
      expected_lift: edit.expected_lift
    }))
  };

  const result = await callOpenRouter({
    system: EDIT_SYSTEM_PROMPT,
    user: JSON.stringify(userPayload),
    schemaHint: EDIT_SCHEMA_HINT,
    maxTokens: Math.min(1400, 220 + edits.length * 180)
  });

  if (!result || !Array.isArray(result.edits)) {
    return edits;
  }

  const polishedByKey = new Map();
  for (const polished of result.edits) {
    if (!polished || typeof polished !== "object") continue;
    if (!polished.score_key || typeof polished.score_key !== "string") continue;
    polishedByKey.set(polished.score_key, polished);
  }

  return edits.map((edit) => {
    const polished = polishedByKey.get(edit.score_key);
    if (!polished) return edit;
    const issue = sanitizeString(polished.issue) || edit.issue;
    const suggestedEdit = sanitizeString(polished.suggested_edit) || edit.suggested_edit;
    let draftRevision = edit.draft_revision;
    if (polished.draft_revision === null) {
      draftRevision = null;
    } else if (typeof polished.draft_revision === "string") {
      const cleaned = sanitizeString(polished.draft_revision);
      if (cleaned) draftRevision = cleaned;
    }
    return {
      ...edit,
      issue,
      suggested_edit: suggestedEdit,
      draft_revision: draftRevision,
      llm_polished: true
    };
  });
}

// --- Recommendation reasons -------------------------------------------------

const REASONS_SCHEMA_HINT = `{
  "headline": "<short verdict sentence, <= 14 words>",
  "reasons": [
    "<reason 1, <= 28 words, evidence-grounded>",
    "<reason 2, <= 28 words>",
    "<reason 3, <= 28 words>",
    "<optional reason 4, <= 28 words>"
  ]
}`;

const REASONS_SYSTEM_PROMPT = `You are a DTC creative analytics partner writing the verdict callout on a comparison report.
You receive: the two top variants, their score breakdowns, the gap, the attention peak, and the brief.
Write the verdict like you would brief a CMO: specific, evidence-anchored, no jargon, no marketing speak.
Cite real numbers (composite score, dimension scores, attention peak seconds) when present.
Never invent metrics that weren't in the input.
Return ONLY valid JSON matching the schema.`;

export async function polishRecommendation({ variants, recommendation, brief }) {
  if (!isCopyLlmEnabled() || !variants || variants.length < 2) {
    return recommendation;
  }
  const best = variants[0];
  const runnerUp = variants[1];
  const peak = findPeak(best?.analysis?.timeline);
  const overallBest = Number(best?.analysis?.scores?.overall) || 0;
  const overallRunner = Number(runnerUp?.analysis?.scores?.overall) || 0;

  const userPayload = {
    verdict: recommendation.verdict,
    confidence: recommendation.confidence,
    template_headline: recommendation.headline,
    template_reasons: recommendation.reasons,
    brief: {
      brand_name: brief?.brand_name || null,
      audience: brief?.audience || null,
      primary_offer: brief?.primary_offer || null
    },
    winner: {
      name: best?.asset?.name,
      composite: overallBest,
      scores: best?.analysis?.scores,
      excerpt: clampText(String(best?.asset?.extracted_text || ""), 600)
    },
    runner_up: {
      name: runnerUp?.asset?.name,
      composite: overallRunner,
      scores: runnerUp?.analysis?.scores,
      excerpt: clampText(String(runnerUp?.asset?.extracted_text || ""), 400)
    },
    gap: Number((overallBest - overallRunner).toFixed(1)),
    attention_peak: peak
  };

  const result = await callOpenRouter({
    system: REASONS_SYSTEM_PROMPT,
    user: JSON.stringify(userPayload),
    schemaHint: REASONS_SCHEMA_HINT,
    maxTokens: 600
  });

  if (!result) return recommendation;
  const headline = sanitizeString(result.headline) || recommendation.headline;
  const reasons = Array.isArray(result.reasons)
    ? result.reasons.map((reason) => sanitizeString(reason)).filter(Boolean).slice(0, 4)
    : null;
  if (!reasons || !reasons.length) return { ...recommendation, headline };
  return { ...recommendation, headline, reasons, llm_polished: true };
}

// --- Challenger variants ----------------------------------------------------

const CHALLENGER_SCHEMA_HINT = `{
  "text": "<the rewritten ad copy, plain text, <= 90 words>",
  "rationale": "<one sentence on how this challenger addresses the focus area>"
}`;

const CHALLENGER_SYSTEM_PROMPT = `You are a senior DTC copywriter producing a challenger ad variant for an A/B test.
Keep the original brand voice and category.
The "focus" tells you the single dimension to upgrade vs the source variant.
- focus=hook: open with the painful before-state or a specific number in the first beat.
- focus=cta: keep the body, sharpen the close with one verb-led action that names the offer.
- focus=offer: lead with the offer itself, pair with one numeric proof point or concrete benefit.
- focus=clarity: collapse to one problem, one proof, one action; cut filler.
Output PLAIN text in the "text" field - no markdown, no quotes around it, no headlines.
Return ONLY valid JSON matching the schema.`;

export async function generateChallengerText({ asset, brief, focus, fallback }) {
  if (!isCopyLlmEnabled()) return fallback;
  const text = String(asset?.extracted_text || asset?.name || "").trim();
  if (!text) return fallback;

  const userPayload = {
    focus,
    source_variant: {
      name: asset.name || "",
      type: asset.type || "script",
      extracted_text: clampText(text, 2400)
    },
    brief: {
      brand_name: brief?.brand_name || null,
      audience: brief?.audience || null,
      product_category: brief?.product_category || null,
      primary_offer: brief?.primary_offer || null,
      required_claims: brief?.required_claims || [],
      forbidden_terms: brief?.forbidden_terms || []
    }
  };

  const result = await callOpenRouter({
    system: CHALLENGER_SYSTEM_PROMPT,
    user: JSON.stringify(userPayload),
    schemaHint: CHALLENGER_SCHEMA_HINT,
    maxTokens: 500
  });

  if (!result) return fallback;
  const polished = sanitizeString(result.text);
  if (!polished) return fallback;
  return polished;
}

// --- Semantic compliance ----------------------------------------------------

const COMPLIANCE_SCHEMA_HINT = `{
  "required_claims": [
    { "claim": "<verbatim from input>", "present": true, "evidence": "<short quote or paraphrase from the variant>" },
    { "claim": "<another>", "present": false, "evidence": null }
  ],
  "forbidden_terms": [
    { "term": "<verbatim from input>", "present": false, "evidence": null }
  ]
}`;

const COMPLIANCE_SYSTEM_PROMPT = `You are a compliance reviewer for DTC ad copy.
For each required_claim, decide whether the variant supports it semantically (not just as a literal substring). Paraphrases count.
For each forbidden_term, decide whether the variant contains it OR a semantic equivalent (e.g. "miracle cure" for "cures cancer").
"evidence" must be a short quote from the variant when present is true, otherwise null.
Return ONLY valid JSON matching the schema. Echo every claim and term you were given.`;

export async function checkCompliance({ text, brief }) {
  if (!isCopyLlmEnabled()) return null;
  const required = Array.isArray(brief?.required_claims) ? brief.required_claims.filter(Boolean) : [];
  const forbidden = Array.isArray(brief?.forbidden_terms) ? brief.forbidden_terms.filter(Boolean) : [];
  const trimmed = clampText(String(text || ""), 2400);
  if (!trimmed || (!required.length && !forbidden.length)) return null;

  const result = await callOpenRouter({
    system: COMPLIANCE_SYSTEM_PROMPT,
    user: JSON.stringify({
      extracted_text: trimmed,
      required_claims: required,
      forbidden_terms: forbidden
    }),
    schemaHint: COMPLIANCE_SCHEMA_HINT,
    maxTokens: 600
  });

  if (!result) return null;
  const requiredChecks = Array.isArray(result.required_claims)
    ? result.required_claims
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          claim: sanitizeString(entry.claim),
          present: Boolean(entry.present),
          evidence: sanitizeString(entry.evidence) || null
        }))
        .filter((entry) => entry.claim)
    : [];
  const forbiddenChecks = Array.isArray(result.forbidden_terms)
    ? result.forbidden_terms
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          term: sanitizeString(entry.term),
          present: Boolean(entry.present),
          evidence: sanitizeString(entry.evidence) || null
        }))
        .filter((entry) => entry.term)
    : [];
  if (!requiredChecks.length && !forbiddenChecks.length) return null;
  return {
    required_claims: requiredChecks,
    forbidden_terms: forbiddenChecks,
    missing_required: requiredChecks.filter((entry) => !entry.present).map((entry) => entry.claim),
    forbidden_hits: forbiddenChecks.filter((entry) => entry.present)
  };
}

// --- Helpers ----------------------------------------------------------------

function findPeak(timeline) {
  if (!Array.isArray(timeline) || !timeline.length) return null;
  let best = null;
  for (const point of timeline) {
    const value = Number(point?.attention);
    if (!Number.isFinite(value)) continue;
    if (!best || value > best.value) {
      best = { value, second: Number(point.second) || 0 };
    }
  }
  return best;
}

function clampText(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function sanitizeString(value) {
  if (typeof value !== "string") return "";
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) {
      out += " ";
    } else if (code >= 32 && code !== 127) {
      out += value[i];
    }
  }
  return out.replace(/\s+/g, " ").trim();
}
