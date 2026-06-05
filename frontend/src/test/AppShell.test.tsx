import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const clerkMock = vi.hoisted(() => ({
  openSignIn: vi.fn(),
  openUserProfile: vi.fn(),
  signOut: vi.fn(),
  state: {
    isLoaded: true,
    isSignedIn: true,
    user: {
      id: "user_1",
      fullName: "Owner User",
      firstName: "Owner",
      primaryEmailAddress: { emailAddress: "owner@example.com" }
    }
  }
}));

vi.mock("@clerk/clerk-react", () => ({
  useUser: () => clerkMock.state,
  useClerk: () => ({
    openSignIn: clerkMock.openSignIn,
    openUserProfile: clerkMock.openUserProfile,
    signOut: clerkMock.signOut
  }),
  UserButton: () => null
}));

import { AppShell, InvitePage, SharedReportPage } from "../AppShell";

function setPath(path: string) {
  window.history.replaceState(null, "", path);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const session = {
  authenticated: true,
  user: { id: "user_1", name: "Owner User", email: "owner@example.com" },
  team: { id: "team_1", name: "Owner Team", created_at: new Date().toISOString() },
  role: "owner",
  permissions: ["workspace:write", "members:manage", "billing:manage"],
  teams: [{ id: "team_1", name: "Owner Team", created_at: new Date().toISOString() }]
};

const usage = {
  plan: { id: "research", name: "Research", asset_limit_per_hour: 40, comparison_limit_per_hour: 12, commercial: false, configured: true },
  subscription: null,
  billing_configured: false,
  commercial_use_enabled: false,
  limits: { asset: 40, comparison: 12 },
  monthly_limits: { asset: 200, comparison: 25 },
  period: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z", source: "calendar_month" },
  usage: { window_ms: 3600000, comparison: 0, asset: 0 },
  monthly_usage: { comparison: 1, asset: 2 }
};

const billingStatus = {
  current_plan: usage.plan,
  subscription: null,
  billing_configured: false,
  commercial_use_enabled: false,
  license: { provider: "fixture", tribe_commercial_license: false, mode: "research-only" },
  plans: [
    usage.plan,
    {
      id: "growth",
      name: "Growth",
      asset_limit_per_hour: 300,
      comparison_limit_per_hour: 100,
      asset_limit_per_month: 4000,
      comparison_limit_per_month: 500,
      commercial: true,
      configured: false,
      price_cents_monthly: 14900,
      features: []
    }
  ]
};

const assets = [
  {
    id: "asset_a",
    type: "script",
    name: "Persisted A",
    extracted_text: "Stop weak hooks before launch.",
    metadata: {},
    created_at: "2026-06-01T00:00:00.000Z",
    library: { text_length: 31, extraction_status: "provided", has_private_blob: false, source: "text" }
  },
  {
    id: "asset_b",
    type: "script",
    name: "Persisted B",
    extracted_text: "Try a clearer offer today.",
    metadata: {},
    created_at: "2026-06-02T00:00:00.000Z",
    library: { text_length: 26, extraction_status: "provided", has_private_blob: false, source: "text" }
  }
];

function stubAppFetch() {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method || "GET").toUpperCase();
    if (u.includes("/auth/session")) return json(session);
    if (u.includes("/billing/usage")) return json(usage);
    if (u.includes("/billing/status")) return json(billingStatus);
    if (u.includes("/library/assets")) return json({ assets, total: assets.length });
    if (u.includes("/assets/asset_a") && method === "DELETE") return json({ deleted: "asset_a" });
    if (u.includes("/assets/asset_b") && method === "DELETE") return json({ detail: "Could not delete" }, 500);
    if (u.includes("/teams/members")) return json([]);
    if (u.includes("/teams/invites")) return json([]);
    if (u.includes("/audit")) return json([]);
    if (u.includes("/comparisons")) return json([]);
    if (u.includes("/assets")) return json([]);
    if (u.includes("/brand-profiles")) return json([]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AppShell routing and shell flows", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clerkMock.openSignIn.mockReset();
    clerkMock.openUserProfile.mockReset();
    clerkMock.signOut.mockReset();
    clerkMock.state.isLoaded = true;
    clerkMock.state.isSignedIn = true;
    stubAppFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders /app/billing directly from the path", async () => {
    setPath("/app/billing");
    render(<AppShell />);
    expect(await screen.findByRole("heading", { name: /plans & usage/i })).toBeInTheDocument();
  });

  it("switches teams in-place and refreshes session-scoped data", async () => {
    setPath("/app/team");
    vi.stubGlobal("Clerk", { session: { getToken: vi.fn(async () => "test-token") } });
    const teamA = { id: "team_a", name: "Personal Team", created_at: new Date().toISOString() };
    const teamB = { id: "team_b", name: "Team B", created_at: new Date().toISOString() };
    const currentSession = {
      ...session,
      team: teamB,
      role: "owner",
      permissions: ["workspace:write", "members:manage", "billing:manage", "audit:read"],
      teams: [teamA, teamB]
    };
    const switchedSession = { ...currentSession, team: teamA };
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const headers = (init?.headers || {}) as Record<string, string>;
      const workspace = headers["X-Stimli-Workspace"];
      if (u.includes("/auth/session")) return json(workspace === "team_a" ? switchedSession : currentSession);
      if (u.includes("/billing/usage")) return json(usage);
      if (u.includes("/teams/members")) return json([]);
      if (u.includes("/teams/invites")) return json([]);
      if (u.includes("/audit")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppShell />);
    const switcher = (await screen.findByLabelText(/active team/i)) as HTMLSelectElement;
    expect(switcher.value).toBe("team_b");

    fireEvent.change(switcher, { target: { value: "team_a" } });

    await waitFor(() => expect(window.localStorage.getItem("stimli.team_workspace")).toBe("team_a"));
    await waitFor(() => expect((screen.getByLabelText(/active team/i) as HTMLSelectElement).value).toBe("team_a"));
    expect(fetchMock.mock.calls.some(([url, init]) => {
      const headers = (init?.headers || {}) as Record<string, string>;
      return String(url).includes("/auth/session") && headers["X-Stimli-Workspace"] === "team_a";
    })).toBe(true);
  });

  it("does not load workspace views until the signed-in team session is ready", async () => {
    setPath("/app/library");
    const sessionResolver: { current?: (response: Response) => void } = {};
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/auth/session")) {
        return new Promise<Response>((resolve) => {
          sessionResolver.current = resolve;
        });
      }
      if (u.includes("/billing/usage")) return json(usage);
      if (u.includes("/library/assets")) return json({ assets, total: assets.length });
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppShell />);

    expect(await screen.findByText(/Loading workspace/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/library/assets"))).toBe(false);
    if (!sessionResolver.current) throw new Error("Session request did not start.");
    sessionResolver.current(json(session));

    expect(await screen.findByText("Persisted A")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/library/assets"))).toBe(true);
  });

  it("renders billing usage when older APIs omit monthly fields", async () => {
    setPath("/app/billing");
    const oldUsage = {
      ...usage,
      monthly_limits: undefined,
      monthly_usage: undefined
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/auth/session")) return json(session);
        if (u.includes("/billing/usage")) return json(oldUsage);
        if (u.includes("/billing/status")) return json(billingStatus);
        return json([]);
      })
    );

    render(<AppShell />);

    expect((await screen.findAllByText(/Comparisons this month/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Assets this month/i).length).toBeGreaterThan(0);
  });

  it("does not expose billing mutations without billing permission", async () => {
    setPath("/app/billing");
    const limitedSession = {
      ...session,
      role: "admin",
      permissions: ["workspace:write", "members:manage"]
    };
    const subscription = {
      plan: "growth",
      status: "active",
      current_period_start: "2026-06-01T00:00:00.000Z",
      current_period_end: "2026-07-01T00:00:00.000Z",
      cancel_at_period_end: false,
      trial_end: null
    };
    const activeUsage = {
      ...usage,
      subscription,
      billing_configured: true,
      commercial_use_enabled: true
    };
    const activeBillingStatus = {
      ...billingStatus,
      billing_configured: true,
      commercial_use_enabled: true,
      subscription,
      plans: billingStatus.plans.map((plan) => (plan.id === "growth" ? { ...plan, configured: true } : plan))
    };
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (u.includes("/auth/session")) return json(limitedSession);
      if (u.includes("/billing/usage")) return json(activeUsage);
      if (u.includes("/billing/status")) return json(activeBillingStatus);
      if (u.includes("/billing/checkout") && method === "POST") return json({ url: "https://checkout.test" });
      if (u.includes("/billing/portal") && method === "POST") return json({ url: "https://portal.test" });
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AppShell />);

    expect(await screen.findByRole("heading", { name: /plans & usage/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage subscription/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /billing access required/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /billing access required/i }));

    const mutationCalls = fetchMock.mock.calls.filter(([url, init]) => {
      const path = String(url);
      const method = (init?.method || "GET").toUpperCase();
      return method === "POST" && (path.includes("/billing/checkout") || path.includes("/billing/portal"));
    });
    expect(mutationCalls).toHaveLength(0);
  });

  it("updates the URL when a sidebar view changes", async () => {
    setPath("/app/billing");
    render(<AppShell />);
    await screen.findByRole("heading", { name: /plans & usage/i });

    fireEvent.click(screen.getByRole("button", { name: /library/i }));

    expect(window.location.pathname).toBe("/app/library");
    expect(await screen.findByRole("heading", { name: /library/i })).toBeInTheDocument();
  });

  it("routes quota events to Billing with the quota message", async () => {
    setPath("/app");
    render(<AppShell />);

    window.dispatchEvent(
      new CustomEvent("stimli:upgrade-required", {
        detail: { details: { kind: "comparison", plan: "research", limit: 1, used: 1 } }
      })
    );

    expect(await screen.findByText(/comparison limit on the research plan \(1\/1\)/i)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/app/billing");
  });

  it("clears cached team workspace when Clerk reports a signed-out user", async () => {
    clerkMock.state.isSignedIn = false;
    window.localStorage.setItem("stimli.team_workspace", "team_cached");
    setPath("/app");

    render(<AppShell />);

    await waitFor(() => expect(window.localStorage.getItem("stimli.team_workspace")).toBeNull());
  });

  it("keeps failed bulk deletes visible and selected", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setPath("/app/library");
    render(<AppShell />);
    await screen.findByText("Persisted A");
    await screen.findByText("Persisted B");

    fireEvent.click(screen.getByLabelText("Select Persisted A"));
    fireEvent.click(screen.getByLabelText("Select Persisted B"));
    fireEvent.click(screen.getByRole("button", { name: /delete 2/i }));
    const dialog = await screen.findByRole("alertdialog", { name: /delete 2 assets/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /delete 2/i }));

    expect(await screen.findByText(/Deleted 1, 1 could not be removed/i)).toBeInTheDocument();
    expect(screen.queryByText("Persisted A")).not.toBeInTheDocument();
    expect(screen.getByText("Persisted B")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /bulk actions/i })).toHaveTextContent(/1\s*asset selected/i);
    warnSpy.mockRestore();
  });

  it("clears library selections that are hidden by search", async () => {
    setPath("/app/library");
    render(<AppShell />);
    await screen.findByText("Persisted A");
    await screen.findByText("Persisted B");

    fireEvent.click(screen.getByLabelText("Select Persisted A"));
    fireEvent.click(screen.getByLabelText("Select Persisted B"));
    expect(screen.getByRole("region", { name: /bulk actions/i })).toHaveTextContent(/2\s*assets selected/i);

    fireEvent.change(screen.getByLabelText(/search library/i), { target: { value: "Persisted A" } });

    await waitFor(() => {
      expect(screen.getByRole("region", { name: /bulk actions/i })).toHaveTextContent(/1\s*asset selected/i);
    });
    expect(screen.getByRole("button", { name: /delete 1/i })).toBeInTheDocument();
  });

  it("uses user-facing copy for private stored library files", async () => {
    setPath("/app/library");
    const privateAsset = {
      ...assets[0],
      library: { ...assets[0].library, has_private_blob: true }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/auth/session")) return json(session);
        if (u.includes("/billing/usage")) return json(usage);
        if (u.includes("/library/assets")) return json({ assets: [privateAsset], total: 1 });
        return json([]);
      })
    );

    render(<AppShell />);

    expect(await screen.findByText(/private file/i)).toBeInTheDocument();
    expect(screen.queryByText(/in r2/i)).not.toBeInTheDocument();
  });

  it("prunes deleted selections and expanded rows on library refresh", async () => {
    setPath("/app/library");
    let libraryCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/auth/session")) return json(session);
        if (u.includes("/billing/usage")) return json(usage);
        if (u.includes("/library/assets")) {
          libraryCalls += 1;
          return json({ assets: libraryCalls === 1 ? assets : [assets[1]], total: libraryCalls === 1 ? 2 : 1 });
        }
        return json([]);
      })
    );
    render(<AppShell />);
    await screen.findByText("Persisted A");

    fireEvent.click(screen.getByLabelText("Select Persisted A"));
    const assetCard = screen.getByText("Persisted A").closest("article");
    if (!assetCard) throw new Error("Persisted A card did not render.");
    fireEvent.click(within(assetCard).getByRole("button", { name: /View text/i }));
    expect(screen.getByRole("region", { name: /bulk actions/i })).toHaveTextContent(/1\s*asset selected/i);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(screen.queryByText("Persisted A")).not.toBeInTheDocument());
    expect(screen.queryByRole("region", { name: /bulk actions/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Stop weak hooks before launch/i)).not.toBeInTheDocument();
  });

  it("stores default brand profiles under the active team key", async () => {
    setPath("/app/brands");
    const profile = {
      id: "brand_1",
      name: "Lumina Q3",
      brief: {
        brand_name: "Lumina",
        audience: "busy women",
        product_category: "skincare",
        primary_offer: "starter kit",
        required_claims: [],
        forbidden_terms: []
      },
      voice_rules: [],
      compliance_notes: [],
      created_at: "2026-06-01T00:00:00.000Z"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/auth/session")) return json(session);
        if (u.includes("/billing/usage")) return json(usage);
        if (u.includes("/brand-profiles")) return json([profile]);
        return json([]);
      })
    );

    render(<AppShell />);
    await screen.findByText("Lumina Q3");
    fireEvent.click(screen.getByRole("button", { name: /set as default/i }));

    expect(window.localStorage.getItem("stimli.default_brand_profile:team_1")).toBe("brand_1");
    expect(window.localStorage.getItem("stimli.default_brand_profile")).toBeNull();
  });

  it("sends logged-out invite users back to the invite page after sign-in", async () => {
    clerkMock.state.isSignedIn = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/invites/invite-token")) {
          return json({
            id: "invite_1",
            team_id: "team_1",
            team_name: "Owner Team",
            email: "owner@example.com",
            role: "analyst",
            expires_at: "2026-07-01T00:00:00.000Z",
            accepted_at: null,
            created_at: "2026-06-01T00:00:00.000Z"
          });
        }
        return json({});
      })
    );

    render(<InvitePage token="invite-token" />);
    fireEvent.click(await screen.findByRole("button", { name: /sign in to accept/i }));

    expect(clerkMock.openSignIn).toHaveBeenCalledWith({ forceRedirectUrl: "/invite/invite-token" });
  });

  it("shows a checking state for signed-in invite users until the backend session loads", async () => {
    clerkMock.state.isSignedIn = true;
    const sessionResolver: { current?: (response: Response) => void } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/invites/invite-token")) {
          return json({
            id: "invite_1",
            team_id: "team_1",
            team_name: "Owner Team",
            email: "owner@example.com",
            role: "analyst",
            expires_at: "2026-07-01T00:00:00.000Z",
            accepted_at: null,
            created_at: "2026-06-01T00:00:00.000Z"
          });
        }
        if (u.includes("/auth/session")) {
          return new Promise<Response>((resolve) => {
            sessionResolver.current = resolve;
          });
        }
        return json({});
      })
    );

    render(<InvitePage token="invite-token" />);

    expect(await screen.findByRole("button", { name: /checking account/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /sign in to accept/i })).not.toBeInTheDocument();
    if (!sessionResolver.current) throw new Error("Session request did not start.");
    sessionResolver.current(json(session));
    expect(await screen.findByRole("button", { name: /accept invite as owner@example.com/i })).toBeInTheDocument();
  });

  it("shows a retry state when signed-in invite session lookup fails", async () => {
    clerkMock.state.isSignedIn = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/invites/invite-token")) {
          return json({
            id: "invite_1",
            team_id: "team_1",
            team_name: "Owner Team",
            email: "owner@example.com",
            role: "analyst",
            expires_at: "2026-07-01T00:00:00.000Z",
            accepted_at: null,
            created_at: "2026-06-01T00:00:00.000Z"
          });
        }
        if (u.includes("/auth/session")) {
          return json({ detail: "Session temporarily unavailable." }, 503);
        }
        return json({});
      })
    );

    render(<InvitePage token="invite-token" />);

    expect(await screen.findByText(/session temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry account check/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /checking account/i })).not.toBeInTheDocument();
  });

  it("blocks email-bound invites for the wrong signed-in account", async () => {
    clerkMock.state.isSignedIn = true;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (u.includes("/invites/invite-token") && method === "GET") {
        return json({
          id: "invite_1",
          team_id: "team_1",
          team_name: "Owner Team",
          email: "owner@example.com",
          role: "analyst",
          expires_at: "2026-07-01T00:00:00.000Z",
          accepted_at: null,
          created_at: "2026-06-01T00:00:00.000Z"
        });
      }
      if (u.includes("/auth/session")) {
        return json({ ...session, user: { ...session.user, email: "other@example.com" } });
      }
      if (u.includes("/invites/invite-token/accept") && method === "POST") {
        return json(session);
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<InvitePage token="invite-token" />);

    expect(await screen.findByText(/you are signed in as/i)).toBeInTheDocument();
    expect(screen.getByText(/other@example.com/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /accept invite/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /switch account/i }));
    expect(clerkMock.signOut).toHaveBeenCalledWith({ redirectUrl: "/invite/invite-token" });
    const acceptCalls = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes("/invites/invite-token/accept") && (init?.method || "GET").toUpperCase() === "POST"
    );
    expect(acceptCalls).toHaveLength(0);
  });

  it("maps shared report provider ids to user-facing labels", async () => {
    const report = {
      comparison_id: "cmp_shared",
      title: "Shared Report",
      executive_summary: "Ship the winner.",
      recommendation: {
        winner_asset_id: "asset_a",
        verdict: "ship",
        confidence: 0.82,
        headline: "Ship the built-in winner.",
        reasons: ["Strong hook."]
      },
      variants: [
        {
          asset: { id: "asset_a", type: "script", name: "Variant A", extracted_text: "A", metadata: {}, created_at: "2026-06-01T00:00:00.000Z" },
          analysis: {
            asset_id: "asset_a",
            provider: "web-heuristic-brain",
            status: "complete",
            scores: {
              overall: 82,
              hook: 82,
              clarity: 82,
              cta: 82,
              brand_cue: 82,
              pacing: 82,
              offer_strength: 82,
              audience_fit: 82,
              neural_attention: 82,
              memory: 82,
              cognitive_load: 32
            },
            timeline: [
              { second: 0, attention: 0.7, memory: 0.6, cognitive_load: 0.4, note: "" },
              { second: 3, attention: 0.8, memory: 0.7, cognitive_load: 0.45, note: "" }
            ],
            feature_vector: {},
            summary: ""
          },
          rank: 1,
          delta_from_best: 0
        }
      ],
      suggestions: [],
      next_steps: [],
      brief: {},
      learning_summary: null,
      compliance: null
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/share/share-token")) return json(report);
        return json({});
      })
    );

    render(<SharedReportPage token="share-token" />);

    expect(await screen.findByText(/per second · Stimli built-in/i)).toBeInTheDocument();
    expect(screen.getByText(/Built on the/i)).toHaveTextContent(/Stimli built-in/);
    expect(screen.queryByText(/web-heuristic-brain/i)).not.toBeInTheDocument();
  });

  it("shows an unavailable state for invalid invites instead of loading forever", async () => {
    clerkMock.state.isSignedIn = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/invites/revoked-token")) {
          return json({ detail: "Invite has expired or was revoked." }, 404);
        }
        return json({});
      })
    );

    render(<InvitePage token="revoked-token" />);

    expect(await screen.findByText(/invite has expired or was revoked/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /invite unavailable/i })).toBeInTheDocument();
    expect(screen.queryByText(/loading invite/i)).not.toBeInTheDocument();
  });
});
