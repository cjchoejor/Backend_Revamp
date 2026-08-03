import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type GuestProfileSummary = {
  id: string;
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

export function guestDisplayName(g: Pick<GuestProfileSummary, "firstName" | "lastName" | "email" | "phone">) {
  const name = `${g.firstName} ${g.lastName}`.trim();
  const contact = g.email ?? g.phone ?? "";
  return contact ? `${name} · ${contact}` : name;
}
