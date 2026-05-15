import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useClerk, UserButton, useUser } from "@clerk/clerk-react";
import {
  acceptInvite,
  createBrandProfile,
  createTeamInvite,
  deleteAsset,
  deleteBrandProfile,
  exportBrandProfile,
  getInvite,
  getLearningSummary,
  getSession,
  getSharedReport,
  listAuditEvents,
  listBrandProfiles,
  listComparisons,
  listLibraryAssets,
  listTeamInvites,
  listTeamMembers,
  listWorkspaceOutcomes,
  removeTeamMember,
  revokeTeamInvite,
  updateBrandProfile,
  updateTeamMemberRole
} from "./api";
import type {
  AssetType,
  AuditEvent,
  AuthSession,
  BrandProfile,
  Comparison,
  CreativeBrief,
  LearningSummary,
  LibraryAsset,
  OutcomeCreate,
  Report,
  TeamInvite,
  TeamMember,
  TeamRole,
  WorkspaceOutcome
} from "./types";
import { BrainBlob } from "./art";
import { Workbench } from "./Workbench";

const DEFAULT_BRAND_KEY = "stimli.default_brand_profile";

const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  script: "Script",
  landing_page: "Landing page",
  image: "Static ad",
  audio: "Audio",
  video: "Video"
};
const ASSET_TYPE_ORDER: AssetType[] = ["script", "landing_page", "image", "audio", "video"];

type ToastKind = "info" | "success" | "error";
type ToastState = { id: number; kind: ToastKind; message: string };

function useLocalToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  function show(kind: ToastKind, message: string) {
    const id = Date.now();
    setToast({ id, kind, message });
    window.setTimeout(() => {
      setToast((current) => (current && current.id === id ? null : current));
    }, 4500);
  }
  return { toast, show, dismiss: () => setToast(null) } as const;
}

