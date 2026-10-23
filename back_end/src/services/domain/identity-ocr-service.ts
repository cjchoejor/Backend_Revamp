/**
 * Identity extraction suggestions — OCR / QR → guest-detail table (2026-08-18).
 *
 * The contract (docs/id-proof-capture-and-ocr.md §2.1):
 *   1. Output is a SUGGESTION the desk operator applies — never a direct write. `apply` goes
 *      through `saveGuestIdentityDetail`, so the coverage gate, p16 docType allowlist and the
 *      detail traces are untouched. Nothing here ever touches `identityVerifiedAt`.
 *   2. The PHONE IS A SENSOR, THE SERVER IS THE BRAIN. The capture page may decode the QR /
 *      read the MRZ on the device (it has the camera and a CPU), but it sends the RAW payload
 *      (MRZ lines / QR text) + whatever the person corrected on the phone; the server
 *      re-parses the raw payload, re-verifies check digits, maps the document type into the
 *      `identity.documentTypes` vocabulary and only then stores the suggestion. A phone can
 *      never inject a document code the hotel does not accept or a "verified" mark it did not
 *      earn.
 *   3. Photos that arrive with no phone extraction (desk uploads, older captures) get the
 *      same pipeline server-side from the W39 worker — best-effort, never in a request path.
 *   4. Nothing leaves the server. Traces carry field NAMES + confidence, never the values.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { extractMrzLines, parseMrzLines } from "../../lib/identity-ocr/mrz.js";
import { partyAgeChecker, type AgeCheck } from "../../lib/party-age-check.js";
import { parseIdentityQrText } from "../../lib/identity-ocr/aadhaar-qr.js";
import type {
  FieldConfidence,
  IdentityExtraction,
  IdentitySuggestedFields,
  OcrEngine,
  OcrSuggestionStatus,
} from "../../lib/identity-ocr/types.js";
import {
  listIdentityDocumentTypeOptions,
  readIdentityProofFile,
  saveGuestIdentityDetail,
} from "./guest-identity-proof-service.js";

const SUGGESTABLE_KEYS: (keyof IdentitySuggestedFields)[] = [
  "documentType",
  "documentNumber",
  "documentNumberLast4",
  "fullName",
  "dateOfBirth",
  "gender",
  "nationality",
  "expiryDate",
];

/** `OCR_DISABLE=true` turns the server-side worker off (phone-side extraction still lands). */
export function serverOcrDisabled(): boolean {
  return process.env.OCR_DISABLE === "true";
}

/**
 * Keep only fields the desk can use, and only a document type the hotel accepts (an
 * unmapped/unknown code is dropped, never invented). Phone-typed edits are trimmed strings.
 */
async function sanitiseFields(
  prisma: PrismaClient,
  fields: IdentitySuggestedFields,
  confidence: IdentityExtraction["fieldConfidence"],
): Promise<{ fields: IdentitySuggestedFields; fieldConfidence: IdentityExtraction["fieldConfidence"] }> {
  const out: IdentitySuggestedFields = {};
  const conf: IdentityExtraction["fieldConfidence"] = {};
  for (const k of SUGGESTABLE_KEYS) {
    const v = fields[k];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    if (k === "dateOfBirth" || k === "expiryDate") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(new Date(`${t}T00:00:00Z`).getTime())) continue;
    }
    if (k === "gender" && !/^[MFX]$/.test(t.toUpperCase())) continue;
    out[k] = k === "gender" ? t.toUpperCase() : t.slice(0, 200);
    conf[k] = confidence[k] ?? "READ";
  }
  if (out.documentType) {
    const accepted = new Set((await listIdentityDocumentTypeOptions(prisma)).map((d) => d.code));
    if (!accepted.has(out.documentType)) {
      delete out.documentType;
      delete conf.documentType;
    }
  }
  return { fields: out, fieldConfidence: conf };
}

async function loadPhoto(prisma: PrismaClient, photoDocumentId: string) {
  const photo = await prisma.guestIdentityDocument.findUnique({
    where: { id: photoDocumentId },
    select: { id: true, entryId: true, subjectKey: true, storageKey: true, mimeType: true, clearedAt: true },
  });
  if (!photo || !photo.storageKey) throw new NotFoundError("Identity proof photo");
  if (!photo.entryId) throw new ValidationError("This photo is not attached to a booking");
  return photo as typeof photo & { entryId: string };
}

