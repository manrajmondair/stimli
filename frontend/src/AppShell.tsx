import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useClerk, UserButton, useUser } from "@clerk/clerk-react";
import {
  acceptInvite,
  createBrandProfile,
  createOutcome,
  createTeamInvite,
  deleteAsset,
  deleteBrandProfile,
  exportBrandProfile,
  getBillingStatus,
  getBillingUsage,
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
  openBillingPortal,
  removeTeamMember,
  revokeTeamInvite,
  startCheckout,
  updateBrandProfile,
  updateTeamMemberRole,
  type UsageSnapshot
} from "./api";
import type { BillingStatus, Plan } from "./types";
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
import { BrainBlob, NeuralTimeline, type NeuralVariant } from "./art";
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

type View = "workbench" | "library" | "brands" | "outcomes" | "team" | "billing";

const NAV_ITEMS: Array<{ id: View; label: string; color: string }> = [
  { id: "workbench", label: "Workbench", color: "var(--tomato)" },
  { id: "library", label: "Library", color: "var(--pistachio)" },
  { id: "brands", label: "Brands", color: "var(--butter)" },
  { id: "outcomes", label: "Outcomes", color: "var(--plum)" },
  { id: "team", label: "Team", color: "var(--ink)" },
  { id: "billing", label: "Billing", color: "var(--pistachio)" }
];

