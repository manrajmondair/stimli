import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeTeamId,
  cancelComparison,
  createChallenger,
  createOutcome,
  createShareLink,
  createTextAsset,
  deleteAsset,
  deleteBrandProfile,
  deleteComparison,
  extractErrorMessage,
  getComparison,
  getReport,
  getReportMarkdown,
  listProjects,
  removeTeamMember,
  revokeTeamInvite,
  StimliApiError,
  setActiveTeam
} from "../api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("extractErrorMessage", () => {
  it("returns the trimmed raw string for plain text errors", () => {
    expect(extractErrorMessage("  something went wrong  ")).toBe("something went wrong");
  });

  it("returns an empty string for empty input", () => {
    expect(extractErrorMessage("")).toBe("");
  });

  it("extracts `detail` from a Pages-style error payload", () => {
    const raw = JSON.stringify({ detail: "Sign in before using this workspace control." });
    expect(extractErrorMessage(raw)).toBe("Sign in before using this workspace control.");
  });

  it("extracts `msg` from a nested FastAPI pydantic validation payload", () => {
    const raw = JSON.stringify({
      detail: [
        { type: "too_short", loc: ["body", "asset_ids"], msg: "List should have at least 2 items after validation, not 1" }
      ]
    });
    expect(extractErrorMessage(raw)).toBe("List should have at least 2 items after validation, not 1");
  });

  it("extracts `error` when neither detail nor message is present", () => {
    expect(extractErrorMessage(JSON.stringify({ error: "Boom." }))).toBe("Boom.");
  });

  it("falls back to the trimmed raw string when JSON has no recognizable error field", () => {
    const raw = JSON.stringify({ unrelated: "field" });
    expect(extractErrorMessage(raw)).toBe(raw);
  });
});

describe("workspace storage fallback", () => {
  it("keeps request workspace headers stable when localStorage is unavailable", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    await listProjects();
    await listProjects();

    const firstHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(firstHeaders["X-Stimli-Workspace"]).toMatch(/^ws_/);
    expect(secondHeaders["X-Stimli-Workspace"]).toBe(firstHeaders["X-Stimli-Workspace"]);

    setActiveTeam("team_storage_fallback");
    expect(activeTeamId()).toBe("team_storage_fallback");
    await listProjects();

    const anonymousTeamHeaders = fetchMock.mock.calls[2][1]?.headers as Record<string, string>;
    expect(anonymousTeamHeaders["X-Stimli-Workspace"]).toBe(firstHeaders["X-Stimli-Workspace"]);

    vi.stubGlobal("Clerk", { session: { getToken: vi.fn(async () => "test-token") } });
    await listProjects();

    const signedInTeamHeaders = fetchMock.mock.calls[3][1]?.headers as Record<string, string>;
    expect(signedInTeamHeaders["X-Stimli-Workspace"]).toBe("team_storage_fallback");
    expect(signedInTeamHeaders.Authorization).toBe("Bearer test-token");
  });

  it("does not send a cached team workspace unless a Clerk token is available", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    setActiveTeam("team_cached");
    await listProjects();

    const anonymousHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(anonymousHeaders["X-Stimli-Workspace"]).toMatch(/^ws_/);
    expect(anonymousHeaders["X-Stimli-Workspace"]).not.toBe("team_cached");
    expect(anonymousHeaders.Authorization).toBeUndefined();

    vi.stubGlobal("Clerk", { session: { getToken: vi.fn(async () => "test-token") } });
    await listProjects();

    const signedInHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(signedInHeaders["X-Stimli-Workspace"]).toBe("team_cached");
    expect(signedInHeaders.Authorization).toBe("Bearer test-token");
  });
});

