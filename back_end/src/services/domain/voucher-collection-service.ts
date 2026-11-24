/**
 * Vouchers to collect (2026-11-24, operator: "in the billing section maybe we should show it if it was
 * actually gotten later, like a flag which shows that the transaction has been recorded or not —
 * recorded could mean the agent has done the payment with card, QR and all, and recorded the journal
 * number").
 *
 * WHAT A VOUCHER IS HERE. At check-out the desk settles an agency's share with "The agent's voucher":
 * a PaymentRecord IN with method VOUCHER, which counts as paid on the guest's bill. The agency still
 * owes the hotel that money. This service keeps the second half: whether the agency has paid it.
 *
 * ⚠️ MONEY. Recording the agency's money is NOT a payment on the guest's bill. The voucher already
 * counted there; a second PaymentRecord would count the same money twice and push the bill below zero.
 * So it writes a `VoucherCollection` row beside the voucher, and nothing on the folio moves. Its amount
 * is the voucher's own, copied, and the money audit checks they agree (A18).
 */
import { randomUUID } from "node:crypto";
import type { ActorLevel, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { sumMoney, toDecimal } from "../../lib/money.js";
import { cleanPaymentBank } from "../../lib/payment-bank.js";
import { hotelCalendarYmd } from "../../lib/stay-dates.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";

type Actor = { actorId: string; actorLevel: ActorLevel };

/** How an agency can pay the hotel for its vouchers. */
export const VOUCHER_COLLECTION_METHODS = ["CASH", "CARD", "MOBILE_PAYMENT", "BANK_TRANSFER", "INWARD_REMITTANCE"] as const;
export type VoucherCollectionMethod = (typeof VOUCHER_COLLECTION_METHODS)[number];

const voucherWhere = { paymentMethod: "VOUCHER", paymentDirection: "IN" as const, tripTransferRef: null };

const voucherSelect = {
  id: true,
  amount: true,
  currency: true,
  receivedAt: true,
  createdAt: true,
  stage: true,
  folioId: true,
  entryId: true,
  voucherCollection: true,
  folio: {
    select: {
      entry: {
        select: {
          id: true,
          inquiryId: true,
          status: true,
          currentStage: true,
          checkInDate: true,
          checkOutDate: true,
          guestProfile: { select: { title: true, firstName: true, lastName: true } },
          inquiry: {
            select: {
              travelAgent: { select: { id: true, displayName: true } },
              corporateAccount: { select: { id: true, displayName: true } },
            },
          },
        },
      },
    },
  },
} as const;

type VoucherPaymentRow = Awaited<ReturnType<typeof loadVouchers>>[number];

async function loadVouchers(prisma: PrismaClient, ids?: string[]) {
  return prisma.paymentRecord.findMany({
    where: { ...voucherWhere, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
    select: voucherSelect,
  });
}

function partyOf(p: VoucherPaymentRow) {
  const inq = p.folio?.entry?.inquiry;
  if (inq?.travelAgent) return { kind: "TRAVEL_AGENT" as const, id: inq.travelAgent.id, name: inq.travelAgent.displayName };
  if (inq?.corporateAccount) return { kind: "CORPORATE" as const, id: inq.corporateAccount.id, name: inq.corporateAccount.displayName };
  return { kind: null, id: null, name: null };
}

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const num = (v: unknown) => Number(toDecimal(v as never).toFixed(2));

/**
 * Every voucher taken at check-out, with whether the agency's money for it has come in.
 * `view`: OPEN (not received yet), RECEIVED, or ALL. The totals are over every voucher, whatever
 * the view, so the tab can say how much is still to come.
 */
export async function listVouchers(prisma: PrismaClient, view: "OPEN" | "RECEIVED" | "ALL" = "OPEN") {
  const all = await loadVouchers(prisma);
  const staffIds = [...new Set(all.map((p) => p.voucherCollection?.recordedBy).filter((x): x is string => !!x))];
  const staff = staffIds.length ? await prisma.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, fullName: true } }) : [];
  const staffName = new Map(staff.map((s) => [s.id, s.fullName]));
  const batchIds = [...new Set(all.map((p) => p.voucherCollection?.batchId).filter((x): x is string => !!x))];
  const batchRows = all.filter((p) => p.voucherCollection && batchIds.includes(p.voucherCollection.batchId));
  const batchOf = new Map<string, { count: number; total: number }>();
  for (const b of batchIds) {
    const inBatch = batchRows.filter((p) => p.voucherCollection!.batchId === b);
    batchOf.set(b, { count: inBatch.length, total: num(sumMoney(inBatch.map((p) => p.voucherCollection!.amount))) });
  }

  const rows = all.map((p) => {
    const e = p.folio?.entry ?? null;
    const c = p.voucherCollection;
    return {
      paymentId: p.id,
      amount: num(p.amount),
      currency: p.currency || "BTN",
      takenAt: (p.receivedAt ?? p.createdAt).toISOString(),
      stage: p.stage,
      booking: e
        ? {
            entryId: e.id,
            inquiryId: e.inquiryId,
            guestName: guestDisplayName(e.guestProfile) || "Guest",
            checkIn: ymd(e.checkInDate),
            checkOut: ymd(e.checkOutDate),
            status: e.status,
            stage: e.currentStage,
          }
        : null,
      party: partyOf(p),
      received: c
        ? {
            receivedOn: ymd(c.receivedOn)!,
            paymentMethod: c.paymentMethod,
            bankName: c.bankName,
            journalNumber: c.journalNumber,
            reference: c.reference,
            notes: c.notes,
            batchId: c.batchId,
            batch: batchOf.get(c.batchId) ?? { count: 1, total: num(c.amount) },
            recordedBy: staffName.get(c.recordedBy) ?? c.recordedBy,
            recordedAt: c.recordedAt.toISOString(),
          }
        : null,
    };
  });

  const open = rows.filter((r) => !r.received);
  const received = rows.filter((r) => r.received);
  const byPartyMap = new Map<string, { partyId: string | null; name: string; openCount: number; openAmounts: number[] }>();
  for (const r of open) {
    const key = r.party.id ?? "none";
    const cur = byPartyMap.get(key) ?? { partyId: r.party.id, name: r.party.name ?? "No agency on the booking", openCount: 0, openAmounts: [] };
    cur.openCount += 1;
    cur.openAmounts.push(r.amount);
    byPartyMap.set(key, cur);
  }
  const byParty = [...byPartyMap.values()]
    .map((b) => ({ partyId: b.partyId, name: b.name, openCount: b.openCount, openAmount: num(sumMoney(b.openAmounts)) }))
    .sort((a, b) => b.openAmount - a.openAmount || a.name.localeCompare(b.name));

  return {
    items: view === "OPEN" ? open : view === "RECEIVED" ? received : rows,
    totals: {
      open: { count: open.length, amount: num(sumMoney(open.map((r) => r.amount))) },
      received: { count: received.length, amount: num(sumMoney(received.map((r) => r.amount))) },
      byParty,
    },
  };
}

