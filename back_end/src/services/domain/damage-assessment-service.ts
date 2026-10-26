import { EntryStatus, FolioLineType, FolioState, Stage, type ActorLevel, type Prisma, type PrismaClient } from "@prisma/client";
import { AuthorizationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { readBookingDamages, type BookingDamage } from "../../lib/damage-standing.js";
import { hotelCalendarYmd } from "../../lib/stay-dates.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { chargeTaxFigures, postCharge } from "./s7-folio-lines-service.js";
import { postStayCharge } from "./s9-service.js";

/**
 * Answering a damage found at a room inspection (2026-10-26, operator: "I marked room 304 as
 * damaged, yet nothing appeared on S9 while sealing and closing it — nothing to waive or ask for
 * payment for the damage"). The gates are Policy 81; what stands is lib/damage-standing.ts.
 *
 * - CHARGE: a charge for the damage, posted to the room it was found in, with or without service
 *   charge and GST as the desk chooses (operator ruling) — the choice is recorded on the line so a
 *   later correction moves only the taxes it carries. At Check-out while the bill is open (the
 *   desk's own charge); after departure as a charge after the stay (the FOM's, as every such
 *   charge is).
 * - WAIVE: the FOM's, with the reason — it forgoes money.
 * - LATER: decide after departure — at Check-out only; the booking may leave Check-out, but is not
 *   sealed until the damage is charged or waived.
 *
 * Charged and waived are final: a charge is put right on the bill (a correction or a credit note),
 * not by answering again.
 */

const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
const atLeast = (level: ActorLevel | string | undefined, min: "L1" | "L2") => (RANK[level ?? "L1"] ?? 1) >= RANK[min];

export type DamageWay = { open: boolean; level: "L1" | "L2"; why: string | null };
export type DamageWays = { charge: DamageWay; waive: DamageWay; later: DamageWay };

const shut = (why: string, level: "L1" | "L2" = "L1"): DamageWay => ({ open: false, level, why });
const open = (level: "L1" | "L2"): DamageWay => ({ open: true, level, why: null });

/** Which answers the booking can take now, and whose they are — the same rule the act enforces. */
export function damageWaysFor(entry: { currentStage: Stage; status: EntryStatus }, folioState: FolioState | null): DamageWays {
  if (entry.status === EntryStatus.CLOSED || entry.status === EntryStatus.CANCELLED || entry.status === EntryStatus.EXPIRED) {
    const why = "This booking is sealed — a sealed record is read-only";
    return { charge: shut(why), waive: shut(why, "L2"), later: shut(why) };
  }
  if (entry.currentStage === Stage.S8) {
    return {
      charge:
        folioState === FolioState.LIVE
          ? open("L1")
          : shut("The bill is already settled — charge it after departure, on the Closed step, or waive it"),
      waive: open("L2"),
      later: open("L1"),
    };
  }
  if (entry.currentStage === Stage.S9) {
    return {
      charge:
        folioState === FolioState.NO_SHOW_CLOSED
          ? shut("This booking is a no-show — nothing more is posted to its bill", "L2")
          : open("L2"),
      waive: open("L2"),
      later: shut("The guest has left — charge it or waive it now"),
    };
  }
  const why = "A damage is answered at Check-out or on the Closed step";
  return { charge: shut(why), waive: shut(why, "L2"), later: shut(why) };
}

async function loadEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, inquiryId: true, currentStage: true, status: true, folio: { select: { id: true, state: true } } },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

export async function listBookingDamages(prisma: PrismaClient, entryId: string) {
  const entry = await loadEntry(prisma, entryId);
  const damages = await readBookingDamages(prisma, entryId);
  const lineIds = damages.map((d) => d.folioLineId).filter((x): x is string => !!x);
  const lines = lineIds.length
    ? await prisma.folioLine.findMany({
        where: { id: { in: lineIds } },
        select: { id: true, amount: true, withServiceCharge: true, withGst: true, chargeDate: true },
      })
    : [];
  const byId = new Map(lines.map((l) => [l.id, l]));
  const rates = await resolveChargeRates(prisma);
  return {
    entryId,
    ways: damageWaysFor(entry, entry.folio?.state ?? null),
    rates,
    damages: damages.map((d) => {
      const line = d.folioLineId ? byId.get(d.folioLineId) : undefined;
      return {
        ...d,
        charge: line
          ? {
              folioLineId: line.id,
              amount: line.amount.toFixed(2),
              withServiceCharge: line.withServiceCharge === true,
              withGst: line.withGst === true,
              chargeDate: line.chargeDate.toISOString().slice(0, 10),
            }
          : null,
      };
    }),
  };
}

/** What a damage charge comes to with the taxes chosen — server figures, nothing written. */
export async function previewDamageCharge(prisma: PrismaClient, input: { amount: number; serviceCharge: boolean; gst: boolean }) {
  if (!Number.isFinite(input.amount) || !(input.amount > 0)) throw new ValidationError("Type the damage's charge — an amount above zero");
  const rates = await resolveChargeRates(prisma);
  const f = chargeTaxFigures(input.amount, {
    serviceChargeRate: input.serviceCharge ? rates.serviceChargeRate : 0,
    gstRate: input.gst ? rates.gstRate : 0,
  });
  return {
    amount: f.base.toFixed(2),
    serviceCharge: f.serviceCharge.toFixed(2),
    gst: f.gst.toFixed(2),
    total: f.total.toFixed(2),
    serviceChargeRate: rates.serviceChargeRate,
    gstRate: rates.gstRate,
  };
}

