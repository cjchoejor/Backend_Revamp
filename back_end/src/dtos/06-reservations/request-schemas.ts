import { z } from "zod";

const transitionDataSchema = z
  .object({
    guestPresentConfirmation: z.boolean().optional(),
    keyCount: z.coerce.number().optional(),
    registrationConfirmed: z.boolean().optional(),
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