export function AppShell() {
  const { isLoaded: clerkLoaded, isSignedIn, user: clerkUser } = useUser();
  const clerk = useClerk();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [view, setView] = useState<View>("workbench");
  const [bootError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((current) => !current);
      }
      if (e.key === "Escape" && paletteOpen) {
        setPaletteOpen(false);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [paletteOpen]);

  const [usage, setUsage] = useState<UsageSnapshot | null>(null);

  useEffect(() => {
    if (!clerkLoaded) return;
    if (!isSignedIn) {
      setSession({ authenticated: false, user: null, team: null, teams: [] });
      setUsage(null);
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

  // Pull usage on mount and refresh it whenever the user switches view so the
  // sidebar number stays vaguely current after they run a comparison. Not
  // real-time; that would mean SSE/websockets which is overkill for an hourly
  // counter.
  useEffect(() => {
    if (!clerkLoaded || !isSignedIn) return;
    let cancelled = false;
    getBillingUsage()
      .then((next) => {
        if (!cancelled) setUsage(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clerkLoaded, isSignedIn, view]);

  // Honor `?billing=upgrade` (sent by the structured 402 path) and
  // `?billing=success` (Stripe Checkout return) so the user lands directly on
  // the Billing view instead of having to find it in the sidebar.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const billingFlag = url.searchParams.get("billing");
    if (billingFlag === "upgrade" || billingFlag === "success" || billingFlag === "cancelled") {
      setView("billing");
    }
    // Listen for quota-exceeded events fired from api.ts so any 402 anywhere
    // in the app routes the user to the Billing view to upgrade.
    function onQuota() {
      setView("billing");
    }
    window.addEventListener("stimli:upgrade-required", onQuota);
    return () => window.removeEventListener("stimli:upgrade-required", onQuota);
  }, []);

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
        usage={usage}
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
        {view === "billing" ? (
          <BillingView usage={usage} onUsageRefresh={() => getBillingUsage().then(setUsage).catch(() => undefined)} />
        ) : null}
      </main>

      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onNavigate={(target) => {
            setView(target);
            setPaletteOpen(false);
          }}
          onSignIn={() => {
            if (clerk) clerk.openSignIn({ forceRedirectUrl: "/app" });
            setPaletteOpen(false);
          }}
          onAccount={() => {
            if (clerk) clerk.openUserProfile();
            setPaletteOpen(false);
          }}
          signedIn={signedIn}
        />
      ) : null}
    </div>
  );
}

const PALETTE_NAV: Array<{ id: View; label: string; hint: string; icon: string }> = [
  { id: "workbench", label: "Go to Workbench", hint: "Run a new comparison", icon: "✦" },
  { id: "library", label: "Go to Library", hint: "Saved variants + bulk actions", icon: "❒" },
  { id: "brands", label: "Go to Brands", hint: "Re-usable briefs", icon: "✺" },
  { id: "outcomes", label: "Go to Outcomes", hint: "Calibration vs real spend", icon: "$" },
  { id: "team", label: "Go to Team", hint: "Members, invites, audit log", icon: "◐" },
  { id: "billing", label: "Go to Billing", hint: "Plan, usage, invoices", icon: "$" }
];

type PaletteCommand = {
  id: string;
  label: string;
  hint: string;
  icon: string;
  perform: () => void;
};

function CommandPalette({
  onClose,
  onNavigate,
  onSignIn,
  onAccount,
  signedIn
}: {
  onClose: () => void;
  onNavigate: (view: View) => void;
  onSignIn: () => void;
  onAccount: () => void;
  signedIn: boolean;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commands: PaletteCommand[] = useMemo(() => {
    const base: PaletteCommand[] = PALETTE_NAV.map((item) => ({
      id: `nav:${item.id}`,
      label: item.label,
      hint: item.hint,
      icon: item.icon,
      perform: () => onNavigate(item.id)
    }));
    base.push({
      id: "external:repo",
      label: "Open GitHub repository",
      hint: "github.com/manrajmondair/stimli",
      icon: "↗",
      perform: () => window.open("https://github.com/manrajmondair/stimli", "_blank", "noopener,noreferrer")
    });
    base.push({
      id: "external:legal",
      label: "Open trust & license",
      hint: "Data handling, model license",
      icon: "§",
      perform: () => {
        window.location.href = "/legal";
      }
    });
    if (signedIn) {
      base.push({
        id: "account",
        label: "Manage account",
        hint: "Profile, security, connected providers",
        icon: "@",
        perform: onAccount
      });
    } else {
      base.push({
        id: "signin",
        label: "Sign in",
        hint: "Save variants, log outcomes, share decisions",
        icon: "→",
        perform: onSignIn
      });
    }
    return base;
  }, [onNavigate, onSignIn, onAccount, signedIn]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((cmd) =>
      cmd.label.toLowerCase().includes(q) || cmd.hint.toLowerCase().includes(q)
    );
  }, [commands, query]);

  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered, activeIdx]);

  function onKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActiveIdx((idx) => Math.min(filtered.length - 1, idx + 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActiveIdx((idx) => Math.max(0, idx - 1));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      filtered[activeIdx]?.perform();
    }
  }

  return (
    <div className="palette-overlay" role="presentation" onClick={onClose}>
      <div
        className="palette-modal"
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="palette-input-row">
          <span className="palette-prefix">⌘K</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a view, search a command…"
            aria-label="Command palette search"
            className="palette-input"
          />
          <button type="button" className="palette-close" onClick={onClose} aria-label="Close command palette">
            ×
          </button>
        </div>
        <ul className="palette-list" role="listbox">
          {filtered.length === 0 ? (
            <li className="palette-empty">No commands match.</li>
          ) : (
            filtered.map((cmd, idx) => (
              <li key={cmd.id}>
                <button
                  type="button"
                  className={`palette-item ${idx === activeIdx ? "active" : ""}`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => cmd.perform()}
                  role="option"
                  aria-selected={idx === activeIdx}
                >
                  <span className="palette-icon">{cmd.icon}</span>
                  <span className="palette-label">{cmd.label}</span>
                  <span className="palette-hint">{cmd.hint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="palette-footer">
          <kbd>↑↓</kbd> navigate · <kbd>↵</kbd> select · <kbd>esc</kbd> close
        </div>
      </div>
    </div>
  );
}

function Sidebar({
  active,
  onChange,
  signedIn,
  displayName,
  displayEmail,
  usage
}: {
  active: View;
  onChange: (view: View) => void;
  signedIn: boolean;
  displayName: string;
  displayEmail: string;
  usage: UsageSnapshot | null;
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
        <span className="cmdk-hint" aria-hidden="true" style={{ paddingLeft: 14 }}>
          <kbd>⌘</kbd> <kbd>K</kbd> for commands
        </span>
      </nav>

      {signedIn && usage ? <UsageBadge usage={usage} /> : null}
      <WhatsNewButton />


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

const CHANGELOG_VERSION = "2026-05-16";
const CHANGELOG_KEY = "stimli.changelog_seen";

type ChangelogEntry = { title: string; body: string };
const CHANGELOG: ChangelogEntry[] = [
  {
    title: "Real predicted-brain-response chart",
    body: "The Thought-trail now plots the actual per-second timeline from the inference provider. New NeuralTimeline panel below it shows the full chart with proper axes, multi-variant overlay, keyboard scrubbing, channel toggles, and live read-outs."
  },
  {
    title: "Evidence-grounded edit list",
    body: "Every edit card now carries the measured evidence: the time window driving the gap, the dimension score with the leader's delta, and an expected composite-lift figure. No more 'Address before launch' templated filler."
  },
  {
    title: "Shared report = full report",
    body: "The /share/:token page now renders the neural timeline, variant grid, edit chips, and a verdict pill. New 'Print / PDF' action on both the workbench result and shared report so anyone can hand a printable report to a stakeholder."
  },
  {
    title: "Command palette (⌘K)",
    body: "Press ⌘K (or Ctrl+K) anywhere in the app to jump between views, open account settings, hit the GitHub repo, or sign in. Up/Down to navigate, Enter to fire, Esc to close."
  },
  {
    title: "Workspace usage meter",
    body: "Sidebar now shows your current plan, hourly comparison and asset counters, and an at-a-glance bar that goes tomato above 85% of the hourly cap."
  },
  {
    title: "Library search + bulk delete",
    body: "Search variants by name, body text, or URL. Select multiple and delete in one go, with confirm. The select-all shortcut flips between 'select all visible' and 'clear selection'."
  },
  {
    title: "Outcomes CSV export + audit search",
    body: "Outcomes view exports a single CSV with RFC 4180 quoting and derived CTR / CVR columns. The audit log gained a search box, an action filter built from live data, and a Show-all toggle."
  }
];

function WhatsNewButton() {
  const [open, setOpen] = useState(false);
  const [hasUnseen, setHasUnseen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = window.localStorage.getItem(CHANGELOG_KEY);
    setHasUnseen(seen !== CHANGELOG_VERSION);
  }, []);

  function openModal() {
    setOpen(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(CHANGELOG_KEY, CHANGELOG_VERSION);
    }
    setHasUnseen(false);
  }

  return (
    <>
      <button
        type="button"
        className={`whatsnew-btn ${hasUnseen ? "has-unseen" : ""}`}
        onClick={openModal}
        aria-label="What's new in Stimli"
      >
        <span aria-hidden="true" className="whatsnew-icon">
          ✺
        </span>
        <span>What's new</span>
        {hasUnseen ? <span className="whatsnew-dot" aria-label="unread updates" /> : null}
      </button>
      {open ? <WhatsNewModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function WhatsNewModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="auth-overlay" role="presentation" onClick={onClose}>
      <div
        className="auth-modal whatsnew-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whatsnew-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="auth-close" onClick={onClose} aria-label="Close changelog">
          ×
        </button>
        <span className="kicker">released {CHANGELOG_VERSION}</span>
        <h2 id="whatsnew-title" style={{ marginTop: 6 }}>
          What's new in Stimli
        </h2>
        <p className="lead">
          A summary of the upgrades shipped in this release. Tap one to read more, or just scroll.
        </p>
        <ol className="whatsnew-list">
          {CHANGELOG.map((entry) => (
            <li key={entry.title}>
              <strong>{entry.title}</strong>
              <p>{entry.body}</p>
            </li>
          ))}
        </ol>
        <div className="form-actions" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <a className="btn cream" href="https://github.com/manrajmondair/stimli/commits/main" target="_blank" rel="noreferrer">
            See full commit history ↗
          </a>
          <button className="btn primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function UsageBadge({ usage }: { usage: UsageSnapshot }) {
  // Show monthly progress as the headline (that's the real quota a customer
  // hits), and keep an hourly micro-meter underneath so they can spot a burst
  // before it locks them out. Falls back gracefully if the server doesn't
  // surface monthly numbers yet (older deploys / preview envs).
  const monthlyComp = usage.monthly_usage?.comparison ?? 0;
  const monthlyCompLimit = usage.monthly_limits?.comparison ?? 0;
  const monthlyCompRatio = monthlyCompLimit > 0 ? Math.min(1, monthlyComp / monthlyCompLimit) : 0;
  const monthlyAsset = usage.monthly_usage?.asset ?? 0;
  const monthlyAssetLimit = usage.monthly_limits?.asset ?? 0;
  const monthlyAssetRatio = monthlyAssetLimit > 0 ? Math.min(1, monthlyAsset / monthlyAssetLimit) : 0;
  const compHour = usage.usage.comparison;
  const compHourLimit = usage.limits.comparison || 0;
  const compHourRatio = compHourLimit > 0 ? Math.min(1, compHour / compHourLimit) : 0;
  const planLabel = usage.plan?.name || usage.plan?.id || "Research";
  const commercial = usage.commercial_use_enabled || usage.plan?.commercial;
  const planStyle = planLabel.toLowerCase().includes("scale")
    ? "var(--plum)"
    : planLabel.toLowerCase().includes("growth")
    ? "var(--pistachio)"
    : "var(--butter)";
  const resetIso = usage.period?.end;
  const resetLabel = resetIso
    ? new Date(resetIso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;
  return (
    <div className="usage-badge" role="region" aria-label="Workspace usage">
      <div className="usage-badge-head">
        <span className="usage-plan" style={{ background: planStyle }}>
          {planLabel}
        </span>
        <span className="usage-license" title={commercial ? "Commercial use enabled" : "Research-only"}>
          {commercial ? "commercial" : "research"}
        </span>
      </div>
      <UsageMeter
        label="Comparisons this month"
        used={monthlyComp}
        limit={monthlyCompLimit}
        ratio={monthlyCompRatio}
      />
      <UsageMeter
        label="Assets this month"
        used={monthlyAsset}
        limit={monthlyAssetLimit}
        ratio={monthlyAssetRatio}
      />
      <UsageMeter label="Comparisons / hr" used={compHour} limit={compHourLimit} ratio={compHourRatio} />
      <p className="hint usage-window">
        {resetLabel ? `Resets ${resetLabel} · ` : ""}upgrade for higher limits
      </p>
    </div>
  );
}

function UsageMeter({ label, used, limit, ratio }: { label: string; used: number; limit: number; ratio: number }) {
  const danger = ratio >= 0.85;
  const warning = ratio >= 0.6;
  const fillColor = danger ? "var(--tomato)" : warning ? "var(--butter)" : "var(--pistachio)";
  return (
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span>{label}</span>
        <strong>
          {used}
          {limit > 0 ? <span className="usage-limit"> / {limit}</span> : null}
        </strong>
      </div>
      <div className="usage-meter-track" role="progressbar" aria-valuenow={used} aria-valuemax={limit}>
        <div
          className="usage-meter-fill"
          style={{ width: `${Math.max(2, Math.round(ratio * 100))}%`, background: fillColor }}
        />
      </div>
    </div>
  );
}

function BillingView({ usage, onUsageRefresh }: { usage: UsageSnapshot | null; onUsageRefresh: () => void }) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "info" | "warn"; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getBillingStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load billing.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const flag = url.searchParams.get("billing");
    if (flag === "success") {
      setBanner({ kind: "success", message: "Subscription updated. Welcome aboard." });
    } else if (flag === "cancelled") {
      setBanner({ kind: "info", message: "Checkout cancelled. Your plan was not changed." });
    } else if (flag === "upgrade") {
      setBanner({ kind: "warn", message: "You hit a usage limit. Pick a plan to keep shipping." });
    }
    if (flag) {
      url.searchParams.delete("billing");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  async function handleSelectPlan(plan: Plan) {
    if (busyPlan) return;
    setBusyPlan(plan.id);
    try {
      const session = await startCheckout(plan.id);
      if (session?.url) {
        window.location.assign(session.url);
        return;
      }
      setBanner({ kind: "warn", message: "Stripe did not return a checkout URL. Try again." });
    } catch (err) {
      setBanner({ kind: "warn", message: err instanceof Error ? err.message : "Checkout failed." });
    } finally {
      setBusyPlan(null);
    }
  }

  async function handleManageSubscription() {
    if (portalBusy) return;
    setPortalBusy(true);
    try {
      const session = await openBillingPortal();
      if (session?.url) {
        window.location.assign(session.url);
        return;
      }
      setBanner({ kind: "warn", message: "Stripe did not return a portal URL." });
    } catch (err) {
      setBanner({ kind: "warn", message: err instanceof Error ? err.message : "Could not open billing portal." });
    } finally {
      setPortalBusy(false);
    }
  }

  if (loading) {
    return (
      <>
        <header className="wb-top">
          <div className="wb-top-left">
            <h1 className="wb-h1">
              <span className="hl-pist">Billing</span>
            </h1>
            <span className="wb-crumbs"><span className="pill">Loading plan and usage…</span></span>
          </div>
        </header>
      </>
    );
  }
  if (error || !status) {
    return (
      <>
        <header className="wb-top">
          <div className="wb-top-left">
            <h1 className="wb-h1">
              <span className="hl-pist">Billing</span>
            </h1>
            <span className="wb-crumbs"><span className="pill">{error || "Billing is unavailable right now."}</span></span>
          </div>
        </header>
      </>
    );
  }

  const currentPlanId = status.current_plan.id;
  const customerExists = Boolean(usage?.subscription || status.subscription);
  const billingConfigured = status.billing_configured;

  return (
    <>
      <header className="wb-top">
        <div className="wb-top-left">
          <h1 className="wb-h1">
            Plans &amp; <span className="hl-pist">usage</span>
          </h1>
          <span className="wb-crumbs">
            <span className="pill">{status.current_plan.name} plan</span>
            <span className="pill">
              {status.commercial_use_enabled ? "commercial-ready" : "research-only"}
            </span>
          </span>
        </div>
        <div className="wb-top-right">
          {customerExists && billingConfigured ? (
            <button type="button" className="btn ghost" onClick={handleManageSubscription} disabled={portalBusy}>
              {portalBusy ? "Opening…" : "Manage subscription"}
            </button>
          ) : null}
        </div>
      </header>

      {banner ? (
        <div className={`banner ${banner.kind === "success" ? "ok" : banner.kind === "warn" ? "error" : ""}`} role="status">
          {banner.message}
        </div>
      ) : null}

      {usage ? <BillingUsageSummary usage={usage} onRefresh={onUsageRefresh} /> : null}

      <div className="pricing-grid">
        {status.plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            current={plan.id === currentPlanId}
            busy={busyPlan === plan.id}
            billingConfigured={billingConfigured}
            onSelect={() => handleSelectPlan(plan)}
          />
        ))}
      </div>

      <div className="billing-footnote">
        <p className="hint">
          Prices are in USD and billed monthly via Stripe. Cancel any time from the customer portal — your plan stays active
          until the end of the billing cycle.
        </p>
        <p className="hint">
          License mode: <code>{status.license.mode}</code> · provider <code>{status.license.provider}</code>
          {status.license.tribe_commercial_license ? " · TRIBE commercial license active" : ""}
        </p>
      </div>
    </>
  );
}

function BillingUsageSummary({ usage, onRefresh }: { usage: UsageSnapshot; onRefresh: () => void }) {
  const period = usage.period;
  const monthlyComp = usage.monthly_usage.comparison;
  const monthlyAsset = usage.monthly_usage.asset;
  const compLimit = usage.monthly_limits.comparison;
  const assetLimit = usage.monthly_limits.asset;
  const compRatio = compLimit > 0 ? Math.min(1, monthlyComp / compLimit) : 0;
  const assetRatio = assetLimit > 0 ? Math.min(1, monthlyAsset / assetLimit) : 0;
  const reset = period?.end ? new Date(period.end) : null;
  const subscription = usage.subscription;

  return (
    <div className="billing-usage-card">
      <div className="billing-usage-head">
        <div>
          <strong>This billing period</strong>
          {reset ? (
            <p className="hint">
              Resets {reset.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
              {period.source === "calendar_month" ? " (calendar month)" : ""}
            </p>
          ) : null}
        </div>
        <div className="billing-usage-actions">
          <button type="button" className="btn ghost small" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </div>
      <div className="billing-usage-meters">
        <UsageMeter label="Comparisons this month" used={monthlyComp} limit={compLimit} ratio={compRatio} />
        <UsageMeter label="Assets this month" used={monthlyAsset} limit={assetLimit} ratio={assetRatio} />
      </div>
      {subscription && subscription.status !== "active" ? (
        <p className="hint" style={{ marginTop: 12 }}>
          Subscription status: <code>{subscription.status}</code>
          {subscription.cancel_at_period_end ? " · scheduled to cancel at period end" : ""}
        </p>
      ) : null}
    </div>
  );
}

function PlanCard({
  plan,
  current,
  busy,
  billingConfigured,
  onSelect
}: {
  plan: Plan;
  current: boolean;
  busy: boolean;
  billingConfigured: boolean;
  onSelect: () => void;
}) {
  const price = plan.price_cents_monthly ?? 0;
  const priceLabel = price > 0 ? `$${(price / 100).toFixed(0)}` : "Free";
  const canUpgrade = !current && plan.id !== "research" && plan.configured && billingConfigured;
  const cta = current
    ? "Current plan"
    : plan.id === "research"
    ? "Default plan"
    : !plan.configured
    ? "Coming soon"
    : !billingConfigured
    ? "Billing offline"
    : `Upgrade to ${plan.name}`;

  return (
    <div className={`plan-card ${current ? "current" : ""}`}>
      <div className="plan-card-head">
        <h2>{plan.name}</h2>
        {plan.tagline ? <p className="hint">{plan.tagline}</p> : null}
      </div>
      <div className="plan-card-price">
        <span className="plan-price-amount">{priceLabel}</span>
        {price > 0 ? <span className="plan-price-period">/month</span> : null}
      </div>
      <ul className="plan-card-features">
        <li>
          <strong>{plan.comparison_limit_per_month ?? 0}</strong> comparisons / month
        </li>
        <li>
          <strong>{plan.asset_limit_per_month ?? 0}</strong> assets / month
        </li>
        <li>
          <strong>{plan.seats ?? 1}</strong> {plan.seats === 1 ? "seat" : "seats"}
        </li>
        <li>
          <strong>{plan.retention_days ?? 30}</strong>-day history retention
        </li>
        {(plan.features || []).map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>
      <button
        type="button"
        className={`btn ${current ? "ghost" : "primary"}`}
        onClick={onSelect}
        disabled={!canUpgrade || busy}
      >
        {busy ? "Redirecting…" : cta}
      </button>
    </div>
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
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((asset) => {
      if (filter !== "all" && asset.type !== filter) return false;
      if (!q) return true;
      return (
        asset.name.toLowerCase().includes(q) ||
        (asset.extracted_text || "").toLowerCase().includes(q) ||
        (asset.source_url || "").toLowerCase().includes(q)
      );
    });
  }, [items, filter, query]);

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected(new Set(visible.map((asset) => asset.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function performBulkDelete() {
    if (selected.size === 0) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    let success = 0;
    let failure = 0;
    // Sequential — Cloudflare Pages Functions don't love a burst of
    // workspace-scoped writes from one client. Sequential keeps us under
    // the per-IP rate limit and means partial failures don't strand
    // half the selection in an unknown state.
    for (const id of ids) {
      try {
        await deleteAsset(id);
        success += 1;
      } catch (err) {
        console.warn(err);
        failure += 1;
      }
    }
    setItems((current) => current.filter((asset) => !selected.has(asset.id)));
    setSelected(new Set());
    setBulkBusy(false);
    setConfirmBulkDelete(false);
    if (failure === 0) {
      show("success", `Deleted ${success} ${success === 1 ? "asset" : "assets"}.`);
    } else if (success === 0) {
      show("error", `Could not delete the selected ${failure === 1 ? "asset" : "assets"}.`);
    } else {
      show("info", `Deleted ${success}, ${failure} could not be removed.`);
    }
  }

  const allVisibleSelected = visible.length > 0 && visible.every((asset) => selected.has(asset.id));

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
        <div className="library-toolbar">
          <input
            type="search"
            className="library-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search variants by name, body text, or URL…"
            aria-label="Search library"
          />
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
        </div>
      ) : null}

      {selected.size > 0 ? (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <span>
            <strong>{selected.size}</strong> {selected.size === 1 ? "asset" : "assets"} selected
          </span>
          <div className="bulk-bar-actions">
            <button
              type="button"
              className="btn cream small"
              onClick={allVisibleSelected ? clearSelection : selectAllVisible}
            >
              {allVisibleSelected ? "Clear selection" : `Select all ${visible.length}`}
            </button>
            <button
              type="button"
              className="btn cream small"
              style={{
                background: "var(--tomato-soft)",
                borderColor: "var(--tomato-ink)",
                color: "var(--tomato-ink)"
              }}
              onClick={() => setConfirmBulkDelete(true)}
              disabled={bulkBusy}
            >
              {bulkBusy ? "Deleting…" : `Delete ${selected.size}`}
            </button>
          </div>
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
          <h4>{query.trim() ? "No matches for that search." : "No assets in this filter."}</h4>
          <p>{query.trim() ? "Try a shorter or different term." : "Try a different type or upload another variant from the workbench."}</p>
          {query.trim() ? (
            <button className="btn cream" onClick={() => setQuery("")} style={{ marginTop: 12 }}>
              Clear search
            </button>
          ) : null}
        </div>
      ) : (
        <div className="list-grid">
          {visible.map((asset, idx) => {
            const accent = ["var(--tomato)", "var(--pistachio)", "var(--butter)", "var(--plum)"][idx % 4];
            const isOpen = expandedId === asset.id;
            const previewText = (asset.extracted_text || "").trim();
            const isSelected = selected.has(asset.id);
            return (
              <article
                key={asset.id}
                className={`list-card ${isSelected ? "selected" : ""}`}
                style={{ borderLeft: `6px solid ${accent}` }}
              >
                <label className="list-select" aria-label={`Select ${asset.name}`}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelected(asset.id)}
                  />
                </label>
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

      <ConfirmDialog
        open={confirmBulkDelete}
        title={`Delete ${selected.size} ${selected.size === 1 ? "asset" : "assets"}?`}
        confirmLabel={bulkBusy ? "Deleting…" : `Delete ${selected.size}`}
        message={
          <>
            <p>
              The selected {selected.size === 1 ? "asset" : "assets"} will be removed from your library and
              from any new comparisons. Existing comparison reports keep their snapshots.
            </p>
            <p style={{ marginTop: 8, color: "var(--ink-soft)", fontSize: 12 }}>This can't be undone.</p>
          </>
        }
        onCancel={() => setConfirmBulkDelete(false)}
        onConfirm={performBulkDelete}
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
  const [outcomes, setOutcomes] = useState<WorkspaceOutcome[]>([]);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const { toast, show, dismiss } = useLocalToast();

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [s, o, c] = await Promise.all([
        getLearningSummary(),
        listWorkspaceOutcomes().catch(() => [] as WorkspaceOutcome[]),
        listComparisons().catch(() => [] as Comparison[])
      ]);
      setSummary(s);
      setOutcomes(o);
      setComparisons(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load outcomes.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getLearningSummary(),
      listWorkspaceOutcomes().catch(() => [] as WorkspaceOutcome[]),
      listComparisons().catch(() => [] as Comparison[])
    ])
      .then(([s, o, c]) => {
        if (cancelled) return;
        setSummary(s);
        setOutcomes(o);
        setComparisons(c);
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

  const completedComparisons = useMemo(
    () => comparisons.filter((c) => c.status === "complete"),
    [comparisons]
  );

  async function submitOutcome(payload: OutcomeCreate & { comparison_id: string }) {
    await createOutcome(payload.comparison_id, {
      asset_id: payload.asset_id,
      spend: payload.spend,
      impressions: payload.impressions,
      clicks: payload.clicks,
      conversions: payload.conversions,
      revenue: payload.revenue,
      notes: payload.notes
    });
    show("success", "Outcome logged.");
    await refresh();
  }

  const hasOutcomes = outcomes.length > 0 || (summary?.outcome_count ?? 0) > 0;

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
              {summary?.outcome_count ?? 0} {summary?.outcome_count === 1 ? "outcome" : "outcomes"}
            </span>
            {summary && summary.calibration.evaluated_comparisons > 0 ? (
              <span className="pill">
                <span className="dot" style={{ background: "var(--pistachio)" }} />
                {Math.round(summary.calibration.alignment_rate * 100)}% alignment
              </span>
            ) : null}
          </span>
        </div>
        <div className="wb-top-right">
          <button className="btn cream" onClick={refresh} disabled={loading}>
            Refresh
          </button>
          <button
            className="btn cream"
            onClick={() => exportOutcomesCsv(outcomes)}
            disabled={outcomes.length === 0}
            title={outcomes.length === 0 ? "No outcomes to export yet" : "Download outcomes as CSV"}
          >
            Export CSV
          </button>
          <button
            className="btn primary"
            onClick={() => setLogOpen(true)}
            disabled={completedComparisons.length === 0}
            title={completedComparisons.length === 0 ? "Run a comparison first" : ""}
          >
            Log outcome
          </button>
        </div>
      </header>
      {error ? <div className="banner error">{error}</div> : null}

      {loading && !summary ? (
        <div className="banner">Loading…</div>
      ) : !hasOutcomes ? (
        <div className="panel-card empty" style={{ paddingTop: 60, paddingBottom: 60 }}>
          <BrainBlob size={120} color="var(--plum)" eyes mouth />
          <h4>No launch outcomes logged yet.</h4>
          <p>
            After you run an ad, log spend and revenue here. Once a few outcomes are in, Stimli compares its
            pre-spend prediction against actual performance and surfaces the alignment rate.
          </p>
          {completedComparisons.length === 0 ? (
            <a className="btn primary" href="/app">
              Open the workbench
            </a>
          ) : (
            <button className="btn primary" onClick={() => setLogOpen(true)}>
              Log your first outcome
            </button>
          )}
        </div>
      ) : (
        <div className="wb-col">
          <div className="panel-card">
            <div className="panel-head">
              <h3>Where the brain calls match the spreadsheet</h3>
              <span className="kicker">{summary?.outcome_count ?? 0} outcomes logged</span>
            </div>
            <p className="big-p">{summary?.insight}</p>
            <div className="metric-grid">
              <div className="metric">
                <span>Total spend</span>
                <strong>${formatNumber(summary?.total_spend ?? 0)}</strong>
              </div>
              <div className="metric">
                <span>Total revenue</span>
                <strong>${formatNumber(summary?.total_revenue ?? 0)}</strong>
              </div>
              <div className="metric">
                <span>Avg CTR</span>
                <strong>{((summary?.average_ctr ?? 0) * 100).toFixed(2)}%</strong>
              </div>
              <div className="metric">
                <span>Avg CVR</span>
                <strong>{((summary?.average_cvr ?? 0) * 100).toFixed(2)}%</strong>
              </div>
            </div>
          </div>

          {summary && summary.calibration.evaluated_comparisons > 0 ? (
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
                      <th>Actual best</th>
                      <th>Aligned</th>
                      <th>Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.calibration.recent.map((row) => (
                      <tr key={row.comparison_id}>
                        <td>{row.comparison_id.slice(0, 10)}</td>
                        <td>{row.predicted_asset_id.slice(0, 8)}</td>
                        <td>{row.actual_best_asset_id.slice(0, 8)}</td>
                        <td>{row.aligned ? "✓" : "—"}</td>
                        <td>${formatNumber(row.actual_profit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ) : null}

          <div className="panel-card">
            <div className="panel-head">
              <h3>Recent outcomes</h3>
              <span className="kicker">latest {Math.min(outcomes.length, 25)} logged</span>
            </div>
            {outcomes.length === 0 ? (
              <p className="hint">Outcomes will appear here once you log one.</p>
            ) : (
              outcomes.slice(0, 25).map((row) => {
                const profit = row.profit;
                const profitClass =
                  profit === null ? "" : profit >= 0 ? "profit-pos" : "profit-neg";
                return (
                  <div key={row.id} className="outcome-summary-row">
                    <div style={{ minWidth: 0 }}>
                      <strong>{row.asset_name || row.asset_id.slice(0, 12)}</strong>
                      <span className="meta" style={{ display: "block", marginTop: 2 }}>
                        {row.comparison_objective || row.comparison_id.slice(0, 12)} ·{" "}
                        {new Date(row.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <div style={{ textAlign: "right", fontSize: 12 }}>
                      <div>
                        <span style={{ color: "var(--ink-soft)" }}>spend</span>{" "}
                        <strong>${formatNumber(row.spend)}</strong>{" "}
                        · <span style={{ color: "var(--ink-soft)" }}>rev</span>{" "}
                        <strong>${formatNumber(row.revenue)}</strong>
                      </div>
                      {profit !== null ? (
                        <div className={profitClass} style={{ marginTop: 4 }}>
                          profit ${formatNumber(profit)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {logOpen ? (
        <LogOutcomeModal
          comparisons={completedComparisons}
          onClose={() => setLogOpen(false)}
          onSubmit={async (payload) => {
            await submitOutcome(payload);
            setLogOpen(false);
          }}
        />
      ) : null}

      <ToastBar toast={toast} onDismiss={dismiss} />
    </>
  );
}

function LogOutcomeModal({
  comparisons,
  onClose,
  onSubmit
}: {
  comparisons: Comparison[];
  onClose: () => void;
  onSubmit: (payload: OutcomeCreate & { comparison_id: string }) => Promise<void>;
}) {
  const [comparisonId, setComparisonId] = useState<string>(comparisons[0]?.id ?? "");
  const selected = useMemo(
    () => comparisons.find((c) => c.id === comparisonId) || null,
    [comparisons, comparisonId]
  );
  const [assetId, setAssetId] = useState<string>(
    selected?.recommendation?.winner_asset_id || selected?.variants[0]?.asset.id || ""
  );
  useEffect(() => {
    if (selected && !selected.variants.some((v) => v.asset.id === assetId)) {
      setAssetId(selected.recommendation?.winner_asset_id || selected.variants[0]?.asset.id || "");
    }
  }, [selected, assetId]);

  const [spend, setSpend] = useState("");
  const [revenue, setRevenue] = useState("");
  const [impressions, setImpressions] = useState("");
  const [clicks, setClicks] = useState("");
  const [conversions, setConversions] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [busy, onClose]);

  function num(value: string): number {
    const cleaned = value.replace(/[,$\s]/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  async function submit() {
    if (!comparisonId || !assetId) {
      setError("Pick a comparison and a variant.");
      return;
    }
    if (!spend.trim() && !revenue.trim() && !impressions.trim() && !clicks.trim() && !conversions.trim()) {
      setError("Add at least one metric.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        comparison_id: comparisonId,
        asset_id: assetId,
        spend: num(spend),
        revenue: num(revenue),
        impressions: num(impressions),
        clicks: num(clicks),
        conversions: num(conversions),
        notes: notes.trim() || "Logged from outcomes"
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not log outcome.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-overlay" onClick={onClose} role="presentation">
      <div
        className="auth-modal outcome-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="log-outcome-title"
      >
        <button className="auth-close" onClick={onClose} aria-label="Close log outcome dialog">
          ×
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <BrainBlob size={48} color="var(--plum)" eyes mouth />
          <h2 id="log-outcome-title">Log outcome</h2>
        </div>
        <p className="lead">
          Logged spend and revenue calibrate the brain's confidence against real campaign performance. Each
          outcome only takes one metric to be useful — fill what you have.
        </p>
        <label className="field">
          <span>Comparison</span>
          <select
            value={comparisonId}
            onChange={(e) => setComparisonId(e.target.value)}
            className="member-role-select"
            style={{ width: "100%", fontSize: 14, padding: 8 }}
          >
            {comparisons.map((c) => (
              <option key={c.id} value={c.id}>
                {(c.objective || c.id).slice(0, 64)} · {new Date(c.created_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Variant</span>
          <select
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
            className="member-role-select"
            style={{ width: "100%", fontSize: 14, padding: 8 }}
          >
            {selected?.variants.map((variant) => (
              <option key={variant.asset.id} value={variant.asset.id}>
                {variant.asset.name}
                {selected.recommendation?.winner_asset_id === variant.asset.id ? "  (predicted winner)" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="outcome-grid">
          <label className="field">
            <span>Spend (USD)</span>
            <input value={spend} onChange={(e) => setSpend(e.target.value)} inputMode="decimal" placeholder="1500" />
          </label>
          <label className="field">
            <span>Revenue (USD)</span>
            <input value={revenue} onChange={(e) => setRevenue(e.target.value)} inputMode="decimal" placeholder="2400" />
          </label>
          <label className="field">
            <span>Impressions</span>
            <input value={impressions} onChange={(e) => setImpressions(e.target.value)} inputMode="numeric" placeholder="42000" />
          </label>
          <label className="field">
            <span>Clicks</span>
            <input value={clicks} onChange={(e) => setClicks(e.target.value)} inputMode="numeric" placeholder="980" />
          </label>
          <label className="field">
            <span>Conversions</span>
            <input value={conversions} onChange={(e) => setConversions(e.target.value)} inputMode="numeric" placeholder="38" />
          </label>
        </div>
        <label className="field">
          <span>Notes (optional)</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Channel, audience, dates…" />
        </label>
        {error ? <div className="auth-error">{error}</div> : null}
        <div className="form-actions" style={{ justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save outcome"}
          </button>
        </div>
      </div>
    </div>
  );
}

const ROLE_OPTIONS: TeamRole[] = ["owner", "admin", "analyst", "viewer"];

function TeamView({ session, onUpdate }: { session: AuthSession | null; onUpdate: () => Promise<void> }) {
  // Clerk is the source of truth for "is the user signed in" — when the
  // backend session lookup is still pending (or has briefly failed), we
  // shouldn't pretend the user is anonymous and hide the team UI.
  const { isLoaded: clerkLoaded, isSignedIn, user: clerkUser } = useUser();
  const signedIn = Boolean(clerkLoaded && isSignedIn);
  const clerkUserLabel =
    clerkUser?.primaryEmailAddress?.emailAddress ||
    clerkUser?.fullName ||
    clerkUser?.username ||
    "you";

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [inviteRole, setInviteRole] = useState<TeamRole>("analyst");
  const [inviteEmail, setInviteEmail] = useState("");
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [confirmRemove, setConfirmRemove] = useState<TeamMember | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<TeamInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast, show, dismiss } = useLocalToast();

  useEffect(() => {
    if (!signedIn) return;
    void refresh();
  }, [signedIn, session?.team?.id]);

  async function refresh() {
    try {
      const [membersList, invitesList, events] = await Promise.all([
        listTeamMembers().catch(() => [] as TeamMember[]),
        listTeamInvites().catch(() => [] as TeamInvite[]),
        listAuditEvents().catch(() => [] as AuditEvent[])
      ]);
      setMembers(membersList);
      setInvites(invitesList);
      setAudit(events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load team.");
    }
  }

  async function invite() {
    setBusy(true);
    setError(null);
    try {
      const result = await createTeamInvite({ email: inviteEmail.trim() || undefined, role: inviteRole });
      setLastInviteUrl(result.url ?? null);
      setCopyState("idle");
      setInviteEmail("");
      if (result.url) {
        try {
          await navigator.clipboard.writeText(result.url);
          setCopyState("copied");
          show("success", "Invite link copied to clipboard.");
        } catch {
          show("info", "Invite link created — copy from the banner below.");
        }
      }
      await onUpdate();
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not create invite.";
      setError(message);
      show("error", message);
    } finally {
      setBusy(false);
    }
  }

  async function copyAgain() {
    if (!lastInviteUrl) return;
    try {
      await navigator.clipboard.writeText(lastInviteUrl);
      setCopyState("copied");
      show("success", "Invite link copied.");
    } catch {
      show("error", "Could not copy. Select the link manually.");
    }
  }

  async function changeRole(member: TeamMember, role: TeamRole) {
    if (member.role === role) return;
    setBusy(true);
    try {
      const updated = await updateTeamMemberRole(member.user_id, role);
      setMembers((current) => current.map((m) => (m.user_id === member.user_id ? updated : m)));
      show("success", `${member.name || member.email} is now ${role}.`);
    } catch (err) {
      show("error", err instanceof Error ? err.message : "Could not update role.");
    } finally {
      setBusy(false);
    }
  }

  async function performRemove(member: TeamMember) {
    setBusy(true);
    try {
      await removeTeamMember(member.user_id);
      setMembers((current) => current.filter((m) => m.user_id !== member.user_id));
      show("success", `Removed ${member.name || member.email}.`);
    } catch (err) {
      show("error", err instanceof Error ? err.message : "Could not remove member.");
    } finally {
      setBusy(false);
      setConfirmRemove(null);
    }
  }

  async function performRevoke(invite: TeamInvite) {
    setBusy(true);
    try {
      await revokeTeamInvite(invite.id);
      setInvites((current) => current.filter((i) => i.id !== invite.id));
      show("success", "Invite revoked.");
    } catch (err) {
      show("error", err instanceof Error ? err.message : "Could not revoke invite.");
    } finally {
      setBusy(false);
      setConfirmRevoke(null);
    }
  }

  if (!signedIn) {
    return (
      <div className="panel-card empty" style={{ paddingTop: 60, paddingBottom: 60 }}>
        <BrainBlob size={120} color="var(--ink)" eyes mouth />
        <h4>Sign in to manage your team.</h4>
        <p>Once signed in you can invite collaborators, set roles, revoke pending invites, and review audit history.</p>
        <SignInTrigger className="btn primary">Sign in</SignInTrigger>
      </div>
    );
  }

  // Signed in per Clerk, but backend hasn't recognized the JWT yet (or
  // rejected it). Surface the reason so we can diagnose instead of looping
  // back to the sign-in prompt (which no-ops when Clerk already has a
  // session). Once the backend agrees, this branch is skipped.
  if (!session?.authenticated) {
    const reason =
      (session as (AuthSession & { debug_reason?: string | null }) | null)?.debug_reason ||
      "Pending — backend session not yet established.";
    return (
      <div className="panel-card empty" style={{ paddingTop: 60, paddingBottom: 60 }}>
        <BrainBlob size={120} color="var(--tomato)" eyes mouth />
        <h4>Connecting to your workspace…</h4>
        <p style={{ marginTop: 8, color: "var(--ink-soft)" }}>
          Signed in as <strong>{clerkUserLabel}</strong>. Waiting for the workspace API to acknowledge the
          session.
        </p>
        <p style={{ marginTop: 12, fontFamily: "monospace", fontSize: 12, color: "var(--ink-soft)" }}>
          {reason}
        </p>
        <button className="btn cream" onClick={() => void onUpdate()} style={{ marginTop: 12 }}>
          Retry
        </button>
      </div>
    );
  }

  const pendingInvites = invites.filter((invite) => !invite.accepted_at);

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
              {members.length} {members.length === 1 ? "member" : "members"}
            </span>
            {pendingInvites.length > 0 ? (
              <span className="pill">
                <span className="dot" style={{ background: "var(--butter)" }} />
                {pendingInvites.length} pending {pendingInvites.length === 1 ? "invite" : "invites"}
              </span>
            ) : null}
            <span className="pill">
              <span className="dot" style={{ background: "var(--tomato)" }} />
              {session.team?.name}
            </span>
          </span>
        </div>
        <div className="wb-top-right">
          <button className="btn cream" onClick={refresh} disabled={busy}>
            Refresh
          </button>
        </div>
      </header>
      {error ? <div className="banner error">{error}</div> : null}
      <div className="wb-grid" style={{ gridTemplateColumns: "360px 1fr" }}>
        <section className="panel-card">
          <div className="panel-head">
            <h3>Invite collaborator</h3>
            <span className="kicker">expires in 14 days</span>
          </div>
          <div className="add-form">
            <label className="field">
              <span>Email (optional)</span>
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@brand.com"
                type="email"
              />
            </label>
            <label className="field">
              <span>Role</span>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as TeamRole)}
                className="member-role-select"
                style={{ width: "100%", fontSize: 14, padding: "10px 12px" }}
              >
                {ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint" style={{ fontSize: 11.5, margin: 0 }}>
              <strong>owner</strong> · full control · <strong>admin</strong> · members + jobs ·{" "}
              <strong>analyst</strong> · run comparisons · <strong>viewer</strong> · read only
            </p>
            <button className="btn primary wide" onClick={invite} disabled={busy}>
              Create invite link
            </button>
            {lastInviteUrl ? (
              <div className="invite-banner">
                <code>{lastInviteUrl}</code>
                <button className="btn cream small" onClick={copyAgain} type="button">
                  {copyState === "copied" ? "Copied" : "Copy"}
                </button>
              </div>
            ) : null}
          </div>
        </section>

        <section className="wb-col">
          {pendingInvites.length > 0 ? (
            <div className="panel-card">
              <div className="panel-head">
                <h3>Pending invites</h3>
                <span className="kicker">{pendingInvites.length}</span>
              </div>
              <table className="simple-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                    <th>Sent</th>
                    <th aria-label="actions" />
                  </tr>
                </thead>
                <tbody>
                  {pendingInvites.map((invite) => (
                    <tr key={invite.id}>
                      <td>{invite.email || <em style={{ color: "var(--ink-soft)" }}>(any email)</em>}</td>
                      <td>
                        <span className="claim-pill">{invite.role}</span>
                      </td>
                      <td>{new Date(invite.expires_at).toLocaleDateString()}</td>
                      <td>{new Date(invite.created_at).toLocaleDateString()}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className="btn cream small"
                          onClick={() => setConfirmRevoke(invite)}
                          disabled={busy}
                          style={{
                            background: "var(--tomato-soft)",
                            borderColor: "var(--tomato-ink)",
                            color: "var(--tomato-ink)"
                          }}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

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
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const isSelf = member.user_id === session.user?.id;
                  return (
                    <tr key={member.user_id}>
                      <td>{member.name || <em style={{ color: "var(--ink-soft)" }}>—</em>}</td>
                      <td>{member.email}</td>
                      <td>
                        <select
                          className="member-role-select"
                          value={member.role}
                          onChange={(e) => changeRole(member, e.target.value as TeamRole)}
                          disabled={busy || isSelf}
                          title={isSelf ? "Change your own role from your account settings" : ""}
                        >
                          {ROLE_OPTIONS.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{new Date(member.created_at).toLocaleDateString()}</td>
                      <td style={{ textAlign: "right" }}>
                        {isSelf ? (
                          <span className="hint" style={{ fontSize: 11 }}>that's you</span>
                        ) : (
                          <button
                            className="btn cream small"
                            onClick={() => setConfirmRemove(member)}
                            disabled={busy}
                            style={{
                              background: "var(--tomato-soft)",
                              borderColor: "var(--tomato-ink)",
                              color: "var(--tomato-ink)"
                            }}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <AuditLogPanel audit={audit} />
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(confirmRemove)}
        title="Remove this member?"
        confirmLabel="Remove member"
        message={
          <p>
            <strong>{confirmRemove?.name || confirmRemove?.email}</strong> will lose access to{" "}
            <strong>{session.team?.name}</strong>. Their personal team and any other team memberships are
            unaffected.
          </p>
        }
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => confirmRemove && performRemove(confirmRemove)}
      />

      <ConfirmDialog
        open={Boolean(confirmRevoke)}
        title="Revoke this invite?"
        confirmLabel="Revoke invite"
        message={
          <p>
            The invite link {confirmRevoke?.email ? <>for <strong>{confirmRevoke.email}</strong> </> : null}
            will stop working immediately. You can always create a new one.
          </p>
        }
        onCancel={() => setConfirmRevoke(null)}
        onConfirm={() => confirmRevoke && performRevoke(confirmRevoke)}
      />

      <ToastBar toast={toast} onDismiss={dismiss} />
    </>
  );
}

function AuditLogPanel({ audit }: { audit: AuditEvent[] }) {
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [showAll, setShowAll] = useState(false);

  const actions = useMemo(() => {
    const set = new Set<string>();
    for (const event of audit) set.add(event.action);
    return Array.from(set).sort();
  }, [audit]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return audit.filter((event) => {
      if (actionFilter !== "all" && event.action !== actionFilter) return false;
      if (!q) return true;
      return (
        event.action.toLowerCase().includes(q) ||
        (event.actor_email || "").toLowerCase().includes(q) ||
        event.target_type.toLowerCase().includes(q) ||
        (event.target_id || "").toLowerCase().includes(q)
      );
    });
  }, [audit, actionFilter, query]);

  const visible = showAll ? filtered : filtered.slice(0, 25);

  return (
    <div className="panel-card">
      <div className="panel-head">
        <h3>Audit log</h3>
        <span className="kicker">
          {filtered.length} {filtered.length === 1 ? "event" : "events"}
          {filtered.length !== audit.length ? ` of ${audit.length}` : ""}
        </span>
      </div>
      {audit.length === 0 ? (
        <p className="hint">No audit events yet. Adding variants and running comparisons will start the trail.</p>
      ) : (
        <>
          <div className="audit-toolbar">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by actor, action, or target…"
              aria-label="Search audit log"
              className="library-search"
              style={{ minWidth: 220 }}
            />
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="member-role-select"
              aria-label="Filter by action"
            >
              <option value="all">All actions ({actions.length})</option>
              {actions.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
            {(query.trim() || actionFilter !== "all") && (
              <button
                type="button"
                className="btn cream small"
                onClick={() => {
                  setQuery("");
                  setActionFilter("all");
                }}
              >
                Clear
              </button>
            )}
          </div>
          {filtered.length === 0 ? (
            <p className="hint" style={{ marginTop: 12 }}>
              No events match those filters.
            </p>
          ) : (
            <>
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
                  {visible.map((event) => (
                    <tr key={event.id}>
                      <td>{new Date(event.created_at).toLocaleString()}</td>
                      <td>{event.actor_email || "—"}</td>
                      <td>
                        <code>{event.action}</code>
                      </td>
                      <td>{event.target_type}{event.target_id ? ` · ${event.target_id.slice(0, 10)}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length > 25 ? (
                <button
                  type="button"
                  className="btn cream small"
                  style={{ marginTop: 10 }}
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? "Show less" : `Show all ${filtered.length}`}
                </button>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
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

  function handlePrint() {
    window.print();
  }

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
  const ranked = [...report.variants].sort((a, b) => a.rank - b.rank);
  const variantColors = ["var(--tomato)", "var(--pistachio)", "var(--butter)", "var(--plum)"];
  const neuralVariants: NeuralVariant[] = ranked.map((variant, idx) => ({
    id: variant.asset.id,
    label: variant.asset.name.split("·")[0]?.trim() ?? variant.asset.name,
    color: variantColors[idx % variantColors.length],
    timeline: variant.analysis.timeline ?? []
  }));
  const provider = winner?.analysis.provider || ranked[0]?.analysis.provider || "stimli";
  const confidencePct = Math.round((report.recommendation.confidence ?? 0) * 100);

  return (
    <div className="share-page paper-bg shared-report">
      <header className="shared-report-head">
        <a className="brand" href="/">
          <BrainBlob size={42} color="var(--tomato)" />
          <span className="brand-word">stimli</span>
        </a>
        <div className="shared-report-actions">
          <span className="shared-report-badge">
            <span className="dot" style={{ background: "var(--pistachio)" }} />
            shared decision report
          </span>
          <button type="button" className="btn cream small no-print" onClick={handlePrint}>
            Print / save as PDF
          </button>
        </div>
      </header>

      <h1 className="shared-report-title">{report.title}</h1>
      <p className="shared-report-summary">{report.executive_summary}</p>

      <div className="panel-card shared-report-hero">
        <div className="shared-report-hero-grid">
          <div>
            <span className="kicker">recommendation</span>
            <h2 className="shared-report-headline">{report.recommendation.headline}</h2>
            <div className="shared-report-conf">
              <strong>
                {confidencePct}
                <small>%</small>
              </strong>
              <span>confidence</span>
              <span className={`verdict-pill verdict-${report.recommendation.verdict}`}>
                {report.recommendation.verdict}
              </span>
            </div>
            <ul className="shared-report-reasons">
              {report.recommendation.reasons.map((reason, idx) => (
                <li key={`${idx}-${reason.slice(0, 24)}`}>{reason}</li>
              ))}
            </ul>
          </div>
          <BrainBlob size={140} color={variantColors[0]} eyes mouth />
        </div>
      </div>

      {neuralVariants.some((v) => v.timeline.length >= 2) ? (
        <div className="panel-card" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <h3>Predicted brain response</h3>
            <span className="kicker">per second · {provider}</span>
          </div>
          <NeuralTimeline
            activeVariantId={report.recommendation.winner_asset_id || undefined}
            variants={neuralVariants}
          />
        </div>
      ) : null}

      <div className="panel-card" style={{ marginTop: 18 }}>
        <div className="panel-head">
          <h3>Variants</h3>
          <span className="kicker">{ranked.length} ranked</span>
        </div>
        <div className="shared-variant-grid">
          {ranked.map((variant, idx) => {
            const isWinner = variant.asset.id === report.recommendation.winner_asset_id;
            const color = variantColors[idx % variantColors.length];
            return (
              <article key={variant.asset.id} className={`shared-variant ${isWinner ? "winner" : ""}`}>
                <header>
                  <span className="swatch" style={{ background: color }} />
                  <strong>{variant.asset.name}</strong>
                  {isWinner ? <span className="winner-pill">winner</span> : null}
                </header>
                <p className="hint">{variant.analysis.summary}</p>
                <div className="shared-variant-scores">
                  <span>
                    Overall <strong>{Math.round(variant.analysis.scores.overall)}</strong>
                  </span>
                  <span>
                    Hook <strong>{Math.round(variant.analysis.scores.hook)}</strong>
                  </span>
                  <span>
                    Attention <strong>{Math.round(variant.analysis.scores.neural_attention)}</strong>
                  </span>
                  <span>
                    Memory <strong>{Math.round(variant.analysis.scores.memory)}</strong>
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {report.suggestions.length ? (
        <div className="panel-card" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <h3>Edits before launch</h3>
            <span className="kicker">{report.suggestions.length} · prioritized</span>
          </div>
          <ol className="shared-edits">
            {report.suggestions.map((entry, idx) => {
              const window = entry.evidence_window;
              const lift = entry.expected_lift;
              return (
                <li key={idx}>
                  <div>
                    <strong>{entry.target}</strong>
                    <p>{entry.suggested_edit}</p>
                    <div className="shared-edit-meta">
                      <span className={`severity sev-${entry.severity}`}>{entry.severity}</span>
                      {window ? (
                        <span className="chip">
                          {window.start_s.toFixed(1)}s – {window.end_s.toFixed(1)}s · {window.channel.replace("_", " ")}{" "}
                          {Math.round((window.low_value || 0) * 100)}
                        </span>
                      ) : null}
                      {entry.dimension_score != null ? (
                        <span className="chip">
                          {Math.round(entry.dimension_score)}/100
                          {entry.compared_score != null ? ` · leader ${Math.round(entry.compared_score)}` : ""}
                        </span>
                      ) : null}
                      {lift != null && lift > 0 ? <span className="chip lift">+{lift.toFixed(1)} pts</span> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      {report.next_steps?.length ? (
        <div className="panel-card" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <h3>Next steps</h3>
          </div>
          <ul>
            {report.next_steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer className="shared-report-foot no-print">
        <span>
          Powered by <a href="/">Stimli</a> · brain-aware creative pretesting.
          Built on the <strong>{provider}</strong> provider.
        </span>
        <a className="btn cream" href="/">
          Run your own comparison →
        </a>
      </footer>
    </div>
  );
}

function exportOutcomesCsv(outcomes: WorkspaceOutcome[]): void {
  if (!outcomes.length) return;
  const headers = [
    "created_at",
    "comparison_id",
    "comparison_objective",
    "comparison_status",
    "asset_id",
    "asset_name",
    "spend",
    "revenue",
    "profit",
    "impressions",
    "clicks",
    "conversions",
    "ctr",
    "cvr",
    "notes"
  ];
  const rows = outcomes.map((row) => {
    const ctr = row.impressions > 0 ? row.clicks / row.impressions : 0;
    const cvr = row.clicks > 0 ? row.conversions / row.clicks : 0;
    return [
      row.created_at,
      row.comparison_id,
      row.comparison_objective || "",
      row.comparison_status || "",
      row.asset_id,
      row.asset_name || "",
      row.spend,
      row.revenue,
      row.profit ?? "",
      row.impressions,
      row.clicks,
      row.conversions,
      ctr.toFixed(6),
      cvr.toFixed(6),
      row.notes || ""
    ];
  });
  const csv = [headers, ...rows]
    .map((cells) =>
      cells
        .map((cell) => {
          const value = cell == null ? "" : String(cell);
          // Quote and escape per RFC 4180 — only when needed, so the file
          // stays readable when opened in a text editor.
          if (/[",\n\r]/.test(value)) {
            return `"${value.split('"').join('""')}"`;
          }
          return value;
        })
        .join(",")
    )
    .join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  link.download = `stimli-outcomes-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
