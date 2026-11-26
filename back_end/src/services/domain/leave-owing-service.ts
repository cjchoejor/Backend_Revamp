/**
 * Leaving owing at Check-out, asked of the FOM (2026-11-26, operator: "when such things where fom or
 * other person needs to approve, does it pop up on the fom and gm's page, and how do they approve
 * it" — then "okay do it").
 *
 * The front desk may not let a guest leave with part of the bill unpaid: that is the FOM's call
 * (Policy 46 — the FOM settles it, or a credit extension covers what is left). Until now the desk
 * could only fetch the FOM to the counter. Now it asks, with what the guest said:
 *
 *   REQUESTED → APPROVED (the FOM's credit extension recorded for what the bill still owes)
 *             → REJECTED (with the FOM's words, which the desk reads)
 *             → WITHDRAWN (the desk takes it back, or the bill was settled meanwhile)
 *
 * The request shows in the FOM's and GM's bell and on Notifications (`attentionItems` reads it off
 * the desk list), and the "Alerts sent" feed reads its NOTIFICATION trace. Approving it is the same
 * credit extension the FOM records by hand (`recordCreditExtensionApproval`) — so the settle card
 * then offers "Settle — leave it owing" to whoever is at the desk. Nothing here moves money.
 */
import { enforceMayApprove } from "../../lib/approval-roles.js";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { round2, toDecimal } from "../../lib/money.js";
import { recordCreditExtensionApproval } from "./s3-payment-service.js";

type Db = PrismaClient;
type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };


const ROW_SELECT = {
  id: true,
  status: true,
  amountOwed: true,
  guestWords: true,
  requestedBy: true,
  requestedLevel: true,
  requestedAt: true,
  decisionNote: true,
  decidedBy: true,
  decidedLevel: true,
  decidedAt: true,
  payBy: true,
  creditExtensionId: true,
} satisfies Prisma.LeaveOwingRequestSelect;

type Row = Prisma.LeaveOwingRequestGetPayload<{ select: typeof ROW_SELECT }>;

async function loadEntry(prisma: Db, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      inquiryId: true,
      status: true,
      currentStage: true,
      folio: { select: { id: true, state: true, outstandingBalance: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

/** Where leaving owing stands on this booking: the balance, the credit on file, the requests. */
export async function readLeaveOwing(prisma: Db, entryId: string) {
  const entry = await loadEntry(prisma, entryId);
  const folio = entry.folio;
  const balance = folio ? Number(round2(toDecimal(folio.outstandingBalance))) : 0;
  const now = Date.now();
  const credit = folio
    ? await prisma.creditExtensionCeilingRecord.findUnique({ where: { folioId: folio.id }, select: { id: true, ceilingAmount: true, expiresAt: true } })
    : null;
  const creditLive = !!credit && (!credit.expiresAt || credit.expiresAt.getTime() > now);
  const creditCovers = creditLive && balance > 0 && toDecimal(credit!.ceilingAmount).gte(balance);
  const rows: Row[] = await prisma.leaveOwingRequest.findMany({ where: { entryId }, orderBy: { requestedAt: "desc" }, take: 6, select: ROW_SELECT });
  const staffIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((x): x is string => !!x))];
  const staff = staffIds.length ? await prisma.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, fullName: true } }) : [];
  const name = new Map(staff.map((s) => [s.id, s.fullName]));
  const shaped = rows.map((r) => ({
    id: r.id,
    status: r.status as "REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN",
    amountOwed: Number(r.amountOwed),
    guestWords: r.guestWords,
    requestedAt: r.requestedAt.toISOString(),
    requestedByName: name.get(r.requestedBy) ?? r.requestedBy,
    decisionNote: r.decisionNote,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decidedByName: r.decidedBy ? name.get(r.decidedBy) ?? r.decidedBy : null,
    payBy: r.payBy?.toISOString() ?? null,
  }));
  const open = shaped.find((r) => r.status === "REQUESTED") ?? null;
  const atCheckout = entry.status === "ACTIVE" && entry.currentStage === "S8" && folio?.state === "LIVE";
  return {
    balance,
    creditLive,
    creditCovers,
    open,
    // The FOM's latest word, once there is no request waiting.
    latest: open ? null : shaped.find((r) => r.status === "APPROVED" || r.status === "REJECTED") ?? null,
    requests: shaped,
    mayAsk: atCheckout && balance > 0 && !open && !creditCovers,
  };
}

