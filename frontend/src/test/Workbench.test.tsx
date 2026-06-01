import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Workbench } from "../Workbench";
import type { Comparison } from "../types";

// Builds a minimal-but-valid completed comparison so the Recent decisions panel
// has something to render and filter.
function makeComparison(id: string, objective: string, winnerName: string): Comparison {
  const scores = {
    overall: 80,
    hook: 80,
    clarity: 80,
    cta: 80,
    brand_cue: 80,
    pacing: 80,
    offer_strength: 80,
    audience_fit: 80,
    neural_attention: 80,
    memory: 80,
    cognitive_load: 40
  };
  const timeline = [
    { second: 0, attention: 0.7, memory: 0.6, cognitive_load: 0.4, note: "" },
    { second: 3, attention: 0.8, memory: 0.7, cognitive_load: 0.45, note: "" }
  ];
  return {
    id,
    objective,
    status: "complete",
    created_at: new Date().toISOString(),
    brief: {},
    variants: [
      { asset: { id: `${id}_a`, type: "script", name: winnerName }, analysis: { asset_id: `${id}_a`, provider: "web-heuristic-brain", status: "complete", scores, timeline, feature_vector: {}, summary: "" }, rank: 1, delta_from_best: 0 },
      { asset: { id: `${id}_b`, type: "script", name: "Runner up" }, analysis: { asset_id: `${id}_b`, provider: "web-heuristic-brain", status: "complete", scores: { ...scores, overall: 70 }, timeline, feature_vector: {}, summary: "" }, rank: 2, delta_from_best: 10 }
    ],
    recommendation: { winner_asset_id: `${id}_a`, verdict: "ship", confidence: 0.8, headline: `Ship ${winnerName}`, reasons: ["because"] },
    suggestions: []
  } as unknown as Comparison;
}

function stubFetch(comparisons: Comparison[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/comparisons")) return json(comparisons);
      if (u.includes("/assets")) return json([]);
      if (u.includes("/brand-profiles")) return json([]);
      return json([]);
    })
  );
}

describe("Workbench", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the empty-state demo onboarding when there are no assets or decisions", async () => {
    stubFetch([]);
    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);
    // The toolbar's "Demo set" affordance is always present.
    expect((await screen.findAllByText(/demo set/i)).length).toBeGreaterThan(0);
  });

  it("shows a search box and filters the decision history once there are several", async () => {
    const comparisons = [
      makeComparison("cmp_1", "spring hero test", "Pain-led hook"),
      makeComparison("cmp_2", "summer test", "Generic story"),
      makeComparison("cmp_3", "fall test", "Bundle offer"),
      makeComparison("cmp_4", "winter test", "Proof angle"),
      makeComparison("cmp_5", "q1 test", "Speed claim"),
      makeComparison("cmp_6", "q2 test", "Founder voice"),
      makeComparison("cmp_7", "q3 test", "Unboxing")
    ];
    stubFetch(comparisons);
    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);

    // Wait for the history to load (a known winner headline appears).
    await screen.findByText(/Ship Pain-led hook\./i);
    // With > 6 decisions, the search box renders.
    const search = screen.getByLabelText(/search past decisions/i);
    // Filter to the one whose winner is "Bundle offer".
    fireEvent.change(search, { target: { value: "Bundle" } });
    expect(screen.getByText(/Ship Bundle offer\./i)).toBeInTheDocument();
    expect(screen.queryByText(/Ship Pain-led hook\./i)).not.toBeInTheDocument();
  });

  it("renders a delete control on each decision row", async () => {
    stubFetch([makeComparison("cmp_x", "only test", "Only winner")]);
    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);
    await screen.findByText(/Ship Only winner\./i);
    expect(screen.getByLabelText(/delete decision: ship only winner/i)).toBeInTheDocument();
  });

  it("runs the core flow: load the demo set, then compare to a recommendation", async () => {
    const demoAssets = [
      { id: "asset_d1", type: "script", name: "Demo A", extracted_text: "Stop weak hooks. Try the kit." },
      { id: "asset_d2", type: "script", name: "Demo B", extracted_text: "A modern holistic ecosystem." }
    ];
    const result = makeComparison("cmp_new", "demo run", "Demo A");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method || "GET").toUpperCase();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (u.includes("/demo/seed") && method === "POST") return json(demoAssets);
        if (u.includes("/comparisons") && method === "POST") return json(result);
        if (u.includes("/comparisons")) return json([]);
        if (u.includes("/assets")) return json([]);
        if (u.includes("/brand-profiles")) return json([]);
        return json([]);
      })
    );
    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);

    // Load the demo set (toolbar affordance), which seeds + auto-selects two.
    const demoButtons = await screen.findAllByRole("button", { name: /demo set/i });
    fireEvent.click(demoButtons[0]);
    expect((await screen.findAllByText(/Demo A/)).length).toBeGreaterThan(0);

    // Compare -> the stubbed complete comparison renders its recommendation.
    const compare = screen.getByRole("button", { name: /^Compare/i });
    fireEvent.click(compare);
    expect(await screen.findByText(/Ship Demo A/i)).toBeInTheDocument();
  });
});
