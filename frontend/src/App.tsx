import { Landing } from "./Landing";
import { AppShell, InvitePage, LegalPage, SharedReportPage } from "./AppShell";
import { BrainBlob } from "./art";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "";

export function App() {
  const path = window.location.pathname;

  if (path === "/legal") {
    return <LegalPage />;
  }
  const inviteMatch = path.match(/^\/invite\/([^/]+)$/);
  if (inviteMatch) {
    return clerkPublishableKey ? <InvitePage token={inviteMatch[1]} /> : <AuthSetupNeeded />;
  }
  const shareMatch = path.match(/^\/share\/([^/]+)$/);
  if (shareMatch) {
    return <SharedReportPage token={shareMatch[1]} />;
  }
  if (path === "/app" || path.startsWith("/app/")) {
    return clerkPublishableKey ? <AppShell /> : <AuthSetupNeeded />;
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
