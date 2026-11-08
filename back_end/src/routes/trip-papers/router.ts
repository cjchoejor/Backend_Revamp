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
  keepTripQuotationInStep,
} from "../../services/domain/trip-paper-service.js";
import {
  answerTripVoucher,
  describeTripVoucher,
  keepTripVoucherInStep,
  markTripVoucherNotSent,
  renderTripVoucherHtml,
  renderTripVoucherPdf,
  sendTripVoucher,
} from "../../services/domain/trip-voucher-service.js";
import {
  answerTripProforma,
  describeTripPayment,
  describeTripProforma,
  previewTripPaymentForEntry,
  recordTripPaymentForEntry,
  makeTripProforma,
  previewTripPayment,
  recordTripPayment,
  renderTripProformaHtml,
  renderTripProformaPdf,
  sendTripProforma,
  keepTripProformaInStep,
} from "../../services/domain/trip-proforma-service.js";

/** Which kind of trip paper an id names — the paper routes serve all three. */
async function kindOf(id: string) {
  const p = await prisma.tripPaper.findUnique({ where: { id }, select: { kind: true } });
  return p?.kind ?? "QUOTATION";
}

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
    await keepTripQuotationInStep(prisma, req.params.id);
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

tripPapersRouter.get("/entries/:id/trip-proforma", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    await keepTripProformaInStep(prisma, req.params.id);
    res.json(await describeTripProforma(prisma, req.params.id));
  } catch (error) {
    next(error);
  }
});

tripPapersRouter.post("/entries/:id/trip-proforma", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await makeTripProforma(prisma, req.params.id, actorOf(req as never));
    res.status(out.made ? 201 : 200).json({ made: out.made, id: out.paper.id });
  } catch (error) {
    next(error);
  }
});

tripPapersRouter.get("/entries/:id/trip-voucher", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    await keepTripVoucherInStep(prisma, req.params.id);
    res.json(await describeTripVoucher(prisma, req.params.id));
  } catch (error) {
    next(error);
  }
});

tripPapersRouter.get("/trip-papers/:id/preview-html", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const opts = { hidePrices: req.query.prices === "none", nightsMode: readNightsMode(req.query.nights) };
    const kind = await kindOf(req.params.id);
    const { html } =
      kind === "VOUCHER"
        ? await renderTripVoucherHtml(prisma, req.params.id, opts)
        : kind === "PROFORMA"
          ? await renderTripProformaHtml(prisma, req.params.id, opts)
          : await renderTripQuotationHtml(prisma, req.params.id, opts);
    res.set("Cache-Control", "no-store");
    res.type("html").send(html);
  } catch (error) {
    next(error);
  }
});

tripPapersRouter.get("/trip-papers/:id/pdf", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const opts = { hidePrices: req.query.prices === "none", nightsMode: readNightsMode(req.query.nights) };
    const kind = await kindOf(req.params.id);
    const { bytes, filename } =
      kind === "VOUCHER"
        ? await renderTripVoucherPdf(prisma, req.params.id, opts)
        : kind === "PROFORMA"
          ? await renderTripProformaPdf(prisma, req.params.id, opts)
          : await renderTripQuotationPdf(prisma, req.params.id, opts);
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
    const kind = await kindOf(req.params.id);
    res.json(
      kind === "VOUCHER"
        ? await sendTripVoucher(prisma, req.params.id, actorOf(req as never), req.body)
        : kind === "PROFORMA"
          ? await sendTripProforma(prisma, req.params.id, actorOf(req as never), req.body)
          : await sendTripQuotation(prisma, req.params.id, actorOf(req as never), req.body),
    );
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
    const kind = await kindOf(req.params.id);
    res.json(
      kind === "VOUCHER"
        ? await answerTripVoucher(prisma, req.params.id, actorOf(req as never), req.body)
        : kind === "PROFORMA"
          ? await answerTripProforma(prisma, req.params.id, actorOf(req as never), req.body)
          : await answerTripQuotation(prisma, req.params.id, actorOf(req as never), req.body),
    );
  } catch (error) {
    next(error);
  }
});

const notSentSchema = z.object({ note: z.string().trim().max(500).nullable().optional() });

tripPapersRouter.post("/trip-papers/:id/not-sent", requireActorLevel("L1"), validateBody(notSentSchema), async (req, res, next) => {
  try {
    res.json(await markTripVoucherNotSent(prisma, req.params.id, actorOf(req as never), req.body));
  } catch (error) {
    next(error);
  }
});

/* A payment for the trip (2026-11-07): the first stay's advance first, or as the desk types it. */
const shares = z.array(z.object({ entryId: z.string().min(1), amount: z.coerce.number().refine((n) => Number.isFinite(n) && n >= 0, "a share is zero or more") })).max(20);
const amount = z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, "amount must be positive");

/* The same by the booking — at Reserve, Arrival or Check-in a trip may have no trip proforma. */
tripPapersRouter.get("/entries/:id/trip-payment", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await describeTripPayment(prisma, req.params.id));
  } catch (error) {
    next(error);
  }
});

tripPapersRouter.post(
  "/entries/:id/trip-payment/preview",
  requireActorLevel("L1"),
  validateBody(z.object({ amount: amount.nullable().optional(), shares: shares.nullable().optional() })),
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await previewTripPaymentForEntry(prisma, req.params.id, req.body));
    } catch (error) {
      next(error);
    }
  },
);

tripPapersRouter.post(
  "/entries/:id/trip-payment",
  requireActorLevel("L1"),
  validateBody(
    z.object({
      amount,
      paymentMethod: z.string().trim().min(1).max(40).optional(),
      notes: z.string().trim().max(500).optional(),
      shares: shares.nullable().optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      res.status(201).json(await recordTripPaymentForEntry(prisma, req.params.id, actorOf(req as never), req.body));
    } catch (error) {
      next(error);
    }
  },
);

tripPapersRouter.post(
  "/trip-papers/:id/payment/preview",
  requireActorLevel("L1"),
  validateBody(z.object({ amount: amount.nullable().optional(), shares: shares.nullable().optional() })),
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json(await previewTripPayment(prisma, req.params.id, req.body));
    } catch (error) {
      next(error);
    }
  },
);

tripPapersRouter.post(
  "/trip-papers/:id/payment",
  requireActorLevel("L1"),
  validateBody(
    z.object({
      amount,
      paymentMethod: z.string().trim().min(1).max(40).optional(),
      notes: z.string().trim().max(500).optional(),
      shares: shares.nullable().optional(),
    }),
  ),
  async (req, res, next) => {
    try {
      res.status(201).json(await recordTripPayment(prisma, req.params.id, actorOf(req as never), req.body));
    } catch (error) {
      next(error);
    }
  },
);
