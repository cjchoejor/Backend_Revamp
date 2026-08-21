import { z } from "zod";
import { discountShape, roomCompositionInputSchema } from "../05-quotations-and-holds/request-schemas.js";

const transitionDataSchema = z
  .object({
    guestPresentConfirmation: z.boolean().optional(),
    keyCount: z.coerce.number().optional(),
    registrationConfirmed: z.boolean().optional(),
    // Which rooms' keys actually went over the desk at check-in (2026-08-11; DECLARED here
    // 2026-08-14 — Zod strips undeclared keys, so the route had been receiving undefined and
    // the per-room key trace recorded null since the feature landed). Arrival-night rooms
    // only; the service refuses ids for rooms the guest moves into later.
    issuedKeyRoomIds: z.array(z.string().min(1)).max(60).optional(),
    reEntryReason: z.string().optional(),
  })
  .optional();

export const confirmReservationRequestSchema = z.object({
  version: z.coerce.number(),
});
export type ConfirmReservationRequestDto = z.infer<typeof confirmReservationRequestSchema>;

export const progressStageRequestSchema = z.object({
  targetStage: z.enum(["S2", "S3", "S4", "S6", "S7", "S8", "S9"]),
  version: z.coerce.number().int().optional(),
  guestPhysicallyPresent: z.boolean().optional(),
  transitionData: transitionDataSchema,
});
export type ProgressStageRequestDto = z.infer<typeof progressStageRequestSchema>;

export const multiBookingAckRequestSchema = z.object({
  note: z.unknown().optional(),
});
export type MultiBookingAckRequestDto = z.infer<typeof multiBookingAckRequestSchema>;

export const conferenceVerifyRequestSchema = z.object({
  checklist: z.unknown().optional(),
});
export type ConferenceVerifyRequestDto = z.infer<typeof conferenceVerifyRequestSchema>;

export const patchPreArrivalTaskRequestSchema = z.object({
  action: z.enum(["COMPLETE", "WAIVE"]),
  waivedReason: z.string().optional(),
});
export type PatchPreArrivalTaskRequestDto = z.infer<typeof patchPreArrivalTaskRequestSchema>;

export const deficientAckSchema = z.object({
  acknowledgementActorId: z.string().min(1),
  acknowledgementAt: z.string().min(1),
  decisionTaken: z.string().min(1),
});

export const createRoomAssignmentRequestSchema = z.object({
  roomId: z.string().min(1),
  notes: z.string().optional(),
  deficientAcknowledgement: deficientAckSchema.optional(),
  reEntryToS1: z.boolean().optional(),
});
export type CreateRoomAssignmentRequestDto = z.infer<typeof createRoomAssignmentRequestSchema>;

export const allocateConferenceSpaceRequestSchema = z.object({
  spaceCode: z.string().min(1),
  attendeeCount: z.coerce.number().refine((n) => Number.isFinite(n) && n >= 1, "attendeeCount must be >= 1"),
  seatingConfig: z.string().min(1),
});
export type AllocateConferenceSpaceRequestDto = z.infer<typeof allocateConferenceSpaceRequestSchema>;

export const ensureProvisionalFolioRequestSchema = z.object({
  billingModel: z.string().min(1),
});
export type EnsureProvisionalFolioRequestDto = z.infer<typeof ensureProvisionalFolioRequestSchema>;

export const placeCommittedHoldRequestSchema = z.object({
  roomId: z.string().min(1),
  commercialJustification: z.string().min(1),
  isFoc: z.boolean().optional(),
  roomsRequested: z.coerce.number().int().optional(),
  focRoomsRequested: z.coerce.number().int().optional(),
});
export type PlaceCommittedHoldRequestDto = z.infer<typeof placeCommittedHoldRequestSchema>;

export const s3ReEntryRequestSchema = z.object({
  reason: z.string().optional(),
});
export type S3ReEntryRequestDto = z.infer<typeof s3ReEntryRequestSchema>;

// S6 room change — reason is required; the new room is chosen fresh at S1.
export const s6RoomChangeReEnterS1RequestSchema = z.object({
  reason: z.string().min(3, "A reason for the room change is required"),
});

