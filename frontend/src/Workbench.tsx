import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  cancelComparison,
  createBriefComparisonForProject,
  createChallenger,
  createOutcome,
  createShareLink,
  createTextAsset,
  getComparison,
  getReportMarkdown,
  listAssets,
  listComparisons,
  seedDemo
} from "./api";
import type {
  Asset,
  AssetType,
  Comparison,
  CreativeBrief,
  ScoreBreakdown,
  TimelinePoint,
  VariantResult
} from "./types";
import { BrainBlob, BraidedTrail, Sparkle, StickerStar } from "./art";

type Step = "intake" | "inventory" | "analyzing" | "result";

type DraftState = {
  type: AssetType;
  name: string;
  text: string;
  url: string;
  durationSeconds: string;
  file: File | null;
};

const TYPE_LABEL: Record<AssetType, string> = {
  script: "Script",
  landing_page: "Landing page",
  image: "Static ad",
  audio: "Audio",
  video: "Video"
};

const COLOR_CYCLE = ["var(--tomato)", "var(--pistachio)", "var(--butter)", "var(--plum)"];

const FALLBACK_OBJECTIVE =
  "Pick the DTC creative most likely to earn attention, build memory, and convert.";

type Toast = { kind: "info" | "success" | "error"; message: string } | null;

type WorkbenchProps = {
  onRequireAuth: () => void;
  onSurfaceLibrary?: () => void;
  remoteProvider: string | null;
  briefDefaults?: Partial<CreativeBrief>;
};

