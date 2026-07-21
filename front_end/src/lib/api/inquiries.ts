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

/**
 * Capture the corporate/government commercial context on an inquiry (SIG-S1 §100.6, Policy 17).
 * Required for `sourceChannel` CORPORATE or GOVERNMENT before the entry can exit S1 — the backend
 * bills the organisation, so it needs the client reference (their PO/account/authorisation ref)
 * and the coordinator (their contact person). `PATCH /api/inquiries/:id/corporate-context` (L1+).
 */
export async function captureCorporateContext(
  session: Session,
  inquiryId: string,
  body: { corporateClientRef: string; corporateCoordinator: string },
) {
  return apiRequest<InquiryListItem>(`/api/inquiries/${inquiryId}/corporate-context`, {
    method: "PATCH",
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
