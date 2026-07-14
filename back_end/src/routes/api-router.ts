import { Router } from "express";
import { parseActorHeaders } from "../middleware/auth.js";
import { concurrentEditingPassthrough } from "../middleware/concurrent-editing.js";
import { rateLimitingPassthrough } from "../middleware/rate-limiting.js";
import { prisma } from "../db.js";
import { assertS9Readiness } from "../lib/s9-readiness.js";

import { sessionAndAuthenticationRouter } from "./session-and-authentication/router.js";
import { inquiriesRouter } from "./inquiries/router.js";
import { duplicateFlagsRouter } from "./inquiries/duplicate-flags-router.js";
import { entriesRouter } from "./entries/router.js";
import { availabilityRouter } from "./availability/router.js";
import { processingLocksRouter } from "./processing-locks/router.js";
import { quotationsAndHoldsRouter } from "./quotations-and-holds/router.js";
import { reservationsRouter } from "./reservations/router.js";
import { guestProfilesRouter } from "./guest-profiles/router.js";
import { handoffsRouter } from "./handoffs/router.js";
import { workOrdersRouter } from "./work-orders/router.js";
import { disputesRouter } from "./disputes/router.js";
import { nightAuditRouter } from "./night-audit/router.js";
import { foliosRouter } from "./folios/router.js";
import { amendmentsRouter } from "./amendments/router.js";
import { cancellationsRouter } from "./cancellations/router.js";
import { noShowRouter } from "./no-show/router.js";
import { adminRouter } from "./admin/router.js";
import { incidentsAndLostFoundRouter } from "./incidents-and-lost-found/router.js";
import { deficientConditionsRouter } from "./deficient-conditions/router.js";
import { lookupsRouter } from "./lookups/router.js";
import { backflowsRouter } from "./backflows/router.js";

export const apiRouter = Router();

apiRouter.get("/health", async (_req, res) => {
  res.json({ ok: true, scope: "S5-S9-slice" });
});

// SIG-S9 §9 — readiness probe (does not block generic health).
apiRouter.get("/health/s9-readiness", async (_req, res) => {
  try {
    await assertS9Readiness(prisma);
    res.json({ ok: true, readiness: { s9: "OK" } });
  } catch (e) {
    res.status(503).json({
      ok: false,
      readiness: { s9: "MISSING_CONFIG" },
      message: (e as Error)?.message ?? "S9 readiness failed",
    });
  }
});

// Cat 10 #1
apiRouter.use("/auth", sessionAndAuthenticationRouter);

// Actor attribution begins for operational routes
apiRouter.use(parseActorHeaders());

// Atlas Cat 11 — concurrent editing + rate limiting pipeline slots (currently pass-through; validation is per-route Zod).
apiRouter.use(concurrentEditingPassthrough());
apiRouter.use(rateLimitingPassthrough());

// Cat 10 #2
apiRouter.use("/inquiries", inquiriesRouter);
apiRouter.use("/duplicate-flags", duplicateFlagsRouter);
apiRouter.use("/entries", entriesRouter);
apiRouter.use(availabilityRouter);
apiRouter.use("/processing-locks", processingLocksRouter);
apiRouter.use(quotationsAndHoldsRouter);
apiRouter.use(reservationsRouter);
apiRouter.use(guestProfilesRouter);
apiRouter.use(handoffsRouter);
apiRouter.use(workOrdersRouter);
apiRouter.use(disputesRouter);
apiRouter.use(nightAuditRouter);
apiRouter.use(foliosRouter);
apiRouter.use(amendmentsRouter);
apiRouter.use(cancellationsRouter);
apiRouter.use(noShowRouter);
apiRouter.use(incidentsAndLostFoundRouter);
apiRouter.use(deficientConditionsRouter);
apiRouter.use(lookupsRouter);
apiRouter.use(backflowsRouter);
apiRouter.use("/admin", adminRouter);

