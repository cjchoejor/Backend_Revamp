import type { Prisma, PrismaClient } from "@prisma/client";
import { ContactMode } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";
import { allocateReadableId } from "../../lib/readable-id.js";

export type CoordinatorContact = { name: string; phone?: string | null; email?: string | null };

export type CorporateAccountInput = {
  displayName: string;
  contactNumber?: string | null;
  contactEmail?: string | null;
  modeOfContact?: ContactMode | null;
  gstNumber?: string | null;
  billingAddress?: string | null;
  /** Contract / PO / authorisation reference identifiers for this client (spec §2.6.2). */
  contractRefs?: string[];
  /** Coordinator contact objects [{ name, phone?, email? }] (spec §2.6.2). */
  coordinators?: CoordinatorContact[];
  notes?: string | null;
  isActive?: boolean;
};

/** Normalise contractRefs: trimmed, non-empty, deduped. */
function normalizeContractRefs(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of v) {
    const s = typeof r === "string" ? r.trim() : "";
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

/** Normalise coordinators: each must have a non-empty name; phone/email optional. */
function normalizeCoordinators(v: unknown): CoordinatorContact[] {
  if (!Array.isArray(v)) return [];
  const out: CoordinatorContact[] = [];
  for (const c of v) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) continue;
    const phone = typeof obj.phone === "string" && obj.phone.trim() ? obj.phone.trim() : null;
    const email = typeof obj.email === "string" && obj.email.trim() ? obj.email.trim() : null;
    out.push({ name, phone, email });
  }
  return out;
}

const ALLOWED_CONTACT_MODES: ContactMode[] = [
  ContactMode.PHONE,
  ContactMode.EMAIL,
  ContactMode.WHATSAPP,
  ContactMode.IN_PERSON,
  ContactMode.OTHER,
];

function validateContactMode(v: unknown): ContactMode {
  if (typeof v !== "string") throw new ValidationError("modeOfContact must be a string");
  if (!ALLOWED_CONTACT_MODES.includes(v as ContactMode)) {
    throw new ValidationError(`modeOfContact must be one of: ${ALLOWED_CONTACT_MODES.join(", ")}`);
  }
  return v as ContactMode;
}

export async function listCorporateAccounts(prisma: PrismaClient, input?: { includeInactive?: boolean }) {
  return prisma.corporateAccount.findMany({
    where: input?.includeInactive ? undefined : { isActive: true },
    orderBy: [{ isActive: "desc" }, { displayName: "asc" }],
  });
}

export async function getCorporateAccount(prisma: PrismaClient, id: string) {
  const row = await prisma.corporateAccount.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("CorporateAccount");
  return row;
}

export async function createCorporateAccount(prisma: PrismaClient, input: CorporateAccountInput, actorId: string) {
  if (!input.displayName?.trim()) throw new ValidationError("displayName is required");
  const mode = input.modeOfContact != null ? validateContactMode(input.modeOfContact) : ContactMode.EMAIL;

  return prisma.$transaction(async (tx) => {
    const id = await allocateReadableId(tx, "CORPORATE_ACCOUNT" as const);
    const created = await tx.corporateAccount.create({
      data: {
        id,
        displayName: input.displayName.trim(),
        contactNumber: input.contactNumber?.trim() || null,
        contactEmail: input.contactEmail?.trim() || null,
        modeOfContact: mode,
        gstNumber: input.gstNumber?.trim() || null,
        billingAddress: input.billingAddress?.trim() || null,
        contractRefs: normalizeContractRefs(input.contractRefs),
        coordinators: normalizeCoordinators(input.coordinators),
        notes: input.notes?.trim() || null,
        isActive: input.isActive ?? true,
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.CORPORATE_ACCOUNT_CREATED",
      entityType: "CorporateAccount",
      entityId: created.id,
      operation: "CREATE",
      payload: { displayName: created.displayName },
    });
    return created;
  });
}

export async function updateCorporateAccount(
  prisma: PrismaClient,
  id: string,
  input: Partial<CorporateAccountInput>,
  actorId: string,
) {
  const existing = await prisma.corporateAccount.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("CorporateAccount");

  if (input.modeOfContact !== undefined && input.modeOfContact !== null) {
    validateContactMode(input.modeOfContact);
  }

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "CorporateAccount", entityId: id, actorId });
    const updated = await tx.corporateAccount.update({
      where: { id },
      data: {
        displayName: input.displayName?.trim(),
        contactNumber: input.contactNumber === undefined ? undefined : input.contactNumber?.trim() || null,
        contactEmail: input.contactEmail === undefined ? undefined : input.contactEmail?.trim() || null,
        modeOfContact: input.modeOfContact ?? undefined,
        gstNumber: input.gstNumber === undefined ? undefined : input.gstNumber?.trim() || null,
        billingAddress: input.billingAddress === undefined ? undefined : input.billingAddress?.trim() || null,
        contractRefs: input.contractRefs === undefined ? undefined : normalizeContractRefs(input.contractRefs),
        coordinators: input.coordinators === undefined ? undefined : normalizeCoordinators(input.coordinators),
        notes: input.notes === undefined ? undefined : input.notes?.trim() || null,
        isActive: input.isActive,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.CORPORATE_ACCOUNT_UPDATED",
      entityType: "CorporateAccount",
      entityId: id,
      operation: "UPDATE",
      payload: {
        fieldsChanged: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
      },
    });
    return updated;
  });
}

export async function deactivateCorporateAccount(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.corporateAccount.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("CorporateAccount");
  if (!existing.isActive) return existing;

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "CorporateAccount", entityId: id, actorId });
    const updated = await tx.corporateAccount.update({ where: { id }, data: { isActive: false } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.CORPORATE_ACCOUNT_DEACTIVATED",
      entityType: "CorporateAccount",
      entityId: id,
      operation: "UPDATE",
      payload: { displayName: updated.displayName },
    });
    return updated;
  });
}

export async function reactivateCorporateAccount(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.corporateAccount.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("CorporateAccount");
  if (existing.isActive) return existing;

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "CorporateAccount", entityId: id, actorId });
    const updated = await tx.corporateAccount.update({ where: { id }, data: { isActive: true } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.CORPORATE_ACCOUNT_REACTIVATED",
      entityType: "CorporateAccount",
      entityId: id,
      operation: "UPDATE",
      payload: { displayName: updated.displayName },
    });
    return updated;
  });
}

/** Search by name (case-insensitive substring), for the front-desk picker. */
export async function searchCorporateAccounts(prisma: PrismaClient, query: string) {
  const q = query.trim();
  if (!q) return [];
  return prisma.corporateAccount.findMany({
    where: { isActive: true, displayName: { contains: q, mode: "insensitive" } },
    orderBy: { displayName: "asc" },
    take: 25,
  });
}
