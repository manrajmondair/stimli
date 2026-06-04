import { afterEach, describe, expect, it, vi } from "vitest";
import { activeTeamId, createTextAsset, extractErrorMessage, listProjects, setActiveTeam } from "../api";

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