export type DamageAnswerInput =
  | { answer: "CHARGE"; amount: number; serviceCharge: boolean; gst: boolean; description?: string; note?: string }
  | { answer: "WAIVE"; note: string }
  | { answer: "LATER"; note?: string };

const ANSWERED_WORD = { CHARGED: "charged", WAIVED: "waived" } as const;

export async function answerDamage(
  prisma: PrismaClient,
  entryId: string,
  inspectionId: string,
  actor: { actorId: string; actorLevel: ActorLevel },
  input: DamageAnswerInput,
) {
  const entry = await loadEntry(prisma, entryId);
  const damages = await readBookingDamages(prisma, entryId);
  const d = damages.find((x) => x.inspectionId === inspectionId);
  if (!d) throw new ValidationError("That inspection is not a damage standing on this booking — the room may have been inspected again");
  if (d.answer === "CHARGED" || d.answer === "WAIVED") {
    throw new ValidationError(
      `Room ${d.roomNumber}'s damage was already ${ANSWERED_WORD[d.answer]} — a charge is put right on the bill, with a correction or a credit note`,
    );
  }
  const ways = damageWaysFor(entry, entry.folio?.state ?? null);
  const way = input.answer === "CHARGE" ? ways.charge : input.answer === "WAIVE" ? ways.waive : ways.later;
  if (!way.open) throw new ValidationError(way.why ?? "That answer is not open here");
  if (!atLeast(actor.actorLevel, way.level)) {
    throw new AuthorizationError(
      input.answer === "WAIVE" ? "Waiving a damage is the FOM's — it gives up the charge" : "A charge after departure is the FOM's",
    );
  }
  if (input.answer === "LATER" && d.answer === "LATER") throw new ValidationError(`Room ${d.roomNumber}'s damage is already left to decide after departure`);

  const now = new Date();
  // The answer is written once: a second screen answering at the same moment is refused, and with a
  // charge the refusal rolls the charge back too (it runs inside the posting's transaction).
  const writeAnswer = async (
    tx: Prisma.TransactionClient,
    answer: "CHARGED" | "WAIVED" | "LATER",
    extra: { folioLineId?: string; payload?: Record<string, unknown> },
  ) => {
    const n = await tx.roomInspectionRecord.updateMany({
      where: { id: d.inspectionId, OR: [{ damageAnswer: null }, { damageAnswer: "LATER" }] },
      data: {
        damageAnswer: answer,
        damageAnswerNote: input.note?.trim() || null,
        damageAnsweredBy: actor.actorId,
        damageAnsweredAt: now,
        ...(extra.folioLineId ? { damageFolioLineId: extra.folioLineId } : {}),
      },
    });
    if (n.count !== 1) throw new ValidationError(`Room ${d.roomNumber}'s damage was answered on another screen — refresh and look again`);
    await tx.traceEvent.create({
      data: {
        eventType: answer === "CHARGED" ? "ROOM_INSPECTION.DAMAGE_CHARGED" : answer === "WAIVED" ? "ROOM_INSPECTION.DAMAGE_WAIVED" : "ROOM_INSPECTION.DAMAGE_PUT_OFF",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          inspectionId: d.inspectionId,
          roomId: d.roomId,
          roomNumber: d.roomNumber,
          damageNotes: d.damageNotes,
          note: input.note?.trim() || null,
          priorAnswer: d.answer,
          ...(extra.payload ?? {}),
        },
        createdBy: actor.actorId,
      },
    });
  };

  if (input.answer === "WAIVE") {
    if (!input.note?.trim()) throw new ValidationError("Say why the damage is waived — it is recorded on the booking");
    await prisma.$transaction((tx) => writeAnswer(tx, "WAIVED", {}));
  } else if (input.answer === "LATER") {
    await prisma.$transaction((tx) => writeAnswer(tx, "LATER", {}));
  } else {
    if (!Number.isFinite(input.amount) || !(input.amount > 0)) throw new ValidationError("Type the damage's charge — an amount above zero");
    if (typeof input.serviceCharge !== "boolean" || typeof input.gst !== "boolean") {
      throw new ValidationError("Say whether the charge carries service charge and GST");
    }
    if (!entry.folio) throw new NotFoundError("Folio");
    const description = input.description?.trim() || `Damage · Room ${d.roomNumber}${d.damageNotes ? ` — ${d.damageNotes}` : ""}`;
    const taxes = { serviceCharge: input.serviceCharge, gst: input.gst };
    const onPostedTx = (tx: Prisma.TransactionClient, line: { id: string }) =>
      writeAnswer(tx, "CHARGED", {
        folioLineId: line.id,
        payload: { folioLineId: line.id, amount: Number(input.amount).toFixed(2), withServiceCharge: input.serviceCharge, withGst: input.gst },
      });
    if (entry.currentStage === Stage.S8) {
      await postCharge(
        prisma,
        entry.folio.id,
        actor.actorId,
        {
          entryId,
          lineType: FolioLineType.OTHER,
          description,
          amount: Number(input.amount),
          chargeDate: hotelCalendarYmd(now),
          roomId: d.roomId,
          allowSoftGateBypass: atLeast(actor.actorLevel, "L2"),
        },
        { taxes, onPostedTx },
      );
    } else {
      await postStayCharge(
        prisma,
        entry.folio.id,
        actor.actorId,
        { entryId, lineType: FolioLineType.OTHER, description, amount: Number(input.amount), postedAt: now.toISOString(), isPostStay: true },
        { roomId: d.roomId, taxes, onPostedTx },
      );
    }
  }
  return listBookingDamages(prisma, entryId);
}

export type { BookingDamage };
