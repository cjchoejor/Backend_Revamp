import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type GuestProfileSummary = {
  id: string;
  title?: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  vipTier: string | null;
  clientTier: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GuestProfileListResponse = {
  items: GuestProfileSummary[];
  count: number;
};

export async function searchGuestProfiles(session: Session, q: string, limit = 20) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (q.trim()) params.set("q", q.trim());
  return apiRequest<GuestProfileListResponse>(`/api/guest-profiles?${params}`, { session });
}

export async function createGuestProfile(
  session: Session,
  body: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    nationality?: string;
    clientTier?: string;
  },
) {
  return apiRequest<GuestProfileSummary>("/api/guest-profiles", {
    method: "POST",
    session,
    body,
  });
}

/** The plain name, with no contact detail appended. */
export function guestFullName(g: Pick<GuestProfileSummary, "firstName" | "lastName">) {
  return `${g.firstName} ${g.lastName}`.trim() || "Guest";
}

/** A guest already on file with a phone or an email — which of the two matched. */
export type GuestOnFile = {
  id: string;
  title: string | null;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  nationality: string | null;
  matchedBy: Array<"PHONE" | "EMAIL">;
};

/**
 * Guests on file with this phone (its digits, 4 or more, anywhere in the number) or this email
 * (3 characters or more, anywhere in the address) — the Wrap up dropdown while the desk types
 * (2026-10-28). `GET /api/guest-profiles/on-file`, L1, no-store.
 */
export function findGuestsOnFile(session: Session, q: { phone?: string; email?: string }) {
  const params = new URLSearchParams();
  if (q.phone) params.set("phone", q.phone);
  if (q.email) params.set("email", q.email);
  return apiRequest<{ guests: GuestOnFile[] }>(`/api/guest-profiles/on-file?${params}`, { session });
}

/** The same person's name, as the backend compares it: spaces collapsed, case aside. */
export function sameGuestName(a: { firstName: string; lastName: string }, b: { firstName: string; lastName: string }) {
  const n = (x: { firstName: string; lastName: string }) => `${x.firstName} ${x.lastName}`.trim().replace(/\s+/g, " ").toLowerCase();
  return n(a) === n(b);
}


/** One guest's record — `GET /api/guest-profiles/:id`. */
export async function getGuestProfile(session: Session, id: string) {
  return apiRequest<GuestProfileSummary>(`/api/guest-profiles/${encodeURIComponent(id)}`, { session });
}

/**
 * Wrap up at Inquiry (2026-10-10): a phone or email the guest gave once rooms were chosen. The
 * server fills an EMPTY field only — one already on file is never replaced from a booking.
 */
export function addGuestContact(
  session: Session,
  guestProfileId: string,
  body: { phone?: string | null; email?: string | null; entryId?: string | null },
) {
  return apiRequest<{ profile: GuestProfileSummary; added: string[] }>(`/api/guest-profiles/${guestProfileId}/contact`, {
    method: "POST",
    session,
    body,
  });
}
