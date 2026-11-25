import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/** How an apartment is let (2026-11-25). Under a week there is no plan: it is charged by the night. */
export type ApartmentPlan = "MONTHLY" | "WEEKLY";

export type ApartmentPlans = { nights: number; firstMonthEnds: string; firstWeekEnds: string; monthly: boolean; weekly: boolean };

/** A rate as the bill reads it — the server's figures. */
export type ApartmentFigures = { rate: string; serviceCharge: string; gst: string; total: string };

export type RentPeriodLine = {
  from: string;
  to: string;
  nights: number;
  ofNights: number;
  whole: boolean;
  net: string;
  serviceCharge: string;
  gst: string;
  total: string;
};
export type RentForStay = { plan: ApartmentPlan; periods: RentPeriodLine[]; net: string; serviceCharge: string; gst: string; total: string };

export type ApartmentUnitForStay = {
  id: string;
  label: string;
  maxOccupants: number;
  rooms: Array<{ id: string; roomNumber: string; bedType: string | null; roomTypeName: string; faultOpen: boolean }>;
  free: boolean;
  takenBy: Array<{ roomNumber: string; entryId: string; guestName: string | null; from: string; to: string; kind: "RESERVED" | "HELD" | "MARKED" }>;
  outOfService: string[];
  picked: boolean;
};

export type ApartmentPackageForStay = {
  id: string;
  name: string;
  carpetAreaSqft: number | null;
  amenities: string | null;
  weekly: ApartmentFigures;
  monthly: ApartmentFigures;
  forStay: { MONTHLY: RentForStay | null; WEEKLY: RentForStay | null } | null;
  units?: ApartmentUnitForStay[];
};

export type EntryApartments = {
  entryId: string;
  useType: string;
  plan: ApartmentPlan | null;
  stay: { checkInDate: string; checkOutDate: string; nights: number } | null;
  plans: Omit<ApartmentPlans, "nights"> | null;
  guests: number;
  packages: Array<ApartmentPackageForStay & { units: ApartmentUnitForStay[] }>;
};

export async function getApartmentPlans(session: Session, checkIn: string, checkOut: string) {
  return apiRequest<ApartmentPlans>(`/api/lookups/apartment-plans?checkIn=${checkIn}&checkOut=${checkOut}`, { session });
}

/** The apartments offered, with what each comes to for the dates given (the new inquiry). */
export async function getApartmentPackagesForDates(session: Session, checkIn?: string | null, checkOut?: string | null) {
  const q = checkIn && checkOut ? `?checkIn=${checkIn}&checkOut=${checkOut}` : "";
  return apiRequest<{ packages: ApartmentPackageForStay[]; plans: ApartmentPlans | null; stay: { nights: number } | null }>(`/api/lookups/apartment-packages${q}`, { session });
}

/** This booking's apartments for its stay (or dates not saved yet). */
export async function getEntryApartments(session: Session, entryId: string, stay?: { checkInDate?: string; checkOutDate?: string }) {
  const q = stay?.checkInDate && stay?.checkOutDate ? `?checkInDate=${stay.checkInDate}&checkOutDate=${stay.checkOutDate}` : "";
  return apiRequest<EntryApartments>(`/api/entries/${encodeURIComponent(entryId)}/apartments${q}`, { session });
}

/** Who holds a room over the stay, and the rooms free for their nights — the server's (2026-11-25). */
export type ApartmentHolder = {
  entryId: string;
  bookingRef: string | null;
  guestName: string | null;
  partyName: string | null;
  stage: string;
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  nightsInRoom: string[];
  swappable: boolean;
  why: string | null;
  rooms: Array<{ roomId: string; roomNumber: string; roomTypeName: string | null; sameType: boolean }>;
};

export type ApartmentHolders = {
  entryId: string;
  stay: { checkInDate: string; checkOutDate: string };
  unit: { id: string; label: string; packageName: string; maxOccupants: number };
  rooms: Array<{ roomId: string; roomNumber: string; outOfService: string | null; heldBy: ApartmentHolder[] }>;
};

/** Who holds an apartment over this booking's stay, and where each could go — for "Make room". */
export async function getApartmentHolders(session: Session, entryId: string, unitId: string) {
  return apiRequest<ApartmentHolders>(`/api/entries/${encodeURIComponent(entryId)}/apartments/${encodeURIComponent(unitId)}/holders`, { session });
}

export async function pickApartments(session: Session, entryId: string, unitIds: string[]) {
  return apiRequest<{ apartments: string[]; rooms: string[]; numberOfRooms: number }>(`/api/entries/${encodeURIComponent(entryId)}/apartments/pick`, {
    method: "POST",
    session,
    body: { unitIds },
  });
}

export const PLAN_WORD: Record<ApartmentPlan, string> = { MONTHLY: "Monthly", WEEKLY: "Weekly" };
