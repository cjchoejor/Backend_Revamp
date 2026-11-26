/**
 * The front desk asks the FOM to correct a charge on a settled bill (2026-11-26, operator: "if front
 * desk wants to do it, it should like ask the FOM for permission from FOM, GM or admin and then they
 * approve it from notification or do it by themselves, like how we handle other cases like this").
 *
 * ⚠️ Money. Correcting a charge once a share of the bill is settled is the FOM's (ruling the same
 * day). The desk names the charge, the new figure and why:
 *
 *   REQUESTED → APPROVED (the FOM's approval posts the correction itself — `correctCharge`, in the
 *                         same transaction that marks the request approved, so the two cannot
 *                         disagree; what follows is settled-correction-service's)
 *             → REJECTED (the FOM's words, which the desk reads)
 *             → WITHDRAWN (the desk takes it back)
 *
 * The request shows in the FOM's and GM's bell (`attentionItems` reads it off the desk list) and in
 * Alerts sent (the NOTIFICATION trace). Nothing here moves money until the FOM approves.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { classifyFolioLine, CORRECTION_LINE_PREFIX } from "../../lib/folio-tax-lines.js";
import { round2, toDecimal } from "../../lib/money.js";
import { correctCharge } from "./s7-folio-lines-service.js";
import { SETTLED_FOLIO_STATES } from "./settled-correction-service.js";

type Db = PrismaClient;
type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };
const isFom = (l: string) => l === "L2" || l === "L3" || l === "L4";

async function loadEntry(prisma: Db, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, inquiryId: true, status: true, currentStage: true, folio: { select: { id: true, state: true } } },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

/** The charge as it stands now: the original and every earlier correction of it. */
async function chargeNow(prisma: Db | Prisma.TransactionClient, folioId: string, lineId: string) {
  const line = await prisma.folioLine.findUnique({
    where: { id: lineId },
    select: { id: true, folioId: true, lineType: true, description: true, amount: true, chargeDate: true, room: { select: { roomNumber: true } }, space: { select: { name: true } } },
  });
  if (!line || line.folioId !== folioId) return null;
  const earlier = await prisma.folioLine.aggregate({ where: { folioId, description: { startsWith: `${CORRECTION_LINE_PREFIX}${line.id}:` } }, _sum: { amount: true } });
  return { line, net: round2(toDecimal(line.amount).add(toDecimal(earlier._sum.amount))) };
}

function refuseUnlessCorrectable(entry: Awaited<ReturnType<typeof loadEntry>>) {
  if (entry.status !== "ACTIVE") throw new PolicyGateBlockedError("ENTRY_SEALED_READ_ONLY", "This booking is closed and sealed — its bill is read-only");
  if (entry.currentStage !== "S8" && entry.currentStage !== "S9") throw new ValidationError("A settled bill is corrected at Check-out or on the Closed step");
  if (!entry.folio) throw new ValidationError("There is no bill on this booking");
  if (entry.folio.state === "LIVE") throw new ValidationError("The bill is still open — correct the charge yourself, from Charges");
  if (!SETTLED_FOLIO_STATES.has(entry.folio.state)) throw new ValidationError("This bill can no longer be corrected");
}

/** Where the asks stand on this booking: those waiting, and the FOM's latest answer. */
export async function readChargeCorrections(prisma: Db, entryId: string) {
  const entry = await loadEntry(prisma, entryId);
  const rows = await prisma.chargeCorrectionRequest.findMany({ where: { entryId }, orderBy: { requestedAt: "desc" }, take: 10 });
  const staffIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((x): x is string => !!x))];
  const staff = staffIds.length ? await prisma.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, fullName: true } }) : [];
  const name = new Map(staff.map((s) => [s.id, s.fullName]));
  const shaped = [];
  for (const r of rows) {
    const now = entry.folio ? await chargeNow(prisma, entry.folio.id, r.originalLineId) : null;
    const netAfter = r.mode === "SET_NET" ? toDecimal(r.value) : toDecimal(r.netBefore).add(toDecimal(r.value));
    shaped.push({
      id: r.id,
      status: r.status as "REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN",
      originalLineId: r.originalLineId,
      charge: now
        ? { description: now.line.description, chargeDate: now.line.chargeDate.toISOString(), where: now.line.room?.roomNumber ? `Room ${now.line.room.roomNumber}` : (now.line.space?.name ?? null), netNow: Number(now.net.toFixed(2)) }
        : null,
      mode: r.mode as "ADJUST" | "SET_NET",
      value: Number(toDecimal(r.value).toFixed(2)),
      netBefore: Number(toDecimal(r.netBefore).toFixed(2)),
      netAfter: Number(round2(netAfter).toFixed(2)),
      reason: r.reason,
      requestedAt: r.requestedAt.toISOString(),
      requestedByName: name.get(r.requestedBy) ?? r.requestedBy,
      decisionNote: r.decisionNote,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decidedByName: r.decidedBy ? name.get(r.decidedBy) ?? r.decidedBy : null,
      outcome: r.outcome ?? null,
    });
  }
  const open = shaped.filter((r) => r.status === "REQUESTED");
  let mayAsk = false;
  try {
    refuseUnlessCorrectable(entry);
    mayAsk = true;
  } catch {
    mayAsk = false;
  }
  return { open, latest: open.length ? null : shaped.find((r) => r.status === "APPROVED" || r.status === "REJECTED") ?? null, requests: shaped, mayAsk };
}

