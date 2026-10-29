import { EntryStatus, Stage } from "@prisma/client";
import { z } from "zod";
import { roomCompositionInputSchema } from "../05-quotations-and-holds/request-schemas.js";

/**
 * Add the guest's return stay to the same enquiry (2026-09-25) — "we'll stay again on the way
 * back". Counts omitted mean the same party comes back; the service carries them from the first
 * stay and refuses dates that overlap a stay already on the enquiry.
 */
export const addReturnStayRequestSchema = z.object({
  checkInDate: z.string().trim().min(10).max(40),
  checkOutDate: z.string().trim().min(10).max(40),
  numberOfRooms: z.coerce.number().int().min(1).max(50).optional(),
  adultCount: z.coerce.number().int().min(0).max(200).optional(),
  childCount: z.coerce.number().int().min(0).max(200).optional(),
  childAges: z.array(z.coerce.number().int().min(0).max(150)).max(200).optional(),
});
export type AddReturnStayRequestDto = z.infer<typeof addReturnStayRequestSchema>;

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
  /**
   * Bed-setup breakdown of the room request ("5 King + 2 Twin"), map bedType → count.
   * Keys are validated service-side against the ROOM_BED_TYPES vocabulary and the
   * registry's achievable bed stock — shape-level we only require whole counts.
   */
  bedTypeRequest: z.record(z.string(), z.coerce.number().int().min(0).max(50)).nullish(),
  otaSource: z.boolean().optional(),
  walkInCompressed: z.boolean().optional(),
  // Contact person — the on-site individual travelling or leading the group. Distinct from
  // any travel-agent or corporate-account contact fields (those describe the agency /
  // company; this describes the human physically arriving). Optional at S1 intake, but
  // MANDATORY before S5 — the S4→S5 progression gate blocks otherwise.
  contactPersonName: z.string().trim().min(1).max(200).optional(),
  contactPersonPhone: z.string().trim().min(1).max(50).optional(),
  contactPersonEmail: z.string().trim().email().max(200).optional().or(z.literal("")),
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
  /** Bed-setup breakdown ("5 King + 2 Twin"). Explicit null clears the stored request. */
  bedTypeRequest: z.record(z.string(), z.coerce.number().int().min(0).max(50)).nullish(),
  useType: z.string().optional(),
  contactPersonName: z.string().trim().max(200).optional(),
  contactPersonPhone: z.string().trim().max(50).optional(),
  contactPersonEmail: z.string().trim().max(200).optional(),
  expectedVersion: z.coerce.number().int().optional(),
});
export type UpdateEntryRequestDto = z.infer<typeof updateEntryRequestSchema>;

/**
 * POST /api/entries/:id/negotiation-amendment — change the dates, the rooms and the party WITHOUT
 * leaving Negotiation (2026-09-30; dates since 2026-10-12). At least one of `dates` / `party` /
 * `rooms` is required; new dates need `rooms` picked from a search for them (the service checks),
 * and the room picks take the same three shapes the S1 save accepts.
 */
export const negotiationAmendmentRequestSchema = z
  .object({
    dates: z
      .object({
        checkInDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the check-in as YYYY-MM-DD."),
        checkOutDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the check-out as YYYY-MM-DD."),
      })
      .optional(),
    party: z
      .object({
        adultCount: z.coerce.number().int().min(0).optional(),
        childCount: z.coerce.number().int().min(0).optional(),
        childAges: z.array(z.coerce.number().int().min(0).max(150)).optional(),
        numberOfRooms: z.coerce.number().int().min(1).max(50).optional(),
        bedTypeRequest: z.record(z.string(), z.coerce.number().int().min(0).max(50)).nullish(),
      })
      .optional(),
    rooms: z
      .object({
        configurationId: z.string().min(1),
        roomId: z.string().min(1).optional(),
        roomIds: z.array(z.string().min(1)).max(60).optional(),
        perNight: z
          .array(z.object({ date: z.string().min(1), roomIds: z.array(z.string().min(1)).max(60) }))
          .max(90)
          .optional(),
        deficientAcknowledgements: z.unknown().optional(),
        /** Rooms by type (2026-10-29): the counts each night; the system chooses the rooms. */
        byType: z
          .object({
            perNight: z
              .array(
                z.object({
                  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                  types: z.array(z.object({ roomTypeId: z.string().min(1), count: z.number().int().min(0).max(200) })).max(50),
                }),
              )
              .min(1)
              .max(90),
            fixedRoomIds: z.array(z.string().min(1)).max(100).optional(),
          })
          .optional(),
      })
      .refine((r) => !!r.roomId || (r.roomIds?.length ?? 0) > 0 || (r.perNight?.length ?? 0) > 0 || !!r.byType, {
        message: "Name the rooms — roomId, roomIds, perNight or byType.",
      })
      .optional(),
    reason: z.string().trim().min(1, "A reason is required.").max(500),
    expectedVersion: z.coerce.number().int().optional(),
  })
  .refine((b) => !!b.party || !!b.rooms || !!b.dates, {
    message: "Nothing to change — send the dates, the party, the rooms, or any of them.",
  });
