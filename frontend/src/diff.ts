// Word-level diff between two creative texts, used by the result view to show
// what actually changed between a variant and the winner. Classic LCS over
// word tokens — deterministic, dependency-free, and fast at ad-copy lengths
// (a few hundred words per side).

export type DiffOp = { kind: "same" | "added" | "removed"; text: string };

function tokenize(text: string): string[] {
  return (text || "").trim().split(/\s+/).filter(Boolean);
}

// Guards against pathological inputs: at ad-copy scale (≤1200 tokens/side) the
// LCS table is at most ~1.4M cells, well within budget; beyond that we clamp
// rather than risk a quadratic blowup on a pasted novel.
const MAX_TOKENS = 1200;

export function wordDiff(fromText: string, toText: string): DiffOp[] {
  const from = tokenize(fromText).slice(0, MAX_TOKENS);
  const to = tokenize(toText).slice(0, MAX_TOKENS);
  if (!from.length && !to.length) return [];
  if (!from.length) return [{ kind: "added", text: to.join(" ") }];
  if (!to.length) return [{ kind: "removed", text: from.join(" ") }];

  // LCS length table (m+1 x n+1), then walk back to emit ops.
  const m = from.length;
  const n = to.length;
  const table: Uint16Array = new Uint16Array((m + 1) * (n + 1));
  const at = (i: number, j: number) => i * (n + 1) + j;
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        from[i] === to[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const ops: DiffOp[] = [];
  const push = (kind: DiffOp["kind"], word: string) => {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) {
      last.text += ` ${word}`;
    } else {
      ops.push({ kind, text: word });
    }
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (from[i] === to[j]) {
      push("same", from[i]);
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      push("removed", from[i]);
      i += 1;
    } else {
      push("added", to[j]);
      j += 1;
    }
  }
  while (i < m) {
    push("removed", from[i]);
    i += 1;
  }
  while (j < n) {
    push("added", to[j]);
    j += 1;
  }
  return ops;
}

// Summary counts for a diff, used for the disclosure label ("+12 / −8 words").
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    const count = op.text.split(/\s+/).filter(Boolean).length;
    if (op.kind === "added") added += count;
    if (op.kind === "removed") removed += count;
  }
  return { added, removed };
}
