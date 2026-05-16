import { Suspense, lazy } from "react";
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

export function App() {
  const path = window.location.pathname;

  if (path === "/legal") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <LegalPage />
      </Suspense>
    );
  }
  const inviteMatch = path.match(/^\/invite\/([^/]+)$/);
  if (inviteMatch) {
    if (!clerkPublishableKey) return <AuthSetupNeeded />;
    return (
      <Suspense fallback={<RouteFallback />}>
        <InvitePage token={inviteMatch[1]} />
      </Suspense>
    );
  }
  const shareMatch = path.match(/^\/share\/([^/]+)$/);
  if (shareMatch) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <SharedReportPage token={shareMatch[1]} />
      </Suspense>
    );
  }
  if (path === "/app" || path.startsWith("/app/")) {
    if (!clerkPublishableKey) return <AuthSetupNeeded />;
    return (
      <Suspense fallback={<RouteFallback />}>
        <AppShell />
      </Suspense>
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
