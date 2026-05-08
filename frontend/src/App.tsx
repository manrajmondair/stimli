import { Landing } from "./Landing";
import { AppShell, InvitePage, LegalPage, SharedReportPage } from "./AppShell";

export function App() {
  const path = window.location.pathname;

  if (path === "/legal") {
    return <LegalPage />;
  }
  const inviteMatch = path.match(/^\/invite\/([^/]+)$/);
  if (inviteMatch) {
    return <InvitePage token={inviteMatch[1]} />;
  }
  const shareMatch = path.match(/^\/share\/([^/]+)$/);
  if (shareMatch) {
    return <SharedReportPage token={shareMatch[1]} />;
  }
  if (path === "/app" || path.startsWith("/app/")) {
    return <AppShell />;
  }
  return <Landing />;
}
