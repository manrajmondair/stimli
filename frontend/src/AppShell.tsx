import { useEffect, useState } from "react";
import {
  acceptInvite,
  createBrandProfile,
  createTeamInvite,
  getInvite,
  getLearningSummary,
  getSession,
  getSharedReport,
  listAuditEvents,
  listBrandProfiles,
  listLibraryAssets,
  listTeamMembers,
  loginWithPasskey,
  logout,
  registerWithPasskey,
  switchTeam
} from "./api";
import type {
  AuditEvent,
  AuthSession,
  BrandProfile,
  CreativeBrief,
  LearningSummary,
  LibraryAsset,
  Report,
  TeamInvite,
  TeamMember
} from "./types";
import { BrainBlob } from "./art";
import { Workbench } from "./Workbench";

type View = "workbench" | "library" | "brands" | "outcomes" | "team";

const NAV_ITEMS: Array<{ id: View; label: string; color: string }> = [
  { id: "workbench", label: "Workbench", color: "var(--tomato)" },
  { id: "library", label: "Library", color: "var(--pistachio)" },
  { id: "brands", label: "Brands", color: "var(--butter)" },
  { id: "outcomes", label: "Outcomes", color: "var(--plum)" },
  { id: "team", label: "Team", color: "var(--ink)" }
];