describe("parseResponse", () => {
  it("wraps invalid success JSON in a structured API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } }))
    );

    await expect(listProjects()).rejects.toMatchObject({
      name: "StimliApiError",
      message: "Response was not valid JSON.",
      status: 200,
      code: null,
      details: null
    } satisfies Partial<StimliApiError>);
  });

  it("keeps structured errors for delete-style responses", async () => {
    const body = {
      detail: "This item is still in use.",
      code: "resource_busy",
      details: { resource: "asset" }
    };
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(body), { status: 409, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const actions = [
      () => deleteAsset("asset_1"),
      () => deleteComparison("cmp_1"),
      () => revokeTeamInvite("invite_1"),
      () => removeTeamMember("user_1"),
      () => deleteBrandProfile("brand_1")
    ];

    for (const action of actions) {
      await expect(action()).rejects.toMatchObject({
        name: "StimliApiError",
        message: body.detail,
        status: 409,
        code: body.code,
        details: body.details
      } satisfies Partial<StimliApiError>);
    }
    expect(fetchMock).toHaveBeenCalledTimes(actions.length);
  });

  it("appends the server's request id to opaque 5xx messages", async () => {
    // The server stamps 5xx bodies with a correlation id that maps to its
    // logged stack trace — the toast a user screenshots must carry it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ detail: "Request failed", request_id: "ray-abc123" }), {
          status: 500,
          headers: { "Content-Type": "application/json", "X-Request-Id": "ray-abc123" }
        });
      })
    );

    await expect(listProjects()).rejects.toMatchObject({
      name: "StimliApiError",
      message: "Request failed (ref: ray-abc123)",
      status: 500,
      requestId: "ray-abc123"
    } satisfies Partial<StimliApiError>);
  });

  it("leaves 4xx messages unchanged (no request-id suffix)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ detail: "Project name is required." }), {
          status: 400,
          headers: { "Content-Type": "application/json", "X-Request-Id": "ray-def456" }
        });
      })
    );

    await expect(listProjects()).rejects.toMatchObject({
      name: "StimliApiError",
      message: "Project name is required.",
      status: 400
    } satisfies Partial<StimliApiError>);
  });

  it("keeps structured errors for markdown response failures", async () => {
    const details = { kind: "comparison", limit: 10, used: 10 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ detail: "Upgrade required.", code: "quota_exceeded", details }), {
          status: 402,
          headers: { "Content-Type": "application/json" }
        });
      })
    );
    const upgradeListener = vi.fn();
    window.addEventListener("stimli:upgrade-required", upgradeListener);

    try {
      await expect(getReportMarkdown("cmp_1")).rejects.toMatchObject({
        name: "StimliApiError",
        message: "Upgrade required.",
        status: 402,
        code: "quota_exceeded",
        details
      } satisfies Partial<StimliApiError>);
      expect(upgradeListener).toHaveBeenCalledTimes(1);
      expect((upgradeListener.mock.calls[0][0] as CustomEvent).detail).toEqual({ code: "quota_exceeded", details });
    } finally {
      window.removeEventListener("stimli:upgrade-required", upgradeListener);
    }
  });
});

describe("createTextAsset", () => {
  it("submits zero duration instead of dropping it", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ asset: { id: "asset_1", type: "video", name: "Zero", extracted_text: "", metadata: {} } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createTextAsset({ assetType: "video", name: "Zero", text: "", durationSeconds: 0 });

    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get("duration_seconds")).toBe("0");
  });
});

describe("comparison path params", () => {
  it("encodes comparison ids for all nested comparison and report routes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/markdown")) {
        return new Response("# report", { status: 200, headers: { "Content-Type": "text/markdown" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const comparisonId = "cmp/with space";
    const encoded = encodeURIComponent(comparisonId);

    await getComparison(comparisonId);
    await cancelComparison(comparisonId);
    await getReport(comparisonId);
    await getReportMarkdown(comparisonId);
    await createShareLink(comparisonId);
    await createOutcome(comparisonId, {
      asset_id: "asset_1",
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      notes: ""
    });
    await createChallenger(comparisonId, { focus: "hook" });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `/api/comparisons/${encoded}`,
      `/api/comparisons/${encoded}/cancel`,
      `/api/reports/${encoded}`,
      `/api/reports/${encoded}/markdown`,
      `/api/reports/${encoded}/share`,
      `/api/comparisons/${encoded}/outcomes`,
      `/api/comparisons/${encoded}/challengers`
    ]);
  });
});
