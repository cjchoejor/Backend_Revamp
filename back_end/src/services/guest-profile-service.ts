import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, PolicyGateBlockedError, ValidationError } from "../lib/errors.js";

type VerificationPath = "FIRST_TIME" | "RETURNING_VALID" | "RETURNING_EXPIRED" | "VIP";

type DocTypeConfig = { documentTypeCode: string; documentTypeName?: string; isActive?: boolean };

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
) {
  const entry = await prisma.entry.findUnique({ where: { id: body.entryId } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.guestProfileId !== guestProfileId) {
    throw new ValidationError("Guest profile is not linked to this entry");
  }

  const profile = await prisma.guestProfile.findUnique({ where: { id: guestProfileId } });
  if (!profile) throw new NotFoundError("GuestProfile");

  const docTypesCfg = await prisma.configurationEntry.findUnique({ where: { configKey: "identity.documentTypes" } });
  if (!docTypesCfg) {
    throw new MissingConfigurationError("identity.documentTypes");
  }
  const docTypes = (docTypesCfg.value as DocTypeConfig[] | undefined) ?? [];
  const activeCodes = new Set(
    docTypes.filter((d) => d.isActive !== false).map((d) => d.documentTypeCode),
  );

  const retentionCfg = await prisma.configurationEntry.findUnique({ where: { configKey: "identity.retentionPeriodDays" } });
  if (!retentionCfg) {
    throw new MissingConfigurationError("identity.retentionPeriodDays");
  }
  const retentionMap = (retentionCfg?.value as Record<string, number> | undefined) ?? {};

  const now = new Date();

  if (body.verificationPath === "FIRST_TIME" || body.verificationPath === "RETURNING_EXPIRED") {
    if (!body.documentType?.trim()) {
      throw new ValidationError("documentType is required for this verification path");
    }
    if (activeCodes.size > 0 && !activeCodes.has(body.documentType)) {
      throw new PolicyGateBlockedError("DOCUMENT_TYPE_NOT_ACCEPTED", `Document type not accepted: ${body.documentType}`);
    }
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

  return prisma.guestProfile.findUniqueOrThrow({ where: { id: guestProfileId } });
}