export type RecordVoucherMoneyInput = {
  paymentIds: string[];
  /** "YYYY-MM-DD", the hotel's calendar. */
  receivedOn: string;
  paymentMethod: string;
  bankName?: string | null;
  journalNumber?: string | null;
  reference?: string | null;
  notes?: string | null;
};

/** The vouchers ticked: each a voucher, none received yet, one agency's. Writes nothing. */
async function planVouchers(prisma: PrismaClient, paymentIds: string[]) {
  const ids = [...new Set((paymentIds ?? []).map((x) => x.trim()).filter(Boolean))];
  if (!ids.length) throw new ValidationError("Tick the vouchers the agency paid for");
  if (ids.length > 200) throw new ValidationError("At most 200 vouchers at a time");
  const found = await loadVouchers(prisma, ids);
  const missing = ids.filter((id) => !found.some((p) => p.id === id));
  if (missing.length) throw new NotFoundError(`Voucher ${missing.join(", ")}`);
  const done = found.filter((p) => p.voucherCollection);
  if (done.length) {
    throw new ValidationError(
      `The money for ${done.map((p) => p.id).join(", ")} is already recorded as received — untick ${done.length === 1 ? "it" : "them"}`,
    );
  }
  const parties = new Set(found.map((p) => partyOf(p).id ?? "none"));
  if (parties.size > 1) {
    throw new ValidationError("These vouchers are from different agencies — record each agency's payment on its own");
  }
  return { found, party: partyOf(found[0]), total: num(sumMoney(found.map((p) => p.amount))) };
}

