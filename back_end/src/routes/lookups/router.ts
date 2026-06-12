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

export const lookupsRouter = Router();
const L1 = requireActorLevel("L1");

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
