import type { InquiryListItem, ListResponse } from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export async function listInquiries(session: Session, limit = 50) {
  return apiRequest<ListResponse<InquiryListItem>>(`/api/inquiries?limit=${limit}`, { session });
}

export async function getInquiry(session: Session, inquiryId: string) {
  return apiRequest<InquiryListItem>(`/api/inquiries/${inquiryId}`, { session });
}

export async function createInquiry(
  session: Session,
  body: {
    guestProfileId: string;
    sourceChannel: string;
    notes?: string;
    proposedCheckIn?: string;
    proposedCheckOut?: string;
  },
) {
  return apiRequest<InquiryListItem>("/api/inquiries", {
    method: "POST",
    session,
    body,
  });
}
