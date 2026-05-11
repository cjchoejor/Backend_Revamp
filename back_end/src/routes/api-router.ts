import { Router } from "express";
import { parseActorHeaders } from "../middleware/auth.js";

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

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true, scope: "S5-S6-check-in-slice" });
});

// Cat 10 #1
apiRouter.use("/auth", sessionAndAuthenticationRouter);

// Actor attribution begins for operational routes
apiRouter.use(parseActorHeaders());

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
apiRouter.use("/admin", adminRouter);

