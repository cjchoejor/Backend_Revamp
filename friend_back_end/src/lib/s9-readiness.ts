import type { PrismaClient } from "@prisma/client";
import { requireActiveConfigValue } from "./config-store.js";

/**
 * SIG-S9 §9 — S9_READINESS blocking configuration surfaces.
 *
 * This is a lightweight runtime check to surface missing config keys early.
 * It does not validate shapes exhaustively; it only asserts presence/readability.
 */
export async function assertS9Readiness(prisma: PrismaClient): Promise<void> {
  await Promise.all([
    requireActiveConfigValue(prisma, "invoice.templates").catch(() => {
      throw new Error("S9_READINESS missing config: invoice.templates");
    }),
    requireActiveConfigValue(prisma, "payment.followUp.intervals").catch(() => {
      throw new Error("S9_READINESS missing config: payment.followUp.intervals");
    }),
    requireActiveConfigValue(prisma, "feedback.survey.templates").catch(() => {
      throw new Error("S9_READINESS missing config: feedback.survey.templates");
    }),
    requireActiveConfigValue(prisma, "feedback.platform.links").catch(() => {
      throw new Error("S9_READINESS missing config: feedback.platform.links");
    }),
    requireActiveConfigValue(prisma, "government.submission.config").catch(() => {
      throw new Error("S9_READINESS missing config: government.submission.config");
    }),
    requireActiveConfigValue(prisma, "identity.document.retentionPeriodDays").catch(() => {
      throw new Error("S9_READINESS missing config: identity.document.retentionPeriodDays");
    }),
    requireActiveConfigValue(prisma, "expiry.defaults").catch(() => {
      throw new Error("S9_READINESS missing config: expiry.defaults");
    }),
  ]);
}

