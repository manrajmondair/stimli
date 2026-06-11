import { describe, expect, it } from "vitest";
import { DIFF_MAX_TOKENS, diffStats, diffTruncated, wordDiff, type DiffOp } from "../diff";

function render(ops: DiffOp[]): string {
  return ops
    .map((op) => (op.kind === "same" ? op.text : op.kind === "added" ? `[+${op.text}]` : `[-${op.text}]`))
    .join(" ");
}

describe("wordDiff", () => {
  it("returns a single same-run for identical text", () => {
    const ops = wordDiff("try the starter kit", "try the starter kit");
    expect(ops).toEqual([{ kind: "same", text: "try the starter kit" }]);
  });

  it("marks words only in the target as added and only in the source as removed", () => {
    const ops = wordDiff("stop wasting money on routines", "stop wasting budget on routines");
    expect(render(ops)).toBe("stop wasting [-money] [+budget] on routines");
  });

  it("handles wholly different texts", () => {
    const ops = wordDiff("alpha beta", "gamma delta");
    const stats = diffStats(ops);
    expect(stats).toEqual({ added: 2, removed: 2 });
    expect(ops.every((op) => op.kind !== "same")).toBe(true);
  });

  it("handles empty sides", () => {
    expect(wordDiff("", "")).toEqual([]);
    expect(wordDiff("", "new copy")).toEqual([{ kind: "added", text: "new copy" }]);
    expect(wordDiff("old copy", "")).toEqual([{ kind: "removed", text: "old copy" }]);
  });

  it("coalesces consecutive ops into runs", () => {
    const ops = wordDiff("a b c d", "a x y d");
    expect(ops).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b c" },
      { kind: "added", text: "x y" },
      { kind: "same", text: "d" }
    ]);
  });

  it("preserves order through interleaved edits (LCS, not bag-of-words)", () => {
    const ops = wordDiff("one two three four", "two three one four");
    // The common subsequence keeps relative order; "one" must move.
    const stats = diffStats(ops);
    expect(stats.added).toBe(stats.removed);
    expect(render(ops)).toContain("four");
  });

  it("counts multi-word runs correctly in diffStats", () => {
    const stats = diffStats([
      { kind: "added", text: "three new words" },
      { kind: "removed", text: "two old" },
      { kind: "same", text: "ignored words here" }
    ]);
    expect(stats).toEqual({ added: 3, removed: 2 });
  });

  it("reports truncation when either side exceeds the clamp", () => {
    const short = "a few words";
    const long = Array.from({ length: DIFF_MAX_TOKENS + 1 }, (_, i) => `w${i}`).join(" ");
    expect(diffTruncated(short, short)).toBe(false);
    expect(diffTruncated(long, short)).toBe(true);
    expect(diffTruncated(short, long)).toBe(true);
  });

  it("treats whitespace-only differences as identical", () => {
    const ops = wordDiff("buy  now\nplease", "buy now please");
    expect(diffStats(ops)).toEqual({ added: 0, removed: 0 });
  });

  it("stays fast and bounded on long inputs", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    const b = Array.from({ length: 3000 }, (_, i) => `w${i + 1}`).join(" ");
    const start = performance.now();
    const ops = wordDiff(a, b);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(ops.length).toBeGreaterThan(0);
  });
});
