import type { Prisma } from "@prisma/client";
import { round2, sumMoney, toDecimal, ZERO, type MoneyLike } from "./money.js";
import {
  CORRECTION_LINE_PREFIX,
  classifyFolioLine,
  companionBaseDescription,
  isCorrectionCompanionDescription,
} from "./folio-tax-lines.js";

/**
 * THE LEDGER VIEW — one reading of a folio that every bill is a view of (2026-08-22).
 *
 * DFG-001 (docs/bills) models Family C as "one folio; component bills are filtered views; the
 * Master Bill is the rollup", and the Tax Invoice as the fiscal document over the same figures.
 * Before this module each document read the ledger its own way (the FINAL invoice in
 * `buildFinalInvoiceFigures`, the billing summary in its own loop, the interim figures in a
 * third). This is the single pure reading the documents share from now on:
 *
 *   - which lines are CHARGES and which are their SC / GST COMPANIONS (the one-home description
 *     convention in lib/folio-tax-lines.ts);
 *   - which COMPONENT each line belongs to — Room · Food & beverage · Services & other (the
 *     reference's charge-category → component-bill routing; a companion follows the charge it
 *     rides on, matched exactly as the desk's folio fold matches it);
 *   - the LADDER, additive from the ledger's own lines: net = Σ charges, service = Σ SC
 *     companions, taxable = net + service, GST = Σ GST companions, total = Σ everything — so
 *     every document reconciles to the folio's billed-so-far to the chethrum;
 *   - the legacy rule for room nights audited BEFORE the night audit wrote tax companions
 *     (2026-08-18): their SC/GST is computed at read time, aggregated and rounded once, exactly
 *     as `buildFinalInvoiceFigures` always did — so an old folio's documents keep their room tax.
 *
 * Pure: no I/O, Decimal throughout. Callers format.
 */

export type LedgerComponentKey = "ROOM" | "F_AND_B" | "SERVICES";

export const LEDGER_COMPONENTS: ReadonlyArray<{ key: LedgerComponentKey; label: string }> = [
  { key: "ROOM", label: "Room" },
  { key: "F_AND_B", label: "Food & beverage" },
  { key: "SERVICES", label: "Services & other" },
];

/** Charge category → component. The reference wants this in configuration; until a vocabulary
 *  surface exists it is this one map, consulted by every document. */
export function componentForLineType(lineType: string): LedgerComponentKey {
  if (lineType === "ROOM_CHARGE" || lineType === "STAY") return "ROOM";
  if (lineType === "F_AND_B") return "F_AND_B";
  return "SERVICES"; // SERVICE · OTHER · CREDIT_NOTE
}

export type LedgerLineLike = {
  id: string;
  lineType: string;
  description: string;
  amount: MoneyLike;
  chargeDate: Date;
  postedAt: Date;
  createdAt: Date;
  nightAuditRecordId: string | null;
  roomId: string | null;
  billingModel?: string | null;
  room?: { roomNumber: string } | null;
};

export type LedgerPaymentLike = {
  id: string;
  amount: MoneyLike;
  paymentDirection: string;
  billingModel?: string | null;
  paymentMethod?: string | null;
  receivedAt?: Date | null;
  createdAt: Date;
  stage?: string | null;
  interimPaymentRequestId?: string | null;
};

export type LedgerCharge<L extends LedgerLineLike = LedgerLineLike> = {
  line: L;
  component: LedgerComponentKey;
  isRoom: boolean;
  /** The charge's own correction line (`Correction for <id>: …`), not a fresh charge. */
  isCorrection: boolean;
  /** A room night with no tax companion on the ledger — its SC/GST is computed at read time. */
  legacyTaxAtRender: boolean;
};

export type LedgerCompanion<L extends LedgerLineLike = LedgerLineLike> = {
  line: L;
  kind: "SERVICE_CHARGE" | "GST";
  component: LedgerComponentKey;
};

export type LedgerComponentBucket = {
  key: LedgerComponentKey;
  label: string;
  base: Prisma.Decimal;
  serviceCharge: Prisma.Decimal;
  gst: Prisma.Decimal;
  /** base + serviceCharge + gst — the component's all-in figure. */
  total: Prisma.Decimal;
  chargeCount: number;
  /** ROOM only: positive, non-correction room-charge lines. */
  roomNights: number;
  /** Distinct room numbers the component's charges are attributed to, numeric order. */
  roomNumbers: string[];
  /** Distinct non-correction charge descriptions, posting order. */
  descriptions: string[];
};

