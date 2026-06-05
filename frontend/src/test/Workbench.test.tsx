import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Workbench } from "../Workbench";
import type { Comparison } from "../types";

// Builds a minimal-but-valid completed comparison so the Recent decisions panel
// has something to render and filter.
function makeComparison(id: string, objective: string, winnerName: string, provider = "web-heuristic-brain"): Comparison {
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
      { asset: { id: `${id}_a`, type: "script", name: winnerName }, analysis: { asset_id: `${id}_a`, provider, status: "complete", scores, timeline, feature_vector: {}, summary: "" }, rank: 1, delta_from_best: 0 },
      { asset: { id: `${id}_b`, type: "script", name: "Runner up" }, analysis: { asset_id: `${id}_b`, provider, status: "complete", scores: { ...scores, overall: 70 }, timeline, feature_vector: {}, summary: "" }, rank: 2, delta_from_best: 10 }
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

  it("uses neutral provider copy before an engine has reported", async () => {
    stubFetch([]);
    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);

    expect(await screen.findByText(/Brain: Stimli/i)).toBeInTheDocument();
    expect(screen.queryByText(/Brain: TRIBE v2/i)).not.toBeInTheDocument();
  });

  it("renders keyboard-accessible controls for removing brief rules", async () => {
    stubFetch([]);
    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);

    const demoBriefButtons = await screen.findAllByRole("button", { name: /load demo brief/i });
    fireEvent.click(demoBriefButtons[0]);

    const removeClaim = screen.getByRole("button", { name: /remove required claim: 24-hr hydration/i });
    const removeTerm = screen.getByRole("button", { name: /remove forbidden term: miracle cure/i });
    fireEvent.click(removeClaim);
    fireEvent.click(removeTerm);

    expect(screen.queryByText("24-hr hydration")).not.toBeInTheDocument();
    expect(screen.queryByText("miracle cure")).not.toBeInTheDocument();
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

  it("cancels recent decision deletion without calling the API", async () => {
    const comparison = makeComparison("cmp_cancel_delete", "only test", "Only winner");
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/comparisons/cmp_cancel_delete") && method === "DELETE") return json({ deleted: comparison.id });
      if (u.includes("/comparisons")) return json([comparison]);
      if (u.includes("/assets")) return json([]);
      if (u.includes("/brand-profiles")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);
    await screen.findByText(/Ship Only winner\./i);
    fireEvent.click(screen.getByLabelText(/delete decision: ship only winner/i));
    const dialog = await screen.findByRole("alertdialog", { name: /delete this decision/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: /delete this decision/i })).not.toBeInTheDocument());
    const deleteCalls = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes("/comparisons/cmp_cancel_delete") && (init?.method || "GET").toUpperCase() === "DELETE"
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it("only dispatches one recent decision delete when confirm is clicked twice", async () => {
    const comparison = makeComparison("cmp_delete_once", "only test", "Only winner");
    const pendingDelete: { resolve?: () => void } = {};
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/comparisons/cmp_delete_once") && method === "DELETE") {
        return new Promise<Response>((resolve) => {
          pendingDelete.resolve = () => resolve(json({ deleted: comparison.id }));
        });
      }
      if (u.includes("/comparisons")) return json([comparison]);
      if (u.includes("/assets")) return json([]);
      if (u.includes("/brand-profiles")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);
    await screen.findByText(/Ship Only winner\./i);
    fireEvent.click(screen.getByLabelText(/delete decision: ship only winner/i));
    const dialog = await screen.findByRole("alertdialog", { name: /delete this decision/i });
    const confirm = within(dialog).getByRole("button", { name: /delete decision/i });

    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter(([url, init]) =>
        String(url).includes("/comparisons/cmp_delete_once") && (init?.method || "GET").toUpperCase() === "DELETE"
      );
      expect(deleteCalls).toHaveLength(1);
    });
    pendingDelete.resolve?.();
    expect(await screen.findByText(/decision deleted/i)).toBeInTheDocument();
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

  it("does not expose raw provider ids in the result view", async () => {
    const rawProvider = "private-provider-id";
    const demoAssets = [
      { id: "asset_d1", type: "script", name: "Demo A", extracted_text: "Stop weak hooks. Try the kit." },
      { id: "asset_d2", type: "script", name: "Demo B", extracted_text: "A modern holistic ecosystem." }
    ];
    const result = makeComparison("cmp_provider", "demo run", "Demo A", rawProvider);
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

    fireEvent.click((await screen.findAllByRole("button", { name: /demo set/i }))[0]);
    await screen.findAllByText(/Demo A/);
    fireEvent.click(screen.getByRole("button", { name: /^Compare/i }));

    expect(await screen.findByText(/Ship Demo A/i)).toBeInTheDocument();
    expect(screen.getByText("Stimli", { selector: ".kicker" })).toBeInTheDocument();
    expect(screen.queryByText(rawProvider)).not.toBeInTheDocument();
  });

  it("keeps a generated share link visible when clipboard copy fails", async () => {
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => { throw new Error("blocked"); }) },
      configurable: true
    });
    const demoAssets = [
      { id: "asset_d1", type: "script", name: "Demo A", extracted_text: "Stop weak hooks. Try the kit." },
      { id: "asset_d2", type: "script", name: "Demo B", extracted_text: "A modern holistic ecosystem." }
    ];
    const result = makeComparison("cmp_share", "demo run", "Demo A");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method || "GET").toUpperCase();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (u.includes("/reports/cmp_share/share") && method === "POST") {
          return json({
            token: "share_token",
            path: "/share/share_token",
            api_path: "/api/share/share_token",
            url: "https://stimli.test/share/share_token",
            expires_at: "2026-07-01T00:00:00.000Z"
          });
        }
        if (u.includes("/demo/seed") && method === "POST") return json(demoAssets);
        if (u.includes("/comparisons") && method === "POST") return json(result);
        if (u.includes("/comparisons")) return json([]);
        if (u.includes("/assets")) return json([]);
        if (u.includes("/brand-profiles")) return json([]);
        return json([]);
      })
    );

    try {
      render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);
      const demoButtons = await screen.findAllByRole("button", { name: /demo set/i });
      fireEvent.click(demoButtons[0]);
      expect((await screen.findAllByText(/Demo A/)).length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("button", { name: /^Compare/i }));
      await screen.findByText(/Ship Demo A/i);

      fireEvent.click(screen.getByRole("button", { name: /share/i }));

      const shareBanner = await screen.findByRole("status", { name: /share link/i });
      expect(within(shareBanner).getByText("https://stimli.test/share/share_token")).toBeInTheDocument();
      expect(within(shareBanner).getByRole("button", { name: /copy/i })).toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        configurable: true
      });
    }
  });

  it("does not submit malformed outcome metrics", async () => {
    const demoAssets = [
      { id: "asset_d1", type: "script", name: "Demo A", extracted_text: "Stop weak hooks. Try the kit." },
      { id: "asset_d2", type: "script", name: "Demo B", extracted_text: "A modern holistic ecosystem." }
    ];
    const result = makeComparison("cmp_invalid_outcome", "demo run", "Demo A");
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.includes("/demo/seed") && method === "POST") return json(demoAssets);
      if (u.includes("/comparisons") && method === "POST" && !u.includes("/outcomes")) return json(result);
      if (u.includes("/comparisons")) return json([]);
      if (u.includes("/assets")) return json([]);
      if (u.includes("/brand-profiles")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);

    fireEvent.click((await screen.findAllByRole("button", { name: /demo set/i }))[0]);
    await screen.findAllByText(/Demo A/);
    fireEvent.click(screen.getByRole("button", { name: /^Compare/i }));
    await screen.findByText(/Ship Demo A/i);

    fireEvent.click(screen.getByRole("button", { name: /log outcome/i }));
    fireEvent.change(screen.getByLabelText(/clicks/i), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: /save outcome/i }));

    expect(await screen.findByText(/Clicks must be a whole number/i)).toBeInTheDocument();
    const outcomePosts = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes("/outcomes") && (init?.method || "GET").toUpperCase() === "POST"
    );
    expect(outcomePosts).toHaveLength(0);
  });

  it("keeps an in-flight analysis visible when cancellation fails", async () => {
    const demoAssets = [
      { id: "asset_d1", type: "script", name: "Demo A", extracted_text: "Stop weak hooks. Try the kit." },
      { id: "asset_d2", type: "script", name: "Demo B", extracted_text: "A modern holistic ecosystem." }
    ];
    const processing = {
      ...makeComparison("cmp_cancel", "demo run", "Demo A"),
      status: "processing",
      jobs: [
        { asset_id: "asset_d1", status: "running" },
        { asset_id: "asset_d2", status: "queued" }
      ]
    } as unknown as Comparison;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.includes("/demo/seed") && method === "POST") return json(demoAssets);
      if (u.includes("/comparisons") && method === "POST" && u.includes("/cancel")) {
        return json({ detail: "Could not cancel analysis." }, 500);
      }
      if (u.includes("/comparisons") && method === "POST") return json(processing);
      if (u.includes("/comparisons/cmp_cancel")) return json(processing);
      if (u.includes("/comparisons")) return json([]);
      if (u.includes("/assets")) return json([]);
      if (u.includes("/brand-profiles")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);

    fireEvent.click((await screen.findAllByRole("button", { name: /demo set/i }))[0]);
    await screen.findAllByText(/Demo A/);
    fireEvent.click(screen.getByRole("button", { name: /^Compare/i }));
    expect(await screen.findByText(/Growing thought-trails/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    expect(await screen.findByText(/Could not cancel analysis/i)).toBeInTheDocument();
    expect(screen.getByText(/Growing thought-trails/i)).toBeInTheDocument();
    const cancelCalls = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes("/comparisons/cmp_cancel/cancel") && (init?.method || "GET").toUpperCase() === "POST"
    );
    expect(cancelCalls).toHaveLength(1);
  });

  it("calls onRequireAuth when an asset upload is rejected for auth", async () => {
    const onRequireAuth = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method || "GET").toUpperCase();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (u.includes("/assets") && method === "POST") return json({ detail: "Sign in before uploading." }, 401);
        if (u.includes("/comparisons")) return json([]);
        if (u.includes("/assets")) return json([]);
        if (u.includes("/brand-profiles")) return json([]);
        return json([]);
      })
    );
    render(<Workbench onRequireAuth={onRequireAuth} remoteProvider={null} briefDefaults={undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: /Add a variant/i }));
    fireEvent.change(screen.getByLabelText(/^Name$/i), { target: { value: "Auth variant" } });
    fireEvent.change(screen.getByLabelText(/Creative text/i), { target: { value: "Try the starter kit today." } });
    fireEvent.click(screen.getByRole("button", { name: /add to comparison/i }));

    await waitFor(() => expect(onRequireAuth).toHaveBeenCalledTimes(1));
  });

  it("lets users cancel while the initial comparison request is still in flight", async () => {
    const demoAssets = [
      { id: "asset_d1", type: "script", name: "Demo A", extracted_text: "Stop weak hooks. Try the kit." },
      { id: "asset_d2", type: "script", name: "Demo B", extracted_text: "A modern holistic ecosystem." }
    ];
    const result = makeComparison("cmp_late", "demo run", "Demo A");
    const compareResolver: { current?: (response: Response) => void } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = (init?.method || "GET").toUpperCase();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (u.includes("/demo/seed") && method === "POST") return json(demoAssets);
        if (u.includes("/comparisons") && method === "POST") {
          return new Promise<Response>((resolve) => {
            compareResolver.current = resolve;
          });
        }
        if (u.includes("/comparisons")) return json([]);
        if (u.includes("/assets")) return json([]);
        if (u.includes("/brand-profiles")) return json([]);
        return json([]);
      })
    );
    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);

    fireEvent.click((await screen.findAllByRole("button", { name: /demo set/i }))[0]);
    await screen.findAllByText(/Demo A/);
    fireEvent.click(screen.getByRole("button", { name: /^Compare/i }));
    expect(await screen.findByText(/Growing thought-trails/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(await screen.findByText(/Analysis cancelled/i)).toBeInTheDocument();
    expect(screen.queryByText(/Growing thought-trails/i)).not.toBeInTheDocument();

    if (!compareResolver.current) throw new Error("Comparison request did not start.");
    compareResolver.current(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await waitFor(() => expect(screen.queryByText(/Ship Demo A/i)).not.toBeInTheDocument());
  });

  it("shows indeterminate upload progress for file assets", async () => {
    const uploadResolver: { current?: (response: Response) => void } = {};
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.includes("/assets") && method === "POST") {
        return new Promise<Response>((resolve) => {
          uploadResolver.current = resolve;
        });
      }
      if (u.includes("/comparisons")) return json([]);
      if (u.includes("/assets")) return json([]);
      if (u.includes("/brand-profiles")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Workbench onRequireAuth={vi.fn()} remoteProvider={null} briefDefaults={undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: /\+ New variant/i }));
    fireEvent.click(screen.getByRole("button", { name: "Video" }));
    fireEvent.change(screen.getByLabelText(/^Name$/i), { target: { value: "Upload variant" } });
    fireEvent.change(screen.getByLabelText(/upload file/i), {
      target: { files: [new File(["clip"], "clip.mp4", { type: "video/mp4" })] }
    });
    fireEvent.click(screen.getByRole("button", { name: /add to comparison/i }));

    expect(await screen.findByText(/^Uploading…$/i)).toBeInTheDocument();
    expect(screen.queryByText(/Uploading…\s+\d+%/i)).not.toBeInTheDocument();

    if (!uploadResolver.current) throw new Error("Upload request did not start.");
    uploadResolver.current(
      new Response(JSON.stringify({ asset: { id: "asset_upload", type: "video", name: "Upload variant", extracted_text: "", metadata: {} } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await waitFor(() => expect(screen.queryByText(/^Uploading…$/i)).not.toBeInTheDocument());
  });
});
