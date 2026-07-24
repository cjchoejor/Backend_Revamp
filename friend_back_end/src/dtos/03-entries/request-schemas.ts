import { EntryStatus, Stage } from "@prisma/client";
import { z } from "zod";

export const createEntryRequestSchema = z.object({
  inquiryId: z.string().min(1),
  guestProfileId: z.string().optional(),
  useType: z.string().min(1),
  checkInDate: z.string().optional(),
  checkOutDate: z.string().optional(),
  guestCount: z.coerce.number().int().optional(),
  adultCount: z.coerce.number().int().min(0).optional(),
  childCount: z.coerce.number().int().min(0).optional(),
  // The legal-age upper bound (typically 17 — "under minimumAge") is enforced at the service
  // layer against registry.child.unaccompaniedMinorMinAge so it stays editable as policy.
  // Shape-level we only require non-negative integers below an absurd ceiling.
  childAges: z.array(z.coerce.number().int().min(0).max(150)).optional(),
  /** Number of rooms requested — service enforces the chargeable-occupants envelope. */
  numberOfRooms: z.coerce.number().int().min(1).max(50).optional(),
  otaSource: z.boolean().optional(),
  walkInCompressed: z.boolean().optional(),
  // Contact person — the on-site individual travelling or leading the group. Distinct from
  // any travel-agent or corporate-account contact fields (those describe the agency /
  // company; this describes the human physically arriving). Optional at S1 intake, but
  // MANDATORY before S5 — the S4→S5 progression gate blocks otherwise.
  contactPersonName: z.string().trim().min(1).max(200).optional(),
  contactPersonPhone: z.string().trim().min(1).max(50).optional(),
});
export type CreateEntryRequestDto = z.infer<typeof createEntryRequestSchema>;

/**
 * PATCH /api/entries/:id — narrow, S1-only update path for the booking flow's "Edit" affordance.
 * Operators correcting initial intake mistakes (wrong dates, wrong head count) can re-open step 1
 * of the unified booking flow, change values, and save. Stage gates apply on the service side.
 */
export const updateEntryRequestSchema = z.object({
  checkInDate: z.string().optional(),
  checkOutDate: z.string().optional(),
  guestCount: z.coerce.number().int().min(0).optional(),
  adultCount: z.coerce.number().int().min(0).optional(),
  childCount: z.coerce.number().int().min(0).optional(),
  // Upper bound is enforced policy-side (registry.child.unaccompaniedMinorMinAge - 1) in the
  // service. See createEntryRequestSchema for the rationale.
  childAges: z.array(z.coerce.number().int().min(0).max(150)).optional(),
  numberOfRooms: z.coerce.number().int().min(1).max(50).optional(),
  useType: z.string().optional(),
  contactPersonName: z.string().trim().max(200).optional(),
  contactPersonPhone: z.string().trim().max(50).optional(),
  expectedVersion: z.coerce.number().int().optional(),
});
export type UpdateEntryRequestDto = z.infer<typeof updateEntryRequestSchema>;

export const patchApartmentContextRequestSchema = z.object({
  apartmentDurationNights: z.coerce.number().int().min(1),
  apartmentRateTierCode: z.string().trim().min(1),
});
export type PatchApartmentContextRequestDto = z.infer<typeof patchApartmentContextRequestSchema>;

export const parkEntryRequestSchema = z.object({
  // SIG-S1 §3.3 / SIG-S2 §3.3 — a park reason is required (max 500 chars) and is recorded on the trace.
  reason: z.string().trim().min(1, "A reason is required to park an entry.").max(500),
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