function refuseUnlessAtCheckout(entry: Awaited<ReturnType<typeof loadEntry>>) {
  if (entry.status !== "ACTIVE" || entry.currentStage !== "S8") {
    throw new PolicyGateBlockedError("NOT_AT_CHECKOUT", "Leaving owing is asked at Check-out");
  }
  if (!entry.folio || entry.folio.state !== "LIVE") {
    throw new PolicyGateBlockedError("BILL_SETTLED", "The bill is already settled — money still owed is collected on the Closed step");
  }
}

/** The desk asks the FOM, with what the guest said. */
export async function askToLeaveOwing(prisma: Db, actor: Actor, input: { entryId: string; guestWords: string }) {
  const words = input.guestWords?.trim();
  if (!words) throw new ValidationError("Write what the guest said — the FOM reads it");
  const entry = await loadEntry(prisma, input.entryId);
  refuseUnlessAtCheckout(entry);
  const standing = await readLeaveOwing(prisma, input.entryId);
  if (standing.balance <= 0) throw new PolicyGateBlockedError("NOTHING_OWED", "Nothing is owed — the bill can be closed");
  if (standing.creditCovers) {
    throw new PolicyGateBlockedError("ALREADY_COVERED", "A credit extension already covers the balance — settle it, leaving it owing");
  }
  if (standing.open) throw new PolicyGateBlockedError("ALREADY_ASKED", "The FOM has already been asked — wait for their answer, or take the request back");

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const created = await tx.leaveOwingRequest.create({
      data: {
        entryId: entry.id,
        folioId: entry.folio!.id,
        status: "REQUESTED",
        amountOwed: new Prisma.Decimal(standing.balance),
        guestWords: words,
        requestedBy: actor.actorId,
        requestedLevel: actor.actorLevel,
        requestedAt: now,
      },
      select: { id: true },
    });
    const payload = { entryId: entry.id, requestId: created.id, amountOwed: standing.balance, guestWords: words };
    await tx.traceEvent.create({
      data: {
        eventType: "LEAVE_OWING.REQUESTED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "LeaveOwingRequest",
        entityId: created.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload,
        createdBy: actor.actorId,
      },
    });
    // Raised to the FOM, GM and admin — the "Alerts sent" feed reads the NOTIFICATION.* traces.
    await tx.traceEvent.create({
      data: {
        eventType: "NOTIFICATION.LEAVE_OWING_REQUESTED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "LeaveOwingRequest",
        entityId: created.id,
        operation: "NOTIFY",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { ...payload, targets: ["FOM", "GM"], dispatchedAt: now.toISOString() },
        createdBy: "SYSTEM",
      },
    });
  });
  return readLeaveOwing(prisma, input.entryId);
}

/** The desk takes its own request back before the FOM answers. */
export async function withdrawLeaveOwing(prisma: Db, actor: Actor, input: { entryId: string; requestId: string }) {
  const row = await prisma.leaveOwingRequest.findUnique({ where: { id: input.requestId }, select: { id: true, entryId: true, status: true } });
  if (!row || row.entryId !== input.entryId) throw new NotFoundError("LeaveOwingRequest");
  if (row.status !== "REQUESTED") throw new PolicyGateBlockedError("NOT_OPEN", "This request has already been answered");
  const entry = await loadEntry(prisma, input.entryId);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.leaveOwingRequest.update({
      where: { id: row.id },
      data: { status: "WITHDRAWN", decisionNote: "Taken back by the desk", decidedBy: actor.actorId, decidedLevel: actor.actorLevel, decidedAt: now },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "LEAVE_OWING.WITHDRAWN",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "LeaveOwingRequest",
        entityId: row.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { entryId: entry.id, requestId: row.id },
        createdBy: actor.actorId,
      },
    });
  });
  return readLeaveOwing(prisma, input.entryId);
}

/**
 * The FOM decides (L2+). Approving records the FOM's credit extension for what the bill owes now
 * (never lowering one already on the bill), until `payWithinDays` when given; turning it down
 * needs the FOM's words.
 */