/** The desk asks: the charge, the new figure (a change or the net it becomes), and why. */
export async function askChargeCorrection(
  prisma: Db,
  actor: Actor,
  input: { entryId: string; originalLineId: string; mode: "ADJUST" | "SET_NET"; value: number; reason: string },
) {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Say why the charge is wrong — the FOM reads it");
  const entry = await loadEntry(prisma, input.entryId);
  refuseUnlessCorrectable(entry);
  const now = await chargeNow(prisma, entry.folio!.id, input.originalLineId);
  if (!now) throw new ValidationError("That charge is not on this bill");
  if (classifyFolioLine(now.line) !== "CHARGE" || now.line.description.startsWith(CORRECTION_LINE_PREFIX)) {
    throw new ValidationError("Pick the charge itself, not its service charge, GST or an earlier correction");
  }
  const value = toDecimal(input.value);
  if (!value.isFinite()) throw new ValidationError("Type the amount");
  if (input.mode === "ADJUST" && value.isZero()) throw new ValidationError("A change of nothing changes nothing");
  if (input.mode === "SET_NET" && value.lt(0)) throw new ValidationError("A charge's net cannot go below zero");
  if (input.mode === "SET_NET" && value.eq(now.net)) throw new ValidationError(`The charge already reads ${now.net.toFixed(2)}`);
  const waiting = await prisma.chargeCorrectionRequest.findFirst({ where: { entryId: entry.id, originalLineId: now.line.id, status: "REQUESTED" }, select: { id: true } });
  if (waiting) throw new PolicyGateBlockedError("ALREADY_ASKED", "The FOM has already been asked about this charge — wait for their answer, or take the request back");

  const at = new Date();
  await prisma.$transaction(async (tx) => {
    const created = await tx.chargeCorrectionRequest.create({
      data: {
        entryId: entry.id,
        folioId: entry.folio!.id,
        originalLineId: now.line.id,
        mode: input.mode,
        value: round2(value),
        netBefore: now.net,
        reason,
        requestedBy: actor.actorId,
        requestedLevel: actor.actorLevel,
        requestedAt: at,
      },
      select: { id: true },
    });
    const netAfter = input.mode === "SET_NET" ? round2(value) : round2(now.net.add(value));
    const payload = {
      entryId: entry.id,
      requestId: created.id,
      lineId: now.line.id,
      charge: now.line.description,
      netBefore: now.net.toFixed(2),
      netAfter: netAfter.toFixed(2),
      reason,
    };
    await tx.traceEvent.create({
      data: {
        eventType: "CHARGE_CORRECTION.REQUESTED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "ChargeCorrectionRequest",
        entityId: created.id,
        operation: "CREATE",
        timestamp: at,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload,
        createdBy: actor.actorId,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "NOTIFICATION.CHARGE_CORRECTION_REQUESTED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "ChargeCorrectionRequest",
        entityId: created.id,
        operation: "NOTIFY",
        timestamp: at,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { ...payload, targets: ["FOM", "GM"], dispatchedAt: at.toISOString() },
        createdBy: "SYSTEM",
      },
    });
  });
  return readChargeCorrections(prisma, input.entryId);
}

