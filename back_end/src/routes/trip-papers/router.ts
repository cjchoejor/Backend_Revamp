import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { readNightsMode } from "../../lib/room-nights-for-entry.js";
import {
  answerTripQuotation,
  describeTripQuotation,
  makeTripQuotation,
  renderTripQuotationHtml,
  renderTripQuotationPdf,
  sendTripQuotation,
} from "../../services/domain/trip-paper-service.js";

/**
 * A trip's quotation (2026-11-07): each stay keeps its own, and the trip has one made of them,
 * with a number and versions of its own. See trip-paper-service.ts.
 */
export const tripPapersRouter = Router();

const actorOf = (req: { actor?: { actorId: string; level: "L1" | "L2" | "L3" | "L4" } }) => ({
  actorId: req.actor!.actorId,
  actorLevel: req.actor!.level,
});

tripPapersRouter.get("/entries/:id/trip-quotation", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await describeTripQuotation(prisma, req.params.id));
  } catch (error) {
    next(error);
  }
});

tripPapersRouter.post("/entries/:id/trip-quotation", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await makeTripQuotation(prisma, req.params.id, actorOf(req as never));
    res.status(out.made ? 201 : 200).json({ made: out.made, id: out.paper.id });
  } catch (error) {
    next(error);
  }
});

tripPapersRouter.get("/trip-papers/:id/preview-html", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { html } = await renderTripQuotationHtml(prisma, req.params.id, {
      hidePrices: req.query.prices === "none",
      nightsMode: readNightsMode(req.query.nights),
    });
    res.set("Cache-Control", "no-store");
    res.type("html").send(html);
  } catch (error) {
    next(error);
  }
});

tripPapersRouter.get("/trip-papers/:id/pdf", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { bytes, filename } = await renderTripQuotationPdf(prisma, req.params.id, {
      hidePrices: req.query.prices === "none",
      nightsMode: readNightsMode(req.query.nights),
    });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="${filename}"`);
    res.send(bytes);
  } catch (error) {
    next(error);
  }
});

const sendSchema = z.object({
  channel: z.enum(["EMAIL", "WHATSAPP"]),
  to: z.string().trim().max(200).nullable().optional(),
  nightsEach: z.boolean().optional(),
});

tripPapersRouter.post("/trip-papers/:id/send", requireActorLevel("L1"), validateBody(sendSchema), async (req, res, next) => {
  try {
    res.json(await sendTripQuotation(prisma, req.params.id, actorOf(req as never), req.body));
  } catch (error) {
    next(error);
  }
});

const answerSchema = z.object({
  method: z.enum(["WRITTEN", "VERBAL"]),
  verbatimNote: z.string().trim().max(2000).nullable().optional(),
});

tripPapersRouter.post("/trip-papers/:id/answer", requireActorLevel("L1"), validateBody(answerSchema), async (req, res, next) => {
  try {
    res.json(await answerTripQuotation(prisma, req.params.id, actorOf(req as never), req.body));
  } catch (error) {
    next(error);
  }
});
