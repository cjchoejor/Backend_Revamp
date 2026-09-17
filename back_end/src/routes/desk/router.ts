/**
 * Reads for the redesigned desk (2026-09-17) — see services/domain/desk-read-service.ts.
 * All L1, all read-only.
 */
import { Router } from "express";
import { z } from "zod";
import { EntryStatus, Stage } from "@prisma/client";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { ValidationError } from "../../lib/errors.js";
import { hotelDayEndUtc } from "../../lib/stay-dates.js";
import {
  DESK_ACTIVITY_MAX,
  DESK_LIST_MAX,
  deskMoneyFor,
  listDeskActivity,
  listDeskBookings,
  listStaffNames,
} from "../../services/domain/desk-read-service.js";

export const deskRouter = Router();
const L1 = requireActorLevel("L1");

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(DESK_LIST_MAX).optional().default(DESK_LIST_MAX),
  status: z.nativeEnum(EntryStatus).optional(),
  stage: z.nativeEnum(Stage).optional(),
  guestProfileId: z.string().min(1).optional(),
});

/** Bookings for Today, Bookings and Billing — names, rooms and standings; no money. */
deskRouter.get("/bookings", L1, async (req, res, next) => {
  try {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.flatten());
    const items = await listDeskBookings(prisma, parsed.data);
    res.set("Cache-Control", "no-store").json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

const moneyBody = z.object({ entryIds: z.array(z.string().min(1)).min(1).max(100) });

/** The money line for many bookings at once — each the booking header's own billing summary. */
deskRouter.post("/bookings/money", L1, validateBody(moneyBody), async (req, res, next) => {
  try {
    const items = await deskMoneyFor(prisma, (req.body as z.infer<typeof moneyBody>).entryIds);
    res.set("Cache-Control", "no-store").json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

/** Staff names for attribution — who recorded what, who holds a booking. */
deskRouter.get("/staff", L1, async (_req, res, next) => {
  try {
    const items = await listStaffNames(prisma);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

const activityQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  actorId: z.string().min(1).optional(),
  entryId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(DESK_ACTIVITY_MAX).optional(),
});

/**
 * What happened on one hotel day, for the desk's read-only Audit. FOM and above: it names who
 * did what across every booking, which is supervision rather than front-desk work.
 */
deskRouter.get("/activity", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const parsed = activityQuery.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.flatten());
    const [y, m, d] = parsed.data.date.split("-").map(Number);
    // Noon UTC falls on the same calendar day at the hotel (UTC+6); the day ends at its midnight.
    const to = hotelDayEndUtc(new Date(Date.UTC(y, m - 1, d, 12)));
    const from = new Date(to.getTime() - 86_400_000);
    const items = await listDeskActivity(prisma, { ...parsed.data, from, to });
    res.set("Cache-Control", "no-store").json({ items, count: items.length, from, to });
  } catch (e) {
    next(e);
  }
});
