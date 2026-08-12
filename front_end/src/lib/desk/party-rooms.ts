import type { RoomCompositionInput } from "@/lib/api/quotations";
import { optionSelectedRoomIds, type EntryDetail } from "@/types/api";

/**
 * Party ↔ room helpers shared by the S5 guest-detail table and the S5 room-assignment block
 * (2026-08-11). The S2 composition stores COUNTS per room, never which same-band person —
 * so "who sleeps where" is re-derived with the SAME deterministic algorithm the S2 guest
 * board uses to rebuild chips from counts (`deriveFromSeed` in room-compositions-board):
 * band pools in party order, rooms in sealed order, adults → 6–10s → under-6s per room's
 * counts. Exact when the board did the placing; same-band guests are interchangeable.
 */

export type PartyBand = "ADULT" | "C6TO10" | "UNDER6";

/** The operative quotation's per-room compositions — newest live quote that carries any
 *  (ACCEPTED wins, else SENT/DRAFT, else newest of the rest). Null when none. */
export function operativeRoomCompositions(entry: EntryDetail): RoomCompositionInput[] | null {
  const quotes = (entry.quotations ?? [])
    .filter((q) => {
      const comps = (q.commercialTerms as { roomCompositions?: unknown[] } | null | undefined)?.roomCompositions;
      return Array.isArray(comps) && comps.length > 0;
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const operative =
    quotes.find((q) => q.state === "ACCEPTED") ?? quotes.find((q) => q.state === "SENT" || q.state === "DRAFT") ?? quotes[0];
  if (!operative) return null;
  return ((operative.commercialTerms as { roomCompositions?: unknown[] }).roomCompositions ?? []) as RoomCompositionInput[];
}

/** Default display label per party slot — GENERIC band labels only ("Adult 1"), never the
 *  profile's name: the booking's guest profile is the CONTACT PERSON, not necessarily anyone
 *  sleeping in the rooms (operator ruling 2026-08-11). Typed names from the guest-detail
 *  table overlay these where recorded. */
export function partySlotLabels(entry: EntryDetail): Map<string, string> {
  const m = new Map<string, string>();
  const adults = Math.max(0, entry.adultCount ?? 0);
  const childAges = entry.childAges ?? [];
  if (adults > 0 || childAges.length > 0) {
    for (let i = 0; i < adults; i++) m.set(`A${i}`, `Adult ${i + 1}`);
    childAges.forEach((age, i) => m.set(`K${i}`, `Child ${i + 1} · ${age}y`));
  } else {
    const n = Math.max(1, entry.guestCount ?? 1);
    for (let i = 0; i < n; i++) m.set(`A${i}`, `Guest ${i + 1}`);
  }
  return m;
}

/** slot key → roomId, per the deterministic seating described above. Empty map when the
 *  booking has no composition to derive from. */
export function seatPartyByComposition(entry: EntryDetail, youngMax = 5, childMax = 10): Map<string, string> {
  const out = new Map<string, string>();
  const comps = operativeRoomCompositions(entry);
  if (!comps) return out;
  const pool: Record<PartyBand, string[]> = { ADULT: [], C6TO10: [], UNDER6: [] };
  for (let i = 0; i < Math.max(0, entry.adultCount ?? 0); i++) pool.ADULT.push(`A${i}`);
  (entry.childAges ?? []).forEach((age, i) => {
    pool[age <= youngMax ? "UNDER6" : age <= childMax ? "C6TO10" : "ADULT"].push(`K${i}`);
  });
  const sealedOrder = optionSelectedRoomIds(
    (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected)?.optionSelected,
  );
  const order = sealedOrder.length > 0 ? sealedOrder : comps.map((c) => c.roomId).filter((id): id is string => !!id);
  for (const id of order) {
    const c = comps.find((x) => x.roomId === id);
    if (!c) continue;
    const take = (band: PartyBand, n: number) => {
      for (let i = 0; i < n; i++) {
        const key = pool[band].shift();
        if (!key) return;
        out.set(key, id);
      }
    };
    take("ADULT", c.adultCount ?? 0);
    take("C6TO10", c.cnb6To10Count ?? 0);
    take("UNDER6", c.cnbUnder6Count ?? 0);
  }
  return out;
}

/** Compact meal-plan sentence for one room's composition — "2 × CP · 1 × AP", "EP (room
 *  only)" when no plan, with a varies-by-night flag when per-date overrides exist. */
export function mealPlanSummary(c: RoomCompositionInput): string {
  const parts: string[] = [];
  if (c.mealPlanCpCount) parts.push(`${c.mealPlanCpCount} × CP (breakfast)`);
  if (c.mealPlanMaplCount) parts.push(`${c.mealPlanMaplCount} × MAP +lunch`);
  if (c.mealPlanMapdCount) parts.push(`${c.mealPlanMapdCount} × MAP +dinner`);
  if (c.mealPlanApCount) parts.push(`${c.mealPlanApCount} × AP (all meals)`);
  if (c.mealPlanOthersCount) parts.push(`${c.mealPlanOthersCount} × à-la-carte`);
  const base = parts.length > 0 ? parts.join(" · ") : "EP (room only)";
  return (c.nightMealOverrides?.length ?? 0) > 0 ? `${base} · varies by night` : base;
}
