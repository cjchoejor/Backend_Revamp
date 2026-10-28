import type { InquiryListItem, ListResponse } from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export async function listInquiries(session: Session, limit = 50) {
  return apiRequest<ListResponse<InquiryListItem>>(`/api/inquiries?limit=${limit}`, { session });
}

export async function getInquiry(session: Session, inquiryId: string) {
  return apiRequest<InquiryListItem>(`/api/inquiries/${inquiryId}`, { session });
}

export type CallerDetails = {
  title?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  onWhatsApp?: boolean | null;
};

/** Change who is asking at Inquiry — channel, agency or company, package, a company's reference. */
export function updateEntrySource(
  session: Session,
  entryId: string,
  body: {
    cameInAs?: string | null;
    sourceChannel?: string | null;
    travelAgentId?: string | null;
    corporateAccountId?: string | null;
    ratePackageId?: string | null;
    corporateClientRef?: string | null;
    corporateCoordinator?: string | null;
  },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/source`, { method: "POST", session, body });
}

/** Fill in or correct the caller (2026-10-12). Fields left out keep what is on record. */
export function updateEntryCaller(session: Session, entryId: string, body: CallerDetails) {
  return apiRequest<{ caller: CallerDetails }>(`/api/entries/${entryId}/caller`, { method: "POST", session, body });
}

/**
 * `keepNewName`: the phone or email is on file under another name and the desk keeps the typed one
 * (a new guest record; otherwise refused GUEST_ON_FILE_DIFFERENT_NAME with the guests on file).
 * `arrivingIsGuest`: the guest named is the one arriving — on a direct booking "who is arriving"
 * is filled from them (2026-10-28).
 */
type GuestNamingOptions = { keepNewName?: boolean; arrivingIsGuest?: boolean };

export type SetGuestBody =
  | ({ mode: "CALLER"; nationality?: string | null } & GuestNamingOptions)
  | ({ mode: "EXISTING"; guestProfileId: string; phone?: string | null; email?: string | null } & GuestNamingOptions)
  | ({ mode: "NEW"; title?: string | null; firstName: string; lastName: string; nationality?: string | null; phone?: string | null; email?: string | null } & GuestNamingOptions);

/** Name the guest who is staying — the caller, a guest on file, or someone new (Inquiry only). */
export function setEntryGuest(session: Session, entryId: string, body: SetGuestBody) {
  return apiRequest<{
    guestProfileId: string;
    duplicate: { conflictingInquiryId: string; conflictingEntryId: string } | null;
    /** The same name on a phone or email already on file: that guest's record was used. */
    reusedOnFile?: boolean;
    /** Fields the guest on file lacked and took from what was typed. */
    filled?: string[];
    /** A phone or email typed that differs from the record's — kept as it was, not overwritten. */
    contactKept?: string[];
    arrivingSet?: boolean;
  }>(
    `/api/entries/${entryId}/guest`,
    { method: "POST", session, body },
  );
}

export async function createInquiry(
  session: Session,
  body: {
    /** The guest staying, when already known (a returning caller found on file); else named at Wrap up. */
    guestProfileId?: string | null;
    /** Who called (2026-10-12): a phone or an email (not on an OTA), "on WhatsApp?" with a phone. */
    caller?: CallerDetails | null;
    sourceChannel: string;
    /** How the guest came in; the backend checks it belongs to `sourceChannel`. */
    cameInAs?: string;
    notes?: string;
    proposedCheckIn?: string;
    proposedCheckOut?: string;
    /** Phase C — optional link to a Phase-B TravelAgent (mutually exclusive with corporateAccountId). */
    travelAgentId?: string | null;
    /** Phase C — optional link to a Phase-B CorporateAccount (mutually exclusive with travelAgentId). */
    corporateAccountId?: string | null;
    /**
     * Which negotiated package this booking is quoted on. Omit to let pricing use the party's
     * default package, then the hotel's common one.
     */
    ratePackageId?: string | null;
    /** The FOM's answer to a confirmed duplicate — go ahead with a reason (2026-09-18). */
    duplicateResolution?: { resolution: "ACKNOWLEDGE" | "DISMISS"; reason: string };
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
  /** An agency usually has several: office, owner, WhatsApp. */
  contactNumbers: string[];
  contactEmail: string | null;
  modeOfContact: string;
  gstNumber?: string | null;
  /** Corporate accounts only — contract references inherited at intake (spec §2.6.2). */
  contractRefs?: string[];
  /** The party's contact persons — who actually rings in bookings. Both party kinds carry these. */
  coordinators?: CoordinatorContact[];
};

/**
 * A blank `q` lists every active party — that is what lets the picker open as a browsable
 * dropdown. `limit` is the server's own cap: receiving exactly that many rows means the roster
 * was cut, so the caller can say so without hardcoding the number here.
 */
type PartyLookupResult = { matches: LookupPartyMatch[]; limit?: number };

/** A guest a caller booked for before — shown under the caller, offered first at Wrap up. */
export type CallerGuest = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  nationality: string | null;
  lastStay: string | null;
};

/**
 * Someone who has rung before with this number or email (2026-10-27): an earlier enquiry's caller,
 * or an agency's or a company's contact person or own line. `party` is the agency or company they
 * ring for (the same shape the party search returns), so the desk can fill "Who is asking".
 */
export type CallerMatch = {
  key: string;
  kind: "DIRECT" | "TRAVEL_AGENT" | "CORPORATE";
  foundAs: "EARLIER_CALLER" | "PARTY_CONTACT" | "PARTY_NUMBER";
  title: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  onWhatsApp: boolean | null;
  party: (LookupPartyMatch & { kind: "TRAVEL_AGENT" | "CORPORATE" }) | null;
  partyContact: CoordinatorContact | null;
  calls: number;
  lastCalledAt: string | null;
  lastInquiryId: string | null;
  guests: CallerGuest[];
};

/** `q` is a phone (4+ digits) or an email; `exclude` leaves an enquiry out (the booking's own). */
export async function lookupCallers(session: Session, q: string, exclude?: string | null) {
  const qs = new URLSearchParams({ q });
  if (exclude) qs.set("exclude", exclude);
  return apiRequest<{ mode: "PHONE" | "EMAIL" | "NONE"; matches: CallerMatch[] }>(`/api/lookups/callers?${qs}`, { session });
}

export async function searchTravelAgentsLookup(session: Session, q: string) {
  const qs = new URLSearchParams({ q });
  return apiRequest<PartyLookupResult>(`/api/lookups/travel-agents/search?${qs}`, { session });
}

/**
 * File a NEW agency from the desk (L1, 2026-09-29): the name and the contact the caller gives,
 * active, with no rate package of its own (it prices on the hotel's common package until the
 * admin sets one). A name already on file is refused naming it.
 */
export async function createTravelAgentLookup(session: Session, body: { displayName: string; phone?: string | null; email?: string | null }) {
  return apiRequest<LookupPartyMatch>("/api/lookups/travel-agents", { method: "POST", session, body });
}

export async function searchCorporateAccountsLookup(session: Session, q: string) {
  const qs = new URLSearchParams({ q });
  return apiRequest<PartyLookupResult>(`/api/lookups/corporate-accounts/search?${qs}`, { session });
}

export type AddPartyContactResult = {
  contact: CoordinatorContact;
  /** False when the party already had this number — the stored contact is returned unchanged. */
  added: boolean;
  coordinators: CoordinatorContact[];
};

/**
 * Append a contact person to a travel agent / corporate account from the desk (L1).
 *
 * Append-only by design — the desk can add a person who came up on a call, but renaming or
 * removing contacts stays an L4 action in Admin. Idempotent by phone.
 */
export async function addPartyContact(
  session: Session,
  kind: "TRAVEL_AGENT" | "CORPORATE",
  partyId: string,
  contact: CoordinatorContact,
) {
  const base = kind === "TRAVEL_AGENT" ? "travel-agents" : "corporate-accounts";
  return apiRequest<AddPartyContactResult>(`/api/lookups/${base}/${partyId}/contacts`, {
    method: "POST",
    session,
    body: contact,
  });
}

/**
 * The packages a party can be quoted on. An agency can carry several negotiated rates —
 * Season, Off season, Premium — so the desk picks one when taking the booking.
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
