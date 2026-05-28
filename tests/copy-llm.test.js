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

test("checkCompliance treats string-encoded booleans correctly", async () => {
  // Cheap models routinely return JSON-stringified booleans. "false" must
  // resolve to NOT present (no false forbidden hits), "true" must resolve to
  // present.
  setEnv();
  const restore = stubFetch(async () =>
    openRouterResponse(
      JSON.stringify({
        required_claims: [{ claim: "clinically tested", present: "false", evidence: null }],
        forbidden_terms: [
          { term: "miracle", present: "false", evidence: null },
          { term: "guaranteed", present: "true", evidence: "guaranteed sleep" }
        ]
      })
    )
  );
  try {
    const report = await checkCompliance({
      text: "Calmcap promises guaranteed sleep with no caveats.",
      brief: { required_claims: ["clinically tested"], forbidden_terms: ["miracle", "guaranteed"] }
    });
    assert.deepEqual(report.missing_required, ["clinically tested"]);
    assert.equal(report.forbidden_hits.length, 1);
    assert.equal(report.forbidden_hits[0].term, "guaranteed");
  } finally {
    restore();
    clearEnv();
  }
});

test("generateChallengerText falls back when LLM returns a forbidden term", async () => {
  setEnv();
  const restore = stubFetch(async () =>
    openRouterResponse(
      JSON.stringify({
        text: "Calmcap is the miracle cure for thirty-something insomniacs - try it today.",
        rationale: "Leads with the magic word."
      })
    )
  );
  try {
    const result = await generateChallengerText({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      focus: "hook",
      fallback: "templated fallback"
    });
    // SAMPLE_BRIEF.forbidden_terms includes "miracle"; the LLM output uses it
    // so we MUST drop to the deterministic fallback rather than persist a
    // brand-safety violation as a new asset.
    assert.equal(result, "templated fallback");
  } finally {
    restore();
    clearEnv();
  }
});

