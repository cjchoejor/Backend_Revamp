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

/**
 * When the entry entered / left a stage, from StageDwellRecords (first entry, last exit — an
 * entry that re-visited a stage via backflow shows the full span). `exitedAt` null = still there.
 */
export type SectionTimeline = { enteredAt: string | null; exitedAt: string | null };

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
    timeline: SectionTimeline;
    /** When the inquiry was taken and by whom (staff name when resolvable, else actor id). */
    receivedAt: string | null;
    takenBy: string | null;
    /** How many availability searches were run before the selection was sealed. */
    availabilitySearches: number;
    selectionSealedAt: string | null;
    selectionSealedBy: string | null;
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
    timeline: SectionTimeline;
    hasAcceptedQuotation: boolean;
    /** Total quotation versions issued across the negotiation (supersedes included). */
    versionsIssued: number;
    reference: string | null;
    versionNumber: number | null;
    state: string | null;
    draftedAt: string | null;
    draftedBy: string | null;
    sentAt: string | null;
    sentTo: string | null;
    /** Structured view of commercialTerms.requestedDiscount (raw blob stays in discountRequested). */
    discount: { percent: number; basis: string | null } | null;
    /** Structured view of commercialTerms.agentRate (raw blob stays in agentRate). */
    agentRateDetail: { partyType: string | null; roomRate: number | null; cnbPercent: number | null; source: string | null } | null;
    /** Latest speculative hold placed during the negotiation, if any. */
    speculativeHold: { state: string; roomNumber: string | null; placedAt: string | null; expiresAt: string | null } | null;
    acceptedByName: string | null;
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
    timeline: SectionTimeline;
    billingModel: string | null;
    folioState: string | null;
    committedHold: {
      state: string | null;
      rooms: RoomRef[];
      expiresAt: string | null;
      placedAt: string | null;
      placedBy: string | null;
      justification: string | null;
    } | null;
    advancePayment: {
      satisfied: boolean;
      requiredAmount: number | null;
      totalReceived: number | null;
      shortfall: number | null;
      creditExtensionActive: boolean;
      ceilingAmount: number | null;
      /** Where the required amount came from: operator-pinned for this booking, or config thresholds. */
      requirementSource: "OPERATOR" | "CONFIG" | null;
      requirementBasis: unknown | null;
      creditExtensionExpiresAt: string | null;
      creditExtensionExpired: boolean;
      groupBoostApplied: { multiplierPercent: number; baseAmount: number } | null;
      /** The advance is due between proforma dispatch (opensAt) and check-in (deadline). */
      advanceWindow: { opensAt: string | null; deadline: string | null; active: boolean; overdue: boolean } | null;
    } | null;
    /** Individual advance payments received (IN direction) — amounts are DB values, never re-summed. */
    payments: Array<{
      id: string;
      amount: number | null;
      method: string | null;
      receivedAt: string | null;
      recordedBy: string | null;
      notes: string | null;
    }>;
    cancellation: { disclosed: boolean; noShowTreatment: string | null; disclosedAt: string | null; disclosedBy: string | null } | null;
    proformaInvoiceRef: string | null;
    /** The live proforma in full (priorVersions counts superseded re-issues). */
    proforma: {
      id: string;
      invoiceNumber: string | null;
      versionNumber: number;
      state: string;
      totalAmount: number | null;
      createdAt: string | null;
      dispatchedAt: string | null;
      dispatchedTo: string | null;
      priorVersions: number;
    } | null;
    coordinator: string | null;
  };

  s4Confirmation: {
    status: SectionStatus;
    timeline: SectionTimeline;
    confirmed: boolean;
    reservationId: string | null;
    frozenRate: number | null;
    frozenRatePlanId: string | null;
    frozenBillingModel: string | null;
    frozenCheckIn: string | null;
    frozenCheckOut: string | null;
    frozenNights: number | null;
    frozenGuestCount: number | null;
    creditCeilingIfExtended: number | null;
    confirmedAt: string | null;
    confirmedBy: string | null;
    confirmedByName: string | null;
    voucherSent: boolean;
    voucherRenderedAt: string | null;
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
          travelAgent: { select: { id: true, displayName: true, contactNumbers: true, contactEmail: true } },
          corporateAccount: {
            select: { id: true, displayName: true, contactNumbers: true, contactEmail: true, gstNumber: true, coordinators: true, contractRefs: true },
          },
        },
      },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      availabilityConfigs: { orderBy: { createdAt: "desc" } },
      quotations: { orderBy: { versionNumber: "desc" }, include: { lines: { orderBy: { createdAt: "asc" } } } },
      speculativeHolds: { orderBy: { placedAt: "desc" }, take: 1, include: { room: { select: { roomNumber: true } } } },
      folio: {
        include: {
          invoices: { orderBy: { createdAt: "desc" } },
          payments: { orderBy: { createdAt: "asc" } },
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

  // --- Per-stage timeline from StageDwellRecords: first entry, last exit ----------------------
  const dwells = await prisma.stageDwellRecord.findMany({
    where: { entryId },
    orderBy: { enteredAt: "asc" },
    select: { stage: true, enteredAt: true, exitedAt: true },
  });
  const timelineFor = (stage: "S1" | "S2" | "S3" | "S4"): SectionTimeline => {
    const rows = dwells.filter((d) => d.stage === stage);
    if (rows.length === 0) return { enteredAt: null, exitedAt: null };
    const last = rows[rows.length - 1];
    return { enteredAt: iso(rows[0].enteredAt), exitedAt: last.exitedAt ? iso(last.exitedAt) : null };
  };

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

  // Structured views of the commercialTerms blobs the desk actually renders (the raw blobs stay
  // on the payload for consumers that want everything).
  const discountRaw = (terms?.requestedDiscount ?? null) as Record<string, unknown> | null;
  const discount =
    discountRaw && num(discountRaw.discountPercent) != null
      ? { percent: num(discountRaw.discountPercent)!, basis: typeof discountRaw.discountBasis === "string" ? discountRaw.discountBasis : null }
      : null;
  const agentRateRaw = (terms?.agentRate ?? null) as Record<string, unknown> | null;
  const agentRateDetail = agentRateRaw
    ? {
        partyType: typeof agentRateRaw.partyType === "string" ? agentRateRaw.partyType : null,
        roomRate: num(agentRateRaw.roomRate),
        cnbPercent: num(agentRateRaw.cnbPercent),
        source: typeof agentRateRaw.source === "string" ? agentRateRaw.source : null,
      }
    : null;
  const specHold = entry.speculativeHolds[0] ?? null;

  // --- S3: individual advance payments (IN direction) — DB rows, never re-summed here ---------
  const paymentsIn = (entry.folio?.payments ?? []).filter((p) => p.paymentDirection === "IN");

  // --- Proformas: the live one (non-superseded) + how many re-issues preceded it --------------
  const proformas = entry.folio?.invoices.filter((i) => i.invoiceType === "PROFORMA") ?? [];
  const liveProforma = proformas.find((i) => i.state !== "SUPERSEDED") ?? proformas[0] ?? null;

  // --- Resolve every actor id we surface to a staff name in ONE query -------------------------
  const actorIds = Array.from(
    new Set(
      [
        entry.inquiry?.createdBy,
        sealedConfig?.createdBy,
        acceptedQuote?.createdBy,
        acceptedQuote?.acceptedBy,
        entry.committedHold?.placedBy,
        entry.cancellationDisclosure?.disclosedBy,
        entry.reservation?.confirmedBy,
        ...paymentsIn.map((p) => p.recordedBy),
      ].filter((x): x is string => typeof x === "string" && x.length > 0),
    ),
  );
  const staffRows = actorIds.length
    ? await prisma.staffUser.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } })
    : [];
  const staffNameById = new Map(staffRows.map((s) => [s.id, s.fullName]));
  const who = (id: string | null | undefined): string | null => (id ? staffNameById.get(id) ?? id : null);

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
        requirementSource: ps.requirementSource ?? null,
        requirementBasis: ps.requirementBasis ?? null,
        creditExtensionExpiresAt: ps.creditExtensionExpiresAt ?? null,
        creditExtensionExpired: ps.creditExtensionExpired ?? false,
        groupBoostApplied: (ps as { groupBoostApplied?: { multiplierPercent: number; baseAmount: number } }).groupBoostApplied ?? null,
        advanceWindow: ps.advanceWindow ?? null,
      };
    } catch {
      // Missing advancePayment.thresholds config etc. — leave null rather than fail the summary.
      advancePayment = null;
    }
  }

  const billingModel = entry.folio?.billingModelTransitions[0]?.toModel ?? entry.folio?.billingModel ?? null;
  const proforma = liveProforma;

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
      timeline: timelineFor("S1"),
      receivedAt: iso(inq?.createdAt),
      takenBy: who(inq?.createdBy),
      availabilitySearches: entry.availabilityConfigs.length,
      selectionSealedAt: iso(sealedConfig?.sealedAt),
      selectionSealedBy: who(sealedConfig?.createdBy),
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
      timeline: timelineFor("S2"),
      hasAcceptedQuotation: entry.quotations.some((q) => q.state === "ACCEPTED"),
      versionsIssued: entry.quotations.length,
      reference: acceptedQuote?.referenceNumber ?? null,
      versionNumber: acceptedQuote?.versionNumber ?? null,
      state: acceptedQuote?.state ?? null,
      draftedAt: iso(acceptedQuote?.createdAt),
      draftedBy: who(acceptedQuote?.createdBy),
      sentAt: iso(acceptedQuote?.sentAt),
      sentTo: acceptedQuote?.sentTo ?? null,
      discount,
      agentRateDetail,
      speculativeHold: specHold
        ? {
            state: specHold.state,
            roomNumber: specHold.room?.roomNumber ?? null,
            placedAt: iso(specHold.placedAt),
            expiresAt: iso(specHold.expiresAt),
          }
        : null,
      acceptedByName: who(acceptedQuote?.acceptedBy),
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
      timeline: timelineFor("S3"),
      billingModel,
      folioState: entry.folio?.state ?? null,
      committedHold: entry.committedHold
        ? {
            state: entry.committedHold.state,
            rooms: holdRoomIds.length ? Array.from(new Set(holdRoomIds)).map(refFor) : [],
            expiresAt: iso(entry.committedHold.expiresAt),
            placedAt: iso(entry.committedHold.placedAt),
            placedBy: who(entry.committedHold.placedBy),
            justification:
              entry.committedHold.commercialJustification && entry.committedHold.commercialJustification !== "seed"
                ? entry.committedHold.commercialJustification
                : null,
          }
        : null,
      advancePayment,
      payments: paymentsIn.map((p) => ({
        id: p.id,
        amount: money(p.amount),
        method: p.paymentMethod ?? null,
        receivedAt: iso(p.receivedAt ?? p.createdAt),
        recordedBy: who(p.recordedBy),
        notes: p.notes ?? null,
      })),
      cancellation: entry.cancellationDisclosure
        ? {
            disclosed: true,
            noShowTreatment: entry.cancellationDisclosure.noShowTreatmentStatement ?? null,
            disclosedAt: iso(entry.cancellationDisclosure.disclosedAt),
            disclosedBy: who(entry.cancellationDisclosure.disclosedBy),
          }
        : null,
      proformaInvoiceRef: proforma?.id ?? null,
      proforma: proforma
        ? {
            id: proforma.id,
            invoiceNumber: proforma.invoiceNumber ?? null,
            versionNumber: proforma.versionNumber,
            state: proforma.state,
            totalAmount: money(proforma.totalAmount ?? null),
            createdAt: iso(proforma.createdAt),
            dispatchedAt: iso(proforma.dispatchedAt),
            dispatchedTo: proforma.dispatchedTo ?? null,
            priorVersions: Math.max(0, proformas.length - 1),
          }
        : null,
      coordinator,
    },

    s4Confirmation: {
      status: stageStatus(entry.currentStage, "S4"),
      timeline: timelineFor("S4"),
      confirmed: !!res,
      reservationId: res?.id ?? null,
      frozenRate: money(res?.frozenRate ?? null),
      frozenRatePlanId: res?.frozenRatePlanId ?? null,
      frozenBillingModel: res?.frozenBillingModel ?? null,
      frozenCheckIn: iso(res?.frozenCheckInDate),
      frozenCheckOut: iso(res?.frozenCheckOutDate),
      frozenNights: nightsBetween(res?.frozenCheckInDate, res?.frozenCheckOutDate),
      frozenGuestCount: res?.frozenGuestCount ?? null,
      creditCeilingIfExtended: money(res?.creditCeilingIfExtended ?? null),
      confirmedAt: iso(res?.confirmedAt),
      confirmedBy: res?.confirmedBy ?? null,
      confirmedByName: who(res?.confirmedBy),
      voucherSent: res?.confirmationVoucherSent ?? false,
      voucherRenderedAt: iso(res?.confirmationVoucherRenderedAt),
    },
  };
}