// In-place room change (2026-08-12): swap ONE room of the plan from S5/S6/S7. The backend runs
// the full governed journey (new segment, substituted basis revalidated, silent re-quote, walk
// back to the origin stage); the desk never leaves the page.
// Setup for one new room (2026-08-14): meals/extra bed rewrite the carried composition row
// before the silent quote prices it; bedType is applied to the room registry once the change
// commits. Omitted fields carry unchanged.
const roomChangeSetupShape = {
  bedType: z.string().min(1).optional(),
  extraBedCount: z.number().int().min(0).max(6).optional(),
  mealPlanCpCount: z.number().int().min(0).max(50).optional(),
  mealPlanMaplCount: z.number().int().min(0).max(50).optional(),
  mealPlanMapdCount: z.number().int().min(0).max(50).optional(),
  mealPlanApCount: z.number().int().min(0).max(50).optional(),
};
export const roomChangeRequestSchema = z
  .object({
    fromRoomId: z.string().min(1, "fromRoomId is required"),
    // Either ONE room for every night…
    toRoomId: z.string().min(1).optional(),
    // …or a room per night, S1-table style (2026-08-14) — may name the from-room itself on
    // nights the guest keeps. Must cover exactly the change's nights (service-enforced).
    perNight: z
      .array(z.object({ date: z.string().min(8), roomId: z.string().min(1) }))
      .max(120)
      .optional(),
    // Any non-empty reason — one word is fine (2026-08-14: the old min-3 kept the desk's swap
    // button dead on short reasons like "AC" with nothing explaining why).
    reason: z.string().trim().min(1, "A reason for the room change is required"),
    // Simple-swap sugar: setup for the single replacement room — OR, with neither toRoomId nor
    // perNight, a SETUP-ONLY change on the from-room itself (2026-08-19: extra beds / meals
    // re-priced on the same room; the service walks the same governed journey).
    adjustments: z.object(roomChangeSetupShape).optional(),
    // Per-room setups for the per-night form — one entry per distinct new room.
    roomSetups: z
      .array(z.object({ roomId: z.string().min(1), ...roomChangeSetupShape }))
      .max(30)
      .optional(),
    // FULL re-price basis (2026-08-19): the S2 negotiation table's own emission, one row per
    // room of the resulting plan. Replaces the carried compositions outright — the service
    // checks the room set matches and runs the quote's own composition guards before the
    // irreversible re-entry. The SAME row + discount schemas the S2 create/supersede routes
    // use, imported rather than restated so the two surfaces cannot drift.
    roomCompositions: z.array(roomCompositionInputSchema).max(60).optional(),
    /** Omitted carries the prior quote's discount; explicit null clears it. */
    requestedDiscount: discountShape.nullable().optional(),
  })
  .refine(
    (v) => {
      const single = v.toRoomId != null;
      const perNight = Array.isArray(v.perNight) && v.perNight.length > 0;
      const setup = v.adjustments != null && Object.values(v.adjustments).some((x) => x != null);
      // A full composition table (or an explicit discount edit) is a change in its own right.
      const reprice = Array.isArray(v.roomCompositions) && v.roomCompositions.length > 0;
      if (single && perNight) return false;
      return single || perNight || setup || reprice;
    },
    {
      message:
        "Provide toRoomId, perNight, or — to re-price in place — roomCompositions / adjustments; toRoomId and perNight never together",
    },
  );
export type RoomChangeRequestDto = z.infer<typeof roomChangeRequestSchema>;

export const approveFocGmRequestSchema = z.object({
  note: z.string().optional(),
});
export type ApproveFocGmRequestDto = z.infer<typeof approveFocGmRequestSchema>;

export const confirmCoordinatorRequestSchema = z.object({
  coordinatorName: z.string().min(1),
  authorityScope: z.string().min(1),
  notes: z.string().optional(),
});
export type ConfirmCoordinatorRequestDto = z.infer<typeof confirmCoordinatorRequestSchema>;

export const schedulePaymentMilestonesRequestSchema = z.object({
  templateKey: z.string().min(1),
  dueAt: z.string().optional(),
});
export type SchedulePaymentMilestonesRequestDto = z.infer<typeof schedulePaymentMilestonesRequestSchema>;
