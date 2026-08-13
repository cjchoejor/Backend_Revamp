import type { Prisma, PrismaClient } from "@prisma/client";
import { PreArrivalTaskType, TaskStatus } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { hashSha256, readDocument, verifyChecksum, writeDocument } from "../../lib/document-storage.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { enforceAcceptedIdentityDocumentType } from "../../policies/06-guest-identity/p16-accepted-document-types.js";
import { loadChildPolicyBundle } from "./child-policy-service.js";

/**
 * Guest identity PROOF files (2026-08-10, operator request): a photo or scan of the guest's
 * physical ID — passport, CID, licence — captured at the desk (S5 Arrival is the primary
 * surface) by uploading a file or taking a photo on the device.
 *
 * Where it lives, deliberately split in two:
 *  - the BYTES go to the write-once document store under STORAGE_ROOT_DIR (default
 *    `./storage`) — the same store as the bill PDFs: atomic writes, SHA-256 checksums,
 *    key shape `documents/YYYY/MM/identity-proof/…`, swappable for S3/GCS without touching
 *    call sites. Never into Postgres (blobs bloat the DB and every backup of it), and never
 *    re-writable (a stored proof is evidence).
 *  - the METADATA goes on `GuestIdentityDocument` — the table the S6 typed verification
 *    already writes — so one table answers "what do we hold about this guest's identity",
 *    and the existing per-doc-type retention machinery (`identity.retentionPeriodDays`,
 *    `retentionExpiresAt`) governs the photo exactly as it governs the typed record.
 *
 * This is evidence capture, not verification: storing a photo does NOT set
 * `identityVerifiedAt` — the S6 check-in verification (path + typed document) remains the
 * act that vouches a human checked the document against the guest.
 */

const MAX_BYTES = 10 * 1024 * 1024;

type DocTypeConfig = { documentTypeCode: string; documentTypeName?: string; isActive?: boolean };

/**
 * Placeholder docType a detail row carries when no type has been picked (the column is
 * non-nullable). Photo rows use "PHOTO_PROOF" the same way. The desk renders both as
 * "unselected" in the document-type dropdown.
 */
export const UNTYPED_DOC_TYPE = "PASSPORT_OR_PERMIT";

/** The admin-configured identity document types (`identity.documentTypes`), active only. */
async function configuredDocumentTypes(prisma: PrismaClient): Promise<{ code: string; name: string }[]> {
  const raw =
    (await requireActiveConfigValue<DocTypeConfig[] | undefined>(prisma, "identity.documentTypes")) ?? [];
  return raw
    .filter((d) => d?.documentTypeCode && d.isActive !== false)
    .map((d) => ({ code: d.documentTypeCode, name: d.documentTypeName?.trim() || d.documentTypeCode }));
}

/**
 * Vocabulary for the desk's document-type dropdowns — the guest-detail table (S5 + S6) and the
 * S6 verification select read THIS list, so an admin edit to `identity.documentTypes` moves
 * both and the desk never hardcodes codes the p16 allowlist would reject. Falls back to the
 * canonical seeded pair when the config is silent so the dropdown is never empty (p16 is
 * permissive in that case, so the fallback codes always pass verification too).
 */
export async function listIdentityDocumentTypeOptions(prisma: PrismaClient) {
  const configured = await configuredDocumentTypes(prisma);
  if (configured.length > 0) return configured;
  return [
    { code: "PASSPORT", name: "Passport" },
    { code: "CID", name: "National ID" },
  ];
}

/** Accepted upload types → storage extension. Keep in step with the desk's file inputs. */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

/**
 * The Arrival checklist's "guest details captured" tick (2026-08-12, operator request).
 *
 * Completes a PENDING GUEST_DETAILS_CAPTURED pre-arrival task. Runs inside the caller's
 * transaction; the caller decides the cause (coverage satisfied / VIP exempt). Idempotent —
 * no pending task (not seeded yet, already complete, or waived) is a no-op.
 */
