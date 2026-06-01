import { describe, it, expect, vi } from "vitest";

// AppShell imports @clerk/clerk-react at module scope; mock it so importing the
// pure CSV builder doesn't require a Clerk provider.
vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
  useClerk: () => ({}),
  UserButton: () => null
}));

import { buildOutcomesCsv } from "../AppShell";
import type { WorkspaceOutcome } from "../types";

function outcome(over: Partial<WorkspaceOutcome>): WorkspaceOutcome {
  return {
    id: "o1",
    comparison_id: "cmp_1",
    asset_id: "asset_1",
    spend: 100,
    revenue: 250,
    impressions: 1000,
    clicks: 50,
    conversions: 5,
    notes: "",
    created_at: "2026-06-01T00:00:00.000Z",
    comparison_objective: "obj",
    comparison_status: "complete",
    asset_name: "Variant A",
    profit: 150,
    ...over
  } as WorkspaceOutcome;
}

describe("buildOutcomesCsv", () => {
  it("derives CTR/CVR and uses CRLF line endings", () => {
    const csv = buildOutcomesCsv([outcome({})]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("created_at,comparison_id")).toBe(true);
    // ctr = 50/1000 = 0.05, cvr = 5/50 = 0.1
    expect(lines[1]).toContain("0.050000");
    expect(lines[1]).toContain("0.100000");
  });

  it("guards CTR/CVR against division by zero", () => {
    const csv = buildOutcomesCsv([outcome({ impressions: 0, clicks: 0 })]);
    const cells = csv.split("\r\n")[1].split(",");
    // ctr and cvr columns (indexes 12 and 13) are 0, not NaN/Infinity.
    expect(cells[12]).toBe("0.000000");
    expect(cells[13]).toBe("0.000000");
  });

  it("RFC 4180-quotes fields with commas, quotes, and newlines", () => {
    const csv = buildOutcomesCsv([
      outcome({ notes: 'has "quotes", a comma, and\na newline', comparison_objective: "plain" })
    ]);
    const row = csv.split("\r\n")[1];
    // The notes cell must be wrapped in quotes with embedded quotes doubled.
    expect(row).toContain('"has ""quotes"", a comma, and\na newline"');
    // A plain field is not quoted.
    expect(row).toContain(",plain,");
  });
});
