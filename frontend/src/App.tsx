import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Check,
  ClipboardList,
  Download,
  FileText,
  Gauge,
  History,
  Layers,
  Lightbulb,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  TrendingUp,
  Upload
} from "lucide-react";
import { createBriefComparison, createOutcome, createTextAsset, getLearningSummary, getReport, listAssets, listComparisons, seedDemo } from "./api";
import type {
  Asset,
  AssetType,
  Comparison,
  CreativeBrief,
  LearningSummary,
  OutcomeCreate,
  ScoreBreakdown,
  Suggestion,
  TimelinePoint,
  VariantResult
} from "./types";

const assetTypes: { label: string; value: AssetType }[] = [
  { label: "Script", value: "script" },
  { label: "Landing Page", value: "landing_page" },
  { label: "Static Creative", value: "image" },
  { label: "Audio", value: "audio" },
  { label: "Video", value: "video" }
];

const scoreLabels: { key: keyof ScoreBreakdown; label: string }[] = [
  { key: "hook", label: "Hook" },
  { key: "clarity", label: "Clarity" },
  { key: "cta", label: "CTA" },
  { key: "brand_cue", label: "Brand Cue" },
  { key: "pacing", label: "Pacing" },
  { key: "offer_strength", label: "Offer" },
  { key: "audience_fit", label: "Audience" },
  { key: "neural_attention", label: "Attention" },
  { key: "memory", label: "Memory" },
  { key: "cognitive_load", label: "Load" }
];

