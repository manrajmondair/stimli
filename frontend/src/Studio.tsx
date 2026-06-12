import { useEffect, useMemo, useRef, useState } from "react";
import { createBriefComparisonForProject, createTextAsset, listBrandProfiles, previewDraft, StimliApiError } from "./api";
import type { CreativeBrief, DraftPreview } from "./types";
import { BrainBlob, Sparkle } from "./art";
import { BriefTermChips } from "./briefChips";

// Copy Studio: write ad copy WITH the engine instead of judging it after the
// fact. The draft is scored through the same deterministic engine that powers
// comparisons (POST /analyze/preview — no persistence, no remote brain, no
// LLM), debounced as you type, with named signal chips explaining why each
// dimension sits where it does, live brief linting, an optional ladder of
// deterministic rewrites, and one-click save into the compare flow.

const DEBOUNCE_MS = 600;
const DRAFT_HANDOFF_KEY = "stimli.studio_draft";
// How long the live loop stays paused after the preview meter returns 429 —
// re-issuing on every pause would just burn doomed requests.
const RATE_LIMIT_COOLDOWN_MS = 60_000;

function studioStateKey(workspaceKey: string | null | undefined) {
  return `stimli.studio_state:${workspaceKey || "anonymous"}`;
}

export type StudioHandoff = {
  text: string;
  baseline_overall?: number | null;
  baseline_label?: string | null;
  // The asset this draft revises — carried through save so the server can
  // record verified lineage and the rematch can pit revision against source.
  source_asset_id?: string | null;
  brief?: Partial<CreativeBrief>;
};

// Distinct from the studio keys: a comparison id for the Workbench to open on
// mount (written by "Run the rematch").
const WORKBENCH_OPEN_KEY = "stimli.workbench_open";

export function writeWorkbenchOpenHandoff(comparisonId: string) {
  try {
    window.sessionStorage.setItem(WORKBENCH_OPEN_KEY, comparisonId);
  } catch {
    /* storage unavailable — the workbench just opens normally */
  }
}

export function readWorkbenchOpenHandoff(): string | null {
  try {
    const raw = window.sessionStorage.getItem(WORKBENCH_OPEN_KEY);
    if (raw) window.sessionStorage.removeItem(WORKBENCH_OPEN_KEY);
    return raw || null;
  } catch {
    return null;
  }
}

export function writeStudioHandoff(payload: StudioHandoff) {
  try {
    window.sessionStorage.setItem(DRAFT_HANDOFF_KEY, JSON.stringify(payload));
  } catch {
    /* storage can be unavailable; the studio just opens empty */
  }
}

function readStudioHandoff(): StudioHandoff | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_HANDOFF_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(DRAFT_HANDOFF_KEY);
    const parsed = JSON.parse(raw) as StudioHandoff;
    return parsed && typeof parsed.text === "string" ? parsed : null;
  } catch {
    return null;
  }
}

const EMPTY_BRIEF: CreativeBrief = {
  brand_name: "",
  audience: "",
  product_category: "",
  primary_offer: "",
  required_claims: [],
  forbidden_terms: []
};

const DIMENSIONS: Array<{ key: keyof DraftPreview["scores"]; label: string; lowerIsBetter?: boolean }> = [
  { key: "hook", label: "Hook" },
  { key: "clarity", label: "Clarity" },
  { key: "cta", label: "CTA" },
  { key: "brand_cue", label: "Brand cue" },
  { key: "pacing", label: "Pacing" },
  { key: "offer_strength", label: "Offer" },
  { key: "audience_fit", label: "Audience" },
  { key: "neural_attention", label: "Attention" },
  { key: "memory", label: "Memory" },
  { key: "cognitive_load", label: "Load", lowerIsBetter: true }
];

type StudioSavedState = StudioHandoff & { savedAt?: number };

