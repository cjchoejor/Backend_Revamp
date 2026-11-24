import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import {
  listVouchers,
  previewVoucherMoney,
  recordVoucherMoney,
  undoVoucherMoney,
} from "../../services/domain/voucher-collection-service.js";

/**
 * Billing › Vouchers (2026-11-24): the agencies' vouchers taken at check-out, and whether each
 * agency's money for them has come in. Recording it never moves a guest's bill.
 */
export const vouchersRouter = Router();

const recordSchema = z.object({
  paymentIds: z.array(z.string().trim().min(1)).min(1).max(200),
  receivedOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentMethod: z.string().trim().min(1).max(40),
  bankName: z.string().trim().max(80).optional().nullable(),
  journalNumber: z.string().trim().max(60).optional().nullable(),
  reference: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

const previewSchema = z.object({ paymentIds: z.array(z.string().trim().min(1)).min(1).max(200) });

const undoSchema = z.object({ reason: z.string().trim().min(1).max(500) });

vouchersRouter.get("/vouchers", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const v = String(req.query.view ?? "open").toUpperCase();
    res.json(await listVouchers(prisma, v === "RECEIVED" ? "RECEIVED" : v === "ALL" ? "ALL" : "OPEN"));
  } catch (e) {
    next(e);
  }
});

vouchersRouter.post("/vouchers/money/preview", requireActorLevel("L1"), validateBody(previewSchema), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await previewVoucherMoney(prisma, req.body));
  } catch (e) {
    next(e);
  }
});

vouchersRouter.post("/vouchers/money", requireActorLevel("L1"), validateBody(recordSchema), async (req, res, next) => {
  try {
    res.status(201).json(await recordVoucherMoney(prisma, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body));
  } catch (e) {
    next(e);
  }
});

vouchersRouter.post("/vouchers/:paymentId/money/undo", requireActorLevel("L2"), validateBody(undoSchema), async (req, res, next) => {
  try {
    res.json(await undoVoucherMoney(prisma, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.params.paymentId, req.body.reason));
  } catch (e) {
    next(e);
  }
});
