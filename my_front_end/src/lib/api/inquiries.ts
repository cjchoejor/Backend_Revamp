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
    /** Phase C — optional link to a Phase-B TravelAgent (mutually exclusive with corporateAccountId). */
    travelAgentId?: string | null;
    /** Phase C — optional link to a Phase-B CorporateAccount (mutually exclusive with travelAgentId). */
    corporateAccountId?: string | null;
  },
) {
  return apiRequest<InquiryListItem>("/api/inquiries", {
    method: "POST",
    session,
    body,
  });
}

// ----- Phase C operational lookups (L1-accessible search) -----

export type LookupPartyMatch = {
  id: string;
  displayName: string;
  contactNumber: string | null;
  contactEmail: string | null;
  modeOfContact: string;
  gstNumber?: string | null;
};

export async function searchTravelAgentsLookup(session: Session, q: string) {
  const qs = new URLSearchParams({ q });
  return apiRequest<{ matches: LookupPartyMatch[] }>(`/api/lookups/travel-agents/search?${qs}`, { session });
}

export async function searchCorporateAccountsLookup(session: Session, q: string) {
  const qs = new URLSearchParams({ q });
  return apiRequest<{ matches: LookupPartyMatch[] }>(`/api/lookups/corporate-accounts/search?${qs}`, { session });
}
