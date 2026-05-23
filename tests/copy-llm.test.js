// Unit tests for the OpenRouter copy-polish module.
//
// Stubs globalThis.fetch with hand-crafted responses to exercise the happy path
// (polished JSON parsed and merged) and the fallback paths (no API key,
// non-2xx, malformed JSON, timeout/network error). When OPENROUTER_API_KEY is
// not set the module must be a complete no-op — that contract is what keeps
// the rest of the suite deterministic.

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCompliance,
  configureCopyLlm,
  copyLlmProviderHealth,
  copyLlmStatus,
  generateChallengerText,
  isCopyLlmEnabled,
  polishEditsForVariant,
  polishRecommendation
} from "../functions/api/_lib/copy_llm.js";

const SAMPLE_ASSET = {
  id: "asset_unit",
  type: "script",
  name: "Sleep Tonight Script",
  extracted_text: "Stop tossing all night. Calmcap helps you fall asleep in twelve minutes."
};

const SAMPLE_BRIEF = {
  brand_name: "Calmcap",
  audience: "thirty-something insomniacs",
  product_category: "Sleep supplement",
  primary_offer: "starter kit",
  required_claims: ["clinically tested"],
  forbidden_terms: ["miracle"]
};

const SAMPLE_EDITS = [
  {
    asset_id: "asset_unit",
    score_key: "hook",
    target_kind: "hook",
    dimension_score: 60,
    compared_score: 78,
    evidence_window: { start_s: 0.0, end_s: 2.0, low_value: 0.31, channel: "attention" },
    expected_lift: 1.9,
    severity: "high",
    issue: "Template issue text",
    suggested_edit: "Template suggested edit",
    expected_effect: "Earlier attention",
    draft_revision: null
  }
];

function setEnv(extras = {}) {
  configureCopyLlm({
    OPENROUTER_API_KEY: "test-key",
    STIMLI_LLM_MODEL: "anthropic/claude-haiku-4.5",
    STIMLI_LLM_TIMEOUT_MS: "5000",
    STIMLI_APP_URL: "https://stimli.test",
    ...extras
  });
}

function clearEnv() {
  configureCopyLlm({});
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => handler(url, options);
  return () => {
    globalThis.fetch = original;
  };
}