export function Workbench({ onRequireAuth, remoteProvider, briefDefaults }: WorkbenchProps) {
  const [step, setStep] = useState<Step>("inventory");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [recentComparisons, setRecentComparisons] = useState<Comparison[]>([]);
  const [progress, setProgress] = useState(0);
  const [activeVariantIdx, setActiveVariantIdx] = useState(0);
  const [showAddForm, setShowAddForm] = useState(false);
  const [draft, setDraft] = useState<DraftState>({
    type: "script",
    name: "",
    text: "",
    url: "",
    durationSeconds: "",
    file: null
  });
  const [brief, setBrief] = useState<CreativeBrief>(() => ({
    brand_name: briefDefaults?.brand_name ?? "Lumina",
    audience: briefDefaults?.audience ?? "busy women with dry or sensitive skin",
    product_category: briefDefaults?.product_category ?? "skincare hydration system",
    primary_offer: briefDefaults?.primary_offer ?? "starter kit with free shipping",
    required_claims: briefDefaults?.required_claims ?? ["24-hr hydration", "dermatologist tested"],
    forbidden_terms: briefDefaults?.forbidden_terms ?? ["miracle cure", "guaranteed"]
  }));
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [newClaim, setNewClaim] = useState("");
  const [newForbidden, setNewForbidden] = useState("");
  const [pollNote, setPollNote] = useState<string | null>(null);
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const progressTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void refreshAssets();
    void refreshComparisons();
  }, []);

  useEffect(() => {
    return () => {
      if (progressTimerRef.current !== null) {
        window.clearInterval(progressTimerRef.current);
      }
    };
  }, []);

  async function refreshAssets() {
    try {
      const list = await listAssets();
      setAssets(list);
    } catch (err) {
      console.warn(err);
    }
  }

  async function refreshComparisons() {
    try {
      const list = await listComparisons();
      setRecentComparisons(list.slice(0, 5));
    } catch (err) {
      console.warn(err);
    }
  }

  function flash(toast: Toast) {
    setToast(toast);
    if (toast) {
      window.setTimeout(() => setToast(null), 4500);
    }
  }

  function toggleSelect(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      return [...current, id].slice(-4);
    });
  }

  function startProgressAnimation() {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
    }
    setProgress(2);
    let p = 2;
    // Pre-comparison animation: ramp toward ~30% while we wait for the initial POST
    // to return. Once we have real status from the backend we drive progress from
    // job state instead of the timer.
    progressTimerRef.current = window.setInterval(() => {
      p = Math.min(30, p + 1.5 + Math.random() * 1.5);
      setProgress(Math.round(p));
    }, 320);
  }

  function stopProgressAnimation() {
    if (progressTimerRef.current !== null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }

  function finishProgressAnimation() {
    stopProgressAnimation();
    setProgress(100);
  }

  async function handleSeed() {
    setBusy(true);
    try {
      const seeded = await seedDemo();
      setAssets((existing) => {
        const known = new Set(existing.map((asset) => asset.id));
        const fresh = seeded.filter((asset) => !known.has(asset.id));
        return [...fresh, ...existing];
      });
      setSelected(seeded.slice(0, 2).map((asset) => asset.id));
      setStep("inventory");
      flash({ kind: "success", message: "Demo set loaded — ready to compare." });
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Could not load demo." });
    } finally {
      setBusy(false);
    }
  }

  async function handleAddVariant() {
    if (!draft.name.trim()) {
      flash({ kind: "error", message: "Name your variant." });
      return;
    }
    const hasContent = draft.text.trim() || draft.url.trim() || draft.file;
    if (!hasContent) {
      flash({ kind: "error", message: "Paste text, a URL, or upload a file." });
      return;
    }
    setBusy(true);
    try {
      const duration = draft.durationSeconds ? Number(draft.durationSeconds) : undefined;
      if (draft.file) setUploadProgress(0);
      const asset = await createTextAsset({
        assetType: draft.type,
        name: draft.name.trim(),
        text: draft.text.trim(),
        url: draft.url.trim() || undefined,
        durationSeconds: Number.isFinite(duration) ? duration : undefined,
        file: draft.file,
        onUploadProgress: setUploadProgress
      });
      setAssets((current) => [asset, ...current]);
      setSelected((current) => [...new Set([...current, asset.id])].slice(-4));
      setDraft({ type: draft.type, name: "", text: "", url: "", durationSeconds: "", file: null });
      setShowAddForm(false);
      flash({ kind: "success", message: `${asset.name} added.` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not add variant.";
      if (/auth|login|session/i.test(message)) onRequireAuth();
      flash({ kind: "error", message });
    } finally {
      setUploadProgress(null);
      setBusy(false);
    }
  }

  async function handleCompare() {
    if (selected.length < 2) {
      flash({ kind: "error", message: "Pick at least two variants." });
      return;
    }
    setBusy(true);
    setComparison(null);
    setPollNote(null);
    setStep("analyzing");
    setPollStartedAt(Date.now());
    startProgressAnimation();
    try {
      const next = await createBriefComparisonForProject(selected, FALLBACK_OBJECTIVE, brief, null);
      setComparison(next);
      if (next.status === "processing") {
        applyJobProgress(next);
        await pollComparison(next.id);
      } else {
        finishProgressAnimation();
        setStep("result");
        setActiveVariantIdx(0);
        await refreshComparisons();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not run comparison.";
      finishProgressAnimation();
      if (/auth|login|session/i.test(message)) onRequireAuth();
      flash({ kind: "error", message });
      setStep("inventory");
    } finally {
      setBusy(false);
    }
  }

  function applyJobProgress(snapshot: Comparison) {
    // Stop the timer-based ramp once the backend gives us real status.
    stopProgressAnimation();
    const next = computeProgress(snapshot);
    setProgress((current) => Math.max(current, next));
  }

  async function pollComparison(comparisonId: string) {
    let consecutiveErrors = 0;
    const start = Date.now();
    // Keep polling for ~15 minutes. Modal video jobs can take a while; we'd rather
    // wait than time the user out at 5 minutes with no result.
    const MAX_MS = 15 * 60 * 1000;
    let attempt = 0;
    while (Date.now() - start < MAX_MS) {
      const wait = Math.min(2500 + attempt * 200, 6000);
      await delay(wait);
      attempt += 1;
      try {
        const fresh = await getComparison(comparisonId);
        consecutiveErrors = 0;
        setComparison(fresh);
        applyJobProgress(fresh);
        if (fresh.status === "complete") {
          finishProgressAnimation();
          setPollNote(null);
          setStep("result");
          setActiveVariantIdx(0);
          await refreshComparisons();
          return;
        }
        if (fresh.status === "failed") {
          finishProgressAnimation();
          setStep("inventory");
          const reason = fresh.recommendation?.reasons?.[0] || "Analysis failed.";
          flash({ kind: "error", message: reason });
          await refreshComparisons();
          return;
        }
        if (fresh.status === "cancelled") {
          finishProgressAnimation();
          setStep("inventory");
          flash({ kind: "info", message: "Analysis was cancelled." });
          await refreshComparisons();
          return;
        }
        // Still processing — surface waiting context after long stretches.
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        if (elapsedSec > 90) {
          setPollNote(
            `Still working. Hosted model jobs for video can take a few minutes. (${elapsedSec}s elapsed)`
          );
        }
      } catch (err) {
        consecutiveErrors += 1;
        const msg = err instanceof Error ? err.message : "Unknown error";
        setPollNote(
          consecutiveErrors > 2
            ? `Network is being flaky — retrying. (${msg})`
            : `Refreshing status… (${msg})`
        );
        if (consecutiveErrors > 8) {
          // After repeated failures, fall back rather than spin forever.
          finishProgressAnimation();
          setStep("inventory");
          flash({ kind: "error", message: `Could not refresh comparison: ${msg}` });
          return;
        }
      }
    }
    // Timed out client-side; the comparison may still finish on the backend, so
    // surface it in Recent decisions instead of erroring out the user.
    finishProgressAnimation();
    setStep("inventory");
    flash({
      kind: "info",
      message:
        "Still running on the backend — we moved it to Recent decisions. Re-open later to see the result."
    });
    await refreshComparisons();
  }

  async function handleCancel() {
    if (!comparison) return;
    try {
      const cancelled = await cancelComparison(comparison.id);
      setComparison(cancelled);
      finishProgressAnimation();
      setStep("inventory");
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Could not cancel." });
    }
  }

  async function handleShare() {
    if (!comparison) return;
    try {
      const link = await createShareLink(comparison.id);
      const url = link.url || `${window.location.origin}${link.path}`;
      await navigator.clipboard?.writeText(url).catch(() => null);
      flash({ kind: "success", message: "Share link copied to clipboard." });
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Could not share." });
    }
  }

  async function handleExport() {
    if (!comparison) return;
    try {
      const md = await getReportMarkdown(comparison.id);
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `stimli-report-${comparison.id.slice(0, 8)}.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      flash({ kind: "success", message: "Markdown report downloaded." });
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Could not export." });
    }
  }

  async function handleDraftChallenger() {
    if (!comparison || !comparison.recommendation.winner_asset_id) return;
    setBusy(true);
    try {
      const result = await createChallenger(comparison.id, {
        source_asset_id: comparison.recommendation.winner_asset_id,
        focus: "hook"
      });
      setAssets((current) => [result.asset, ...current]);
      setSelected((current) => [...new Set([...current, result.asset.id])].slice(-4));
      flash({ kind: "success", message: `Challenger "${result.asset.name}" drafted.` });
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Could not draft challenger." });
    } finally {
      setBusy(false);
    }
  }

  async function handleLogOutcome(assetId: string) {
    if (!comparison) return;
    const spend = window.prompt("Reported spend (USD)?", "1500");
    if (!spend) return;
    const revenue = window.prompt("Reported revenue (USD)?", "2400");
    if (!revenue) return;
    try {
      await createOutcome(comparison.id, {
        asset_id: assetId,
        spend: Number(spend) || 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        revenue: Number(revenue) || 0,
        notes: "Logged from workbench"
      });
      flash({ kind: "success", message: "Outcome logged." });
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Could not log outcome." });
    }
  }

  function reCompare() {
    setComparison(null);
    setStep("inventory");
    setProgress(0);
    setPollNote(null);
    setPollStartedAt(null);
  }

  function continueInBackground() {
    // Stop showing the analyzing view but keep the comparison id so the user
    // can pick it up from Recent decisions when ready.
    stopProgressAnimation();
    setStep("inventory");
    setPollNote(null);
    flash({
      kind: "info",
      message: "Comparison is still running. We'll surface it under Recent decisions when it lands."
    });
    void refreshComparisons();
  }

  async function openRecent(comparisonId: string) {
    setBusy(true);
    try {
      const fresh = await getComparison(comparisonId);
      setComparison(fresh);
      if (fresh.status === "complete") {
        setStep("result");
        setActiveVariantIdx(0);
        return;
      }
      if (fresh.status === "processing") {
        setPollStartedAt(Date.now());
        setStep("analyzing");
        startProgressAnimation();
        applyJobProgress(fresh);
        await pollComparison(fresh.id);
        return;
      }
      flash({
        kind: "info",
        message: `Comparison ${fresh.status}. Recreate from the inventory to retry.`
      });
    } catch (err) {
      flash({ kind: "error", message: err instanceof Error ? err.message : "Could not open comparison." });
    } finally {
      setBusy(false);
    }
  }

  const selectedAssets = useMemo(
    () => assets.filter((asset) => selected.includes(asset.id)),
    [assets, selected]
  );

  const ranked = useMemo(() => {
    if (!comparison) return [];
    return [...comparison.variants].sort((a, b) => a.rank - b.rank);
  }, [comparison]);

  const activeVariant = ranked[activeVariantIdx] ?? ranked[0];

  return (
    <>
      <header className="wb-top">
        <div className="wb-top-left">
          <h1 className="wb-h1">
            The <span className="hl-pist">workbench</span>
          </h1>
          <span className="wb-crumbs">
            <span className="pill">
              <span className="dot" style={{ background: "var(--tomato)" }} />
              Brief: {brief.brand_name}
            </span>
            <span className="pill">
              <span className="dot" style={{ background: "var(--pistachio)" }} />
              Audience: {brief.audience.split(",")[0].slice(0, 28)}
            </span>
            <span className="pill">
              <span className="dot" style={{ background: "var(--butter)" }} />
              Brain: {remoteProvider ?? "TRIBE v2"}
            </span>
          </span>
        </div>
        <div className="wb-top-right">
          <button className="btn cream" onClick={handleSeed} disabled={busy}>
            <Sparkle size={16} /> Demo set
          </button>
          {step === "analyzing" ? (
            <button className="btn ghost" onClick={handleCancel}>
              Cancel
            </button>
          ) : null}
          <button className="btn primary" onClick={handleCompare} disabled={selected.length < 2 || busy}>
            {step === "analyzing" ? "Growing trails…" : "Compare ✺"}
          </button>
        </div>
      </header>

      <div className="wb-grid">
        <IntakePanel
          showAddForm={showAddForm}
          setShowAddForm={setShowAddForm}
          draft={draft}
          setDraft={setDraft}
          onAdd={handleAddVariant}
          brief={brief}
          setBrief={setBrief}
          busy={busy}
          uploadProgress={uploadProgress}
          newClaim={newClaim}
          setNewClaim={setNewClaim}
          newForbidden={newForbidden}
          setNewForbidden={setNewForbidden}
        />
        <InventoryPanel
          assets={assets}
          selected={selected}
          toggleSelect={toggleSelect}
          onSeed={handleSeed}
          recents={recentComparisons}
          onOpenRecent={openRecent}
        />
        <ResultsColumn
          step={step}
          progress={progress}
          comparison={comparison}
          ranked={ranked}
          activeVariant={activeVariant}
          activeVariantIdx={activeVariantIdx}
          setActiveVariantIdx={setActiveVariantIdx}
          selectedAssets={selectedAssets}
          onSeed={handleSeed}
          onReCompare={reCompare}
          onShare={handleShare}
          onExport={handleExport}
          onDraftChallenger={handleDraftChallenger}
          onLogOutcome={handleLogOutcome}
          onCancel={handleCancel}
          onContinueInBackground={continueInBackground}
          pollNote={pollNote}
          pollStartedAt={pollStartedAt}
        />
      </div>

      {toast ? (
        <div className={`error-toast ${toast.kind === "error" ? "" : ""}`} style={toast.kind === "success" ? { background: "var(--pistachio-ink)" } : toast.kind === "info" ? { background: "var(--ink)" } : {}}>
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)}>×</button>
        </div>
      ) : null}
    </>
  );
}

function IntakePanel({
  showAddForm,
  setShowAddForm,
  draft,
  setDraft,
  onAdd,
  brief,
  setBrief,
  busy,
  uploadProgress,
  newClaim,
  setNewClaim,
  newForbidden,
  setNewForbidden
}: {
  showAddForm: boolean;
  setShowAddForm: (value: boolean) => void;
  draft: DraftState;
  setDraft: (value: DraftState) => void;
  onAdd: () => void;
  brief: CreativeBrief;
  setBrief: (value: CreativeBrief) => void;
  busy: boolean;
  uploadProgress: number | null;
  newClaim: string;
  setNewClaim: (value: string) => void;
  newForbidden: string;
  setNewForbidden: (value: string) => void;
}) {
  function update<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft({ ...draft, [key]: value });
  }
  return (
    <section className="wb-col wb-col-intake">
      <div className="panel-card">
        <div className="panel-head">
          <h3>Add a variant</h3>
          <span className="kicker">brief & inputs</span>
        </div>

        {!showAddForm ? (
          <div className="add-cta">
            <BrainBlob size={64} color="var(--pistachio)" rotation={-6} />
            <button className="btn cream wide" onClick={() => setShowAddForm(true)}>
              + New variant
            </button>
            <p className="hint">script · landing page · audio · video · static ad</p>
          </div>
        ) : (
          <div className="add-form">
            <label className="field">
              <span>Type</span>
              <div className="chip-row">
                {(Object.keys(TYPE_LABEL) as AssetType[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`chip ${draft.type === key ? "active" : ""}`}
                    onClick={() => update("type", key)}
                  >
                    {TYPE_LABEL[key]}
                  </button>
                ))}
              </div>
            </label>
            <label className="field">
              <span>Name</span>
              <input
                value={draft.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="Variant E · proof-first hook"
              />
            </label>
            <label className="field">
              <span>Creative text · transcript · notes</span>
              <textarea
                rows={5}
                value={draft.text}
                onChange={(e) => update("text", e.target.value)}
                placeholder="Paste the script, page copy, transcript, or describe the visual."
              />
            </label>
            {(draft.type === "landing_page" || draft.type === "image" || draft.type === "video" || draft.type === "audio") ? (
              <label className="field">
                <span>Source URL (optional)</span>
                <input
                  value={draft.url}
                  onChange={(e) => update("url", e.target.value)}
                  placeholder="https://yourbrand.com/landing"
                />
              </label>
            ) : null}
            {(draft.type === "image" || draft.type === "audio" || draft.type === "video") ? (
              <label className="field">
                <span>Upload file (optional)</span>
                <input
                  type="file"
                  onChange={(e) => update("file", e.target.files?.[0] ?? null)}
                  accept={draft.type === "image" ? "image/*" : draft.type === "audio" ? "audio/*" : "video/*"}
                />
                {uploadProgress !== null ? (
                  <span className="upload-progress">Uploading… {uploadProgress}%</span>
                ) : null}
              </label>
            ) : null}
            {(draft.type === "audio" || draft.type === "video") ? (
              <label className="field">
                <span>Duration (s)</span>
                <input
                  value={draft.durationSeconds}
                  onChange={(e) => update("durationSeconds", e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="30"
                />
              </label>
            ) : null}
            <div className="form-actions">
              <button className="btn ghost" onClick={() => setShowAddForm(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={onAdd} disabled={busy}>
                Add to comparison
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="panel-card brief-card">
        <div className="panel-head">
          <h3>Decision brief</h3>
          <span className="kicker">guides every score</span>
        </div>
        <div className="brief-grid">
          <label className="brief-row">
            <span>Brand</span>
            <input value={brief.brand_name} onChange={(e) => setBrief({ ...brief, brand_name: e.target.value })} />
          </label>
          <label className="brief-row">
            <span>Audience</span>
            <input value={brief.audience} onChange={(e) => setBrief({ ...brief, audience: e.target.value })} />
          </label>
          <label className="brief-row">
            <span>Category</span>
            <input
              value={brief.product_category}
              onChange={(e) => setBrief({ ...brief, product_category: e.target.value })}
            />
          </label>
          <label className="brief-row">
            <span>Offer</span>
            <input value={brief.primary_offer} onChange={(e) => setBrief({ ...brief, primary_offer: e.target.value })} />
          </label>
        </div>
        <div className="brief-rules">
          <strong>Required claims</strong>
          {brief.required_claims.map((claim) => (
            <span key={claim} className="claim-pill">
              {claim}
              <em onClick={() => setBrief({ ...brief, required_claims: brief.required_claims.filter((x) => x !== claim) })}>
                ×
              </em>
            </span>
          ))}
          <ClaimAdder
            value={newClaim}
            setValue={setNewClaim}
            onAdd={() => {
              if (!newClaim.trim()) return;
              setBrief({ ...brief, required_claims: [...brief.required_claims, newClaim.trim()] });
              setNewClaim("");
            }}
          />
          <strong style={{ marginTop: 10 }}>Forbidden terms</strong>
          {brief.forbidden_terms.map((term) => (
            <span key={term} className="claim-pill forbid">
              {term}
              <em onClick={() => setBrief({ ...brief, forbidden_terms: brief.forbidden_terms.filter((x) => x !== term) })}>
                ×
              </em>
            </span>
          ))}
          <ClaimAdder
            value={newForbidden}
            setValue={setNewForbidden}
            forbid
            onAdd={() => {
              if (!newForbidden.trim()) return;
              setBrief({ ...brief, forbidden_terms: [...brief.forbidden_terms, newForbidden.trim()] });
              setNewForbidden("");
            }}
          />
        </div>
      </div>
    </section>
  );
}

function ClaimAdder({
  value,
  setValue,
  onAdd,
  forbid = false
}: {
  value: string;
  setValue: (value: string) => void;
  onAdd: () => void;
  forbid?: boolean;
}) {
  return (
    <span className={`claim-pill add${forbid ? " forbid" : ""}`}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onAdd();
          }
        }}
        placeholder={forbid ? "+ forbid" : "+ add"}
        style={{ background: "transparent", border: 0, outline: "none", font: "inherit", color: "inherit", width: 92 }}
      />
    </span>
  );
}

function InventoryPanel({
  assets,
  selected,
  toggleSelect,
  onSeed,
  recents,
  onOpenRecent
}: {
  assets: Asset[];
  selected: string[];
  toggleSelect: (id: string) => void;
  onSeed: () => void;
  recents: Comparison[];
  onOpenRecent: (comparisonId: string) => void;
}) {
  return (
    <section className="wb-col wb-col-inventory">
      <div className="panel-card">
        <div className="panel-head spread">
          <div>
            <h3>Variants</h3>
            <span className="kicker">{selected.length} selected</span>
          </div>
          <span
            className="pill"
            style={{ borderColor: "var(--tomato)", color: "var(--tomato-ink)" }}
          >
            <span className="dot" style={{ background: "var(--tomato)" }} />
            {selected.length >= 2 ? "ready" : "select two"}
          </span>
        </div>

        {assets.length === 0 ? (
          <div className="empty">
            <BrainBlob size={120} color="var(--pistachio)" eyes mouth />
            <h4>Empty workbench</h4>
            <p>Add a variant or load the demo set to begin.</p>
            <button className="btn primary" onClick={onSeed}>
              Load demo set
            </button>
          </div>
        ) : (
          <div className="variant-list">
            {assets.map((asset, i) => {
              const isSel = selected.includes(asset.id);
              const color = COLOR_CYCLE[i % COLOR_CYCLE.length];
              const tilt = [0.8, -0.6, 0.5, -0.4][i % 4];
              return (
                <button
                  key={asset.id}
                  className={`variant-row ${isSel ? "selected" : ""}`}
                  onClick={() => toggleSelect(asset.id)}
                  style={{
                    ["--accent" as string]: color,
                    transform: `rotate(${tilt}deg)`
                  } as CSSProperties}
                >
                  <span className="check-blob">
                    <BrainBlob size={42} color={color} />
                    {isSel && <span className="check-mark">✓</span>}
                  </span>
                  <span className="variant-body">
                    <span className="variant-meta">
                      <span className="type-tag">{TYPE_LABEL[asset.type]}</span>
                      <span className="dot-sep">·</span>
                      <span>{asset.duration_seconds ? `${Math.round(asset.duration_seconds)}s` : "—"}</span>
                    </span>
                    <strong>{asset.name}</strong>
                    <p>
                      {(asset.extracted_text || "").slice(0, 96)}
                      {asset.extracted_text && asset.extracted_text.length > 96 ? "…" : ""}
                    </p>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel-card recents">
        <div className="panel-head">
          <h3>Recent decisions</h3>
          <span className="kicker">last {recents.length || 0}</span>
        </div>
        {recents.length === 0 ? (
          <p className="hint">No decisions yet. Run a comparison to start a history.</p>
        ) : (
          recents.map((recent) => {
            const winner = recent.variants.find((v) => v.asset.id === recent.recommendation.winner_asset_id);
            const verb = recent.recommendation.verdict === "ship" ? "Ship" : "Revise";
            const isOpen = recent.status === "processing" || recent.status === "complete";
            const accent = recent.status === "processing"
              ? "var(--butter)"
              : recent.status === "failed" || recent.status === "cancelled"
              ? "var(--ink-faint)"
              : winner
              ? "var(--tomato)"
              : "var(--ink)";
            const headline = recent.status === "processing"
              ? "Still analyzing…"
              : recent.status === "failed"
              ? "Analysis failed."
              : recent.status === "cancelled"
              ? "Analysis cancelled."
              : `${verb} ${winner?.asset.name?.split("·")[0]?.trim() ?? "—"}.`;
            return (
              <button
                key={recent.id}
                className="recent-row"
                onClick={() => onOpenRecent(recent.id)}
                disabled={!isOpen}
                style={{
                  borderLeftColor: accent,
                  cursor: isOpen ? "pointer" : "default",
                  background: "var(--paper-warm)",
                  border: 0,
                  borderLeft: `4px solid ${accent}`,
                  textAlign: "left",
                  font: "inherit",
                  color: "inherit",
                  width: "100%"
                }}
              >
                <strong>{headline}</strong>
                <span>
                  {recent.status === "complete"
                    ? `${Math.round((recent.recommendation.confidence ?? 0) * 100)}%`
                    : recent.status}{" "}
                  · {formatRelative(recent.created_at)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

function ResultsColumn({
  step,
  progress,
  comparison,
  ranked,
  activeVariant,
  activeVariantIdx,
  setActiveVariantIdx,
  selectedAssets,
  onSeed,
  onReCompare,
  onShare,
  onExport,
  onDraftChallenger,
  onLogOutcome,
  onCancel,
  onContinueInBackground,
  pollNote,
  pollStartedAt
}: {
  step: Step;
  progress: number;
  comparison: Comparison | null;
  ranked: VariantResult[];
  activeVariant: VariantResult | undefined;
  activeVariantIdx: number;
  setActiveVariantIdx: (idx: number) => void;
  selectedAssets: Asset[];
  onSeed: () => void;
  onReCompare: () => void;
  onShare: () => void;
  onExport: () => void;
  onDraftChallenger: () => void;
  onLogOutcome: (assetId: string) => void;
  onCancel: () => void;
  onContinueInBackground: () => void;
  pollNote: string | null;
  pollStartedAt: number | null;
}) {
  if (step === "intake" || step === "inventory") {
    return <PreCompare selectedAssets={selectedAssets} onSeed={onSeed} />;
  }
  if (step === "analyzing") {
    return (
      <Analyzing
        progress={progress}
        selectedAssets={selectedAssets}
        comparison={comparison}
        pollNote={pollNote}
        pollStartedAt={pollStartedAt}
        onCancel={onCancel}
        onContinueInBackground={onContinueInBackground}
      />
    );
  }
  if (!comparison || !activeVariant) {
    return <PreCompare selectedAssets={selectedAssets} onSeed={onSeed} />;
  }
  return (
    <Result
      comparison={comparison}
      ranked={ranked}
      activeVariant={activeVariant}
      activeVariantIdx={activeVariantIdx}
      setActiveVariantIdx={setActiveVariantIdx}
      onReCompare={onReCompare}
      onShare={onShare}
      onExport={onExport}
      onDraftChallenger={onDraftChallenger}
      onLogOutcome={onLogOutcome}
    />
  );
}

function PreCompare({ selectedAssets, onSeed }: { selectedAssets: Asset[]; onSeed: () => void }) {
  return (
    <section className="wb-col wb-col-results">
      <div className="panel-card pre-card">
        <div className="floating-art">
          <div className="bob slow" style={{ ["--rot" as string]: "-6deg" } as CSSProperties}>
            <BrainBlob size={120} color="var(--tomato)" eyes mouth />
          </div>
          <div className="bob fast" style={{ ["--rot" as string]: "8deg", marginLeft: -22 } as CSSProperties}>
            <BrainBlob size={88} color="var(--pistachio)" />
          </div>
          <div className="bob" style={{ ["--rot" as string]: "-4deg", marginLeft: -10 } as CSSProperties}>
            <BrainBlob size={70} color="var(--butter)" />
          </div>
        </div>

        <span className="kicker">step 03 — compare</span>
        <h2 className="big-h">
          Pick two variants.
          <br />
          We'll grow them into a decision.
        </h2>
        <p className="big-p">
          Stimli will read each variant the way a brain would — second-by-second — and braid the four signals into a single
          recommendation.
        </p>

        {selectedAssets.length >= 2 ? (
          <div className="selection-preview">
            {selectedAssets.slice(0, 4).map((asset, i) => (
              <div key={asset.id} className="sp-row">
                <BrainBlob size={48} color={COLOR_CYCLE[i % COLOR_CYCLE.length]} />
                <div>
                  <strong>{asset.name}</strong>
                  <span>
                    {TYPE_LABEL[asset.type]} · {asset.duration_seconds ? `${Math.round(asset.duration_seconds)}s` : "—"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="hint-card">
            <p>← pick two or more variants from the inventory</p>
            <button className="btn cream" onClick={onSeed}>Load the demo set</button>
          </div>
        )}

        <div className="signal-legend">
          {[
            ["Hook", "var(--tomato)"],
            ["Memory", "var(--pistachio)"],
            ["Attention", "var(--butter)"],
            ["Load", "var(--plum)"]
          ].map(([l, c]) => (
            <span key={l} className="legend-chip">
              <span className="swatch" style={{ background: c }} />
              {l}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Analyzing({
  progress,
  selectedAssets,
  comparison,
  pollNote,
  pollStartedAt,
  onCancel,
  onContinueInBackground
}: {
  progress: number;
  selectedAssets: Asset[];
  comparison: Comparison | null;
  pollNote: string | null;
  pollStartedAt: number | null;
  onCancel: () => void;
  onContinueInBackground: () => void;
}) {
  const variantSource = (comparison?.variants?.length ?? 0) > 0
    ? comparison!.variants.map((variant) => variant.asset)
    : selectedAssets;
  const jobByAssetId = new Map((comparison?.jobs ?? []).map((job) => [job.asset_id, job]));
  const elapsed = pollStartedAt ? Math.round((Date.now() - pollStartedAt) / 1000) : 0;
  const showLongRunning = elapsed > 60;
  const stageLabels = labelsForProgress(progress, comparison);

  return (
    <section className="wb-col wb-col-results">
      <div className="panel-card analyze-card">
        <span className="kicker">
          analyzing · {progress}%{showLongRunning ? ` · ${elapsed}s elapsed` : ""}
        </span>
        <h2 className="big-h">Growing thought-trails…</h2>
        <p className="big-p">
          Stimli is reading {variantSource.length} variants second-by-second and braiding the signals.
        </p>

        <div className="analyze-stage">
          <div className="bob fast" style={{ ["--rot" as string]: "-6deg" } as CSSProperties}>
            <BrainBlob size={150} color="var(--tomato)" eyes mouth />
          </div>
          <div className="bob" style={{ ["--rot" as string]: "8deg" } as CSSProperties}>
            <BrainBlob size={120} color="var(--pistachio)" eyes />
          </div>
          {variantSource.length > 2 ? (
            <div className="bob slow" style={{ ["--rot" as string]: "-4deg" } as CSSProperties}>
              <BrainBlob size={94} color="var(--butter)" />
            </div>
          ) : null}
        </div>

        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
          <span className="progress-num">{progress}%</span>
        </div>

        <ul className="stage-list">
          {stageLabels.map((stage) => (
            <li key={stage.label} className={stage.state}>
              <span className="stage-dot" />
              {stage.label}
            </li>
          ))}
        </ul>

        {variantSource.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: "20px 0 0", display: "flex", flexDirection: "column", gap: 8 }}>
            {variantSource.map((asset, idx) => {
              const job = jobByAssetId.get(asset.id);
              const status = job?.status ?? comparison?.variants[idx]?.analysis.status ?? "queued";
              const accent = COLOR_CYCLE[idx % COLOR_CYCLE.length];
              const error = job?.error;
              return (
                <li
                  key={asset.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "32px 1fr auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "8px 12px",
                    background: "var(--paper-warm)",
                    border: "1.5px solid var(--ink)",
                    borderRadius: 12
                  }}
                >
                  <BrainBlob size={28} color={accent} />
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontFamily: "var(--body)", fontWeight: 600, fontSize: 13 }}>{asset.name}</strong>
                    {error ? (
                      <p style={{ margin: 0, fontSize: 11.5, color: "var(--tomato-ink)" }}>{error}</p>
                    ) : (
                      <p style={{ margin: 0, fontSize: 11.5, color: "var(--ink-soft)" }}>
                        {jobStatusBlurb(status, asset.type)}
                      </p>
                    )}
                  </div>
                  <span
                    className="claim-pill"
                    style={statusPillStyle(status)}
                  >
                    {status}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}

        {pollNote ? (
          <div className="banner" style={{ marginTop: 18 }}>
            {pollNote}
          </div>
        ) : null}

        {showLongRunning ? (
          <div style={{ marginTop: 18, display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button className="btn ghost" onClick={onContinueInBackground}>
              Continue in background
            </button>
            <button className="btn cream" onClick={onCancel}>
              Cancel analysis
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function labelsForProgress(progress: number, comparison: Comparison | null): Array<{ label: string; state: string }> {
  const stages = [
    "Reading the words",
    "Sampling brain response",
    "Tracing the timeline",
    "Tasting the offer",
    "Composing the verdict"
  ];
  const jobs = comparison?.jobs ?? [];
  const completedJobs = jobs.filter((job) => job.status === "complete").length;
  const totalJobs = jobs.length;
  let liveIdx = Math.min(stages.length - 1, Math.floor((progress / 100) * stages.length));
  if (totalJobs > 0) {
    if (completedJobs === 0) liveIdx = 1;
    else if (completedJobs < totalJobs) liveIdx = 2;
    else liveIdx = 4;
  }
  return stages.map((label, i) => ({
    label,
    state: i < liveIdx ? "done" : i === liveIdx ? "live" : ""
  }));
}

function jobStatusBlurb(status: string, type: AssetType): string {
  if (status === "complete") return "Brain trace ready.";
  if (status === "failed") return "Job failed.";
  if (status === "cancelled") return "Job cancelled.";
  if (status === "queued") return type === "video" || type === "audio" ? "Queued for hosted Modal job." : "Waiting in line.";
  if (status === "running") return "Modal GPU is sampling responses.";
  if (status === "processing") return type === "video" ? "Extracting frames + transcript." : "Processing on the brain model.";
  if (status === "retrying") return "Hosted job retrying after a transient error.";
  return "Working…";
}

function statusPillStyle(status: string): CSSProperties {
  if (status === "complete") {
    return { background: "var(--pistachio-soft)", borderColor: "var(--pistachio-ink)", color: "var(--pistachio-ink)" };
  }
  if (status === "failed" || status === "cancelled") {
    return { background: "var(--tomato-soft)", borderColor: "var(--tomato-ink)", color: "var(--tomato-ink)" };
  }
  if (status === "running" || status === "processing") {
    return { background: "var(--butter-soft)", borderColor: "var(--butter-ink)", color: "var(--butter-ink)" };
  }
  return { background: "var(--paper-warm)", borderColor: "var(--ink)", color: "var(--ink-soft)" };
}

function Result({
  comparison,
  ranked,
  activeVariant,
  activeVariantIdx,
  setActiveVariantIdx,
  onReCompare,
  onShare,
  onExport,
  onDraftChallenger,
  onLogOutcome
}: {
  comparison: Comparison;
  ranked: VariantResult[];
  activeVariant: VariantResult;
  activeVariantIdx: number;
  setActiveVariantIdx: (idx: number) => void;
  onReCompare: () => void;
  onShare: () => void;
  onExport: () => void;
  onDraftChallenger: () => void;
  onLogOutcome: (assetId: string) => void;
}) {
  const winner = ranked[0];
  const winnerColor = COLOR_CYCLE[0];
  const confidence = Math.round((comparison.recommendation.confidence ?? 0) * 100);
  const runnerUpDelta = ranked.length > 1 ? Math.round(ranked[1].delta_from_best) : 0;
  const focusKey = pickWeakKey(winner.analysis.scores);
  const focusLabel = labelFor(focusKey);
  const winnerName = winner.asset.name.split("·")[0]?.trim() ?? winner.asset.name;
  const headline = comparison.recommendation.headline || `Ship ${winnerName}. Tighten the ${focusLabel}.`;
  const trailScores = trailScoresFor(activeVariant);

  return (
    <section className="wb-col wb-col-results">
      <div className="panel-card result-hero" style={{ ["--accent" as string]: winnerColor } as CSSProperties}>
        <div className="result-hero-grid">
          <div>
            <span className="kicker">decision report</span>
            <h2 className="big-h" style={{ fontSize: 44 }}>
              {headline}
            </h2>
            <div className="confidence-row">
              <div className="conf-num">
                <strong>
                  {confidence}
                  <small>%</small>
                </strong>
                <span>confidence</span>
              </div>
              <div className="conf-blob">
                <Sparkle color="var(--butter)" size={32} />
                <p>delta of {Math.abs(runnerUpDelta)} pts vs runner-up</p>
              </div>
            </div>
          </div>
          <div className="result-winner-art">
            <div className="bob slow" style={{ ["--rot" as string]: "-6deg" } as CSSProperties}>
              <BrainBlob size={180} color={winnerColor} eyes mouth />
            </div>
            <StickerStar
              color="var(--butter)"
              size={70}
              rot={-12}
              label="A"
              style={{ position: "absolute", top: -10, right: 0 }}
            />
          </div>
        </div>

        <div className="trail-display">
          <div className="trail-head">
            <strong>Thought-trail · {activeVariant.asset.name.split("·")[0]?.trim() ?? activeVariant.asset.name}</strong>
            <div className="trail-tabs">
              {ranked.map((variant, idx) => (
                <button
                  key={variant.asset.id}
                  className={`trail-tab ${idx === activeVariantIdx ? "active" : ""}`}
                  onClick={() => setActiveVariantIdx(idx)}
                >
                  <span className="swatch" style={{ background: COLOR_CYCLE[idx % COLOR_CYCLE.length] }} />
                  {variant.asset.name.split("·")[0]?.trim() ?? variant.asset.name}
                </button>
              ))}
            </div>
          </div>
          <div className="braided-trail">
            <BraidedTrail scores={trailScores} />
            <div className="trail-axis">
              <span>0:00 · the hook</span>
              <span>0:08 · build</span>
              <span>0:18 · the offer</span>
              <span>0:30 · the close</span>
            </div>
            <div className="trail-legend">
              {[
                ["hook", "Hook", "var(--tomato)"],
                ["memory", "Memory", "var(--pistachio)"],
                ["attention", "Attention", "var(--butter)"],
                ["load", "Load", "var(--plum)"]
              ].map(([k, label, color]) => (
                <span key={k} className="legend-chip">
                  <span className="swatch" style={{ background: color }} />
                  {label}{" "}
                  <strong>
                    {Math.round((trailScores as Record<string, number>)[k as keyof typeof trailScores] ?? 0)}
                  </strong>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="result-side-grid">
        <div className="panel-card scores-card">
          <div className="panel-head">
            <h3>Scores</h3>
            <span className="kicker">side by side</span>
          </div>
          <ScoreBars ranked={ranked} />
        </div>

        <div className="panel-card edits-card">
          <div className="panel-head">
            <h3>The edit list</h3>
            <span className="kicker">what to fix before launch</span>
          </div>
          <ul className="edit-list">
            {editEntries(comparison, winner).map((entry, i) => {
              const accent = accentForTarget(entry.target);
              return (
                <li key={i} style={{ ["--accent" as string]: accent } as CSSProperties}>
                  <span className="edit-num">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{entry.title}</strong>
                    <p>{entry.detail}</p>
                  </div>
                  <BrainBlob size={36} color={accent} />
                </li>
              );
            })}
          </ul>
          <div className="edit-actions">
            <button className="btn ghost" onClick={() => onLogOutcome(winner.asset.id)}>
              Log outcome
            </button>
            <button className="btn cream" onClick={onExport}>
              Export
            </button>
            <button className="btn cream" onClick={onShare}>
              Share
            </button>
            <button className="btn cream" onClick={onReCompare}>
              Re-compare
            </button>
            <button className="btn primary" onClick={onDraftChallenger}>
              Draft challenger ✺
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ScoreBars({ ranked }: { ranked: VariantResult[] }) {
  const keys: Array<[keyof ScoreBreakdown | "load", string, string]> = [
    ["hook", "Hook", "var(--tomato)"],
    ["memory", "Memory", "var(--pistachio)"],
    ["neural_attention", "Attention", "var(--butter)"],
    ["cognitive_load", "Load", "var(--plum)"],
    ["cta", "CTA", "var(--ink)"],
    ["brand_cue", "Brand", "var(--tomato-ink)"]
  ];
  return (
    <div className="score-bars">
      {keys.map(([key, label, color]) => (
        <div key={String(key)} className="bar-row">
          <span className="bar-label">{label}</span>
          <div className="bar-track">
            {ranked.map((variant, idx) => {
              const value = readScore(variant.analysis.scores, key as keyof ScoreBreakdown);
              return (
                <span
                  key={variant.asset.id}
                  className="bar-fill"
                  style={{
                    width: `${Math.max(8, value)}%`,
                    background: COLOR_CYCLE[idx % COLOR_CYCLE.length],
                    borderColor: "var(--ink)",
                    color: color
                  }}
                  title={`${variant.asset.name}: ${value}`}
                >
                  <span className="bar-val">{Math.round(value)}</span>
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function readScore(scores: ScoreBreakdown, key: keyof ScoreBreakdown): number {
  const value = scores[key];
  if (typeof value !== "number" || Number.isNaN(value)) return 50;
  if (value <= 1) return Math.round(value * 100);
  return Math.round(value);
}

function pickWeakKey(scores: ScoreBreakdown): keyof ScoreBreakdown {
  const keys: Array<keyof ScoreBreakdown> = ["hook", "cta", "brand_cue", "memory", "clarity"];
  let weakest: keyof ScoreBreakdown = "hook";
  let weakestValue = 100;
  for (const key of keys) {
    const v = readScore(scores, key);
    if (v < weakestValue) {
      weakestValue = v;
      weakest = key;
    }
  }
  return weakest;
}

function labelFor(key: keyof ScoreBreakdown): string {
  switch (key) {
    case "hook":
      return "hook";
    case "cta":
      return "CTA";
    case "brand_cue":
      return "brand cue";
    case "memory":
      return "memory";
    case "clarity":
      return "clarity";
    default:
      return String(key);
  }
}

function trailScoresFor(variant: VariantResult): {
  hook: number;
  memory: number;
  attention: number;
  load: number;
} {
  const scores = variant.analysis.scores;
  const timeline = variant.analysis.timeline ?? [];
  const avg = (key: keyof TimelinePoint) =>
    timeline.length === 0 ? null : timeline.reduce((sum, point) => sum + (Number(point[key]) || 0), 0) / timeline.length;
  const attention = avg("attention");
  const memory = avg("memory");
  const load = avg("cognitive_load");
  return {
    hook: readScore(scores, "hook"),
    memory: memory != null ? Math.round(memory * 100) : readScore(scores, "memory"),
    attention: attention != null ? Math.round(attention * 100) : readScore(scores, "neural_attention"),
    load: load != null ? Math.round(load * 100) : readScore(scores, "cognitive_load")
  };
}

function accentForTarget(target: string): string {
  const t = target.toLowerCase();
  if (t.includes("hook") || t.includes("first")) return "var(--tomato)";
  if (t.includes("cta") || t.includes("offer")) return "var(--butter)";
  if (t.includes("brand")) return "var(--pistachio)";
  if (t.includes("load") || t.includes("density") || t.includes("clarity")) return "var(--plum)";
  return "var(--tomato)";
}

function editEntries(comparison: Comparison, winner: VariantResult): Array<{ title: string; detail: string; target: string }> {
  if (comparison.suggestions.length > 0) {
    return comparison.suggestions.slice(0, 4).map((entry) => ({
      title: titleForTarget(entry.target, entry.severity),
      detail: entry.suggested_edit || entry.issue,
      target: entry.target
    }));
  }
  return fallbackEdits(winner);
}

function titleForTarget(target: string, severity: string): string {
  const t = target.toLowerCase();
  if (t.includes("hook")) return "Sharpen the hook.";
  if (t.includes("cta")) return "Tighten the CTA.";
  if (t.includes("brand")) return "Plant the brand earlier.";
  if (t.includes("offer")) return "Re-stage the offer.";
  if (t.includes("clarity")) return "Cut the clutter.";
  if (t.includes("load") || t.includes("density")) return "Ease the cognitive load.";
  return severity === "high" ? "Address before launch." : "Worth a tweak.";
}

function fallbackEdits(variant: VariantResult): Array<{ title: string; detail: string; target: string }> {
  const list: Array<{ title: string; detail: string; target: string }> = [];
  const scores = variant.analysis.scores;
  if (readScore(scores, "hook") < 80) {
    list.push({
      title: "Sharpen the first 3 seconds.",
      detail: "Move the pain into the first frame so the hook lands inside the attention window.",
      target: "hook"
    });
  }
  if (readScore(scores, "cta") < 80) {
    list.push({
      title: "End on the offer, not the brand.",
      detail: "Replace the close with the explicit starter-kit CTA.",
      target: "cta"
    });
  }
  if (readScore(scores, "brand_cue") < 80) {
    list.push({
      title: "Plant the brand cue earlier.",
      detail: "Bring the logo or product silhouette into the first beat.",
      target: "brand"
    });
  }
  if (readScore(scores, "cognitive_load") > 50) {
    list.push({
      title: "Ease the offer reveal.",
      detail: "Trim the claim list to two so the load curve relaxes through the close.",
      target: "load"
    });
  }
  if (list.length === 0) {
    list.push({
      title: "Ready to ship.",
      detail: "All four signals clear thresholds. Launch with confidence.",
      target: "ship"
    });
  }
  return list.slice(0, 4);
}

function computeProgress(comparison: Comparison | null): number {
  if (!comparison) return 0;
  if (comparison.status === "complete") return 100;
  if (comparison.status === "failed" || comparison.status === "cancelled") return 100;
  const jobs = comparison.jobs ?? [];
  if (jobs.length === 0) {
    // Server hasn't surfaced jobs yet (sync or pre-job-creation). Cap below 60% so
    // we don't pretend to be near done.
    return 35;
  }
  const weights: Record<string, number> = {
    queued: 10,
    retrying: 30,
    processing: 50,
    running: 65,
    complete: 100,
    failed: 0,
    cancelled: 0
  };
  const total = jobs.reduce((sum, job) => sum + (weights[job.status] ?? 25), 0);
  // Reserve the top 5% for the post-job scoring step.
  const ratio = (total / (jobs.length * 100)) * 95;
  return Math.max(35, Math.min(95, Math.round(ratio)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatRelative(timestamp: string): string {
  const created = new Date(timestamp);
  if (Number.isNaN(created.getTime())) return "earlier";
  const diff = Date.now() - created.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  return `${Math.round(diff / (24 * 60 * 60_000))}d ago`;
}
