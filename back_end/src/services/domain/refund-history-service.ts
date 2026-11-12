/**
 * Refunds made (2026-11-12, operator: "this refunds section should be showing the list of refunds made
 * to a booking … a column can show the total refund made to that booking, when clicked on it, it can
 * show which refunds were made, when, at what stage, reason if there is, by who").
 *
 * ⚠️ Money, read only. A refund is a money-out row on a booking's bill (`PaymentRecord`, direction OUT)
 * — written by a cancellation, a no-show, money paid above the bill given back, or a waiting refund
 * recorded. Money moved between a trip's stays is also a money-out row, but it is not a refund: it
 * stays the hotel's, on another stay's bill (`tripTransferRef`). It is left out of the refunds and
 * reported beside them, so a booking's figures still reconcile with its bill's "refunded".
 *
 * Every total here is summed in Decimal; the desk adds nothing.
 */
import type { PrismaClient } from "@prisma/client";
import { PaymentDirection, Prisma } from "@prisma/client";
import { guestDisplayName } from "../../lib/guest-display-name.js";
import { toDecimal } from "../../lib/money.js";

/** Why the money went back, as one kind. */
export type RefundKind = "CANCELLED" | "NO_SHOW" | "PAID_OVER" | "REQUEST" | "OTHER";

const REQUEST_CAUSE_WORDS: Record<string, string> = {
  RENEGOTIATED: "An advance paid at an earlier price",
  LAPSED: "The booking lapsed while it held this money",
};

const money2 = (d: Prisma.Decimal) => Number(d.toFixed(2));
const ending = (account: string | null) => (account ? account.replace(/\s+/g, "").slice(-4) : null);

