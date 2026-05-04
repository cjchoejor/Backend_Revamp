import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError, PolicyGateBlockedError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";

function randomRef() {
  return `INQ-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export async function createInquiry(
  prisma: PrismaClient,
  actorId: string,
  input: {
    guestProfileId: string;
    sourceChannel: string;
    notes?: string;
    duplicateCheck?: { isDuplicate: boolean; conflictingInquiryId?: string };
  },
) {
  if (!input.guestProfileId?.trim()) throw new ValidationError("guestProfileId is required");
  if (!input.sourceChannel?.trim()) throw new ValidationError("sourceChannel is required");

  // Policy 12 (Duplicate detection) — stubbed: controller/test can pass duplicateCheck.
  if (input.duplicateCheck?.isDuplicate) {
    throw new PolicyGateBlockedError(
      "DUPLICATE_DETECTED",
      `Duplicate detected for guest profile${input.duplicateCheck.conflictingInquiryId ? ` (conflict: ${input.duplicateCheck.conflictingInquiryId})` : ""}`,
    );
  }

  // Policy 3 (Initial custodian assignment) — from ownership.assignmentRules.
  const rules = await requireActiveConfigValue<any[]>(prisma, "ownership.assignmentRules");
  const rule = rules.find((r) => String(r.channel).toUpperCase() === input.sourceChannel.toUpperCase());
  const custodian = rule?.custodianActorId ? String(rule.custodianActorId) : null;
  if (!custodian) throw new MissingConfigurationError("ownership.assignmentRules");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const created = await tx.inquiry.create({
      data: {
        referenceNumber: randomRef(),
        guestProfileId: input.guestProfileId,
        sourceChannel: input.sourceChannel,
        defaultCustodianId: custodian,
        notes: input.notes?.trim() || null,
        createdBy: actorId,
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "INQUIRY.CREATED",
        actorId,
        actorLevel: "L1",
        entityType: "Inquiry",
        entityId: created.id,
        operation: "CREATE",
        timestamp: now,
        inquiryId: created.id,
        payload: { inquiryId: created.id, sourceChannel: created.sourceChannel, guestProfileId: created.guestProfileId },
        createdBy: actorId,
      },
    });

    return created;
  });
}