test("callOpenRouter retries without response_format on 4xx", async () => {
  setEnv();
  let calls = 0;
  let firstBody = null;
  let secondBody = null;
  const restore = stubFetch(async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (calls === 1) {
      firstBody = body;
      return new Response("response_format not supported", { status: 400 });
    }
    secondBody = body;
    return openRouterResponse(
      JSON.stringify({
        edits: [
          {
            score_key: "hook",
            issue: "Polished issue after retry.",
            suggested_edit: "Polished edit after retry.",
            draft_revision: null
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
    assert.equal(calls, 2, "second attempt should fire without response_format");
    assert.equal(firstBody.response_format?.type, "json_object");
    assert.equal(secondBody.response_format, undefined);
    assert.equal(polished[0].llm_polished, true);
    assert.match(polished[0].issue, /after retry/);
  } finally {
    restore();
    clearEnv();
  }
});

test("STIMLI_LLM_TIMEOUT_MS falls back to default when malformed", async () => {
  // "8s" coerces to NaN. setTimeout(fn, NaN) would fire immediately and abort
  // every call, silently disabling polish. The parser must treat any
  // non-finite or non-positive value as default-timeout instead.
  setEnv({ STIMLI_LLM_TIMEOUT_MS: "8s" });
  const restore = stubFetch(async () =>
    openRouterResponse(
      JSON.stringify({
        edits: [
          {
            score_key: "hook",
            issue: "Polished issue.",
            suggested_edit: "Polished edit.",
            draft_revision: null
          }
        ]
      })
    )
  );
  try {
    const polished = await polishEditsForVariant({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      edits: SAMPLE_EDITS
    });
    assert.equal(polished[0].llm_polished, true);
  } finally {
    restore();
    clearEnv();
  }
});

test("polishEditsForVariant wraps user payload in <input> for anti-injection", async () => {
  setEnv();
  let capturedUserMsg = null;
  let capturedSystem = null;
  const restore = stubFetch(async (_url, options) => {
    const body = JSON.parse(options.body);
    capturedSystem = body.messages?.[0]?.content || "";
    capturedUserMsg = body.messages?.[1]?.content || "";
    return openRouterResponse(JSON.stringify({ edits: [] }));
  });
  try {
    await polishEditsForVariant({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      edits: SAMPLE_EDITS
    });
    assert.match(capturedUserMsg, /^<input>\n/);
    assert.match(capturedUserMsg, /\n<\/input>/);
    // System prompt must tell the model the input block is data, not instructions.
    assert.match(capturedSystem, /<input>/);
    assert.match(capturedSystem, /untrusted data/i);
  } finally {
    restore();
    clearEnv();
  }
});

test("callOpenRouter does NOT retry on 401/403/429", async () => {
  // Old behavior retried on every 4xx — amplified rate-limit pressure and
  // doubled auth-failure noise. New gating only retries on 400/422, where
  // response_format incompatibility is the plausible cause.
  setEnv();
  const seenStatuses = [];
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const restore = stubFetch(async () => {
      calls += 1;
      return new Response("backoff", { status });
    });
    try {
      await polishEditsForVariant({
        asset: SAMPLE_ASSET,
        brief: SAMPLE_BRIEF,
        edits: SAMPLE_EDITS
      });
      seenStatuses.push({ status, calls });
    } finally {
      restore();
    }
  }
  clearEnv();
  for (const observed of seenStatuses) {
    assert.equal(observed.calls, 1, `status ${observed.status} should NOT retry`);
  }
});

test("generateChallengerText uses word-boundary matching for forbidden terms", async () => {
  // Substring match would falsely reject "secure" when the brief forbids
  // "cure". The polished output should survive because "cure" is not a
  // standalone word in the text.
  setEnv();
  const restore = stubFetch(async () =>
    openRouterResponse(
      JSON.stringify({
        text: "Feel secure with overnight delivery and a clear path forward.",
        rationale: "Hook leads with reassurance."
      })
    )
  );
  try {
    const result = await generateChallengerText({
      asset: SAMPLE_ASSET,
      brief: { ...SAMPLE_BRIEF, forbidden_terms: ["cure"] },
      focus: "hook",
      fallback: "templated fallback"
    });
    assert.match(result, /Feel secure/);
  } finally {
    restore();
    clearEnv();
  }
});

test("generateChallengerText still rejects whole-word forbidden terms", async () => {
  setEnv();
  const restore = stubFetch(async () =>
    openRouterResponse(
      JSON.stringify({
        text: "Calmcap is the cure for thirty-something insomniacs.",
        rationale: "Whole-word forbidden term present."
      })
    )
  );
  try {
    const result = await generateChallengerText({
      asset: SAMPLE_ASSET,
      brief: { ...SAMPLE_BRIEF, forbidden_terms: ["cure"] },
      focus: "hook",
      fallback: "templated fallback"
    });
    assert.equal(result, "templated fallback");
  } finally {
    restore();
    clearEnv();
  }
});

test("truncateWords applies a char-cap fallback for CJK / whitespace-less scripts", async () => {
  // A model that returns a 400-char CJK headline has words.length=1 under a
  // /\s+/ split; the char-cap fallback should still cap the output.
  setEnv();
  const longHeadline = "日本語".repeat(120); // 360 chars, no whitespace
  const restore = stubFetch(async () =>
    openRouterResponse(
      JSON.stringify({
        headline: longHeadline,
        reasons: ["Composite leads runner-up by the expected margin."]
      })
    )
  );
  try {
    const polished = await polishRecommendation({
      variants: [
        { asset: { id: "a", name: "A", extracted_text: "Strong" }, analysis: { scores: { overall: 80 }, timeline: [] } },
        { asset: { id: "b", name: "B", extracted_text: "Weak" }, analysis: { scores: { overall: 70 }, timeline: [] } }
      ],
      recommendation: { winner_asset_id: "a", verdict: "ship", confidence: 0.8, headline: "Ship A", reasons: ["templated"] },
      brief: SAMPLE_BRIEF
    });
    // 14 * 12 = 168 chars + ellipsis. Result should be much shorter than 360.
    assert.ok(polished.headline.length < 180, `headline length ${polished.headline.length} exceeded char cap`);
  } finally {
    restore();
    clearEnv();
  }
});

test("retry budget is shared via deadline across response_format fallback", async () => {
  // The retry inherits the original deadline rather than getting a fresh
  // timeoutMs, so total wall clock stays bounded by the original budget.
  setEnv({ STIMLI_LLM_TIMEOUT_MS: "5000" });
  let calls = 0;
  const restore = stubFetch(async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (body.response_format) {
      return new Response("response_format not supported", { status: 400 });
    }
    return openRouterResponse(
      JSON.stringify({
        edits: [
          {
            score_key: "hook",
            issue: "Polished issue after retry.",
            suggested_edit: "Polished edit after retry.",
            draft_revision: null
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
    assert.equal(calls, 2, "should retry once without response_format");
    assert.equal(polished[0].llm_polished, true);
  } finally {
    restore();
    clearEnv();
  }
});

test("retry is skipped when remaining budget is too small", async () => {
  // MIN_RETRY_BUDGET_MS guards against firing a retry that immediately aborts
  // — e.g., when the configured timeout is shorter than the budget guard
  // itself. The first attempt's 400 should fall straight through to
  // template fallback rather than trying a doomed retry.
  setEnv({ STIMLI_LLM_TIMEOUT_MS: "100" });
  let calls = 0;
  const restore = stubFetch(async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (body.response_format) {
      return new Response("response_format not supported", { status: 400 });
    }
    return openRouterResponse(JSON.stringify({ edits: [] }));
  });
  try {
    const polished = await polishEditsForVariant({
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      edits: SAMPLE_EDITS
    });
    assert.equal(calls, 1, "should NOT retry when budget too small");
    assert.equal(polished, SAMPLE_EDITS);
  } finally {
    restore();
    clearEnv();
  }
});

test("env passed explicitly bypasses module-state configureCopyLlm", async () => {
  // The race fix: when env is passed explicitly to a polish call, it must NOT
  // read the module-level _env (which a concurrent request could overwrite).
  configureCopyLlm({}); // _env empty
  const restore = stubFetch(async () =>
    openRouterResponse(
      JSON.stringify({
        edits: [
          {
            score_key: "hook",
            issue: "Polished via explicit env.",
            suggested_edit: "Polished edit.",
            draft_revision: null
          }
        ]
      })
    )
  );
  try {
    const polished = await polishEditsForVariant({
      env: { OPENROUTER_API_KEY: "explicit-key", STIMLI_LLM_TIMEOUT_MS: "5000" },
      asset: SAMPLE_ASSET,
      brief: SAMPLE_BRIEF,
      edits: SAMPLE_EDITS
    });
    assert.equal(polished[0].llm_polished, true);
    assert.match(polished[0].issue, /via explicit env/);
  } finally {
    restore();
  }
});
