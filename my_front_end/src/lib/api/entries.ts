import type { EntryDetail, EntryListItem, ListResponse } from "@/types/api";
import type { Session } from "@/types/session";
import type { TraceEvent } from "@/lib/trace/humanize";
import { apiRequest } from "./client";

export type ListEntriesParams = {
  limit?: number;
  inquiryId?: string;
  status?: string;
  currentStage?: string;
};

export async function listEntries(session: Session, params?: ListEntriesParams) {
  const q = new URLSearchParams();
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.inquiryId) q.set("inquiryId", params.inquiryId);
  if (params?.status) q.set("status", params.status);
  if (params?.currentStage) q.set("currentStage", params.currentStage);
  const qs = q.toString();
  return apiRequest<ListResponse<EntryListItem>>(`/api/entries${qs ? `?${qs}` : ""}`, { session });
}

export async function getEntry(session: Session, entryId: string) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}`, { session });
}

export async function getEntryTrace(session: Session, entryId: string, limit = 100) {
  return apiRequest<{ items: TraceEvent[]; count: number }>(
    `/api/entries/${entryId}/trace?limit=${limit}`,
    { session },
  );
}

export async function createEntry(
  session: Session,
  body: {
    inquiryId: string;
    useType: string;
    guestProfileId?: string;
    checkInDate?: string;
    checkOutDate?: string;
    guestCount?: number;
    adultCount?: number;
    childCount?: number;
    childAges?: number[];
    numberOfRooms?: number;
    contactPersonName?: string;
    contactPersonPhone?: string;
    otaSource?: boolean;
  },
) {
  return apiRequest<EntryDetail>("/api/entries", {
    method: "POST",
    session,
    body,
  });
}

export type TimerRecordSummary = {
  id: string;
  timerType: string;
  timerCode: string;
  stageContext: string | null;
  firesAt: string;
  warningAt: string | null;
  criticalAt: string | null;
  status: string;
  createdAt: string;
};

export async function getEntryTimers(session: Session, entryId: string) {
  return apiRequest<{ items: TimerRecordSummary[]; count: number }>(`/api/entries/${entryId}/timers`, { session });
}

/** Narrow update for the booking flow's "Edit step 1" affordance. S1-only on the server side. */
export async function updateEntryIntake(
  session: Session,
  entryId: string,
  body: {
    checkInDate?: string;
    checkOutDate?: string;
    guestCount?: number;
    adultCount?: number;
    childCount?: number;
    childAges?: number[];
    numberOfRooms?: number;
    contactPersonName?: string;
    contactPersonPhone?: string;
    useType?: string;
    expectedVersion?: number;
  },
) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}`, {
    method: "PATCH",
    session,
    body,
  });
}

/**
 * L3+ manual override of Policy 64's auto-classification. Pass `mode = null` to clear, or
 * `clearManualOverride: true` to re-enable auto-reclassify on subsequent intake edits.
 */
export async function setGroupBillingMode(
  session: Session,
  entryId: string,
  body: {
    mode: "GROUP_MASTER" | "INDIVIDUAL_FOLIO" | null;
    reason: string;
    clearManualOverride?: boolean;
  },
) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}/group-billing-mode`, {
    method: "PATCH",
    session,
    body,
  });
}

/** S3→S4 confirm historically returned `{ reservation, entry }`; normalize to EntryDetail. */
export function normalizeEntryResponse(data: unknown): EntryDetail {
  if (data && typeof data === "object" && "entry" in data && (data as { entry?: EntryDetail }).entry) {
    return (data as { entry: EntryDetail }).entry;
  }
  return data as EntryDetail;
}

export async function progressStage(
  session: Session,
  entryId: string,
  body: {
    targetStage: string;
    version: number;
    guestPhysicallyPresent?: boolean;
    transitionData?: Record<string, unknown>;
  },
) {
  const data = await apiRequest<unknown>(`/api/entries/${entryId}/progress-stage`, {
    method: "POST",
    session,
    body,
  });
  return normalizeEntryResponse(data);
}
