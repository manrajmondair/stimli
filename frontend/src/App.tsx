import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Building2,
  Check,
  ClipboardList,
  CreditCard,
  Database,
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
  Repeat2,
  Send,
  Share2,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Upload,
  UserPlus,
  UserRound
} from "lucide-react";
import {
  acceptInvite,
  cancelComparison,
  createBriefComparisonForProject,
  createBrandProfile,
  createDeletionRequest,
  createChallenger,
  createImportJob,
  createOutcome,
  createProject,
  createShareLink,
  createTeamInvite,
  createTextAsset,
  exportWorkspace,
  getAdminSummary,
  getBillingStatus,
  getBrainProviders,
  getComparison,
  getGovernancePolicy,
  getLearningSummary,
  getReport,
  getReportMarkdown,
  getInvite,
  getSharedReport,
  getSession,
  getValidationCalibration,
  listAdminJobs,
  listProjects,
  listAuditEvents,
  listBrandProfiles,
  listGovernanceRequests,
  listImportJobs,
  listLibraryAssets,
  listTeamMembers,
  loginWithPasskey,
  logout,
  listAssets,
  listComparisons,
  openBillingPortal,
  registerWithPasskey,
  retryAdminJob,
  runValidationBenchmark,
  seedDemo,
  startCheckout,
  switchTeam
} from "./api";
import type {
  AdminSummary,
  Asset,
  AuthSession,
  AssetType,
  AuditEvent,
  BenchmarkRun,
  BillingStatus,
  BrandProfile,
  BrainProviderHealth,
  Comparison,
  CreativeBrief,
  GovernancePolicy,
  GovernanceRequest,
  ImportJob,
  LibraryAsset,
  LearningSummary,
  OutcomeCreate,
  Project,
  Report,
  ScoreBreakdown,
  Suggestion,
  TeamInvite,
  TeamMember,
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
  const inviteToken = getInviteToken();
  const path = window.location.pathname;
  if (window.location.pathname === "/legal") {
    return <LegalPage />;
  }
  if (inviteToken) {
    return <InvitePage token={inviteToken} />;
  }
  if (shareToken) {
    return <SharedReportPage token={shareToken} />;
  }
  return path === "/app" || path.startsWith("/app/") ? <WorkspaceApp /> : <LandingPage />;
}

