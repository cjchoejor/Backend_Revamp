import { Prisma, PartyType } from "@prisma/client";
import type { Entry, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry, requireActiveConfigValue } from "../../lib/config-store.js";
import { queryAvailability as availabilityEngineQuery } from "../../engines/availability-engine.js";
import { enforceAvailabilityQueryParamsForS1 } from "../../policies/01-availability/p01-availability-query-params-s1.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { resolveIndicativePricingForS1Availability } from "../../policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s1-indicative.js";
import { resolveAgentRate } from "../../lib/agent-rate-resolution.js";
import {
  committedHoldSpans,
  pendingStayExtensionClaims,
  reservedEntryRoomsSelect,
  roomsClaimedByReservedEntry,
  stillHoldsInventory,
} from "../../lib/entry-inventory-claim.js";
import { annotateDeficientRoomSurface } from "../../policies/19-deficient-condition/p02-deficient-condition-surface-policy.js";
import {
  createQuotedSpaceAllocationForAvailabilityQuery,
  isConferenceLikeUseType,
} from "./space-allocation-service.js";

type ActorLevel = "L1" | "L2" | "L3" | "L4" | "SYSTEM";

/** The indicative-pricing chip shape the S1 availability result carries (mirrors p19's chip). */
type IndicativeChip = {
  rateAmount: number;
  currency: string;
  stayNights: number;
  lineTotalIndicative: number;
  source?: string;
  disclaimer: "INDICATIVE_ONLY_NO_QUOTATION";
};

/**
 * Resolve the negotiated party (travel agent / corporate account) linked to the entry's inquiry,
 * so S1 indicative pricing can reflect the contracted rate instead of the hotel's standard plan.
 * Returns null when the inquiry has no linked party (walk-in / direct) — caller falls back to p19.
 */
async function resolvePartyForEntryInquiry(
  prisma: PrismaClient,
  inquiryId?: string | null,
): Promise<{ partyType: PartyType; partyId: string } | null> {
  if (!inquiryId) return null;
  const inq = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    select: { travelAgentId: true, corporateAccountId: true },
  });
  if (!inq) return null;
  if (inq.travelAgentId) return { partyType: PartyType.TRAVEL_AGENT, partyId: inq.travelAgentId };
  if (inq.corporateAccountId) return { partyType: PartyType.CORPORATE, partyId: inq.corporateAccountId };
  return null;
}

/**
 * Shared engine run for new queries and stale-configuration recall (SIG §6.3).
 * Exported for cross-segment recall (`segment-recall-service`), which revalidates a prior
 * segment's configuration against present state (Canon Block 10 §59).
 */