function openRouterResponse(content, status = 200) {
  const body = JSON.stringify({ choices: [{ message: { content } }] });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

test("isCopyLlmEnabled is false without OPENROUTER_API_KEY", () => {
  clearEnv();
  assert.equal(isCopyLlmEnabled(), false);
  const health = copyLlmProviderHealth();
  assert.equal(health.provider, "openrouter");
  assert.equal(health.available, false);
  assert.equal(health.active, false);
});

test("polishEditsForVariant is a no-op without the API key", async () => {
  clearEnv();
  const polished = await polishEditsForVariant({
    asset: SAMPLE_ASSET,
    brief: SAMPLE_BRIEF,
    edits: SAMPLE_EDITS
  });
  assert.equal(polished, SAMPLE_EDITS);
});

test("polishEditsForVariant merges polished JSON onto matching score_key", async () => {
  setEnv();
  let receivedUrl = null;
  let receivedBody = null;
  const restore = stubFetch(async (url, options) => {
    receivedUrl = url;
    receivedBody = JSON.parse(options.body);
    return openRouterResponse(
      JSON.stringify({
        edits: [
          {
            score_key: "hook",
            issue: "The opening line names the product before the pain.",
            suggested_edit: "Open on the 3am toss-and-turn moment, then introduce Calmcap.",
            draft_revision: "3am again? Calmcap drops you off in twelve minutes - no morning fog."
          }
        ]
      })
    );
  });
  try {
    const polished = await polishEditsForVariant({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      edits: SAMPLE_EDITS
    });
    assert.equal(receivedUrl, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(receivedBody.model, "anthropic/claude-haiku-4.5");
    assert.ok(Array.isArray(receivedBody.messages));
    assert.equal(receivedBody.messages[0].role, "system");
    assert.equal(receivedBody.response_format?.type, "json_object");
    assert.equal(polished.length, 1);
    assert.equal(polished[0].llm_polished, true);
    assert.match(polished[0].suggested_edit, /Calmcap/);
    assert.match(polished[0].draft_revision, /twelve minutes/);
    // Original metadata (severity, expected_lift) must survive the merge.
    assert.equal(polished[0].severity, "high");
    assert.equal(polished[0].expected_lift, 1.9);
  } finally {
    restore();
    clearEnv();
  }
});

test("polishEditsForVariant ignores edits the LLM didn't return", async () => {
  setEnv();
  const restore = stubFetch(async () => openRouterResponse(JSON.stringify({ edits: [] })));
  try {
    const polished = await polishEditsForVariant({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      edits: SAMPLE_EDITS
    });
    assert.equal(polished.length, 1);
    assert.equal(polished[0].issue, "Template issue text");
    assert.equal(polished[0].llm_polished, undefined);
  } finally {
    restore();
    clearEnv();
  }
});

test("polishEditsForVariant falls back on non-2xx response", async () => {
  setEnv();
  const restore = stubFetch(async () => new Response("backend boom", { status: 503 }));
  try {
    const polished = await polishEditsForVariant({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      edits: SAMPLE_EDITS
    });
    assert.equal(polished, SAMPLE_EDITS);
  } finally {
    restore();
    clearEnv();
  }
});

test("polishEditsForVariant falls back on malformed JSON content", async () => {
  setEnv();
  const restore = stubFetch(async () => openRouterResponse("this is not json at all"));
  try {
    const polished = await polishEditsForVariant({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      edits: SAMPLE_EDITS
    });
    assert.equal(polished, SAMPLE_EDITS);
  } finally {
    restore();
    clearEnv();
  }
});

test("polishEditsForVariant strips ```json fences before parsing", async () => {
  setEnv();
  const fenced = "```json\n" + JSON.stringify({
    edits: [
      {
        score_key: "hook",
        issue: "Polished issue from fenced response.",
        suggested_edit: "Polished edit.",
        draft_revision: null
      }
    ]
  }) + "\n```";
  const restore = stubFetch(async () => openRouterResponse(fenced));
  try {
    const polished = await polishEditsForVariant({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      edits: SAMPLE_EDITS
    });
    assert.equal(polished[0].llm_polished, true);
    assert.equal(polished[0].issue, "Polished issue from fenced response.");
    assert.equal(polished[0].draft_revision, null);
  } finally {
    restore();
    clearEnv();
  }
});

test("polishEditsForVariant falls back on network error", async () => {
  setEnv();
  const restore = stubFetch(async () => {
    throw new Error("connection reset");
  });
  try {
    const polished = await polishEditsForVariant({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      edits: SAMPLE_EDITS
    });
    assert.equal(polished, SAMPLE_EDITS);
  } finally {
    restore();
    clearEnv();
  }
});

test("polishRecommendation overrides headline and reasons on success", async () => {
  setEnv();
  const variants = [
    {
      asset: { id: "a", name: "Variant A", extracted_text: "Ship me strong text." },
      analysis: { scores: { overall: 81 }, timeline: [{ second: 1, attention: 0.7 }] }
    },
    {
      asset: { id: "b", name: "Variant B", extracted_text: "Softer text" },
      analysis: { scores: { overall: 74 }, timeline: [{ second: 1, attention: 0.6 }] }
    }
  ];
  const recommendation = {
    winner_asset_id: "a",
    verdict: "ship",
    confidence: 0.78,
    headline: "Ship Variant A",
    reasons: ["templated reason"]
  };
  const restore = stubFetch(async () =>
    openRouterResponse(
      JSON.stringify({
        headline: "Ship Variant A on the strength of the first beat",
        reasons: [
          "Composite 81 vs 74; opening 3.0 seconds carry the gap.",
          "Hook lands 7 points above the runner-up."
        ]
      })
    )
  );
  try {
    const polished = await polishRecommendation({ variants, recommendation, brief: SAMPLE_BRIEF });
    assert.equal(polished.llm_polished, true);
    assert.equal(polished.verdict, "ship");
    assert.match(polished.headline, /strength of the first beat/);
    assert.equal(polished.reasons.length, 2);
  } finally {
    restore();
    clearEnv();
  }
});

test("generateChallengerText returns LLM text when enabled, fallback otherwise", async () => {
  setEnv();
  const restore = stubFetch(async () =>
    openRouterResponse(
      JSON.stringify({
        text: "3am tossing again? Calmcap puts you down in twelve minutes - no morning fog.",
        rationale: "Leads with a concrete pain moment in the first beat."
      })
    )
  );
  try {
    const polished = await generateChallengerText({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      focus: "hook",
      fallback: "templated fallback"
    });
    assert.match(polished, /twelve minutes/);
  } finally {
    restore();
    clearEnv();
  }

  // With LLM off, the fallback string passes through unchanged.
  clearEnv();
  const passthrough = await generateChallengerText({
    asset: SAMPLE_ASSET,
    brief: SAMPLE_BRIEF,
    focus: "hook",
    fallback: "templated fallback"
  });
  assert.equal(passthrough, "templated fallback");
});

test("checkCompliance returns structured report from LLM", async () => {
  setEnv();
  const restore = stubFetch(async () =>
    openRouterResponse(
      JSON.stringify({
        required_claims: [
          { claim: "clinically tested", present: false, evidence: null }
        ],
        forbidden_terms: [
          { term: "miracle", present: true, evidence: "miracle drops" }
        ]
      })
    )
  );
  try {
    const report = await checkCompliance({
      text: "Calmcap is the miracle drops for your nights.",
      brief: SAMPLE_BRIEF
    });
    assert.deepEqual(report.missing_required, ["clinically tested"]);
    assert.equal(report.forbidden_hits.length, 1);
    assert.equal(report.forbidden_hits[0].term, "miracle");
    assert.equal(report.forbidden_hits[0].evidence, "miracle drops");
  } finally {
    restore();
    clearEnv();
  }
});

test("checkCompliance returns null when LLM disabled or brief empty", async () => {
  clearEnv();
  const offReport = await checkCompliance({ text: "anything", brief: SAMPLE_BRIEF });
  assert.equal(offReport, null);

  setEnv();
  const restore = stubFetch(async () => {
    throw new Error("should not be called");
  });
  try {
    const emptyReport = await checkCompliance({
      text: "anything",
      brief: { required_claims: [], forbidden_terms: [] }
    });
    assert.equal(emptyReport, null);
  } finally {
    restore();
    clearEnv();
  }
});

test("copyLlmStatus reports the active model", () => {
  setEnv({ STIMLI_LLM_MODEL: "google/gemini-2.5-flash" });
  const status = copyLlmStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.model, "google/gemini-2.5-flash");
  clearEnv();
  assert.equal(copyLlmStatus().enabled, false);
});
