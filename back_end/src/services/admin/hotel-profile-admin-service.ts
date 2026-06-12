import type { PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";

export async function getHotelProfile(prisma: PrismaClient) {
  const row = await prisma.hotelProfile.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (!row) throw new NotFoundError("HotelProfile");
  return row;
}

export async function updateHotelProfile(
  prisma: PrismaClient,
  input: Partial<{
    expectedVersion: number;
    hotelName: string;
    registeredAddress: string;
    tradingAddress: string | null;
    contactNumbers: unknown;
    primaryEmail: string;
    operatingHours: unknown;
    publicHolidaySchedule: unknown;
    timeZone: string;
    propertyCurrency: string;
  }>,
  actorId: string,
) {
  const existing = await prisma.hotelProfile.findFirst({ orderBy: { createdAt: "asc" } });
  if (!existing) throw new NotFoundError("HotelProfile");

  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
    throw new ValidationError("HotelProfile was updated concurrently — refresh and retry");
  }

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "HotelProfile", entityId: existing.id, actorId });
    const updated = await tx.hotelProfile.update({
      where: { id: existing.id },
      data: {
        hotelName: input.hotelName?.trim(),
        registeredAddress: input.registeredAddress?.trim(),
        tradingAddress: input.tradingAddress === undefined ? undefined : input.tradingAddress?.trim() || null,
        contactNumbers: input.contactNumbers as never,
        primaryEmail: input.primaryEmail?.trim(),
        operatingHours: input.operatingHours as never,
        publicHolidaySchedule: input.publicHolidaySchedule as never,
        timeZone: input.timeZone?.trim(),
        propertyCurrency: input.propertyCurrency?.trim(),
        version: { increment: 1 },
        createdBy: actorId,
      },
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.HOTEL_PROFILE_UPDATED",
      entityType: "HotelProfile",
      entityId: updated.id,
      operation: "UPDATE",
      payload: {
        fieldsChanged: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
        newVersion: updated.version,
      },
    });

    return updated;
  });
}

