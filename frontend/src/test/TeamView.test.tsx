import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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
});