function LandingPage() {
  return (
    <main className="landing-shell">
      <nav className="landing-nav">
        <a className="brand-mark" href="/">
          <span>St</span>
          Stimli
        </a>
        <div>
          <a href="#product">Product</a>
          <a href="#inputs">Inputs</a>
          <a href="#sample-report">Sample report</a>
          <a href="/legal">Trust</a>
        </div>
        <a className="nav-cta" href="/app">
          Start free
        </a>
      </nav>

      <section className="landing-hero">
        <div className="hero-copy">
          <h1>Creative testing before ad spend.</h1>
          <p>
            Compare scripts, landing pages, images, audio, and video. Stimli gives you a winner, the evidence, and the
            edits to make before a campaign burns budget.
          </p>
          <div className="landing-actions">
            <a className="button primary" href="/app">
              <Play size={18} />
              Start free
            </a>
            <a className="button ghost" href="#sample-report">
              <FileText size={18} />
              Sample report
            </a>
          </div>
        </div>
        <LandingProductScene />
      </section>

      <section className="landing-section proof-strip" aria-label="Stimli product details">
        <p>Free to start</p>
        <p>TRIBE-backed signals</p>
        <p>Private uploads</p>
        <p>Passkey accounts</p>
      </section>

      <section className="landing-section product-section" id="product">
        <div>
          <h2>One answer. Then the edit list.</h2>
        </div>
        <div className="workflow-grid" id="how-it-works">
          <article>
            <h3>Upload variants</h3>
            <p>Bring scripts, landing pages, static creative, audio, or short video into one comparison set.</p>
          </article>
          <article>
            <h3>Predict response</h3>
            <p>Blend brain-response timelines with hook, pacing, CTA, brand cue, offer, and clarity scoring.</p>
          </article>
          <article>
            <h3>Ship or edit</h3>
            <p>Get the winner, the confidence, and concrete edits your team can apply before buying media.</p>
          </article>
        </div>
      </section>

      <section className="landing-section multimodal-section" id="inputs">
        <div>
          <h2>Not just video. Not just copy.</h2>
        </div>
        <div className="input-matrix">
          {["Script", "Landing page", "Static creative", "Audio", "Video"].map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      </section>

      <section className="landing-section trust-section">
        <div>
          <h2>Built to be used, not watched in a demo.</h2>
        </div>
        <div className="trust-grid">
          <article>
            <strong>Passkey accounts</strong>
            <p>No paid auth provider required. Sessions and teams live in Postgres.</p>
          </article>
          <article>
            <strong>Private uploads</strong>
            <p>Media goes to private Blob storage and is hidden from public report payloads.</p>
          </article>
          <article>
            <strong>Free-tier controls</strong>
            <p>Conservative quotas, one Modal container, and billing disabled until deliberately configured.</p>
          </article>
        </div>
      </section>

      <section className="landing-section report-preview" id="sample-report">
        <div>
          <h2>Reports your team can actually act on.</h2>
          <p>
            Reports package the winner, score deltas, timeline evidence, and edit cards into a shareable artifact for
            creative, growth, and founder review.
          </p>
          <a className="button secondary" href="/app">
            Run your first comparison
          </a>
        </div>
        <div className="report-card">
          <p>Recommendation</p>
          <h3>Ship Variant A with one CTA edit</h3>
          <div className="report-score-row">
            <b>84</b>
            <p>Variant A wins on hook strength, memory, and offer clarity. CTA is late by 4 seconds.</p>
          </div>
          <div className="report-edits">
            <p>Move offer into first 3 seconds.</p>
            <p>Show brand cue before proof claim.</p>
            <p>Replace generic close with starter-kit CTA.</p>
          </div>
        </div>
      </section>

      <section className="landing-final">
        <h2>Know what deserves budget.</h2>
        <a className="button primary" href="/app">
          Start free
        </a>
      </section>
    </main>
  );
}

function LandingProductScene() {
  const bars = [
    [88, 70, 30],
    [76, 78, 42],
    [92, 82, 36],
    [80, 86, 44],
    [68, 72, 52],
    [74, 80, 38]
  ];
  return (
    <div className="product-scene" role="img" aria-label="Stimli creative comparison preview">
      <div className="scene-window">
        <div className="scene-toolbar">
          <p>Stimli</p>
          <strong>Decision ready</strong>
        </div>
        <div className="scene-decision">
          <h2>Ship Variant A</h2>
          <div>
            <b>84</b>
            <p>92% confidence</p>
          </div>
        </div>
        <div className="scene-grid">
          <article className="scene-variant winner">
            <p>Variant A</p>
            <strong>Pain-led hook</strong>
            <em>+14 pts ahead</em>
          </article>
          <article className="scene-variant">
            <p>Variant B</p>
            <strong>Generic product story</strong>
            <em>Revise hook</em>
          </article>
        </div>
        <div className="scene-timeline">
          {bars.map(([attention, memory, load], index) => (
            <div key={index}>
              <i style={{ height: `${attention}%` }} />
              <i style={{ height: `${memory}%` }} />
              <i style={{ height: `${load}%` }} />
            </div>
          ))}
        </div>
        <div className="scene-edits">
          <p>Move the offer into the first 3 seconds.</p>
          <p>Add brand cue before the proof claim.</p>
        </div>
      </div>
    </div>
  );
}

function WorkspaceApp() {
  const [view, setView] = useState<"workbench" | "observability" | "governance" | "validation" | "brands" | "library" | "imports">(
    "workbench"
  );
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
  const [adminSummary, setAdminSummary] = useState<AdminSummary | null>(null);
  const [adminJobs, setAdminJobs] = useState<NonNullable<Comparison["jobs"]>>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [brandProfiles, setBrandProfiles] = useState<BrandProfile[]>([]);
  const [selectedBrandProfileId, setSelectedBrandProfileId] = useState<string>("");
  const [governancePolicy, setGovernancePolicy] = useState<GovernancePolicy | null>(null);
  const [governanceRequests, setGovernanceRequests] = useState<GovernanceRequest[]>([]);
  const [validation, setValidation] = useState<Awaited<ReturnType<typeof getValidationCalibration>> | null>(null);
  const [benchmarkRuns, setBenchmarkRuns] = useState<BenchmarkRun[]>([]);
  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([]);
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
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
  const [profileName, setProfileName] = useState("");
  const [profileVoiceRules, setProfileVoiceRules] = useState("specific before abstract, proof before promise");
  const [importText, setImportText] = useState("Variant A,Stop weak hooks before launch. Try the starter kit today.");
  const [deletionTarget, setDeletionTarget] = useState("");
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
  const activeProjectName =
    selectedProjectId === "all" ? "All projects" : projects.find((project) => project.id === selectedProjectId)?.name ?? "Project";
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
      const [brands, library, imports] = await Promise.all([listBrandProfiles(), listLibraryAssets(), listImportJobs().catch(() => [])]);
      setBrandProfiles(brands);
      setLibraryAssets(library.assets);
      setImportJobs(imports);
      const guarded = await Promise.allSettled([
        getAdminSummary(),
        listAdminJobs(),
        listAuditEvents(),
        listTeamMembers(),
        getGovernancePolicy(),
        listGovernanceRequests(),
        getValidationCalibration()
      ]);
      if (guarded[0].status === "fulfilled") setAdminSummary(guarded[0].value);
      if (guarded[1].status === "fulfilled") setAdminJobs(guarded[1].value || []);
      if (guarded[2].status === "fulfilled") setAuditEvents(guarded[2].value);
      if (guarded[3].status === "fulfilled") setTeamMembers(guarded[3].value);
      if (guarded[4].status === "fulfilled") setGovernancePolicy(guarded[4].value);
      if (guarded[5].status === "fulfilled") setGovernanceRequests(guarded[5].value);
      if (guarded[6].status === "fulfilled") {
        setValidation(guarded[6].value);
        setBenchmarkRuns(guarded[6].value.benchmark_runs);
      }
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

  async function handleSwitchTeam(teamId: string) {
    setAuthBusy(true);
    setError(null);
    try {
      const nextSession = await switchTeam(teamId);
      setSession(nextSession);
      setSelected([]);
      setComparison(null);
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch teams.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleCreateInvite(email: string): Promise<string> {
    setAuthBusy(true);
    setError(null);
    try {
      const invite = await createTeamInvite({ email, role: "analyst" });
      if (invite.url) {
        await navigator.clipboard?.writeText(invite.url);
      }
      return invite.url || "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create invite.");
      return "";
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

  async function handleSaveBrandProfile() {
    const nextName = profileName.trim() || brandName.trim();
    if (!nextName) {
      setError("Add a brand profile name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const profile = await createBrandProfile({
        name: nextName,
        brief,
        voice_rules: splitList(profileVoiceRules),
        compliance_notes: []
      });
      setBrandProfiles([profile, ...brandProfiles]);
      setSelectedBrandProfileId(profile.id);
      setProfileName("");
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save brand profile.");
    } finally {
      setBusy(false);
    }
  }

  async function handleImportRows() {
    const rows = importText
      .split("\n")
      .map((row) => row.trim())
      .filter(Boolean)
      .map((row) => {
        const [namePart, ...textParts] = row.split(",");
        return { asset_type: "script" as AssetType, name: namePart?.trim(), text: textParts.join(",").trim() };
      })
      .filter((row) => row.name && row.text);
    if (!rows.length) {
      setError("Add import rows as Name,Creative text.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createImportJob({ platform: "csv", source: "paste", project_id: activeProjectId, items: rows });
      setAssets([...result.assets, ...assets]);
      setImportJobs([result.job, ...importJobs]);
      setImportText("");
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import assets.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletionRequest() {
    if (!deletionTarget.trim()) {
      setError("Add an asset, project, comparison, or user id.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const request = await createDeletionRequest({
        target_type: deletionTarget.startsWith("cmp_") ? "comparison" : deletionTarget.startsWith("project_") ? "project" : "asset",
        target_id: deletionTarget.trim(),
        reason: "Workspace governance review"
      });
      setGovernanceRequests([request, ...governanceRequests]);
      setDeletionTarget("");
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create deletion request.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRunBenchmark() {
    setBusy(true);
    setError(null);
    try {
      const run = await runValidationBenchmark();
      setBenchmarkRuns([run, ...benchmarkRuns]);
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run benchmark.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRetryJob(jobId: string) {
    setBusy(true);
    setError(null);
    try {
      const retried = await retryAdminJob(jobId);
      setComparison(retried);
      void pollComparison(retried.id);
      await refreshWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not retry job.");
    } finally {
      setBusy(false);
    }
  }

  async function handleExportWorkspace() {
    setBusy(true);
    setError(null);
    try {
      const exported = await exportWorkspace();
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `stimli-workspace-${exported.workspace_id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export workspace.");
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
      const nextComparison = await createBriefComparisonForProject(
        selected,
        objective,
        brief,
        activeProjectId,
        selectedBrandProfileId || null
      );
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
      <AppHeader session={session} projectName={activeProjectName} />
      <EnterpriseNav view={view} onChange={setView} />

      {view === "workbench" ? (
        <>
      <section className="top-band app-intro">
        <div>
          <p className="eyebrow">Creative command center</p>
          <h1>Compare variants, pick the winner, and ship the edit list.</h1>
          <p className="subhead">
            A compact workspace for multimodal uploads, TRIBE-backed response signals, project history, and shareable decision reports.
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
            onSwitchTeam={handleSwitchTeam}
            onInvite={handleCreateInvite}
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

      {error && (
        <div className="notice" role="alert" aria-live="polite">
          {error}
        </div>
      )}

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
              Saved profile
              <select value={selectedBrandProfileId} onChange={(event) => setSelectedBrandProfileId(event.target.value)}>
                <option value="">Use manual brief</option>
                {brandProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
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
              <EmptyState onSeed={handleSeed} busy={busy} />
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
        </>
      ) : (
        <EnterpriseView
          view={view}
          session={session}
          adminSummary={adminSummary}
          adminJobs={adminJobs}
          auditEvents={auditEvents}
          teamMembers={teamMembers}
          brandProfiles={brandProfiles}
          selectedBrandProfileId={selectedBrandProfileId}
          onSelectBrandProfile={setSelectedBrandProfileId}
          governancePolicy={governancePolicy}
          governanceRequests={governanceRequests}
          validation={validation}
          benchmarkRuns={benchmarkRuns}
          libraryAssets={libraryAssets}
          importJobs={importJobs}
          profileName={profileName}
          setProfileName={setProfileName}
          profileVoiceRules={profileVoiceRules}
          setProfileVoiceRules={setProfileVoiceRules}
          importText={importText}
          setImportText={setImportText}
          deletionTarget={deletionTarget}
          setDeletionTarget={setDeletionTarget}
          busy={busy}
          onSaveBrandProfile={handleSaveBrandProfile}
          onImportRows={handleImportRows}
          onDeletionRequest={handleDeletionRequest}
          onRunBenchmark={handleRunBenchmark}
          onRetryJob={handleRetryJob}
          onExportWorkspace={handleExportWorkspace}
          onRefresh={refreshWorkspace}
        />
      )}

      <footer className="app-footer">
        <a href="/legal">Legal & license</a>
      </footer>
    </main>
  );
}

function EnterpriseNav({
  view,
  onChange
}: {
  view: "workbench" | "observability" | "governance" | "validation" | "brands" | "library" | "imports";
  onChange: (view: "workbench" | "observability" | "governance" | "validation" | "brands" | "library" | "imports") => void;
}) {
  const items = [
    ["workbench", Layers, "Workbench"],
    ["observability", Activity, "Observability"],
    ["governance", ShieldCheck, "Governance"],
    ["validation", BarChart3, "Validation"],
    ["brands", ClipboardList, "Brands"],
    ["library", Database, "Library"],
    ["imports", Upload, "Imports"]
  ] as const;
  return (
    <nav className="enterprise-nav" aria-label="Workspace sections">
      {items.map(([id, Icon, label]) => (
        <button key={id} className={view === id ? "active" : ""} onClick={() => onChange(id)}>
          <Icon size={16} />
          {label}
        </button>
      ))}
    </nav>
  );
}

function EnterpriseView({
  view,
  session,
  adminSummary,
  adminJobs,
  auditEvents,
  teamMembers,
  brandProfiles,
  selectedBrandProfileId,
  onSelectBrandProfile,
  governancePolicy,
  governanceRequests,
  validation,
  benchmarkRuns,
  libraryAssets,
  importJobs,
  profileName,
  setProfileName,
  profileVoiceRules,
  setProfileVoiceRules,
  importText,
  setImportText,
  deletionTarget,
  setDeletionTarget,
  busy,
  onSaveBrandProfile,
  onImportRows,
  onDeletionRequest,
  onRunBenchmark,
  onRetryJob,
  onExportWorkspace,
  onRefresh
}: {
  view: "observability" | "governance" | "validation" | "brands" | "library" | "imports";
  session: AuthSession | null;
  adminSummary: AdminSummary | null;
  adminJobs: NonNullable<Comparison["jobs"]>;
  auditEvents: AuditEvent[];
  teamMembers: TeamMember[];
  brandProfiles: BrandProfile[];
  selectedBrandProfileId: string;
  onSelectBrandProfile: (id: string) => void;
  governancePolicy: GovernancePolicy | null;
  governanceRequests: GovernanceRequest[];
  validation: Awaited<ReturnType<typeof getValidationCalibration>> | null;
  benchmarkRuns: BenchmarkRun[];
  libraryAssets: LibraryAsset[];
  importJobs: ImportJob[];
  profileName: string;
  setProfileName: (value: string) => void;
  profileVoiceRules: string;
  setProfileVoiceRules: (value: string) => void;
  importText: string;
  setImportText: (value: string) => void;
  deletionTarget: string;
  setDeletionTarget: (value: string) => void;
  busy: boolean;
  onSaveBrandProfile: () => Promise<void>;
  onImportRows: () => Promise<void>;
  onDeletionRequest: () => Promise<void>;
  onRunBenchmark: () => Promise<void>;
  onRetryJob: (jobId: string) => Promise<void>;
  onExportWorkspace: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  if (!session?.authenticated && ["observability", "governance", "validation"].includes(view)) {
    return (
      <section className="panel enterprise-empty">
        <ShieldCheck size={24} />
        <h2>Sign in to use enterprise controls</h2>
        <p>Admin, governance, and validation surfaces are scoped to authenticated team workspaces.</p>
      </section>
    );
  }

  if (view === "observability") {
    return (
      <section className="enterprise-view">
        <div className="enterprise-toolbar">
          <div>
            <h1>Observability</h1>
            <p>Hosted inference, extraction, storage, jobs, and audit activity.</p>
          </div>
          <button className="button secondary" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={17} />
            Refresh
          </button>
        </div>
        <div className="ops-grid">
          <Metric label="Jobs" value={adminSummary?.jobs.total ?? adminJobs.length} />
          <Metric label="Failed" value={adminSummary?.jobs.failed ?? 0} />
          <Metric label="Storage" value={adminSummary?.storage.persistent ? "Postgres" : "Memory"} />
          <Metric label="TRIBE" value={adminSummary?.inference.control_configured ? "Control ready" : "Not configured"} />
        </div>
        <div className="enterprise-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Asset</th>
                <th>Status</th>
                <th>Provider</th>
                <th>Attempt</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {adminJobs.length ? (
                adminJobs.map((job) => (
                  <tr key={job.job_id}>
                    <td>{job.job_id}</td>
                    <td>{job.asset_id}</td>
                    <td>{job.status}</td>
                    <td>{job.provider}</td>
                    <td>{job.attempt ?? 0}</td>
                    <td>
                      {["failed", "cancelled"].includes(job.status) && (
                        <button className="text-button" onClick={() => onRetryJob(job.job_id)}>
                          <Repeat2 size={15} />
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6}>No hosted inference jobs yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <AuditTable events={auditEvents} />
      </section>
    );
  }

  if (view === "governance") {
    return (
      <section className="enterprise-view">
        <div className="enterprise-toolbar">
          <div>
            <h1>Governance</h1>
            <p>Workspace export, retention, deletion review, members, and license posture.</p>
          </div>
          <button className="button secondary" onClick={onExportWorkspace} disabled={busy}>
            <Download size={17} />
            Export
          </button>
        </div>
        <div className="ops-grid">
          <Metric label="Retention" value={`${governancePolicy?.retention_days ?? 365} days`} />
          <Metric label="Sharing" value={governancePolicy?.public_share_links ? "Enabled" : "Disabled"} />
          <Metric label="License" value={governancePolicy?.commercial_license_mode ?? "research-only"} />
          <Metric label="Requests" value={governanceRequests.length} />
        </div>
        <div className="enterprise-split">
          <section className="panel compact-panel">
            <h2>Deletion Review</h2>
            <label>
              Target id
              <input value={deletionTarget} onChange={(event) => setDeletionTarget(event.target.value)} placeholder="asset_..." />
            </label>
            <button className="button full" onClick={onDeletionRequest} disabled={busy || !deletionTarget.trim()}>
              <ShieldCheck size={17} />
              Request review
            </button>
          </section>
          <section className="enterprise-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Email</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {teamMembers.map((member) => (
                  <tr key={member.user_id}>
                    <td>{member.name || member.user_id}</td>
                    <td>{member.email || "-"}</td>
                    <td>{member.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </section>
    );
  }

  if (view === "validation") {
    return (
      <section className="enterprise-view">
        <div className="enterprise-toolbar">
          <div>
            <h1>Validation</h1>
            <p>Prediction accuracy, confidence calibration, and benchmark checks.</p>
          </div>
          <button className="button secondary" onClick={onRunBenchmark} disabled={busy}>
            <Play size={17} />
            Run benchmark
          </button>
        </div>
        <div className="ops-grid">
          <Metric label="Outcomes" value={validation?.learning.outcome_count ?? 0} />
          <Metric label="Alignment" value={`${Math.round((validation?.learning.calibration.alignment_rate ?? 0) * 100)}%`} />
          <Metric label="Benchmarks" value={benchmarkRuns.length} />
          <Metric label="Revenue" value={`$${validation?.learning.total_revenue ?? 0}`} />
        </div>
        <section className="enterprise-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Benchmark</th>
                <th>Accuracy</th>
                <th>Confidence</th>
                <th>Cases</th>
              </tr>
            </thead>
            <tbody>
              {benchmarkRuns.length ? (
                benchmarkRuns.map((run) => (
                  <tr key={run.id}>
                    <td>{run.benchmark_name}</td>
                    <td>{Math.round(run.accuracy * 100)}%</td>
                    <td>{Math.round(run.average_confidence * 100)}%</td>
                    <td>{run.case_count}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4}>Run the built-in DTC benchmark to create a validation baseline.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </section>
    );
  }

  if (view === "brands") {
    return (
      <section className="enterprise-view">
        <div className="enterprise-toolbar">
          <div>
            <h1>Brand Profiles</h1>
            <p>Reusable briefs, claims, forbidden terms, and voice rules for comparison scoring.</p>
          </div>
        </div>
        <div className="enterprise-split">
          <section className="panel compact-panel">
            <h2>Save Current Brief</h2>
            <label>
              Profile name
              <input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Lumina paid social" />
            </label>
            <label>
              Voice rules
              <textarea value={profileVoiceRules} onChange={(event) => setProfileVoiceRules(event.target.value)} />
            </label>
            <button className="button full" onClick={onSaveBrandProfile} disabled={busy}>
              <Plus size={17} />
              Save profile
            </button>
          </section>
          <section className="enterprise-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Audience</th>
                  <th>Offer</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {brandProfiles.map((profile) => (
                  <tr key={profile.id}>
                    <td>{profile.name}</td>
                    <td>{profile.brief.audience || "-"}</td>
                    <td>{profile.brief.primary_offer || "-"}</td>
                    <td>
                      <button className="text-button" onClick={() => onSelectBrandProfile(profile.id)}>
                        {selectedBrandProfileId === profile.id ? "Selected" : "Use"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </section>
    );
  }

  if (view === "imports") {
    return (
      <section className="enterprise-view">
        <div className="enterprise-toolbar">
          <div>
            <h1>Imports</h1>
            <p>Bulk creative intake for CSV rows, ad-platform exports, transcripts, and URL lists.</p>
          </div>
        </div>
        <div className="enterprise-split">
          <section className="panel compact-panel">
            <h2>Paste Rows</h2>
            <textarea value={importText} onChange={(event) => setImportText(event.target.value)} />
            <button className="button full" onClick={onImportRows} disabled={busy || !importText.trim()}>
              <Upload size={17} />
              Import
            </button>
          </section>
          <section className="enterprise-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Imported</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {importJobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.platform}</td>
                    <td>{job.status}</td>
                    <td>{job.imported_items}</td>
                    <td>{job.failed_items}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </section>
    );
  }

  return (
    <section className="enterprise-view">
      <div className="enterprise-toolbar">
        <div>
          <h1>Creative Library</h1>
          <p>Workspace assets with extraction status, source, and reusable creative text.</p>
        </div>
      </div>
      <section className="enterprise-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Source</th>
              <th>Text</th>
              <th>Extraction</th>
            </tr>
          </thead>
          <tbody>
            {libraryAssets.map((asset) => (
              <tr key={asset.id}>
                <td>{asset.name}</td>
                <td>{asset.type.replace("_", " ")}</td>
                <td>{asset.library.source}</td>
                <td>{asset.library.text_length} chars</td>
                <td>{asset.library.extraction_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AuditTable({ events }: { events: AuditEvent[] }) {
  return (
    <section className="enterprise-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Event</th>
            <th>Actor</th>
            <th>Target</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {events.length ? (
            events.slice(0, 12).map((event) => (
              <tr key={event.id}>
                <td>{event.action}</td>
                <td>{event.actor_email || "workspace"}</td>
                <td>{event.target_id || event.target_type}</td>
                <td>{new Date(event.created_at).toLocaleString()}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={4}>No audit events yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function LegalPage() {
  const [billing, setBilling] = useState<BillingStatus | null>(null);

  useEffect(() => {
    getBillingStatus().then(setBilling).catch(() => setBilling(null));
  }, []);

  return (
    <main className="app-shell legal-shell">
      <section className="legal-hero">
        <p className="eyebrow">Legal & license</p>
        <h1>Stimli production controls</h1>
        <p className="subhead">
          The app separates research-only brain-response inference from commercial plan access, billing, and team data controls.
        </p>
      </section>

      <section className="legal-grid">
        <article className="panel">
          <div className="panel-heading">
            <ShieldCheck size={19} />
            <h2>Inference License</h2>
          </div>
          <div className="reason-list">
            <p>Current provider: {billing?.license.provider ?? "checking"}</p>
            <p>Mode: {billing?.license.mode ?? "checking"}</p>
            <p>Commercial plan checkout is blocked unless a commercial brain-response provider or commercial TRIBE rights are configured.</p>
          </div>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <CreditCard size={19} />
            <h2>Billing Controls</h2>
          </div>
          <div className="reason-list">
            <p>Billing configured: {billing?.billing_configured ? "yes" : "no"}</p>
            <p>Research plan limits remain active until Stripe price IDs and webhook signing are configured.</p>
            <p>Subscription webhooks update team plan, billing status, customer ID, and subscription ID server-side.</p>
          </div>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <KeyRound size={19} />
            <h2>Accounts & Data</h2>
          </div>
          <div className="reason-list">
            <p>Passkey sessions use HTTP-only cookies. Team workspaces scope assets, projects, comparisons, outcomes, and private uploads.</p>
            <p>Anonymous trial workspaces are rate-limited and identified by a local workspace key.</p>
            <p>Private creative files are uploaded to Vercel Blob and are not exposed in public API payloads.</p>
          </div>
        </article>
      </section>
    </main>
  );
}

function InvitePage({ token }: { token: string }) {
  const [invite, setInvite] = useState<TeamInvite | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([getInvite(token), getSession()])
      .then(([nextInvite, nextSession]) => {
        setInvite(nextInvite);
        setSession(nextSession);
        if (nextInvite.email) {
          setEmail(nextInvite.email);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Invite is unavailable."));
  }, [token]);

  async function authenticate() {
    setBusy(true);
    setError(null);
    try {
      const nextSession =
        mode === "register"
          ? await registerWithPasskey({
              email,
              name: displayName || email.split("@")[0],
              teamName: `${displayName || email.split("@")[0]}'s Team`
            })
          : await loginWithPasskey(email);
      setSession(nextSession);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not authenticate.");
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(token);
      window.location.assign("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept invite.");
      setBusy(false);
    }
  }

  return (
    <main className="app-shell invite-shell">
      <section className="panel invite-card">
        <p className="eyebrow">Team invite</p>
        <h1>{invite ? `Join ${invite.team_name}` : "Loading invite"}</h1>
        {error && <div className="notice compact">{error}</div>}
        {invite && (
          <div className="reason-list">
            <p>Role: {invite.role}</p>
            <p>Expires: {new Date(invite.expires_at).toLocaleDateString()}</p>
          </div>
        )}
        {session?.authenticated ? (
          <button className="button full" disabled={busy || !invite} onClick={accept}>
            {busy ? <Loader2 className="spin" size={18} /> : <UserPlus size={18} />}
            Accept invite
          </button>
        ) : (
          <div className="auth-panel invite-auth">
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
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" />
            )}
            <button className="button full" disabled={busy || !email.trim()} onClick={authenticate}>
              {busy ? <Loader2 className="spin" size={18} /> : <KeyRound size={18} />}
              Passkey
            </button>
          </div>
        )}
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
  onLogout,
  onSwitchTeam,
  onInvite
}: {
  session: AuthSession | null;
  busy: boolean;
  onRegister: (input: { email: string; name: string; teamName: string }) => Promise<void>;
  onLogin: (email: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onSwitchTeam: (teamId: string) => Promise<void>;
  onInvite: (email: string) => Promise<string>;
}) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");

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
          {session.teams.length > 1 && (
            <select value={session.team.id} onChange={(event) => onSwitchTeam(event.target.value)} disabled={busy}>
              {session.teams.map((team) => (
                <option value={team.id} key={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          )}
          <div className="invite-row">
            <input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="teammate@company.com" />
            <button
              className="icon-button"
              disabled={busy}
              aria-label="Copy team invite"
              onClick={async () => setInviteUrl(await onInvite(inviteEmail))}
            >
              {busy ? <Loader2 className="spin" size={17} /> : <UserPlus size={17} />}
            </button>
          </div>
          {inviteUrl && (
            <a href={inviteUrl} target="_blank" rel="noreferrer">
              Invite copied
            </a>
          )}
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

function AppHeader({ session, projectName }: { session: AuthSession | null; projectName: string }) {
  return (
    <header className="app-header">
      <a className="brand-mark app-brand" href="/">
        <span>St</span>
        Stimli
      </a>
      <div className="app-context">
        <span>
          Team
          <strong>{session?.team?.name ?? "Trial workspace"}</strong>
        </span>
        <span>
          Project
          <strong>{projectName}</strong>
        </span>
      </div>
      <nav>
        <a href="/">Landing</a>
        <a href="/legal">Trust</a>
      </nav>
    </header>
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

function EmptyState({ onSeed, busy }: { onSeed?: () => Promise<void>; busy?: boolean }) {
  return (
    <div className="empty-state">
      <FileText size={34} />
      <h3>Start with your first comparison.</h3>
      <p>Add variants manually or load a realistic skincare launch set to see the full recommendation flow.</p>
      <div className="empty-examples">
        <span>Variant A: pain-led hook</span>
        <span>Variant B: proof-led hook</span>
      </div>
      {onSeed && (
        <button className="button secondary" onClick={onSeed} disabled={busy}>
          {busy ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
          Load demo assets
        </button>
      )}
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
  const [reportNotice, setReportNotice] = useState("");
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
        <button
          className="button report-button"
          onClick={async () => {
            await exportReport(comparison.id, setReportBusy);
            setReportNotice("JSON report downloaded");
          }}
          disabled={reportBusy}
        >
          {reportBusy ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
          JSON
        </button>
        <button
          className="button report-button"
          onClick={async () => {
            await exportMarkdownReport(comparison.id, setReportBusy);
            setReportNotice("Markdown report downloaded");
          }}
          disabled={reportBusy}
        >
          {reportBusy ? <Loader2 className="spin" size={18} /> : <FileText size={18} />}
          Markdown
        </button>
        <button
          className="button report-button"
          onClick={async () => {
            setShareUrl(await shareReport(comparison.id, setShareBusy));
            setReportNotice("Share link copied");
          }}
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
        {reportNotice && <span className="report-notice">{reportNotice}</span>}
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

function getInviteToken(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([^/]+)$/);
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
