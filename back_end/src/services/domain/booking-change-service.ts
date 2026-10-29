import type { PrismaClient } from "@prisma/client";
import { Prisma, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { requireActiveMode } from "../../lib/mode-registry-runtime.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";
import { recordHeldDocument } from "../../lib/held-documents.js";
import { enforceNoOverbookingForPlannedStay } from "../../policies/17-overbooking/p41-overbooking-requires-gm-mitigation.js";
import { enforceMultiBookingAcknowledgedForNewDates } from "../../policies/04-duplicate-detection/p13-multi-booking-ack-required.js";
import { enforceDateMoveAuthority } from "../../policies/23-room-change/p58-room-change-mode-trigger.js";
import { enforceEntryActiveForStageTransition } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { backflowRoomChangeToS2 } from "../../state-machines/backflows-state-machine.js";
import { progressS2ToS3 } from "../../state-machines/s2-s3-state-machine.js";
import { runPreArrivalWindowActivationWorker } from "../../workers/w4-pre-arrival-window-activation-worker.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { validateCapacity } from "./capacity-validation-service.js";
import { queryAvailability, selectOption } from "./s1-availability-service.js";
import { amendNegotiationConfiguration, checkNewDates } from "./negotiation-amendment-service.js";
import { createQuotation, type RoomCompositionServiceInput } from "./s2-quotation-service.js";
import { carryAdvancePinsAcrossNewPass } from "./s3-payment-service.js";
import * as s3HoldService from "./s3-hold-service.js";
import { confirmReservation } from "./s4-confirmation-service.js";
import { recordCommunicationAcknowledgement } from "./communication-acknowledgement-service.js";
import { assignRoomsFromSealedPerNight } from "./room-assignment-service.js";
import { releasePreOccupancyForReEntryTx } from "./room-change-service.js";

/**
 * CHANGE THE DATES, ROOMS OR GUESTS ON THE STEP THE BOOKING IS AT (2026-10-29, operator: "in the
 * actual stage 4 we can still change the dates and rooms and its configuration and from the backend
 * it would look like it went through all the correct stages but for the user it should still happen
 * in that current stage, the papers and all will be newly generated … the backend goes back but the
 * user stays on the current page"). "Change the dates, rooms or guests" at Reserve used to send the
 * booking back to Inquiry and leave the desk on a page with nothing to change.
 *
 * One governed walk, every step an act that already exists:
 *   0. Everything checked first, nothing written — the dates, the party, the rooms against the
 *      house's answer for the new dates, the table, the overbooking and same-guest questions.
 *   1. Back to Negotiation (`backflowRoomChangeToS2`, a new pass): the hold and the room flags
 *      released, Arrival's room rows dropped, the old pass's held papers retired.
 *   2. At Negotiation the change itself — `amendNegotiationConfiguration` (dates, party, rooms),
 *      the same act and checks as Negotiation's own Change configuration, on a fresh search.
 *   3. The quotation priced again from the desk's table (nothing goes to the guest).
 *   4. Set up: the folio, the payer and the terms carry; the desk's advance pins carry; the
 *      rooms blocked again.
 *   5. From Reserve on: reserved again with a new voucher HELD for the desk; from Arrival the
 *      guest's answer is the change they asked for, and Arrival opens again (only inside its
 *      window) with the rooms assigned.
 * A step refused after the re-entry stops the walk and says where (the partial-outcome contract of
 * the room-change composite); the desk finishes the booking from that step.
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

export type BookingChangeInput = {
  dates: { checkInDate: string; checkOutDate: string };
  party: { adultCount: number; childCount: number; childAges: number[]; numberOfRooms: number };
  /** The house's answer the rooms were picked from, for exactly the new dates, and the picks. */
  rooms: { configurationId: string; perNight: Array<{ date: string; roomIds: string[] }> };
  /** The S2 table for the new rooms — who sleeps where, meals, beds, rates. */
  roomCompositions: RoomCompositionServiceInput[];
  reason: string;
  expectedVersion?: number;
};

