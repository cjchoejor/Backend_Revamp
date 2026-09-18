import type { PrismaClient } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { resolveVerificationPaths } from "../../lib/identity-verification-path.js";
import * as auditService from "../infrastructure/audit-service.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceAcceptedIdentityDocumentType } from "../../policies/06-guest-identity/p16-accepted-document-types.js";

type VerificationPath = "FIRST_TIME" | "RETURNING_VALID" | "RETURNING_EXPIRED" | "VIP";

type DocTypeConfig = { documentTypeCode: string; documentTypeName?: string; isActive?: boolean };

const guestProfileSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  nationality: true,
  vipTier: true,
  clientTier: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function createGuestProfile(
  prisma: PrismaClient,
  actorId: string,
  actorLevel: string,
  input: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    nationality?: string;
    clientTier?: string;
  },
) {
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() || null;
  if (!email && !phone) {
    throw new ValidationError("At least one of email or phone is required");
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const created = await tx.guestProfile.create({
      data: {
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email,
        phone,
        nationality: input.nationality?.trim() || null,
        clientTier: input.clientTier?.trim() || "STANDARD",
        createdBy: actorId,
      },
      select: guestProfileSelect,
    });

    await auditService.emit(tx as any, { actorId, actorLevel: actorLevel as any }, {
      eventType: "GUEST_PROFILE.CREATED",
      entityType: "GuestProfile",
      entityId: created.id,
      operation: "CREATE",
      timestamp: now,
      payload: { guestProfileId: created.id },
      createdBy: actorId,
    });

    return created;
  });
}

export async function searchGuestProfiles(
  prisma: PrismaClient,
  query: { q?: string; limit: number },
) {
  const term = query.q?.trim();
  const where = term
    ? {
        isActive: true,
        OR: [
          { firstName: { contains: term, mode: "insensitive" as const } },
          { lastName: { contains: term, mode: "insensitive" as const } },
          { email: { contains: term, mode: "insensitive" as const } },
          { phone: { contains: term, mode: "insensitive" as const } },
        ],
      }
    : { isActive: true };

  const items = await prisma.guestProfile.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }],
    take: query.limit,
    select: guestProfileSelect,
  });

  return { items, count: items.length };
}

export async function getGuestProfileById(prisma: PrismaClient, guestProfileId: string) {
  const profile = await prisma.guestProfile.findUnique({
    where: { id: guestProfileId },
    select: guestProfileSelect,
  });
  if (!profile) throw new NotFoundError("GuestProfile");
  return profile;
}

export async function recordVerification(
  prisma: PrismaClient,
  guestProfileId: string,
  actorId: string,
  body: {
    entryId: string;
    verificationPath: VerificationPath;
    documentType?: string;
    documentNumber?: string;
    issuingCountry?: string;
    expiryDate?: string;
  },
  actorLevel: "L1" | "L2" | "L3" | "L4" = "L1",
) {
  const entry = await prisma.entry.findUnique({ where: { id: body.entryId } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.guestProfileId !== guestProfileId) {
    throw new ValidationError("Guest profile is not linked to this entry");
  }

  const profile = await prisma.guestProfile.findUnique({ where: { id: guestProfileId } });
  if (!profile) throw new NotFoundError("GuestProfile");

  const docTypes = (await requireActiveConfigValue<DocTypeConfig[] | undefined>(prisma, "identity.documentTypes")) ?? [];
  const activeCodes = new Set(
    docTypes.filter((d) => d.isActive !== false).map((d) => d.documentTypeCode),
  );

  const retentionMap = (await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "identity.retentionPeriodDays")) ?? {};

  const now = new Date();

  // The path must be one the guest's profile allows (SIG-S6 §756) — a first-time guest cannot be
  // waved through as "returning" with no document, nor anyone through the VIP path without a tier.
  const standing = await resolveVerificationPaths(prisma, { guestProfileId, entryId: body.entryId, now });
  if (!standing.allowed.includes(body.verificationPath)) {
    throw new PolicyGateBlockedError(
      "VERIFICATION_PATH_NOT_ALLOWED",
      standing.refused[body.verificationPath] ?? "This verification path does not apply to this guest",
      { suggested: standing.suggested, allowed: standing.allowed },
    );
  }

  if (body.verificationPath === "FIRST_TIME" || body.verificationPath === "RETURNING_EXPIRED") {
    if (!body.documentType?.trim()) {
      throw new ValidationError("documentType is required for this verification path");
    }
    enforceAcceptedIdentityDocumentType({ documentType: body.documentType, acceptedDocumentTypeCodes: activeCodes });
    if (body.verificationPath === "FIRST_TIME" && !body.documentNumber?.trim()) {
      throw new ValidationError("documentNumber is required for FIRST_TIME");
    }

    const docType = body.documentType;
    const retentionDays = retentionMap[docType] ?? retentionMap.DEFAULT ?? 2555;

    const capturedAt = now;
    const retentionExpiresAt = new Date(capturedAt);
    retentionExpiresAt.setUTCDate(retentionExpiresAt.getUTCDate() + retentionDays);

    await prisma.$transaction(async (tx) => {
      if (body.documentNumber) {
        await tx.guestIdentityDocument.create({
          data: {
            guestProfileId,
            // The booking it was captured for, so a later stay can tell "on file from before".
            entryId: body.entryId,
            documentType: docType,
            documentNumber: body.documentNumber.trim(),
            issuingCountry: body.issuingCountry ?? null,
            expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
            capturedAt,
            capturedBy: actorId,
            retentionPeriod: retentionDays,
            retentionExpiresAt,
          },
        });
      }
      await tx.guestProfile.update({
        where: { id: guestProfileId },
        data: {
          identityVerifiedAt: now,
          identityVerifiedBy: actorId,
          identityVerificationPath: body.verificationPath,
          updatedAt: now,
        },
      });
    });
  } else {
    await prisma.guestProfile.update({
      where: { id: guestProfileId },
      data: {
        identityVerifiedAt: now,
        identityVerifiedBy: actorId,
        identityVerificationPath: body.verificationPath,
        updatedAt: now,
      },
    });
  }

  await prisma.traceEvent.create({
    data: {
      eventType: "GUEST.IDENTITY_VERIFIED",
      actorId,
      actorLevel,
      entityType: "GuestProfile",
      entityId: guestProfileId,
      operation: "UPDATE",
      timestamp: now,
      stageContext: entry.currentStage,
      inquiryId: entry.inquiryId,
      entryId: body.entryId,
      payload: { entryId: body.entryId, guestProfileId, verificationPath: body.verificationPath, documentType: body.documentType ?? null },
      createdBy: actorId,
    },
  });

  return prisma.guestProfile.findUniqueOrThrow({ where: { id: guestProfileId } });
}
