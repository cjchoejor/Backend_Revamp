import { Router } from "express";
import { prisma } from "../../db.js";
import * as sessionService from "../../services/infrastructure/session-service.js";

export const sessionAndAuthenticationRouter = Router();

sessionAndAuthenticationRouter.post("/authenticate", async (req, res, next) => {
  try {
    const out = await sessionService.authenticate(prisma, req.body ?? {});
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

sessionAndAuthenticationRouter.post("/switch", async (req, res, next) => {
  try {
    const out = await sessionService.pinSwitch(prisma, req.body ?? {});
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

sessionAndAuthenticationRouter.post("/lock", async (req, res, next) => {
  try {
    const out = await sessionService.manualLock(prisma, req.body ?? {});
    res.status(200).json(out);
  } catch (e) {
    next(e);
  }
});

sessionAndAuthenticationRouter.post("/logout", async (req, res, next) => {
  try {
    const out = await sessionService.hardLogout(prisma, req.body ?? {});
    res.status(200).json(out);
  } catch (e) {
    next(e);
  }
});

