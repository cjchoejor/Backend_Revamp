import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX, NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX } from "../../lib/folio-tax-lines.js";
import { buildFolioLedgerView } from "../../lib/folio-ledger-view.js";
import { sumMoney, toDecimal, ZERO, type MoneyLike } from "../../lib/money.js";
import { loadHotelProfileForRender } from "../../lib/pdf-render-context.js";
import { labelRoomNights } from "../../lib/room-nights-for-entry.js";
import { effectiveCheckOutDate } from "../../lib/stay-dates.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { buildEntryBillingSummary } from "./entry-billing-summary-service.js";
import { taxInvoicePartiesFromEntry } from "./invoice-pdf-service.js";

/**
 * THE BILL ON THE BILLING PAGE (2026-11-09, operator: "a proper page here where it shows a hotel
 * like bill format with all the necessary info with tables and stuff, if it has multiple entries
 * their bills together").
 *
 * A read, nothing written. The lines and the net · service charge · GST ladder are the ledger view
 * every paper prints from (lib/folio-ledger-view.ts); billed, received, refunded, written off and the
 * balance are the booking's own billing summary, the figures the Billing list shows. A trip's figures
 * are only its stays' added up, in Decimal: each stay keeps its own bill.
 */

const BILL_ENTRY_INCLUDE = {
  guestProfile: true,
  inquiry: { include: { travelAgent: true, corporateAccount: true } },
  folio: {
    include: {
      lines: { include: { room: { select: { roomNumber: true } }, space: { select: { name: true } } } },
      payments: true,
      invoices: { orderBy: { createdAt: "desc" as const } },
      writeOffRecords: true,
    },
  },
  roomAssignments: { include: { room: { select: { roomNumber: true } } } },
} satisfies Prisma.EntryInclude;

type BillEntry = Prisma.EntryGetPayload<{ include: typeof BILL_ENTRY_INCLUDE }>;

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
};

export type BillPayment = {
  id: string;
  stayNo: number;
  at: string;
  method: string | null;
  /** MOVE (2026-11-10): money paid for the trip moved from one stay's bill to another's — the two
   *  halves of the move as one row. Neither paid by the guest nor given back. */
  direction: "IN" | "OUT" | "MOVE";
  amount: number;
  note: string | null;
  /** A MOVE's two stays. */
  fromStayNo?: number;
  toStayNo?: number;
  /** The move's reference, for pairing its two halves. */
  moveRef?: string | null;
};

export type BillFigures = {
  net: number;
  serviceCharge: number;
  gst: number;
  total: number;
  received: number;
  refunded: number;
  writtenOff: number;
  /** A booking brought over from the old system: settled there, with no payment on record here. */
  settledBefore: number;
  balance: number;
  paidAhead: number;
};

export type BillStay = {
  entryId: string;
  stayNo: number;
  status: string;
  stage: string;
  folioId: string | null;
  folioState: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  rooms: string[];
  roomCount: number;
  guest: string | null;
  rows: BillRow[];
  figures: BillFigures;
  taxInvoices: Array<{ id: string; number: string }>;
};

export type BillView = {
  entryId: string;
  inquiryId: string;
  currency: string;
  asAt: string;
  hotel: { name: string; address: string; phone: string | null; email: string; tpn: string | null; gstTpn: string | null; logo: string | null };
  billedTo: string;
  forGuest: string | null;
  customerTpn: string | null;
  stays: BillStay[];
  payments: BillPayment[];
  figures: BillFigures;
};

const n = (v: MoneyLike) => Number(toDecimal(v).toFixed(2));
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function phoneOf(contactNumbers: unknown): string | null {
  if (typeof contactNumbers === "string") return contactNumbers;
  if (contactNumbers && typeof contactNumbers === "object") {
    const c = contactNumbers as Record<string, unknown>;
    const first = c.primary ?? Object.values(c)[0];
    return typeof first === "string" ? first : null;
  }
  return null;
}