export async function runAvailabilityEngineForEntry(
  prisma: PrismaClient,
  entry: Pick<Entry, "id" | "guestCount" | "useType" | "otaSource" | "inquiryId">,
  input: { roomTypeId?: string; checkInDate: string; checkOutDate: string; guestCount?: number; useType?: string },
  actorLevel: ActorLevel,
) {
  const { checkIn, checkOut, guestCount: guestCountResolved } = enforceAvailabilityQueryParamsForS1({
    checkInDate: input.checkInDate,
    checkOutDate: input.checkOutDate,
    guestCount: input.guestCount ?? entry.guestCount,
  });

  const shadowRules = await requireActiveConfigValue<any[]>(prisma, "availability.shadowInventory.visibilityRules");
  const bookablePhysicalStates = await requireActiveConfigValue<any>(prisma, "availability.bookablePhysicalStates").catch(() => ["FREE"]);

  const rooms = await prisma.room.findMany({
    orderBy: { roomNumber: "asc" },
    include: { roomType: { select: { name: true } } },
  });
  const spaces = await prisma.space.findMany({ orderBy: { code: "asc" } });

  // Fetch existing bookings + committed holds that intersect the query range. Used by the
  // engine to compute a per-date breakdown so the S1 calendar can render per-night cells.
  // Excludes the current entry so re-searching an already-sealed booking doesn't mark its
  // own rooms as occupied.
  //
  // 2026-07-24: pulls entry.id (readable ENT-…), entry.inquiryId (readable INQ-…) and the
  // guest's first + last name so the frontend can show WHO holds each occupied room, not
  // just that it's taken. Both queries carry the same enrichment shape so the fan-out below
  // can be uniform.
  //
  // 2026-07-25: also pulls guest email/phone and the linked travel agent / corporate account
  // (name + contact) so the S1 calendar hover can show the operator who to contact about the
  // blocking booking.
  const contactSelect = {
    id: true,
    inquiryId: true,
    contactPersonName: true,
    contactPersonPhone: true,
    guestProfile: {
      select: { firstName: true, lastName: true, email: true, phone: true },
    },
    inquiry: {
      select: {
        travelAgent: { select: { displayName: true, contactNumber: true, contactEmail: true } },
        corporateAccount: { select: { displayName: true, contactNumber: true, contactEmail: true } },
      },
    },
  } as const;

  const [reservations, committedHolds, speculativeHolds] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        frozenCheckInDate: { lt: checkOut },
        frozenCheckOutDate: { gt: checkIn },
        NOT: { entryId: entry.id },
        // A cancelled / expired / checked-out booking has let its rooms go.
        entry: { ...stillHoldsInventory },
      },
      select: {
        frozenCheckInDate: true,
        frozenCheckOutDate: true,
        entryId: true,
        entry: {
          select: {
            ...contactSelect,
            ...reservedEntryRoomsSelect,
            // Confirmed with the advance still short (2026-08-07) — surfaces the booking as
            // "Held · payment pending" instead of fully Reserved. Blocks identically.
            reservationPaymentPending: true,
          },
        },
      },
    }),
    prisma.committedHold.findMany({
      where: {
        // Not narrowed by roomId — a multi-room hold names only its primary room there, and its
        // other rooms live in the per-night breakdown. `committedHoldSpans` resolves both.
        state: { in: ["PLACED", "CONFIRMED"] },
        NOT: { entryId: entry.id },
        expiresAt: { gt: new Date() },
        entry: {
          ...stillHoldsInventory,
          checkInDate: { lt: checkOut },
          checkOutDate: { gt: checkIn },
        },
      },
      select: {
        roomId: true,
        entryId: true,
        perNightBreakdown: true,
        entry: {
          select: {
            ...contactSelect,
            checkInDate: true,
            checkOutDate: true,
          },
        },
      },
    }),
    /**
     * Speculative holds (S2) block too — added 2026-08-04.
     *
     * They were queried by neither the search nor the S3 gate, so a room could carry a live
     * speculative hold and still be offered as free. Two operators quoting different guests at
     * the same time would each place a hold on the same room and both walk into S3, where the
     * first committed hold wins and the second booking has to be unpicked in front of a guest.
     * A speculative hold is a weaker claim than a committed one, but it is still a claim, and
     * the point of showing it is precisely to stop the second operator taking the room.
     */
    prisma.speculativeHold.findMany({
      where: {
        state: "PLACED",
        NOT: { entryId: entry.id },
        expiresAt: { gt: new Date() },
        entry: {
          ...stillHoldsInventory,
          checkInDate: { lt: checkOut },
          checkOutDate: { gt: checkIn },
        },
      },
      select: {
        // The release route for a speculative hold is keyed by hold id, so carry it through —
        // without it the desk can show the hold but has no way to act on it.
        id: true,
        roomId: true,
        // The whole sealed selection the hold covers (2026-08-06) — one hold can pin several
        // rooms, each over its own nights; `roomId` alone is just the anchor.
        perNightBreakdown: true,
        entryId: true,
        expiresAt: true,
        entry: {
          select: {
            ...contactSelect,
            checkInDate: true,
            checkOutDate: true,
          },
        },
      },
    }),
  ]);

  /** Compose "First Last" or fall back to "Guest" when both names are missing. */
  const guestNameOf = (g: { firstName?: string | null; lastName?: string | null } | null | undefined) => {
    if (!g) return "Guest";
    const combined = [g.firstName, g.lastName].filter((v): v is string => !!v?.trim()).join(" ").trim();
    return combined || "Guest";
  };

  /**
   * Common contact-context extractor for both Reservation and CommittedHold entry payloads.
   * Guest phone falls back to Entry.contactPersonPhone (the on-site contact captured at intake)
   * when the guest profile has none. Agent info comes from the inquiry's linked travel-agent
   * or corporate account — exactly one of those is populated per Phase-C wiring.
   */
  const contextFromEntry = (
    e:
      | (Partial<{
          contactPersonName: string | null;
          contactPersonPhone: string | null;
          guestProfile: { firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null } | null;
          inquiry: {
            travelAgent: { displayName: string; contactNumber?: string | null; contactEmail?: string | null } | null;
            corporateAccount: { displayName: string; contactNumber?: string | null; contactEmail?: string | null } | null;
          } | null;
        }>)
      | null
      | undefined,
  ) => {
    const guest = e?.guestProfile ?? null;
    const guestPhone = guest?.phone ?? e?.contactPersonPhone ?? null;
    const guestEmail = guest?.email ?? null;
    const ta = e?.inquiry?.travelAgent;
    const ca = e?.inquiry?.corporateAccount;
    if (ta) {
      return {
        guestName: guestNameOf(guest),
        guestPhone,
        guestEmail,
        agentType: "TRAVEL_AGENT" as const,
        agentName: ta.displayName,
        agentPhone: ta.contactNumber ?? null,
        agentEmail: ta.contactEmail ?? null,
      };
    }
    if (ca) {
      return {
        guestName: guestNameOf(guest),
        guestPhone,
        guestEmail,
        agentType: "CORPORATE" as const,
        agentName: ca.displayName,
        agentPhone: ca.contactNumber ?? null,
        agentEmail: ca.contactEmail ?? null,
      };
    }
    return {
      guestName: guestNameOf(guest),
      guestPhone,
      guestEmail,
      agentType: null,
      agentName: null,
      agentPhone: null,
      agentEmail: null,
    };
  };

  // Fan out reservations to (roomId, start, end, contact-context) tuples. Rooms come from the
  // assignments once they exist, and from the committed hold before that — a reservation made
  // at S4 has no assignments until pre-arrival, and without the fallback its rooms went
  // unblocked the moment the hold's TTL lapsed.
  const reservedBlockages = reservations.flatMap((r) =>
    roomsClaimedByReservedEntry(r.entry).map((roomId) => ({
      roomId,
      startDate: r.frozenCheckInDate,
      endDate: r.frozenCheckOutDate,
      source: "RESERVED" as const,
      // Confirmed while the advance was still short — the desk labels these nights
      // "Held · payment pending" rather than "Reserved". Same block either way.
      paymentPending: (r.entry as { reservationPaymentPending?: boolean } | null)?.reservationPaymentPending === true,
      entryId: r.entryId,
      entryReferenceNumber: r.entry?.inquiryId ?? null,
      ...contextFromEntry(r.entry),
    })),
  );
  // A confirmed booking keeps its CommittedHold row, so the same room can arrive twice — once
  // reserved, once held. Consumers key occupancy by room and take the last writer, so an
  // unfiltered hold would relabel a confirmed booking as "Held". Reservation is the stronger
  // claim and the later stage, so it wins and the duplicate hold is dropped.
  const reservedRoomIds = new Set(reservedBlockages.map((b) => `${b.entryId}:${b.roomId}`));
  // Claims rank RESERVED > COMMITTED hold > SPECULATIVE hold. One booking can carry all three
  // for the same room, and it is one occupancy — report only the strongest.
  // A committed hold covers the (room, night) pairs in its sealed per-night breakdown — every
  // room it pinned, on the nights it pinned them — not just its primary room across the whole
  // stay. See `committedHoldSpans` for the two faults that produced.
  const committedSpans = committedHolds
    .filter((h) => h.entry?.checkInDate && h.entry?.checkOutDate)
    .flatMap((h) =>
      committedHoldSpans(h, { checkIn: h.entry!.checkInDate!, checkOut: h.entry!.checkOutDate! })
        .filter((s) => !reservedRoomIds.has(`${h.entryId}:${s.roomId}`))
        .map((s) => ({
          roomId: s.roomId,
          startDate: s.startDate,
          endDate: s.endDate,
          source: "HOLD" as const,
          holdKind: "COMMITTED" as const,
          entryId: h.entryId,
          entryReferenceNumber: h.entry?.inquiryId ?? null,
          ...contextFromEntry(h.entry),
        })),
    );
  const strongerClaim = new Set(reservedRoomIds);
  for (const s of committedSpans) strongerClaim.add(`${s.entryId}:${s.roomId}`);
  // Pending stay extensions (2026-08-21) — the nights after a checkout a guest is extending
  // into, held while the interim payment comes in. Same standing as a committed hold; not
  // deduped against the entry's reservation (different nights, both real).
  const extensionSpans = (await pendingStayExtensionClaims(prisma, { checkIn, checkOut, excludeEntryId: entry.id })).map((x) => ({
    roomId: x.roomId,
    startDate: x.startDate,
    endDate: x.endDate,
    source: "HOLD" as const,
    holdKind: "COMMITTED" as const,
    entryId: x.entryId,
    entryReferenceNumber: x.entry?.inquiryId ?? null,
    ...contextFromEntry(x.entry as Parameters<typeof contextFromEntry>[0]),
  }));
  const roomBlockages = [
    ...reservedBlockages,
    ...committedSpans,
    ...extensionSpans,
    // Weakest claim, so it is added last and skipped wherever a stronger one already covers the
    // same room: a reservation or committed hold on the entry supersedes its speculative one.
    // Spans resolve like committed holds (2026-08-06): the per-night snapshot when present —
    // every room the hold pinned, on the nights it pinned them — else the anchor room across
    // the entry's stay.
    ...speculativeHolds
      .filter((h) => h.entry?.checkInDate && h.entry?.checkOutDate)
      .flatMap((h) =>
        committedHoldSpans(h, { checkIn: h.entry!.checkInDate!, checkOut: h.entry!.checkOutDate! })
          .filter((s) => !strongerClaim.has(`${h.entryId}:${s.roomId}`))
          .map((s) => ({
            roomId: s.roomId,
            startDate: s.startDate,
            endDate: s.endDate,
            source: "HOLD" as const,
            holdKind: "SPECULATIVE" as const,
            holdId: h.id,
            holdExpiresAt: h.expiresAt,
            entryId: h.entryId,
            entryReferenceNumber: h.entry?.inquiryId ?? null,
            ...contextFromEntry(h.entry),
          })),
      ),
  ];

  const engineRaw = availabilityEngineQuery({
    checkInDate: checkIn,
    checkOutDate: checkOut,
    roomTypeId: input.roomTypeId,
    guestCount: guestCountResolved,
    useType: (input.useType as any) ?? entry.useType,
    otaSource: entry.otaSource,
    guestTier: "STANDARD",
    actorLevel,
    shadowInventoryRules: shadowRules ?? [],
    bookablePhysicalStates,
    rooms: rooms.map((r) => ({
      id: r.id,
      roomNumber: r.roomNumber,
      roomTypeId: r.roomTypeId,
      roomTypeName: r.roomType?.name ?? null,
      capacity: r.capacity,
      currentClaimState: r.currentClaimState,
      isShadowInventory: (r as any).isShadowInventory === true,
      isDeficient: r.isDeficient,
      deficientConditionCategory: r.deficientConditionCategory,
      isUnderMaintenance: r.isUnderMaintenance,
      maintenanceDeadline: r.maintenanceDeadline,
      isBlocked: r.isBlocked,
      blockedReason: r.blockedReason,
    })),
    spaces: spaces.map((s) => ({ id: s.id, spaceName: s.name, defaultCapacity: s.defaultCapacity, isAvailable: s.isAvailable, isEventInProgress: s.isEventInProgress })),
    roomBlockages,
    currentTimestamp: new Date(),
  });

  // Standard (rack) indicative from the hotel's rate plans — used as the fallback and for walk-ins.
  const indicative = await resolveIndicativePricingForS1Availability(prisma, { checkIn, checkOut }, input.roomTypeId);

  // Contracted-rate override (SIG-S1 §1.6 indicative; Phase B RateCard): if the inquiry is linked to
  // a travel agent or corporate account, surface that party's negotiated per-room-type rate instead
  // of the flat rack plan. Resolved once per distinct room type present in the result.
  const party = await resolvePartyForEntryInquiry(prisma, entry.inquiryId);
  const stayNights = Math.max(1, Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86_400_000));
  const agentChipByRoomType = new Map<string, IndicativeChip>();
  if (party) {
    const distinctTypes = new Set<string>();
    for (const r of [...engineRaw.availableRooms, ...engineRaw.deficientRooms] as any[]) {
      if (r.roomTypeId) distinctTypes.add(r.roomTypeId as string);
    }
    for (const roomTypeId of distinctTypes) {
      const br = await resolveAgentRate(prisma, { partyType: party.partyType, partyId: party.partyId, roomTypeId });
      if (br) {
        agentChipByRoomType.set(roomTypeId, {
          rateAmount: br.roomRate,
          currency: br.currency,
          stayNights,
          lineTotalIndicative: br.roomRate * stayNights,
          source: "AGENT_RATE_CARD",
          disclaimer: "INDICATIVE_ONLY_NO_QUOTATION",
        });
      }
    }
  }

  // Per-room indicative: contracted rate for the room's type when available, else the rack indicative.
  const chipForRoom = (r: any): IndicativeChip | null =>
    (r.roomTypeId ? agentChipByRoomType.get(r.roomTypeId) : null) ?? (indicative as IndicativeChip | null);
  const attachPricing = (rooms: any[]) =>
    rooms.map((r) => {
      const chip = chipForRoom(r);
      return chip ? { ...r, pricingIndicative: chip } : r;
    });

  // Top-level banner: representative contracted rate when agent-linked (falls back to rack).
  const topIndicative =
    (party && agentChipByRoomType.size > 0
      ? agentChipByRoomType.get((engineRaw.availableRooms[0] as any)?.roomTypeId) ??
        agentChipByRoomType.values().next().value
      : null) ?? indicative ?? null;

  const engineOutRaw =
    indicative || agentChipByRoomType.size > 0
      ? {
          ...engineRaw,
          availableRooms: attachPricing(engineRaw.availableRooms as any[]),
          deficientRooms: attachPricing(engineRaw.deficientRooms as any[]),
        }
      : engineRaw;

  const engineOut = {
    ...engineOutRaw,
    availableRooms: annotateDeficientRoomSurface(engineOutRaw.availableRooms as any),
    unavailableRooms: annotateDeficientRoomSurface(engineOutRaw.unavailableRooms as any),
    deficientRooms: annotateDeficientRoomSurface(engineOutRaw.deficientRooms as any),
  };

  const resultForApi = {
    ...engineOut,
    ...(topIndicative ? { indicativePricing: topIndicative } : {}),
    availableRooms: engineOut.availableRooms.map((r: any) => ({ ...r, roomId: r.inventoryId })),
    unavailableRooms: engineOut.unavailableRooms.map((r: any) => ({ ...r, roomId: r.inventoryId })),
    deficientRooms: engineOut.deficientRooms.map((r: any) => ({ ...r, roomId: r.inventoryId })),
  };

  return { engineOut, resultForApi, checkIn, checkOut, guestCount: guestCountResolved };
}

