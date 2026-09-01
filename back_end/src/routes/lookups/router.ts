/**
 * Operational lookup endpoints — L1-accessible search for the front-desk inquiry intake form.
 *
 * These mirror the L4-only admin search routes (`/admin/travel-agents/search`, etc.) but with a
 * lower authority bar so a receptionist can look up a travel agent / corporate account when
 * taking a phone-call inquiry. Read-only.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as travelAgentSvc from "../../services/admin/travel-agent-admin-service.js";
import * as corporateSvc from "../../services/admin/corporate-account-admin-service.js";
import { PARTY_LOOKUP_LIMIT } from "../../lib/admin/party-lookup.js";
import { loadChildPolicyBundle } from "../../services/domain/child-policy-service.js";
import { computeChargeableOccupants, computeAllowedRoomCounts, loadHotelInventorySnapshot } from "../../services/domain/capacity-validation-service.js";
import { listPackagesForParty } from "../../lib/rate-package-resolution.js";

export const lookupsRouter = Router();
const L1 = requireActorLevel("L1");

/**
 * Live snapshot of the child-policy bundle for the front-desk forms. The booking flow's child
 * age input reads `unaccompaniedMinorMinAge.minimumAge` so the visible cap stays in sync with
 * whatever the L4 admin has configured at /admin/policies — no hardcoded "17".
 */
lookupsRouter.get("/lookups/child-policy", L1, async (_req, res, next) => {
  try {
    const bundle = await loadChildPolicyBundle(prisma);
    res.json(bundle);
  } catch (e) { next(e); }
});

/**
 * Backend-authoritative capacity math for the S1 intake form. Given a proposed guest
 * composition + optional maxCapacity ceiling, returns:
 *   - `chargeableOccupants`: adults + children in the pricing ADULT band (>= childMaxAge+1)
 *   - `allowedRoomCounts`: `{ min, max }` envelope the operator's number-of-rooms dropdown
 *     must render (min = ceil(CO / maxCap), max = min(CO, registered rooms))
 *   - `hotelRoomCount` / `hotelMaxOccupants` / `exceedsHotelCapacity`: the live room-registry
 *     ceiling — a party larger than the hotel can sleep is flagged here AND rejected by the
 *     same check inside validateCapacity at create-entry time. Counts come from the Room /
 *     RoomType tables (never config), so admin room edits move them immediately.
 *
 * Kept as an endpoint so ANY frontend (main testing UI + the friend's real UI) can consume
 * the same computation without duplicating the classification logic. Business logic — age
 * bands, occupancy math — lives here on the backend.
 *
 * Body: `{ adults, childAges: number[], maxCapacity? }`. Response: `{ chargeableOccupants,
 * allowedRoomCounts: { min, max }, bandBreakdown: { young, child, adult }, maxCapacityUsed,
 * hotelRoomCount, hotelMaxOccupants, exceedsHotelCapacity }`.
 */
lookupsRouter.post("/lookups/allowed-room-counts", L1, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const adults = Number.isFinite(Number(body.adults)) ? Math.max(0, Number(body.adults)) : 0;
    const childAges = Array.isArray(body.childAges)
      ? body.childAges.map((a: unknown) => Number(a)).filter((n: number) => Number.isFinite(n) && n >= 0)
      : [];
    const bundle = await loadChildPolicyBundle(prisma);
    const hotelInventory = await loadHotelInventorySnapshot(prisma);
    // Default divisor = the largest maxCapacity across the hotel's room types — the SAME
    // fallback createEntry's validateCapacity uses, so the envelope this endpoint offers is
    // exactly the envelope the create-entry check accepts (was a hardcoded 3).
    let maxCapacity =
      body.maxCapacity != null && Number.isFinite(Number(body.maxCapacity)) ? Math.max(1, Number(body.maxCapacity)) : null;
    if (maxCapacity == null) {
      const largest = await prisma.roomType.aggregate({ _max: { maxCapacity: true } });
      maxCapacity = largest._max.maxCapacity ?? 3;
    }
    const chargeableOccupants = computeChargeableOccupants({ adults, childAges }, bundle);
    const allowedRoomCounts = computeAllowedRoomCounts(chargeableOccupants, maxCapacity, hotelInventory.bookableRoomCount);
    // Party physically can't fit: either it out-sleeps the whole hotel, or the minimum rooms
    // it needs exceeds the rooms that exist. Mirrors validateCapacity's OVER_HOTEL_CAPACITY /
    // empty-envelope BLOCKs so the form can refuse before the create call does.
    const exceedsHotelCapacity =
      chargeableOccupants > hotelInventory.maxSleepableOccupants ||
      (chargeableOccupants > 0 && allowedRoomCounts.min > allowedRoomCounts.max);
    // Extra transparency: give the caller the per-band breakdown so it can render its own
    // "1 adult, 2 kids under 11, 1 teen" hint without re-classifying ages client-side.
    const bandBreakdown = { young: 0, child: 0, adult: adults };
    const youngMax = bundle.ageBands.youngChildMaxAge;
    const childMax = bundle.ageBands.childMaxAge;
    for (const age of childAges) {
      if (age > childMax) bandBreakdown.adult++;
      else if (age > youngMax) bandBreakdown.child++;
      else bandBreakdown.young++;
    }
    res.json({
      chargeableOccupants,
      allowedRoomCounts,
      bandBreakdown,
      maxCapacityUsed: maxCapacity,
      hotelRoomCount: hotelInventory.bookableRoomCount,
      hotelMaxOccupants: hotelInventory.maxSleepableOccupants,
      exceedsHotelCapacity,
    });
  } catch (e) {
    next(e);
  }
});

