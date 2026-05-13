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

  it("renders the LegalPage when the path is /legal", () => {
    setPath("/legal");
    render(<App />);
    expect(screen.getByRole("heading", { name: /Trust & license/i })).toBeInTheDocument();
  });

  it("falls back to the Landing page for unknown routes", () => {
    setPath("/some/unknown/path");
    render(<App />);
    expect(screen.getAllByRole("link", { name: /Run a comparison/i }).length).toBeGreaterThan(0);
  });

  it("renders the SharedReportPage shell when path is /share/<token>", () => {
    setPath("/share/abc-token");
    render(<App />);
    // While the fetch resolves, the loading message is visible.
    expect(screen.getByText(/Loading report…/i)).toBeInTheDocument();
  });
});
