/**
 * Operational lookup endpoints — L1-accessible search for the front-desk inquiry intake form.
 *
 * These mirror the L4-only admin search routes (`/admin/travel-agents/search`, etc.) but with a
 * lower authority bar so a receptionist can look up a travel agent / corporate account when
 * taking a phone-call inquiry. Read-only.
 */
import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as travelAgentSvc from "../../services/admin/travel-agent-admin-service.js";
import * as corporateSvc from "../../services/admin/corporate-account-admin-service.js";
import { loadChildPolicyBundle } from "../../services/domain/child-policy-service.js";
import { computeChargeableOccupants, computeAllowedRoomCounts } from "../../services/domain/capacity-validation-service.js";

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
 *     must render (min = ceil(CO / maxCap), max = CO)
 *
 * Kept as an endpoint so ANY frontend (main testing UI + the friend's real UI) can consume
 * the same computation without duplicating the classification logic. Business logic — age
 * bands, occupancy math — lives here on the backend.
 *
 * Body: `{ adults, childAges: number[], maxCapacity? }`. Response: `{ chargeableOccupants,
 * allowedRoomCounts: { min, max }, bandBreakdown: { young, child, adult } }`.
 */
lookupsRouter.post("/lookups/allowed-room-counts", L1, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const adults = Number.isFinite(Number(body.adults)) ? Math.max(0, Number(body.adults)) : 0;
    const childAges = Array.isArray(body.childAges)
      ? body.childAges.map((a: unknown) => Number(a)).filter((n: number) => Number.isFinite(n) && n >= 0)
      : [];
    const maxCapacity = Number.isFinite(Number(body.maxCapacity)) ? Math.max(1, Number(body.maxCapacity)) : 3;
    const bundle = await loadChildPolicyBundle(prisma);
    const chargeableOccupants = computeChargeableOccupants({ adults, childAges }, bundle);
    const allowedRoomCounts = computeAllowedRoomCounts(chargeableOccupants, maxCapacity);
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
    res.json({ chargeableOccupants, allowedRoomCounts, bandBreakdown, maxCapacityUsed: maxCapacity });
  } catch (e) {
    next(e);
  }
});

lookupsRouter.get("/lookups/travel-agents/search", L1, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    res.json({ matches: await travelAgentSvc.searchTravelAgents(prisma, q) });
  } catch (e) { next(e); }
});

lookupsRouter.get("/lookups/corporate-accounts/search", L1, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    res.json({ matches: await corporateSvc.searchCorporateAccounts(prisma, q) });
  } catch (e) { next(e); }
});