// `limit` rides along so a caller can tell a capped list from a complete one without mirroring
// the number: receiving exactly `limit` rows means the roster was cut. A blank `q` lists all
// active parties, which is what lets the desk picker open as a browsable dropdown.
lookupsRouter.get("/lookups/travel-agents/search", L1, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    res.json({ matches: await travelAgentSvc.searchTravelAgents(prisma, q), limit: PARTY_LOOKUP_LIMIT });
  } catch (e) { next(e); }
});

lookupsRouter.get("/lookups/corporate-accounts/search", L1, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    res.json({ matches: await corporateSvc.searchCorporateAccounts(prisma, q), limit: PARTY_LOOKUP_LIMIT });
  } catch (e) { next(e); }
});

/**
 * Append a contact person to a standing party, at L1.
 *
 * Every other write to a TravelAgent / CorporateAccount is L4-only, deliberately — these carry the
 * negotiated rate cards. Appending a contact is the one carve-out: a new person at the agency comes
 * up during an intake call, and the number is only worth capturing if the operator taking the call
 * can store it. The authority granted is append-only — no rename, no removal, no touching any
 * commercial field — and each append is audited + snapshotted like any admin write, so an L4 can
 * see who added what and revert it from the Versions tab.
 *
 * Idempotent by phone: re-posting a number the party already has returns it with `added: false`.
 */
const addContactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(50).optional().nullable(),
  email: z.string().trim().max(200).optional().nullable(),
});

lookupsRouter.post(
  "/lookups/travel-agents/:id/contacts",
  L1,
  validateBody(addContactSchema),
  async (req, res, next) => {
    try {
      const result = await travelAgentSvc.addTravelAgentContact(
        prisma,
        req.params.id,
        req.body,
        req.actor!.actorId,
      );
      res.status(result.added ? 201 : 200).json({
        contact: result.contact,
        added: result.added,
        coordinators: result.agent.coordinators ?? [],
      });
    } catch (e) { next(e); }
  },
);

lookupsRouter.post(
  "/lookups/corporate-accounts/:id/contacts",
  L1,
  validateBody(addContactSchema),
  async (req, res, next) => {
    try {
      const result = await corporateSvc.addCorporateAccountContact(
        prisma,
        req.params.id,
        req.body,
        req.actor!.actorId,
      );
      res.status(result.added ? 201 : 200).json({
        contact: result.contact,
        added: result.added,
        coordinators: result.account.coordinators ?? [],
      });
    } catch (e) { next(e); }
  },
);

/**
 * The packages a party can be quoted on, for the S1 picker.
 *
 * L1 because front desk choose the package while taking the booking. The admin equivalent
 * (`/api/admin/rate-packages`) is L4 and also exposes history and the COMMON package; this one
 * returns only what is currently sellable for one party, default first.
 *
 * An empty list means the party has no package of its own — pricing falls back to the COMMON
 * package, so the desk should say so rather than block.
 */
lookupsRouter.get("/lookups/rate-packages", L1, async (req, res, next) => {
  try {
    const travelAgentId = typeof req.query.travelAgentId === "string" && req.query.travelAgentId ? req.query.travelAgentId : null;
    const corporateAccountId = typeof req.query.corporateAccountId === "string" && req.query.corporateAccountId ? req.query.corporateAccountId : null;
    const items = await listPackagesForParty(prisma, { travelAgentId, corporateAccountId });
    res.json({ items, count: items.length });
  } catch (e) { next(e); }
});