function ToastBar({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  if (!toast) return null;
  const bg =
    toast.kind === "success"
      ? "var(--pistachio-ink)"
      : toast.kind === "error"
      ? "var(--tomato-ink)"
      : "var(--ink)";
  return (
    <div className="error-toast" style={{ background: bg }} role="status" aria-live="polite">
      <span>{toast.message}</span>
      <button onClick={onDismiss}>×</button>
    </div>
  );
}

function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  confirmKind = "danger",
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  confirmKind?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;
  return (
    <div className="auth-overlay" onClick={onCancel} role="presentation">
      <div
        className="auth-modal confirm-modal"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        <div className="lead">{message}</div>
        <div className="form-actions" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={confirmKind === "danger" ? "btn primary danger" : "btn primary"}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

type View = "workbench" | "library" | "brands" | "outcomes" | "team";

const NAV_ITEMS: Array<{ id: View; label: string; color: string }> = [
  { id: "workbench", label: "Workbench", color: "var(--tomato)" },
  { id: "library", label: "Library", color: "var(--pistachio)" },
  { id: "brands", label: "Brands", color: "var(--butter)" },
  { id: "outcomes", label: "Outcomes", color: "var(--plum)" },
  { id: "team", label: "Team", color: "var(--ink)" }
];

export function AppShell() {
  const { isLoaded: clerkLoaded, isSignedIn, user: clerkUser } = useUser();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [view, setView] = useState<View>("workbench");
  const [bootError] = useState<string | null>(null);

  useEffect(() => {
    if (!clerkLoaded) return;
    if (!isSignedIn) {
      setSession({ authenticated: false, user: null, team: null, teams: [] });
      return;
    }
    let cancelled = false;
    getSession()
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch(() => {
        if (!cancelled) setSession({ authenticated: false, user: null, team: null, teams: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [clerkLoaded, isSignedIn]);

  async function refreshSession() {
    try {
      const next = await getSession();
      setSession(next);
    } catch (err) {
      console.warn(err);
    }
  }

  // Clerk's useUser() is the source of truth for "is the user signed in".
  // session carries the backend-derived team + permissions for UI scoping;
  // when the API call hasn't returned yet we still show the user as signed
  // in (just with degraded team info) instead of flashing "Sign in" again.
  const signedIn = Boolean(clerkLoaded && isSignedIn);
  const displayName =
    session?.user?.name ||
    clerkUser?.fullName ||
    clerkUser?.firstName ||
    clerkUser?.primaryEmailAddress?.emailAddress ||
    "";
  const displayEmail =
    session?.user?.email || clerkUser?.primaryEmailAddress?.emailAddress || "";

  return (
    <div className="wb-root paper-bg">
      <Sidebar
        active={view}
        onChange={setView}
        signedIn={signedIn}
        displayName={displayName}
        displayEmail={displayEmail}
      />

      <main className="wb-main">
        {bootError ? <div className="banner error">{bootError}</div> : null}
        {view === "workbench" ? (
          <Workbench
            onRequireAuth={() => {
              /* Sign-in is driven by useClerk().openSignIn() elsewhere */
            }}
            remoteProvider={null}
            briefDefaults={undefined}
          />
        ) : null}
        {view === "library" ? <LibraryView /> : null}
        {view === "brands" ? <BrandsView /> : null}
        {view === "outcomes" ? <OutcomesView /> : null}
        {view === "team" ? (
          <TeamView session={session} onUpdate={refreshSession} />
        ) : null}
      </main>
    </div>
  );
}

function Sidebar({
  active,
  onChange,
  signedIn,
  displayName,
  displayEmail
}: {
  active: View;
  onChange: (view: View) => void;
  signedIn: boolean;
  displayName: string;
  displayEmail: string;
}) {
  return (
    <aside className="wb-side">
      <a className="brand brand-side" href="/">
        <BrainBlob size={36} color="var(--tomato)" />
        <span className="brand-word" style={{ fontSize: 24 }}>
          stimli
        </span>
      </a>
      <nav className="side-nav">
        <span className="kicker side-kicker">Workspace</span>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`side-link ${active === item.id ? "active" : ""}`}
            onClick={() => onChange(item.id)}
          >
            <span className="side-dot" style={{ background: item.color }} />
            <span>{item.label}</span>
            {active === item.id && <span className="side-mark">✦</span>}
          </button>
        ))}
        <span className="kicker side-kicker" style={{ marginTop: 24 }}>
          Help
        </span>
        <a className="side-link" href="/legal">
          <span className="side-dot" style={{ background: "transparent", border: "1.5px dashed var(--ink)" }} />
          <span>Trust & license</span>
        </a>
        <a className="side-link" href="https://github.com/manrajmondair/stimli" target="_blank" rel="noreferrer">
          <span className="side-dot" style={{ background: "transparent", border: "1.5px dashed var(--ink)" }} />
          <span>Docs</span>
        </a>
      </nav>

      {signedIn ? (
        <div className="side-tip side-tip-account" style={{ alignItems: "stretch", textAlign: "left" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <UserButton
              afterSignOutUrl="/"
              userProfileMode="modal"
              appearance={{
                elements: {
                  userButtonAvatarBox: {
                    width: 40,
                    height: 40,
                    border: "2px solid var(--ink)",
                    boxShadow: "3px 3px 0 var(--ink)"
                  },
                  userButtonTrigger: { borderRadius: 999 }
                }
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong
                style={{
                  fontFamily: "var(--display)",
                  fontSize: 16,
                  lineHeight: 1.05,
                  display: "block",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }}
              >
                {displayName || "Signed in"}
              </strong>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--ink-soft)",
                  fontFamily: "var(--mono)",
                  display: "block",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }}
              >
                {displayEmail}
              </span>
            </div>
          </div>
          <p className="hint" style={{ margin: "8px 0 0", fontSize: 11 }}>
            Click the avatar for account, security, and sign-out.
          </p>
        </div>
      ) : (
        <div className="side-tip">
          <BrainBlob size={56} color="var(--butter)" eyes mouth />
          <p>Sign in to save variants, log outcomes, and share decisions.</p>
          <SignInTrigger className="btn primary small">Sign in</SignInTrigger>
        </div>
      )}
    </aside>
  );
}

export function SignInTrigger({
  children,
  className = "btn primary",
  signUp = false
}: {
  children: React.ReactNode;
  className?: string;
  signUp?: boolean;
}) {
  const clerk = useClerk();
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (!clerk) return;
        // Imperative open is more reliable than <SignInButton> when the
        // trigger lives inside a portal/overlay or has competing handlers.
        // Force redirect to /app post-auth regardless of where the user
        // started so they land on the workbench.
        if (signUp) {
          clerk.openSignUp({ forceRedirectUrl: "/app" });
        } else {
          clerk.openSignIn({ forceRedirectUrl: "/app" });
        }
      }}
    >
      {children}
    </button>
  );
}


function LibraryView() {
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | AssetType>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LibraryAsset | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { toast, show, dismiss } = useLocalToast();

  function refresh() {
    setLoading(true);
    setError(null);
    listLibraryAssets()
      .then((res) => setItems(res.assets))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load library."))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let cancelled = false;
    listLibraryAssets()
      .then((res) => {
        if (cancelled) return;
        setItems(res.assets);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load library.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function performDelete(asset: LibraryAsset) {
    setBusyId(asset.id);
    try {
      await deleteAsset(asset.id);
      setItems((current) => current.filter((item) => item.id !== asset.id));
      if (expandedId === asset.id) setExpandedId(null);
      show("success", `Deleted "${asset.name}".`);
    } catch (err) {
      show("error", err instanceof Error ? err.message : "Could not delete asset.");
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
    }
  }

  const counts = useMemo(() => {
    const tally: Record<string, number> = { all: items.length };
    for (const item of items) tally[item.type] = (tally[item.type] || 0) + 1;
    return tally;
  }, [items]);

  const visible = filter === "all" ? items : items.filter((asset) => asset.type === filter);

  return (
    <>
      <header className="wb-top">
        <div className="wb-top-left">
          <h1 className="wb-h1">
            The <span className="hl-pist">library</span>
          </h1>
          <span className="wb-crumbs">
            <span className="pill">
              <span className="dot" style={{ background: "var(--pistachio)" }} />
              {items.length} {items.length === 1 ? "asset" : "assets"}
            </span>
            {filter !== "all" ? (
              <span className="pill">
                <span className="dot" style={{ background: "var(--butter)" }} />
                {visible.length} filtered
              </span>
            ) : null}
          </span>
        </div>
        <div className="wb-top-right">
          <button className="btn cream" onClick={refresh} disabled={loading}>
            Refresh
          </button>
          <a className="btn primary" href="/app">
            Upload variant
          </a>
        </div>
      </header>

      {error ? <div className="banner error">{error}</div> : null}

      {items.length > 0 ? (
        <div className="filter-chips" role="tablist" aria-label="Filter assets by type">
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            className={`filter-chip ${filter === "all" ? "active" : ""}`}
            onClick={() => setFilter("all")}
          >
            All · {counts.all || 0}
          </button>
          {ASSET_TYPE_ORDER.map((type) => (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={filter === type}
              className={`filter-chip ${filter === type ? "active" : ""}`}
              onClick={() => setFilter(type)}
              disabled={!counts[type]}
            >
              {ASSET_TYPE_LABEL[type]} · {counts[type] || 0}
            </button>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div className="banner">Loading…</div>
      ) : items.length === 0 ? (
        <div className="panel-card empty" style={{ paddingTop: 60, paddingBottom: 60 }}>
          <BrainBlob size={120} color="var(--pistachio)" eyes mouth />
          <h4>No saved assets yet.</h4>
          <p>Variants you upload from the workbench collect here with extracted text and source metadata.</p>
          <a className="btn primary" href="/app">
            Open the workbench
          </a>
        </div>
      ) : visible.length === 0 ? (
        <div className="panel-card empty" style={{ paddingTop: 50, paddingBottom: 50 }}>
          <BrainBlob size={96} color="var(--ink-faint)" />
          <h4>No assets in this filter.</h4>
          <p>Try a different type or upload another variant from the workbench.</p>
        </div>
      ) : (
        <div className="list-grid">
          {visible.map((asset, idx) => {
            const accent = ["var(--tomato)", "var(--pistachio)", "var(--butter)", "var(--plum)"][idx % 4];
            const isOpen = expandedId === asset.id;
            const previewText = (asset.extracted_text || "").trim();
            return (
              <article key={asset.id} className="list-card" style={{ borderLeft: `6px solid ${accent}` }}>
                <span className="meta">
                  {ASSET_TYPE_LABEL[asset.type]} · {new Date(asset.created_at).toLocaleDateString()}
                </span>
                <h4>{asset.name}</h4>
                <p>
                  {previewText.slice(0, 200)}
                  {previewText.length > 200 ? "…" : ""}
                </p>
                <div className="row">
                  <span className="kicker">{asset.library?.extraction_status || "provided"}</span>
                  <span className="kicker">{asset.library?.text_length ?? previewText.length} chars</span>
                  {asset.library?.has_private_blob ? <span className="kicker">in r2</span> : null}
                </div>
                {isOpen ? <div className="asset-preview-body">{previewText || "(no extracted text)"}</div> : null}
                <div className="list-card-actions">
                  <button
                    type="button"
                    className="btn cream"
                    onClick={() => setExpandedId(isOpen ? null : asset.id)}
                  >
                    {isOpen ? "Hide" : "View text"}
                  </button>
                  <button
                    type="button"
                    className="btn cream danger"
                    onClick={() => setConfirmDelete(asset)}
                    disabled={busyId === asset.id}
                    style={{ background: "var(--tomato-soft)", borderColor: "var(--tomato-ink)", color: "var(--tomato-ink)" }}
                  >
                    {busyId === asset.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete this asset?"
        confirmLabel="Delete asset"
        message={
          <>
            <p>
              <strong>{confirmDelete?.name}</strong> will be removed from your library and from any new
              comparisons. Existing comparison reports keep their snapshot of this variant.
            </p>
            <p style={{ marginTop: 8, color: "var(--ink-soft)", fontSize: 12 }}>
              This can't be undone.
            </p>
          </>
        }
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && performDelete(confirmDelete)}
      />

      <ToastBar toast={toast} onDismiss={dismiss} />
    </>
  );
}

type BrandFormState = {
  name: string;
  brand_name: string;
  audience: string;
  product_category: string;
  primary_offer: string;
  voice: string;
  required_claims: string;
  forbidden_terms: string;
};

const EMPTY_BRAND_FORM: BrandFormState = {
  name: "",
  brand_name: "",
  audience: "",
  product_category: "",
  primary_offer: "",
  voice: "specific before abstract, proof before promise",
  required_claims: "",
  forbidden_terms: ""
};

function brandToForm(profile: BrandProfile): BrandFormState {
  return {
    name: profile.name,
    brand_name: profile.brief.brand_name,
    audience: profile.brief.audience,
    product_category: profile.brief.product_category,
    primary_offer: profile.brief.primary_offer,
    voice: profile.voice_rules.join(", "),
    required_claims: (profile.brief.required_claims || []).join(", "),
    forbidden_terms: (profile.brief.forbidden_terms || []).join(", ")
  };
}

function csvToList(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function BrandsView() {
  const [profiles, setProfiles] = useState<BrandProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BrandProfile | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.localStorage.getItem(DEFAULT_BRAND_KEY)
  );
  const [form, setForm] = useState<BrandFormState>(EMPTY_BRAND_FORM);
  const { toast, show, dismiss } = useLocalToast();

  useEffect(() => {
    let cancelled = false;
    listBrandProfiles()
      .then((res) => {
        if (cancelled) return;
        setProfiles(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load brands.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setActiveDefault(id: string | null) {
    setDefaultId(id);
    if (typeof window === "undefined") return;
    if (id) {
      window.localStorage.setItem(DEFAULT_BRAND_KEY, id);
    } else {
      window.localStorage.removeItem(DEFAULT_BRAND_KEY);
    }
  }

  async function save() {
    if (!form.name.trim() || !form.brand_name.trim()) {
      setError("Add a profile name and brand.");
      return;
    }
    setBusy(true);
    setError(null);
    const brief: CreativeBrief = {
      brand_name: form.brand_name.trim(),
      audience: form.audience.trim(),
      product_category: form.product_category.trim(),
      primary_offer: form.primary_offer.trim(),
      required_claims: csvToList(form.required_claims),
      forbidden_terms: csvToList(form.forbidden_terms)
    };
    const voice = csvToList(form.voice);
    try {
      if (editingId) {
        const updated = await updateBrandProfile(editingId, {
          name: form.name.trim(),
          brief,
          voice_rules: voice,
          compliance_notes: []
        });
        setProfiles((current) => current.map((profile) => (profile.id === editingId ? updated : profile)));
        show("success", `Updated "${updated.name}".`);
      } else {
        const profile = await createBrandProfile({
          name: form.name.trim(),
          brief,
          voice_rules: voice,
          compliance_notes: []
        });
        setProfiles((current) => [profile, ...current]);
        show("success", `Saved "${profile.name}".`);
      }
      setForm({ ...EMPTY_BRAND_FORM, voice: form.voice });
      setEditingId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save profile.";
      setError(message);
      show("error", message);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(profile: BrandProfile) {
    setEditingId(profile.id);
    setForm(brandToForm(profile));
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_BRAND_FORM);
    setError(null);
  }

  async function performDelete(profile: BrandProfile) {
    setBusy(true);
    try {
      await deleteBrandProfile(profile.id);
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      if (defaultId === profile.id) setActiveDefault(null);
      if (editingId === profile.id) cancelEdit();
      show("success", `Deleted "${profile.name}".`);
    } catch (err) {
      show("error", err instanceof Error ? err.message : "Could not delete profile.");
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  }

  async function downloadExport(profile: BrandProfile) {
    try {
      const payload = await exportBrandProfile(profile.id);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.brand.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      show("success", "Profile exported.");
    } catch (err) {
      show("error", err instanceof Error ? err.message : "Could not export profile.");
    }
  }

  const headingKicker = editingId ? "edit brief" : "re-usable brief";

  return (
    <>
      <header className="wb-top">
        <div className="wb-top-left">
          <h1 className="wb-h1">
            The <span className="hl-pist">brands</span>
          </h1>
          <span className="wb-crumbs">
            <span className="pill">
              <span className="dot" style={{ background: "var(--butter)" }} />
              {profiles.length} {profiles.length === 1 ? "profile" : "profiles"}
            </span>
            {defaultId ? (
              <span className="pill">
                <span className="dot" style={{ background: "var(--pistachio)" }} />
                default set
              </span>
            ) : null}
          </span>
        </div>
      </header>
      {error ? <div className="banner error">{error}</div> : null}
      <div className="wb-grid" style={{ gridTemplateColumns: "360px 1fr" }}>
        <section className="panel-card">
          <div className="panel-head">
            <h3>{editingId ? "Edit profile" : "New brand profile"}</h3>
            <span className="kicker">{headingKicker}</span>
          </div>
          <div className="add-form">
            <label className="field">
              <span>Profile name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Lumina · Q3" />
            </label>
            <label className="field">
              <span>Brand</span>
              <input value={form.brand_name} onChange={(e) => setForm({ ...form, brand_name: e.target.value })} placeholder="Lumina" />
            </label>
            <label className="field">
              <span>Audience</span>
              <input
                value={form.audience}
                onChange={(e) => setForm({ ...form, audience: e.target.value })}
                placeholder="busy women, sensitive skin"
              />
            </label>
            <label className="field">
              <span>Category</span>
              <input
                value={form.product_category}
                onChange={(e) => setForm({ ...form, product_category: e.target.value })}
                placeholder="hydration system"
              />
            </label>
            <label className="field">
              <span>Primary offer</span>
              <input
                value={form.primary_offer}
                onChange={(e) => setForm({ ...form, primary_offer: e.target.value })}
                placeholder="starter kit, free shipping"
              />
            </label>
            <label className="field">
              <span>Voice rules · comma separated</span>
              <textarea rows={2} value={form.voice} onChange={(e) => setForm({ ...form, voice: e.target.value })} />
            </label>
            <label className="field">
              <span>Required claims · comma separated</span>
              <textarea
                rows={2}
                value={form.required_claims}
                onChange={(e) => setForm({ ...form, required_claims: e.target.value })}
                placeholder="24-hr hydration, dermatologist tested"
              />
            </label>
            <label className="field">
              <span>Forbidden terms · comma separated</span>
              <textarea
                rows={2}
                value={form.forbidden_terms}
                onChange={(e) => setForm({ ...form, forbidden_terms: e.target.value })}
                placeholder="miracle cure, guaranteed"
              />
            </label>
            <div className="form-actions" style={{ justifyContent: "flex-end" }}>
              {editingId ? (
                <button className="btn ghost" onClick={cancelEdit} disabled={busy}>
                  Cancel
                </button>
              ) : null}
              <button className="btn primary" onClick={save} disabled={busy}>
                {busy ? "Saving…" : editingId ? "Save changes" : "Save profile"}
              </button>
            </div>
          </div>
        </section>

        <section className="wb-col">
          {loading ? (
            <div className="banner">Loading…</div>
          ) : profiles.length === 0 ? (
            <div className="panel-card empty" style={{ paddingTop: 50, paddingBottom: 50 }}>
              <BrainBlob size={100} color="var(--butter)" />
              <h4>No brand profiles yet.</h4>
              <p>Save the briefs your team uses most so the workbench can pull them in for every comparison.</p>
            </div>
          ) : (
            <div className="list-grid">
              {profiles.map((profile, idx) => {
                const accent = ["var(--tomato)", "var(--pistachio)", "var(--butter)", "var(--plum)"][idx % 4];
                const isDefault = defaultId === profile.id;
                const isEditing = editingId === profile.id;
                return (
                  <article
                    key={profile.id}
                    className="list-card"
                    style={{ borderTop: `6px solid ${accent}`, opacity: isEditing ? 0.55 : 1 }}
                  >
                    {isDefault ? <span className="brand-active-tag">default for next compare</span> : null}
                    <span className="meta">{profile.brief.product_category || "—"}</span>
                    <h4>{profile.name}</h4>
                    <p>
                      <strong>{profile.brief.brand_name}</strong> · {profile.brief.audience || "(no audience set)"}
                    </p>
                    <p>
                      Offer: <strong>{profile.brief.primary_offer || "—"}</strong>
                    </p>
                    {profile.voice_rules.length ? (
                      <div className="brand-pill-row">
                        {profile.voice_rules.map((rule) => (
                          <span key={rule} className="brand-pill voice">
                            {rule}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {profile.brief.required_claims?.length ? (
                      <div className="brand-pill-row">
                        {profile.brief.required_claims.map((claim) => (
                          <span key={claim} className="brand-pill required">
                            ✓ {claim}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {profile.brief.forbidden_terms?.length ? (
                      <div className="brand-pill-row">
                        {profile.brief.forbidden_terms.map((term) => (
                          <span key={term} className="brand-pill forbid">
                            ✕ {term}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <div className="list-card-actions">
                      <button
                        type="button"
                        className={isDefault ? "btn primary" : "btn cream"}
                        onClick={() => setActiveDefault(isDefault ? null : profile.id)}
                      >
                        {isDefault ? "Unset default" : "Set as default"}
                      </button>
                      <button type="button" className="btn cream" onClick={() => startEdit(profile)} disabled={busy}>
                        {isEditing ? "Editing…" : "Edit"}
                      </button>
                      <button type="button" className="btn cream" onClick={() => downloadExport(profile)}>
                        Export
                      </button>
                      <button
                        type="button"
                        className="btn cream"
                        onClick={() => setConfirmDelete(profile)}
                        disabled={busy}
                        style={{
                          background: "var(--tomato-soft)",
                          borderColor: "var(--tomato-ink)",
                          color: "var(--tomato-ink)"
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete this brand profile?"
        confirmLabel="Delete profile"
        message={
          <>
            <p>
              <strong>{confirmDelete?.name}</strong> will be removed. New comparisons can't reference it
              after deletion; existing comparison reports keep their snapshot of this brief.
            </p>
            <p style={{ marginTop: 8, color: "var(--ink-soft)", fontSize: 12 }}>This can't be undone.</p>
          </>
        }
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && performDelete(confirmDelete)}
      />

      <ToastBar toast={toast} onDismiss={dismiss} />
    </>
  );
}

function OutcomesView() {
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getLearningSummary()
      .then((res) => {
        if (cancelled) return;
        setSummary(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load outcomes.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <header className="wb-top">
        <div className="wb-top-left">
          <h1 className="wb-h1">
            The <span className="hl-pist">outcomes</span>
          </h1>
          <span className="wb-crumbs">
            <span className="pill">
              <span className="dot" style={{ background: "var(--plum)" }} />
              Learning loop
            </span>
          </span>
        </div>
      </header>
      {error ? <div className="banner error">{error}</div> : null}
      {loading ? (
        <div className="banner">Loading…</div>
      ) : !summary ? null : summary.outcome_count === 0 ? (
        <div className="panel-card empty" style={{ paddingTop: 60, paddingBottom: 60 }}>
          <BrainBlob size={120} color="var(--plum)" eyes mouth />
          <h4>No launch outcomes logged yet.</h4>
          <p>
            After you run an ad, open its decision report and click <strong>Log outcome</strong> to record
            spend and revenue. Once a few are in, this page will show how often Stimli's predictions match
            real spend results.
          </p>
        </div>
      ) : (
        <div className="wb-col">
          <div className="panel-card">
            <div className="panel-head">
              <h3>Where the brain calls match the spreadsheet</h3>
              <span className="kicker">{summary.outcome_count} outcomes logged</span>
            </div>
            <p className="big-p">{summary.insight}</p>
            <div className="metric-grid">
              <div className="metric">
                <span>Total spend</span>
                <strong>${formatNumber(summary.total_spend)}</strong>
              </div>
              <div className="metric">
                <span>Total revenue</span>
                <strong>${formatNumber(summary.total_revenue)}</strong>
              </div>
              <div className="metric">
                <span>Avg CTR</span>
                <strong>{(summary.average_ctr * 100).toFixed(2)}%</strong>
              </div>
              <div className="metric">
                <span>Avg CVR</span>
                <strong>{(summary.average_cvr * 100).toFixed(2)}%</strong>
              </div>
            </div>
          </div>

          <div className="panel-card">
            <div className="panel-head">
              <h3>Calibration</h3>
              <span className="kicker">brain prediction vs ad outcomes</span>
            </div>
            <div className="metric-grid">
              <div className="metric">
                <span>Comparisons evaluated</span>
                <strong>{summary.calibration.evaluated_comparisons}</strong>
              </div>
              <div className="metric">
                <span>Aligned predictions</span>
                <strong>{summary.calibration.aligned_predictions}</strong>
              </div>
              <div className="metric">
                <span>Alignment rate</span>
                <strong>{(summary.calibration.alignment_rate * 100).toFixed(0)}%</strong>
              </div>
            </div>
            {summary.calibration.recent.length ? (
              <table className="simple-table" style={{ marginTop: 18 }}>
                <thead>
                  <tr>
                    <th>Comparison</th>
                    <th>Predicted</th>
                    <th>Actual</th>
                    <th>Aligned</th>
                    <th>Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.calibration.recent.map((row) => (
                    <tr key={row.comparison_id}>
                      <td>{row.comparison_id.slice(0, 8)}</td>
                      <td>{row.predicted_asset_id.slice(0, 6)}</td>
                      <td>{row.actual_best_asset_id.slice(0, 6)}</td>
                      <td>{row.aligned ? "✓" : "—"}</td>
                      <td>${formatNumber(row.actual_profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function TeamView({ session, onUpdate }: { session: AuthSession | null; onUpdate: () => Promise<void> }) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.authenticated) return;
    void refresh();
  }, [session?.team?.id]);

  async function refresh() {
    try {
      const [membersList, events] = await Promise.all([
        listTeamMembers().catch(() => [] as TeamMember[]),
        listAuditEvents().catch(() => [] as AuditEvent[])
      ]);
      setMembers(membersList);
      setAudit(events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load team.");
    }
  }

  async function invite() {
    setBusy(true);
    setError(null);
    setInviteUrl(null);
    try {
      const result = await createTeamInvite({ email: inviteEmail.trim() || undefined, role: "analyst" });
      setInviteUrl(result.url ?? null);
      if (result.url) await navigator.clipboard?.writeText(result.url).catch(() => null);
      await onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create invite.");
    } finally {
      setBusy(false);
    }
  }

  if (!session?.authenticated) {
    return (
      <div className="panel-card empty" style={{ paddingTop: 60, paddingBottom: 60 }}>
        <BrainBlob size={120} color="var(--ink)" eyes mouth />
        <h4>Sign in to manage your team.</h4>
        <p>Once signed in you can invite collaborators, set roles, and review audit history.</p>
      </div>
    );
  }

  return (
    <>
      <header className="wb-top">
        <div className="wb-top-left">
          <h1 className="wb-h1">
            The <span className="hl-pist">team</span>
          </h1>
          <span className="wb-crumbs">
            <span className="pill">
              <span className="dot" style={{ background: "var(--ink)" }} />
              {members.length} members
            </span>
            <span className="pill">
              <span className="dot" style={{ background: "var(--tomato)" }} />
              {session.team?.name}
            </span>
          </span>
        </div>
      </header>
      {error ? <div className="banner error">{error}</div> : null}
      <div className="wb-grid" style={{ gridTemplateColumns: "360px 1fr" }}>
        <section className="panel-card">
          <div className="panel-head">
            <h3>Invite an analyst</h3>
            <span className="kicker">link copies to clipboard</span>
          </div>
          <div className="add-form">
            <label className="field">
              <span>Email (optional)</span>
              <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@brand.com" />
            </label>
            <button className="btn primary wide" onClick={invite} disabled={busy}>
              Create invite link
            </button>
            {inviteUrl ? (
              <div className="banner success" style={{ wordBreak: "break-all", fontSize: 12 }}>
                {inviteUrl}
              </div>
            ) : null}
          </div>
        </section>

        <section className="wb-col">
          <div className="panel-card">
            <div className="panel-head">
              <h3>Members</h3>
              <span className="kicker">{members.length}</span>
            </div>
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.user_id}>
                    <td>{member.name}</td>
                    <td>{member.email}</td>
                    <td>
                      <span className="claim-pill">{member.role}</span>
                    </td>
                    <td>{new Date(member.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel-card">
            <div className="panel-head">
              <h3>Audit log</h3>
              <span className="kicker">last {audit.length} events</span>
            </div>
            {audit.length === 0 ? (
              <p className="hint">No audit events yet. Adding variants and running comparisons will start the trail.</p>
            ) : (
              <table className="simple-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.slice(0, 12).map((event) => (
                    <tr key={event.id}>
                      <td>{new Date(event.created_at).toLocaleString()}</td>
                      <td>{event.actor_email || "—"}</td>
                      <td>{event.action}</td>
                      <td>{event.target_type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

export function LegalPage() {
  return (
    <div className="legal-page paper-bg">
      <a className="brand" href="/" style={{ marginBottom: 32 }}>
        <BrainBlob size={42} color="var(--tomato)" />
        <span className="brand-word">stimli</span>
      </a>
      <h1>Trust & license</h1>
      <p>
        Stimli is an opinionated decision engine for creative pretesting. It runs uploaded variants through brain-aware
        signal analysis, returns one recommendation, and lists the edits to make before launch.
      </p>
      <h2>Data handling</h2>
      <ul>
        <li>Uploaded files are stored privately. Public payloads never include private blob URLs.</li>
        <li>Workspaces are isolated by team. Audit events are written for asset, comparison, and team operations.</li>
        <li>Deletion review is available from the workspace governance API.</li>
      </ul>
      <h2>Model license</h2>
      <p>
        TRIBE v2 is released under CC BY-NC 4.0 by its upstream authors. The default deployment uses a deterministic
        local provider for reproducible demos. Commercial use of the TRIBE-backed mode requires separate licensing
        agreements with the upstream authors.
      </p>
      <h2>Built for CS 153</h2>
      <p>
        Stimli was built as a one-person frontier-lab project for CS 153 at Stanford. Everything in this product —
        landing page, workbench, comparison pipeline, hosted GPU inference path — was designed and shipped solo using
        modern AI coding assistants. See the <a href="https://github.com/manrajmondair/stimli">project repository</a>{" "}
        for source and reproduction notes.
      </p>
      <p style={{ marginTop: 48 }}>
        <a className="btn cream" href="/">
          ← Back home
        </a>
      </p>
    </div>
  );
}

export function InvitePage({ token }: { token: string }) {
  const { isLoaded: clerkLoaded, isSignedIn } = useUser();
  const [invite, setInvite] = useState<TeamInvite | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getInvite(token)
      .then(setInvite)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load invite."));
  }, [token]);

  useEffect(() => {
    if (!clerkLoaded || !isSignedIn) return;
    getSession()
      .then(setSession)
      .catch(() => undefined);
  }, [clerkLoaded, isSignedIn]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const next = await acceptInvite(token);
      setSession(next);
      window.location.assign("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept invite.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="invite-page paper-bg">
      <a className="brand" href="/" style={{ marginBottom: 24 }}>
        <BrainBlob size={42} color="var(--tomato)" />
        <span className="brand-word">stimli</span>
      </a>
      {error ? <div className="banner error">{error}</div> : null}
      {!invite ? (
        <p>Loading invite…</p>
      ) : (
        <div className="panel-card" style={{ padding: 32 }}>
          <span className="kicker">team invite</span>
          <h1 style={{ marginTop: 8 }}>Join {invite.team_name}</h1>
          <p>
            Role: <strong>{invite.role}</strong>
            {invite.email ? (
              <>
                {" "}
                · expected for <strong>{invite.email}</strong>
              </>
            ) : null}
          </p>
          {session?.authenticated ? (
            <button className="btn primary" onClick={accept} disabled={busy}>
              Accept invite as {session.user?.email}
            </button>
          ) : (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <a className="btn primary" href={`/app?invite=${encodeURIComponent(token)}`}>
                Sign in to accept
              </a>
              <a className="btn cream" href="/">
                Cancel
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SharedReportPage({ token }: { token: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSharedReport(token)
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load report."));
  }, [token]);

  if (error) {
    return (
      <div className="share-page paper-bg">
        <h1>Report not available.</h1>
        <p>{error}</p>
        <a className="btn cream" href="/">
          ← Back home
        </a>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="share-page paper-bg">
        <p>Loading report…</p>
      </div>
    );
  }

  const winner = report.variants.find((variant) => variant.asset.id === report.recommendation.winner_asset_id);

  return (
    <div className="share-page paper-bg">
      <a className="brand" href="/" style={{ marginBottom: 24 }}>
        <BrainBlob size={42} color="var(--tomato)" />
        <span className="brand-word">stimli</span>
      </a>
      <span className="kicker">shared decision report</span>
      <h1 style={{ marginTop: 8 }}>{report.title}</h1>
      <p>{report.executive_summary}</p>
      <div className="panel-card" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h3>Recommendation</h3>
          <span className="kicker">{Math.round((report.recommendation.confidence ?? 0) * 100)}% confidence</span>
        </div>
        <h2 style={{ fontFamily: "var(--display)", fontSize: 32, lineHeight: 1.05, marginBottom: 12 }}>
          {report.recommendation.headline}
        </h2>
        <ul>
          {report.recommendation.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>
      {winner ? (
        <div className="panel-card" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <h3>Winner: {winner.asset.name}</h3>
            <span className="kicker">{winner.analysis.summary}</span>
          </div>
        </div>
      ) : null}
      {report.suggestions.length ? (
        <div className="panel-card" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <h3>Edits before launch</h3>
            <span className="kicker">prioritized</span>
          </div>
          <ul>
            {report.suggestions.map((entry, idx) => (
              <li key={idx}>
                <strong>{entry.target}:</strong> {entry.suggested_edit}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
