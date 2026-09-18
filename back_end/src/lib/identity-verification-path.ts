import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError } from "./errors.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type VerificationPath = "FIRST_TIME" | "RETURNING_VALID" | "RETURNING_EXPIRED" | "VIP";

export type VerificationPathStanding = {
  /** The path the guest's profile points to — what the desk should offer first. */
  suggested: VerificationPath;
  /** Every path the profile allows. FIRST_TIME is always here: it captures a full document. */
  allowed: VerificationPath[];
  /** Why each path the profile does NOT allow is refused, in the desk's words. */
  refused: Partial<Record<VerificationPath, string>>;
  vip: boolean;
  /** A document number on file from before this booking — what makes the guest "returning". */
  priorDocument: { documentType: string | null; documentNumber: string; expiryDate: Date | null; capturedAt: Date } | null;
  priorDocumentExpired: boolean;
};

/**
 * Which identity-verification paths a guest's profile allows at check-in (2026-09-18).
 *
 * SIG-S6 §756: the path is "determined from guest profile (vipTier, returning-guest status, ID
 * expiry status)". The route took whatever path the caller named, and the desk defaulted every
 * guest who was not VIP to "Returning — ID valid", the one path that needs no document, so a
 * first-time guest was verified with nothing on file.
 *
 *   - FIRST_TIME is always allowed — it captures a full document, the strictest path.
 *   - RETURNING_VALID needs a document number on file from BEFORE this booking that has not expired.
 *   - RETURNING_EXPIRED needs a document on file from before this booking (the point is re-capture).
 *   - VIP needs the profile's vipTier.
 *
 * "Before this booking" means another booking's row, or a slot-less verification row captured
 * before this booking existed. Only the profile holder's own rows count (slot A0 or no slot) — a
 * companion's number from an earlier stay is not this guest's ID.
 */
export async function resolveVerificationPaths(
  db: DbClient,
  input: { guestProfileId: string; entryId: string; now?: Date },
): Promise<VerificationPathStanding> {
  const now = input.now ?? new Date();
  const [profile, entry] = await Promise.all([
    db.guestProfile.findUnique({ where: { id: input.guestProfileId }, select: { vipTier: true } }),
    db.entry.findUnique({ where: { id: input.entryId }, select: { createdAt: true } }),
  ]);
  if (!profile) throw new NotFoundError("GuestProfile");
  if (!entry) throw new NotFoundError("Entry");

  const prior = await db.guestIdentityDocument.findFirst({
    where: {
      guestProfileId: input.guestProfileId,
      documentNumber: { not: null },
      AND: [
        { OR: [{ entryId: { not: input.entryId } }, { entryId: null, capturedAt: { lt: entry.createdAt } }] },
        { OR: [{ subjectKey: null }, { subjectKey: "A0" }] },
      ],
    },
    orderBy: { capturedAt: "desc" },
    select: { documentType: true, documentNumber: true, expiryDate: true, capturedAt: true },
  });

  const vip = !!profile.vipTier;
  const priorDocumentExpired = !!prior?.expiryDate && prior.expiryDate.getTime() <= now.getTime();
  const allowed: VerificationPath[] = ["FIRST_TIME"];
  const refused: Partial<Record<VerificationPath, string>> = {};
  if (prior) {
    if (priorDocumentExpired) {
      refused.RETURNING_VALID = "The ID on file for this guest has expired — verify them as returning with an expired ID, or as a first-time guest";
    } else {
      allowed.push("RETURNING_VALID");
    }
    allowed.push("RETURNING_EXPIRED");
  } else {
    const why = "This guest has no ID on file from an earlier stay — verify them as a first-time guest, with their document";
    refused.RETURNING_VALID = why;
    refused.RETURNING_EXPIRED = why;
  }
  if (vip) allowed.push("VIP");
  else refused.VIP = "This guest is not a VIP — the VIP path is for guests with a VIP tier on their profile";

  const suggested: VerificationPath = vip ? "VIP" : prior ? (priorDocumentExpired ? "RETURNING_EXPIRED" : "RETURNING_VALID") : "FIRST_TIME";
  return {
    suggested,
    allowed,
    refused,
    vip,
    priorDocument: prior?.documentNumber
      ? { documentType: prior.documentType, documentNumber: prior.documentNumber, expiryDate: prior.expiryDate, capturedAt: prior.capturedAt }
      : null,
    priorDocumentExpired,
  };
}