function readStudioSavedState(workspaceKey: string | undefined): StudioSavedState | null {
  try {
    const raw = window.sessionStorage.getItem(studioStateKey(workspaceKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StudioSavedState;
    return parsed && typeof parsed.text === "string" ? parsed : null;
  } catch {
    return null;
  }
}

type SaveReceipt = {
  assetId: string;
  name: string;
  lift: number | null;
  sourceLabel: string | null;
};

export function StudioView({
  workspaceKey = "anonymous",
  onOpenWorkbench
}: {
  workspaceKey?: string;
  onOpenWorkbench?: () => void;
}) {
  // A fresh handoff (from "Open in Studio") wins; otherwise rehydrate the
  // last working state so navigating to another view and back doesn't destroy
  // the draft — Studio unmounts on every view switch.
  const initial = useMemo<StudioSavedState | null>(
    () => readStudioHandoff() || readStudioSavedState(workspaceKey),
    [workspaceKey]
  );
  const [text, setText] = useState(initial?.text || "");
  const [brief, setBrief] = useState<CreativeBrief>({ ...EMPTY_BRIEF, ...(initial?.brief || {}) });
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [ladder, setLadder] = useState<DraftPreview["ladder"] | null>(null);
  const [ladderBusy, setLadderBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SaveReceipt | null>(null);
  const [rematchBusy, setRematchBusy] = useState(false);
  const baseline = initial?.baseline_overall ?? null;
  const baselineLabel = initial?.baseline_label ?? null;
  const sourceAssetId = initial?.source_asset_id ?? null;
  // Monotonic token: only the latest in-flight preview (or ladder) may write state.
  const previewTokenRef = useRef(0);
  // Set after a 429: the live loop skips scheduling until this timestamp.
  const pausedUntilRef = useRef(0);

  // Persist the working state so the draft survives navigation.
  useEffect(() => {
    try {
      if (!text.trim()) {
        window.sessionStorage.removeItem(studioStateKey(workspaceKey));
      } else {
        // source_asset_id MUST persist with the rest: dropping it here would
        // keep the baseline chip after navigate-away-and-back while silently
        // saving without lineage — looks right, records nothing.
        window.sessionStorage.setItem(
          studioStateKey(workspaceKey),
          JSON.stringify({
            text,
            brief,
            baseline_overall: baseline,
            baseline_label: baselineLabel,
            source_asset_id: sourceAssetId
          })
        );
      }
    } catch {
      /* storage unavailable — the draft just won't survive navigation */
    }
  }, [text, brief, baseline, baselineLabel, sourceAssetId, workspaceKey]);

  // Pre-fill the brief from the default brand profile (same convention the
  // Workbench uses) when the handoff/rehydration didn't bring one. Applied via
  // the functional form ONLY while the brief is still pristine, so a slow
  // profile fetch can't clobber fields the user already typed.
  useEffect(() => {
    if (initial?.brief) return;
    const key =
      workspaceKey && workspaceKey !== "anonymous"
        ? `stimli.default_brand_profile:${workspaceKey}`
        : "stimli.default_brand_profile";
    let defaultBrandId: string | null = null;
    try {
      defaultBrandId = window.localStorage.getItem(key);
    } catch {
      defaultBrandId = null;
    }
    if (!defaultBrandId) return;
    let cancelled = false;
    listBrandProfiles()
      .then((profiles) => {
        if (cancelled) return;
        const match = profiles.find((profile) => profile.id === defaultBrandId);
        if (!match) return;
        setBrief((current) => {
          const pristine =
            !current.brand_name &&
            !current.audience &&
            !current.product_category &&
            !current.primary_offer &&
            current.required_claims.length === 0 &&
            current.forbidden_terms.length === 0;
          if (!pristine) return current;
          return {
            brand_name: match.brief.brand_name || "",
            audience: match.brief.audience || "",
            product_category: match.brief.product_category || "",
            primary_offer: match.brief.primary_offer || "",
            required_claims: [...(match.brief.required_claims || [])],
            forbidden_terms: [...(match.brief.forbidden_terms || [])]
          };
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initial, workspaceKey]);

  // The live loop: debounce the draft + brief into a preview call. The token
  // bumps on EVERY change — including clearing the editor — so an in-flight
  // response for retired text can never repopulate the screen. The ladder is
  // invalidated by any change (it was computed against the previous text), and
  // a stale "Saved" banner stops asserting the rewritten draft is saved.
  useEffect(() => {
    const token = ++previewTokenRef.current;
    setLadder(null);
    setSavedName(null);
    setReceipt(null);
    if (!text.trim()) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (Date.now() < pausedUntilRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      setPreviewing(true);
      previewDraft({ text, brief })
        .then((result) => {
          if (previewTokenRef.current !== token) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((err) => {
          if (previewTokenRef.current !== token) return;
          if (err instanceof StimliApiError && err.status === 429) {
            // The preview meter is empty — pause the loop instead of firing a
            // doomed request on every pause in typing.
            pausedUntilRef.current = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            setPreviewError("Live scoring is taking a breather (rate limit) — it resumes in about a minute.");
            return;
          }
          setPreviewError(err instanceof Error ? err.message : "Could not score the draft.");
        })
        .finally(() => {
          if (previewTokenRef.current === token) setPreviewing(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, brief]);

  async function runLadder() {
    if (!text.trim() || ladderBusy) return;
    // Capture the token so a ladder computed for retired text is discarded —
    // the live-loop effect bumps it on any draft/brief change.
    const token = previewTokenRef.current;
    setLadderBusy(true);
    try {
      const result = await previewDraft({ text, brief, include_ladder: true });
      if (previewTokenRef.current !== token) return;
      setLadder(result.ladder || []);
    } catch (err) {
      if (previewTokenRef.current === token) {
        setPreviewError(err instanceof Error ? err.message : "Could not generate rewrites.");
      }
    } finally {
      setLadderBusy(false);
    }
  }

  async function saveAsVariant() {
    if (!text.trim() || saving) return;
    setSaving(true);
    setSavedName(null);
    setReceipt(null);
    try {
      const now = new Date();
      const name = `Studio draft · ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
      const asset = await createTextAsset({
        assetType: "script",
        name,
        text: text.trim(),
        revisedFrom: sourceAssetId,
        brief
      });
      // The lift on the receipt is the SERVER's number — recomputed for both
      // sides through the same engine at save time, not the (possibly stale,
      // possibly cross-engine) live pill.
      const serverLift = Number(asset.metadata?.revision_lift);
      setReceipt({
        assetId: asset.id,
        name: asset.name,
        lift: Number.isFinite(serverLift) ? serverLift : null,
        sourceLabel: asset.metadata?.revised_from ? baselineLabel : null
      });
      setSavedName(asset.name);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Could not save the draft.");
    } finally {
      setSaving(false);
    }
  }

  // The full loop closer: pit the saved revision against its source in a real
  // comparison and open the result in the Workbench.
  async function runRematch() {
    if (!receipt || !sourceAssetId || rematchBusy) return;
    setRematchBusy(true);
    try {
      const comparison = await createBriefComparisonForProject(
        [sourceAssetId, receipt.assetId],
        "Rematch: Studio revision vs original.",
        { ...EMPTY_BRIEF, ...brief },
        null
      );
      writeWorkbenchOpenHandoff(comparison.id);
      if (onOpenWorkbench) {
        onOpenWorkbench();
      } else {
        setPreviewError(null);
        setSavedName(`Rematch created — open the Workbench to see the result.`);
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Could not run the rematch.");
    } finally {
      setRematchBusy(false);
    }
  }

  const overall = preview?.scores.overall ?? null;
  const shipThreshold = preview?.ship_threshold ?? 68;
  const shipReady = overall !== null && overall >= shipThreshold;
  const delta = baseline !== null && overall !== null ? Math.round((overall - baseline) * 10) / 10 : null;

  return (
    <>
      <header className="wb-top">
        <div className="wb-top-left">
          <h1 className="wb-h1">
            The <span className="hl-butter">studio</span>
          </h1>
          <span className="wb-crumbs">
            <span className="pill">
              <span className="dot" style={{ background: "var(--butter)" }} />
              write with the brain
            </span>
            {baselineLabel ? (
              <span className="pill" title="Opened from a comparison result">
                <span className="dot" style={{ background: "var(--tomato)" }} />
                {`baseline: ${baselineLabel}`}
              </span>
            ) : null}
          </span>
        </div>
        <div className="wb-top-right">
          <button className="btn cream" onClick={runLadder} disabled={!text.trim() || ladderBusy}>
            {ladderBusy ? "Sparring…" : "Optimize ✺"}
          </button>
          <button className="btn primary" onClick={saveAsVariant} disabled={!text.trim() || saving}>
            {saving ? "Saving…" : "Save as variant"}
          </button>
        </div>
      </header>
      {previewError ? <div className="banner error">{previewError}</div> : null}
      {receipt && receipt.lift !== null ? (
        <div className="banner" role="status" data-testid="lift-receipt" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span>
            {`Saved "${receipt.name}" · `}
            <strong style={{ color: receipt.lift >= 0 ? "var(--pistachio-ink)" : "var(--tomato-ink)" }}>
              {receipt.lift >= 0 ? "+" : ""}
              {receipt.lift} measured
            </strong>
            {receipt.sourceLabel ? ` vs ${receipt.sourceLabel}` : ""} · same engine, both sides
          </span>
          <button className="btn primary small" onClick={runRematch} disabled={rematchBusy}>
            {rematchBusy ? "Setting up…" : "Run the rematch ⚡"}
          </button>
        </div>
      ) : savedName ? (
        <div className="banner" role="status">
          {`Saved "${savedName}" — it's in your Workbench variants, ready to compare.`}
        </div>
      ) : null}

      <div className="wb-grid wb-grid-sidebar">
        <section className="wb-col">
          <div className="panel-card">
            <div className="panel-head">
              <h3>Draft</h3>
              <span className="kicker">
                {previewing ? "scoring…" : preview ? "scored live" : "start typing"}
              </span>
            </div>
            <label className="field">
              <span className="sr-only">Ad copy draft</span>
              <textarea
                rows={12}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Write or paste ad copy. The brain scores every pause."
                aria-label="Ad copy draft"
                style={{ fontSize: 15, lineHeight: 1.6 }}
              />
            </label>
            <div className="panel-head" style={{ marginTop: 12 }}>
              <h3 style={{ fontSize: 14 }}>Brief contract</h3>
              <span className="kicker">linted live</span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <label className="field" style={{ flex: "1 1 140px" }}>
                <span>Brand</span>
                <input value={brief.brand_name} onChange={(e) => setBrief({ ...brief, brand_name: e.target.value })} />
              </label>
              <label className="field" style={{ flex: "1 1 140px" }}>
                <span>Offer</span>
                <input value={brief.primary_offer} onChange={(e) => setBrief({ ...brief, primary_offer: e.target.value })} />
              </label>
              <label className="field" style={{ flex: "1 1 180px" }}>
                <span>Audience</span>
                <input value={brief.audience} onChange={(e) => setBrief({ ...brief, audience: e.target.value })} />
              </label>
            </div>
            <BriefTermChips
              label="Required claims"
              terms={brief.required_claims}
              onChange={(next) => setBrief({ ...brief, required_claims: next })}
              addPlaceholder="+ claim"
            />
            <BriefTermChips
              label="Forbidden terms"
              terms={brief.forbidden_terms}
              onChange={(next) => setBrief({ ...brief, forbidden_terms: next })}
              addPlaceholder="+ forbid"
              accent="var(--tomato-ink)"
            />
            {preview && (preview.compliance.required_claims.length || preview.compliance.forbidden_terms.length) ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                {preview.compliance.required_claims.map((entry) => (
                  <span
                    key={`claim-${entry.claim}`}
                    className="pill"
                    style={{
                      borderColor: entry.present ? "var(--pistachio-ink)" : "var(--ink-faint)",
                      color: entry.present ? "var(--pistachio-ink)" : "var(--ink-soft)"
                    }}
                  >
                    <span aria-hidden="true">{entry.present ? "✓" : "○"} </span>
                    {entry.claim}
                    <span className="sr-only">{entry.present ? " — claim met" : " — claim missing"}</span>
                  </span>
                ))}
                {preview.compliance.forbidden_terms.map((entry) =>
                  entry.present ? (
                    <span
                      key={`forbid-${entry.term}`}
                      className="pill"
                      style={{ borderColor: "var(--tomato-ink)", color: "var(--tomato-ink)" }}
                    >
                      ✕ forbidden: {entry.term}
                    </span>
                  ) : null
                )}
              </div>
            ) : null}
          </div>

          {ladder && ladder.length ? (
            <div className="panel-card">
              <div className="panel-head">
                <h3>Sparring partner</h3>
                <span className="kicker">deterministic rewrites, ranked by measured delta</span>
              </div>
              {ladder.map((rung) => (
                <div
                  key={rung.focus}
                  style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "10px 0", borderTop: "1px dashed var(--ink-faint)" }}
                >
                  <span className="pill" style={{ flexShrink: 0 }}>
                    {rung.focus}
                  </span>
                  <p style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 13.5 }}>{rung.text}</p>
                  <strong style={{ flexShrink: 0, color: rung.delta > 0 ? "var(--pistachio-ink)" : "var(--ink-soft)" }}>
                    {rung.delta > 0 ? "+" : ""}
                    {rung.delta}
                  </strong>
                  <button type="button" className="btn cream small" onClick={() => setText(rung.text)}>
                    Apply
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="wb-col">
          <div className="panel-card" data-testid="studio-scoreboard">
            <div className="panel-head">
              <h3>Live score</h3>
              <span className="kicker">{preview ? preview.provider : "—"}</span>
            </div>
            {!preview ? (
              <div className="empty">
                <BrainBlob size={96} color="var(--butter)" eyes mouth />
                <p className="hint">The scoreboard lights up as you write.</p>
              </div>
            ) : (
              <>
                {/* Announced politely: updates land at debounce cadence (600ms+),
                    so screen readers hear settled scores, not keystroke spam. */}
                <div aria-live="polite" aria-atomic="true" style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
                  <span className="sr-only">Overall score</span>
                  <strong style={{ fontSize: 44, lineHeight: 1 }}>{overall}</strong>
                  <span
                    className="pill"
                    style={{
                      borderColor: shipReady ? "var(--pistachio-ink)" : "var(--butter-ink, var(--ink))",
                      color: shipReady ? "var(--pistachio-ink)" : "var(--ink-soft)"
                    }}
                  >
                    {shipReady ? "ship-ready zone" : `${shipThreshold}+ is ship territory`}
                  </span>
                  {delta !== null ? (
                    <span
                      className="pill"
                      title={`vs baseline ${baseline}`}
                      style={{ borderColor: delta >= 0 ? "var(--pistachio-ink)" : "var(--tomato-ink)" }}
                    >
                      {delta >= 0 ? "+" : ""}
                      {delta} vs baseline
                    </span>
                  ) : null}
                  {previewing ? <Sparkle size={16} /> : null}
                </div>
                <div style={{ marginTop: 14 }}>
                  {DIMENSIONS.map(({ key, label, lowerIsBetter }) => {
                    const value = Math.round(Number(preview.scores[key]) || 0);
                    return (
                      <div key={String(key)} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                        <span style={{ width: 84, fontSize: 12, color: "var(--ink-soft)", flexShrink: 0 }}>
                          {label}
                          {lowerIsBetter ? "↓" : ""}
                        </span>
                        <div style={{ flex: 1, height: 9, background: "var(--paper-warm)", borderRadius: 6, border: "1px solid var(--ink-faint)" }}>
                          <div
                            style={{
                              width: `${Math.min(100, Math.max(3, value))}%`,
                              height: "100%",
                              borderRadius: 6,
                              background: lowerIsBetter
                                ? value > 62
                                  ? "var(--tomato)"
                                  : "var(--pistachio)"
                                : value >= 68
                                ? "var(--pistachio)"
                                : "var(--butter)"
                            }}
                          />
                        </div>
                        <strong style={{ width: 30, fontSize: 12, textAlign: "right" }}>{value}</strong>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
                  {preview.signals.map((signal) => (
                    <span
                      key={signal.signal}
                      className="pill"
                      style={{
                        opacity: signal.active ? 1 : 0.45,
                        borderColor: signal.active ? "var(--pistachio-ink)" : "var(--ink-faint)"
                      }}
                      title={signal.active ? "Active in this draft" : "Not detected in this draft"}
                    >
                      <span aria-hidden="true">{signal.active ? "●" : "○"} </span>
                      {signal.label}
                      <span className="sr-only">{signal.active ? " — present" : " — missing"}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          {preview && preview.suggestions.length ? (
            <div className="panel-card">
              <div className="panel-head">
                <h3>Next moves</h3>
                <span className="kicker">biggest lifts first</span>
              </div>
              {preview.suggestions.slice(0, 3).map((suggestion, index) => (
                <div key={index} style={{ padding: "8px 0", borderTop: index ? "1px dashed var(--ink-faint)" : "none" }}>
                  <strong style={{ fontSize: 13.5 }}>{suggestion.target}</strong>
                  <p style={{ margin: "4px 0 0", fontSize: 13 }}>{suggestion.suggested_edit}</p>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}
