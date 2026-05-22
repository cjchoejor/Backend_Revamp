import type { EntryDetail, EntryListItem, ListResponse } from "@/types/api";
import type { Session } from "@/types/session";
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

export async function createEntry(
  session: Session,
  body: {
    inquiryId: string;
    useType: string;
    guestProfileId?: string;
    checkInDate?: string;
    checkOutDate?: string;
    guestCount?: number;
    otaSource?: boolean;
  },
) {
  return apiRequest<EntryDetail>("/api/entries", {
    method: "POST",
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
