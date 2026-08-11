import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { hashSha256, readDocument, verifyChecksum, writeDocument } from "../../lib/document-storage.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";

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

/** Accepted upload types → storage extension. Keep in step with the desk's file inputs. */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

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

  return prisma.$transaction(async (tx) => {
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

  const fields = {
    subjectLabel: input.subjectLabel?.trim() || null,
    documentNumber: input.documentNumber?.trim() || null,
    dateOfBirth,
    gender: input.gender?.trim() || null,
  };

  const now = new Date();
  const existing = await prisma.guestIdentityDocument.findFirst({
    where: { entryId: entry.id, subjectKey, storageKey: null },
    select: { id: true },
  });

  return prisma.$transaction(async (tx) => {
    let row;
    if (existing) {
      row = await tx.guestIdentityDocument.update({ where: { id: existing.id }, data: fields });
    } else {
      const retentionMap =
        (await requireActiveConfigValue<Record<string, number> | undefined>(tx as any, "identity.retentionPeriodDays")) ?? {};
      const retentionDays = retentionMap.DEFAULT ?? 2555;
      const retentionExpiresAt = new Date(now);
      retentionExpiresAt.setUTCDate(retentionExpiresAt.getUTCDate() + retentionDays);
      row = await tx.guestIdentityDocument.create({
        data: {
          guestProfileId: entry.guestProfileId!,
          entryId: entry.id,
          documentType: "PASSPORT_OR_PERMIT",
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
          documentNumber: fields.documentNumber,
          dateOfBirth: dateOfBirth?.toISOString().slice(0, 10) ?? null,
          gender: fields.gender,
        },
        createdBy: actorId,
      },
    });
    return row;
  });
}

/**
 * Everything the Arrival guest-detail table needs, newest first: stored proof FILES for this
 * booking's guest — including files captured on the guest's earlier stays (a returning
 * guest's ID is already on file; the desk tags which rows came from this booking via
 * `entryId`) — plus THIS booking's per-guest DETAIL rows (no file, subject-keyed). The S6
 * typed verification's rows (no file, no subjectKey) stay off this surface.
 */
export async function listIdentityProofsForEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, guestProfileId: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.guestProfileId) return { items: [] as const };

  const items = await prisma.guestIdentityDocument.findMany({
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
  });
  // The storage key itself is server-internal — expose only whether a file exists.
  return { items: items.map(({ storageKey, ...rest }) => ({ ...rest, hasFile: !!storageKey })) };
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