export type FolioLedgerView<L extends LedgerLineLike = LedgerLineLike, P extends LedgerPaymentLike = LedgerPaymentLike> = {
  /** Charge lines in bill order: room nights first (night, room, posting), then the rest in posting order. */
  charges: Array<LedgerCharge<L>>;
  companions: Array<LedgerCompanion<L>>;
  /** Σ net of room lines whose tax is computed at read time (see module note). */
  legacyRoomNet: Prisma.Decimal;
  legacyServiceCharge: Prisma.Decimal;
  legacyGst: Prisma.Decimal;
  components: Record<LedgerComponentKey, LedgerComponentBucket>;
  ladder: {
    /** Σ charge lines (corrections and credit notes included). */
    net: Prisma.Decimal;
    /** Σ SC companions + legacy read-time SC. */
    serviceCharge: Prisma.Decimal;
    /** net + serviceCharge — the GST base. */
    taxable: Prisma.Decimal;
    /** Σ GST companions + legacy read-time GST. */
    gst: Prisma.Decimal;
    /** taxable + gst = the folio's billed-so-far for the covered lines. */
    total: Prisma.Decimal;
  };
  payments: {
    records: P[];
    in: Prisma.Decimal;
    out: Prisma.Decimal;
    /** in − out. */
    net: Prisma.Decimal;
  };
};