async function resolveConferenceSpaceTurnaroundBufferMinutes(prisma: PrismaClient): Promise<number> {
  const row = await getActiveConfigEntry(prisma, "availability.conferenceSpace.turnaroundBufferMinutes");
  const v = row?.configValue;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 120;
}

export async function queryAvailability(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  actorLevel: ActorLevel,
  input: {
    roomTypeId?: string;
    checkInDate: string;
    checkOutDate: string;
    guestCount?: number;
    useType?: string;
    spaceId?: string;
    seatingConfig?: string;
  },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } },
  });
  if (!entry) throw new NotFoundError("Entry");
  // Sealed records are read-only — no fresh availability work on an expired/cancelled/closed booking.
  enforceEntryNotSealedForWorkingAction({ status: entry.status });

  const { engineOut, resultForApi, checkIn, checkOut, guestCount } = await runAvailabilityEngineForEntry(prisma, entry, input, actorLevel);
  const segmentId = entry.segments[0]?.id ?? null;
  const effectiveUse = String(input.useType ?? entry.useType);
  const spaceId = input.spaceId?.trim();
  const wantsSpaceAlloc = isConferenceLikeUseType(effectiveUse) && !!spaceId;

  if (wantsSpaceAlloc) {
    const bufferMinutes = await resolveConferenceSpaceTurnaroundBufferMinutes(prisma);
    const seatingConfig = (input.seatingConfig?.trim() || "STANDARD").trim();
    return prisma.$transaction(async (tx) => {
      const cfg = await tx.availabilityConfiguration.create({
        data: {
          entryId,
          segmentId,
          searchCriteria: { ...input },
          resultSet: engineOut as any,
          createdBy: actorId,
        },
      });
      const spaceAllocation = await createQuotedSpaceAllocationForAvailabilityQuery(tx, {
        entryId,
        segmentId,
        spaceId: spaceId!,
        windowStart: checkIn,
        windowEnd: checkOut,
        attendeeCount: guestCount,
        seatingConfig,
        actorId,
        bufferMinutes,
        currentStage: entry.currentStage,
      });
      return { configuration: cfg, result: resultForApi, spaceAllocation };
    });
  }

  const cfg = await prisma.availabilityConfiguration.create({
    data: {
      entryId,
      segmentId,
      searchCriteria: { ...input },
      resultSet: engineOut as any,
      createdBy: actorId,
    },
  });
  return { configuration: cfg, result: resultForApi };
}

