import { EntryStatus, Stage } from "@prisma/client";
import { z } from "zod";

export const createEntryRequestSchema = z.object({
  inquiryId: z.string().min(1),
  guestProfileId: z.string().optional(),
  useType: z.string().min(1),
  checkInDate: z.string().optional(),
  checkOutDate: z.string().optional(),
  guestCount: z.coerce.number().int().optional(),
  otaSource: z.boolean().optional(),
  walkInCompressed: z.boolean().optional(),
});
export type CreateEntryRequestDto = z.infer<typeof createEntryRequestSchema>;

export const patchApartmentContextRequestSchema = z.object({
  apartmentDurationNights: z.coerce.number().int().min(1),
  apartmentRateTierCode: z.string().trim().min(1),
});
export type PatchApartmentContextRequestDto = z.infer<typeof patchApartmentContextRequestSchema>;

export const parkEntryRequestSchema = z.object({
  reason: z.string().optional(),
});
export type ParkEntryRequestDto = z.infer<typeof parkEntryRequestSchema>;

export const reassignEntryCustodianRequestSchema = z.object({
  newCustodianId: z.string().min(1),
  reason: z.string().min(1),
});
export type ReassignEntryCustodianRequestDto = z.infer<typeof reassignEntryCustodianRequestSchema>;

export const recordKeyReturnRequestSchema = z.object({
  keyCountReturned: z.coerce.number().int().min(0),
  reconciliationNote: z.string().optional(),
});
export type RecordKeyReturnRequestDto = z.infer<typeof recordKeyReturnRequestSchema>;

export const recordRoomInspectionRequestSchema = z.object({
  isDeferred: z.boolean(),
  deficientFlagStatus: z.enum(["RESOLVED", "UNRESOLVED_AT_CHECKOUT", "NOT_APPLICABLE"]),
  deficientConditionId: z.string().optional(),
  inspectorAssessment: z.string().optional(),
  damageFound: z.boolean(),
  damageNotes: z.string().optional(),
});
export type RecordRoomInspectionRequestDto = z.infer<typeof recordRoomInspectionRequestSchema>;

/**
 * S9 terminal close.
 * Body is intentionally empty today; validation middleware expects a JSON object.
 */
export const closeEntryRequestSchema = z.object({}).passthrough();
export type CloseEntryRequestDto = z.infer<typeof closeEntryRequestSchema>;

/** `GET /entries` — query string. */
export const listEntriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  inquiryId: z.string().min(1).optional(),
  status: z.nativeEnum(EntryStatus).optional(),
  currentStage: z.nativeEnum(Stage).optional(),
});
export type ListEntriesQueryDto = z.infer<typeof listEntriesQuerySchema>;
