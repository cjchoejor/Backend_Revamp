import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { backflowReasonRequestSchema, backflowS7ToS4RequestSchema } from "../../dtos/21-backflows/request-schemas.js";
import * as backflows from "../../state-machines/backflows-state-machine.js";

/**
 * Backflow HTTP surface. Each route corresponds to one of the 9 spec-mandated regression
 * transitions. Authority is double-enforced:
 *   1. `requireActorLevel(min)` at the route boundary (broad allow-list).
 *   2. The service's `enforce*BackflowAuthority` check (spec-precise).
 * The service's check is authoritative — the route middleware is defence-in-depth.
 */
export const backflowsRouter = Router();

const asActor = (req: import("express").Request) => ({
  actorId: req.actor!.actorId,
  actorLevel: req.actor!.level,
});

// 1. S2 → S1 · L1+
backflowsRouter.post(
  "/entries/:id/backflow/s2-to-s1",
  requireActorLevel("L1"),
  validateBody(backflowReasonRequestSchema),
  async (req, res, next) => {
    try {
      const out = await backflows.backflowS2ToS1(prisma, req.params.id, asActor(req), req.body);
      res.json(out);
    } catch (e) { next(e); }
  },
);

// 2. S4 → S1 · FOM
backflowsRouter.post(
  "/entries/:id/backflow/s4-to-s1",
  requireActorLevel("L2"),
  validateBody(backflowReasonRequestSchema),
  async (req, res, next) => {
    try {
      const out = await backflows.backflowS4ToS1(prisma, req.params.id, asActor(req), req.body);
      res.json(out);
    } catch (e) { next(e); }
  },
);

// 3. S4 → S2 · FOM
backflowsRouter.post(
  "/entries/:id/backflow/s4-to-s2",
  requireActorLevel("L2"),
  validateBody(backflowReasonRequestSchema),
  async (req, res, next) => {
    try {
      const out = await backflows.backflowS4ToS2(prisma, req.params.id, asActor(req), req.body);
      res.json(out);
    } catch (e) { next(e); }
  },
);

// 4. S4 → S3 · FOM
backflowsRouter.post(
  "/entries/:id/backflow/s4-to-s3",
  requireActorLevel("L2"),
  validateBody(backflowReasonRequestSchema),
  async (req, res, next) => {
    try {
      const out = await backflows.backflowS4ToS3(prisma, req.params.id, asActor(req), req.body);
      res.json(out);
    } catch (e) { next(e); }
  },
);

// 5. S5 → S1 · FOM
backflowsRouter.post(
  "/entries/:id/backflow/s5-to-s1",
  requireActorLevel("L2"),
  validateBody(backflowReasonRequestSchema),
  async (req, res, next) => {
    try {
      const out = await backflows.backflowS5ToS1(prisma, req.params.id, asActor(req), req.body);
      res.json(out);
    } catch (e) { next(e); }
  },
);

// 6. S7 → S2 · GM
backflowsRouter.post(
  "/entries/:id/backflow/s7-to-s2",
  requireActorLevel("L3"),
  validateBody(backflowReasonRequestSchema),
  async (req, res, next) => {
    try {
      const out = await backflows.backflowS7ToS2(prisma, req.params.id, asActor(req), req.body);
      res.json(out);
    } catch (e) { next(e); }
  },
);

// 7. S7 → S3 · FOM
backflowsRouter.post(
  "/entries/:id/backflow/s7-to-s3",
  requireActorLevel("L2"),
  validateBody(backflowReasonRequestSchema),
  async (req, res, next) => {
    try {
      const out = await backflows.backflowS7ToS3(prisma, req.params.id, asActor(req), req.body);
      res.json(out);
    } catch (e) { next(e); }
  },
);

// 8. S7 → S4 · FOM (date extension carries newCheckOutDate)
backflowsRouter.post(
  "/entries/:id/backflow/s7-to-s4",
  requireActorLevel("L2"),
  validateBody(backflowS7ToS4RequestSchema),
  async (req, res, next) => {
    try {
      const out = await backflows.backflowS7ToS4(prisma, req.params.id, asActor(req), req.body);
      res.json(out);
    } catch (e) { next(e); }
  },
);

// 9. Any → S2 · complaint · FOM
backflowsRouter.post(
  "/entries/:id/backflow/complaint-to-s2",
  requireActorLevel("L2"),
  validateBody(backflowReasonRequestSchema),
  async (req, res, next) => {
    try {
      const out = await backflows.backflowComplaintToS2(prisma, req.params.id, asActor(req), req.body);
      res.json(out);
    } catch (e) { next(e); }
  },
);
