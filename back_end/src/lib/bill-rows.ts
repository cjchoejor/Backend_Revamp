import type { Prisma } from "@prisma/client";
import { NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX, NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX } from "./folio-tax-lines.js";
import { sumMoney, toDecimal, type MoneyLike } from "./money.js";
import { labelRoomNights, type NightsMode } from "./room-nights-for-entry.js";

/**
 * A bill's rows (2026-11-25, moved here from the bill page so the papers set the charges out the
 * same way). A room's nights at one figure are one row ("3 nights × 3,000.00"), so a long stay stays
 * readable; every other charge keeps its own line and date. Rooms first, by their first night and
 * then number; the rest in the order they were posted. Each row's amount is its lines added up, so the rows add up to the
 * ledger's net to the chhertum.
 */
export type BillRow = {
  key: string;
  /** "09 Nov", or "10–12 Apr" for nights set out on one row. */
  when: string;
  /** A room number or a hall's name. */
  place: string | null;
  description: string;
  /** Nights on this row and the figure of each, when there is more than one. */
  qty: number;
  rate: number;
  amount: number;
  /** A room's nights or meal plan set out on one row — the paper prints its nights and rate. */
  repeats: boolean;
};

export type BillRowLine = {
  id: string;
  description: string;
  amount: MoneyLike;
  chargeDate: Date;
  room?: { roomNumber: string } | null;
  space?: { name: string } | null;
};

export type BillRowCharge<L extends BillRowLine = BillRowLine> = { line: L; isRoom: boolean; isCorrection: boolean };

const n = (v: MoneyLike) => Number(toDecimal(v).toFixed(2));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const firstNight = (lines: ReadonlyArray<{ chargeDate: Date }>) => Math.min(...lines.map((l) => l.chargeDate.getTime()));

/** Plain words for a line: the desk's working names never reach a bill. */
export function billWordsFor(description: string): { words: string; repeats: boolean } {
  if (description.startsWith(NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX)) return { words: "Room charge", repeats: true };
  if (description.startsWith(NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX)) return { words: "Meal plan", repeats: true };
  return { words: description.replace(/^Correction for \S+: /, "Correction: "), repeats: false };
}

/** The rows of a bill, from the ledger view's charges (in its bill order). */
export function billRowsOf<L extends BillRowLine>(charges: ReadonlyArray<BillRowCharge<L>>, mode: NightsMode = "SHORT"): BillRow[] {
  const grouped = new Map<string, { place: string | null; words: string; isRoom: boolean; amount: Prisma.Decimal; lines: L[] }>();
  const single: BillRow[] = [];
  for (const c of charges) {
    const { words, repeats } = billWordsFor(c.line.description);
    const place = c.line.room?.roomNumber ?? c.line.space?.name ?? null;
    if (!c.isCorrection && (repeats || c.isRoom)) {
      const key = `${place ?? ""}|${c.isRoom ? words || "Room" : words}|${toDecimal(c.line.amount).toFixed(2)}`;
      const g = grouped.get(key) ?? { place, words, isRoom: c.isRoom, amount: toDecimal(c.line.amount), lines: [] };
      g.lines.push(c.line);
      grouped.set(key, g);
    } else {
      single.push({
        key: c.line.id,
        when: labelRoomNights([ymd(c.line.chargeDate)], mode),
        place,
        description: words,
        qty: 1,
        rate: n(c.line.amount),
        amount: n(c.line.amount),
        repeats: false,
      });
    }
  }
  const rows = [...grouped.values()]
    // By the first night, then the room, the room charge before its meal plan — the order a guest
    // reads a hotel bill in (2026-11-25; it was by room number alone).
    .sort(
      (a, b) =>
        firstNight(a.lines) - firstNight(b.lines) ||
        byNumber(a.place ?? "", b.place ?? "") ||
        Number(b.isRoom) - Number(a.isRoom),
    )
    .map((g) => ({
      key: g.lines[0]!.id,
      when: labelRoomNights(
        g.lines.map((l) => ymd(l.chargeDate)),
        mode,
      ),
      place: g.place,
      description: g.words,
      qty: g.lines.length,
      rate: n(g.amount),
      amount: n(sumMoney(g.lines.map((l) => l.amount))),
      repeats: true,
    }));
  return [...rows, ...single];
}
