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
import { allocateReadableId } from "../../lib/readable-id.js";
import { labelRoomNights, roomNightsForEntry } from "../../lib/room-nights-for-entry.js";
import {
  buildStorageKey,
  documentExists,
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
import { formatDocDate, formatDocDateTime, formatDocDateLocal } from "../infrastructure/pdf-templates/legphel-document-format.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";
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
  /**
   * A deliberate re-make (the repair script): the file is rendered fresh and saved under the next
   * free name (`VOU-…-r2`, `-r3`) — stored files are write-once, so an earlier render stays on
   * disk as it was, and is never adopted in place of the new one.
   */
  opts?: { remake?: boolean },
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

  // Every voucher has its own number; one made without (an importer, a script) gets it now.
  let voucherNumber = reservation.confirmationVoucherNumber;
  if (!voucherNumber) {
    voucherNumber = await allocateReadableId(prisma, "VOUCHER", reservation.confirmedAt);
    await prisma.reservation.update({ where: { id: reservation.id }, data: { confirmationVoucherNumber: voucherNumber } });
  }

  // Idempotency
  if (reservation.confirmationVoucherStorageKey && reservation.confirmationVoucherChecksum) {
    const bytes = await readDocument(reservation.confirmationVoucherStorageKey);
    const bookingReference = reservation.entry.inquiryId ?? reservation.id;
    return {
      storageKey: reservation.confirmationVoucherStorageKey,
      checksum: reservation.confirmationVoucherChecksum,
      bytes,
      filename: `${voucherNumber}-confirmation-voucher.pdf`,
    };
  }

  const entry = reservation.entry;
  const hotel = await loadHotelProfileForRender(prisma);
  const hotelPhone = extractPrimaryPhone(hotel.contactNumbers);

  const guest = entry.guestProfile;
  // With the title the desk took at Inquiry (2026-10-28).
  const guestFullName = guestDisplayName(guest) || "Guest";
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
  // No rooms assigned yet — the normal case at Reserve, since rooms are assigned at Arrival: the
  // voucher names the rooms the reservation itself confirmed (its frozen compositions), each over
  // the nights the sealed pick holds it for (2026-10-13 — every voucher issued at Reserve read
  // "Room · plan: None").
  if (bookingRows.length === 0) {
    const comps = ((reservation.frozenCommercialTerms as { roomCompositions?: unknown } | null)?.roomCompositions ?? []) as Array<{
      roomId?: string;
      adultCount?: number | null;
      cnb6To10Count?: number | null;
      cnbUnder6Count?: number | null;
      mealPlanCpCount?: number | null;
      mealPlanMaplCount?: number | null;
      mealPlanMapdCount?: number | null;
      mealPlanApCount?: number | null;
      mealPlanOthersCount?: number | null;
      extraBedCount?: number | null;
    }>;
    if (Array.isArray(comps) && comps.length) {
      const roomIds = comps.map((c) => c.roomId).filter((x): x is string => !!x);
      const roomNo = new Map(
        (await prisma.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, roomNumber: true } })).map((r) => [r.id, r.roomNumber]),
      );
      const heldNights = await roomNightsForEntry(prisma, entry.id, { segmentId: reservation.segmentId, asOf: reservation.confirmedAt });
      const stayNights = Array.from({ length: nights }, (_, i) => new Date(checkIn.getTime() + i * 86_400_000).toISOString().slice(0, 10));
      for (const c of comps) {
        if (!c.roomId) continue;
        const asRow = {
          occupantCount: null,
          adultCount: c.adultCount ?? null,
          cnb6To10Count: c.cnb6To10Count ?? 0,
          cnbUnder6Count: c.cnbUnder6Count ?? 0,
          mealPlanCpCount: c.mealPlanCpCount ?? 0,
          mealPlanMaplCount: c.mealPlanMaplCount ?? 0,
          mealPlanMapdCount: c.mealPlanMapdCount ?? 0,
          mealPlanApCount: c.mealPlanApCount ?? 0,
          mealPlanOthersCount: c.mealPlanOthersCount ?? 0,
          extraBedCount: c.extraBedCount ?? 0,
        } as unknown as (typeof entry.roomAssignments)[number];
        for (const night of heldNights.get(c.roomId) ?? stayNights) {
          bookingRows.push({
            date: new Date(`${night}T00:00:00.000Z`),
            roomNo: roomNo.get(c.roomId) ?? "",
            occupants: describeOccupants(asRow),
            mealPlan: describeMealPlan(asRow),
            extraBeds: describeExtraBeds(asRow),
          });
        }
      }
      bookingRows.sort((a, b) => a.date.getTime() - b.date.getTime() || a.roomNo.localeCompare(b.roomNo, "en", { numeric: true }));
    }
  }
  // Defensive: nothing at all to describe — one blank row per night so the voucher still has
  // something in the booking table (matches legacy behaviour for empty bookings).
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
  // Each room once (the rows are one per room per night), and the plan only when the rooms share it.
  // When the rooms are not all held for the same nights (a stay that moves rooms), each room says
  // its nights — "302 · 13–15 Oct" — as the quotation's Nights column does.
  const roomsOnce = [...new Set(bookingRows.map((r) => r.roomNo).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const nightsOf = new Map(roomsOnce.map((no) => [no, bookingRows.filter((r) => r.roomNo === no).map((r) => r.date.toISOString().slice(0, 10))]));
  const nightsVary = new Set([...nightsOf.values()].map((n) => [...new Set(n)].sort().join(","))).size > 1;
  const roomWords = roomsOnce.map((no) => (nightsVary ? `${no} · ${labelRoomNights(nightsOf.get(no) ?? [])}` : no));
  const plans = [...new Set(bookingRows.map((r) => r.mealPlan).filter(Boolean))];
  const roomsSummary = bookingRows.length
    ? [
        roomsOnce.length ? `${roomsOnce.length === 1 ? "Room" : "Rooms"} ${roomWords.join(", ")}` : null,
        plans.length === 1 ? plans[0] : plans.length > 1 ? "meal plans per room" : null,
        `${nights} night${nights === 1 ? "" : "s"} total`,
      ]
        .filter(Boolean)
        .join(" · ")
    : `${nights} night${nights === 1 ? "" : "s"} total`;

  const html = renderLegphelConfirmationVoucherHtml({
    masthead: mastheadFromHotelProfile(hotel),
    voucherNo: voucherNumber,
    bookingRef: entry.inquiryId,
    date: formatDocDateLocal(reservation.confirmedAt ?? now),
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

  let bytes = await renderHtmlToPdf(html, { fitToPage: true });
  // Named by the voucher's own number (2026-10-13). It was `<enquiry>-v1`, the same for every
  // voucher of a booking and of every stay on its enquiry — so the first file was found and
  // adopted below by every later one, and a re-confirmed booking's voucher (a room move, a
  // re-entry, a return stay) carried the first voucher's rooms and dates.
  let storageKey = buildStorageKey("confirmation-voucher", voucherNumber, now);
  if (opts?.remake) {
    for (let n = 2; await documentExists(storageKey); n++) {
      storageKey = buildStorageKey("confirmation-voucher", `${voucherNumber}-r${n}`, now);
    }
  }
  // Orphan adoption (2026-08-07): before the immutability carve-out in db.ts, every voucher
  // render wrote its PDF to storage and THEN failed on the reservation.update — leaving a
  // write-once file with no DB pointer. The key is deterministic, so a retry would collide.
  // The reservation is immutable, so the orphan was rendered from the same data: adopt it as
  // the artifact rather than failing on the write-once guard. The key is this voucher's own,
  // so the file found is this voucher's.
  if (await documentExists(storageKey)) {
    bytes = await readDocument(storageKey);
  } else {
    await writeDocument(storageKey, bytes);
  }
  const checksum = hashSha256(bytes);

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
          voucherNumber,
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
          voucherNumber,
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
    filename: `${voucherNumber}-confirmation-voucher.pdf`,
  };
}