export async function completeGuestDetailsTaskTx(
  tx: Prisma.TransactionClient,
  entryId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  cause: "COVERAGE_SATISFIED" | "VIP_EXEMPT",
) {
  const pending = await tx.preArrivalTask.findFirst({
    where: { entryId, taskType: PreArrivalTaskType.GUEST_DETAILS_CAPTURED, status: TaskStatus.PENDING },
    select: { id: true },
  });
  if (!pending) return { completed: false } as const;
  const now = new Date();
  await tx.preArrivalTask.update({
    where: { id: pending.id },
    data: { status: TaskStatus.COMPLETE, completedAt: now, completedBy: actor.actorId },
  });
  await tx.traceEvent.create({
    data: {
      eventType: "PRE_ARRIVAL_TASK.COMPLETED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "PreArrivalTask",
      entityId: pending.id,
      operation: "UPDATE",
      timestamp: now,
      entryId,
      payload: { entryId, taskType: "GUEST_DETAILS_CAPTURED", auto: true, cause },
      createdBy: actor.actorId,
    },
  });
  return { completed: true } as const;
}

/**
 * Best-effort follow-through after any capture write (typed detail save, desk upload, phone
 * upload — they all funnel through this service): the moment every party slot has a typed
 * document number or a stored ID photo, the Arrival checklist's GUEST_DETAILS_CAPTURED task
 * ticks itself — the operator never closes a checklist item the table above already proves.
 * VIP bookings tick as exempt, mirroring the S6 check-in gate. Never throws: the capture
 * itself has already committed, and a task hiccup must not fail it.
 */
export async function autoCompleteGuestDetailsTaskIfCovered(prisma: PrismaClient, entryId: string, actorId: string) {
  try {
    const pending = await prisma.preArrivalTask.findFirst({
      where: { entryId, taskType: PreArrivalTaskType.GUEST_DETAILS_CAPTURED, status: TaskStatus.PENDING },
      select: { id: true },
    });
    if (!pending) return { completed: false } as const;
    const coverage = await guestDetailsCoverageForEntry(prisma, entryId);
    if (!coverage.satisfied && !coverage.vipExempt) return { completed: false } as const;
    return await prisma.$transaction((tx) =>
      completeGuestDetailsTaskTx(tx, entryId, { actorId, actorLevel: "L1" }, coverage.satisfied ? "COVERAGE_SATISFIED" : "VIP_EXEMPT"),
    );
  } catch {
    return { completed: false } as const;
  }
}

