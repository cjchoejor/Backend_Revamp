import { cleanPhone } from "../../lib/phone-numbers.js";
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

  // Each number in the one stored form, or refused in words (2026-11-05).
  const contactNumbers = Array.isArray(input.contactNumbers)
    ? (input.contactNumbers as Array<{ label?: unknown; value?: unknown }>).map((c) => ({
        label: String(c?.label ?? "").trim(),
        value: cleanPhone(String(c?.value ?? ""), `The ${String(c?.label ?? "").trim() || "hotel's"} number`) ?? "",
      }))
    : input.contactNumbers;

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "HotelProfile", entityId: existing.id, actorId });
    const updated = await tx.hotelProfile.update({
      where: { id: existing.id },
      data: {
        hotelName: input.hotelName?.trim(),
        registeredAddress: input.registeredAddress?.trim(),
        tradingAddress: input.tradingAddress === undefined ? undefined : input.tradingAddress?.trim() || null,
        contactNumbers: contactNumbers as never,
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

