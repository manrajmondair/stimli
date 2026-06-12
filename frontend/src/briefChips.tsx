import { useState } from "react";

// Add/remove chip editor for brief term lists (required claims, forbidden
// terms). Deduplicates case-insensitively on add — duplicate terms would
// collide as React keys and a single remove click would filter both.
export function BriefTermChips({
  label,
  terms,
  onChange,
  addPlaceholder,
  accent = "var(--pistachio-ink)"
}: {
  label: string;
  terms: string[];
  onChange: (next: string[]) => void;
  addPlaceholder: string;
  accent?: string;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const term = draft.trim();
    if (!term) return;
    const exists = terms.some((existing) => existing.toLowerCase() === term.toLowerCase());
    if (!exists) onChange([...terms, term]);
    setDraft("");
  }

  return (
    <div className="field">
      <span>{label}</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {terms.map((term) => (
          <span key={term} className="pill" style={{ borderColor: accent }}>
            {term}
            <button
              type="button"
              onClick={() => onChange(terms.filter((existing) => existing !== term))}
              aria-label={`Remove ${label.toLowerCase().replace(/s$/, "")}: ${term}`}
              style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--ink-soft)", marginLeft: 4 }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={addPlaceholder}
          aria-label={`Add ${label.toLowerCase()}`}
          style={{ background: "transparent", border: 0, outline: "none", font: "inherit", color: "inherit", width: 110 }}
        />
      </div>
    </div>
  );
}
