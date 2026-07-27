import type { Prisma, PrismaClient } from "@prisma/client";
import type { EntryStatus, EntryUseType, GroupBillingMode, Stage } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { getPaymentStatus } from "./s3-payment-service.js";

/**
 * BOOKING JOURNEY SUMMARY (a.k.a. the "S1–S4 handoff summary").
 *
 * A read-only, staff-facing recap of everything the customer chose or did across the pre-stay
 * lifecycle — Inquiry (S1) → Quote (S2) → Set up (S3) → Confirmation (S4). It is a pure
 * aggregation over records that already exist; it stores nothing and computes no new business
 * outcome. Every figure is sourced from an existing spec-backed record so the summary can never
 * disagree with the system of record:
 *
 *   - S1  Inquiry / Entry / AvailabilityConfiguration.optionSelected  (SIG-S1 §1.4)
 *   - S2  Quotation.commercialTerms + QuotationLine                   (SIG-S2 §2.2)
 *   - S3  Folio / CommittedHold / CancellationDisclosureRecord / advance-payment status (SIG-S3 §1.5)
 *   - S4  Reservation frozen commitment snapshot                       (SIG-S4 §2.1)
 *
 * NOTE ON NAMING: this is deliberately NOT a `HandoffRecord`. The H1–H5 handoffs are *departmental*
 * obligation transfers (Reservations→Front-Desk, Front-Desk→Housekeeping, …). This is a
 * *customer-journey* recap and shares nothing with that machinery.
 *
 * MONEY: all money is read from the DB (Decimal, computed server-side) and returned as numbers so
 * the desk can render it directly — no arithmetic on the frontend (see CLAUDE.md money rule).
 */

type Db = PrismaClient;

/**
 * READY = the entry is still ON this stage but every piece of evidence the stage needs is
 * already in place — "done, awaiting the transition". Distinguished from IN_PROGRESS so the
 * desk can say "Ready to confirm" instead of a misleading "In progress" once the operator
 * has finished the S3 checklist but hasn't frozen yet.
 */
export type SectionStatus = "COMPLETE" | "READY" | "IN_PROGRESS" | "NOT_STARTED";

export type RoomRef = { roomId: string; roomNumber: string | null; roomTypeCode: string | null; roomTypeName: string | null };

export interface BookingJourneySummary {
  entryId: string;
  inquiryReference: string | null;
  generatedAt: string;
  currentStage: Stage;
  status: EntryStatus;
  segmentNumber: number;
  useType: EntryUseType;
  groupBillingMode: GroupBillingMode | null;

  guest: {
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
    nationality: string | null;
    vipTier: string | null;
    clientTier: string | null;
  };

  s1Inquiry: {
    status: SectionStatus;
    sourceChannel: string | null;
    party: {
      adults: number | null;
      children: number | null;
      childAges: number[];
      totalGuests: number | null;
      roomsRequested: number | null;
    };
    dates: { checkIn: string | null; checkOut: string | null; nights: number | null };
    contactPerson: { name: string | null; phone: string | null };
    commercialContext: {
      type: "TRAVEL_AGENT" | "CORPORATE" | "NONE";
      partyName: string | null;
      coordinator: string | null;
      contractRef: string | null;
      gstNumber: string | null;
    };
    roomSelection: {
      shape: "single" | "whole-stay-multi" | "per-night" | "none";
      rooms: RoomRef[];
      perNight: Array<{ date: string; rooms: RoomRef[] }> | null;
      distinctRoomCount: number;
      anyDeficient: boolean;
    };
    notes: string | null;
  };

  s2Quote: {
    status: SectionStatus;
    hasAcceptedQuotation: boolean;
    reference: string | null;
    versionNumber: number | null;
    state: string | null;
    currency: string | null;
    nightlyRate: number | null;
    roomCount: number | null;
    nights: number | null;
    total: number | null;
    inclusions: string[];
    mealPlan: string | null;
    discountRequested: unknown | null;
    belowMsr: boolean | null;
    agentRate: unknown | null;
    standardPricing: unknown | null;
    focRoomsRequested: number | null;
    validUntil: string | null;
    acceptedAt: string | null;
    acceptedBy: string | null;
    lines: Array<{ date: string | null; occupants: string | null; mealPlan: string | null; extraBeds: string | null; amount: number | null }>;
  };

  s3Setup: {
    status: SectionStatus;
    billingModel: string | null;
    folioState: string | null;
    committedHold: { state: string | null; rooms: RoomRef[]; expiresAt: string | null } | null;
    advancePayment: {
      satisfied: boolean;
      requiredAmount: number | null;
      totalReceived: number | null;
      shortfall: number | null;
      creditExtensionActive: boolean;
      ceilingAmount: number | null;
    } | null;
    cancellation: { disclosed: boolean; noShowTreatment: string | null; disclosedAt: string | null } | null;
    proformaInvoiceRef: string | null;
    coordinator: string | null;
  };

