/**
 * The rows a quotation prints for one room — the room itself, then its extra beds and its meals
 * beneath it — as one shared reading (2026-10-27, operator: the booking file's Charges tab should
 * read "how the prices are shown in quotation, like how the meals and extra beds and all come
 * under one column, that way the user can just scroll down instead of scrolling horizontally").
 *
 * The quotation document, the desk's Charges tab (from the saved quotation) and the live
 * negotiation preview all build their rows here, so the three cannot describe one room two ways.
 * Moved out of `buildQuotationDocRender` unchanged; the document's rows are what they were.
 */

export type PriceLine = {
  /** The nights this room is held for — only on a booking whose rooms differ (2026-10-06). */
  dates?: string | null;
  description: string;
  /** The multiplier as printed: "3 nights", "2 pax × 3 nights". */
  qty: string;
  /** Unit rate, or null when the row has no single one (meals that vary night to night). */
  rate: number | null;
  amount: number;
  /** Sub-line of the room above it. */
  indent?: boolean;
};

/** A room's counts as the quotation stores them (`commercialTerms.roomCompositions[]`). */
export type PriceLineComposition = {
  adultCount?: number | null;
  cnb6To10Count?: number | null;
  cnbUnder6Count?: number | null;
  extraBedCount?: number | null;
  mealPlanCpCount?: number | null;
  mealPlanMaplCount?: number | null;
  mealPlanMapdCount?: number | null;
  mealPlanApCount?: number | null;
  mealPlanOthersCount?: number | null;
  othersBreakfastPax?: number | null;
  othersLunchPax?: number | null;
  othersDinnerPax?: number | null;
  isFoc?: boolean | null;
};

export type PriceLineRoom = {
  roomId: string;
  roomNumber: string | null;
  roomTypeName: string | null;
  /** The nights this room is priced for. */
  nights: number;
  composition: PriceLineComposition | null | undefined;
  /** The room rate the row prints — the rate priced, or the original one under a discount. */
  printedRoomRate: number;
  extraBedRate: number;
  breakfastRate: number;
  lunchRate: number;
  dinnerRate: number;
  /** The room's own meals figure — the truth the meal rows must add up to. */
  mealsSubtotal: number;
  /** The stored night-by-night extra-bed figure, when the bed count changed part-way. */
  extraBedSubtotal?: number | null;
  extraBedsVaryByNight?: boolean;
  /** True when per-date meal plans mean the meals are not one multiplication. */
  mealsVaryByNight: boolean;
  datesLabel?: string | null;
  /** Name the room by its type alone — the guest's papers (2026-10-28). */
  hideRoomNumber?: boolean;
  /**
   * How the desk names a room the system chose and may still move before Arrival — "Deluxe Double ·
   * room 1" (2026-10-28, docs/room-types-until-arrival.md). Printed in place of the room number, which
   * is not a promise yet.
   */
  roomLabel?: string | null;
  /** How many identical rooms these rows stand for (default 1) — see `buildPaperPriceLines`. */
  roomCount?: number;
};

/** The rows as figures to the cent, for a JSON answer (the document rounds as it prints). */
export function priceLinesToCents(lines: readonly PriceLine[]): PriceLine[] {
  const c = (v: number) => Number(v.toFixed(2));
  return lines.map((l) => ({ ...l, rate: l.rate == null ? null : c(l.rate), amount: c(l.amount) }));
}

export const nightsWord = (n: number) => `${n} night${n === 1 ? "" : "s"}`;

/** "2 adults, 1 child" — the room's occupants as the quotation names them. */
export function roomOccupantsLabel(c: PriceLineComposition | null | undefined): string {
  const adults = c?.adultCount ?? 0;
  const cnb = (c?.cnb6To10Count ?? 0) + (c?.cnbUnder6Count ?? 0);
  return `${adults} adult${adults === 1 ? "" : "s"}${cnb > 0 ? `, ${cnb} child${cnb === 1 ? "" : "ren"}` : ""}`;
}

/** "2 CP · 1 MAP+L" — the room's meal plans as tallies. */
export function mealPlanParts(c: PriceLineComposition | null | undefined): string[] {
  const parts: string[] = [];
  if (c?.mealPlanCpCount) parts.push(`${c.mealPlanCpCount} CP`);
  if (c?.mealPlanMaplCount) parts.push(`${c.mealPlanMaplCount} MAP+L`);
  if (c?.mealPlanMapdCount) parts.push(`${c.mealPlanMapdCount} MAP+D`);
  if (c?.mealPlanApCount) parts.push(`${c.mealPlanApCount} AP`);
  if (c?.mealPlanOthersCount) parts.push(`${c.mealPlanOthersCount} Others`);
  return parts;
}