async function writeSuggestion(
  prisma: PrismaClient,
  photo: { id: string; entryId: string; subjectKey: string | null },
  data: {
    engine: OcrEngine;
    status: OcrSuggestionStatus;
    fields?: IdentitySuggestedFields | null;
    fieldConfidence?: IdentityExtraction["fieldConfidence"] | null;
    raw?: IdentityExtraction["raw"] | null;
    error?: string | null;
    actorId: string;
  },
) {
  const now = new Date();
  const row = await prisma.identityOcrSuggestion.upsert({
    where: { photoDocumentId: photo.id },
    create: {
      photoDocumentId: photo.id,
      entryId: photo.entryId,
      subjectKey: photo.subjectKey,
      engine: data.engine,
      status: data.status,
      fields: (data.fields ?? undefined) as Prisma.InputJsonValue | undefined,
      fieldConfidence: (data.fieldConfidence ?? undefined) as Prisma.InputJsonValue | undefined,
      raw: (data.raw ?? undefined) as Prisma.InputJsonValue | undefined,
      error: data.error ?? null,
      extractedAt: now,
      stage: null,
      stageAt: null,
    },
    update: {
      engine: data.engine,
      status: data.status,
      fields: (data.fields ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
      fieldConfidence: (data.fieldConfidence ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
      raw: (data.raw ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
      error: data.error ?? null,
      extractedAt: now,
      appliedAt: null,
      appliedBy: null,
      dismissedAt: null,
      dismissedBy: null,
      stage: null,
      stageAt: null,
    },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "GUEST.IDENTITY_OCR_SUGGESTED",
      actorId: data.actorId,
      actorLevel: "SYSTEM",
      entityType: "IdentityOcrSuggestion",
      entityId: row.id,
      operation: "UPSERT",
      timestamp: now,
      entryId: photo.entryId,
      // Names + confidence only — never the values (guest PII stays out of the trace table).
      payload: {
        photoDocumentId: photo.id,
        subjectKey: photo.subjectKey,
        engine: data.engine,
        status: data.status,
        fields: Object.keys(data.fields ?? {}),
        fieldConfidence: data.fieldConfidence ?? null,
        source: data.raw?.source ?? null,
        error: data.error ?? null,
      },
      createdBy: data.actorId,
    },
  });
  return row;
}

/**
 * Parse a phone's raw reading WITHOUT storing anything — the capture page calls this before
 * the upload so the person can see and correct the fields; the phone never interprets the
 * MRZ/QR itself (the parser, the check digits and the document-type allowlist live here).
 * `ocrText` is the tesseract dump of the page's lower part; the MRZ lines are pulled out of it.
 */
export async function previewPhoneExtraction(
  prisma: PrismaClient,
  input: { ocrText?: string | null; mrzLines?: string[] | null; qrText?: string | null },
): Promise<{ engine: OcrEngine | null; fields: IdentitySuggestedFields; fieldConfidence: IdentityExtraction["fieldConfidence"]; raw: IdentityExtraction["raw"] | null }> {
  let base: IdentityExtraction | null = null;
  let engine: OcrEngine | null = null;
  if (input.qrText?.trim()) {
    base = parseIdentityQrText(input.qrText);
    if (base) engine = "PHONE_QR";
  }
  if (!base) {
    const lines = input.mrzLines?.length ? input.mrzLines : input.ocrText ? extractMrzLines(input.ocrText) : null;
    if (lines) {
      base = parseMrzLines(lines);
      if (base) engine = "PHONE_MRZ";
    }
  }
  if (!base || base.empty) {
    // A QR WAS decoded but its payload carried nothing recognisable — tell the phone so,
    // instead of a flat "nothing found" (the person can see the code on the card).
    const qrFound = !!input.qrText?.trim();
    return {
      engine: null,
      fields: {},
      fieldConfidence: {},
      raw: qrFound ? { qrText: input.qrText!.trim().slice(0, 300), source: "QR_UNRECOGNISED" } : null,
    };
  }
  const clean = await sanitiseFields(prisma, base.fields, base.fieldConfidence);
  return { engine, fields: clean.fields, fieldConfidence: clean.fieldConfidence, raw: base.raw };
}

/**
 * Full server-side read of an image the phone is PREVIEWING (2026-08-17, operator ruling:
 * "the phone should act like an OCR machine — fields fill in before sending"). The phone's
 * own pass only covers QR + MRZ; label documents (CID, work permit, birth certificate) need
 * the layout engine, which lives here. Nothing is stored — the phone shows the fields for
 * the person to confirm, and they travel with the eventual upload. Runs the same
 * `extractIdentityFromImage` pipeline as W39, so a document the worker could read, the
 * phone preview can too.
 */
/** The four layouts the printed-text reader anchors on; any other type gives no layout hint. */
type LayoutKind = "CID" | "VOTER_CARD" | "BIRTH_CERTIFICATE" | "WORK_PERMIT" | "PASSPORT";
const asLayoutKind = (t: string | null | undefined): LayoutKind | null =>
  t === "CID" || t === "VOTER_CARD" || t === "BIRTH_CERTIFICATE" || t === "WORK_PERMIT" || t === "PASSPORT" ? t : null;

export async function analyzeIdentityImage(
  prisma: PrismaClient,
  bytes: Buffer,
  opts: { entryId?: string; subjectKey?: string | null; documentType?: string | null } = {},
): Promise<{
  available: boolean;
  engine: OcrEngine | null;
  fields: IdentitySuggestedFields;
  fieldConfidence: IdentityExtraction["fieldConfidence"];
  source: string | null;
}> {
  if (serverOcrDisabled()) return { available: false, engine: null, fields: {}, fieldConfidence: {}, source: null };
  const { extractIdentityFromImage } = await import("../../lib/identity-ocr/server-extract.js");
  // The type picked on the phone first (2026-10-23); else the W39 pass's hint, a desk row that
  // already names the document type.
  let kindHint: LayoutKind | null = asLayoutKind(opts.documentType);
  if (!kindHint && opts.entryId && opts.subjectKey) {
    const detail = await prisma.guestIdentityDocument.findFirst({
      where: { entryId: opts.entryId, subjectKey: opts.subjectKey, storageKey: null },
      select: { documentType: true },
    });
    kindHint = asLayoutKind(detail?.documentType);
  }
  const result = await extractIdentityFromImage(bytes, { kindHint });
  if (!result) return { available: true, engine: null, fields: {}, fieldConfidence: {}, source: null };
  if (opts.documentType && !result.extraction.fields.documentType) {
    result.extraction.fields.documentType = opts.documentType;
    result.extraction.fieldConfidence.documentType = "READ";
  }
  const clean = await sanitiseFields(prisma, result.extraction.fields, result.extraction.fieldConfidence);
  return {
    available: true,
    engine: result.engine,
    fields: clean.fields,
    fieldConfidence: clean.fieldConfidence,
    source: result.extraction.raw.source ?? null,
  };
}

/**
 * A phone-side extraction for a photo that was just uploaded. `mrzLines` / `qrText` are the
 * RAW machine-readable payloads the phone decoded (re-parsed here — the phone's own field
 * interpretation is never trusted); `fields` are what the person on the phone saw and
 * possibly corrected, layered on top as READ values.
 */
export async function ingestPhoneExtraction(
  prisma: PrismaClient,
  actorId: string,
  input: {
    photoDocumentId: string;
    mrzLines?: string[] | null;
    qrText?: string | null;
    fields?: IdentitySuggestedFields | null;
  },
) {
  const photo = await loadPhoto(prisma, input.photoDocumentId);
  let base: IdentityExtraction | null = null;
  let engine: OcrEngine = "PHONE_MANUAL";
  if (input.qrText?.trim()) {
    base = parseIdentityQrText(input.qrText);
    if (base) engine = "PHONE_QR";
  }
  if (!base && input.mrzLines?.length) {
    base = parseMrzLines(input.mrzLines);
    if (base) engine = "PHONE_MRZ";
  }
  const merged: IdentitySuggestedFields = { ...(base?.fields ?? {}) };
  const conf: IdentityExtraction["fieldConfidence"] = { ...(base?.fieldConfidence ?? {}) };
  // Phone edits: a value the person changed/typed overrides the machine read and is READ —
  // an edited MRZ field no longer carries the document's own proof.
  for (const k of SUGGESTABLE_KEYS) {
    const v = input.fields?.[k];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    if (merged[k] !== t) {
      merged[k] = t;
      conf[k] = "READ";
    }
  }
  const clean = await sanitiseFields(prisma, merged, conf);
  const status: OcrSuggestionStatus = Object.keys(clean.fields).length ? "READY" : "EMPTY";
  return writeSuggestion(prisma, photo, {
    engine,
    status,
    fields: clean.fields,
    fieldConfidence: clean.fieldConfidence,
    raw: base?.raw ?? { source: "PHONE_MANUAL" },
    actorId,
  });
}

/**
 * Server-side extraction over the stored bytes (W39 worker + the manual re-run route).
 * Skips photos that already carry a phone-side READY suggestion unless `force` — the phone
 * had the live camera and the person's corrections; a colder server pass must not overwrite
 * that. Loads the heavy OCR module lazily so the API process never pays for it.
 */
export async function runServerExtractionForPhoto(
  prisma: PrismaClient,
  actorId: string,
  photoDocumentId: string,
  opts: { force?: boolean; documentType?: string | null } = {},
) {
  const photo = await loadPhoto(prisma, photoDocumentId);
  const existing = await prisma.identityOcrSuggestion.findUnique({ where: { photoDocumentId: photo.id } });
  // Taken off its row (2026-10-23): nothing to read it for.
  if (photo.clearedAt) return { skipped: true as const, reason: "PHOTO_CLEARED", suggestion: existing };
  if (
    !opts.force &&
    existing &&
    (existing.status === "APPLIED" || existing.status === "DISMISSED" || (existing.engine.startsWith("PHONE_") && existing.status === "READY"))
  ) {
    return { skipped: true as const, reason: "ALREADY_HAS_SUGGESTION", suggestion: existing };
  }
  if (serverOcrDisabled()) {
    return { skipped: true as const, reason: "OCR_DISABLED", suggestion: existing };
  }
  // Reading now: PENDING, and the time it was asked for kept when it waited in the queue.
  const startedAt = new Date();
  await prisma.identityOcrSuggestion.upsert({
    where: { photoDocumentId: photo.id },
    create: {
      photoDocumentId: photo.id,
      entryId: photo.entryId,
      subjectKey: photo.subjectKey,
      engine: "SERVER_QR",
      status: "PENDING",
      stage: "QR",
      stageAt: startedAt,
      readingSince: startedAt,
    },
    update: {
      status: "PENDING",
      stage: "QR",
      stageAt: startedAt,
      ...(existing?.status === "PENDING" && existing.readingSince ? {} : { readingSince: startedAt }),
      error: null,
    },
  });
  const onStage = async (stage: string) => {
    await prisma.identityOcrSuggestion
      .update({ where: { photoDocumentId: photo.id }, data: { stage, stageAt: new Date() } })
      .catch(() => {});
  };
  try {
    const { extractIdentityFromImage } = await import("../../lib/identity-ocr/server-extract.js");
    const file = await readIdentityProofFile(prisma, photo.id);
    // Phase B hint: when the desk row already names the document (CID / voter card / birth
    // certificate / work permit), the layout pass anchors on that layout instead of guessing
    // from keywords.
    // The type picked on the phone when the photo was sent before it was read (2026-10-23)
    // comes first.
    let kindHint: LayoutKind | null = asLayoutKind(opts.documentType);
    if (!kindHint && photo.subjectKey) {
      const detail = await prisma.guestIdentityDocument.findFirst({
        where: { entryId: photo.entryId, subjectKey: photo.subjectKey, storageKey: null },
        select: { documentType: true },
      });
      kindHint = asLayoutKind(detail?.documentType);
    }
    const result = await extractIdentityFromImage(file.bytes, { kindHint, onStage });
    if (!result) {
      // Nothing read — but the type the person picked is still worth suggesting to the desk.
      const picked = opts.documentType ? await sanitiseFields(prisma, { documentType: opts.documentType }, { documentType: "READ" }) : null;
      if (picked && Object.keys(picked.fields).length) {
        const row = await writeSuggestion(prisma, photo, {
          engine: "PHONE_MANUAL",
          status: "READY",
          fields: picked.fields,
          fieldConfidence: picked.fieldConfidence,
          raw: { source: "SERVER_NONE" },
          actorId,
        });
        return { skipped: false as const, suggestion: row };
      }
      const row = await writeSuggestion(prisma, photo, { engine: "SERVER_MRZ", status: "EMPTY", actorId, raw: { source: "SERVER_NONE" } });
      return { skipped: false as const, suggestion: row };
    }
    if (opts.documentType && !result.extraction.fields.documentType) {
      result.extraction.fields.documentType = opts.documentType;
      result.extraction.fieldConfidence.documentType = "READ";
    }
    const clean = await sanitiseFields(prisma, result.extraction.fields, result.extraction.fieldConfidence);
    const row = await writeSuggestion(prisma, photo, {
      engine: result.engine,
      status: Object.keys(clean.fields).length ? "READY" : "EMPTY",
      fields: clean.fields,
      fieldConfidence: clean.fieldConfidence,
      raw: result.extraction.raw,
      actorId,
    });
    return { skipped: false as const, suggestion: row };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const row = await writeSuggestion(prisma, photo, { engine: "SERVER_MRZ", status: "FAILED", error: message.slice(0, 500), actorId });
    return { skipped: false as const, suggestion: row };
  }
}

/**
 * A reading has been asked for (an upload, or Scan again — 2026-10-23): the photo's suggestion
 * reads PENDING · QUEUED from this moment, so the desk shows it waiting and polls for the result.
 * Before, a re-read of a photo that already had a suggestion left it as it was until the worker
 * started, and the desk had nothing to wait on — the result only showed after a reload.
 */
export async function markOcrQueued(prisma: PrismaClient, photoDocumentId: string): Promise<void> {
  const photo = await loadPhoto(prisma, photoDocumentId);
  const now = new Date();
  await prisma.identityOcrSuggestion.upsert({
    where: { photoDocumentId: photo.id },
    create: {
      photoDocumentId: photo.id,
      entryId: photo.entryId,
      subjectKey: photo.subjectKey,
      engine: "SERVER_QR",
      status: "PENDING",
      stage: "QUEUED",
      stageAt: now,
      readingSince: now,
    },
    update: { status: "PENDING", stage: "QUEUED", stageAt: now, readingSince: now, error: null },
  });
}

/** Queue the W39 server extraction for a freshly stored photo (best-effort, never throws). */
export async function enqueueServerExtraction(prisma: PrismaClient, photoDocumentId: string, actorId: string): Promise<void> {
  if (serverOcrDisabled()) return;
  try {
    await markOcrQueued(prisma, photoDocumentId);
    const engine = await getTimerEngine();
    await engine.schedule("IDENTITY_OCR_W39", { photoDocumentId, actorId }, { startAfter: new Date() });
  } catch (err) {
    console.warn(`[identity-ocr] could not enqueue W39 for ${photoDocumentId}:`, err instanceof Error ? err.message : err);
  }
}

/** Apply a suggestion to the guest-detail row — through the ordinary save path. */
export async function applyOcrSuggestion(
  prisma: PrismaClient,
  actorId: string,
  suggestionId: string,
  overrides: Partial<Pick<IdentitySuggestedFields, "documentType" | "documentNumber" | "fullName" | "dateOfBirth" | "gender">> = {},
) {
  const s = await prisma.identityOcrSuggestion.findUnique({ where: { id: suggestionId } });
  if (!s) throw new NotFoundError("OCR suggestion");
  if (!s.subjectKey) throw new ValidationError("This photo is not filed under a guest — pick the guest first, then apply");
  if (s.status !== "READY") throw new ValidationError(`Suggestion is ${s.status} — nothing to apply`);
  const f = { ...((s.fields as IdentitySuggestedFields | null) ?? {}), ...overrides };
  const documentNumber = f.documentNumber?.trim() || null;
  // The detail row's gender vocabulary is MALE / FEMALE / OTHER; documents print M / F / X.
  const genderMap: Record<string, string> = { M: "MALE", F: "FEMALE", X: "OTHER", MALE: "MALE", FEMALE: "FEMALE", OTHER: "OTHER" };
  const gender = f.gender?.trim() ? genderMap[f.gender.trim().toUpperCase()] : undefined;
  const detail = await saveGuestIdentityDetail(prisma, s.entryId, actorId, {
    subjectKey: s.subjectKey,
    subjectLabel: f.fullName?.trim() || undefined,
    documentType: f.documentType?.trim() || undefined,
    documentNumber: documentNumber ?? undefined,
    dateOfBirth: f.dateOfBirth?.trim() || undefined,
    gender,
  });
  const now = new Date();
  const updated = await prisma.identityOcrSuggestion.update({
    where: { id: s.id },
    data: { status: "APPLIED", appliedAt: now, appliedBy: actorId },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "GUEST.IDENTITY_OCR_APPLIED",
      actorId,
      actorLevel: "SYSTEM",
      entityType: "IdentityOcrSuggestion",
      entityId: s.id,
      operation: "UPDATE",
      timestamp: now,
      entryId: s.entryId,
      payload: { photoDocumentId: s.photoDocumentId, subjectKey: s.subjectKey, engine: s.engine, applied: Object.keys(f), overridden: Object.keys(overrides) },
      createdBy: actorId,
    },
  });
  return { suggestion: updated, detail };
}

export async function dismissOcrSuggestion(prisma: PrismaClient, actorId: string, suggestionId: string) {
  const s = await prisma.identityOcrSuggestion.findUnique({ where: { id: suggestionId } });
  if (!s) throw new NotFoundError("OCR suggestion");
  const now = new Date();
  const updated = await prisma.identityOcrSuggestion.update({
    where: { id: s.id },
    data: { status: "DISMISSED", dismissedAt: now, dismissedBy: actorId },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "GUEST.IDENTITY_OCR_DISMISSED",
      actorId,
      actorLevel: "SYSTEM",
      entityType: "IdentityOcrSuggestion",
      entityId: s.id,
      operation: "UPDATE",
      timestamp: now,
      entryId: s.entryId,
      payload: { photoDocumentId: s.photoDocumentId, subjectKey: s.subjectKey, engine: s.engine },
      createdBy: actorId,
    },
  });
  return updated;
}

