import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as s1EntryService from "../../services/domain/s1-entry-service.js";

export const entriesRouter = Router();

entriesRouter.post("/", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s1EntryService.createEntry(prisma, req.actor!.actorId, req.body ?? {});
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

entriesRouter.patch("/:id/apartment-context", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { apartmentDurationNights, apartmentRateTierCode } = req.body ?? {};
    if (typeof apartmentDurationNights !== "number" || apartmentDurationNights < 1) {
      next(new AppError(400, { error: "ValidationError", message: "apartmentDurationNights must be a positive number" }));
      return;
    }
    if (typeof apartmentRateTierCode !== "string" || !apartmentRateTierCode.trim()) {
      next(new AppError(400, { error: "ValidationError", message: "apartmentRateTierCode is required" }));
      return;
    }
    const updated = await prisma.entry.update({
      where: { id: req.params.id },
      data: { apartmentDurationNights, apartmentRateTierCode: apartmentRateTierCode.trim(), version: { increment: 1 } } as any,
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/park", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1EntryService.parkEntry(prisma, req.params.id, req.actor!.actorId, req.body?.reason);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/unpark", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1EntryService.unparkEntry(prisma, req.params.id, req.actor!.actorId);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