export function AppShell() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [view, setView] = useState<View>("workbench");
  const [authOpen, setAuthOpen] = useState(false);
  const [bootError] = useState<string | null>(null);

  useEffect(() => {
    void boot();
  }, []);

  async function boot() {
    try {
      const next = await getSession();
      setSession(next);
    } catch {
      // Some deployments (e.g. the local FastAPI research backend) do not expose passkey
      // auth endpoints. Treat that as unauthenticated rather than a hard failure so the
      // workbench can still seed and run comparisons.
      setSession({ authenticated: false, user: null, team: null, teams: [] });
    }
  }

  async function handleSignOut() {
    try {
      await logout();
      const next = await getSession();
      setSession(next);
    } catch (err) {
      console.warn(err);
    }
  }

  async function refreshSession() {
    try {
      const next = await getSession();
      setSession(next);
    } catch (err) {
      console.warn(err);
    }
  }

  return (
    <div className="wb-root paper-bg">
      <Sidebar
        active={view}
        onChange={setView}
        session={session}
        onSignIn={() => setAuthOpen(true)}
        onSignOut={handleSignOut}
        onSwitchTeam={async (teamId) => {
          await switchTeam(teamId);
          await refreshSession();
        }}
      />

      <main className="wb-main">
        {bootError ? <div className="banner error">{bootError}</div> : null}
        {view === "workbench" ? (
          <Workbench
            onRequireAuth={() => setAuthOpen(true)}
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

      {authOpen ? (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onAuthenticated={async (next) => {
            setSession(next);
            setAuthOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Sidebar({
  active,
  onChange,
  session,
  onSignIn,
  onSignOut,
  onSwitchTeam
}: {
  active: View;
  onChange: (view: View) => void;
  session: AuthSession | null;
  onSignIn: () => void;
  onSignOut: () => void;
  onSwitchTeam: (teamId: string) => void;
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

      {session?.authenticated && session.user ? (
        <div className="side-tip" style={{ alignItems: "stretch", textAlign: "left" }}>
          <strong style={{ fontFamily: "var(--display)", fontSize: 18, lineHeight: 1.05 }}>{session.user.name}</strong>
          <span style={{ fontSize: 11, color: "var(--ink-soft)", fontFamily: "var(--mono)" }}>
            {session.user.email}
          </span>
          {session.teams.length > 1 ? (
            <select
              value={session.team?.id ?? ""}
              onChange={(e) => onSwitchTeam(e.target.value)}
              style={{
                marginTop: 6,
                background: "var(--paper-warm)",
                border: "1.5px solid var(--ink)",
                borderRadius: 999,
                padding: "4px 10px",
                font: "inherit",
                fontSize: 12
              }}
            >
              {session.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          ) : null}
          <button className="btn cream small" onClick={onSignOut} style={{ marginTop: 8 }}>
            Sign out
          </button>
        </div>
      ) : (
        <div className="side-tip">
          <BrainBlob size={56} color="var(--butter)" eyes mouth />
          <p>Sign in with a passkey to save variants and share decisions.</p>
          <button className="btn primary small" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      )}
    </aside>
  );
}

function AuthModal({ onClose, onAuthenticated }: { onClose: () => void; onAuthenticated: (next: AuthSession) => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [teamName, setTeamName] = useState("My team");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const next = mode === "register"
        ? await registerWithPasskey({ email: email.trim(), name: name.trim() || email.trim(), teamName: teamName.trim() || "My team" })
        : await loginWithPasskey(email.trim());
      onAuthenticated(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not authenticate.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
        <button className="auth-close" onClick={onClose}>
          ×
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <BrainBlob size={48} color="var(--tomato)" eyes mouth />
          <h2>Sign in to Stimli</h2>
        </div>
        <p className="lead">
          Passkey accounts work on most modern browsers. No passwords, no setup. Use one passkey across all your
          devices that share an iCloud, Google, or 1Password account.
        </p>
        <div className="auth-tabs">
          <button className={`chip ${mode === "register" ? "active" : ""}`} onClick={() => setMode("register")}>
            New account
          </button>
          <button className={`chip ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")}>
            Existing passkey
          </button>
        </div>

        <label className="field">
          <span>Email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brand.com" type="email" />
        </label>

        {mode === "register" ? (
          <>
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </label>
            <label className="field">
              <span>Team name</span>
              <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="My team" />
            </label>
          </>
        ) : null}

        {error ? <div className="auth-error">{error}</div> : null}

        <button className="btn primary wide" onClick={submit} disabled={busy || !email}>
          {busy ? "Talking to your device…" : mode === "register" ? "Create account" : "Sign in"}
        </button>

        <p className="hint" style={{ textAlign: "center" }}>
          Your passkey never leaves your device. Stimli stores creative variants and decisions; nothing else.
        </p>
      </div>
    </div>
  );
}

function LibraryView() {
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
              {items.length} assets
            </span>
          </span>
        </div>
      </header>
      {error ? <div className="banner error">{error}</div> : null}
      {loading ? (
        <div className="banner">Loading…</div>
      ) : items.length === 0 ? (
        <div className="panel-card empty" style={{ paddingTop: 60, paddingBottom: 60 }}>
          <BrainBlob size={120} color="var(--pistachio)" eyes mouth />
          <h4>No saved assets yet.</h4>
          <p>Variants you upload from the workbench will collect here with extracted text and source metadata.</p>
        </div>
      ) : (
        <div className="list-grid">
          {items.map((asset, idx) => (
            <article
              key={asset.id}
              className="list-card"
              style={{ borderLeft: `6px solid ${["var(--tomato)", "var(--pistachio)", "var(--butter)", "var(--plum)"][idx % 4]}` }}
            >
              <span className="meta">
                {asset.type.replace("_", " ")} · {new Date(asset.created_at).toLocaleDateString()}
              </span>
              <h4>{asset.name}</h4>
              <p>
                {(asset.extracted_text || "").slice(0, 200)}
                {asset.extracted_text && asset.extracted_text.length > 200 ? "…" : ""}
              </p>
              <div className="row">
                <span className="kicker">{asset.library.extraction_status}</span>
                <span className="kicker">{asset.library.text_length} chars</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function BrandsView() {
  const [profiles, setProfiles] = useState<BrandProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    brand_name: "",
    audience: "",
    product_category: "",
    primary_offer: "",
    voice: "specific before abstract, proof before promise"
  });

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

  async function save() {
    if (!form.name.trim() || !form.brand_name.trim()) {
      setError("Add a profile name and brand.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const profile = await createBrandProfile({
        name: form.name.trim(),
        brief: {
          brand_name: form.brand_name.trim(),
          audience: form.audience.trim(),
          product_category: form.product_category.trim(),
          primary_offer: form.primary_offer.trim(),
          required_claims: [],
          forbidden_terms: []
        } satisfies CreativeBrief,
        voice_rules: form.voice.split(",").map((part) => part.trim()).filter(Boolean),
        compliance_notes: []
      });
      setProfiles((current) => [profile, ...current]);
      setForm({ name: "", brand_name: "", audience: "", product_category: "", primary_offer: "", voice: form.voice });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save profile.");
    } finally {
      setBusy(false);
    }
  }

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
              {profiles.length} profiles
            </span>
          </span>
        </div>
      </header>
      {error ? <div className="banner error">{error}</div> : null}
      <div className="wb-grid" style={{ gridTemplateColumns: "360px 1fr" }}>
        <section className="panel-card">
          <div className="panel-head">
            <h3>New brand profile</h3>
            <span className="kicker">re-usable brief</span>
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
              <span>Voice rules</span>
              <textarea
                rows={3}
                value={form.voice}
                onChange={(e) => setForm({ ...form, voice: e.target.value })}
              />
            </label>
            <button className="btn primary wide" onClick={save} disabled={busy}>
              Save profile
            </button>
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
              {profiles.map((profile, idx) => (
                <article
                  key={profile.id}
                  className="list-card"
                  style={{ borderTop: `6px solid ${["var(--tomato)", "var(--pistachio)", "var(--butter)", "var(--plum)"][idx % 4]}` }}
                >
                  <span className="meta">{profile.brief.product_category}</span>
                  <h4>{profile.name}</h4>
                  <p>
                    {profile.brief.brand_name} · {profile.brief.audience}
                  </p>
                  <p>
                    Offer: <strong>{profile.brief.primary_offer}</strong>
                  </p>
                  {profile.voice_rules.length ? (
                    <div className="row">
                      {profile.voice_rules.slice(0, 3).map((rule) => (
                        <span key={rule} className="claim-pill">
                          {rule}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
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
      ) : !summary ? null : (
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
  const [invite, setInvite] = useState<TeamInvite | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getInvite(token), getSession()])
      .then(([nextInvite, nextSession]) => {
        setInvite(nextInvite);
        setSession(nextSession);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load invite."));
  }, [token]);

  async function authenticate() {
    if (!invite) return;
    const email = window.prompt("Email for the new account", invite.email || "") || "";
    if (!email) return;
    setBusy(true);
    try {
      await registerWithPasskey({ email, name: email.split("@")[0], teamName: invite.team_name });
      const next = await getSession();
      setSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not register.");
    } finally {
      setBusy(false);
    }
  }

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
              <button className="btn primary" onClick={authenticate} disabled={busy}>
                Create account & join
              </button>
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