export async function storeIdentityProof(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: {
    bytes: Buffer;
    mimeType: string;
    fileName?: string | null;
    documentType?: string | null;
    note?: string | null;
    /** Party slot this document belongs to (guest-board keys "A0".."An"/"K0".."Km") —
     *  every guest in the party gets their own proofs, not just the profile-holder. */
    subjectKey?: string | null;
    /** The person's name as the operator recorded it (typed off the document), or the
     *  slot label ("Adult 2") when unnamed. */
    subjectLabel?: string | null;
  },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, status: true, currentStage: true, inquiryId: true, guestProfileId: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (!entry.guestProfileId) {
    throw new ValidationError("This booking has no guest profile to attach the ID proof to");
  }

  if (!input.bytes?.length) throw new ValidationError("The upload is empty — no file bytes received");
  if (input.bytes.length > MAX_BYTES) {
    throw new ValidationError(`The file is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_BYTES / 1024 / 1024} MB`);
  }
  const mimeType = input.mimeType.toLowerCase();
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) {
    throw new ValidationError(
      `Unsupported file type "${input.mimeType}" — send a JPEG/PNG/WebP/HEIC photo or a PDF scan`,
    );
  }

  // Same retention resolution as the S6 typed verification (`recordVerification`) — per
  // document type, DEFAULT fallback, ~7 years if the config is silent — so the photo and the
  // typed record of the same document can never disagree about how long they're held.
  const retentionMap =
    (await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "identity.retentionPeriodDays")) ?? {};
  const docType = input.documentType?.trim() || "PHOTO_PROOF";
  const retentionDays = retentionMap[docType] ?? retentionMap.DEFAULT ?? 2555;

  const capturedAt = new Date();
  const retentionExpiresAt = new Date(capturedAt);
  retentionExpiresAt.setUTCDate(retentionExpiresAt.getUTCDate() + retentionDays);

  // Key shape mirrors the bill PDFs' YYYY/MM partitioning (archival + retention sweeps stay
  // trivial); the random suffix keeps the write-once store collision-free for rapid-fire
  // captures on one booking.
  const y = capturedAt.getUTCFullYear();
  const m = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
  const stamp = capturedAt.toISOString().replace(/\D/g, "").slice(0, 14);
  const storageKey = `documents/${y}/${m}/identity-proof/${entryId}-${stamp}-${randomBytes(4).toString("hex")}.${ext}`;

  // File first, row second: if the row write fails the orphan file is harmless (unreferenced,
  // swept by retention); a row pointing at a missing file would be the bad failure mode.
  await writeDocument(storageKey, input.bytes);
  const checksum = hashSha256(input.bytes);

  const created = await prisma.$transaction(async (tx) => {
    const created = await tx.guestIdentityDocument.create({
      data: {
        guestProfileId: entry.guestProfileId!,
        entryId: entry.id,
        documentType: docType,
        fileName: input.fileName?.trim() || null,
        mimeType,
        sizeBytes: input.bytes.length,
        storageKey,
        checksum,
        note: input.note?.trim() || null,
        subjectKey: input.subjectKey?.trim() || null,
        subjectLabel: input.subjectLabel?.trim() || null,
        capturedAt,
        capturedBy: actorId,
        retentionPeriod: retentionDays,
        retentionExpiresAt,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "GUEST.IDENTITY_PROOF_CAPTURED",
        actorId,
        actorLevel: "L1",
        entityType: "GuestIdentityDocument",
        entityId: created.id,
        operation: "CREATE",
        timestamp: capturedAt,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: {
          entryId: entry.id,
          guestProfileId: entry.guestProfileId,
          documentType: docType,
          mimeType,
          sizeBytes: input.bytes.length,
          storageKey,
          subjectKey: input.subjectKey?.trim() || null,
          subjectLabel: input.subjectLabel?.trim() || null,
          retentionExpiresAt: retentionExpiresAt.toISOString(),
        },
        createdBy: actorId,
      },
    });
    return created;
  });

  // A photo may have been the last missing piece — tick the Arrival checklist if so.
  await autoCompleteGuestDetailsTaskIfCovered(prisma, entryId, actorId);
  return created;
}

/**
 * Per-guest typed details for the Arrival guest-detail table (2026-08-10): passport/permit
 * number, name, DOB and gender as read off the document — one DETAIL row per
 * (entry, subjectKey), identified by `storageKey IS NULL` (photo rows are separate rows on
 * the same table and keep their own subject stamp). Upsert semantics: re-saving a slot
 * updates its row in place — typed details are working data, not write-once evidence; the
 * trace records each save.
 */