  s4Confirmation: {
    status: SectionStatus;
    confirmed: boolean;
    reservationId: string | null;
    frozenRate: number | null;
    frozenRatePlanId: string | null;
    frozenBillingModel: string | null;
    frozenCheckIn: string | null;
    frozenCheckOut: string | null;
    frozenGuestCount: number | null;
    creditCeilingIfExtended: number | null;
    confirmedAt: string | null;
    confirmedBy: string | null;
    voucherSent: boolean;
  };
}

const STAGE_ORDER: Record<string, number> = {
  S1: 1, S2: 2, S3: 3, S4: 4, S5: 5, S6: 6, S7: 7, S8: 8, S9: 9, TERMINAL: 99,
};

/** COMPLETE if the entry has advanced past `stage`, IN_PROGRESS if it is on it, else NOT_STARTED. */
function stageStatus(currentStage: Stage, stage: "S1" | "S2" | "S3" | "S4"): SectionStatus {
  const cur = STAGE_ORDER[currentStage] ?? 0;
  const target = STAGE_ORDER[stage];
  if (cur > target) return "COMPLETE";
  if (cur === target) return "IN_PROGRESS";
  return "NOT_STARTED";
}

function money(d: Prisma.Decimal | number | null | undefined): number | null {
  if (d == null) return null;
  const n = Number(d.toString());
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function nightsBetween(checkIn: Date | null | undefined, checkOut: Date | null | undefined): number | null {
  if (!checkIn || !checkOut) return null;
  const ms = checkOut.getTime() - checkIn.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / 86_400_000);
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Mirror of s4-confirmation-service.getNightlyRate — reads the per-night rate from commercialTerms. */
function nightlyRateFromTerms(terms: Record<string, unknown> | null): number | null {
  if (!terms) return null;
  const keys = ["nightlyRate", "rate", "effectiveRate", "resolvedNightlyRate", "resolvedRateAmount"] as const;
  for (const k of keys) {
    const n = num(terms[k]);
    if (n != null) return n;
  }
  return null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x && "label" in x ? String((x as any).label) : String(x)));
}

/**
 * Build the S1–S4 booking journey summary for one entry. Read-only: one entry read, one rooms
 * read to resolve room numbers/types, and one advance-payment status computation (Decimal-safe,
 * reusing s3-payment-service — we never re-sum payments here).
 */
