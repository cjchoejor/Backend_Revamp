import { PrismaClient, Stage } from "@prisma/client";

const prisma = new PrismaClient();
const entryId = "ENT-20260529-0002";
const ACTOR = "SYSTEM";
const REASON = "ManualFix: backfill of S6 room-change amendment (pre-fix flow did not record AmendmentEventRecord)";

const entry = await prisma.entry.findUnique({
  where: { id: entryId },
  include: { segments: { orderBy: { segmentNumber: "asc" } } },
});
if (!entry) throw new Error("Entry not found");

const existing = await prisma.amendmentEventRecord.count({ where: { entryId } });
if (existing > 0) {
  console.log("Entry already has", existing, "amendments — nothing to backfill.");
  await prisma.$disconnect();
  process.exit(0);
}

// The room-change re-entry creates a new segment (segmentNumber > 1) under stage S1 with the
// REENTRY_S6_TO_S1 notes. Use that segment to anchor the amendment record.
const reentrySegment = entry.segments.find((s) => s.notes === "REENTRY_S6_TO_S1") ?? entry.segments[entry.segments.length - 1];
if (!reentrySegment) throw new Error("No segment to anchor amendment");

console.log("Backfilling amendment for entry", entryId, "segment", reentrySegment.id, `(${reentrySegment.segmentNumber})`);

await prisma.$transaction(async (tx) => {
  const now = new Date();
  const created = await tx.amendmentEventRecord.create({
    data: {
      entryId,
      segmentId: reentrySegment.id,
      amendmentPath: "PATH_1",
      amendmentType: "ROOM_CHANGE",
      requestedBy: ACTOR,
      authorisedBy: ACTOR,
      authorityBasis: "S6 room change re-entry (backfilled)",
      reason: REASON,
      newTermsSummary: "Room change at check-in (S6 → S1) — backfilled record for pre-fix re-entry",
      stageAtAmendment: Stage.S6,
    },
  });
  await tx.traceEvent.create({
    data: {
      eventType: "DATA_REPAIR.AMENDMENT_BACKFILLED",
      actorId: ACTOR,
      actorLevel: "SYSTEM",
      entityType: "AmendmentEventRecord",
      entityId: created.id,
      operation: "CREATE",
      timestamp: now,
      stageContext: entry.currentStage,
      inquiryId: entry.inquiryId,
      entryId,
      payload: {
        entryId,
        amendmentId: created.id,
        amendmentType: "ROOM_CHANGE",
        segmentId: reentrySegment.id,
        reason: REASON,
      },
      createdBy: ACTOR,
    },
  });
  console.log("Created amendment", created.id);
});

const after = await prisma.amendmentEventRecord.findMany({ where: { entryId } });
console.log("Amendments now:", after.length);
await prisma.$disconnect();