/** Check what the desk asked for, and work out the batch, writing nothing. */
async function planRecord(prisma: PrismaClient, input: RecordVoucherMoneyInput) {
  const { found, party, total } = await planVouchers(prisma, input.paymentIds);

  const method = (input.paymentMethod ?? "").trim().toUpperCase();
  if (!(VOUCHER_COLLECTION_METHODS as readonly string[]).includes(method)) {
    throw new ValidationError("Pick how the agency paid — cash, card, QR, bank transfer or inward remittance");
  }
  const bank = await cleanPaymentBank(prisma, { method, bankName: input.bankName, journalNumber: input.journalNumber });
  const reference = method === "CASH" ? (input.reference ?? "").trim() : "";
  if (method === "CASH" && !reference) throw new ValidationError("Type the cash receipt's number");
  if (reference.length > 80) throw new ValidationError("A receipt number is at most 80 characters");

  const day = (input.receivedOn ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new ValidationError("Pick the day the agency's money came in");
  }
  if (day > hotelCalendarYmd()) throw new ValidationError("The day the money came in can't be after today");
  const earliest = found.map((p) => ymd(p.receivedAt ?? p.createdAt)!).sort()[0];
  if (earliest && day < earliest) {
    throw new ValidationError(`The money can't have come in before the voucher was taken (${earliest})`);
  }
  const notes = (input.notes ?? "").trim() || null;
  return { found, method, bank, reference: reference || null, notes, day, party, total };
}

/** The vouchers ticked — how many, whose, and what they come to. Nothing is written. */
export async function previewVoucherMoney(prisma: PrismaClient, input: { paymentIds: string[] }) {
  const plan = await planVouchers(prisma, input.paymentIds);
  return { count: plan.found.length, total: plan.total, party: plan.party, currency: plan.found[0]?.currency || "BTN" };
}

/**
 * Record that the agency paid the hotel for these vouchers: one row each, one batch. Every voucher
 * must be the same agency's and not yet received. Nothing on any guest's bill moves.
 */
export async function recordVoucherMoney(prisma: PrismaClient, actor: Actor, input: RecordVoucherMoneyInput) {
  const plan = await planRecord(prisma, input);
  const batchId = randomUUID();
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const p of plan.found) {
      await tx.voucherCollection.create({
        data: {
          paymentRecordId: p.id,
          folioId: p.folioId,
          entryId: p.entryId ?? p.folio?.entry?.id ?? null,
          amount: p.amount,
          receivedOn: new Date(`${plan.day}T00:00:00.000Z`),
          paymentMethod: plan.method,
          bankName: plan.bank.bankName,
          journalNumber: plan.bank.journalNumber,
          reference: plan.reference,
          notes: plan.notes,
          batchId,
          recordedBy: actor.actorId,
        },
      });
      const e = p.folio?.entry;
      await tx.traceEvent.create({
        data: {
          eventType: "VOUCHER.MONEY_RECEIVED",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "PaymentRecord",
          entityId: p.id,
          operation: "CREATE",
          timestamp: now,
          inquiryId: e?.inquiryId ?? null,
          entryId: e?.id ?? null,
          payload: {
            paymentId: p.id,
            amount: num(p.amount),
            party: plan.party.name,
            receivedOn: plan.day,
            paymentMethod: plan.method,
            bankName: plan.bank.bankName,
            journalNumber: plan.bank.journalNumber,
            reference: plan.reference,
            batchId,
            batchCount: plan.found.length,
            batchTotal: plan.total,
          },
          createdBy: actor.actorId,
        },
      });
    }
  });
  return { batchId, count: plan.found.length, total: plan.total, party: plan.party };
}

/** Take back a voucher's money recorded by mistake (the FOM, with a reason). The trace keeps the row. */
export async function undoVoucherMoney(prisma: PrismaClient, actor: Actor, paymentId: string, reason: string) {
  const why = (reason ?? "").trim();
  if (!why) throw new ValidationError("Say why it is taken back");
  const row = await prisma.voucherCollection.findUnique({
    where: { paymentRecordId: paymentId },
    include: { paymentRecord: { select: { folio: { select: { entry: { select: { id: true, inquiryId: true } } } } } } },
  });
  if (!row) throw new NotFoundError("Money recorded for this voucher");
  const e = row.paymentRecord.folio?.entry ?? null;
  await prisma.$transaction(async (tx) => {
    await tx.voucherCollection.delete({ where: { id: row.id } });
    await tx.traceEvent.create({
      data: {
        eventType: "VOUCHER.MONEY_RECEIVED_UNDONE",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "PaymentRecord",
        entityId: paymentId,
        operation: "DELETE",
        inquiryId: e?.inquiryId ?? null,
        entryId: e?.id ?? null,
        payload: {
          reason: why,
          row: {
            paymentId,
            amount: num(row.amount),
            receivedOn: ymd(row.receivedOn),
            paymentMethod: row.paymentMethod,
            bankName: row.bankName,
            journalNumber: row.journalNumber,
            reference: row.reference,
            notes: row.notes,
            batchId: row.batchId,
            recordedBy: row.recordedBy,
            recordedAt: row.recordedAt.toISOString(),
          },
        },
        createdBy: actor.actorId,
      },
    });
  });
  return { paymentId, undone: true };
}