/** One room's rows: the room, then its extra beds and its meals as sub-lines. */
export function buildRoomPriceLines(r: PriceLineRoom): PriceLine[] {
  const raw = r.composition ?? undefined;
  const roomNights = r.nights;
  const planParts = mealPlanParts(raw);
  const lines: PriceLine[] = [];
  // Several identical rooms set out once: every count and amount is k times one room's.
  const k = Math.max(1, Math.floor(r.roomCount ?? 1));
  const many = k > 1;
  const roomsTimes = (q: string) => (many ? `${k} rooms × ${q}` : q);

  // ── Room row ────────────────────────────────────────────────────────────────
  lines.push({
    dates: r.datesLabel ?? null,
    description: (r.hideRoomNumber
      ? [r.roomTypeName ?? "Room", many ? `${k} rooms` : null, `${roomOccupantsLabel(raw)}${many ? " each" : ""}`, raw?.isFoc ? "FOC" : null]
      : r.roomLabel
        ? [r.roomLabel, roomOccupantsLabel(raw), raw?.isFoc ? "FOC" : null]
        : [
            r.roomNumber ? `Room ${r.roomNumber}` : `Room ${r.roomId.slice(0, 6)}`,
            r.roomTypeName ?? null,
            roomOccupantsLabel(raw),
            raw?.isFoc ? "FOC" : null,
          ]
    )
      .filter(Boolean)
      .join(" · "),
    qty: roomsTimes(nightsWord(roomNights)),
    rate: r.printedRoomRate,
    amount: r.printedRoomRate * roomNights * k,
  });

  // ── Extra beds ──────────────────────────────────────────────────────────────
  const bedCount = Number(raw?.extraBedCount ?? 0);
  const bedRate = Number(r.extraBedRate ?? 0);
  if (r.extraBedsVaryByNight === true && Number(r.extraBedSubtotal ?? 0) > 0) {
    // The bed count changed part-way through the stay (in-house setup change, 2026-08-19) —
    // one multiplication can't describe it, so print the stored night-by-night figure.
    lines.push({
      description: `Extra bed · varies by night`,
      qty: roomsTimes(nightsWord(roomNights)),
      rate: null,
      amount: Number(r.extraBedSubtotal) * k,
    });
  } else if (bedCount > 0 && bedRate > 0) {
    lines.push({
      description: `Extra bed`,
      qty: `${bedCount * k} × ${nightsWord(roomNights)}`,
      rate: bedRate,
      amount: bedRate * bedCount * roomNights * k,
    });
  }

  // ── Meals, one row per plan ─────────────────────────────────────────────────
  // A plan's per-head nightly rate is the sum of the meals it includes, which is exactly how
  // `paxFromMealPlanCounts` prices it — so `planRate × pax × nights` summed over the plans
  // reproduces the stored `mealsSubtotal` to the cent.
  const bf = Number(r.breakfastRate ?? 0);
  const lu = Number(r.lunchRate ?? 0);
  const di = Number(r.dinnerRate ?? 0);
  const mealsSubtotal = Number(r.mealsSubtotal ?? 0);
  if (r.mealsVaryByNight && mealsSubtotal > 0) {
    // Per-date plans: no single rate × qty describes the stay, so state the stay total and say
    // why rather than printing a multiplication that doesn't hold.
    lines.push({
      description: `Meals · varies by night${planParts.length ? ` (usually ${planParts.join(" · ")})` : ""}`,
      qty: roomsTimes(nightsWord(roomNights)),
      rate: null,
      amount: mealsSubtotal * k,
    });
  } else {
    const planRows: Array<{ label: string; pax: number; rate: number }> = [
      { label: "CP (breakfast)", pax: Number(raw?.mealPlanCpCount ?? 0), rate: bf },
      { label: "MAP+L (breakfast, lunch)", pax: Number(raw?.mealPlanMaplCount ?? 0), rate: bf + lu },
      { label: "MAP+D (breakfast, dinner)", pax: Number(raw?.mealPlanMapdCount ?? 0), rate: bf + di },
      { label: "AP (all meals)", pax: Number(raw?.mealPlanApCount ?? 0), rate: bf + lu + di },
    ];
    // The room's own `mealsSubtotal` is the truth; splitting it into one row per plan is a
    // courtesy that has to add up to it. It does not always: the stored per-room meal RATES are
    // only populated on the first room of a composition, so on a multi-room booking rooms 2..n
    // priced their meals at a rate the document could not see and printed NO meal row at all —
    // the rows then under-summed by the missing meals and, once the deduction was measured as
    // rows-minus-net, the discount came out NEGATIVE (2026-10-06, operator: "I did a Nu 1000
    // discount, but it's now showing more"). So: print the split when it reconciles, and one
    // honest row at the stored figure when it cannot.
    const split = planRows
      .filter((pl) => pl.pax > 0 && pl.rate > 0)
      .map((pl) => ({ ...pl, amount: pl.rate * pl.pax * roomNights }));
    const alaCarteTotal =
      (Number(raw?.othersBreakfastPax ?? 0) * bf + Number(raw?.othersLunchPax ?? 0) * lu + Number(raw?.othersDinnerPax ?? 0) * di) *
      roomNights;
    const splitTotal = split.reduce((t, pl) => t + pl.amount, 0) + alaCarteTotal;
    const splitReconciles = mealsSubtotal <= 0 || Math.abs(splitTotal - mealsSubtotal) < 0.01;
    if (!splitReconciles) {
      // The pax ARE stored even when the rates are not, so a room on a single plan still prints
      // the row every other room prints — same words, same "N pax × N nights", and the per-head
      // rate worked back from the room's own figure (2026-10-06, operator: "why does the first row
      // show differently in the qty column ... just below that room, not the others"). A room on
      // several plans cannot be split from one subtotal, so it keeps one row with no unit rate.
      const withPax = planRows.filter((pl) => pl.pax > 0);
      const alaCartePax =
        Number(raw?.othersBreakfastPax ?? 0) + Number(raw?.othersLunchPax ?? 0) + Number(raw?.othersDinnerPax ?? 0);
      const only = withPax.length === 1 && alaCartePax === 0 ? withPax[0] : null;
      const covers = only ? only.pax * roomNights : 0;
      lines.push({
        description: only ? `Meals · ${only.label}` : `Meals${planParts.length ? ` · ${planParts.join(" · ")}` : ""}`,
        qty: only ? `${only.pax * k} pax × ${nightsWord(roomNights)}` : roomsTimes(nightsWord(roomNights)),
        rate: only && covers > 0 ? Number((mealsSubtotal / covers).toFixed(2)) : null,
        amount: mealsSubtotal * k,
      });
    }
    for (const p of splitReconciles ? split : []) {
      lines.push({
        description: `Meals · ${p.label}`,
        qty: `${p.pax * k} pax × ${nightsWord(roomNights)}`,
        rate: p.rate,
        amount: p.amount * k,
      });
    }
    // "Others" guests order à la carte, so their meals are priced per meal taken rather than by a
    // plan — one row per meal that actually has pax on it.
    const alaCarte: Array<{ label: string; pax: number; rate: number }> = splitReconciles
      ? [
          { label: "breakfast", pax: Number(raw?.othersBreakfastPax ?? 0), rate: bf },
          { label: "lunch", pax: Number(raw?.othersLunchPax ?? 0), rate: lu },
          { label: "dinner", pax: Number(raw?.othersDinnerPax ?? 0), rate: di },
        ]
      : [];
    for (const a of alaCarte) {
      if (a.pax > 0 && a.rate > 0) {
        lines.push({
          description: `Meals · à la carte ${a.label}`,
          qty: `${a.pax * k} pax × ${nightsWord(roomNights)}`,
          rate: a.rate,
          amount: a.rate * a.pax * roomNights * k,
        });
      }
    }
  }

  // Everything after this room's own row is a sub-line of it.
  for (let i = 1; i < lines.length; i++) lines[i].indent = true;
  return lines;
}

