import type { GuestProfileName } from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";
import { progressStage } from "./entries";
import type { EntryDetail } from "@/types/api";

export type VerificationPath = "FIRST_TIME" | "RETURNING_VALID" | "RETURNING_EXPIRED" | "VIP";

export async function verifyGuestIdentity(
  session: Session,
  guestProfileId: string,
  body: {
    entryId: string;
    verificationPath: VerificationPath;
    documentType?: string;
    documentNumber?: string;
    issuingCountry?: string;
    expiryDate?: string;
  },
) {
  return apiRequest<GuestProfileName>(`/api/guest-profiles/${guestProfileId}/verify-identity`, {
    method: "POST",
    session,
    body,
  });
}

export async function completeCheckInToS7(
  session: Session,
  entryId: string,
  version: number,
  body: {
    keyCount: number;
    registrationConfirmed: boolean;
    /** Per-room key tracking (2026-08-11): the rooms whose key was handed over — recorded on
     *  the backend's KEYS trace alongside the count. */
    issuedKeyRoomIds?: string[];
  },
) {
  return progressStage(session, entryId, {
    targetStage: "S7",
    version,
    transitionData: {
      keyCount: body.keyCount,
      registrationConfirmed: body.registrationConfirmed,
      ...(body.issuedKeyRoomIds ? { issuedKeyRoomIds: body.issuedKeyRoomIds } : {}),
    },
  }) as Promise<EntryDetail>;
}
