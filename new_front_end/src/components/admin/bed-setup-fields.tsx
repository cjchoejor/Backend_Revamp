"use client";

/**
 * Bed-setup controls for the admin console (2026-09-19) — shared by Room types and Rooms so the
 * two pages describe one rule the same way:
 *  - the USUAL setup of a room type (Standard: Twin, Suite: King);
 *  - which setups a room CAN be made up in. An empty list means every setup — the hotel's
 *    default, since any room can take any bed setup unless narrowed here.
 * The vocabulary always comes from the API (`bedTypes`), never a list typed on the page.
 */

const WORD: Record<string, string> = { KING: "King", QUEEN: "Queen", TWIN: "Twin", SINGLE: "Single" };

export function bedSetupWord(t: string | null | undefined): string {
  if (!t) return "—";
  return WORD[t] ?? t.charAt(0) + t.slice(1).toLowerCase();
}

/** "Any setup" for an empty list, else "King, Twin". */
export function bedSetupListWords(list: readonly string[] | null | undefined): string {
  return list && list.length > 0 ? list.map(bedSetupWord).join(", ") : "Any setup";
}

/**
 * Tick the setups allowed. Ticking every one — or none — means "any setup", sent as an empty
 * list, so a setup added to the vocabulary later is allowed without anyone editing each type.
 */
export function AllowedBedSetups({
  vocabulary,
  value,
  onChange,
  emptyLabel = "Any setup",
}: {
  vocabulary: readonly string[];
  /** The stored list — empty means any setup. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  emptyLabel?: string;
}) {
  const all = value.length === 0;
  const ticked = (t: string) => all || value.includes(t);
  const toggle = (t: string) => {
    const current = all ? [...vocabulary] : [...value];
    const next = current.includes(t) ? current.filter((x) => x !== t) : [...current, t];
    const ordered = vocabulary.filter((v) => next.includes(v));
    // Every setup ticked (or none) is "any" — stored as the empty list.
    onChange(ordered.length === 0 || ordered.length === vocabulary.length ? [] : ordered);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {vocabulary.map((t) => (
        <label key={t} className="inline-flex items-center gap-1 text-xs">
          <input type="checkbox" checked={ticked(t)} onChange={() => toggle(t)} />
          {bedSetupWord(t)}
        </label>
      ))}
      <span className="text-[10px] text-muted-foreground">{all ? emptyLabel : `Only ${bedSetupListWords(value)}`}</span>
    </div>
  );
}

/** The usual setup — one of the allowed ones, or none stated. */
export function UsualBedSetup({
  vocabulary,
  allowed,
  value,
  onChange,
}: {
  vocabulary: readonly string[];
  /** The allowed list the usual setup must sit inside (empty = any). */
  allowed: readonly string[];
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const options = allowed.length > 0 ? allowed : vocabulary;
  return (
    <select className="admin-input" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">No usual setup</option>
      {options.map((t) => (
        <option key={t} value={t}>
          {bedSetupWord(t)}
        </option>
      ))}
      {/* Keep a stored value visible even if it has since been ticked off the allowed list. */}
      {value && !options.includes(value) && <option value={value}>{bedSetupWord(value)} (not allowed any more)</option>}
    </select>
  );
}
