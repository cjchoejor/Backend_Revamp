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

import { labelRoomNights, type NightsMode } from "./room-nights-for-entry.js";

export type PriceLine = {
  /**
   * The nights this line is for (2026-10-06; on every room since 2026-10-30). A line under a room
   * carries its own nights only when they are not all the room's — an extra bed or a meal plan
   * on part of the stay.
   */
  dates?: string | null;
  description: string;
  /** The multiplier as printed: "3 nights", "2 pax × 3 nights". */
  qty: string;
  /** Unit rate, or null when the row has no single one (meals that vary night to night). */
  rate: number | null;
  amount: number;
  /** Sub-line of the room above it. */
  indent?: boolean;
  /** A line that says something and charges nothing — "Room only · no meals" (2026-10-30). */
  muted?: boolean;
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
  /** The nights whose meals or beds differ from the room's usual night (`RoomNightMealOverride`). */
  nightMealOverrides?: Array<{
    date: string | Date;
    mealPlanCpCount?: number | null;
    mealPlanMaplCount?: number | null;
    mealPlanMapdCount?: number | null;
    mealPlanApCount?: number | null;
    mealPlanOthersCount?: number | null;
    othersBreakfastPax?: number | null;
    othersLunchPax?: number | null;
    othersDinnerPax?: number | null;
    extraBedCount?: number | null;
  }> | null;
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
  /** The room's own nights, `YYYY-MM-DD` — written on its row in the paper's words. */
  nightDates?: readonly string[] | null;
  /** How the nights are written: the first and last of a run (default), or each one. */
  nightsMode?: NightsMode;
  /**
   * Each night as the pricing priced it (`perNightMealBreakdown`): that night's meals figure and
   * extra beds. Present when some night differs from the room's usual one; it is what lets the
   * bed and meal lines be set out by the nights they are for, adding up to the room's own figures.
   */
  nightBreakdown?: ReadonlyArray<{ date: string; meals: number; extraBeds?: number | null }> | null;
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
  const nightsN = r.nights;
  const planParts = mealPlanParts(raw);
  const lines: PriceLine[] = [];
  // Several identical rooms set out once: every count and amount is k times one room's.
  const k = Math.max(1, Math.floor(r.roomCount ?? 1));
  const many = k > 1;
  const roomsTimes = (q: string) => (many ? `${k} rooms × ${q}` : q);

  // The room's nights, in the paper's words; a line under it names its own only when they differ.
  const mode: NightsMode = r.nightsMode ?? "SHORT";
  const nb = (r.nightBreakdown ?? []).filter((n) => n && n.date).map((n) => ({ ...n, date: String(n.date).slice(0, 10) }));
  const roomNightList = [...new Set((r.nightDates?.length ? r.nightDates : nb.map((n) => n.date)).map((d) => String(d).slice(0, 10)))].sort();
  const roomNightsKey = roomNightList.join(",");
  const subDates = (ds: readonly string[]): string | null => {
    const sorted = [...new Set(ds)].sort();
    return sorted.join(",") === roomNightsKey ? null : labelRoomNights(sorted, mode);
  };

  // ── Room row ────────────────────────────────────────────────────────────────
  lines.push({
    dates: roomNightList.length ? labelRoomNights(roomNightList, mode) : (r.datesLabel ?? null),
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
    qty: roomsTimes(nightsWord(nightsN)),
    rate: r.printedRoomRate,
    amount: r.printedRoomRate * nightsN * k,
  });

  // ── Extra beds ──────────────────────────────────────────────────────────────
  const bedCount = Number(raw?.extraBedCount ?? 0);
  const bedRate = Number(r.extraBedRate ?? 0);
  // The bed count changed part-way (2026-08-19), and each night is known: one line per run of
  // nights with the same number of beds, nights with none printing no line (2026-10-30, operator).
  // It must add up to the room's own extra-bed figure, or the old single line stands.
  const bedsByNight =
    r.extraBedsVaryByNight === true && bedRate > 0 && nb.length
      ? groupNights(nb.map((n) => ({ date: n.date, key: String(Math.max(0, Math.trunc(Number(n.extraBeds ?? bedCount)))) })))
      : null;
  const bedLines = (bedsByNight ?? [])
    .filter((g) => Number(g.key) > 0)
    .map((g) => ({ count: Number(g.key), dates: g.dates, amount: bedRate * Number(g.key) * g.dates.length }));
  const bedSplitFits =
    !!bedsByNight && Math.abs(bedLines.reduce((t, l) => t + l.amount, 0) - Number(r.extraBedSubtotal ?? 0)) < 0.01;
  if (bedSplitFits) {
    for (const l of bedLines) {
      lines.push({
        dates: subDates(l.dates),
        description: `Extra bed`,
        qty: `${l.count * k} × ${nightsWord(l.dates.length)}`,
        rate: bedRate,
        amount: l.amount * k,
      });
    }
  } else if (r.extraBedsVaryByNight === true && Number(r.extraBedSubtotal ?? 0) > 0) {
    // The bed count changed part-way through the stay (in-house setup change, 2026-08-19) —
    // one multiplication can't describe it, so print the stored night-by-night figure.
    lines.push({
      description: `Extra bed · varies by night`,
      qty: roomsTimes(nightsWord(nightsN)),
      rate: null,
      amount: Number(r.extraBedSubtotal) * k,
    });
  } else if (bedCount > 0 && bedRate > 0) {
    lines.push({
      description: `Extra bed`,
      qty: `${bedCount * k} × ${nightsWord(nightsN)}`,
      rate: bedRate,
      amount: bedRate * bedCount * nightsN * k,
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
  // Meals that change part-way, each night known (2026-10-30, operator): one line per run of
  // nights on the same plans, from each night's own figure, so the lines add up to the room's
  // meals exactly; a night with no meals reads "Room only · no meals" and charges nothing.
  const mealsByNight = r.mealsVaryByNight && mealsSubtotal > 0 && nb.length ? mealLinesByNight(raw, nb, { bf, lu, di }) : null;
  if (mealsByNight && Math.abs(mealsByNight.reduce((t, l) => t + l.amount, 0) - mealsSubtotal) < 0.01) {
    for (const l of mealsByNight) {
      lines.push({
        dates: subDates(l.dates),
        description: l.description,
        qty: l.pax == null ? (l.muted ? "" : roomsTimes(nightsWord(l.dates.length))) : `${l.pax * k} pax × ${nightsWord(l.dates.length)}`,
        rate: l.rate,
        amount: l.amount * k,
        muted: l.muted || undefined,
      });
    }
  } else if (r.mealsVaryByNight && mealsSubtotal > 0) {
    // Per-date plans: no single rate × qty describes the stay, so state the stay total and say
    // why rather than printing a multiplication that doesn't hold.
    lines.push({
      description: `Meals · varies by night${planParts.length ? ` (usually ${planParts.join(" · ")})` : ""}`,
      qty: roomsTimes(nightsWord(nightsN)),
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
      .map((pl) => ({ ...pl, amount: pl.rate * pl.pax * nightsN }));
    const alaCarteTotal =
      (Number(raw?.othersBreakfastPax ?? 0) * bf + Number(raw?.othersLunchPax ?? 0) * lu + Number(raw?.othersDinnerPax ?? 0) * di) *
      nightsN;
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
      const covers = only ? only.pax * nightsN : 0;
      lines.push({
        description: only ? `Meals · ${only.label}` : `Meals${planParts.length ? ` · ${planParts.join(" · ")}` : ""}`,
        qty: only ? `${only.pax * k} pax × ${nightsWord(nightsN)}` : roomsTimes(nightsWord(nightsN)),
        rate: only && covers > 0 ? Number((mealsSubtotal / covers).toFixed(2)) : null,
        amount: mealsSubtotal * k,
      });
    }
    for (const p of splitReconciles ? split : []) {
      lines.push({
        description: `Meals · ${p.label}`,
        qty: `${p.pax * k} pax × ${nightsWord(nightsN)}`,
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
          qty: `${a.pax * k} pax × ${nightsWord(nightsN)}`,
          rate: a.rate,
          amount: a.rate * a.pax * nightsN * k,
        });
      }
    }
  }

  // Everything after this room's own row is a sub-line of it.
  for (let i = 1; i < lines.length; i++) lines[i].indent = true;
  return lines;
}

/** Nights with the same key, ordered by their first night (a key coming back joins its group). */
function groupNights(nights: ReadonlyArray<{ date: string; key: string }>): Array<{ key: string; dates: string[] }> {
  const groups: Array<{ key: string; dates: string[] }> = [];
  for (const n of [...nights].sort((a, b) => a.date.localeCompare(b.date))) {
    const g = groups.find((x) => x.key === n.key);
    if (g) g.dates.push(n.date);
    else groups.push({ key: n.key, dates: [n.date] });
  }
  return groups;
}

type MealRates = { bf: number; lu: number; di: number };
type PlanField = "mealPlanCpCount" | "mealPlanMaplCount" | "mealPlanMapdCount" | "mealPlanApCount";
const PLAN_WORDS: ReadonlyArray<{ field: PlanField; label: string; short: string; rate: (r: MealRates) => number }> = [
  { field: "mealPlanCpCount", label: "CP (breakfast)", short: "CP", rate: (r) => r.bf },
  { field: "mealPlanMaplCount", label: "MAP+L (breakfast, lunch)", short: "MAP+L", rate: (r) => r.bf + r.lu },
  { field: "mealPlanMapdCount", label: "MAP+D (breakfast, dinner)", short: "MAP+D", rate: (r) => r.bf + r.di },
  { field: "mealPlanApCount", label: "AP (all meals)", short: "AP", rate: (r) => r.bf + r.lu + r.di },
];
const COUNT_FIELDS = [
  "mealPlanCpCount",
  "mealPlanMaplCount",
  "mealPlanMapdCount",
  "mealPlanApCount",
  "mealPlanOthersCount",
  "othersBreakfastPax",
  "othersLunchPax",
  "othersDinnerPax",
] as const;
type NightCounts = Record<(typeof COUNT_FIELDS)[number], number>;
type NightMealLine = { dates: string[]; description: string; pax: number | null; rate: number | null; amount: number; muted: boolean };

/**
 * A room's meal lines night by night: each night's plans are the room's usual ones unless an
 * override for that night names meals (the pricing's own rule — an override naming only beds
 * leaves the meals alone), and each run of nights on the same plans is priced from those nights'
 * own figures. A run on one plan says "N pax × N nights" with its rate per head; several plans in
 * one run are split by their rates when that adds up, else set out as one line.
 */
function mealLinesByNight(
  raw: PriceLineComposition | undefined,
  nb: ReadonlyArray<{ date: string; meals: number }>,
  rates: MealRates,
): NightMealLine[] {
  const usual = Object.fromEntries(COUNT_FIELDS.map((f) => [f, Number(raw?.[f] ?? 0)])) as NightCounts;
  const overrides = new Map<string, NonNullable<PriceLineComposition["nightMealOverrides"]>[number]>();
  for (const o of raw?.nightMealOverrides ?? []) {
    const key = o?.date instanceof Date ? o.date.toISOString().slice(0, 10) : String(o?.date ?? "").slice(0, 10);
    if (key) overrides.set(key, o);
  }
  const countsOn = (date: string): NightCounts => {
    const o = overrides.get(date);
    if (!o || !COUNT_FIELDS.some((f) => o[f] != null)) return usual;
    return Object.fromEntries(COUNT_FIELDS.map((f) => [f, Number(o[f] ?? 0)])) as NightCounts;
  };
  const mealsOn = new Map(nb.map((n) => [n.date, Number(n.meals ?? 0)]));
  const countsByDate = new Map(nb.map((n) => [n.date, countsOn(n.date)]));
  const groups = groupNights(nb.map((n) => ({ date: n.date, key: JSON.stringify(countsByDate.get(n.date)) })));
  const out: NightMealLine[] = [];
  for (const g of groups) {
    const c = countsByDate.get(g.dates[0])!;
    const n = g.dates.length;
    const amount = g.dates.reduce((t, d) => t + (mealsOn.get(d) ?? 0), 0);
    if (!COUNT_FIELDS.some((f) => c[f] > 0)) {
      out.push({ dates: g.dates, description: "Room only · no meals", pax: null, rate: null, amount: 0, muted: true });
      continue;
    }
    const plans = PLAN_WORDS.filter((p) => c[p.field] > 0).map((p) => ({ label: p.label, short: p.short, pax: c[p.field], rate: p.rate(rates) }));
    const alaCarte = [
      { label: "breakfast", pax: c.othersBreakfastPax, rate: rates.bf },
      { label: "lunch", pax: c.othersLunchPax, rate: rates.lu },
      { label: "dinner", pax: c.othersDinnerPax, rate: rates.di },
    ].filter((a) => a.pax > 0);
    const split = [
      ...plans.map((p) => ({ description: `Meals · ${p.label}`, pax: p.pax, rate: p.rate, amount: p.rate * p.pax * n })),
      ...alaCarte.map((a) => ({ description: `Meals · à la carte ${a.label}`, pax: a.pax, rate: a.rate, amount: a.rate * a.pax * n })),
    ];
    const othersUnpriced = c.mealPlanOthersCount > 0 && alaCarte.length === 0;
    const splitFits =
      !othersUnpriced && split.length > 0 && split.every((x) => x.rate > 0) && Math.abs(split.reduce((t, x) => t + x.amount, 0) - amount) < 0.01;
    if (splitFits) {
      for (const x of split) out.push({ dates: g.dates, ...x, muted: false });
      continue;
    }
    // The split does not add up (children's meals are priced at a share of the adult rate, or a
    // plan's own rate is not the sum of its meals): one plan still prints per head, worked back
    // from the nights' own figure; several print as one line at that figure.
    if (plans.length === 1 && alaCarte.length === 0 && !othersUnpriced) {
      const covers = plans[0].pax * n;
      out.push({
        dates: g.dates,
        description: `Meals · ${plans[0].label}`,
        pax: plans[0].pax,
        rate: covers > 0 ? Number((amount / covers).toFixed(2)) : null,
        amount,
        muted: false,
      });
      continue;
    }
    const words = [...plans.map((p) => `${p.pax} ${p.short}`), ...(c.mealPlanOthersCount > 0 ? [`${c.mealPlanOthersCount} Others`] : [])].join(" · ");
    out.push({ dates: g.dates, description: `Meals${words ? ` · ${words}` : ""}`, pax: null, rate: null, amount, muted: false });
  }
  return out;
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