export function getAvailabilityConfigurationDto(cfg: {
  id: string;
  entryId: string;
  searchCriteria: unknown;
  optionSelected: unknown;
  isStale: boolean;
  stalenessAt: Date | null;
  deficientAcknowledgements: unknown;
  sealedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: cfg.id,
    entryId: cfg.entryId,
    searchCriteria: cfg.searchCriteria,
    optionSelected: cfg.optionSelected,
    isStale: cfg.isStale,
    stalenessAt: cfg.stalenessAt?.toISOString() ?? null,
    deficientAcknowledgements: cfg.deficientAcknowledgements,
    sealedAt: cfg.sealedAt?.toISOString() ?? null,
    createdAt: cfg.createdAt.toISOString(),
  };
}

export async function getConfiguration(prisma: PrismaClient, configurationId: string) {
  const cfg = await prisma.availabilityConfiguration.findUnique({ where: { id: configurationId } });
  if (!cfg) throw new NotFoundError("AvailabilityConfiguration");
  return getAvailabilityConfigurationDto(cfg);
}

/**
 * Re-runs the availability engine for a **stale** configuration, persists the new result set,
 * clears prior selection, and clears the stale flag (SIG §6.3 `recallConfiguration`).
 */
export async function recallConfiguration(prisma: PrismaClient, configurationId: string, actorId: string, actorLevel: ActorLevel) {
  const cfg = await prisma.availabilityConfiguration.findUnique({
    where: { id: configurationId },
    include: { entry: { include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } } } },
  });
  if (!cfg) throw new NotFoundError("AvailabilityConfiguration");
  if (!cfg.isStale) {
    throw new ValidationError("configuration is not stale; recall applies only to stale configurations");
  }
  // This path REWRITES the configuration in place (clearing its selection and stale flag), so it
  // must never be pointed at a configuration belonging to an earlier, sealed segment — that would
  // mutate sealed commercial history, the pattern the segment model exists to prevent
  // (Implementation Reference §6.6; Canon Block 10 §59 M.9 "the recalled configuration is not
  // modified"). Cross-segment reuse goes through `segment-recall-service` instead, which derives
  // a NEW configuration on the current segment.
  const currentSegmentId = cfg.entry.segments[0]?.id ?? null;
  if (cfg.segmentId && currentSegmentId && cfg.segmentId !== currentSegmentId) {
    throw new ValidationError(
      "That configuration belongs to an earlier segment and is read-only. Use the segment-reuse route (POST /api/entries/:id/segments/:segmentNumber/recall) to revalidate it onto the current segment.",
    );
  }

  const sc = (cfg.searchCriteria ?? {}) as Record<string, unknown>;
  const input = {
    roomTypeId: sc.roomTypeId as string | undefined,
    checkInDate: String(sc.checkInDate ?? ""),
    checkOutDate: String(sc.checkOutDate ?? ""),
    guestCount: typeof sc.guestCount === "number" ? sc.guestCount : sc.guestCount != null ? Number(sc.guestCount) : undefined,
    useType: typeof sc.useType === "string" ? sc.useType : undefined,
    spaceId: typeof sc.spaceId === "string" ? sc.spaceId : undefined,
    seatingConfig: typeof sc.seatingConfig === "string" ? sc.seatingConfig : undefined,
  };
  if (!input.checkInDate?.trim() || !input.checkOutDate?.trim()) {
    throw new ValidationError("searchCriteria missing checkInDate/checkOutDate");
  }

  const { engineOut, resultForApi, checkIn, checkOut, guestCount } = await runAvailabilityEngineForEntry(prisma, cfg.entry, input, actorLevel);
  const resultSetPersisted = { ...engineOut, isRevalidationRequired: true };
  const resultForClient = { ...resultForApi, isRevalidationRequired: true };

  const bufferMinutes = await resolveConferenceSpaceTurnaroundBufferMinutes(prisma);
  const effectiveUse = String(input.useType ?? cfg.entry.useType);
  const spaceIdTrim = input.spaceId?.trim() ?? "";
  const wantsSpaceAlloc = isConferenceLikeUseType(effectiveUse) && !!spaceIdTrim;
  const seatingConfig = (input.seatingConfig?.trim() || "STANDARD").trim();
  const segmentId = cfg.entry.segments[0]?.id ?? null;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.availabilityConfiguration.update({
      where: { id: configurationId },
      data: {
        resultSet: resultSetPersisted as any,
        isStale: false,
        stalenessAt: null,
        optionSelected: Prisma.DbNull,
        deficientAcknowledgements: Prisma.DbNull,
      },
    });

    let spaceAllocation;
    if (wantsSpaceAlloc) {
      spaceAllocation = await createQuotedSpaceAllocationForAvailabilityQuery(tx, {
        entryId: cfg.entryId,
        segmentId,
        spaceId: spaceIdTrim,
        windowStart: checkIn,
        windowEnd: checkOut,
        attendeeCount: guestCount,
        seatingConfig,
        actorId,
        bufferMinutes,
        currentStage: cfg.entry.currentStage,
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "AVAILABILITY_CONFIGURATION_RECALLED",
        actorId,
        actorLevel,
        entityType: "AvailabilityConfiguration",
        entityId: configurationId,
        operation: "UPDATE",
        timestamp: new Date(),
        entryId: cfg.entryId,
        payload: { configurationId, entryId: cfg.entryId },
        createdBy: actorId,
      },
    });

    return {
      configuration: updated,
      result: resultForClient,
      ...(spaceAllocation ? { spaceAllocation } : {}),
    };
  });
}

