import { Router } from "express";
import { prisma } from "../../db.js";
import { valueOnlyRequestSchema, updateChannelRequestSchema } from "../../dtos/08-admin/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as svc from "../../services/admin/communication-config-admin-service.js";

export const adminCommunicationConfigRouter = Router();
const L4 = requireActorLevel("L4");

adminCommunicationConfigRouter.get("/communication-config/channels", L4, async (_req, res, next) => {
  try {
    res.json({ channels: await svc.listChannels(prisma) });
  } catch (e) {
    next(e);
  }
});

adminCommunicationConfigRouter.get("/communication-config/channels/:channelId", L4, async (req, res, next) => {
  try {
    res.json(await svc.getChannel(prisma, req.params.channelId));
  } catch (e) {
    next(e);
  }
});

adminCommunicationConfigRouter.put(
  "/communication-config/channels/:channelId",
  L4,
  validateBody(updateChannelRequestSchema),
  async (req, res, next) => {
    try {
      res.json(await svc.updateChannel(prisma, req.params.channelId, req.body, req.actor!.actorId));
    } catch (e) {
      next(e);
    }
  },
);

adminCommunicationConfigRouter.get("/communication-config/acknowledgement-window", L4, async (_req, res, next) => {
  try {
    res.json({ value: await svc.getAcknowledgementWindow(prisma) });
  } catch (e) {
    next(e);
  }
});

adminCommunicationConfigRouter.put(
  "/communication-config/acknowledgement-window",
  L4,
  validateBody(valueOnlyRequestSchema),
  async (req, res, next) => {
    try {
      res.json(await svc.setAcknowledgementWindow(prisma, req.body.value as never, req.actor!.actorId));
    } catch (e) {
      next(e);
    }
  },
);