export async function listRefundsMade(prisma: PrismaClient) {
  const outs = await prisma.paymentRecord.findMany({
    where: { paymentDirection: PaymentDirection.OUT },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      entryId: true,
      folioId: true,
      amount: true,
      currency: true,
      paymentMethod: true,
      stage: true,
      notes: true,
      recordedBy: true,
      createdAt: true,
      receivedAt: true,
      tripTransferRef: true,
      folio: { select: { entryId: true } },
    },
  });
  const refunds = outs.filter((p) => !p.tripTransferRef);
  const moves = outs.filter((p) => !!p.tripTransferRef);
  const entryIdOf = (p: (typeof outs)[number]) => p.entryId ?? p.folio.entryId;
  const entryIds = [...new Set(refunds.map(entryIdOf).filter((x): x is string => !!x))];
  if (!entryIds.length) return { bookings: [], totals: { bookings: 0, refunds: 0, amount: 0, currency: "BTN" } };

  const [entries, requests, traces] = await Promise.all([
    prisma.entry.findMany({
      where: { id: { in: entryIds } },
      select: {
        id: true,
        inquiryId: true,
        status: true,
        currentStage: true,
        closedAs: true,
        closedReason: true,
        checkInDate: true,
        checkOutDate: true,
        actualCheckOutDate: true,
        contactPersonName: true,
        guestProfile: { select: { title: true, firstName: true, lastName: true } },
        inquiry: {
          select: {
            callerTitle: true,
            callerFirstName: true,
            callerLastName: true,
            travelAgent: { select: { displayName: true } },
            corporateAccount: { select: { displayName: true } },
          },
        },
      },
    }),
    prisma.refundRequest.findMany({
      where: { paymentRecordId: { in: refunds.map((r) => r.id) } },
      select: { id: true, paymentRecordId: true, cause: true, note: true, closeNote: true, bankName: true, accountNumber: true, journalNumber: true },
    }),
    prisma.traceEvent.findMany({
      where: { eventType: "FOLIO.REFUND_RECORDED", entryId: { in: entryIds } },
      select: { payload: true },
    }),
  ]);
  const entryOf = new Map(entries.map((e) => [e.id, e]));
  const requestOf = new Map(requests.map((r) => [r.paymentRecordId!, r]));
  // A refund of money paid above the bill keeps its reason and reference on its record's trace.
  const paidOverOf = new Map<string, { reason: string | null; reference: string | null }>();
  for (const t of traces) {
    const p = (t.payload ?? {}) as { paymentId?: string; reason?: string; reference?: string | null };
    if (p.paymentId) paidOverOf.set(p.paymentId, { reason: p.reason ?? null, reference: p.reference ?? null });
  }
  const staffIds = [...new Set(refunds.map((r) => r.recordedBy).filter((x): x is string => !!x && x !== "SYSTEM"))];
  const staff = staffIds.length ? await prisma.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, title: true, fullName: true, username: true } }) : [];
  const nameOf = new Map(staff.map((s) => [s.id, [s.title, s.fullName].filter(Boolean).join(" ") || s.username]));
  const person = (id: string | null) => (!id ? null : id === "SYSTEM" ? "The system" : (nameOf.get(id) ?? null));

  const describe = (r: (typeof refunds)[number], e: (typeof entries)[number] | undefined) => {
    const notes = r.notes ?? "";
    const req = requestOf.get(r.id);
    if (req) {
      return {
        kind: "REQUEST" as RefundKind,
        why: REQUEST_CAUSE_WORDS[req.cause] ?? "Money waiting to go back",
        reason: req.closeNote ?? req.note ?? null,
        reference: req.journalNumber ? `Journal ${req.journalNumber}` : null,
        bank: req.bankName ? [req.bankName, ending(req.accountNumber) ? `account ending ${ending(req.accountNumber)}` : null].filter(Boolean).join(" · ") : null,
        requestId: req.id,
      };
    }
    if (notes.startsWith("Refund obligation after")) {
      const ref = notes.includes(" · ") ? notes.slice(notes.indexOf(" · ") + 3).trim() : null;
      const atCheckIn = notes.includes("check-in");
      return {
        kind: "CANCELLED" as RefundKind,
        why: atCheckIn ? "Cancelled at check-in" : "Booking cancelled",
        reason: e?.closedReason ?? null,
        reference: ref || null,
        bank: null,
        requestId: null,
      };
    }
    if (notes.startsWith("NO_SHOW_REFUND")) {
      return { kind: "NO_SHOW" as RefundKind, why: "No-show: what was paid beyond the charge", reason: null, reference: null, bank: null, requestId: null };
    }
    if (notes.startsWith("REFUND:")) {
      const t = paidOverOf.get(r.id);
      return {
        kind: "PAID_OVER" as RefundKind,
        why: "Paid more than the bill",
        reason: t?.reason ?? (notes.slice("REFUND:".length).split(":")[0] || null),
        reference: t?.reference ?? null,
        bank: null,
        requestId: null,
      };
    }
    return { kind: "OTHER" as RefundKind, why: "Refund", reason: notes || null, reference: null, bank: null, requestId: null };
  };

  const byEntry = new Map<string, typeof refunds>();
  for (const r of refunds) {
    const id = entryIdOf(r);
    if (!id) continue;
    byEntry.set(id, [...(byEntry.get(id) ?? []), r]);
  }

  let all = new Prisma.Decimal(0);
  const bookings = [...byEntry.entries()].map(([entryId, rows]) => {
    const e = entryOf.get(entryId);
    const total = rows.reduce((s, r) => s.add(toDecimal(r.amount)), new Prisma.Decimal(0));
    all = all.add(total);
    const moved = moves
      .filter((m) => entryIdOf(m) === entryId)
      .reduce((s, m) => s.add(toDecimal(m.amount)), new Prisma.Decimal(0));
    const inq = e?.inquiry;
    const callerName = [inq?.callerTitle, inq?.callerFirstName, inq?.callerLastName].filter(Boolean).join(" ");
    const last = rows.reduce((d, r) => {
      const at = r.receivedAt ?? r.createdAt;
      return at > d ? at : d;
    }, new Date(0));
    return {
      entryId,
      inquiryId: e?.inquiryId ?? null,
      guestName: (e && (guestDisplayName(e.guestProfile) || callerName || e.contactPersonName)) || null,
      party: inq?.travelAgent?.displayName ?? inq?.corporateAccount?.displayName ?? null,
      status: e?.status ?? null,
      stage: e?.currentStage ?? null,
      closedAs: e?.closedAs ?? null,
      checkInDate: e?.checkInDate?.toISOString() ?? null,
      checkOutDate: (e?.actualCheckOutDate ?? e?.checkOutDate)?.toISOString() ?? null,
      currency: rows[0]?.currency ?? "BTN",
      total: money2(total),
      count: rows.length,
      lastAt: last.toISOString(),
      /** Money moved from this stay's bill to another stay of the trip: the hotel's still, not a refund. */
      movedToTrip: moved.gt(0) ? money2(moved) : null,
      refunds: rows
        .map((r) => {
          const d = describe(r, e);
          return {
            id: r.id,
            amount: money2(toDecimal(r.amount)),
            currency: r.currency,
            at: (r.receivedAt ?? r.createdAt).toISOString(),
            stage: r.stage,
            method: r.paymentMethod,
            by: person(r.recordedBy),
            ...d,
          };
        })
        .sort((a, b) => b.at.localeCompare(a.at)),
    };
  });
  bookings.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return {
    bookings,
    totals: { bookings: bookings.length, refunds: refunds.filter((r) => !!entryIdOf(r)).length, amount: money2(all), currency: bookings[0]?.currency ?? "BTN" },
  };
}