/** Plain words for a line: the desk's working names never reach a bill. */
function wordsFor(description: string): { words: string; repeats: boolean } {
  if (description.startsWith(NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX)) return { words: "Room charge", repeats: true };
  if (description.startsWith(NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX)) return { words: "Meal plan", repeats: true };
  return { words: description.replace(/^Correction for \S+: /, "Correction: "), repeats: false };
}

/**
 * The bill's rows. A room's nights at one figure are one row ("3 nights × 3,000.00"), so a long stay
 * stays readable; everything else keeps its own line and date. Rooms first, in number order.
 */
function rowsOf(view: ReturnType<typeof buildFolioLedgerView<BillLine, BillPaymentRow>>): BillRow[] {
  const grouped = new Map<string, { place: string | null; words: string; isRoom: boolean; amount: Prisma.Decimal; lines: BillLine[] }>();
  const single: BillRow[] = [];
  for (const c of view.charges) {
    const { words, repeats } = wordsFor(c.line.description);
    const place = c.line.room?.roomNumber ?? c.line.space?.name ?? null;
    if (!c.isCorrection && (repeats || c.isRoom)) {
      const key = `${place ?? ""}|${c.isRoom ? words || "Room" : words}|${toDecimal(c.line.amount).toFixed(2)}`;
      const g = grouped.get(key) ?? { place, words, isRoom: c.isRoom, amount: toDecimal(c.line.amount), lines: [] };
      g.lines.push(c.line);
      grouped.set(key, g);
    } else {
      single.push({ key: c.line.id, when: labelRoomNights([ymd(c.line.chargeDate)!]), place, description: words, qty: 1, rate: n(c.line.amount), amount: n(c.line.amount) });
    }
  }
  const rows = [...grouped.values()]
    .sort((a, b) => byNumber(a.place ?? "", b.place ?? "") || Number(b.isRoom) - Number(a.isRoom) || a.lines[0]!.chargeDate.getTime() - b.lines[0]!.chargeDate.getTime())
    .map((g) => ({
      key: g.lines[0]!.id,
      when: labelRoomNights(g.lines.map((l) => ymd(l.chargeDate)!)),
      place: g.place,
      description: g.words,
      qty: g.lines.length,
      rate: n(g.amount),
      amount: n(sumMoney(g.lines.map((l) => l.amount))),
    }));
  return [...rows, ...single];
}

type BillLine = NonNullable<BillEntry["folio"]>["lines"][number];
type BillPaymentRow = NonNullable<BillEntry["folio"]>["payments"][number];

const NOTHING: BillFigures = { net: 0, serviceCharge: 0, gst: 0, total: 0, received: 0, refunded: 0, writtenOff: 0, settledBefore: 0, balance: 0, paidAhead: 0 };

