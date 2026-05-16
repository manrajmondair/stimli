import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../App";

function setPath(path: string) {
  window.history.replaceState(null, "", path);
}

describe("App router", () => {
  beforeEach(() => {
    // jsdom's fetch is undefined; stub a permissive one so AppShell's boot() resolves.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ authenticated: false, user: null, team: null, teams: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the Landing page at the root", () => {
    setPath("/");
    render(<App />);
    expect(screen.getAllByText(/Know which ad/i).length).toBeGreaterThan(0);
  });

  it("renders the LegalPage when the path is /legal", async () => {
    // /legal is lazy-loaded behind Suspense, so the test has to await the
    // chunk import; the synchronous render only shows the Suspense fallback.
    setPath("/legal");
    render(<App />);
    const heading = await screen.findByRole("heading", { name: /Trust & license/i });
    expect(heading).toBeInTheDocument();
  });

  it("falls back to the Landing page for unknown routes", () => {
    setPath("/some/unknown/path");
    render(<App />);
    expect(screen.getAllByRole("link", { name: /Run a comparison/i }).length).toBeGreaterThan(0);
  });

  it("renders the SharedReportPage shell when path is /share/<token>", async () => {
    setPath("/share/abc-token");
    render(<App />);
    // SharedReportPage is also lazy; the Suspense fallback shows briefly then
    // SharedReportPage takes over with its own "Loading report…" copy.
    const loading = await screen.findByText(/Loading report…/i);
    expect(loading).toBeInTheDocument();
  });
});
