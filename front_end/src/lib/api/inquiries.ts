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
    /**
     * Which negotiated package this booking is quoted on (2026-08-04). Omit to let pricing use
     * the party's default package, then the hotel's common one.
     */
    ratePackageId?: string | null;
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

/**
 * Edit the free-text special-preference note (`Inquiry.notes`) from any stage. Stage-agnostic
 * (L1+); an empty string clears it. Overwrites in place so the preference is never duplicated.
 * `PATCH /api/inquiries/:id/notes`.
 */
export async function updateInquiryNotes(session: Session, inquiryId: string, notes: string) {
  return apiRequest<InquiryListItem>(`/api/inquiries/${inquiryId}/notes`, {
    method: "PATCH",
    session,
    body: { notes },
  });
}

// ----- Phase C operational lookups (L1-accessible search) -----

export type CoordinatorContact = { name: string; phone?: string | null; email?: string | null };

export type LookupPartyMatch = {
  id: string;
  displayName: string;
  contactNumber: string | null;
  contactEmail: string | null;
  modeOfContact: string;
  gstNumber?: string | null;
  /** Corporate accounts only — contract references + coordinators inherited at intake (spec §2.6.2). */
  contractRefs?: string[];
  coordinators?: CoordinatorContact[];
};

export async function searchTravelAgentsLookup(session: Session, q: string) {
  const qs = new URLSearchParams({ q });
  return apiRequest<{ matches: LookupPartyMatch[] }>(`/api/lookups/travel-agents/search?${qs}`, { session });
}

export async function searchCorporateAccountsLookup(session: Session, q: string) {
  const qs = new URLSearchParams({ q });
  return apiRequest<{ matches: LookupPartyMatch[] }>(`/api/lookups/corporate-accounts/search?${qs}`, { session });
}

/**
 * The packages a party can be quoted on (2026-08-04). An agency can carry several negotiated
 * rates — Season, Off season, Premium — so the desk picks one when taking the booking.
 * An empty list means the party has none and pricing falls back to the hotel's common package.
 */
export type LookupRatePackage = {
  id: string;
  name: string;
  isDefault: boolean;
  roomBaseRate: string;
  extraBedRate: string | null;
  breakfastRate: string | null;
  lunchRate: string | null;
  dinnerRate: string | null;
  cpRate: string | null;
  mapLunchRate: string | null;
  mapDinnerRate: string | null;
  apRate: string | null;
  currency: string;
};

export async function listRatePackagesLookup(
  session: Session,
  owner: { travelAgentId?: string; corporateAccountId?: string },
) {
  const qs = new URLSearchParams(
    owner.travelAgentId ? { travelAgentId: owner.travelAgentId } : { corporateAccountId: owner.corporateAccountId! },
  );
  return apiRequest<{ items: LookupRatePackage[]; count: number }>(`/api/lookups/rate-packages?${qs}`, { session });
}