export type NegotiationAmendmentRequestDto = z.infer<typeof negotiationAmendmentRequestSchema>;

/**
 * Change the dates, rooms or guests on the step the booking is at (2026-10-29) — Set up, Reserve
 * or Arrival. The whole stay as it will stand: the dates, the party, the rooms picked night by
 * night from the house's answer for those dates, and the table for them.
 */
export const changeStayInPlaceRequestSchema = z.object({
  dates: z.object({
    checkInDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the check-in as YYYY-MM-DD."),
    checkOutDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the check-out as YYYY-MM-DD."),
  }),
  party: z.object({
    adultCount: z.coerce.number().int().min(1),
    childCount: z.coerce.number().int().min(0),
    childAges: z.array(z.coerce.number().int().min(0).max(150)),
    numberOfRooms: z.coerce.number().int().min(1).max(50),
  }),
  rooms: z.object({
    configurationId: z.string().min(1),
    perNight: z
      .array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), roomIds: z.array(z.string().min(1)).min(1).max(60) }))
      .min(1)
      .max(90),
    /** Picked by type (2026-10-29): `perNight` is then the rooms the system chose for it, as shown. */
    byType: z
          .object({
            perNight: z
              .array(
                z.object({
                  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                  types: z.array(z.object({ roomTypeId: z.string().min(1), count: z.number().int().min(0).max(200) })).max(50),
                }),
              )
              .min(1)
              .max(90),
            fixedRoomIds: z.array(z.string().min(1)).max(100).optional(),
          })
          .optional(),
  }),
  roomCompositions: z.array(roomCompositionInputSchema).min(1).max(60),
  reason: z.string().trim().min(1, "Type why the stay is changing.").max(500),
  expectedVersion: z.coerce.number().int().optional(),
});
export type ChangeStayInPlaceRequestDto = z.infer<typeof changeStayInPlaceRequestSchema>;

/** Approve (which applies it) or turn down a waiting configuration change. */
export const decideNegotiationAmendmentRequestSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(500).optional(),
});
export type DecideNegotiationAmendmentRequestDto = z.infer<typeof decideNegotiationAmendmentRequestSchema>;

export const withdrawNegotiationAmendmentRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type WithdrawNegotiationAmendmentRequestDto = z.infer<typeof withdrawNegotiationAmendmentRequestSchema>;

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

/** Move to another stay of the same trip — parks the one left, resumes one a switch parked. */
export const switchStayRequestSchema = z.object({
  toEntryId: z.string().trim().min(1),
});

export const reassignEntryCustodianRequestSchema = z.object({
  newCustodianId: z.string().min(1),
  reason: z.string().min(1),
});
export type ReassignEntryCustodianRequestDto = z.infer<typeof reassignEntryCustodianRequestSchema>;

export const recordKeyReturnRequestSchema = z.object({
  keyCountReturned: z.coerce.number().int().min(0),
  reconciliationNote: z.string().optional(),
  /** Room-wise return (2026-08-17, operator request — mirrors check-in's issuedKeyRoomIds):
   *  the rooms whose key actually came back; their assignment rows are stamped returned in
   *  the same transaction as the KeyReturnRecord. */
  returnedRoomIds: z.array(z.string().min(1)).max(60).optional(),
  /** Keys declared LOST (2026-10-26, ported from 4e36b65): the count, and room by room which. */
  keyCountLost: z.coerce.number().int().min(0).optional(),
  lostRoomIds: z.array(z.string().min(1)).max(60).optional(),
});
export type RecordKeyReturnRequestDto = z.infer<typeof recordKeyReturnRequestSchema>;

