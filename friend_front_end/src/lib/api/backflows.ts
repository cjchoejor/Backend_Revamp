import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * API client for the 9 spec-mandated backflows wired 2026-07-14.
 * All backflows write to /entries/:id/backflow/<code>. Each takes { reason }; S7→S4 also
 * takes { newCheckOutDate }.
 */

type BackflowResponse = { id: string; currentStage: string; version: number };

async function post<T = BackflowResponse>(
  path: string,
  session: Session,
  body: Record<string, unknown>,
): Promise<T> {
  return apiRequest<T>(path, { method: "POST", session, body });
}

export const backflows = {
  s2ToS1: (session: Session, entryId: string, reason: string) =>
    post(`/api/entries/${entryId}/backflow/s2-to-s1`, session, { reason }),
  s4ToS1: (session: Session, entryId: string, reason: string) =>
    post(`/api/entries/${entryId}/backflow/s4-to-s1`, session, { reason }),
  s4ToS2: (session: Session, entryId: string, reason: string) =>
    post(`/api/entries/${entryId}/backflow/s4-to-s2`, session, { reason }),
  s4ToS3: (session: Session, entryId: string, reason: string) =>
    post(`/api/entries/${entryId}/backflow/s4-to-s3`, session, { reason }),
  s5ToS1: (session: Session, entryId: string, reason: string) =>
    post(`/api/entries/${entryId}/backflow/s5-to-s1`, session, { reason }),
  s7ToS2: (session: Session, entryId: string, reason: string) =>
    post(`/api/entries/${entryId}/backflow/s7-to-s2`, session, { reason }),
  s7ToS3: (session: Session, entryId: string, reason: string) =>
    post(`/api/entries/${entryId}/backflow/s7-to-s3`, session, { reason }),
  s7ToS4: (session: Session, entryId: string, reason: string, newCheckOutDate: string) =>
    post(`/api/entries/${entryId}/backflow/s7-to-s4`, session, { reason, newCheckOutDate }),
  complaintToS2: (session: Session, entryId: string, reason: string) =>
    post(`/api/entries/${entryId}/backflow/complaint-to-s2`, session, { reason }),
};

/** Metadata for the UI — what's applicable at each source stage, and the required actor level. */
export type BackflowDescriptor = {
  key: string;
  label: string;
  toStage: string;
  minLevel: "L1" | "L2" | "L3";
  needsNewCheckOutDate?: boolean;
  destructive?: boolean;
};

export const BACKFLOWS_BY_STAGE: Record<string, BackflowDescriptor[]> = {
  S2: [
    { key: "s2ToS1", label: "Re-search availability (date / room-type change)", toStage: "S1", minLevel: "L1" },
  ],
  S4: [
    { key: "s4ToS3", label: "Change billing model", toStage: "S3", minLevel: "L2" },
    { key: "s4ToS2", label: "Renegotiate rate", toStage: "S2", minLevel: "L2" },
    { key: "s4ToS1", label: "Change dates (re-search)", toStage: "S1", minLevel: "L2", destructive: true },
  ],
  S5: [
    { key: "s5ToS1", label: "Pre-arrival config error → re-search", toStage: "S1", minLevel: "L2", destructive: true },
  ],
  S7: [
    { key: "s7ToS4", label: "Extend stay (date extension)", toStage: "S4", minLevel: "L2", needsNewCheckOutDate: true },
    { key: "s7ToS3", label: "Change billing model", toStage: "S3", minLevel: "L2" },
    { key: "s7ToS2", label: "Renegotiate rate (GM only)", toStage: "S2", minLevel: "L3" },
  ],
};

/** Complaint resolution is applicable from any active stage except S2 (already there) and S9 (closed). */
export const COMPLAINT_APPLICABLE_STAGES = new Set(["S1", "S3", "S4", "S5", "S6", "S7", "S8"]);