/** Public shape of a suggestion for the identity-proofs list / phone context. */
export type OcrSuggestionView = {
  id: string;
  photoDocumentId: string;
  subjectKey: string | null;
  engine: OcrEngine;
  status: OcrSuggestionStatus;
  fields: IdentitySuggestedFields | null;
  fieldConfidence: Partial<Record<keyof IdentitySuggestedFields, FieldConfidence>> | null;
  source: string | null;
  error: string | null;
  extractedAt: Date | null;
  appliedAt: Date | null;
  /** While PENDING: QUEUED · QR · STRIP · TEXT. */
  stage: string | null;
  stageAt: Date | null;
  readingSince: Date | null;
  /** PENDING with a stage that has not moved for minutes — the reading stopped; Scan again. */
  stalled: boolean;
  /** How long the last reading took, once it ended. */
  readSeconds: number | null;
  /** Measured on the server's clock when this answer was made — the desk counts on from its arrival,
   *  so a desk machine whose clock disagrees still shows the right seconds. */
  readingForSeconds: number | null;
  stageForSeconds: number | null;
  endedForSeconds: number | null;
  /** Whether the date of birth read fits the guest's row (2026-10-23); null with no date. */
  ageCheck: AgeCheck | null;
};

/** A stage that has not moved in this long belongs to a reading that died. */
const STALLED_AFTER_MS = 5 * 60_000;

