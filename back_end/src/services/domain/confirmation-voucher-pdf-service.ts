/**
 * S4 Confirmation Voucher PDF generation.
 *
 * Called from `confirmReservation` right BEFORE the confirmation email is dispatched, so the
 * voucher exists in storage and its bytes can be attached to the email.
 *
 * The template (`confirmation-voucher-template.ts`) matches `Reservation_Confirmation_for
 * email.pdf` — LEGPHEL header, In/Out + Hotel Information panels, BOOKING DETAILS table,
 * amenities grid, four coloured policy cards, front-office block, "WALK THE EXTRA MILE!"
 * footer.
 *
 * Re Check-In / Re Check-Out: currently null (deferred design — see
 * docs/pdf-bill-generation-todo.md "Discuss later #1"). Template renders "—" placeholders.
 *
 * Storage / immutability: same append-only pattern as the quotation and invoice services.
 * If a voucher was previously rendered we serve the stored file rather than regenerating.
 */
import { type PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import {
  buildStorageKey,
  hashSha256,
  readDocument,
  writeDocument,
} from "../../lib/document-storage.js";
import {
  extractPrimaryPhone,
  formatMoney,
  loadHotelProfileForRender,
} from "../../lib/pdf-render-context.js";
import { renderHtmlToPdf } from "../infrastructure/pdf-render-service.js";
import { renderLegphelConfirmationVoucherHtml } from "../infrastructure/pdf-templates/legphel-confirmation-voucher-template.js";
import { mastheadFromHotelProfile } from "../infrastructure/pdf-templates/legphel-document-shell.js";
import { formatDocDate, formatDocDateTime } from "../infrastructure/pdf-templates/legphel-document-format.js";
import { type ConfirmationVoucherLine } from "../infrastructure/pdf-templates/confirmation-voucher-template.js";

/** Static policy text — matches the reference voucher. Would live in ConfigurationEntry once
 *  the admin console gets a policy editor. Kept inline for now so the voucher renders even
 *  before that admin surface exists. */
const DEFAULT_POLICIES = {
  cancellation:
    "If cancellation is made 45 days or more before the scheduled date, a 100% refund will be provided. For cancellations made between 30 and 44 days before the scheduled date, a 50% refund will be issued. Cancellations made less than 30 days before the scheduled date are not eligible for any refund.",
  extraGuest:
    "Legphel Hotel operates on a double occupancy basis per room, with a maximum capacity of up to 3 guests. Additional guests over the age of 12 accommodated in the same room with two adults, requiring an extra bed, may do so for an additional charge. This policy applies to bookings in Deluxe Rooms, Executive Rooms, and Suite Rooms.",
  pet: "No pets are allowed",
  childAge:
    "Children below the age of 6 years will receive complimentary accommodation when sharing the room with their parents or guardians, with no additional charges for their stay and meals.\nChildren between the ages of 6 and 10 years will also receive complimentary accommodation if they share the room with their parents or guardians; however, charges will apply for meals only.\nChildren aged 11 years and above will be considered adults for accommodation purposes. They will be provided with a separate extra bed or mattress, and regular adult rates will apply for their stay.",
} as const;

export type ConfirmationVoucherArtifact = {
  storageKey: string;
  checksum: string;
  bytes: Buffer;
  filename: string;
};

export async function generateOrLoadConfirmationVoucherPdf(
  prisma: PrismaClient,
  reservationId: string,
  actorId: string,
): Promise<ConfirmationVoucherArtifact> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      entry: {
        include: {
          guestProfile: true,
          inquiry: {
            include: { travelAgent: true, corporateAccount: true },
          },
          roomAssignments: {
            orderBy: { createdAt: "asc" },
            include: { room: true },
          },
        },
      },
    },
  });
  if (!reservation) throw new NotFoundError("Reservation");

  // Idempotency
  if (reservation.confirmationVoucherStorageKey && reservation.confirmationVoucherChecksum) {
    const bytes = await readDocument(reservation.confirmationVoucherStorageKey);
    const bookingReference = reservation.entry.inquiryId ?? reservation.id;
    return {
      storageKey: reservation.confirmationVoucherStorageKey,
      checksum: reservation.confirmationVoucherChecksum,
      bytes,
      filename: `${bookingReference}-confirmation-voucher.pdf`,
    };
  }

  const entry = reservation.entry;
  const hotel = await loadHotelProfileForRender(prisma);
  const hotelPhone = extractPrimaryPhone(hotel.contactNumbers);

  const guest = entry.guestProfile;
  const guestFullName = [guest?.firstName, guest?.lastName].filter(Boolean).join(" ") || "Guest";
  // Boss's convention: `To:` = guest full name, `Guest Name` (booking row) = contact person.
  const contactPersonName = entry.contactPersonName?.trim() || guestFullName;
  const confirmationBy =
    entry.inquiry?.travelAgent?.displayName ??
    entry.inquiry?.corporateAccount?.displayName ??
    "Walk-In";

  const checkIn = reservation.frozenCheckInDate;
  const checkOut = reservation.frozenCheckOutDate;
  const nights = Math.max(
    1,
    Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000),
  );

  // Booking-details rows — one row per (night × room assignment).
  //
  // Phase D of per-room track (2026-07-27): rooms are no longer collapsed into a joined
  // string. When RoomAssignment carries composition (Phase A/C), each row shows that
  // assignment's own occupants, meal-plan distribution, and extra beds. Falls back to
  // entry-level totals for assignments with no composition.
  const bookingRows: ConfirmationVoucherLine[] = [];
  const fallbackAdults = entry.adultCount ?? Number(entry.guestCount ?? 1) ?? 1;
  const fallbackChildren = entry.childCount ?? 0;
  const fallbackOccupants = `${fallbackAdults} adult${fallbackAdults === 1 ? "" : "s"}, ${fallbackChildren} child${fallbackChildren === 1 ? "" : "ren"}`;

  // Helper: describe a single assignment's meal-plan distribution as "1 CP · 2 MAPL" etc.
  const describeMealPlan = (a: (typeof entry.roomAssignments)[number]): string => {
    const parts: string[] = [];
    if (a.mealPlanCpCount > 0) parts.push(`${a.mealPlanCpCount} CP`);
    if (a.mealPlanMaplCount > 0) parts.push(`${a.mealPlanMaplCount} MAPL`);
    if (a.mealPlanMapdCount > 0) parts.push(`${a.mealPlanMapdCount} MAPD`);
    if (a.mealPlanApCount > 0) parts.push(`${a.mealPlanApCount} AP`);
    if (a.mealPlanOthersCount > 0) parts.push(`${a.mealPlanOthersCount} Others`);
    return parts.length > 0 ? parts.join(" · ") : "None";
  };
  const describeOccupants = (a: (typeof entry.roomAssignments)[number]): string => {
    if (a.occupantCount == null && a.adultCount == null) return fallbackOccupants;
    const adults = a.adultCount ?? 0;
    const kids = (a.cnb6To10Count ?? 0) + (a.cnbUnder6Count ?? 0);
    return `${adults} adult${adults === 1 ? "" : "s"}${kids > 0 ? `, ${kids} child${kids === 1 ? "" : "ren"}` : ""}`;
  };
  const describeExtraBeds = (a: (typeof entry.roomAssignments)[number]): string =>
    a.extraBedCount && a.extraBedCount > 0
      ? `${a.extraBedCount} extra bed${a.extraBedCount === 1 ? "" : "s"}`
      : "None";

  for (const a of entry.roomAssignments) {
    // Determine the nights this assignment covers.
    const aStart = a.startDate ?? checkIn;
    const aEnd = a.endDate ?? checkOut;
    const aNights = Math.max(1, Math.round((aEnd.getTime() - aStart.getTime()) / 86_400_000));
    for (let i = 0; i < aNights; i++) {
      bookingRows.push({
        date: new Date(aStart.getTime() + i * 86_400_000),
        roomNo: a.room.roomNumber ?? "",
        occupants: describeOccupants(a),
        mealPlan: describeMealPlan(a),
        extraBeds: describeExtraBeds(a),
      });
    }
  }
  // Defensive: if no assignments at all, emit one blank row per night so the voucher still
  // has something in the booking table (matches legacy behaviour for empty bookings).
  if (bookingRows.length === 0) {
    for (let i = 0; i < nights; i++) {
      bookingRows.push({
        date: new Date(checkIn.getTime() + i * 86_400_000),
        roomNo: "",
        occupants: fallbackOccupants,
        mealPlan: "None",
        extraBeds: "None",
      });
    }
  }

  const now = new Date();
  // A3 Confirmation Voucher, house format (docs/bills). Re check-in / re check-out are real rows
  // in the new template and simply omitted for a single-block stay.
  const roomsSummary = bookingRows.length
    ? [
        bookingRows.map((r) => r.roomNo).filter(Boolean).join(", ") || null,
        bookingRows.find((r) => r.mealPlan)?.mealPlan ?? null,
        `${nights} night${nights === 1 ? "" : "s"} total`,
      ]
        .filter(Boolean)
        .join(" · ")
    : `${nights} night${nights === 1 ? "" : "s"} total`;

  const html = renderLegphelConfirmationVoucherHtml({
    masthead: mastheadFromHotelProfile(hotel),
    voucherNo: reservation.id,
    bookingRef: entry.inquiryId,
    date: formatDocDate(reservation.confirmedAt ?? now),
    guest: guestFullName,
    bookedBy: contactPersonName || null,
    checkIn: formatDocDateTime(checkIn, "14:00"),
    checkOut: formatDocDateTime(checkOut, "12:00"),
    // Split stay — still deferred pending the multi-entry booking design (see
    // docs/pdf-bill-generation-todo.md #1). Null keeps the reference's single-block shape.
    reCheckIn: null,
    reCheckOut: null,
    roomAndPlan: roomsSummary,
    advanceReceiptRef: null,
    advanceHeld: formatMoney(0),
    balanceAtCheckout: formatMoney(0),
    closingNote:
      `Inclusions per plan · Wi-Fi · parking. Early check-in and late check-out subject to ` +
      `availability. Please carry photo ID for all adult guests. ${DEFAULT_POLICIES.cancellation}`,
    tariffVersion: "T1.0",
  });

  const bytes = await renderHtmlToPdf(html);
  const checksum = hashSha256(bytes);
  const storageKey = buildStorageKey(
    "confirmation-voucher",
    `${entry.inquiryId}-v${1}`, // Reservation has no versionNumber; increment via reservation.confirmedAt-tied version later.
    now,
  );
  await writeDocument(storageKey, bytes);

  await prisma.$transaction(async (tx) => {
    await tx.reservation.update({
      where: { id: reservation.id },
      data: {
        confirmationVoucherStorageKey: storageKey,
        confirmationVoucherChecksum: checksum,
        confirmationVoucherChecksumAlgo: "SHA-256",
        confirmationVoucherRenderedAt: now,
        confirmationVoucherRenderedBy: actorId,
        confirmationVoucherInputSnapshot: {
          documentTitle: "CONFIRMATION VOUCHER",
          bookingReference: entry.inquiryId,
          guestName: guestFullName,
          contactPersonName,
          confirmationByName: confirmationBy,
          checkIn: checkIn.toISOString(),
          checkOut: checkOut.toISOString(),
          nights,
          bookingRows: bookingRows.map((r) => ({
            date: r.date.toISOString(),
            roomNo: r.roomNo,
            occupants: r.occupants,
            mealPlan: r.mealPlan,
            extraBeds: r.extraBeds,
          })),
          policies: DEFAULT_POLICIES,
          hotel: {
            hotelName: hotel.hotelName,
            registeredAddress: hotel.registeredAddress,
            primaryEmail: hotel.primaryEmail,
            phone: hotelPhone,
          },
        } as any,
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "RESERVATION.CONFIRMATION_VOUCHER_PDF_GENERATED",
        actorId,
        actorLevel: "SYSTEM",
        entityType: "Reservation",
        entityId: reservation.id,
        operation: "CREATE",
        timestamp: now,
        entryId: entry.id,
        payload: {
          reservationId: reservation.id,
          bookingReference: entry.inquiryId,
          storageKey,
          checksum,
          checksumAlgo: "SHA-256",
          byteLength: bytes.byteLength,
        },
        createdBy: actorId,
      } as any,
    });
  });
  return {
    storageKey,
    checksum,
    bytes,
    filename: `${entry.inquiryId}-confirmation-voucher.pdf`,
  };
}