/**
 * The rooms' rows as a guest's paper prints them (2026-10-28, operator: "in the quotation and
 * proforma invoice can it not show the room numbers, just the room type"): each room named by its
 * type, and rooms that would print the very same rows set out once — "Deluxe Double · 2 rooms ·
 * 2 adults each", "2 rooms × 3 nights" — so the paper does not read like one line repeated. A
 * group's amounts are its rooms' amounts added together, so the rows still add up to the net value.
 * The desk's Charges tab keeps one row per room, with its number.
 */
export function buildPaperPriceLines(rooms: readonly PriceLineRoom[]): PriceLine[] {
  const groups: Array<{ first: PriceLineRoom; key: string; count: number }> = [];
  for (const r of rooms) {
    const key = JSON.stringify(buildRoomPriceLines({ ...r, hideRoomNumber: true, roomCount: 1 }));
    const g = groups.find((x) => x.key === key);
    if (g) g.count += 1;
    else groups.push({ first: r, key, count: 1 });
  }
  return groups.flatMap((g) => buildRoomPriceLines({ ...g.first, hideRoomNumber: true, roomCount: g.count }));
}

/**
 * The rows as the desk shows them: a room given by number keeps its own numbered rows, and the
 * rooms the system chose (they carry a `roomLabel`) read as the paper reads them — by their type,
 * identical rooms counted, "Premium Suite · 2 rooms" — never "Premium Suite · room 1, room 2"
 * (2026-10-30, operator). Their rows stand where the first of them stood.
 */
export function buildDeskPriceLines(rooms: readonly PriceLineRoom[]): PriceLine[] {
  const quiet = rooms.filter((r) => r.roomLabel);
  const lines: PriceLine[] = [];
  let quietDone = false;
  for (const r of rooms) {
    if (!r.roomLabel) {
      lines.push(...buildRoomPriceLines(r));
      continue;
    }
    if (quietDone) continue;
    quietDone = true;
    lines.push(...buildPaperPriceLines(quiet.map((q) => ({ ...q, roomLabel: null }))));
  }
  return lines;
}
