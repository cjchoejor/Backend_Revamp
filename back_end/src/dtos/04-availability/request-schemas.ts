import { z } from "zod";

/** `POST /entries/:id/availability/query` — entry id comes from the path. */
export const queryAvailabilityByEntryRequestSchema = z.object({
  roomTypeId: z.string().optional(),
  checkInDate: z.string().min(1),
  checkOutDate: z.string().min(1),
  guestCount: z.coerce.number().int().optional(),
  useType: z.string().optional(),
  /** When set with CONFERENCE/CATERING entry (or matching `useType`), creates a QUOTED `SpaceAllocation` in the same transaction as the configuration (SIG-S1 §6.5). */
  spaceId: z.string().min(1).optional(),
  seatingConfig: z.string().min(1).optional(),
});
export type QueryAvailabilityByEntryRequestDto = z.infer<typeof queryAvailabilityByEntryRequestSchema>;

/** `POST /availability/search` — entry id must be present in the body. */
export const queryAvailabilitySearchRequestSchema = queryAvailabilityByEntryRequestSchema.extend({
  entryId: z.string().min(1),
});
export type QueryAvailabilitySearchRequestDto = z.infer<typeof queryAvailabilitySearchRequestSchema>;

/** @deprecated Prefer {@link QueryAvailabilityByEntryRequestDto} or {@link QueryAvailabilitySearchRequestDto}. */
export type QueryAvailabilityRequestDto = QueryAvailabilitySearchRequestDto;

export const selectAvailabilityOptionRequestSchema = z.object({
  roomId: z.string().min(1),
  deficientAcknowledgements: z.unknown().optional(),
});
export type SelectAvailabilityOptionRequestDto = z.infer<typeof selectAvailabilityOptionRequestSchema>;
