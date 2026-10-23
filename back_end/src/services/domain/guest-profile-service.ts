import type { PrismaClient } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { resolveVerificationPaths } from "../../lib/identity-verification-path.js";
import * as auditService from "../infrastructure/audit-service.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceAcceptedIdentityDocumentType } from "../../policies/06-guest-identity/p16-accepted-document-types.js";
import { resolveLeadSubjectKey } from "../../lib/lead-guest.js";

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
  // Neither is required on the guest's own record (2026-10-06, operator: "can the phone number be
  // not mandatory like email ... we usually just need it when travel agents come, but we cover
  // that on the top"). The booking still needs SOME way to reach someone before Negotiation —
  // Policy 16's S1 exit gate asks for it, and the agency's or the arriving person's number counts.
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() || null;

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

/**
 * Fill in a phone or an email the guest did not give at the inquiry (2026-10-10, operator: "while
 * inquiring the guest doesn't always give our number or emails, but if they're booking and rooms
 * are selected we have to ask them"). The Inquiry step's Wrap up asks for them once rooms are
 * chosen, and this is where they land.
 *
 * FILL ONLY, deliberately: a field already on file is never replaced. The guest's record is shared
 * by every booking they have ever made, so changing a number from one booking's desk would quietly
 * change where every other booking's papers go — that is a correction to the guest's record, which
 * has no desk route. A value equal to the one on file is a no-op; a different one is refused,
 * naming what is there.
 */
export async function addGuestProfileContact(
  prisma: PrismaClient,
  actorId: string,
  actorLevel: string,
  guestProfileId: string,
  input: { phone?: string | null; email?: string | null; entryId?: string | null },
) {
  const phone = input.phone?.trim() || null;
  const email = input.email?.trim() || null;
  if (!phone && !email) throw new ValidationError("Give the phone, the email, or both");

  return prisma.$transaction(async (tx) => {
    const current = await tx.guestProfile.findUnique({ where: { id: guestProfileId }, select: guestProfileSelect });
    if (!current) throw new NotFoundError("GuestProfile");

    const digits = (v: string) => v.replace(/\D/g, "");
    const data: { phone?: string; email?: string } = {};
    const refused: string[] = [];
    if (phone) {
      if (!current.phone?.trim()) data.phone = phone;
      else if (digits(current.phone) !== digits(phone)) refused.push(`a phone (${current.phone})`);
    }
    if (email) {
      if (!current.email?.trim()) data.email = email;
      else if (current.email.trim().toLowerCase() !== email.toLowerCase()) refused.push(`an email (${current.email})`);
    }
    if (refused.length) {
      throw new PolicyGateBlockedError(
        "GUEST_CONTACT_ON_FILE",
        `The guest already has ${refused.join(" and ")} on file — it is not changed from a booking`,
        { guestProfileId },
      );
    }
    if (!data.phone && !data.email) return { profile: current, added: [] as string[] };

    const profile = await tx.guestProfile.update({ where: { id: guestProfileId }, data, select: guestProfileSelect });
    const added = Object.keys(data);
    await auditService.emit(tx as any, { actorId, actorLevel: actorLevel as any }, {
      eventType: "GUEST_PROFILE.CONTACT_ADDED",
      entityType: "GuestProfile",
      entityId: guestProfileId,
      operation: "UPDATE",
      timestamp: new Date(),
      // Field names only — the values are on the record itself.
      payload: { guestProfileId, added, entryId: input.entryId ?? null },
      createdBy: actorId,
    });
    return { profile, added };
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
      // Whose row the verification vouched for (2026-10-23) — a later lead change voids it.
      payload: {
        entryId: body.entryId,
        guestProfileId,
        verificationPath: body.verificationPath,
        documentType: body.documentType ?? null,
        leadSubjectKey: resolveLeadSubjectKey(entry),
      },
      createdBy: actorId,
    },
  });

  return prisma.guestProfile.findUniqueOrThrow({ where: { id: guestProfileId } });
}
