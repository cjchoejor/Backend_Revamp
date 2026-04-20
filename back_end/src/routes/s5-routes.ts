import { Router } from "express";
import { prisma } from "../db.js";
import { AppError } from "../lib/errors.js";
import { parseActorHeaders, requireActorLevel } from "../middleware/auth.js";
import * as handoffService from "../services/handoff-service.js";
import * as roomAssignmentService from "../services/room-assignment-service.js";
import * as preArrivalService from "../services/pre-arrival-service.js";
import * as entryService from "../services/entry-service.js";
import * as noShowService from "../services/no-show-service.js";
import * as cancellationService from "../services/cancellation-service.js";
import * as guestProfileService from "../services/guest-profile-service.js";

export const s5Router = Router();

s5Router.get("/health", (_req, res) => {
  res.json({ ok: true, scope: "S5-S6-check-in-slice" });
});

s5Router.use(parseActorHeaders());

s5Router.get("/entries/:id", async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({
      where: { id: req.params.id },
      include: {
        reservation: true,
        folio: true,
        guestProfile: true,
        handoffs: { orderBy: { createdAt: "desc" } },
        preArrivalTasks: true,
        roomAssignments: { include: { room: true } },
        committedHold: true,
        vipArrivalNotifications: { orderBy: { createdAt: "desc" }, take: 3 },
      },
    });
    if (!entry) {
      next(new AppError(404, { error: "NotFoundError", message: "Entry not found" }));
      return;
    }
    res.json(entry);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/guest-profiles/:id/verify-identity", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { entryId, verificationPath, documentType, documentNumber, issuingCountry, expiryDate } = req.body ?? {};
    if (!entryId || typeof entryId !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "entryId is required" }));
      return;
    }
    if (!verificationPath || typeof verificationPath !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "verificationPath is required" }));
      return;
    }
    const allowed = ["FIRST_TIME", "RETURNING_VALID", "RETURNING_EXPIRED", "VIP"];
    if (!allowed.includes(verificationPath)) {
      next(new AppError(400, { error: "ValidationError", message: "verificationPath must be one of FIRST_TIME, RETURNING_VALID, RETURNING_EXPIRED, VIP" }));
      return;
    }
    const updated = await guestProfileService.recordVerification(prisma, req.params.id, req.actor!.actorId, {
      entryId,
      verificationPath: verificationPath as "FIRST_TIME" | "RETURNING_VALID" | "RETURNING_EXPIRED" | "VIP",
      documentType: typeof documentType === "string" ? documentType : undefined,
      documentNumber: typeof documentNumber === "string" ? documentNumber : undefined,
      issuingCountry: typeof issuingCountry === "string" ? issuingCountry : undefined,
      expiryDate: typeof expiryDate === "string" ? expiryDate : undefined,
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/handoffs/:id/accept", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await handoffService.acceptHandoff(prisma, req.params.id, req.actor!.actorId, req.body?.checklistCompletion);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/handoffs/:id/reject", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const reason = req.body?.rejectionReason;
    if (typeof reason !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "rejectionReason is required" }));
      return;
    }
    const updated = await handoffService.rejectHandoff(prisma, req.params.id, req.actor!.actorId, reason);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/handoffs/:id/fulfil", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await handoffService.fulfilHandoff(prisma, req.params.id, req.actor!.actorId, req.body?.fulfilmentEvidence);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/room-assignments", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { roomId, notes, deficientAcknowledgement } = req.body ?? {};
    if (!roomId || typeof roomId !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "roomId is required" }));
      return;
    }
    const created = await roomAssignmentService.assignRoom(
      prisma,
      req.params.id,
      roomId,
      req.actor!.actorId,
      typeof notes === "string" ? notes : undefined,
      deficientAcknowledgement,
    );
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

s5Router.patch("/pre-arrival-tasks/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { action, waivedReason } = req.body ?? {};
    if (action !== "COMPLETE" && action !== "WAIVE") {
      next(new AppError(400, { error: "ValidationError", message: "action must be COMPLETE or WAIVE" }));
      return;
    }
    const updated = await preArrivalService.updatePreArrivalTask(
      prisma,
      req.params.id,
      req.actor!.actorId,
      action,
      typeof waivedReason === "string" ? waivedReason : undefined,
    );
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/progress-stage", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { targetStage, version, guestPhysicallyPresent, transitionData } = req.body ?? {};
    const guestPresent =
      guestPhysicallyPresent === true ||
      (transitionData && typeof transitionData === "object" && (transitionData as { guestPresentConfirmation?: boolean }).guestPresentConfirmation === true);

    if (targetStage === "S6") {
      const updated = await entryService.progressStageS5ToS6(
        prisma,
        req.params.id,
        req.actor!.actorId,
        typeof version === "number" ? version : undefined,
        guestPresent,
      );
      res.json(updated);
      return;
    }

    if (targetStage === "S7") {
      const td = transitionData && typeof transitionData === "object" ? (transitionData as { keyCount?: number; registrationConfirmed?: boolean }) : {};
      const updated = await entryService.progressStageS6ToS7(
        prisma,
        req.params.id,
        req.actor!.actorId,
        typeof version === "number" ? version : undefined,
        typeof td.keyCount === "number" ? td.keyCount : undefined,
        td.registrationConfirmed === true,
      );
      res.json(updated);
      return;
    }

    next(new AppError(400, { error: "ValidationError", message: 'targetStage must be "S6" (S5→S6) or "S7" (S6→S7 check-in completion)' }));
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/no-show", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const result = await noShowService.determineNoShow(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(result);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/cancel", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await cancellationService.cancelEntryAtS5(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

s5Router.post("/entries/:id/credit-ceiling-tier2-ack", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await preArrivalService.acknowledgeCreditCeilingTier2(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});
