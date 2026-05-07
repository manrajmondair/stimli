import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Building2,
  Check,
  ClipboardList,
  CreditCard,
  Download,
  FileText,
  Gauge,
  History,
  KeyRound,
  Layers,
  Lightbulb,
  Loader2,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  Send,
  Share2,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Upload,
  UserRound
} from "lucide-react";
import {
  cancelComparison,
  createBriefComparisonForProject,
  createChallenger,
  createOutcome,
  createProject,
  createShareLink,
  createTextAsset,
  getBillingStatus,
  getBrainProviders,
  getComparison,
  getLearningSummary,
  getReport,
  getReportMarkdown,
  getSharedReport,
  getSession,
  listProjects,
  loginWithPasskey,
  logout,
  listAssets,
  listComparisons,
  openBillingPortal,
  registerWithPasskey,
  seedDemo,
  startCheckout
} from "./api";
import type {
  Asset,
  AuthSession,
  AssetType,
  BillingStatus,
  BrainProviderHealth,
  Comparison,
  CreativeBrief,
  LearningSummary,
  OutcomeCreate,
  Project,
  Report,
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
  const shareToken = getShareToken();
  return shareToken ? <SharedReportPage token={shareToken} /> : <WorkspaceApp />;
}

function WorkspaceApp() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [learning, setLearning] = useState<LearningSummary | null>(null);
  const [providers, setProviders] = useState<BrainProviderHealth[]>([]);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [name, setName] = useState("");
  const [assetType, setAssetType] = useState<AssetType>("script");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [durationSeconds, setDurationSeconds] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [projectName, setProjectName] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [objective, setObjective] = useState("Pick the DTC creative most likely to earn attention, build memory, and convert.");
  const [brandName, setBrandName] = useState("Lumina");
  const [audience, setAudience] = useState("busy women with dry or sensitive skin");
  const [productCategory, setProductCategory] = useState("skincare hydration system");
  const [primaryOffer, setPrimaryOffer] = useState("starter kit with free shipping");
  const [requiredClaims, setRequiredClaims] = useState("24 hour hydration, dermatologist tested");
  const [forbiddenTerms, setForbiddenTerms] = useState("miracle cure, guaranteed");
  const [busy, setBusy] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initializeWorkspace();
  }, []);

  const activeProjectId = selectedProjectId === "all" ? null : selectedProjectId;
  const visibleAssets = useMemo(
    () => (activeProjectId ? assets.filter((asset) => asset.project_id === activeProjectId) : assets),
    [activeProjectId, assets]
  );
  const visibleComparisons = useMemo(
    () => (activeProjectId ? comparisons.filter((item) => item.project_id === activeProjectId) : comparisons),
    [activeProjectId, comparisons]
  );
  const selectedAssets = useMemo(() => visibleAssets.filter((asset) => selected.includes(asset.id)), [visibleAssets, selected]);
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

  async function initializeWorkspace() {
    try {
      const currentSession = await getSession();
      setSession(currentSession);
      await refreshWorkspace();
    } catch {
      setError("Backend is not reachable. Start the API on port 8000.");
    }
  }

  async function refreshWorkspace() {
    try {
      const [projectList, assetList, comparisonList, learningSummary, providerList, billingState] = await Promise.all([
        listProjects(),
        listAssets(),
        listComparisons(),
        getLearningSummary(),
        getBrainProviders(),
        getBillingStatus()
      ]);
      setProjects(projectList);
      setAssets(assetList);
      setComparisons(comparisonList);
      setLearning(learningSummary);
      setProviders(providerList);
      setBilling(billingState);
    } catch {
      setError("Backend is not reachable. Start the API on port 8000.");
    }
  }

  async function handleRegister(input: { email: string; name: string; teamName: string }) {
    setAuthBusy(true);
    setError(null);
    try {
      const nextSession = await registerWithPasskey(input);
      setSession(nextSession);
      setSelected([]);
      setComparison(null);
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create account.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogin(email: string) {
    setAuthBusy(true);
    setError(null);
    try {
      const nextSession = await loginWithPasskey(email);
      setSession(nextSession);
      setSelected([]);
      setComparison(null);
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    setAuthBusy(true);
    setError(null);
    try {
      await logout();
      const nextSession = await getSession();
      setSession(nextSession);
      setSelected([]);
      setComparison(null);
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleCreateProject() {
    if (!projectName.trim()) {
      setError("Add a project name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await createProject({ name: projectName });
      setProjects([project, ...projects]);
      setSelectedProjectId(project.id);
      setSelected([]);
      setComparison(null);
      setProjectName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpgrade(plan: string) {
    setBillingBusy(true);
    setError(null);
    try {
      const checkout = await startCheckout(plan);
      window.location.assign(checkout.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout.");
    } finally {
      setBillingBusy(false);
    }
  }

  async function handlePortal() {
    setBillingBusy(true);
    setError(null);
    try {
      const portal = await openBillingPortal();
      window.location.assign(portal.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open billing.");
    } finally {
      setBillingBusy(false);
    }
  }

  async function handleSeed() {
    setBusy(true);
    setError(null);
    try {
      const seeded = await seedDemo(activeProjectId);
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
      if (file) {
        setUploadProgress(0);
      }
      const asset = await createTextAsset({
        assetType,
        name,
        text,
        url: url || undefined,
        durationSeconds: Number.isFinite(parsedDuration) ? parsedDuration : undefined,
        file,
        projectId: activeProjectId,
        onUploadProgress: setUploadProgress
      });
      setAssets([asset, ...assets]);
      setSelected((current) => [...new Set([...current, asset.id])].slice(-4));
      setName("");
      setText("");
      setUrl("");
      setDurationSeconds("");
      setFile(null);
      setUploadProgress(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create asset.");
    } finally {
      setUploadProgress(null);
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
      const nextComparison = await createBriefComparisonForProject(selected, objective, brief, activeProjectId);
      setComparison(nextComparison);
      await refreshWorkspace();
      if (nextComparison.status === "processing") {
        void pollComparison(nextComparison.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create comparison.");
    } finally {
      setBusy(false);
    }
  }

  async function pollComparison(comparisonId: string) {
    setProcessingId(comparisonId);
    try {
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await delay(Math.min(2500 + attempt * 250, 8000));
        const fresh = await getComparison(comparisonId);
        setComparison((current) => (current?.id === comparisonId ? fresh : current));
        if (fresh.status === "complete" || fresh.status === "failed" || fresh.status === "cancelled") {
          await refreshWorkspace();
          return;
        }
      }
      setError("Analysis is taking longer than expected. You can refresh recent decisions in a moment.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh comparison status.");
    } finally {
      setProcessingId((current) => (current === comparisonId ? null : current));
    }
  }

  async function handleCancelComparison(comparisonId: string) {
    setBusy(true);
    setError(null);
    try {
      const cancelled = await cancelComparison(comparisonId);
      setComparison(cancelled);
      setProcessingId((current) => (current === comparisonId ? null : current));
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel analysis.");
    } finally {
      setBusy(false);
    }
  }

  function toggleSelected(assetId: string) {
    setSelected((current) => (current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]));
  }

  function handleProjectChange(projectId: string) {
    setSelectedProjectId(projectId);
    setSelected([]);
    setComparison(null);
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
          {providers.length > 0 && <ProviderSnapshot providers={providers} />}
        </div>
        <div className="hero-actions">
          <AuthPanel
            session={session}
            busy={authBusy}
            onRegister={handleRegister}
            onLogin={handleLogin}
            onLogout={handleLogout}
          />
          {billing && (
            <BillingPanel billing={billing} busy={billingBusy} onUpgrade={handleUpgrade} onPortal={handlePortal} />
          )}
          <button className="button secondary" onClick={handleSeed} disabled={busy}>
            {busy ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            Demo assets
          </button>
          <button className="button primary" onClick={handleCompare} disabled={busy || Boolean(processingId) || selected.length < 2}>
            {busy || processingId ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            {processingId ? "Processing" : "Compare"}
          </button>
        </div>
      </section>

      {error && <div className="notice">{error}</div>}

      <section className="project-bar">
        <label>
          Project
          <select value={selectedProjectId} onChange={(event) => handleProjectChange(event.target.value)}>
            <option value="all">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          New project
          <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Q3 hydration launch" />
        </label>
        <button className="button secondary" onClick={handleCreateProject} disabled={busy || !projectName.trim()}>
          <Plus size={18} />
          Create
        </button>
        <div className="project-stats">
          <span>{visibleAssets.length} variants</span>
          <span>{visibleComparisons.length} decisions</span>
        </div>
      </section>

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
          {uploadProgress !== null && (
            <div className="upload-progress">
              <span>Uploading {uploadProgress}%</span>
              <i style={{ width: `${uploadProgress}%` }} />
            </div>
          )}

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
            {visibleAssets.length === 0 ? (
              <EmptyState />
            ) : (
              visibleAssets.map((asset) => (
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
            {visibleComparisons.length === 0 ? (
              <p className="muted">No comparisons yet.</p>
            ) : (
              visibleComparisons.slice(0, 5).map((item) => (
                <button className="history-row" key={item.id} onClick={() => setComparison(item)}>
                  <strong>{item.status === "processing" ? "Processing comparison" : item.recommendation.headline}</strong>
                  <small>
                    {item.status === "complete"
                      ? `${Math.round(item.recommendation.confidence * 100)}% confidence`
                      : item.status}{" "}
                    · {item.variants.length} variants
                  </small>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="results-column">
          {comparison ? (
            <ComparisonView comparison={comparison} onOutcomeSaved={refreshWorkspace} onCancel={handleCancelComparison} />
          ) : (
            <PreComparison selectedAssets={selectedAssets} />
          )}
        </section>
      </section>
    </main>
  );
}

function SharedReportPage({ token }: { token: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSharedReport(token)
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : "Shared report is unavailable."));
  }, [token]);

  if (error) {
    return (
      <main className="app-shell share-shell">
        <section className="panel shared-empty">
          <FileText size={34} />
          <h1>Report unavailable</h1>
          <p>{error}</p>
        </section>
      </main>
    );
  }

  if (!report) {
    return (
      <main className="app-shell share-shell">
        <section className="panel shared-empty">
          <Loader2 className="spin" size={34} />
          <h1>Loading report</h1>
        </section>
      </main>
    );
  }

  const winner = report.variants.find((variant) => variant.asset.id === report.recommendation.winner_asset_id);

  return (
    <main className="app-shell share-shell">
      <section className="share-hero">
        <div>
          <p className="eyebrow">Stimli Decision Report</p>
          <h1>{report.recommendation.headline}</h1>
          <p className="subhead">{report.executive_summary}</p>
          <div className="confidence share-confidence">
            <Gauge size={18} />
            {Math.round(report.recommendation.confidence * 100)}% confidence
          </div>
        </div>
        {winner && (
          <div className="share-winner">
            <span>Recommended variant</span>
            <strong>{winner.asset.name}</strong>
            <b>{winner.analysis.scores.overall}</b>
          </div>
        )}
      </section>

      <section className="share-layout">
        <div className="panel">
          <div className="panel-heading">
            <ClipboardList size={19} />
            <h2>Decision Rationale</h2>
          </div>
          <div className="reason-list">
            {report.recommendation.reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <Target size={19} />
            <h2>Next Steps</h2>
          </div>
          <div className="reason-list">
            {report.next_steps.map((step) => (
              <p key={step}>{step}</p>
            ))}
          </div>
        </div>
      </section>

      <section className="variant-grid share-section">
        {report.variants.map((variant) => (
          <VariantCard key={variant.asset.id} variant={variant} />
        ))}
      </section>

      {winner && (
        <section className="panel share-section">
          <div className="panel-heading">
            <BarChart3 size={19} />
            <h2>Timeline Evidence</h2>
          </div>
          <Timeline timeline={winner.analysis.timeline} />
        </section>
      )}

      <section className="panel share-section">
        <div className="panel-heading">
          <Lightbulb size={19} />
          <h2>Recommended Edits</h2>
        </div>
        <div className="suggestion-list">
          {report.suggestions.map((suggestion, index) => (
            <ShareSuggestionCard
              key={`${suggestion.asset_id}-${suggestion.target}-${index}`}
              suggestion={suggestion}
              variants={report.variants}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function AuthPanel({
  session,
  busy,
  onRegister,
  onLogin,
  onLogout
}: {
  session: AuthSession | null;
  busy: boolean;
  onRegister: (input: { email: string; name: string; teamName: string }) => Promise<void>;
  onLogin: (email: string) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [teamName, setTeamName] = useState("");

  if (session?.authenticated && session.user && session.team) {
    return (
      <div className="auth-panel signed-in">
        <div>
          <span>
            <UserRound size={15} />
            {session.user.name}
          </span>
          <strong>
            <Building2 size={15} />
            {session.team.name}
          </strong>
        </div>
        <button className="icon-button" onClick={onLogout} disabled={busy} aria-label="Sign out">
          {busy ? <Loader2 className="spin" size={17} /> : <LogOut size={17} />}
        </button>
      </div>
    );
  }

  return (
    <div className="auth-panel">
      <div className="auth-tabs">
        <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")} disabled={busy}>
          Create
        </button>
        <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")} disabled={busy}>
          Sign in
        </button>
      </div>
      <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="email@company.com" />
      {mode === "register" && (
        <>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" />
          <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Team name" />
        </>
      )}
      <button
        className="button full"
        disabled={busy || !email.trim()}
        onClick={() =>
          mode === "register"
            ? onRegister({ email, name: displayName || email.split("@")[0], teamName: teamName || "Growth Team" })
            : onLogin(email)
        }
      >
        {busy ? <Loader2 className="spin" size={18} /> : <KeyRound size={18} />}
        Passkey
      </button>
    </div>
  );
}

function BillingPanel({
  billing,
  busy,
  onUpgrade,
  onPortal
}: {
  billing: BillingStatus;
  busy: boolean;
  onUpgrade: (plan: string) => Promise<void>;
  onPortal: () => Promise<void>;
}) {
  const growth = billing.plans.find((plan) => plan.id === "growth");
  const canUpgrade = billing.billing_configured && billing.commercial_use_enabled && Boolean(growth?.configured);
  const isPaid = billing.current_plan.id !== "research";
  return (
    <div className="billing-panel">
      <div>
        <span className={billing.license.mode === "commercial-ready" ? "ready" : "research"}>
          <ShieldCheck size={15} />
          {billing.license.mode === "commercial-ready" ? "Commercial ready" : "Research only"}
        </span>
        <strong>
          <CreditCard size={15} />
          {billing.current_plan.name}
        </strong>
        <small>
          {billing.current_plan.comparison_limit_per_hour}/hr decisions · {billing.current_plan.asset_limit_per_hour}/hr variants
        </small>
      </div>
      <button className="button full" disabled={busy || (!canUpgrade && !isPaid)} onClick={() => (isPaid ? onPortal() : onUpgrade("growth"))}>
        {busy ? <Loader2 className="spin" size={17} /> : <CreditCard size={17} />}
        {isPaid ? "Billing" : "Upgrade"}
      </button>
    </div>
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
      <span>
        <Gauge size={16} />
        {learning.calibration.evaluated_comparisons
          ? `${Math.round(learning.calibration.alignment_rate * 100)}% prediction alignment`
          : "Calibration pending"}
      </span>
    </div>
  );
}

function ProviderSnapshot({ providers }: { providers: BrainProviderHealth[] }) {
  const active = providers.find((provider) => provider.active) ?? providers[0];
  return (
    <div className="provider-snapshot">
      <strong>{active.provider}</strong>
      <span className={active.available ? "available" : "unavailable"}>{active.available ? "available" : "unavailable"}</span>
      <small>{active.detail}</small>
    </div>
  );
}

function ComparisonView(props: { comparison: Comparison; onOutcomeSaved: () => Promise<void>; onCancel: (comparisonId: string) => Promise<void> }) {
  if (props.comparison.status === "processing") {
    return <ProcessingComparison comparison={props.comparison} onCancel={props.onCancel} />;
  }
  if (props.comparison.status === "failed" || props.comparison.status === "cancelled") {
    return <FailedComparison comparison={props.comparison} />;
  }
  return <CompleteComparisonView comparison={props.comparison} onOutcomeSaved={props.onOutcomeSaved} />;
}

function ProcessingComparison({ comparison, onCancel }: { comparison: Comparison; onCancel: (comparisonId: string) => Promise<void> }) {
  const jobs = comparison.jobs ?? [];
  const [cancelBusy, setCancelBusy] = useState(false);
  return (
    <div className="results-stack">
      <section className="decision-band processing-band">
        <div>
          <p className="eyebrow">Analysis running</p>
          <h2>{comparison.recommendation.headline}</h2>
          <div className="confidence">
            <Loader2 className="spin" size={18} />
            {jobs.filter((job) => job.status === "complete").length}/{Math.max(jobs.length, comparison.variants.length)} variants ready
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading spread">
          <div className="inline-title">
            <Activity size={19} />
            <h2>Inference Jobs</h2>
          </div>
          <button
            className="button secondary"
            disabled={cancelBusy}
            onClick={async () => {
              setCancelBusy(true);
              await onCancel(comparison.id);
              setCancelBusy(false);
            }}
          >
            {cancelBusy ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            Cancel
          </button>
        </div>
        <div className="processing-list">
          {comparison.variants.map((variant) => {
            const job = jobs.find((item) => item.asset_id === variant.asset.id);
            return (
              <div className="processing-row" key={variant.asset.id}>
                <span>{variant.asset.name}</span>
                <strong className={`processing-status ${job?.status ?? variant.analysis.status}`}>{job?.status ?? variant.analysis.status}</strong>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function FailedComparison({ comparison }: { comparison: Comparison }) {
  return (
    <div className="results-stack">
      <section className="decision-band failed-band">
        <div>
          <p className="eyebrow">{comparison.status === "cancelled" ? "Analysis cancelled" : "Analysis failed"}</p>
          <h2>{comparison.recommendation.headline}</h2>
        </div>
      </section>
      <section className="panel">
        <div className="reason-list">
          {comparison.recommendation.reasons.length ? (
            comparison.recommendation.reasons.map((reason) => <p key={reason}>{reason}</p>)
          ) : (
            <p>The hosted inference job did not return a usable result.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function CompleteComparisonView({ comparison, onOutcomeSaved }: { comparison: Comparison; onOutcomeSaved: () => Promise<void> }) {
  const winner = comparison.variants.find((variant) => variant.asset.id === comparison.recommendation.winner_asset_id);
  const [reportBusy, setReportBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [challengerBusy, setChallengerBusy] = useState(false);
  const [challengerFocus, setChallengerFocus] = useState<"hook" | "cta" | "offer" | "clarity">("hook");
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
          JSON
        </button>
        <button className="button report-button" onClick={() => exportMarkdownReport(comparison.id, setReportBusy)} disabled={reportBusy}>
          {reportBusy ? <Loader2 className="spin" size={18} /> : <FileText size={18} />}
          Markdown
        </button>
        <button
          className="button report-button"
          onClick={async () => setShareUrl(await shareReport(comparison.id, setShareBusy))}
          disabled={shareBusy}
        >
          {shareBusy ? <Loader2 className="spin" size={18} /> : <Share2 size={18} />}
          Share
        </button>
        {shareUrl && (
          <a className="share-copy" href={shareUrl} target="_blank" rel="noreferrer">
            Link copied
          </a>
        )}
      </section>

      <section className="panel challenger-panel">
        <div className="panel-heading">
          <Sparkles size={19} />
          <h2>Create Challenger</h2>
        </div>
        <div className="challenger-controls">
          <label>
            Focus
            <select value={challengerFocus} onChange={(event) => setChallengerFocus(event.target.value as typeof challengerFocus)}>
              <option value="hook">Hook</option>
              <option value="offer">Offer</option>
              <option value="cta">CTA</option>
              <option value="clarity">Clarity</option>
            </select>
          </label>
          <button
            className="button"
            disabled={challengerBusy}
            onClick={async () => {
              setChallengerBusy(true);
              try {
                await createChallenger(comparison.id, {
                  source_asset_id: comparison.recommendation.winner_asset_id,
                  focus: challengerFocus
                });
                await onOutcomeSaved();
              } finally {
                setChallengerBusy(false);
              }
            }}
          >
            {challengerBusy ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            Draft next variant
          </button>
        </div>
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

async function exportMarkdownReport(comparisonId: string, setBusy: (value: boolean) => void) {
  setBusy(true);
  try {
    const report = await getReportMarkdown(comparisonId);
    const blob = new Blob([report], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `stimli-report-${comparisonId}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  } finally {
    setBusy(false);
  }
}

async function shareReport(comparisonId: string, setBusy: (value: boolean) => void): Promise<string> {
  setBusy(true);
  try {
    const link = await createShareLink(comparisonId);
    await navigator.clipboard?.writeText(link.url);
    return link.url;
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
      {suggestion.draft_revision && <p className="draft">{suggestion.draft_revision}</p>}
      <small>{suggestion.expected_effect}</small>
    </article>
  );
}

function ShareSuggestionCard({ suggestion, variants }: { suggestion: Suggestion; variants: VariantResult[] }) {
  const asset = variants.find((variant) => variant.asset.id === suggestion.asset_id)?.asset;
  return (
    <article className={`suggestion ${suggestion.severity}`}>
      <div>
        <span>{suggestion.severity}</span>
        <strong>{asset?.name ?? "Variant"}</strong>
      </div>
      <h3>{suggestion.target}</h3>
      <p>{suggestion.issue}</p>
      <p className="edit">{suggestion.suggested_edit}</p>
      {suggestion.draft_revision && <p className="draft">{suggestion.draft_revision}</p>}
      <small>{suggestion.expected_effect}</small>
    </article>
  );
}

function getShareToken(): string | null {
  const match = window.location.pathname.match(/^\/share\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}