export function App() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [learning, setLearning] = useState<LearningSummary | null>(null);
  const [name, setName] = useState("");
  const [assetType, setAssetType] = useState<AssetType>("script");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [durationSeconds, setDurationSeconds] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [objective, setObjective] = useState("Pick the DTC creative most likely to earn attention, build memory, and convert.");
  const [brandName, setBrandName] = useState("Lumina");
  const [audience, setAudience] = useState("busy women with dry or sensitive skin");
  const [productCategory, setProductCategory] = useState("skincare hydration system");
  const [primaryOffer, setPrimaryOffer] = useState("starter kit with free shipping");
  const [requiredClaims, setRequiredClaims] = useState("24 hour hydration, dermatologist tested");
  const [forbiddenTerms, setForbiddenTerms] = useState("miracle cure, guaranteed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshWorkspace();
  }, []);

  const selectedAssets = useMemo(() => assets.filter((asset) => selected.includes(asset.id)), [assets, selected]);
  const brief = useMemo<CreativeBrief>(
    () => ({
      brand_name: brandName,
      audience,
      product_category: productCategory,
      primary_offer: primaryOffer,
      required_claims: splitList(requiredClaims),
      forbidden_terms: splitList(forbiddenTerms)
    }),
    [brandName, audience, productCategory, primaryOffer, requiredClaims, forbiddenTerms]
  );

  async function refreshWorkspace() {
    try {
      const [assetList, comparisonList, learningSummary] = await Promise.all([listAssets(), listComparisons(), getLearningSummary()]);
      setAssets(assetList);
      setComparisons(comparisonList);
      setLearning(learningSummary);
    } catch {
      setError("Backend is not reachable. Start the API on port 8000.");
    }
  }

  async function handleSeed() {
    setBusy(true);
    setError(null);
    try {
      const seeded = await seedDemo();
      await refreshWorkspace();
      setSelected(seeded.slice(0, 2).map((asset) => asset.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not seed demo assets.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateAsset() {
    if (!name.trim() || (!text.trim() && !url.trim() && !file)) {
      setError("Add a name plus text, a URL, or a file.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parsedDuration = durationSeconds ? Number(durationSeconds) : undefined;
      const asset = await createTextAsset({
        assetType,
        name,
        text,
        url: url || undefined,
        durationSeconds: Number.isFinite(parsedDuration) ? parsedDuration : undefined,
        file
      });
      setAssets([asset, ...assets]);
      setSelected((current) => [...new Set([...current, asset.id])].slice(-4));
      setName("");
      setText("");
      setUrl("");
      setDurationSeconds("");
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create asset.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCompare() {
    if (selected.length < 2) {
      setError("Select at least two variants.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextComparison = await createBriefComparison(selected, objective, brief);
      setComparison(nextComparison);
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create comparison.");
    } finally {
      setBusy(false);
    }
  }

  function toggleSelected(assetId: string) {
    setSelected((current) => (current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]));
  }

  return (
    <main className="app-shell">
      <section className="top-band">
        <div>
          <p className="eyebrow">Pre-spend creative intelligence</p>
          <h1>Stimli decides which creative ships next.</h1>
          <p className="subhead">
            Compare scripts, pages, static ads, audio, and video notes with predicted response signals and practical edit cards.
          </p>
          {learning && <LearningSnapshot learning={learning} />}
        </div>
        <div className="hero-actions">
          <button className="button secondary" onClick={handleSeed} disabled={busy}>
            {busy ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            Demo assets
          </button>
          <button className="button primary" onClick={handleCompare} disabled={busy || selected.length < 2}>
            {busy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            Compare
          </button>
        </div>
      </section>

      {error && <div className="notice">{error}</div>}

      <section className="workspace-grid">
        <aside className="panel intake-panel">
          <div className="panel-heading">
            <Upload size={19} />
            <h2>Add Variant</h2>
          </div>
          <label>
            Type
            <select value={assetType} onChange={(event) => setAssetType(event.target.value as AssetType)}>
              {assetTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Variant C - proof-led hook" />
          </label>
          <label>
            URL
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://brand.com/offer" />
          </label>
          <label>
            Duration seconds
            <input
              value={durationSeconds}
              inputMode="decimal"
              onChange={(event) => setDurationSeconds(event.target.value)}
              placeholder="30"
            />
          </label>
          <label>
            File
            <input
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              accept=".txt,.md,.png,.jpg,.jpeg,.webp,.mp3,.wav,.mp4,.mov"
            />
          </label>
          <label>
            Creative text, transcript, URL notes, or visual notes
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste the script, landing page copy, transcript, or visual description here."
            />
          </label>
          <button className="button full" onClick={handleCreateAsset} disabled={busy}>
            <Plus size={18} />
            Add to comparison
          </button>

          <div className="objective-box">
            <label>
              Decision objective
              <textarea value={objective} onChange={(event) => setObjective(event.target.value)} />
            </label>
            <label>
              Brand
              <input value={brandName} onChange={(event) => setBrandName(event.target.value)} />
            </label>
            <label>
              Audience
              <input value={audience} onChange={(event) => setAudience(event.target.value)} />
            </label>
            <label>
              Category
              <input value={productCategory} onChange={(event) => setProductCategory(event.target.value)} />
            </label>
            <label>
              Primary offer
              <input value={primaryOffer} onChange={(event) => setPrimaryOffer(event.target.value)} />
            </label>
            <label>
              Required claims
              <input value={requiredClaims} onChange={(event) => setRequiredClaims(event.target.value)} />
            </label>
            <label>
              Forbidden terms
              <input value={forbiddenTerms} onChange={(event) => setForbiddenTerms(event.target.value)} />
            </label>
          </div>
        </aside>

        <section className="panel asset-panel">
          <div className="panel-heading spread">
            <div>
              <div className="inline-title">
                <Layers size={19} />
                <h2>Variants</h2>
              </div>
              <p>{selected.length} selected for comparison</p>
            </div>
            <button className="icon-button" onClick={refreshWorkspace} aria-label="Refresh assets">
              <RefreshCw size={18} />
            </button>
          </div>

          <div className="asset-list">
            {assets.length === 0 ? (
              <EmptyState />
            ) : (
              assets.map((asset) => (
                <button
                  className={`asset-row ${selected.includes(asset.id) ? "selected" : ""}`}
                  key={asset.id}
                  onClick={() => toggleSelected(asset.id)}
                >
                  <span className="select-dot">{selected.includes(asset.id) && <Check size={13} />}</span>
                  <span>
                    <strong>{asset.name}</strong>
                    <small>
                      {asset.type.replace("_", " ")} · {asset.extracted_text.slice(0, 92)}
                    </small>
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="history-block">
            <div className="inline-title history-title">
              <History size={17} />
              <h2>Recent Decisions</h2>
            </div>
            {comparisons.length === 0 ? (
              <p className="muted">No comparisons yet.</p>
            ) : (
              comparisons.slice(0, 5).map((item) => (
                <button className="history-row" key={item.id} onClick={() => setComparison(item)}>
                  <strong>{item.recommendation.headline}</strong>
                  <small>
                    {Math.round(item.recommendation.confidence * 100)}% confidence · {item.variants.length} variants
                  </small>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="results-column">
          {comparison ? (
            <ComparisonView comparison={comparison} onOutcomeSaved={refreshWorkspace} />
          ) : (
            <PreComparison selectedAssets={selectedAssets} />
          )}
        </section>
      </section>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <FileText size={34} />
      <p>Add variants or load the demo set.</p>
    </div>
  );
}

function PreComparison({ selectedAssets }: { selectedAssets: Asset[] }) {
  return (
    <div className="panel pre-panel">
      <Target size={34} />
      <h2>Choose at least two variants.</h2>
      <p>The recommendation panel will show the winner, confidence, score deltas, timeline evidence, and edit cards.</p>
      {selectedAssets.length > 0 && (
        <div className="mini-stack">
          {selectedAssets.map((asset) => (
            <span key={asset.id}>{asset.name}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function LearningSnapshot({ learning }: { learning: LearningSummary }) {
  return (
    <div className="learning-snapshot">
      <span>
        <Activity size={16} />
        {learning.outcome_count} launches logged
      </span>
      <span>
        <TrendingUp size={16} />
        {Math.round(learning.average_ctr * 10000) / 100}% CTR
      </span>
      <span>${learning.total_revenue.toLocaleString()} revenue tracked</span>
    </div>
  );
}

function ComparisonView({ comparison, onOutcomeSaved }: { comparison: Comparison; onOutcomeSaved: () => Promise<void> }) {
  const winner = comparison.variants.find((variant) => variant.asset.id === comparison.recommendation.winner_asset_id);
  const [reportBusy, setReportBusy] = useState(false);
  const [outcomeBusy, setOutcomeBusy] = useState(false);
  const [outcome, setOutcome] = useState<OutcomeCreate>({
    asset_id: winner?.asset.id ?? comparison.variants[0]?.asset.id ?? "",
    spend: 250,
    impressions: 12000,
    clicks: 360,
    conversions: 24,
    revenue: 1200,
    notes: ""
  });

  return (
    <div className="results-stack">
      <section className="decision-band">
        <div>
          <p className="eyebrow">{comparison.recommendation.verdict === "ship" ? "Recommendation" : "Revision needed"}</p>
          <h2>{comparison.recommendation.headline}</h2>
          <div className="confidence">
            <Gauge size={18} />
            {Math.round(comparison.recommendation.confidence * 100)}% confidence
          </div>
        </div>
        {winner && (
          <div className="winner-score">
            <strong>{winner.analysis.scores.overall}</strong>
            <span>overall</span>
          </div>
        )}
        <button className="button report-button" onClick={() => exportReport(comparison.id, setReportBusy)} disabled={reportBusy}>
          {reportBusy ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
          Report
        </button>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <ClipboardList size={19} />
          <h2>Why</h2>
        </div>
        <div className="reason-list">
          {comparison.recommendation.reasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </div>
      </section>

      <section className="variant-grid">
        {comparison.variants.map((variant) => (
          <VariantCard key={variant.asset.id} variant={variant} />
        ))}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <BarChart3 size={19} />
          <h2>Timeline Evidence</h2>
        </div>
        {winner && <Timeline timeline={winner.analysis.timeline} />}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <Lightbulb size={19} />
          <h2>Edit Cards</h2>
        </div>
        <div className="suggestion-list">
          {comparison.suggestions.map((suggestion, index) => (
            <SuggestionCard key={`${suggestion.asset_id}-${suggestion.target}-${index}`} suggestion={suggestion} comparison={comparison} />
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <Send size={19} />
          <h2>Launch Learning</h2>
        </div>
        <div className="outcome-grid">
          <label>
            Variant
            <select value={outcome.asset_id} onChange={(event) => setOutcome({ ...outcome, asset_id: event.target.value })}>
              {comparison.variants.map((variant) => (
                <option key={variant.asset.id} value={variant.asset.id}>
                  {variant.asset.name}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="Spend" value={outcome.spend} onChange={(spend) => setOutcome({ ...outcome, spend })} />
          <NumberField label="Impressions" value={outcome.impressions} onChange={(impressions) => setOutcome({ ...outcome, impressions })} />
          <NumberField label="Clicks" value={outcome.clicks} onChange={(clicks) => setOutcome({ ...outcome, clicks })} />
          <NumberField label="Conversions" value={outcome.conversions} onChange={(conversions) => setOutcome({ ...outcome, conversions })} />
          <NumberField label="Revenue" value={outcome.revenue} onChange={(revenue) => setOutcome({ ...outcome, revenue })} />
        </div>
        <label>
          Notes
          <input
            value={outcome.notes}
            onChange={(event) => setOutcome({ ...outcome, notes: event.target.value })}
            placeholder="Audience, channel, or launch context"
          />
        </label>
        <button
          className="button"
          disabled={outcomeBusy}
          onClick={async () => {
            setOutcomeBusy(true);
            try {
              await createOutcome(comparison.id, outcome);
              await onOutcomeSaved();
            } finally {
              setOutcomeBusy(false);
            }
          }}
        >
          {outcomeBusy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          Log outcome
        </button>
      </section>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label>
      {label}
      <input value={String(value)} inputMode="decimal" onChange={(event) => onChange(Number(event.target.value) || 0)} />
    </label>
  );
}

async function exportReport(comparisonId: string, setBusy: (value: boolean) => void) {
  setBusy(true);
  try {
    const report = await getReport(comparisonId);
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `stimli-report-${comparisonId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } finally {
    setBusy(false);
  }
}

function VariantCard({ variant }: { variant: VariantResult }) {
  return (
    <article className="panel variant-card">
      <div className="variant-title">
        <span>#{variant.rank}</span>
        <div>
          <h3>{variant.asset.name}</h3>
          <p>{variant.analysis.summary}</p>
        </div>
      </div>
      <div className="score-line">
        <strong>{variant.analysis.scores.overall}</strong>
        <span>{variant.delta_from_best === 0 ? "leader" : `${variant.delta_from_best} pts behind`}</span>
      </div>
      <div className="metrics">
        {scoreLabels.map(({ key, label }) => (
          <div className="metric" key={key}>
            <span>{label}</span>
            <div>
              <i style={{ width: `${Math.min(100, variant.analysis.scores[key])}%` }} />
            </div>
            <b>{variant.analysis.scores[key]}</b>
          </div>
        ))}
      </div>
    </article>
  );
}

function Timeline({ timeline }: { timeline: TimelinePoint[] }) {
  return (
    <div className="timeline">
      {timeline.map((point) => (
        <div className="timeline-point" key={point.second}>
          <span>{point.second}s</span>
          <div className="timeline-bars">
            <i className="attention" style={{ height: `${point.attention * 74 + 8}px` }} />
            <i className="memory" style={{ height: `${point.memory * 74 + 8}px` }} />
            <i className="load" style={{ height: `${point.cognitive_load * 74 + 8}px` }} />
          </div>
          <small>{point.note}</small>
        </div>
      ))}
    </div>
  );
}

function SuggestionCard({ suggestion, comparison }: { suggestion: Suggestion; comparison: Comparison }) {
  const asset = comparison.variants.find((variant) => variant.asset.id === suggestion.asset_id)?.asset;
  return (
    <article className={`suggestion ${suggestion.severity}`}>
      <div>
        <span>{suggestion.severity}</span>
        <strong>{asset?.name ?? "Variant"}</strong>
      </div>
      <h3>{suggestion.target}</h3>
      <p>{suggestion.issue}</p>
      <p className="edit">{suggestion.suggested_edit}</p>
      <small>{suggestion.expected_effect}</small>
    </article>
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
