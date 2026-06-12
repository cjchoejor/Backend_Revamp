import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";

async function readActive(prisma: PrismaClient, key: string) {
  const row = await getActiveConfigEntry(prisma, key);
  return row?.configValue ?? null;
}
function setKey(prisma: PrismaClient, key: string, value: Prisma.InputJsonValue, actorId: string) {
  return prisma.$transaction((tx) => supersedeConfigurationEntry(tx, { configKey: key, configValue: value, actorId }));
}

// --- Feedback survey templates (FeedbackSurveyTemplate model) ---

export async function listFeedbackTemplates(prisma: PrismaClient, includeInactive = false) {
  return prisma.feedbackSurveyTemplate.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { templateKey: "asc" },
  });
}

export async function createFeedbackTemplate(
  prisma: PrismaClient,
  input: { templateKey: string; title: string; questions: Prisma.InputJsonValue },
  actorId: string,
) {
  const templateKey = input.templateKey.trim();
  if (!templateKey) throw new ValidationError("templateKey is required");
  return prisma.$transaction(async (tx) => {
    const created = await tx.feedbackSurveyTemplate.create({
      data: { templateKey, title: input.title.trim(), questions: input.questions, createdBy: actorId },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.FEEDBACK_TEMPLATE_CREATED",
      entityType: "FeedbackSurveyTemplate",
      entityId: created.id,
      operation: "CREATE",
      payload: { templateKey },
    });
    return created;
  });
}

export async function updateFeedbackTemplate(
  prisma: PrismaClient,
  id: string,
  input: { title?: string; questions?: Prisma.InputJsonValue; isActive?: boolean },
  actorId: string,
) {
  const existing = await prisma.feedbackSurveyTemplate.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("FeedbackSurveyTemplate");
  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "FeedbackSurveyTemplate", entityId: id, actorId });
    const updated = await tx.feedbackSurveyTemplate.update({
      where: { id },
      data: {
        title: input.title === undefined ? undefined : input.title.trim(),
        questions: input.questions === undefined ? undefined : input.questions,
        isActive: input.isActive,
        version: { increment: 1 },
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.FEEDBACK_TEMPLATE_UPDATED",
      entityType: "FeedbackSurveyTemplate",
      entityId: id,
      operation: "UPDATE",
      payload: { templateKey: updated.templateKey },
    });
    return updated;
  });
}

export async function deactivateFeedbackTemplate(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.feedbackSurveyTemplate.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("FeedbackSurveyTemplate");
  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "FeedbackSurveyTemplate", entityId: id, actorId });
    const updated = await tx.feedbackSurveyTemplate.update({ where: { id }, data: { isActive: false } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.FEEDBACK_TEMPLATE_DEACTIVATED",
      entityType: "FeedbackSurveyTemplate",
      entityId: id,
      operation: "UPDATE",
      payload: { templateKey: updated.templateKey },
    });
    return updated;
  });
}

export async function reactivateFeedbackTemplate(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.feedbackSurveyTemplate.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("FeedbackSurveyTemplate");
  if (existing.isActive) throw new ValidationError("Template is already active");
  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "FeedbackSurveyTemplate", entityId: id, actorId });
    const updated = await tx.feedbackSurveyTemplate.update({ where: { id }, data: { isActive: true } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.FEEDBACK_TEMPLATE_REACTIVATED",
      entityType: "FeedbackSurveyTemplate",
      entityId: id,
      operation: "UPDATE",
      payload: { templateKey: updated.templateKey },
    });
    return updated;
  });
}

// --- Keyed governance surfaces ---

export async function getPlatformLinks(prisma: PrismaClient) {
  return readActive(prisma, "feedback.platformLinks");
}
export async function setPlatformLinks(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "feedback.platformLinks", value, actorId);
}

export async function getGovernmentPortalConfig(prisma: PrismaClient) {
  return readActive(prisma, "government.submissionConfig");
}
export async function setGovernmentPortalConfig(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "government.submissionConfig", value, actorId);
}

export async function getCommissionBasis(prisma: PrismaClient) {
  return readActive(prisma, "commission.calculationBasis");
}
export async function setCommissionBasis(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "commission.calculationBasis", value, actorId);
}

export async function listIdentityDocumentTypes(prisma: PrismaClient) {
  return readActive(prisma, "identity.documentTypes");
}
export async function updateIdentityDocumentTypes(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "identity.documentTypes", value, actorId);
}

export async function getIdentityRetentionPeriod(prisma: PrismaClient) {
  return readActive(prisma, "identity.retentionPeriodDays");
}
export async function setIdentityRetentionPeriod(prisma: PrismaClient, value: Prisma.InputJsonValue, actorId: string) {
  return setKey(prisma, "identity.retentionPeriodDays", value, actorId);
}

// --- Commission rate cross-write (ACIG §6.4 narrow exception) ---

export async function setCommissionRateOnAgentProfile(
  prisma: PrismaClient,
  agentProfileId: string,
  rate: number,
  actorId: string,
  effectiveFrom?: string | Date,
) {
  const agent = await prisma.agentProfile.findUnique({ where: { id: agentProfileId } });
  if (!agent) throw new NotFoundError("AgentProfile");
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new ValidationError("Commission rate must be a fraction between 0 and 1");
  }
  const effDate = effectiveFrom ? new Date(effectiveFrom) : new Date();

  return prisma.$transaction(async (tx) => {
    const updated = await tx.agentProfile.update({
      where: { id: agentProfileId },
      data: {
        commissionRate: rate as unknown as Prisma.Decimal,
        commissionEffectiveFrom: effDate,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.AGENT_COMMISSION_RATE_SET",
      entityType: "AgentProfile",
      entityId: agentProfileId,
      operation: "UPDATE",
      payload: { commissionRate: rate, commissionEffectiveFrom: effDate.toISOString() },
    });
    return { id: updated.id, commissionRate: updated.commissionRate, commissionEffectiveFrom: updated.commissionEffectiveFrom };
  });
}