export const recordRoomInspectionRequestSchema = z.object({
  /** One inspection per room (2026-10-26); optional when the booking leaves a single room. */
  roomId: z.string().min(1).optional(),
  isDeferred: z.boolean(),
  deficientFlagStatus: z.enum(["RESOLVED", "UNRESOLVED_AT_CHECKOUT", "NOT_APPLICABLE"]),
  deficientConditionId: z.string().optional(),
  inspectorAssessment: z.string().optional(),
  damageFound: z.boolean(),
  damageNotes: z.string().optional(),
  /** A damage found: does it stop the room being sold? (2026-10-26 — asked each time.) Yes raises a
   *  fault report and takes the room out of service. Required with a damage found. */
  damageStopsSale: z.boolean().optional(),
  damageFaultCategory: z.enum(["HOUSEKEEPING", "MAINTENANCE", "SOFT_FURNISHING", "OTHER"]).optional(),
});
export type RecordRoomInspectionRequestDto = z.infer<typeof recordRoomInspectionRequestSchema>;

/** Answering a damage (2026-10-26): charge it — with or without service charge and GST — waive it
 *  (the FOM's, with the reason), or decide it after departure. */
export const answerDamageRequestSchema = z.discriminatedUnion("answer", [
  z.object({
    answer: z.literal("CHARGE"),
    amount: z.number().positive().max(10_000_000),
    serviceCharge: z.boolean(),
    gst: z.boolean(),
    description: z.string().max(300).optional(),
    note: z.string().max(1000).optional(),
  }),
  z.object({ answer: z.literal("WAIVE"), note: z.string().trim().min(1, "Say why the damage is waived").max(1000) }),
  z.object({ answer: z.literal("LATER"), note: z.string().max(1000).optional() }),
]);

/** What a damage charge comes to with the taxes chosen (nothing written). */
export const previewDamageChargeRequestSchema = z.object({
  amount: z.number().positive().max(10_000_000),
  serviceCharge: z.boolean(),
  gst: z.boolean(),
});

/** Every room still to inspect in one act (2026-10-26) — nothing found, or put off; rooms optional. */
export const recordRoomInspectionsBulkRequestSchema = z.object({
  mode: z.enum(["CLEAR", "PUT_OFF"]),
  roomIds: z.array(z.string().min(1)).max(200).optional(),
});

/**
 * S9 terminal close.
 * Body is intentionally empty today; validation middleware expects a JSON object.
 */
export const closeEntryRequestSchema = z.object({}).passthrough();

/** The guest's expected arrival, "HH:MM" hotel-local on the check-in day; null clears it (2026-09-18). */
export const setExpectedArrivalRequestSchema = z.object({
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time, HH:MM")
    .nullable(),
  /** The guest is expected the morning after the check-in day (2026-10-29). */
  dayAfter: z.boolean().optional(),
});
export type CloseEntryRequestDto = z.infer<typeof closeEntryRequestSchema>;

/** `GET /entries` — query string. */
export const listEntriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  inquiryId: z.string().min(1).optional(),
  status: z.nativeEnum(EntryStatus).optional(),
  currentStage: z.nativeEnum(Stage).optional(),
});
export type ListEntriesQueryDto = z.infer<typeof listEntriesQuerySchema>;

/** The rest of the bill at check-in (2026-10-29): the desk asks the FOM to let the guest pay later. */
export const checkInPaymentDeferralRequestSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

/** The FOM's answer — let them pay later (when, by when, why) or turn the request down. */
export const checkInPaymentDecisionRequestSchema = z
  .object({
    requestId: z.string().min(1).nullable().optional(),
    decision: z.enum(["APPROVE", "REJECT"]),
    payBy: z.enum(["DURING_STAY", "AT_CHECKOUT", "AFTER_STAY"]).nullable().optional(),
    dueBy: z.string().min(1).nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => v.decision === "REJECT" || !!v.payBy, { message: "Pick when the guest will pay", path: ["payBy"] });

export const checkInPaymentWithdrawRequestSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
});
