import type { Prisma, PrismaClient } from "@prisma/client";
import { HandoffType, InvoiceType } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";

// --- Communication templates --------------------------------------------

export async function listCommunicationTemplates(prisma: PrismaClient) {
  return prisma.communicationTemplate.findMany({ orderBy: { templateKey: "asc" } });
}

export async function createCommunicationTemplate(
  prisma: PrismaClient,
  input: {
    templateKey: string;
    channel: string;
    templateType: string;
    bodyTemplate: string;
    subjectTemplate?: string | null;
    stage?: string | null;
  },
  actorId: string,
) {
  const templateKey = input.templateKey.trim();
  if (!templateKey) throw new ValidationError("templateKey is required");

  return prisma.$transaction(async (tx) => {
    const created = await tx.communicationTemplate.create({
      data: {
        templateKey,
        channel: input.channel.trim(),
        templateType: input.templateType.trim(),
        bodyTemplate: input.bodyTemplate,
        subjectTemplate: input.subjectTemplate?.trim() || null,
        stage: input.stage as never,
        isActive: true,
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.COMM_TEMPLATE_CREATED",
      entityType: "CommunicationTemplate",
      entityId: created.id,
      operation: "CREATE",
      payload: { templateKey },
    });
    return created;
  });
}

export async function updateCommunicationTemplate(
  prisma: PrismaClient,
  id: string,
  input: Partial<{
    channel: string;
    templateType: string;
    bodyTemplate: string;
    subjectTemplate: string | null;
    isActive: boolean;
  }>,
  actorId: string,
) {
  const existing = await prisma.communicationTemplate.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("CommunicationTemplate");

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "CommunicationTemplate", entityId: id, actorId });
    const updated = await tx.communicationTemplate.update({
      where: { id },
      data: {
        channel: input.channel?.trim(),
        templateType: input.templateType?.trim(),
        bodyTemplate: input.bodyTemplate,
        subjectTemplate: input.subjectTemplate === undefined ? undefined : input.subjectTemplate?.trim() || null,
        isActive: input.isActive,
        version: { increment: 1 },
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.COMM_TEMPLATE_UPDATED",
      entityType: "CommunicationTemplate",
      entityId: id,
      operation: "UPDATE",
      payload: { templateKey: updated.templateKey },
    });
    return updated;
  });
}

// --- Handoff checklist templates ----------------------------------------

export async function listHandoffTemplates(prisma: PrismaClient) {
  return prisma.handoffChecklistTemplate.findMany({ orderBy: [{ handoffType: "asc" }, { version: "desc" }] });
}

export async function saveHandoffTemplate(
  prisma: PrismaClient,
  input: { handoffType: HandoffType; checklistItems: Prisma.InputJsonValue },
  actorId: string,
) {
  return prisma.$transaction(async (tx) => {
    const latest = await tx.handoffChecklistTemplate.findFirst({
      where: { handoffType: input.handoffType },
      orderBy: { version: "desc" },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    if (latest?.isActive) {
      await captureSnapshotTx(tx, { entityType: "HandoffChecklistTemplate", entityId: latest.id, actorId });
      await tx.handoffChecklistTemplate.update({
        where: { id: latest.id },
        data: { isActive: false },
      });
    }

    const created = await tx.handoffChecklistTemplate.create({
      data: {
        handoffType: input.handoffType,
        checklistItems: input.checklistItems,
        version: nextVersion,
        isActive: true,
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.HANDOFF_TEMPLATE_SAVED",
      entityType: "HandoffChecklistTemplate",
      entityId: created.id,
      operation: "CREATE",
      payload: { handoffType: input.handoffType, version: nextVersion },
    });
    return created;
  });
}

// --- Invoice templates --------------------------------------------------

export async function listInvoiceTemplates(prisma: PrismaClient) {
  return prisma.invoiceTemplate.findMany({ orderBy: { templateKey: "asc" } });
}

export async function createInvoiceTemplate(
  prisma: PrismaClient,
  input: { templateKey: string; invoiceType: InvoiceType; title: string; bodyTemplate: string },
  actorId: string,
) {
  const templateKey = input.templateKey.trim();
  if (!templateKey || !input.title.trim()) throw new ValidationError("templateKey and title are required");

  return prisma.$transaction(async (tx) => {
    const created = await tx.invoiceTemplate.create({
      data: {
        templateKey,
        invoiceType: input.invoiceType,
        title: input.title.trim(),
        bodyTemplate: input.bodyTemplate,
        isActive: true,
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.INVOICE_TEMPLATE_CREATED",
      entityType: "InvoiceTemplate",
      entityId: created.id,
      operation: "CREATE",
      payload: { templateKey },
    });
    return created;
  });
}

export async function updateInvoiceTemplate(
  prisma: PrismaClient,
  id: string,
  input: Partial<{ title: string; bodyTemplate: string; isActive: boolean }>,
  actorId: string,
) {
  const existing = await prisma.invoiceTemplate.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("InvoiceTemplate");

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "InvoiceTemplate", entityId: id, actorId });
    const updated = await tx.invoiceTemplate.update({
      where: { id },
      data: {
        title: input.title?.trim(),
        bodyTemplate: input.bodyTemplate,
        isActive: input.isActive,
        version: { increment: 1 },
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.INVOICE_TEMPLATE_UPDATED",
      entityType: "InvoiceTemplate",
      entityId: id,
      operation: "UPDATE",
      payload: { templateKey: updated.templateKey },
    });
    return updated;
  });
}

// --- Work order templates -----------------------------------------------

export async function listWorkOrderTemplates(prisma: PrismaClient) {
  return prisma.workOrderTemplate.findMany({ orderBy: { templateKey: "asc" } });
}

export async function createWorkOrderTemplate(
  prisma: PrismaClient,
  input: { templateKey: string; title: string; todoItems: Prisma.InputJsonValue; useType?: string | null },
  actorId: string,
) {
  const templateKey = input.templateKey.trim();
  if (!templateKey || !input.title.trim()) throw new ValidationError("templateKey and title are required");

  return prisma.$transaction(async (tx) => {
    const created = await tx.workOrderTemplate.create({
      data: {
        templateKey,
        title: input.title.trim(),
        todoItems: input.todoItems,
        useType: input.useType as never,
        isActive: true,
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.WORK_ORDER_TEMPLATE_CREATED",
      entityType: "WorkOrderTemplate",
      entityId: created.id,
      operation: "CREATE",
      payload: { templateKey },
    });
    return created;
  });
}

export async function updateWorkOrderTemplate(
  prisma: PrismaClient,
  id: string,
  input: Partial<{ title: string; todoItems: Prisma.InputJsonValue; isActive: boolean }>,
  actorId: string,
) {
  const existing = await prisma.workOrderTemplate.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("WorkOrderTemplate");

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "WorkOrderTemplate", entityId: id, actorId });
    const updated = await tx.workOrderTemplate.update({
      where: { id },
      data: {
        title: input.title?.trim(),
        todoItems: input.todoItems,
        isActive: input.isActive,
        version: { increment: 1 },
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.WORK_ORDER_TEMPLATE_UPDATED",
      entityType: "WorkOrderTemplate",
      entityId: id,
      operation: "UPDATE",
      payload: { templateKey: updated.templateKey },
    });
    return updated;
  });
}