export async function saveGuestIdentityDetail(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: {
    subjectKey: string;
    subjectLabel?: string | null;
    /** One of the configured `identity.documentTypes` codes (2026-08-11 — the guest-detail
     *  table now records WHICH document the number came from, same vocabulary as the S6
     *  verification). Null/absent = not picked. */
    documentType?: string | null;
    documentNumber?: string | null;
    /** ISO calendar date (yyyy-mm-dd). */
    dateOfBirth?: string | null;
    gender?: string | null;
  },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, status: true, currentStage: true, inquiryId: true, guestProfileId: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (!entry.guestProfileId) {
    throw new ValidationError("This booking has no guest profile to attach guest details to");
  }
  const subjectKey = input.subjectKey.trim();
  if (!subjectKey) throw new ValidationError("subjectKey is required");

  const dateOfBirth = input.dateOfBirth?.trim() ? new Date(`${input.dateOfBirth.trim()}T00:00:00.000Z`) : null;
  if (dateOfBirth && Number.isNaN(dateOfBirth.getTime())) {
    throw new ValidationError("dateOfBirth must be a calendar date (yyyy-mm-dd)");
  }

  // Same acceptance rule as the S6 verification (p16): permissive when the allowlist is
  // unconfigured, else the type must be an active configured code.
  const documentType = input.documentType?.trim() || null;
  if (documentType) {
    const configured = await configuredDocumentTypes(prisma);
    enforceAcceptedIdentityDocumentType({
      documentType,
      acceptedDocumentTypeCodes: new Set(configured.map((d) => d.code)),
    });
  }

  const fields = {
    subjectLabel: input.subjectLabel?.trim() || null,
    // The column is non-nullable — an unpicked (or cleared) type keeps the legacy placeholder.
    documentType: documentType ?? UNTYPED_DOC_TYPE,
    documentNumber: input.documentNumber?.trim() || null,
    dateOfBirth,
    gender: input.gender?.trim() || null,
  };

  const now = new Date();
  const existing = await prisma.guestIdentityDocument.findFirst({
    where: { entryId: entry.id, subjectKey, storageKey: null },
    select: { id: true },
  });

  const saved = await prisma.$transaction(async (tx) => {
    let row;
    if (existing) {
      row = await tx.guestIdentityDocument.update({ where: { id: existing.id }, data: fields });
    } else {
      const retentionMap =
        (await requireActiveConfigValue<Record<string, number> | undefined>(tx as any, "identity.retentionPeriodDays")) ?? {};
      const retentionDays = (documentType ? retentionMap[documentType] : undefined) ?? retentionMap.DEFAULT ?? 2555;
      const retentionExpiresAt = new Date(now);
      retentionExpiresAt.setUTCDate(retentionExpiresAt.getUTCDate() + retentionDays);
      row = await tx.guestIdentityDocument.create({
        data: {
          guestProfileId: entry.guestProfileId!,
          entryId: entry.id,
          subjectKey,
          ...fields,
          capturedAt: now,
          capturedBy: actorId,
          retentionPeriod: retentionDays,
          retentionExpiresAt,
        },
      });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "GUEST.IDENTITY_DETAIL_RECORDED",
        actorId,
        actorLevel: "L1",
        entityType: "GuestIdentityDocument",
        entityId: row.id,
        operation: existing ? "UPDATE" : "CREATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: {
          entryId: entry.id,
          subjectKey,
          subjectLabel: fields.subjectLabel,
          documentType: documentType,
          documentNumber: fields.documentNumber,
          dateOfBirth: dateOfBirth?.toISOString().slice(0, 10) ?? null,
          gender: fields.gender,
        },
        createdBy: actorId,
      },
    });
    return row;
  });

  // A typed document number may have been the last missing piece — tick the Arrival checklist.
  await autoCompleteGuestDetailsTaskIfCovered(prisma, entryId, actorId);
  return saved;
}

/**
 * The party as capture slots — the ONE derivation the desk table, the S6 coverage gate and
 * the phone roster all share (adults + per-child ages off the intake breakdown, `guestCount`
 * anonymous fallback, guest-board keys A0…/K0…), so no two surfaces can disagree about who
 * is in the party. Labels are GENERIC ("Adult 1"), never the profile's name: the booking's
 * guest profile is the CONTACT PERSON, not necessarily anyone sleeping in the rooms
 * (operator ruling 2026-08-11). Callers overlay typed subjectLabels where they have them.
 */