export type BookingChangeOutcome = {
  entryId: string;
  fromStage: string;
  reachedStage: string;
  /** The walk came back to the step it started on. */
  returned: boolean;
  /** Where it stopped, and why, when a step after the re-entry refused. */
  blocked: { atStep: string; message: string } | null;
  quotationId: string | null;
  pricing: { priorTotal: number | null; newTotal: number | null; currency: string | null };
  heldDocuments: Array<{ id: string; kind: "CONFIRMATION_VOUCHER" | "PROFORMA"; documentId: string }>;
  notes: string[];
  summary: string;
};

const ORIGINS: Stage[] = [Stage.S3, Stage.S4, Stage.S5];
const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dayWords = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function changeBookingInPlace(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: BookingChangeInput,
): Promise<BookingChangeOutcome> {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Type why the stay is changing — it goes on the booking's record.");

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      quotations: { orderBy: { createdAt: "desc" } },
      committedHold: true,
      folio: true,
      guestProfile: { select: { firstName: true, lastName: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  const stage = entry.currentStage as Stage;

  // ── 0. Everything checked before anything is written ─────────────────────────────────────────
  enforceEntryActiveForStageTransition({ status: entry.status });
  if (!ORIGINS.includes(stage)) {
    throw new ValidationError(
      stage === Stage.S1 || stage === Stage.S2
        ? "At Inquiry and Negotiation the stay is changed on the step itself."
        : "From Check-in on the dates move through Extend the stay or Leaving early, and the rooms through the Rooms tab.",
    );
  }
  if (input.expectedVersion != null && entry.version !== input.expectedVersion) {
    throw new ValidationError("This booking changed on another screen — reload it and try again.");
  }
  // Moving a reserved booking's dates is the FOM's call from Set up on (Policy 58).
  enforceDateMoveAuthority({ actorLevel: actor.actorLevel });
  await requireActiveMode(prisma, "ROOM_CHANGE");
  await requireActiveMode(prisma, "GUEST_COMPOSITION_CHANGE");

  const running = await prisma.roomMoveLeg.findFirst({
    where: { entryId, move: { status: { in: ["IN_PROGRESS", "PARTIAL"] } } },
    select: { moveId: true },
  });
  if (running) throw new ValidationError(`A room move (${running.moveId}) is still running on this booking — finish it first.`);

  // The dates: the same rules as Negotiation's change (not before today, not over another stay of
  // this enquiry). `null` = the dates are the ones the booking already has.
  const newStay = await checkNewDates(prisma, entry, input.dates);
  const checkIn = newStay?.checkIn ?? entry.checkInDate;
  const checkOut = newStay?.checkOut ?? entry.checkOutDate;
  if (!checkIn || !checkOut) throw new ValidationError("The booking has no stay dates to change.");

  // The party.
  const party = input.party;
  if (!(party.adultCount >= 1)) throw new ValidationError("At least one adult stays.");
  if ((party.childAges ?? []).length !== party.childCount) throw new ValidationError("Every child needs an age.");
  if (!(party.numberOfRooms >= 1)) throw new ValidationError("At least one room.");
  const capacity = await validateCapacity(prisma, { adults: party.adultCount, childAges: party.childAges });
  const block = capacity.issues.find((i) => i.severity === "BLOCK");
  if (block) throw new ValidationError(block.message);

  // The rooms: picked from the house's answer for exactly the new dates, every night holding the
  // rooms asked for — the same `selectOption` the save runs, with nothing written.
  const cfg = await prisma.availabilityConfiguration.findUnique({ where: { id: input.rooms.configurationId } });
  if (!cfg || cfg.entryId !== entryId) throw new NotFoundError("AvailabilityConfiguration");
  const sc = (cfg.searchCriteria ?? {}) as { checkInDate?: string; checkOutDate?: string };
  if (String(sc.checkInDate ?? "").slice(0, 10) !== ymd(checkIn) || String(sc.checkOutDate ?? "").slice(0, 10) !== ymd(checkOut)) {
    throw new ValidationError("Those rooms were found for other dates — ask the house for the new dates first.");
  }
  const perNight = input.rooms.perNight.map((n) => ({ date: String(n.date).slice(0, 10), roomIds: [...new Set(n.roomIds)] }));
  await selectOption(prisma, cfg.id, actor.actorId, { perNight }, {
    validateOnly: true,
    stay: { checkInDate: checkIn, checkOutDate: checkOut, numberOfRooms: party.numberOfRooms },
  });
  const planRoomIds = [...new Set(perNight.flatMap((n) => n.roomIds))];

  // The table covers exactly the rooms picked.
  const comps = input.roomCompositions ?? [];
  const compRooms = new Set(comps.map((c) => c.roomId));
  const missing = planRoomIds.filter((id) => !compRooms.has(id));
  const stray = [...compRooms].filter((id) => !planRoomIds.includes(id));
  if (missing.length || stray.length || compRooms.size !== comps.length) {
    const numbers = new Map(
      (await prisma.room.findMany({ where: { id: { in: [...missing, ...stray] } }, select: { id: true, roomNumber: true } })).map((r) => [r.id, r.roomNumber]),
    );
    throw new ValidationError(
      missing.length
        ? `Who sleeps where has no row for ${missing.map((id) => `Room ${numbers.get(id) ?? "?"}`).join(", ")} — set the table again for the rooms picked.`
        : `Who sleeps where names ${stray.map((id) => `Room ${numbers.get(id) ?? "?"}`).join(", ")}, which the stay no longer holds.`,
    );
  }

  // Would the new plan overbook a room, or give the guest two bookings over the same nights?
  // Asked here, so a refusal changes nothing (both are asked again at the re-freeze).
  await enforceNoOverbookingForPlannedStay(prisma, {
    entryId,
    otaSource: (entry as { otaSource?: boolean | null }).otaSource === true,
    spans: perNight.flatMap((n) => {
      const startDate = new Date(`${n.date}T00:00:00.000Z`);
      const endDate = new Date(startDate.getTime() + DAY);
      return n.roomIds.map((roomId) => ({ roomId, startDate, endDate }));
    }),
  });
  if (newStay) {
    await enforceMultiBookingAcknowledgedForNewDates(prisma, { entryId, guestProfileId: entry.guestProfileId, checkInDate: checkIn, checkOutDate: checkOut });
  }

  // What the booking holds today, for the summary and the carried discount.
  const priorSegment = entry.segments[0]!;
  const priorQuote = resolveOperativeQuotation(entry.quotations, priorSegment.id);
  const priorTerms = (priorQuote?.commercialTerms ?? null) as Record<string, unknown> | null;
  const priorTotal = priorQuote?.totalAmount != null ? Number(priorQuote.totalAmount) : null;
  const carriedDiscount = (priorTerms?.requestedDiscount ?? null) as { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
  const approved = ((priorTerms?.discountAuthority as { approvedLevel?: string } | undefined)?.approvedLevel ?? null) as Actor["actorLevel"] | null;
  // The concession carries under the authority that approved it (the room-change walk's rule).
  const quoteLevel = carriedDiscount && approved && (RANK[approved] ?? 0) > (RANK[actor.actorLevel] ?? 0) ? approved : actor.actorLevel;
  const priorRooms = readOptionSelected(
    ((await prisma.availabilityConfiguration.findFirst({
      where: { entryId, segmentId: priorSegment.id, sealedAt: { not: null } },
      orderBy: { sealedAt: "desc" },
      select: { optionSelected: true },
    }))?.optionSelected ?? null) as never,
  ).distinctRoomIds;
  const holdWasPlaced = entry.committedHold?.state === "PLACED" || entry.committedHold?.state === "CONFIRMED";
  const roomNumbers = new Map(
    (await prisma.room.findMany({ where: { id: { in: [...new Set([...priorRooms, ...planRoomIds])] } }, select: { id: true, roomNumber: true } })).map((r) => [r.id, r.roomNumber]),
  );
  const roomsWords = (ids: string[]) =>
    ids.length ? ids.map((id) => roomNumbers.get(id) ?? "?").sort((a, b) => a.localeCompare(b, "en", { numeric: true })).join(", ") : "—";
  const before = {
    checkIn: ymd(entry.checkInDate!),
    checkOut: ymd(entry.checkOutDate!),
    adults: entry.adultCount ?? 0,
    children: entry.childCount ?? 0,
    rooms: entry.numberOfRooms ?? priorRooms.length,
    roomNumbers: roomsWords(priorRooms),
  };
  const after = {
    checkIn: ymd(checkIn),
    checkOut: ymd(checkOut),
    adults: party.adultCount,
    children: party.childCount,
    rooms: party.numberOfRooms,
    roomNumbers: roomsWords(planRoomIds),
  };
  const changes = [
    newStay ? `the stay ${dayWords(before.checkIn)} – ${dayWords(before.checkOut)} → ${dayWords(after.checkIn)} – ${dayWords(after.checkOut)}` : null,
    before.adults !== after.adults || before.children !== after.children
      ? `the party ${before.adults} adult${before.adults === 1 ? "" : "s"}${before.children ? ` + ${before.children} child${before.children === 1 ? "" : "ren"}` : ""} → ${after.adults} adult${after.adults === 1 ? "" : "s"}${after.children ? ` + ${after.children} child${after.children === 1 ? "" : "ren"}` : ""}`
      : null,
    before.roomNumbers !== after.roomNumbers ? `the rooms ${before.roomNumbers} → ${after.roomNumbers}` : null,
  ].filter((x): x is string => !!x);
  const summary = changes.length ? changes.join(" · ") : "who sleeps where, meals or rates";

  // ── The walk ─────────────────────────────────────────────────────────────────────────────────
  const notes: string[] = [];
  const heldDocuments: BookingChangeOutcome["heldDocuments"] = [];
  let quotationId: string | null = null;
  let newTotal: number | null = null;
  let currency: string | null = priorQuote?.currency ?? null;
  let blocked: BookingChangeOutcome["blocked"] = null;
  const version = async () => (await prisma.entry.findUniqueOrThrow({ where: { id: entryId }, select: { version: true } })).version;
  const step = async (atStep: string, fn: () => Promise<unknown>): Promise<boolean> => {
    if (blocked) return false;
    try {
      await fn();
      return true;
    } catch (e) {
      blocked = { atStep, message: errorMessage(e) };
      return false;
    }
  };

  // 1. Back to Negotiation — the one irreversible step; everything after it reports, never throws.
  if (stage === Stage.S3) {
    const { freezeUnrenderedProformasForEntry } = await import("./invoice-pdf-service.js");
    await freezeUnrenderedProformasForEntry(prisma, entryId, actor.actorId).catch(() => {});
  }
  await backflowRoomChangeToS2(prisma, entryId, actor, {
    reason: `Change of the stay: ${summary} (${reason})`,
    fromStage: stage,
    cancelTimerCodes: ["NO_SHOW_CUTOFF_W5", "ROOM_READINESS_SLA_W23", "PRE_ARRIVAL_COUNTDOWN_W4", ...(newStay ? ["NIGHT_AUDIT_STAY_NIGHT_W37"] : [])],
    hooks: async (tx) => {
      if (stage === Stage.S3) {
        const { supersedePendingInvoicesTx } = await import("./s3-folio-service.js");
        await supersedePendingInvoicesTx(tx, entryId, actor.actorId);
      }
      await releasePreOccupancyForReEntryTx(tx, { entryId, actor, inquiryId: entry.inquiryId, stage });
    },
  });

  // 2. The change itself, at Negotiation, on a search of this pass for the new dates.
  await step("THE_CHANGE", async () => {
    const search = (await queryAvailability(prisma, entryId, actor.actorId, actor.actorLevel, {
      checkInDate: ymd(checkIn),
      checkOutDate: ymd(checkOut),
      guestCount: party.adultCount + party.childCount,
    })) as { configuration: { id: string } };
    const out = await amendNegotiationConfiguration(prisma, entryId, actor, {
      reason: `Changed at ${stage === Stage.S3 ? "Set up" : stage === Stage.S4 ? "Reserve" : "Arrival"}: ${reason}`,
      ...(newStay ? { dates: { checkInDate: ymd(checkIn), checkOutDate: ymd(checkOut) } } : {}),
      party: { adultCount: party.adultCount, childCount: party.childCount, childAges: party.childAges, numberOfRooms: party.numberOfRooms },
      rooms: { configurationId: search.configuration.id, perNight },
    });
    if (!out.applied) throw new ValidationError("The change could not be applied at Negotiation.");
  });

  // 3. Priced again from the desk's table — the papers are made again; nothing goes to the guest.
  await step("QUOTATION", async () => {
    const q = await createQuotation(prisma, entryId, actor.actorId, {
      notes: `Stay changed at the desk: ${summary} (${reason})`,
      roomCompositions: comps,
      ...(carriedDiscount ? { requestedDiscount: carriedDiscount } : {}),
      actorLevel: quoteLevel,
    });
    quotationId = q.id;
    newTotal = q.totalAmount != null ? Number(q.totalAmount) : null;
    currency = q.currency ?? currency;
  });
  if (!blocked) {
    // The desk's pinned advance and the guest's plan carry across the pass (as on a room change).
    await carryAdvancePinsAcrossNewPass(prisma, { entryId, priorSegmentStartedAt: priorSegment.startedAt, actor, cause: "RECONFIGURE" }).catch((e) =>
      notes.push(`The advance asked was not carried: ${errorMessage(e)} — set it again at Set up.`),
    );
  }

  // 4. Set up, and the rooms blocked again.
  await step("NEGOTIATION_TO_SET_UP", async () => progressS2ToS3(prisma, entryId, actor.actorId, await version()));
  const anchor = (() => {
    const nights = new Map<string, number>();
    for (const n of perNight) for (const id of n.roomIds) nights.set(id, (nights.get(id) ?? 0) + 1);
    return [...nights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? planRoomIds[0];
  })();
  if (stage !== Stage.S3 || holdWasPlaced) {
    await step("HOLD", async () =>
      s3HoldService.placeCommittedHold(prisma, entryId, actor, {
        roomId: anchor,
        commercialJustification: `Stay changed: ${reason}`,
        trigger: "ROOM_CHANGE",
        expiresAtCarry: stage === Stage.S3 ? (entry.committedHold?.expiresAt ?? null) : null,
      }),
    );
  }
  if (stage === Stage.S3 && !blocked) {
    // At Set up the proforma is the live bill: the new pass made its own on arrival — held for the desk.
    const proforma = entry.folio
      ? await prisma.invoice.findFirst({
          where: { folioId: entry.folio.id, invoiceType: "PROFORMA", state: { not: "SUPERSEDED" } },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        })
      : null;
    if (proforma) {
      const held = await recordHeldDocument(prisma, { entryId, kind: "PROFORMA", documentId: proforma.id, reason: "RECONFIGURE", heldBy: actor.actorId, heldByLevel: actor.actorLevel, stage: Stage.S3 }).catch(() => null);
      if (held) heldDocuments.push({ id: held.id, kind: "PROFORMA", documentId: proforma.id });
    }
  }

  // 5. Reserved again, the voucher held for the desk.
  if (stage === Stage.S4 || stage === Stage.S5) {
    await step("RESERVE", async () => {
      const reserved = await confirmReservation(prisma, entryId, actor.actorId, {
        version: await version(),
        holdGuestEmail: true,
        // The money was settled at the first freeze (money or the FOM's credit); the change does not reopen it.
        carryAdvanceCondition: true,
      });
      const held = await recordHeldDocument(prisma, {
        entryId,
        kind: "CONFIRMATION_VOUCHER",
        documentId: reserved.reservation.id,
        reason: "RECONFIGURE",
        heldBy: actor.actorId,
        heldByLevel: actor.actorLevel,
        stage: Stage.S4,
      }).catch(() => null);
      if (held) heldDocuments.push({ id: held.id, kind: "CONFIRMATION_VOUCHER", documentId: reserved.reservation.id });
    });
    // From Arrival the guest had answered the earlier voucher (Arrival waits for it), and the change
    // is their own ask — it stands as the answer to the new one. At Reserve an answer is recorded
    // only when the earlier voucher had one; otherwise the new voucher waits for a real answer.
    if (!blocked) {
      try {
        const segStart = (await prisma.segment.findFirst({ where: { entryId }, orderBy: { segmentNumber: "desc" }, select: { startedAt: true } }))?.startedAt;
        const voucher = await prisma.communicationRecord.findFirst({
          where: { entryId, commType: "CONFIRMATION_VOUCHER", direction: "OUTBOUND", sendStatus: "DISPATCHED", ...(segStart ? { createdAt: { gte: segStart } } : {}) },
          orderBy: { createdAt: "desc" },
        });
        const priorAnswered =
          stage === Stage.S5 ||
          !!(await prisma.communicationRecord.findFirst({
            where: { entryId, commType: "CONFIRMATION_VOUCHER", direction: "OUTBOUND", acknowledgementStatus: "RECEIVED", ...(segStart ? { createdAt: { lt: segStart } } : {}) },
            select: { id: true },
          }));
        if (voucher && voucher.acknowledgementStatus !== "RECEIVED" && priorAnswered) {
          await recordCommunicationAcknowledgement(prisma, voucher.id, actor, {
            method: "VERBAL",
            verbatimNote: `The guest asked for the change (${summary}): ${reason}. The change itself is the guest's answer to the new voucher.`,
          });
        }
      } catch {
        notes.push("The guest's answer to the new voucher was not recorded — record it on the voucher.");
      }
    }
  }

  // 6. Back to Arrival — only inside its window, with the rooms assigned again.
  if (stage === Stage.S5 && !blocked) {
    const windowDays = Number(await requireActiveConfigValue<number>(prisma, "preArrival.windowDays").catch(() => 1)) || 1;
    const opensAt = new Date(checkIn.getTime() - windowDays * DAY);
    if (opensAt.getTime() > Date.now()) {
      notes.push(`The new dates are further out — the booking waits at Reserve, and Arrival opens on ${dayWords(ymd(opensAt))}.`);
    } else {
      await step("ARRIVAL", async () => {
        const engine = await getTimerEngine();
        const activation = await runPreArrivalWindowActivationWorker(prisma, engine, { entryId }, { skipTaskReset: true });
        if (activation.skipped) throw new ValidationError(`Arrival did not open: ${activation.reason}`);
      });
      if (!blocked) {
        await step("ASSIGN_ROOMS", async () => assignRoomsFromSealedPerNight(prisma, entryId, actor.actorId));
      }
    }
  }

  const reached = await prisma.entry.findUniqueOrThrow({ where: { id: entryId }, select: { currentStage: true } });
  const outcome: BookingChangeOutcome = {
    entryId,
    fromStage: String(stage),
    reachedStage: String(reached.currentStage),
    returned: String(reached.currentStage) === String(stage),
    blocked,
    quotationId,
    pricing: { priorTotal, newTotal, currency },
    heldDocuments,
    notes,
    summary,
  };
  await prisma.traceEvent
    .create({
      data: {
        eventType: "ENTRY.STAY_CHANGED_IN_PLACE",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: new Date(),
        stageContext: stage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          entryId,
          reason,
          summary,
          before,
          after,
          fromStage: String(stage),
          reachedStage: outcome.reachedStage,
          blocked,
          quotationId,
          priorTotal,
          newTotal,
          heldDocuments,
          notes,
        } as unknown as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    })
    .catch(() => {});
  return outcome;
}
