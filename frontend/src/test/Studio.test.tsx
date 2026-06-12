import { StrictMode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { StudioView, writeStudioHandoff } from "../Studio";
import type { DraftPreview } from "../types";

function makePreview(overall: number, overrides: Partial<DraftPreview> = {}): DraftPreview {
  return {
    provider: "web-heuristic-brain",
    scores: {
      overall,
      hook: 70,
      clarity: 80,
      cta: 60,
      brand_cue: 55,
      pacing: 85,
      offer_strength: 62,
      audience_fit: 68,
      neural_attention: 64,
      memory: 58,
      cognitive_load: 48
    },
    timeline: [
      { second: 0, attention: 0.6, memory: 0.5, cognitive_load: 0.4, note: "" },
      { second: 3, attention: 0.7, memory: 0.6, cognitive_load: 0.45, note: "" }
    ],
    feature_vector: { word_count: 20 },
    summary: "stub",
    suggestions: [
      {
        asset_id: "preview",
        target: "Sharpen the CTA",
        severity: "medium",
        issue: "CTA is soft",
        suggested_edit: "Close with a verb-led action.",
        expected_effect: "",
        draft_revision: ""
      }
    ],
    signals: [
      { signal: "hook_word_open", label: "Hook word in the opener", active: true },
      { signal: "cta_close", label: "CTA verb near the close", active: false }
    ],
    compliance: {
      required_claims: [{ claim: "dermatologist tested", present: false }],
      forbidden_terms: [{ term: "miracle", present: false }],
      missing_required: ["dermatologist tested"],
      forbidden_hits: []
    },
    ship_threshold: 68,
    ...overrides
  } as DraftPreview;
}

function stubPreviewFetch(preview: DraftPreview) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/analyze/preview")) {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.include_ladder) {
        return json({
          ...preview,
          ladder: [
            { focus: "hook", text: "Stop settling. Try the kit today.", overall: 80, delta: 8 },
            { focus: "cta", text: "Original plus a close.", overall: 74, delta: 2 }
          ]
        });
      }
      return json(preview);
    }
    if (u.includes("/assets") && (init?.method || "GET") === "POST") {
      return json({ asset: { id: "asset_new", name: "Studio draft · saved", type: "script" } });
    }
    if (u.includes("/brand-profiles")) return json([]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("StudioView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("debounces typing into a single preview call and renders the scoreboard", async () => {
    const fetchMock = stubPreviewFetch(makePreview(72));
    render(<StudioView workspaceKey="ws_studio" />);

    const editor = screen.getByLabelText(/ad copy draft/i);
    fireEvent.change(editor, { target: { value: "Stop wasting" } });
    fireEvent.change(editor, { target: { value: "Stop wasting money today" } });

    // Inside the debounce window nothing fires yet.
    const previewCallsBefore = fetchMock.mock.calls.filter(([u]) => String(u).includes("/analyze/preview"));
    expect(previewCallsBefore).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const previewCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/analyze/preview"));
    expect(previewCalls).toHaveLength(1);

    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText(/ship-ready zone/i)).toBeInTheDocument();
    expect(screen.getByText(/hook word in the opener/i)).toBeInTheDocument();
    expect(screen.getByText(/dermatologist tested/i)).toBeInTheDocument();
    expect(screen.getByText(/sharpen the cta/i)).toBeInTheDocument();
  });

  it("prefills from a workbench handoff and shows the baseline delta", async () => {
    writeStudioHandoff({
      text: "Original variant copy here",
      baseline_overall: 70,
      baseline_label: "Variant A",
      brief: { brand_name: "Lumina" }
    });
    stubPreviewFetch(makePreview(74));
    render(<StudioView workspaceKey="ws_studio" />);

    expect(screen.getByLabelText(/ad copy draft/i)).toHaveValue("Original variant copy here");
    expect(screen.getByText(/baseline: Variant A/i)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/\+4 vs baseline/i)).toBeInTheDocument();
    // The handoff is consumed: it should not survive a remount.
    expect(window.sessionStorage.getItem("stimli.studio_draft")).toBeNull();
  });

  it("runs the optimize ladder and applies a rung to the editor", async () => {
    stubPreviewFetch(makePreview(72));
    render(<StudioView workspaceKey="ws_studio" />);

    const editor = screen.getByLabelText(/ad copy draft/i);
    fireEvent.change(editor, { target: { value: "A draft worth sparring with" } });
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /optimize/i }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/sparring partner/i)).toBeInTheDocument();
    expect(screen.getByText("+8")).toBeInTheDocument();

    const applyButtons = screen.getAllByRole("button", { name: /^apply$/i });
    fireEvent.click(applyButtons[0]);
    expect(screen.getByLabelText(/ad copy draft/i)).toHaveValue("Stop settling. Try the kit today.");
  });

  it("keeps the handoff under StrictMode's double-invoked initializers", async () => {
    // main.tsx wraps the app in StrictMode: in dev, useState initializers and
    // useMemo run twice, and a naive consume-on-read would hand the second
    // invocation nothing — losing the draft. The once-cache must survive it.
    writeStudioHandoff({ text: "StrictMode survivor", baseline_overall: 50, baseline_label: "Src" });
    stubPreviewFetch(makePreview(72));
    render(
      <StrictMode>
        <StudioView workspaceKey="ws_strict" />
      </StrictMode>
    );
    expect(screen.getByLabelText(/ad copy draft/i)).toHaveValue("StrictMode survivor");
  });

  it("rehydrates the working draft after an unmount (navigation away and back)", async () => {
    stubPreviewFetch(makePreview(72));
    const first = render(<StudioView workspaceKey="ws_persist" />);
    fireEvent.change(screen.getByLabelText(/ad copy draft/i), {
      target: { value: "Draft that must survive navigation" }
    });
    first.unmount();

    render(<StudioView workspaceKey="ws_persist" />);
    expect(screen.getByLabelText(/ad copy draft/i)).toHaveValue("Draft that must survive navigation");
  });

  it("sends lineage on save when the handoff carried a source, and shows the lift receipt", async () => {
    vi.useRealTimers();
    writeStudioHandoff({
      text: "Original copy to be revised",
      baseline_overall: 60,
      baseline_label: "Hook v1",
      source_asset_id: "asset_src1",
      brief: { brand_name: "Lumina" }
    });
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/analyze/preview")) return json(makePreview(72));
      if (u.includes("/assets") && (init?.method || "GET") === "POST") {
        return json({
          asset: {
            id: "asset_rev1",
            name: "Studio draft · saved",
            type: "script",
            extracted_text: "x",
            created_at: "now",
            metadata: { revised_from: "asset_src1", revision_baseline: 58, revision_overall: 66.2, revision_lift: 8.2 }
          }
        });
      }
      if (u.includes("/brand-profiles")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<StudioView workspaceKey="ws_lineage" />);

    fireEvent.click(screen.getByRole("button", { name: /save as variant/i }));

    // The receipt shows the SERVER-measured lift with the rematch CTA.
    await waitFor(() => {
      expect(screen.getByTestId("lift-receipt")).toBeInTheDocument();
    });
    expect(screen.getByText(/\+8\.2 measured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run the rematch/i })).toBeInTheDocument();

    // And the save request carried the lineage hint + brief for the server to verify.
    const assetPost = fetchMock.mock.calls.find(
      ([u, init]) => String(u).includes("/assets") && (init?.method || "GET") === "POST"
    );
    const form = assetPost?.[1]?.body as FormData;
    expect(form.get("revised_from")).toBe("asset_src1");
    expect(JSON.parse(String(form.get("brief"))).brand_name).toBe("Lumina");
  });

  it("does not send lineage when the draft has no source", async () => {
    vi.useRealTimers();
    const fetchMock = stubPreviewFetch(makePreview(72));
    render(<StudioView workspaceKey="ws_nolineage" />);
    fireEvent.change(screen.getByLabelText(/ad copy draft/i), { target: { value: "Fresh draft" } });
    fireEvent.click(screen.getByRole("button", { name: /save as variant/i }));
    await waitFor(() => {
      expect(screen.getByText(/Saved "Studio draft · saved"/i)).toBeInTheDocument();
    });
    const assetPost = fetchMock.mock.calls.find(
      ([u, init]) => String(u).includes("/assets") && (init?.method || "GET") === "POST"
    );
    const form = assetPost?.[1]?.body as FormData;
    expect(form.get("revised_from")).toBeNull();
  });

  it("saves the draft as a variant through the existing assets flow", async () => {
    // Real timers here: waitFor polls with its own timers, which deadlock when
    // faked; the save path doesn't depend on the debounce anyway.
    vi.useRealTimers();
    const fetchMock = stubPreviewFetch(makePreview(72));
    render(<StudioView workspaceKey="ws_studio" />);

    fireEvent.change(screen.getByLabelText(/ad copy draft/i), { target: { value: "Save me as a variant" } });
    fireEvent.click(screen.getByRole("button", { name: /save as variant/i }));

    await waitFor(() => {
      expect(screen.getByText(/Saved "Studio draft · saved"/i)).toBeInTheDocument();
    });
    const assetPosts = fetchMock.mock.calls.filter(
      ([u, init]) => String(u).includes("/assets") && (init?.method || "GET") === "POST"
    );
    expect(assetPosts).toHaveLength(1);
  });
});
