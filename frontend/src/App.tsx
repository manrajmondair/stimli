import { Component, Suspense, lazy, useEffect } from "react";
import type { ReactNode } from "react";
import { Landing } from "./Landing";
import { BrainBlob } from "./art";

// Code-split the non-landing surfaces. The Landing page is the dominant
// entry point and used to pull in AppShell + Workbench + every secondary
// view even though it doesn't render them. Lazy chunks keep the marketing
// page's first paint cheap.
const AppShell = lazy(() => import("./AppShell").then((m) => ({ default: m.AppShell })));
const LegalPage = lazy(() => import("./AppShell").then((m) => ({ default: m.LegalPage })));
const InvitePage = lazy(() => import("./AppShell").then((m) => ({ default: m.InvitePage })));
const SharedReportPage = lazy(() => import("./AppShell").then((m) => ({ default: m.SharedReportPage })));

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "";

function RouteFallback() {
  return (
    <div className="paper-bg" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center" }}>
        <BrainBlob size={96} color="var(--tomato)" eyes mouth />
        <p style={{ marginTop: 12, fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink-soft)" }}>
          Loading the workbench…
        </p>
      </div>
    </div>
  );
}

// Catches lazy-chunk load failures (deploy skew, flaky network, offline) so a
// failed dynamic import surfaces a recovery screen instead of an unhandled
// error / blank page. A new deploy fingerprints the chunk filenames, so a
// client holding a stale index can 404 on the old chunk — one reload pulls the
// fresh manifest. We auto-reload once (guarded against a loop) and otherwise
// offer a manual retry.
const RELOAD_GUARD_KEY = "stimli.chunk_reloaded";

class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    let reloadedOnce = false;
    try {
      reloadedOnce = window.sessionStorage.getItem(RELOAD_GUARD_KEY) === "1";
      if (!reloadedOnce) window.sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
    } catch {
      /* sessionStorage can throw in private mode — fall back to manual retry */
    }
    if (!reloadedOnce) {
      window.location.reload();
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="paper-bg" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: 420, padding: 24 }}>
          <BrainBlob size={84} color="var(--tomato)" eyes />
          <p style={{ marginTop: 16, fontFamily: "var(--mono)", fontSize: 13, color: "var(--ink-soft)" }}>
            We couldn't finish loading this view. A new version may have just shipped.
          </p>
          <button
            className="btn cream"
            style={{ marginTop: 16 }}
            onClick={() => {
              try {
                window.sessionStorage.removeItem(RELOAD_GUARD_KEY);
              } catch {
                /* ignore */
              }
              window.location.reload();
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

// Lazy routes get both: the error boundary (load failure) wrapping Suspense
// (load pending). A successful render clears the one-shot reload guard so a
// future chunk failure can auto-reload again.
function LazyRoute({ children }: { children: ReactNode }) {
  useEffect(() => {
    try {
      window.sessionStorage.removeItem(RELOAD_GUARD_KEY);
    } catch {
      /* ignore */
    }
  }, []);
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<RouteFallback />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
}

export function App() {
  const path = window.location.pathname;

  useEffect(() => {
    // Lightweight per-route document title. Real SSR would set the OG tags
    // server-side too, but for now a dynamic <title> at least keeps browser
    // tabs and history entries legible.
    let title = "Stimli — pretest before you spend";
    if (path === "/legal") title = "Trust & license · Stimli";
    else if (path.startsWith("/invite/")) title = "Team invite · Stimli";
    else if (path.startsWith("/share/")) title = "Shared decision report · Stimli";
    else if (path === "/app" || path.startsWith("/app/")) title = "Workbench · Stimli";
    document.title = title;
  }, [path]);

  if (path === "/legal") {
    return (
      <LazyRoute>
        <LegalPage />
      </LazyRoute>
    );
  }
  const inviteMatch = path.match(/^\/invite\/([^/]+)$/);
  if (inviteMatch) {
    if (!clerkPublishableKey) return <AuthSetupNeeded />;
    return (
      <LazyRoute>
        <InvitePage token={inviteMatch[1]} />
      </LazyRoute>
    );
  }
  const shareMatch = path.match(/^\/share\/([^/]+)$/);
  if (shareMatch) {
    return (
      <LazyRoute>
        <SharedReportPage token={shareMatch[1]} />
      </LazyRoute>
    );
  }
  if (path === "/app" || path.startsWith("/app/")) {
    if (!clerkPublishableKey) return <AuthSetupNeeded />;
    return (
      <LazyRoute>
        <AppShell />
      </LazyRoute>
    );
  }
  return <Landing />;
}

function AuthSetupNeeded() {
  return (
    <div className="legal-page paper-bg" style={{ maxWidth: 640 }}>
      <a className="brand" href="/" style={{ marginBottom: 32 }}>
        <BrainBlob size={42} color="var(--tomato)" />
        <span className="brand-word">stimli</span>
      </a>
      <h1>Almost ready.</h1>
      <p>
        Stimli's authentication layer is being configured. The workbench will be live as soon as the deploy
        finishes wiring Clerk — usually a few seconds. Refresh in a moment, or head back to the landing page
        to see the rest of the product.
      </p>
      <p style={{ marginTop: 32 }}>
        <a className="btn cream" href="/">
          ← Back home
        </a>
      </p>
    </div>
  );
}