/** SC then compound GST on (net + SC), each rounded once on the aggregate — the legacy room-line rule. */
export function legacyTaxOn(
  net: Prisma.Decimal,
  svcRate: number,
  gstRate: number,
): { serviceCharge: Prisma.Decimal; gst: Prisma.Decimal } {
  const serviceCharge = svcRate > 0 ? round2(net.mul(svcRate)) : ZERO;
  const gst = gstRate > 0 ? round2(net.add(serviceCharge).mul(gstRate)) : ZERO;
  return { serviceCharge, gst };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function numericRoomSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export function buildFolioLedgerView<L extends LedgerLineLike, P extends LedgerPaymentLike>(input: {
  lines: readonly L[];
  payments: readonly P[];
  /** Split-billing bucket this view covers; null = the whole folio. */
  invoiceBucket: string | null;
  /** The folio's primary billing model — NULL-model lines/payments roll up to it. */
  primaryModel: string | null;
  gstRate: number;
  svcRate: number;
}): FolioLedgerView<L, P> {
  const invoiceBucket = input.invoiceBucket ?? null;
  const primaryModel = input.primaryModel?.trim() ?? null;
  const isBucketScoped = !!invoiceBucket;
  const bucketMatches = (model: string | null | undefined) => {
    if (!isBucketScoped) return true;
    const trimmed = model?.trim() ?? null;
    if (trimmed === invoiceBucket) return true;
    return trimmed == null && primaryModel === invoiceBucket;
  };

  const covered = input.lines.filter((l) => bucketMatches(l.billingModel));
  const chargeLines = covered.filter((l) => classifyFolioLine(l) === "CHARGE");
  const scLines = covered.filter((l) => classifyFolioLine(l) === "SERVICE_CHARGE");
  const gstLines = covered.filter((l) => classifyFolioLine(l) === "GST");

  // A room line is "covered" by ledger tax when a companion exists for the same night-audit run —
  // the structural pairing the audit writes (mirrors buildFinalInvoiceFigures' original rule).
  const auditRunsWithCompanions = new Set(
    [...scLines, ...gstLines].map((l) => l.nightAuditRecordId).filter((id): id is string => !!id),
  );

  // Bill order: room nights first (by night, then room, then posting), then every other charge
  // in posting order — the way a guest reads a hotel bill; the include carries no ordering.
  const ordered = [...chargeLines].sort((a, b) => {
    const ar = componentForLineType(a.lineType) === "ROOM" ? 0 : 1;
    const br = componentForLineType(b.lineType) === "ROOM" ? 0 : 1;
    if (ar !== br) return ar - br;
    const ad = a.chargeDate.getTime() - b.chargeDate.getTime();
    if (ad !== 0) return ad;
    const an = a.room?.roomNumber ?? "";
    const bn = b.room?.roomNumber ?? "";
    if (an !== bn) return numericRoomSort(an, bn);
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const charges: Array<LedgerCharge<L>> = ordered.map((line) => {
    const component = componentForLineType(line.lineType);
    const isRoom = component === "ROOM";
    return {
      line,
      component,
      isRoom,
      isCorrection: (line.description ?? "").startsWith(CORRECTION_LINE_PREFIX),
      legacyTaxAtRender: isRoom && !(!!line.nightAuditRecordId && auditRunsWithCompanions.has(line.nightAuditRecordId)),
    };
  });

  // A companion follows the charge it rides on: same room, same charge date, the exact base
  // description it names; nearest posting time on ties. A correction's delta names the ORIGINAL
  // charge but is dated with the correction, so it matches the correction row posted with it.
  // Falls back structurally — an audit-stamped companion is a room night's; anything else that
  // names no parent lands in Services & other. (Same rule as the desk's FolioLinesTable fold.)
  const attribute = (c: L): LedgerComponentKey => {
    const base = companionBaseDescription(c.description);
    const isCorr = isCorrectionCompanionDescription(c.description);
    const cands = charges.filter(
      (ch) =>
        (ch.line.roomId ?? null) === (c.roomId ?? null) &&
        ymd(ch.line.chargeDate) === ymd(c.chargeDate) &&
        (isCorr ? ch.isCorrection : base == null || ch.line.description === base),
    );
    if (cands.length > 0) {
      const ct = c.postedAt.getTime();
      cands.sort((a, b) => Math.abs(a.line.postedAt.getTime() - ct) - Math.abs(b.line.postedAt.getTime() - ct));
      return cands[0].component;
    }
    return c.nightAuditRecordId ? "ROOM" : "SERVICES";
  };
  const companions: Array<LedgerCompanion<L>> = [
    ...scLines.map((line) => ({ line, kind: "SERVICE_CHARGE" as const, component: attribute(line) })),
    ...gstLines.map((line) => ({ line, kind: "GST" as const, component: attribute(line) })),
  ];

  const legacyRoomNet = sumMoney(charges.filter((c) => c.legacyTaxAtRender).map((c) => c.line.amount));
  const legacy = legacyTaxOn(legacyRoomNet, input.svcRate, input.gstRate);

  const components = Object.fromEntries(
    LEDGER_COMPONENTS.map(({ key, label }) => {
      const mine = charges.filter((c) => c.component === key);
      const myCompanions = companions.filter((c) => c.component === key);
      const base = sumMoney(mine.map((c) => c.line.amount));
      let serviceCharge = sumMoney(myCompanions.filter((c) => c.kind === "SERVICE_CHARGE").map((c) => c.line.amount));
      let gst = sumMoney(myCompanions.filter((c) => c.kind === "GST").map((c) => c.line.amount));
      if (key === "ROOM") {
        serviceCharge = serviceCharge.add(legacy.serviceCharge);
        gst = gst.add(legacy.gst);
      }
      const roomNumbers = Array.from(new Set(mine.map((c) => c.line.room?.roomNumber).filter((n): n is string => !!n))).sort(
        numericRoomSort,
      );
      const descriptions = Array.from(new Set(mine.filter((c) => !c.isCorrection).map((c) => c.line.description.trim())));
      const bucket: LedgerComponentBucket = {
        key,
        label,
        base,
        serviceCharge,
        gst,
        total: base.add(serviceCharge).add(gst),
        chargeCount: mine.length,
        roomNights: key === "ROOM" ? mine.filter((c) => !c.isCorrection && toDecimal(c.line.amount).gt(0)).length : 0,
        roomNumbers,
        descriptions,
      };
      return [key, bucket];
    }),
  ) as Record<LedgerComponentKey, LedgerComponentBucket>;

  const net = sumMoney(charges.map((c) => c.line.amount));
  const serviceCharge = sumMoney(scLines.map((l) => l.amount)).add(legacy.serviceCharge);
  const gst = sumMoney(gstLines.map((l) => l.amount)).add(legacy.gst);
  const taxable = net.add(serviceCharge);

  const records = input.payments.filter((p) => bucketMatches(p.billingModel));
  const paidIn = sumMoney(records.filter((p) => p.paymentDirection === "IN").map((p) => p.amount));
  const paidOut = sumMoney(records.filter((p) => p.paymentDirection === "OUT").map((p) => p.amount));

  return {
    charges,
    companions,
    legacyRoomNet,
    legacyServiceCharge: legacy.serviceCharge,
    legacyGst: legacy.gst,
    components,
    ladder: { net, serviceCharge, taxable, gst, total: taxable.add(gst) },
    payments: { records, in: paidIn, out: paidOut, net: paidIn.sub(paidOut) },
  };
}