function derivePartySlots(entry: {
  adultCount: number | null;
  childAges: number[] | null;
  guestCount: number | null;
}): { key: string; label: string }[] {
  const slots: { key: string; label: string }[] = [];
  const adults = Math.max(0, entry.adultCount ?? 0);
  const childAges = entry.childAges ?? [];
  if (adults > 0 || childAges.length > 0) {
    for (let i = 0; i < adults; i++) {
      slots.push({ key: `A${i}`, label: `Adult ${i + 1}` });
    }
    childAges.forEach((age, i) => slots.push({ key: `K${i}`, label: `Child ${i + 1} (${age}y)` }));
  } else {
    const n = Math.max(1, entry.guestCount ?? 1);
    for (let i = 0; i < n; i++) {
      slots.push({ key: `A${i}`, label: `Guest ${i + 1}` });
    }
  }
  return slots;
}

/** Room the phone page shows next to a guest ("Room 205 · Twin · Deluxe Double"). */
export type PhoneCaptureRoom = { roomNumber: string; bedType: string | null; roomTypeName: string | null };

/**
 * slot key → roomId, per the S2 composition. MIRRORS the desk's `seatPartyByComposition`
 * ([front_end/src/lib/desk/party-rooms.ts]) exactly — the composition stores COUNTS per room,
 * never which same-band person, so seating is re-derived deterministically: band pools in
 * party order, rooms in sealed order, adults → 6–10s → under-6s per room's counts. Keep the
 * two in step or the phone and the desk table would disagree about who sleeps where.
 */