export async function listOcrSuggestionsForEntry(prisma: PrismaClient, entryId: string): Promise<OcrSuggestionView[]> {
  // A photo taken off its row (2026-10-23) takes its reading with it.
  const rows = await prisma.identityOcrSuggestion.findMany({ where: { entryId, photo: { clearedAt: null } }, orderBy: { updatedAt: "desc" } });
  // A date of birth read off the photo that does not fit the guest's row is said before Apply.
  const ageOf = await partyAgeChecker(prisma, entryId);
  const now = Date.now();
  const secsSince = (d: Date | null) => (d ? Math.max(0, Math.round((now - d.getTime()) / 100) / 10) : null);
  return rows.map((r) => ({
    id: r.id,
    photoDocumentId: r.photoDocumentId,
    subjectKey: r.subjectKey,
    engine: r.engine as OcrEngine,
    status: r.status as OcrSuggestionStatus,
    fields: (r.fields as IdentitySuggestedFields | null) ?? null,
    fieldConfidence: (r.fieldConfidence as OcrSuggestionView["fieldConfidence"]) ?? null,
    source: ((r.raw as IdentityExtraction["raw"] | null)?.source as string | undefined) ?? null,
    error: r.error,
    extractedAt: r.extractedAt,
    appliedAt: r.appliedAt,
    stage: r.status === "PENDING" ? r.stage : null,
    stageAt: r.status === "PENDING" ? r.stageAt : null,
    readingSince: r.readingSince,
    stalled: r.status === "PENDING" && Date.now() - (r.stageAt ?? r.updatedAt).getTime() > STALLED_AFTER_MS,
    readSeconds:
      r.status !== "PENDING" && r.readingSince && r.extractedAt && r.extractedAt >= r.readingSince
        ? Math.round((r.extractedAt.getTime() - r.readingSince.getTime()) / 100) / 10
        : null,
    readingForSeconds: r.status === "PENDING" ? secsSince(r.readingSince) : null,
    stageForSeconds: r.status === "PENDING" ? secsSince(r.stageAt) : null,
    endedForSeconds: r.status !== "PENDING" ? secsSince(r.extractedAt) : null,
    ageCheck: ageOf(r.subjectKey, (r.fields as IdentitySuggestedFields | null)?.dateOfBirth ?? null),
  }));
}
