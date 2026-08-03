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
  body: { keyCount: number; registrationConfirmed: boolean },
) {
  return progressStage(session, entryId, {
    targetStage: "S7",
    version,
    transitionData: {
      keyCount: body.keyCount,
      registrationConfirmed: body.registrationConfirmed,
    },
  }) as Promise<EntryDetail>;
}
