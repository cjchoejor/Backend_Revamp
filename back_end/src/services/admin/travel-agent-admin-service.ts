import type { Prisma, PrismaClient } from "@prisma/client";
import { ContactMode } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { appendContact, normalizeCoordinators, type CoordinatorContact } from "../../lib/admin/contact-list.js";

export type { CoordinatorContact };

export type TravelAgentInput = {
  displayName: string;
  contactNumber?: string | null;
  contactEmail?: string | null;
  modeOfContact?: ContactMode | null;
  /** The agency's contact persons [{ name, phone?, email? }] — who actually rings in bookings. */
  coordinators?: CoordinatorContact[];
  notes?: string | null;
  isActive?: boolean;
};

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

export async function listTravelAgents(prisma: PrismaClient, input?: { includeInactive?: boolean }) {
  return prisma.travelAgent.findMany({
    where: input?.includeInactive ? undefined : { isActive: true },
    orderBy: [{ isActive: "desc" }, { displayName: "asc" }],
  });
}

export async function getTravelAgent(prisma: PrismaClient, id: string) {
  const row = await prisma.travelAgent.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("TravelAgent");
  return row;
}

export async function createTravelAgent(prisma: PrismaClient, input: TravelAgentInput, actorId: string) {
  if (!input.displayName?.trim()) throw new ValidationError("displayName is required");
  const mode = input.modeOfContact != null ? validateContactMode(input.modeOfContact) : ContactMode.PHONE;

  return prisma.$transaction(async (tx) => {
    const id = await allocateReadableId(tx, "TRAVEL_AGENT" as const);
    const created = await tx.travelAgent.create({
      data: {
        id,
        displayName: input.displayName.trim(),
        contactNumber: input.contactNumber?.trim() || null,
        contactEmail: input.contactEmail?.trim() || null,
        modeOfContact: mode,
        coordinators: normalizeCoordinators(input.coordinators),
        notes: input.notes?.trim() || null,
        isActive: input.isActive ?? true,
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.TRAVEL_AGENT_CREATED",
      entityType: "TravelAgent",
      entityId: created.id,
      operation: "CREATE",
      payload: { displayName: created.displayName },
    });
    return created;
  });
}

export async function updateTravelAgent(
  prisma: PrismaClient,
  id: string,
  input: Partial<TravelAgentInput>,
  actorId: string,
) {
  const existing = await prisma.travelAgent.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("TravelAgent");

  if (input.modeOfContact !== undefined && input.modeOfContact !== null) {
    validateContactMode(input.modeOfContact);
  }

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "TravelAgent", entityId: id, actorId });
    const updated = await tx.travelAgent.update({
      where: { id },
      data: {
        displayName: input.displayName?.trim(),
        contactNumber: input.contactNumber === undefined ? undefined : input.contactNumber?.trim() || null,
        contactEmail: input.contactEmail === undefined ? undefined : input.contactEmail?.trim() || null,
        modeOfContact: input.modeOfContact ?? undefined,
        coordinators: input.coordinators === undefined ? undefined : normalizeCoordinators(input.coordinators),
        notes: input.notes === undefined ? undefined : input.notes?.trim() || null,
        isActive: input.isActive,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.TRAVEL_AGENT_UPDATED",
      entityType: "TravelAgent",
      entityId: id,
      operation: "UPDATE",
      payload: {
        fieldsChanged: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
      },
    });
    return updated;
  });
}

/**
 * Append one contact person to an agency's list.
 *
 * Unlike the rest of this service this is reachable at L1 (see the desk lookup route): a new
 * contact person at an agency surfaces during an intake call, and the number is only worth having
 * if the operator who heard it can store it. Appending is the whole of the granted authority —
 * existing contacts can't be renamed or removed here, only through the L4 update path.
 *
 * Idempotent by phone: re-adding a number already on the agency returns the stored contact with
 * `added: false` and writes nothing.
 */
export async function addTravelAgentContact(
  prisma: PrismaClient,
  id: string,
  contact: CoordinatorContact,
  actorId: string,
) {
  const existing = await prisma.travelAgent.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("TravelAgent");
  if (!contact?.name?.trim()) throw new ValidationError("name is required");

  const result = appendContact(existing.coordinators, contact);
  if (!result.added) {
    return { agent: existing, contact: result.contact, added: false as const };
  }

  const agent = await prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "TravelAgent", entityId: id, actorId });
    const updated = await tx.travelAgent.update({
      where: { id },
      data: { coordinators: result.coordinators as Prisma.InputJsonValue },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.TRAVEL_AGENT_CONTACT_ADDED",
      entityType: "TravelAgent",
      entityId: id,
      operation: "UPDATE",
      payload: { displayName: updated.displayName, contact: result.contact },
    });
    return updated;
  });

  return { agent, contact: result.contact, added: true as const };
}

export async function deactivateTravelAgent(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.travelAgent.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("TravelAgent");
  if (!existing.isActive) return existing;

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "TravelAgent", entityId: id, actorId });
    const updated = await tx.travelAgent.update({ where: { id }, data: { isActive: false } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.TRAVEL_AGENT_DEACTIVATED",
      entityType: "TravelAgent",
      entityId: id,
      operation: "UPDATE",
      payload: { displayName: updated.displayName },
    });
    return updated;
  });
}

export async function reactivateTravelAgent(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.travelAgent.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("TravelAgent");
  if (existing.isActive) return existing;

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "TravelAgent", entityId: id, actorId });
    const updated = await tx.travelAgent.update({ where: { id }, data: { isActive: true } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.TRAVEL_AGENT_REACTIVATED",
      entityType: "TravelAgent",
      entityId: id,
      operation: "UPDATE",
      payload: { displayName: updated.displayName },
    });
    return updated;
  });
}

/** Search by name (case-insensitive substring), for the front-desk picker. */
export async function searchTravelAgents(prisma: PrismaClient, query: string) {
  const q = query.trim();
  if (!q) return [];
  return prisma.travelAgent.findMany({
    where: { isActive: true, displayName: { contains: q, mode: "insensitive" } },
    orderBy: { displayName: "asc" },
    take: 25,
  });
}
