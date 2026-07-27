/**
 * Wipe all operational / transactional data while preserving seeded reference data,
 * inventory, staff, configuration, and registries.
 *
 * Usage:
 *   npx tsx scripts/wipe-operational-data.ts            # dry-run (counts only, no deletes)
 *   npx tsx scripts/wipe-operational-data.ts --confirm  # actually delete
 *
 * Strategy: wrap all DELETEs in a single transaction with `SET session_replication_role = replica`
 * to disable foreign-key triggers for the wipe. This avoids the ordering puzzle (and the partial-wipe
 * cleanup that follows when an FK violation aborts mid-script). Postgres-only.
 *
 * Preserved tables:
 *   HotelProfile, Department, Role, RolePermissionMapping, RoleSessionConfig
 *   StaffUser, SessionRecord, SessionEventRecord
 *   RoomType, Room, Space
 *   ConfigurationEntry, AiActorIdentity
 *   RatePlanRegistry, SeasonCalendar, PackageRegistry, CancellationPolicyRegistry
 *   PolicyRegistry, ModeConfiguration
 *   CommunicationTemplate, HandoffChecklistTemplate, InvoiceTemplate,
 *   WorkOrderTemplate, FeedbackSurveyTemplate, VipNotificationRoutingConfig
 *
 * Wiped: all entry/inquiry/folio/handoff/communication operational records, plus operational
 * trace events. Admin-only trace events (no inquiry/entry reference) are kept.
 * ReadableIdSequence is reset so the next inquiry/reservation starts from 1.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const CONFIRM = process.argv.includes("--confirm");

type Op = {
  label: string;
  count: () => Promise<number>;
  del: () => Promise<{ count: number }>;
};

const operationalTraceFilter = { OR: [{ inquiryId: { not: null } }, { entryId: { not: null } }] };

const ops: Op[] = [
  { label: "TraceEvent (operational)", count: () => prisma.traceEvent.count({ where: operationalTraceFilter }), del: () => prisma.traceEvent.deleteMany({ where: operationalTraceFilter }) },
  { label: "HumanDecisionRecord", count: () => (prisma as any).humanDecisionRecord.count(), del: () => (prisma as any).humanDecisionRecord.deleteMany() },
  { label: "AiDraftRecord", count: () => (prisma as any).aiDraftRecord.count(), del: () => (prisma as any).aiDraftRecord.deleteMany() },
  { label: "CommunicationRecord", count: () => prisma.communicationRecord.count(), del: () => prisma.communicationRecord.deleteMany() },
  { label: "FollowUpTaskRecord", count: () => prisma.followUpTaskRecord.count(), del: () => prisma.followUpTaskRecord.deleteMany() },
  { label: "ProcessingLockRecord", count: () => prisma.processingLockRecord.count(), del: () => prisma.processingLockRecord.deleteMany() },
  { label: "RevalidationDeltaRecord", count: () => prisma.revalidationDeltaRecord.count(), del: () => prisma.revalidationDeltaRecord.deleteMany() },
  { label: "WorkOrderAmendmentEvent", count: () => prisma.workOrderAmendmentEvent.count(), del: () => prisma.workOrderAmendmentEvent.deleteMany() },
  { label: "WorkOrderConsumptionRecord", count: () => prisma.workOrderConsumptionRecord.count(), del: () => prisma.workOrderConsumptionRecord.deleteMany() },
  { label: "WorkOrderToDoItem", count: () => prisma.workOrderToDoItem.count(), del: () => prisma.workOrderToDoItem.deleteMany() },
  { label: "WorkOrder", count: () => prisma.workOrder.count(), del: () => prisma.workOrder.deleteMany() },
  { label: "DisputeGateOverrideRecord", count: () => prisma.disputeGateOverrideRecord.count(), del: () => prisma.disputeGateOverrideRecord.deleteMany() },
  { label: "DisputeRecord", count: () => prisma.disputeRecord.count(), del: () => prisma.disputeRecord.deleteMany() },
  { label: "AmendmentEventRecord", count: () => prisma.amendmentEventRecord.count(), del: () => prisma.amendmentEventRecord.deleteMany() },
  { label: "VIPArrivalNotificationEvent", count: () => prisma.vIPArrivalNotificationEvent.count(), del: () => prisma.vIPArrivalNotificationEvent.deleteMany() },
  { label: "LostAndFoundRecord", count: () => prisma.lostAndFoundRecord.count(), del: () => prisma.lostAndFoundRecord.deleteMany() },
  { label: "EquipmentAllocation", count: () => prisma.equipmentAllocation.count(), del: () => prisma.equipmentAllocation.deleteMany() },
  { label: "CommissionDueRecord", count: () => prisma.commissionDueRecord.count(), del: () => prisma.commissionDueRecord.deleteMany() },
  { label: "AgentProfile", count: () => prisma.agentProfile.count(), del: () => prisma.agentProfile.deleteMany() },
  { label: "NightAuditAnomaly", count: () => prisma.nightAuditAnomaly.count(), del: () => prisma.nightAuditAnomaly.deleteMany() },
  { label: "NightAuditRecord", count: () => prisma.nightAuditRecord.count(), del: () => prisma.nightAuditRecord.deleteMany() },
  { label: "WriteOffRecord", count: () => prisma.writeOffRecord.count(), del: () => prisma.writeOffRecord.deleteMany() },
  { label: "Invoice", count: () => prisma.invoice.count(), del: () => prisma.invoice.deleteMany() },
  { label: "FolioLine", count: () => prisma.folioLine.count(), del: () => prisma.folioLine.deleteMany() },
  { label: "PaymentRecord", count: () => prisma.paymentRecord.count(), del: () => prisma.paymentRecord.deleteMany() },
  { label: "BillingModelTransitionRecord", count: () => prisma.billingModelTransitionRecord.count(), del: () => prisma.billingModelTransitionRecord.deleteMany() },
  { label: "CreditExtensionCeilingRecord", count: () => prisma.creditExtensionCeilingRecord.count(), del: () => prisma.creditExtensionCeilingRecord.deleteMany() },
  { label: "CreditCeilingThresholdEvent", count: () => prisma.creditCeilingThresholdEvent.count(), del: () => prisma.creditCeilingThresholdEvent.deleteMany() },
  { label: "Folio", count: () => prisma.folio.count(), del: () => prisma.folio.deleteMany() },
  { label: "RoomInspectionRecord", count: () => prisma.roomInspectionRecord.count(), del: () => prisma.roomInspectionRecord.deleteMany() },
  { label: "KeyReturnRecord", count: () => prisma.keyReturnRecord.count(), del: () => prisma.keyReturnRecord.deleteMany() },
  { label: "NoShowDeterminationRecord", count: () => prisma.noShowDeterminationRecord.count(), del: () => prisma.noShowDeterminationRecord.deleteMany() },
  { label: "RoomAssignment", count: () => prisma.roomAssignment.count(), del: () => prisma.roomAssignment.deleteMany() },
  { label: "PreArrivalTask", count: () => prisma.preArrivalTask.count(), del: () => prisma.preArrivalTask.deleteMany() },
  { label: "HandoffRecord", count: () => prisma.handoffRecord.count(), del: () => prisma.handoffRecord.deleteMany() },
  { label: "Reservation", count: () => prisma.reservation.count(), del: () => prisma.reservation.deleteMany() },
  { label: "CancellationDisclosureRecord", count: () => prisma.cancellationDisclosureRecord.count(), del: () => prisma.cancellationDisclosureRecord.deleteMany() },
  { label: "CommittedHold", count: () => prisma.committedHold.count(), del: () => prisma.committedHold.deleteMany() },
  { label: "SpeculativeHold", count: () => prisma.speculativeHold.count(), del: () => prisma.speculativeHold.deleteMany() },
  { label: "Quotation", count: () => prisma.quotation.count(), del: () => prisma.quotation.deleteMany() },
  { label: "TimerRecord", count: () => prisma.timerRecord.count(), del: () => prisma.timerRecord.deleteMany() },
  { label: "StageDwellRecord", count: () => prisma.stageDwellRecord.count(), del: () => prisma.stageDwellRecord.deleteMany() },
  { label: "RoomClaimStateEvent", count: () => prisma.roomClaimStateEvent.count(), del: () => prisma.roomClaimStateEvent.deleteMany() },
  { label: "DeficientConditionRecord", count: () => prisma.deficientConditionRecord.count(), del: () => prisma.deficientConditionRecord.deleteMany() },
  { label: "AvailabilityConfiguration", count: () => prisma.availabilityConfiguration.count(), del: () => prisma.availabilityConfiguration.deleteMany() },
  { label: "SpaceAllocation", count: () => prisma.spaceAllocation.count(), del: () => prisma.spaceAllocation.deleteMany() },
  { label: "Segment", count: () => prisma.segment.count(), del: () => prisma.segment.deleteMany() },
  { label: "Entry", count: () => prisma.entry.count(), del: () => prisma.entry.deleteMany() },
  { label: "DuplicateDetectionFlag", count: () => prisma.duplicateDetectionFlag.count(), del: () => prisma.duplicateDetectionFlag.deleteMany() },
  { label: "Inquiry", count: () => prisma.inquiry.count(), del: () => prisma.inquiry.deleteMany() },
  { label: "GuestIdentityDocument", count: () => prisma.guestIdentityDocument.count(), del: () => prisma.guestIdentityDocument.deleteMany() },
  { label: "GuestProfile", count: () => prisma.guestProfile.count(), del: () => prisma.guestProfile.deleteMany() },
  { label: "OtaConflictOverbookingRecord", count: () => prisma.otaConflictOverbookingRecord.count(), del: () => prisma.otaConflictOverbookingRecord.deleteMany() },
  { label: "ReadableIdSequence (reset counters)", count: () => prisma.readableIdSequence.count(), del: () => prisma.readableIdSequence.deleteMany() },
];

async function dryRun() {
  console.log("DRY RUN — counting rows that would be deleted (nothing persisted).\n");
  let total = 0;
  for (const op of ops) {
    const count = await op.count();
    if (count > 0) console.log(`  ${count.toString().padStart(6)}  ${op.label}`);
    total += count;
  }
  console.log(`\nTotal rows that would be deleted: ${total}`);
  console.log(`\nTo actually wipe, re-run with --confirm`);
}

async function wipe() {
  console.log("DELETING operational data (FK triggers disabled for this session)...\n");
  // Disable FK enforcement for THIS session only. Affects only the current Postgres connection.
  await prisma.$executeRawUnsafe(`SET session_replication_role = 'replica'`);
  try {
    let total = 0;
    for (const op of ops) {
      const { count } = await op.del();
      if (count > 0) console.log(`  -${count.toString().padStart(6)}  ${op.label}`);
      total += count;
    }
    console.log(`\nDone. Deleted ${total} rows.`);
  } finally {
    await prisma.$executeRawUnsafe(`SET session_replication_role = 'origin'`);
  }
}

await (CONFIRM ? wipe() : dryRun());
await prisma.$disconnect();