export async function selectOption(
  prisma: PrismaClient,
  configId: string,
  actorId: string,
  input: {
    roomId?: string;
    roomIds?: string[];
    perNight?: Array<{ date: string; roomIds: string[] }>;
    deficientAcknowledgements?: unknown;
  },
) {
  const cfg = await prisma.availabilityConfiguration.findUnique({ where: { id: configId } });
  if (!cfg) throw new NotFoundError("AvailabilityConfiguration");
  if (cfg.isStale) throw new ValidationError("configuration is stale");
  // Sealed records are read-only — a selection can't be recorded against an expired/cancelled/
  // closed booking (reported: room selection saved onto an EXPIRED entry from the desk).
  const owningEntry = await prisma.entry.findUnique({ where: { id: cfg.entryId }, select: { status: true } });
  if (!owningEntry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: owningEntry.status });

  // Normalise the three input shapes into a single flat list of distinct room ids to validate
  // and a normalised `perNight` list (empty if the caller didn't use that shape). Downstream
  // storage picks the richest shape available:
  //   - perNight provided → { perNight: [...], isDeficient }
  //   - roomIds provided  → { roomIds: [{ roomId, isDeficient }, ...], isDeficient }
  //   - roomId  provided  → { roomId, isDeficient }  (legacy)
  let normalisedPerNight: Array<{ date: string; roomIds: string[] }> = [];
  let rawIds: string[] = [];
  if (input.perNight && input.perNight.length > 0) {
    // Dedup within each night; collect union across nights for the resultSet validation.
    const unique = new Set<string>();
    normalisedPerNight = input.perNight.map((n) => {
      const distinct = Array.from(new Set(n.roomIds.map((r) => r.trim()).filter(Boolean)));
      distinct.forEach((id) => unique.add(id));
      return { date: n.date, roomIds: distinct };
    });
    rawIds = Array.from(unique);
  } else if (input.roomIds && input.roomIds.length > 0) {
    rawIds = input.roomIds;
  } else if (input.roomId) {
    rawIds = [input.roomId];
  }
  const selectedRoomIds = Array.from(new Set(rawIds.map((r) => r.trim()).filter(Boolean)));
  if (selectedRoomIds.length === 0) throw new ValidationError("At least one roomId is required");

  // Load all selected rooms once + compute per-room deficient status. Fetched BEFORE the
  // availability guard so a rejection can name the room the operator clicked ("Room 307") rather
  // than an opaque id.
  const rooms = await prisma.room.findMany({
    where: { id: { in: selectedRoomIds } },
    include: { deficientConditionRecords: true },
  });
  if (rooms.length !== selectedRoomIds.length) throw new NotFoundError("Room");
  const roomLabel = (id: string) => rooms.find((r) => r.id === id)?.roomNumber ?? id;

  // Guard: each selection must be present in the persisted resultSet and not in the
  // unavailable bucket. Fail-fast per id so the operator sees exactly which one's bad.
  const rs = (cfg.resultSet ?? {}) as any;
  const availableIds = new Set<string>(
    [...(rs.availableRooms ?? []), ...(rs.deficientRooms ?? [])].map((r: any) => r.inventoryId ?? r.roomId),
  );
  const unavailableById = new Map<string, any>(
    (rs.unavailableRooms ?? []).map((r: any) => [r.inventoryId ?? r.roomId, r]),
  );

  /**
   * A PER-NIGHT selection is validated night by night — the whole-stay buckets cannot answer it.
   *
   * The whole-range buckets say "usable for the WHOLE stay", so a room held on one night of four
   * lands in `unavailableRooms` even though it is free on the other three. Validating a per-night
   * payload against them rejected exactly the booking the desk is built to express: room 502 for
   * four nights, 307 for the first three, 304 for the last. The engine's own `perDate` breakdown
   * is the authority for "free on THIS night" — the same source the S1 table renders its cells
   * from, so what the operator was offered and what the save accepts cannot disagree.
   *
   * Rooms absent from `perDate` entirely (BLOCKED / MAINTENANCE / physically not ready — the
   * engine only carries available, deficient and CLAIMED rooms into the breakdown) fall through
   * to the whole-stay check below and are still refused. Same for configurations persisted
   * before the breakdown existed: no `perDate` → the original whole-stay rule stands.
   */
  const perDateRows: any[] = Array.isArray(rs.perDate) ? rs.perDate : [];
  const perDateByDate = new Map<string, { free: Set<string>; occupied: Map<string, any> }>(
    perDateRows.map((d: any) => [
      String(d.date).slice(0, 10),
      {
        free: new Set<string>([...(d.availableRoomIds ?? []), ...(d.deficientRoomIds ?? [])]),
        occupied: new Map<string, any>((d.occupiedRoomIds ?? []).map((o: any) => [o.roomId, o])),
      },
    ]),
  );

  /** Ids the per-night pass cleared, and ids it could not answer for on at least one night. */
  const clearedPerNight = new Set<string>();
  const unresolvedPerNight = new Set<string>();
  if (normalisedPerNight.length > 0 && perDateByDate.size > 0) {
    for (const night of normalisedPerNight) {
      const row = perDateByDate.get(String(night.date).slice(0, 10));
      if (!row) {
        // Night outside the searched window — no per-date truth for it, so every room claimed on
        // it must still satisfy the whole-stay rule below.
        night.roomIds.forEach((id) => unresolvedPerNight.add(id));
        continue;
      }
      for (const id of night.roomIds) {
        if (row.free.has(id)) {
          clearedPerNight.add(id);
          continue;
        }
        const occ = row.occupied.get(id);
        if (occ) {
          const holder = occ.guestName ?? occ.agentName ?? null;
          throw new ValidationError(
            `Room ${roomLabel(id)} is not free on ${String(night.date).slice(0, 10)} — ${
              occ.source === "HOLD" ? "held" : "reserved"
            }${holder ? ` by ${holder}` : ""}${occ.entryReferenceNumber ? ` (${occ.entryReferenceNumber})` : ""}. Pick another room for that night.`,
          );
        }
        // Not free, not occupied on this night → not in the breakdown at all. Leave it to the
        // whole-stay guard, which names the engine's own reason (BLOCKED, MAINTENANCE, …).
        unresolvedPerNight.add(id);
      }
    }
  }

  for (const id of selectedRoomIds) {
    // Already proven free on every night it was actually claimed for.
    if (clearedPerNight.has(id) && !unresolvedPerNight.has(id)) continue;
    if (unavailableById.has(id)) {
      const u = unavailableById.get(id);
      throw new ValidationError(
        `Room ${roomLabel(id)} is not selectable (unavailableReason=${u.unavailabilityReason ?? "UNKNOWN"})`,
      );
    }
    if (!availableIds.has(id)) {
      throw new ValidationError(
        `Room ${roomLabel(id)} must be selected from the persisted AvailabilityConfiguration resultSet`,
      );
    }
  }
  const perRoom = selectedRoomIds.map((id) => {
    const room = rooms.find((r) => r.id === id)!;
    const isDeficient = (room.deficientConditionRecords ?? []).some((d) => d.status !== "RESOLVED");
    return { roomId: id, isDeficient };
  });

  const anyDeficient = perRoom.some((r) => r.isDeficient);
  if (anyDeficient && !input.deficientAcknowledgements) {
    throw new ValidationError("deficientAcknowledgements is required when any selected room is DEFICIENT");
  }

  // Per-night specific validation. Every night must have the same number of picks (matching
  // entry.numberOfRooms). Cover all nights of the stay — no gaps. Same room can be repeated
  // across nights (guest staying in room 201 all week) but not within one night (that would
  // be a duplicate assignment).
  if (normalisedPerNight.length > 0) {
    const entry = await prisma.entry.findUnique({
      where: { id: cfg.entryId },
      select: { numberOfRooms: true, checkInDate: true, checkOutDate: true },
    });
    if (!entry) throw new NotFoundError("Entry");
    const requiredRooms = entry.numberOfRooms ?? normalisedPerNight[0].roomIds.length;
    for (const n of normalisedPerNight) {
      if (n.roomIds.length !== requiredRooms) {
        throw new ValidationError(
          `Night ${n.date} has ${n.roomIds.length} rooms selected; expected ${requiredRooms} (matching Entry.numberOfRooms).`,
        );
      }
    }
    // Verify all stay nights are covered. Skip if either check-in or check-out is missing —
    // rare but possible for pre-Phase-D entries; we can't derive expected nights without them.
    if (entry.checkInDate && entry.checkOutDate) {
      const expected: string[] = [];
      const cur = new Date(entry.checkInDate.getTime());
      const end = new Date(entry.checkOutDate.getTime());
      while (cur < end) {
        expected.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
        if (expected.length > 365) break;
      }
      const supplied = new Set(normalisedPerNight.map((n) => n.date));
      const missing = expected.filter((d) => !supplied.has(d));
      if (missing.length > 0) {
        throw new ValidationError(`perNight is missing selections for ${missing.length} night(s): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
      }
    }
  }

  return prisma.$transaction(async (tx) => {
    // Storage shape picked from richest → simplest:
    //   1) perNight given → `{ perNight: [{ date, roomIds: [{ roomId, isDeficient }] }], isDeficient }`
    //      — the operator committed to specific rooms per night; supports mid-stay room
    //      changes (e.g. room 201 for night 1, room 301 for night 2).
    //   2) roomIds given → `{ roomIds: [{ roomId, isDeficient }, ...] }` — same rooms all nights.
    //   3) single roomId → legacy `{ roomId, isDeficient }` shape preserved.
    const deficientLookup = new Map(perRoom.map((r) => [r.roomId, r.isDeficient]));
    let optionSelected: Record<string, unknown>;
    if (normalisedPerNight.length > 0) {
      optionSelected = {
        perNight: normalisedPerNight.map((n) => ({
          date: n.date,
          roomIds: n.roomIds.map((id) => ({ roomId: id, isDeficient: deficientLookup.get(id) === true })),
        })),
        isDeficient: anyDeficient,
      };
    } else if (perRoom.length === 1) {
      optionSelected = { roomId: perRoom[0].roomId, isDeficient: perRoom[0].isDeficient };
    } else {
      optionSelected = { roomIds: perRoom, isDeficient: anyDeficient };
    }

    const updated = await tx.availabilityConfiguration.update({
      where: { id: configId },
      data: {
        optionSelected: optionSelected as Prisma.InputJsonValue,
        deficientAcknowledgements: anyDeficient ? (input.deficientAcknowledgements as any) : null,
        // Saving a selection IS the seal — this is the only route that records one, and every
        // downstream consumer looks for `sealedAt != null && optionSelected != null`:
        // s2-quotation-service (both entry points) and its p01 gate, s3-hold-service,
        // room-assignment-service and rate-reference-service. Nothing anywhere else in the
        // backend ever set this column, so a booking whose rooms were saved from the desk had
        // `sealedAt` null and could not be quoted at all (NO_PREFERRED_CONFIGURATION), could not
        // place a committed hold, and returned no reference rates. Re-saving re-stamps it; the
        // room-change path in entry-lifecycle-state-machine deliberately clears it back to null.
        sealedAt: new Date(),
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "CONFIGURATION_SELECTED",
        actorId,
        actorLevel: "L1",
        entityType: "AvailabilityConfiguration",
        entityId: configId,
        operation: "UPDATE",
        timestamp: new Date(),
        entryId: cfg.entryId,
        payload: {
          configId,
          roomIds: perRoom.map((r) => r.roomId),
          ...(normalisedPerNight.length > 0 ? { perNight: normalisedPerNight } : {}),
        },
        createdBy: actorId,
      },
    });
    return updated;
  });
}

