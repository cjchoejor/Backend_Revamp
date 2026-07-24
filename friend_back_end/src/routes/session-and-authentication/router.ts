import { Router } from "express";
import { prisma } from "../../db.js";
import {
  authenticateRequestSchema,
  hardLogoutRequestSchema,
  manualLockRequestSchema,
  pinSwitchRequestSchema,
} from "../../dtos/01-session-and-authentication/request-schemas.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as sessionService from "../../services/infrastructure/session-service.js";

export const sessionAndAuthenticationRouter = Router();

sessionAndAuthenticationRouter.post("/authenticate", validateBody(authenticateRequestSchema), async (req, res, next) => {
  try {
    const out = await sessionService.authenticate(prisma, req.body);
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

sessionAndAuthenticationRouter.post("/switch", validateBody(pinSwitchRequestSchema), async (req, res, next) => {
  try {
    const out = await sessionService.pinSwitch(prisma, req.body);
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

sessionAndAuthenticationRouter.post("/lock", validateBody(manualLockRequestSchema), async (req, res, next) => {
  try {
    const out = await sessionService.manualLock(prisma, req.body);
    res.status(200).json(out);
  } catch (e) {
    next(e);
  }
});

sessionAndAuthenticationRouter.post("/logout", validateBody(hardLogoutRequestSchema), async (req, res, next) => {
  try {
    const out = await sessionService.hardLogout(prisma, req.body);
    res.status(200).json(out);
  } catch (e) {
    next(e);
  }
});
