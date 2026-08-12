import jwt from "jsonwebtoken";
import { jwtSigningSecret } from "./auth-token.js";

/**
 * Phone identity-capture token (2026-08-12) — the credential inside the QR code the desk
 * shows when the operator hands ID-photo capture to a phone. The phone has no staff session,
 * so this SCOPED token is its whole authority: one entry, one party slot, upload-only,
 * short-lived. It can never read stored proofs, never write typed details, and never touches
 * any other booking — the worst a leaked QR allows is a junk image upload against one slot,
 * which lands in the write-once store attributed to the operator who minted the token.
 *
 * Signed with the SAME `JWT_SECRET` as staff sessions (via `jwtSigningSecret`), but verified
 * ONLY by `verifyIdentityCaptureToken`: the `purpose` discriminator plus the shape check mean
 * a capture token can never pass as a session token and vice versa.
 */

export type IdentityCaptureTokenPayload = {
  purpose: "IDENTITY_PROOF_UPLOAD";
  entryId: string;
  /** Party slot the phone captures for (guest-board keys "A0"…/"K0"…); null = unassigned. */
  subjectKey: string | null;
  /** Label shown on the phone page and stamped on the stored rows ("Adult 2" or a typed name). */
  subjectLabel: string | null;
  /** All-guests mode (2026-08-12): one QR for the whole party — the phone page lists every
   *  slot and the upload names one per photo, validated server-side against the entry's
   *  derived party. Single-slot tokens keep the slot pinned in the token itself. */
  allSlots: boolean;
  /** The staff user who minted the token — recorded as the capturing actor on every upload. */
  mintedBy: string;
};

export const IDENTITY_CAPTURE_TOKEN_TTL_MINUTES = 15;

export function signIdentityCaptureToken(
  payload: Omit<IdentityCaptureTokenPayload, "purpose">,
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + IDENTITY_CAPTURE_TOKEN_TTL_MINUTES * 60_000);
  const token = jwt.sign(
    { purpose: "IDENTITY_PROOF_UPLOAD", ...payload } satisfies IdentityCaptureTokenPayload,
    jwtSigningSecret(),
    { expiresIn: `${IDENTITY_CAPTURE_TOKEN_TTL_MINUTES}m` } as jwt.SignOptions,
  );
  return { token, expiresAt };
}

/** Verify a capture token and return its payload, or null if missing/invalid/expired/wrong-kind. */
export function verifyIdentityCaptureToken(token: string | null | undefined): IdentityCaptureTokenPayload | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, jwtSigningSecret());
    if (!decoded || typeof decoded !== "object") return null;
    const p = decoded as Record<string, unknown>;
    if (p.purpose !== "IDENTITY_PROOF_UPLOAD") return null;
    if (typeof p.entryId !== "string" || !p.entryId) return null;
    if (typeof p.mintedBy !== "string" || !p.mintedBy) return null;
    return {
      purpose: "IDENTITY_PROOF_UPLOAD",
      entryId: p.entryId,
      subjectKey: typeof p.subjectKey === "string" && p.subjectKey ? p.subjectKey : null,
      subjectLabel: typeof p.subjectLabel === "string" && p.subjectLabel ? p.subjectLabel : null,
      allSlots: p.allSlots === true,
      mintedBy: p.mintedBy,
    };
  } catch {
    return null;
  }
}
