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

export const selectAvailabilityOptionRequestSchema = z
  .object({
    /** Legacy single-room selection — kept for backwards compat. */
    roomId: z.string().min(1).optional(),
    /** Multi-room, whole-stay selection. Every night uses the same rooms. */
    roomIds: z.array(z.string().min(1)).min(1).max(50).optional(),
    /**
     * Per-night selection — the new richest shape. Each entry is one night with the rooms
     * assigned to it. Different rooms per night are allowed (mid-stay room changes).
     * `date` is ISO YYYY-MM-DD, matching the check-in night. Validation on the service
     * side ensures every night is covered and each has exactly `entry.numberOfRooms` picks.
     */
    perNight: z
      .array(
        z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
          roomIds: z.array(z.string().min(1)).min(1).max(50),
        }),
      )
      .min(1)
      .max(365)
      .optional(),
    deficientAcknowledgements: z.unknown().optional(),
  })
  .refine(
    (v) =>
      !!v.roomId ||
      (Array.isArray(v.roomIds) && v.roomIds.length > 0) ||
      (Array.isArray(v.perNight) && v.perNight.length > 0),
    { message: "One of roomId, roomIds, or perNight must be provided" },
  );
export type SelectAvailabilityOptionRequestDto = z.infer<typeof selectAvailabilityOptionRequestSchema>;