async function billOfStay(prisma: PrismaClient, entry: BillEntry, stayNo: number, rates: { gstRate: number; svcRate: number }): Promise<{ stay: BillStay; payments: BillPayment[] }> {
  const checkOut = effectiveCheckOutDate(entry);
  const nights = entry.checkInDate && checkOut ? Math.max(0, Math.round((checkOut.getTime() - entry.checkInDate.getTime()) / 86_400_000)) : null;
  const rooms = Array.from(new Set(entry.roomAssignments.map((a) => a.room?.roomNumber).filter((x): x is string => !!x))).sort(byNumber);
  const guest = [entry.guestProfile?.title, entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ") || null;
  const base = {
    entryId: entry.id,
    stayNo,
    status: entry.status,
    stage: entry.currentStage,
    checkIn: ymd(entry.checkInDate),
    checkOut: ymd(checkOut),
    nights,
    rooms,
    roomCount: entry.numberOfRooms ?? rooms.length,
    guest,
  };
  const folio = entry.folio;
  if (!folio) return { stay: { ...base, folioId: null, folioState: null, rows: [], figures: { ...NOTHING }, taxInvoices: [] }, payments: [] };

  const view = buildFolioLedgerView<BillLine, BillPaymentRow>({
    lines: folio.lines,
    payments: folio.payments,
    invoiceBucket: null,
    primaryModel: folio.billingModel ?? null,
    gstRate: rates.gstRate,
    svcRate: rates.svcRate,
  });
  const summary = (await buildEntryBillingSummary(prisma, entry.id)).folio;
  // The import pinned these balances at what the old system left (docs/money-audit-2026-08-24.md).
  // Only an imported bill may read this way: anywhere else a gap must show as a gap.
  const imported = folio.lines.some((l) => /\(imported/i.test(l.description));
  const settledBefore = imported
    ? toDecimal(view.ladder.total)
        .sub(summary?.paymentsReceived ?? 0)
        .add(summary?.refunded ?? 0)
        .sub(summary?.writtenOff ?? 0)
        .sub(summary?.outstandingBalance ?? 0)
        .add(summary?.overpaid ?? 0)
    : ZERO;
  const figures: BillFigures = {
    net: n(view.ladder.net),
    serviceCharge: n(view.ladder.serviceCharge),
    gst: n(view.ladder.gst),
    total: n(view.ladder.total),
    received: summary?.paymentsReceived ?? 0,
    refunded: summary?.refunded ?? 0,
    writtenOff: summary?.writtenOff ?? 0,
    settledBefore: n(settledBefore),
    balance: summary?.outstandingBalance ?? 0,
    paidAhead: summary?.overpaid ?? 0,
  };
  const payments: BillPayment[] = view.payments.records.map((p) => ({
    id: p.id,
    stayNo,
    at: (p.receivedAt ?? p.createdAt).toISOString(),
    method: p.paymentMethod ?? null,
    direction: p.paymentDirection === "OUT" ? "OUT" : "IN",
    amount: n(p.amount),
    note: p.tripTransferRef ? "moved between the stays" : p.paidForTrip ? "paid for the trip" : null,
    moveRef: p.tripTransferRef ?? null,
  }));
  return {
    stay: {
      ...base,
      folioId: folio.id,
      folioState: folio.state,
      rows: rowsOf(view),
      figures,
      taxInvoices: folio.invoices.filter((i) => i.invoiceType === "FINAL" && i.state !== "SUPERSEDED").map((i) => ({ id: i.id, number: i.documentNumber ?? i.id })),
    },
    payments,
  };
}

/**
 * Whether a stay of a trip is on the trip's bill (2026-11-10, shared with the desk's lists so the bill
 * and the lists agree on what a trip comes to): every live stay, and an ended one only when its bill
 * carries something — a cancelled stay with nothing on it has nothing to say.
 */
export function stayIsOnTripBill(e: { status: string; folio?: { lines?: unknown[] | number; payments?: unknown[] | number } | null }): boolean {
  const count = (v: unknown[] | number | undefined) => (typeof v === "number" ? v : v?.length ?? 0);
  return !["CANCELLED", "EXPIRED"].includes(e.status) || count(e.folio?.lines) > 0 || count(e.folio?.payments) > 0;
}

const sumOf = (stays: BillStay[], key: keyof BillFigures) => n(sumMoney(stays.map((s) => s.figures[key])).add(ZERO));

/**
 * The two halves of each move between the stays as one row, and what they came to: a move is one
 * row out of one bill and one into another, the same amount, sharing `tripTransferRef`.
 */
export function pairTripMoves(list: BillPayment[]): { rows: BillPayment[]; movedIn: Prisma.Decimal; movedOut: Prisma.Decimal } {
  const byRef = new Map<string, BillPayment[]>();
  for (const p of list) if (p.moveRef) byRef.set(p.moveRef, [...(byRef.get(p.moveRef) ?? []), p]);
  let movedIn = ZERO;
  let movedOut = ZERO;
  const paired = new Set<string>();
  const merged: BillPayment[] = [];
  for (const [ref, halves] of byRef) {
    const out = halves.find((h) => h.direction === "OUT");
    const into = halves.find((h) => h.direction === "IN");
    if (!out || !into || halves.length !== 2) continue;
    movedIn = movedIn.add(toDecimal(into.amount));
    movedOut = movedOut.add(toDecimal(out.amount));
    paired.add(out.id).add(into.id);
    merged.push({
      id: `move:${ref}`,
      stayNo: into.stayNo,
      at: out.at < into.at ? out.at : into.at,
      method: out.method ?? into.method,
      direction: "MOVE",
      amount: into.amount,
      note: "money paid for the trip, moved to pay a cancelled stay's charge or a stay's advance",
      fromStayNo: out.stayNo,
      toStayNo: into.stayNo,
      moveRef: ref,
    });
  }
  const rows = [...list.filter((p) => !paired.has(p.id)), ...merged].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { rows, movedIn, movedOut };
}

/** The bill of a booking, with every other stay of its trip that has one. */
export async function buildBillView(prisma: PrismaClient, entryId: string): Promise<BillView> {
  const asked = await prisma.entry.findUnique({ where: { id: entryId }, select: { inquiryId: true } });
  if (!asked) throw new NotFoundError("Entry");
  const entries = await prisma.entry.findMany({ where: { inquiryId: asked.inquiryId }, orderBy: { checkInDate: "asc" }, include: BILL_ENTRY_INCLUDE });
  // A stay that ended with nothing on its bill has nothing to say here.
  const shown = entries.filter((e) => e.id === entryId || stayIsOnTripBill(e));
  const [hotel, { gstRate, serviceChargeRate: svcRate }] = await Promise.all([loadHotelProfileForRender(prisma), resolveChargeRates(prisma)]);
  const billed = await Promise.all(shown.map((e) => billOfStay(prisma, e, entries.indexOf(e) + 1, { gstRate, svcRate })));
  const stays = billed.map((b) => b.stay);
  // Money moved between the stays is one row, and it is neither received nor refunded for the
  // trip (2026-11-10, operator, on INQ-20261109-0190: Received read Nu 5,570.75 for Nu 5,370.75
  // the guest paid, Refunded Nu 5,270.75 for Nu 5,070.75 given back — the Nu 200 moved counted in
  // both). A move whose other half is not on this bill stays as it is.
  const { rows: payments, movedIn, movedOut } = pairTripMoves(billed.flatMap((b) => b.payments));
  const parties = taxInvoicePartiesFromEntry(entries.find((e) => e.id === entryId)!);
  return {
    entryId,
    inquiryId: asked.inquiryId,
    currency: hotel.propertyCurrency ?? "BTN",
    asAt: new Date().toISOString(),
    hotel: {
      name: hotel.hotelName,
      address: hotel.registeredAddress,
      phone: phoneOf(hotel.contactNumbers),
      email: hotel.primaryEmail,
      tpn: hotel.tpnNumber,
      gstTpn: hotel.gstTpnNumber,
      logo: hotel.logoDataUri,
    },
    billedTo: parties.billedTo,
    forGuest: parties.forGuest,
    customerTpn: parties.customerTpn,
    stays,
    payments,
    figures: {
      net: sumOf(stays, "net"),
      serviceCharge: sumOf(stays, "serviceCharge"),
      gst: sumOf(stays, "gst"),
      total: sumOf(stays, "total"),
      received: n(toDecimal(sumOf(stays, "received")).sub(movedIn)),
      refunded: n(toDecimal(sumOf(stays, "refunded")).sub(movedOut)),
      writtenOff: sumOf(stays, "writtenOff"),
      settledBefore: sumOf(stays, "settledBefore"),
      balance: sumOf(stays, "balance"),
      paidAhead: sumOf(stays, "paidAhead"),
    },
  };
}