function seatPartyByCompositionServer(
  entry: {
    adultCount: number | null;
    childAges: number[] | null;
    quotations: { state: string; createdAt: Date; commercialTerms: unknown }[];
    availabilityConfigs: { sealedAt: Date | null; optionSelected: unknown }[];
  },
  youngMax: number,
  childMax: number,
): Map<string, string> {
  const out = new Map<string, string>();
  type Comp = { roomId?: string | null; adultCount?: number; cnb6To10Count?: number; cnbUnder6Count?: number };
  const withComps = entry.quotations
    .filter((q) => {
      const comps = (q.commercialTerms as { roomCompositions?: unknown[] } | null)?.roomCompositions;
      return Array.isArray(comps) && comps.length > 0;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const operative =
    withComps.find((q) => q.state === "ACCEPTED") ??
    withComps.find((q) => q.state === "SENT" || q.state === "DRAFT") ??
    withComps[0];
  if (!operative) return out;
  const comps = ((operative.commercialTerms as { roomCompositions?: unknown[] }).roomCompositions ?? []) as Comp[];

  const pool: Record<"ADULT" | "C6TO10" | "UNDER6", string[]> = { ADULT: [], C6TO10: [], UNDER6: [] };
  for (let i = 0; i < Math.max(0, entry.adultCount ?? 0); i++) pool.ADULT.push(`A${i}`);
  (entry.childAges ?? []).forEach((age, i) => {
    pool[age <= youngMax ? "UNDER6" : age <= childMax ? "C6TO10" : "ADULT"].push(`K${i}`);
  });

  const sealed = entry.availabilityConfigs.find((c) => c.sealedAt && c.optionSelected);
  const sealedOrder = sealed ? readOptionSelected(sealed.optionSelected).distinctRoomIds : [];
  const order = sealedOrder.length > 0 ? sealedOrder : comps.map((c) => c.roomId).filter((id): id is string => !!id);
  for (const id of order) {
    const c = comps.find((x) => x.roomId === id);
    if (!c) continue;
    const take = (band: "ADULT" | "C6TO10" | "UNDER6", n: number) => {
      for (let i = 0; i < n; i++) {
        const key = pool[band].shift();
        if (!key) return;
        out.set(key, id);
      }
    };
    take("ADULT", c.adultCount ?? 0);
    take("C6TO10", c.cnb6To10Count ?? 0);
    take("UNDER6", c.cnbUnder6Count ?? 0);
  }
  return out;
}

/**
 * The party roster for the ALL-GUESTS phone capture page (2026-08-12): one row per slot with
 * the best label we hold (the typed name from the guest-detail table when there is one, the
 * generic slot label otherwise), how many photos are already stored for that slot on THIS
 * booking, and — when the S2 composition places the party — which room that guest sleeps in.
 * Also the upload route's validation source — a photo can only file under a slot this roster
 * contains.
 */
export async function phoneCaptureRoster(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      adultCount: true,
      childAges: true,
      guestCount: true,
      guestProfileId: true,
      quotations: { select: { state: true, createdAt: true, commercialTerms: true } },
      availabilityConfigs: {
        where: { sealedAt: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { sealedAt: true, optionSelected: true },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  const slots = derivePartySlots(entry);
  const rows = entry.guestProfileId
    ? await prisma.guestIdentityDocument.findMany({
        where: { entryId: entry.id, subjectKey: { not: null } },
        select: { subjectKey: true, subjectLabel: true, storageKey: true },
      })
    : [];

  // Who sleeps where, resolved to room number + bed + type name for display on the phone.
  const bundle = await loadChildPolicyBundle(prisma).catch(() => null);
  const seating = seatPartyByCompositionServer(
    entry,
    bundle?.ageBands.youngChildMaxAge ?? 5,
    bundle?.ageBands.childMaxAge ?? 10,
  );
  const seatedRoomIds = Array.from(new Set(seating.values()));
  const roomsById = new Map<string, PhoneCaptureRoom>();
  if (seatedRoomIds.length > 0) {
    const roomRows = await prisma.room.findMany({
      where: { id: { in: seatedRoomIds } },
      select: { id: true, roomNumber: true, bedType: true, roomType: { select: { name: true } } },
    });
    for (const r of roomRows) {
      roomsById.set(r.id, { roomNumber: r.roomNumber, bedType: r.bedType ?? null, roomTypeName: r.roomType?.name ?? null });
    }
  }

  return slots.map((s) => {
    const typedName = rows
      .find((r) => r.subjectKey === s.key && !r.storageKey && r.subjectLabel?.trim())
      ?.subjectLabel?.trim();
    const roomId = seating.get(s.key);
    return {
      key: s.key,
      label: typedName || s.label,
      photoCount: rows.filter((r) => r.subjectKey === s.key && r.storageKey).length,
      room: (roomId ? roomsById.get(roomId) : null) ?? null,
    };
  });
}

/**
 * Guest-detail coverage for the S6 check-in gate (2026-08-11, operator ruling): every guest in
 * the party must have their details on file before check-in — a typed document number OR a
 * stored ID photo counts; details captured at S5 carry forward automatically (the rows are
 * per-entry). VIP bookings are exempt — the caller skips the gate when `vipExempt` is true.
 *
 * Slots come from `derivePartySlots`, the same derivation as the desk table and the phone
 * roster, so the gate can never disagree about who is missing.
 */
export async function guestDetailsCoverageForEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      guestProfileId: true,
      adultCount: true,
      childAges: true,
      guestCount: true,
      guestProfile: { select: { vipTier: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  const vipExempt = !!entry.guestProfile?.vipTier?.trim();
  const slots = derivePartySlots(entry);

  const rows = entry.guestProfileId
    ? await prisma.guestIdentityDocument.findMany({
        where: { entryId: entry.id, subjectKey: { not: null } },
        select: { subjectKey: true, subjectLabel: true, documentNumber: true, storageKey: true },
      })
    : [];
  const filled = new Set<string>();
  for (const r of rows) {
    if (!r.subjectKey) continue;
    if (r.storageKey || r.documentNumber?.trim()) filled.add(r.subjectKey);
  }
  const missing = slots
    .filter((s) => !filled.has(s.key))
    .map((s) => ({
      key: s.key,
      // Prefer the name the operator already typed for the slot over the generic label.
      label: rows.find((r) => r.subjectKey === s.key && r.subjectLabel?.trim())?.subjectLabel?.trim() || s.label,
    }));

  return {
    vipExempt,
    totalSlots: slots.length,
    filledSlots: slots.length - missing.length,
    missing,
    satisfied: missing.length === 0,
  };
}

/**
 * Everything the Arrival guest-detail table needs, newest first: stored proof FILES for this
 * booking's guest — including files captured on the guest's earlier stays (a returning
 * guest's ID is already on file; the desk tags which rows came from this booking via
 * `entryId`) — plus THIS booking's per-guest DETAIL rows (no file, subject-keyed). The S6
 * typed verification's rows (no file, no subjectKey) stay off this surface.
 *
 * Also carries `documentTypes` (the config-driven dropdown vocabulary), `coverage` (the
 * S6 check-in gate's own verdict) and `returningGuest` (see below) so the desk never
 * re-derives any of them.
 */
export async function listIdentityProofsForEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, guestProfileId: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  const [documentTypes, coverage] = await Promise.all([
    listIdentityDocumentTypeOptions(prisma),
    guestDetailsCoverageForEntry(prisma, entryId),
  ]);
  if (!entry.guestProfileId) return { items: [], documentTypes, coverage, returningGuest: null };

  const [items, returningRow] = await Promise.all([
    prisma.guestIdentityDocument.findMany({
      where: {
        guestProfileId: entry.guestProfileId,
        OR: [{ storageKey: { not: null } }, { entryId: entry.id, subjectKey: { not: null } }],
      },
      orderBy: { capturedAt: "desc" },
      select: {
        id: true,
        entryId: true,
        documentType: true,
        documentNumber: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        note: true,
        subjectKey: true,
        subjectLabel: true,
        dateOfBirth: true,
        gender: true,
        capturedAt: true,
        capturedBy: true,
        retentionExpiresAt: true,
        storageKey: true,
      },
    }),
    // Returning guest (2026-08-11, operator request): the PROFILE-HOLDER's most recent
    // document number on file from BEFORE this booking — a prior stay's primary-guest detail
    // row or an S6 typed-verification record — so the desk pre-fills the primary row instead
    // of re-asking a known number. Restricted to slot "A0" or slot-less rows: a companion's
    // number from an earlier booking must never seed this booking's primary guest.
    prisma.guestIdentityDocument.findFirst({
      where: {
        guestProfileId: entry.guestProfileId,
        documentNumber: { not: null },
        AND: [
          { OR: [{ entryId: null }, { entryId: { not: entry.id } }] },
          { OR: [{ subjectKey: null }, { subjectKey: "A0" }] },
        ],
      },
      orderBy: { capturedAt: "desc" },
      select: { documentType: true, documentNumber: true, dateOfBirth: true, gender: true, capturedAt: true },
    }),
  ]);
  const returningGuest = returningRow
    ? {
        documentType:
          returningRow.documentType && returningRow.documentType !== UNTYPED_DOC_TYPE && returningRow.documentType !== "PHOTO_PROOF"
            ? returningRow.documentType
            : null,
        documentNumber: returningRow.documentNumber,
        dateOfBirth: returningRow.dateOfBirth,
        gender: returningRow.gender,
        capturedAt: returningRow.capturedAt,
      }
    : null;
  // The storage key itself is server-internal — expose only whether a file exists.
  return {
    items: items.map(({ storageKey, ...rest }) => ({ ...rest, hasFile: !!storageKey })),
    documentTypes,
    coverage,
    returningGuest,
  };
}

/** Stream-ready bytes for one stored proof, integrity-checked against the recorded SHA-256. */
export async function readIdentityProofFile(prisma: PrismaClient, proofId: string) {
  const row = await prisma.guestIdentityDocument.findUnique({
    where: { id: proofId },
    select: { id: true, storageKey: true, mimeType: true, fileName: true, checksum: true },
  });
  if (!row?.storageKey) throw new NotFoundError("Identity proof file");
  if (row.checksum) {
    const check = await verifyChecksum(row.storageKey, row.checksum);
    if (!check.ok) {
      throw new ValidationError("Stored file failed its integrity check — the bytes on disk no longer match the recorded checksum");
    }
  }
  const bytes = await readDocument(row.storageKey);
  return {
    bytes,
    mimeType: row.mimeType ?? "application/octet-stream",
    fileName: row.fileName ?? `${row.id}`,
  };
}
