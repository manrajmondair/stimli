import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";

// TeamView calls Clerk's useUser(); mock the module so it renders without a
// ClerkProvider (the suite deliberately runs without a real Clerk key).
vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: true, user: { id: "u1", fullName: "Me", primaryEmailAddress: { emailAddress: "me@x.com" } } }),
  useClerk: () => ({ openSignIn: vi.fn(), signOut: vi.fn() }),
  UserButton: () => null
}));

import { TeamView } from "../AppShell";

const reloadMock = vi.fn();

describe("TeamView team switcher", () => {
  beforeEach(() => {
    window.localStorage.clear();
    reloadMock.mockReset();
    // jsdom's location.reload isn't implemented; replace it so the switch handler can call it.
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadMock },
      writable: true
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        if (u.includes("/teams/members")) return json([]);
        if (u.includes("/teams/invites")) return json([]);
        if (u.includes("/audit")) return json([]);
        return json([]);
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const multiTeamSession = {
    authenticated: true as const,
    user: { id: "u1", name: "Me", email: "me@x.com" },
    team: { id: "team_b", name: "Team B", created_at: new Date().toISOString() },
    role: "owner" as const,
    permissions: ["workspace:write", "members:manage"],
    teams: [
      { id: "team_a", name: "Personal Team", created_at: new Date().toISOString() },
      { id: "team_b", name: "Team B", created_at: new Date().toISOString() }
    ]
  };

  it("shows a team switcher when the user belongs to more than one team", () => {
    render(<TeamView session={multiTeamSession as never} onUpdate={vi.fn()} />);
    const switcher = screen.getByLabelText(/active team/i) as HTMLSelectElement;
    expect(switcher.value).toBe("team_b");
    expect(screen.getByRole("option", { name: "Personal Team" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Team B" })).toBeInTheDocument();
  });

  it("persists the chosen team and reloads on switch", () => {
    render(<TeamView session={multiTeamSession as never} onUpdate={vi.fn()} />);
    const switcher = screen.getByLabelText(/active team/i);
    fireEvent.change(switcher, { target: { value: "team_a" } });
    expect(window.localStorage.getItem("stimli.team_workspace")).toBe("team_a");
    expect(reloadMock).toHaveBeenCalled();
  });

  it("renders a static team name (no switcher) for a single-team user", () => {
    const single = { ...multiTeamSession, teams: [multiTeamSession.teams[1]] };
    render(<TeamView session={single as never} onUpdate={vi.fn()} />);
    expect(screen.queryByLabelText(/active team/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Team B/).length).toBeGreaterThan(0);
  });

  it("requires an invite email before creating a link", async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/teams/members")) return json([]);
      if (u.includes("/teams/invites")) return json([]);
      if (u.includes("/audit")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeamView session={multiTeamSession as never} onUpdate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /create invite link/i }));

    expect((await screen.findAllByText(/invite email is required/i)).length).toBeGreaterThan(0);
    const inviteCreates = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes("/teams/invites") && (init?.method || "GET").toUpperCase() === "POST"
    );
    expect(inviteCreates).toHaveLength(0);
  });

  it("hides member-management controls from read-only team roles", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/audit")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const readOnlySession = {
      ...multiTeamSession,
      role: "viewer" as const,
      permissions: ["workspace:read"]
    };

    render(<TeamView session={readOnlySession as never} onUpdate={vi.fn()} />);

    expect(screen.getByText(/team administration is limited/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create invite link/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /role/i })).not.toBeInTheDocument();

    await waitFor(() => {
      const protectedTeamReads = fetchMock.mock.calls.filter(([url]) => {
        const path = String(url);
        return path.includes("/teams/members") || path.includes("/teams/invites");
      });
      expect(protectedTeamReads).toHaveLength(0);
    });
  });

  it("preserves the current member list when a refresh fails", async () => {
    let memberLoads = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.includes("/teams/members")) {
        memberLoads += 1;
        if (memberLoads > 1) return json({ detail: "Team temporarily unavailable." }, 500);
        return json([
          {
            user_id: "u2",
            name: "Ada Analyst",
            email: "ada@example.com",
            role: "analyst",
            created_at: new Date().toISOString()
          }
        ]);
      }
      if (u.includes("/teams/invites")) return json([]);
      if (u.includes("/audit")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeamView session={multiTeamSession as never} onUpdate={vi.fn()} />);
    expect(await screen.findByText("Ada Analyst")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    expect(await screen.findByText(/team temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByText("Ada Analyst")).toBeInTheDocument();
  });

  it("does not confirm member removal when Enter is pressed on the cancel button", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/teams/members") && method === "DELETE") return new Response("", { status: 204 });
      if (u.includes("/teams/members")) {
        return json([
          {
            user_id: "u2",
            name: "Ada Analyst",
            email: "ada@example.com",
            role: "analyst",
            created_at: new Date().toISOString()
          }
        ]);
      }
      if (u.includes("/teams/invites")) return json([]);
      if (u.includes("/audit")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeamView session={multiTeamSession as never} onUpdate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /remove/i }));
    const dialog = await screen.findByRole("alertdialog", { name: /remove this member/i });
    const cancel = within(dialog).getByRole("button", { name: /cancel/i });
    const confirm = within(dialog).getByRole("button", { name: /remove member/i });

    await waitFor(() => expect(cancel).toHaveFocus());

    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab", code: "Tab" });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(cancel, { key: "Enter", code: "Enter" });

    const deleteCalls = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).includes("/teams/members/u2") && (init?.method || "GET").toUpperCase() === "DELETE"
    );
    expect(deleteCalls).toHaveLength(0);
    expect(dialog).toBeInTheDocument();
  });

  it("only dispatches one member removal when confirm is clicked twice", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/teams/members") && method === "DELETE") return json({ removed: "u2" });
      if (u.includes("/teams/members")) {
        return json([
          {
            user_id: "u2",
            name: "Ada Analyst",
            email: "ada@example.com",
            role: "analyst",
            created_at: new Date().toISOString()
          }
        ]);
      }
      if (u.includes("/teams/invites")) return json([]);
      if (u.includes("/audit")) return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeamView session={multiTeamSession as never} onUpdate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /remove/i }));
    const dialog = await screen.findByRole("alertdialog", { name: /remove this member/i });
    const confirm = within(dialog).getByRole("button", { name: /remove member/i });

    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter(([url, init]) =>
        String(url).includes("/teams/members/u2") && (init?.method || "GET").toUpperCase() === "DELETE"
      );
      expect(deleteCalls).toHaveLength(1);
    });
  });
});