export async function decideLeaveOwing(
  prisma: Db,
  actor: Actor,
  input: { entryId: string; requestId: string; decision: "APPROVE" | "REJECT"; note?: string | null; payWithinDays?: number | null },
) {
  // Who decides is the admin console's (2026-11-26, approvals.leaveOwing.roles).
  await enforceMayApprove(prisma as never, "LEAVE_OWING", actor.actorLevel);
  const note = input.note?.trim() || null;
  const entry = await loadEntry(prisma, input.entryId);
  const standing = await readLeaveOwing(prisma, input.entryId);
  if (!standing.open || standing.open.id !== input.requestId) {
    throw new PolicyGateBlockedError("NOT_OPEN", "This request has already been answered, or was taken back");
  }
  const now = new Date();

  if (input.decision === "REJECT") {
    if (!note) throw new ValidationError("Say why — the desk reads it");
    await prisma.$transaction(async (tx) => {
      await tx.leaveOwingRequest.update({
        where: { id: input.requestId },
        data: { status: "REJECTED", decisionNote: note, decidedBy: actor.actorId, decidedLevel: actor.actorLevel, decidedAt: now },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "LEAVE_OWING.REJECTED",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "LeaveOwingRequest",
          entityId: input.requestId,
          operation: "UPDATE",
          timestamp: now,
          stageContext: entry.currentStage,
          inquiryId: entry.inquiryId,
          entryId: entry.id,
          payload: { entryId: entry.id, requestId: input.requestId, note, amountOwed: standing.balance },
          createdBy: actor.actorId,
        },
      });
    });
    return readLeaveOwing(prisma, input.entryId);
  }

  // APPROVE — still at Check-out with the bill open and money owed.
  refuseUnlessAtCheckout(entry);
  if (standing.balance <= 0) throw new PolicyGateBlockedError("NOTHING_OWED", "Nothing is owed — the bill can be closed");
  const days = input.payWithinDays == null ? null : Number(input.payWithinDays);
  if (days != null && (!Number.isFinite(days) || days <= 0 || days > 365)) throw new ValidationError("Pay within is a number of days, 1 to 365");
  const payBy = days ? new Date(now.getTime() + days * 86_400_000) : null;
  const existing = await prisma.creditExtensionCeilingRecord.findUnique({ where: { folioId: entry.folio!.id }, select: { ceilingAmount: true, expiresAt: true } });
  const live = !!existing && (!existing.expiresAt || existing.expiresAt.getTime() > now.getTime());
  const ceiling = live && toDecimal(existing!.ceilingAmount).gt(standing.balance) ? Number(round2(existing!.ceilingAmount)) : standing.balance;
  const words = standing.open.guestWords;
  const rec = await recordCreditExtensionApproval(
    prisma,
    { entryId: entry.id, folioId: entry.folio!.id, ceilingAmount: ceiling, reason: `Leave owing — ${words}${note ? ` — ${note}` : ""}`, validUntil: payBy },
    actor,
  );
  await prisma.$transaction(async (tx) => {
    await tx.leaveOwingRequest.update({
      where: { id: input.requestId },
      data: { status: "APPROVED", decisionNote: note, decidedBy: actor.actorId, decidedLevel: actor.actorLevel, decidedAt: now, payBy, creditExtensionId: rec.id },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "LEAVE_OWING.APPROVED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "LeaveOwingRequest",
        entityId: input.requestId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { entryId: entry.id, requestId: input.requestId, note, amountOwed: standing.balance, ceiling, payBy: payBy?.toISOString() ?? null, creditExtensionId: rec.id },
        createdBy: actor.actorId,
      },
    });
  });
  return readLeaveOwing(prisma, input.entryId);
}

/** A request still waiting when the bill is settled has nothing left to ask. Best-effort. */
export async function closeLeaveOwingOnSettle(prisma: Db, folioId: string, actorId: string) {
  const open = await prisma.leaveOwingRequest.findMany({ where: { folioId, status: "REQUESTED" }, select: { id: true } });
  if (open.length === 0) return 0;
  await prisma.leaveOwingRequest.updateMany({
    where: { id: { in: open.map((o) => o.id) } },
    data: { status: "WITHDRAWN", decisionNote: "The bill was settled", decidedBy: actorId, decidedAt: new Date() },
  });
  return open.length;
}