export async function buildBookingJourneySummary(prisma: Db, entryId: string): Promise<BookingJourneySummary> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      guestProfile: true,
      inquiry: {
        include: {
          guestProfile: true,
          travelAgent: { select: { id: true, displayName: true, contactNumber: true, contactEmail: true } },
          corporateAccount: {
            select: { id: true, displayName: true, contactNumber: true, contactEmail: true, gstNumber: true, coordinators: true, contractRefs: true },
          },
        },
      },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      availabilityConfigs: { orderBy: { createdAt: "desc" } },
      quotations: { orderBy: { versionNumber: "desc" }, include: { lines: { orderBy: { createdAt: "asc" } } } },
      folio: {
        include: {
          invoices: { orderBy: { createdAt: "desc" } },
          billingModelTransitions: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
      committedHold: true,
      cancellationDisclosure: true,
      reservation: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  const currentSegmentId = entry.segments[0]?.id ?? null;

  // --- S1: sealed room selection -------------------------------------------------------------
  // Use the most recent availability config that actually has a sealed selection.
  const sealedConfig = entry.availabilityConfigs.find((c) => c.optionSelected != null) ?? null;
  const sel = readOptionSelected(sealedConfig?.optionSelected ?? null);

  // Resolve every room id we reference (S1 selection + S3 committed hold) in ONE query.
  const holdSel = readOptionSelected(entry.committedHold?.perNightBreakdown ?? null);
  const holdRoomIds = [
    ...(entry.committedHold?.roomId ? [entry.committedHold.roomId] : []),
    ...holdSel.distinctRoomIds,
  ];
  const allRoomIds = Array.from(new Set([...sel.distinctRoomIds, ...holdRoomIds]));
  const roomRows = allRoomIds.length
    ? await prisma.room.findMany({
        where: { id: { in: allRoomIds } },
        select: { id: true, roomNumber: true, roomType: { select: { code: true, name: true } } },
      })
    : [];
  const roomMap = new Map<string, RoomRef>(
    roomRows.map((r) => [r.id, { roomId: r.id, roomNumber: r.roomNumber, roomTypeCode: r.roomType?.code ?? null, roomTypeName: r.roomType?.name ?? null }]),
  );
  const refFor = (id: string): RoomRef => roomMap.get(id) ?? { roomId: id, roomNumber: null, roomTypeCode: null, roomTypeName: null };

  const selectionShape: BookingJourneySummary["s1Inquiry"]["roomSelection"]["shape"] = sel.perNight
    ? "per-night"
    : sel.distinctRoomIds.length > 1
      ? "whole-stay-multi"
      : sel.distinctRoomIds.length === 1
        ? "single"
        : "none";

  // --- Commercial context (agent / corporate) ------------------------------------------------
  const inq = entry.inquiry;
  const ta = inq?.travelAgent ?? null;
  const corp = inq?.corporateAccount ?? null;
  let coordinator: string | null = inq?.corporateCoordinator ?? null;
  if (!coordinator && corp?.coordinators && Array.isArray(corp.coordinators) && corp.coordinators.length > 0) {
    const first = corp.coordinators[0] as any;
    coordinator = typeof first === "string" ? first : (first?.name ?? null);
  }
  const contractRef = inq?.corporateClientRef ?? (Array.isArray(corp?.contractRefs) ? corp?.contractRefs[0] ?? null : null);

  // --- S2: the quotation that represents the commercial outcome ------------------------------
  // Prefer the ACCEPTED quotation for the current segment; fall back to the latest version.
  const acceptedQuote =
    entry.quotations.find((q) => q.segmentId === currentSegmentId && q.state === "ACCEPTED") ??
    entry.quotations.find((q) => q.state === "ACCEPTED") ??
    entry.quotations[0] ??
    null;
  const terms = (acceptedQuote?.commercialTerms ?? null) as Record<string, unknown> | null;
  const pricingBreakdown = (terms?.pricingBreakdown ?? null) as Record<string, unknown> | null;

  // --- S3: advance-payment status (Decimal-safe, via the shared service) ---------------------
  let advancePayment: BookingJourneySummary["s3Setup"]["advancePayment"] = null;
  if (entry.folio) {
    try {
      const ps = await getPaymentStatus(prisma, { entryId, folioId: entry.folio.id });
      advancePayment = {
        satisfied: ps.satisfied,
        requiredAmount: ps.requiredAmount ?? null,
        totalReceived: ps.totalReceived ?? null,
        shortfall: ps.shortfall ?? null,
        creditExtensionActive: ps.creditExtensionActive,
        ceilingAmount: ps.ceilingAmount ?? null,
      };
    } catch {
      // Missing advancePayment.thresholds config etc. — leave null rather than fail the summary.
      advancePayment = null;
    }
  }

  const billingModel = entry.folio?.billingModelTransitions[0]?.toModel ?? entry.folio?.billingModel ?? null;
  const proforma = entry.folio?.invoices.find((i) => i.invoiceType === "PROFORMA") ?? null;

  const guest = entry.guestProfile ?? inq?.guestProfile ?? null;
  const guestName = guest ? [guest.firstName, guest.lastName].filter(Boolean).join(" ").trim() || null : null;

  const res = entry.reservation;

  return {
    entryId: entry.id,
    inquiryReference: inq?.referenceNumber ?? null,
    generatedAt: new Date().toISOString(),
    currentStage: entry.currentStage,
    status: entry.status,
    segmentNumber: entry.segmentNumber,
    useType: entry.useType,
    groupBillingMode: entry.groupBillingMode,

    guest: {
      name: guestName,
      firstName: guest?.firstName ?? null,
      lastName: guest?.lastName ?? null,
      phone: guest?.phone ?? null,
      email: guest?.email ?? null,
      nationality: guest?.nationality ?? null,
      vipTier: guest?.vipTier ?? null,
      clientTier: guest?.clientTier ?? null,
    },

    s1Inquiry: {
      status: stageStatus(entry.currentStage, "S1"),
      sourceChannel: inq?.sourceChannel ?? null,
      party: {
        adults: entry.adultCount ?? null,
        children: entry.childCount ?? null,
        childAges: entry.childAges ?? [],
        totalGuests: entry.guestCount ?? null,
        roomsRequested: entry.numberOfRooms ?? null,
      },
      dates: {
        checkIn: iso(entry.checkInDate),
        checkOut: iso(entry.checkOutDate),
        nights: nightsBetween(entry.checkInDate, entry.checkOutDate),
      },
      contactPerson: { name: entry.contactPersonName ?? null, phone: entry.contactPersonPhone ?? null },
      commercialContext: {
        type: ta ? "TRAVEL_AGENT" : corp ? "CORPORATE" : "NONE",
        partyName: ta?.displayName ?? corp?.displayName ?? null,
        coordinator,
        contractRef,
        gstNumber: corp?.gstNumber ?? null,
      },
      roomSelection: {
        shape: selectionShape,
        rooms: sel.distinctRoomIds.map(refFor),
        perNight: sel.perNight ? sel.perNight.map((n) => ({ date: n.date, rooms: n.roomIds.map(refFor) })) : null,
        distinctRoomCount: sel.distinctRoomIds.length,
        anyDeficient: sel.anyDeficient,
      },
      notes: inq?.notes ?? null,
    },

    s2Quote: {
      status: stageStatus(entry.currentStage, "S2"),
      hasAcceptedQuotation: entry.quotations.some((q) => q.state === "ACCEPTED"),
      reference: acceptedQuote?.referenceNumber ?? null,
      versionNumber: acceptedQuote?.versionNumber ?? null,
      state: acceptedQuote?.state ?? null,
      currency: acceptedQuote?.currency ?? null,
      nightlyRate: nightlyRateFromTerms(terms),
      roomCount: num(terms?.roomCount) ?? num(pricingBreakdown?.roomCount),
      nights: num(pricingBreakdown?.nights),
      total: money(acceptedQuote?.totalAmount ?? null),
      inclusions: asStringArray(terms?.inclusions),
      mealPlan: typeof terms?.mealPlan === "string" ? (terms.mealPlan as string) : null,
      discountRequested: terms?.requestedDiscount ?? null,
      belowMsr: typeof terms?.belowMsr === "boolean" ? (terms.belowMsr as boolean) : null,
      agentRate: terms?.agentRate ?? null,
      standardPricing: terms?.standardPricing ?? null,
      focRoomsRequested: num(terms?.focRoomsRequested),
      validUntil: iso(acceptedQuote?.validUntil),
      acceptedAt: iso(acceptedQuote?.acceptedAt),
      acceptedBy: acceptedQuote?.acceptedBy ?? null,
      lines: (acceptedQuote?.lines ?? []).map((l) => ({
        date: iso(l.date),
        occupants: l.occupants ?? null,
        mealPlan: l.mealPlan ?? null,
        extraBeds: l.extraBeds ?? null,
        amount: money(l.amount ?? null),
      })),
    },

    s3Setup: {
      // Upgrade IN_PROGRESS -> READY when all S3 evidence exists (mirrors the S4 confirm
      // gates: accepted quote, folio + billing model, disclosure, live hold, proforma —
      // plus the advance-payment condition when it is known).
      status: (() => {
        const base = stageStatus(entry.currentStage, "S3");
        if (base !== "IN_PROGRESS") return base;
        const holdLive = entry.committedHold?.state === "PLACED" || entry.committedHold?.state === "UPGRADED";
        const evidence =
          !!acceptedQuote &&
          !!entry.folio &&
          !!billingModel &&
          !!entry.cancellationDisclosure &&
          holdLive &&
          !!proforma &&
          (advancePayment == null || advancePayment.satisfied);
        return evidence ? "READY" : "IN_PROGRESS";
      })(),
      billingModel,
      folioState: entry.folio?.state ?? null,
      committedHold: entry.committedHold
        ? {
            state: entry.committedHold.state,
            rooms: holdRoomIds.length ? Array.from(new Set(holdRoomIds)).map(refFor) : [],
            expiresAt: iso(entry.committedHold.expiresAt),
          }
        : null,
      advancePayment,
      cancellation: entry.cancellationDisclosure
        ? {
            disclosed: true,
            noShowTreatment: entry.cancellationDisclosure.noShowTreatmentStatement ?? null,
            disclosedAt: iso(entry.cancellationDisclosure.disclosedAt),
          }
        : null,
      proformaInvoiceRef: proforma?.id ?? null,
      coordinator,
    },

    s4Confirmation: {
      status: stageStatus(entry.currentStage, "S4"),
      confirmed: !!res,
      reservationId: res?.id ?? null,
      frozenRate: money(res?.frozenRate ?? null),
      frozenRatePlanId: res?.frozenRatePlanId ?? null,
      frozenBillingModel: res?.frozenBillingModel ?? null,
      frozenCheckIn: iso(res?.frozenCheckInDate),
      frozenCheckOut: iso(res?.frozenCheckOutDate),
      frozenGuestCount: res?.frozenGuestCount ?? null,
      creditCeilingIfExtended: money(res?.creditCeilingIfExtended ?? null),
      confirmedAt: iso(res?.confirmedAt),
      confirmedBy: res?.confirmedBy ?? null,
      voucherSent: res?.confirmationVoucherSent ?? false,
    },
  };
}