/** The desk takes its own request back before the FOM answers. */
export async function withdrawChargeCorrection(prisma: Db, actor: Actor, input: { entryId: string; requestId: string }) {
  const row = await prisma.chargeCorrectionRequest.findUnique({ where: { id: input.requestId }, select: { id: true, entryId: true, status: true } });
  if (!row || row.entryId !== input.entryId) throw new NotFoundError("ChargeCorrectionRequest");
  if (row.status !== "REQUESTED") throw new PolicyGateBlockedError("NOT_OPEN", "This request has already been answered");
  const entry = await loadEntry(prisma, input.entryId);
  const at = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.chargeCorrectionRequest.update({
      where: { id: row.id },
      data: { status: "WITHDRAWN", decisionNote: "Taken back by the desk", decidedBy: actor.actorId, decidedLevel: actor.actorLevel, decidedAt: at },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "CHARGE_CORRECTION.WITHDRAWN",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "ChargeCorrectionRequest",
        entityId: row.id,
        operation: "UPDATE",
        timestamp: at,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { entryId: entry.id, requestId: row.id },
        createdBy: actor.actorId,
      },
    });
  });
  return readChargeCorrections(prisma, input.entryId);
}

/**
 * The FOM decides (L2+). Approving posts the correction (with its service charge and GST, on the
 * charge's own payer, and everything that follows on a settled bill); turning it down needs words.
 */
export async function decideChargeCorrection(
  prisma: Db,
  actor: Actor,
  input: { entryId: string; requestId: string; decision: "APPROVE" | "REJECT"; note?: string | null },
) {
  if (!isFom(actor.actorLevel)) {
    throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "Correcting a charge once a share is settled is the FOM's — an FOM, the GM or an admin decides it");
  }
  const row = await prisma.chargeCorrectionRequest.findUnique({ where: { id: input.requestId } });
  if (!row || row.entryId !== input.entryId) throw new NotFoundError("ChargeCorrectionRequest");
  if (row.status !== "REQUESTED") throw new PolicyGateBlockedError("NOT_OPEN", "This request has already been answered, or was taken back");
  const entry = await loadEntry(prisma, input.entryId);
  const note = input.note?.trim() || null;
  const at = new Date();

  if (input.decision === "REJECT") {
    if (!note) throw new ValidationError("Say why — the desk reads it");
    await prisma.$transaction(async (tx) => {
      await tx.chargeCorrectionRequest.update({
        where: { id: row.id },
        data: { status: "REJECTED", decisionNote: note, decidedBy: actor.actorId, decidedLevel: actor.actorLevel, decidedAt: at },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "CHARGE_CORRECTION.REJECTED",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "ChargeCorrectionRequest",
          entityId: row.id,
          operation: "UPDATE",
          timestamp: at,
          stageContext: entry.currentStage,
          inquiryId: entry.inquiryId,
          entryId: entry.id,
          payload: { entryId: entry.id, requestId: row.id, note },
          createdBy: actor.actorId,
        },
      });
    });
    return { standing: await readChargeCorrections(prisma, input.entryId), outcome: null };
  }

  // APPROVE — the correction itself, marked approved in its own transaction.
  refuseUnlessCorrectable(entry);
  const body = {
    entryId: entry.id,
    originalFolioLineId: row.originalLineId,
    reason: row.reason,
    correctionDate: at.toISOString(),
    ...(row.mode === "SET_NET" ? { correctToAmount: Number(toDecimal(row.value).toFixed(2)) } : { correctionAmount: Number(toDecimal(row.value).toFixed(2)) }),
  };
  const posted = await correctCharge(prisma, entry.folio!.id, actor.actorId, body, {
    actorLevel: actor.actorLevel,
    onPostedTx: async (tx, line, outcome) => {
      const done = await tx.chargeCorrectionRequest.updateMany({
        where: { id: row.id, status: "REQUESTED" },
        data: {
          status: "APPROVED",
          decisionNote: note,
          decidedBy: actor.actorId,
          decidedLevel: actor.actorLevel,
          decidedAt: at,
          correctionLineId: line.id,
          outcome: (outcome ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
      if (done.count !== 1) throw new PolicyGateBlockedError("NOT_OPEN", "This request was answered on another screen meanwhile");
      await tx.traceEvent.create({
        data: {
          eventType: "CHARGE_CORRECTION.APPROVED",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "ChargeCorrectionRequest",
          entityId: row.id,
          operation: "UPDATE",
          timestamp: at,
          stageContext: entry.currentStage,
          inquiryId: entry.inquiryId,
          entryId: entry.id,
          payload: { entryId: entry.id, requestId: row.id, correctionLineId: line.id, note },
          createdBy: actor.actorId,
        },
      });
    },
  });
  const outcome = (posted as { afterSettlement?: unknown }).afterSettlement ?? null;
  return { standing: await readChargeCorrections(prisma, input.entryId), outcome };
}
