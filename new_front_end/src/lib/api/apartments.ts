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
  /** How many apartments the guest asked for in The stay; null when not said (2026-11-25). */
  asked: number | null;
  stay: { checkInDate: string; checkOutDate: string; nights: number } | null;
  plans: Omit<ApartmentPlans, "nights"> | null;
  guests: number;
  packages: Array<ApartmentPackageForStay & { units: ApartmentUnitForStay[] }>;
};

/** How many apartments a party may ask for — the server's (lib/apartment-count.ts, 2026-11-25). */
export type ApartmentCounts = {
  guests: number;
  /** The apartments the hotel offers. */
  offered: number;
  /** The fewest that sleep the party; null when even all of them cannot. */
  fewest: number | null;
  choices: Array<{ count: number; sleeps: number; fits: boolean }>;
};

export async function getApartmentCounts(session: Session, guests: number) {
  return apiRequest<ApartmentCounts>(`/api/lookups/apartment-counts?guests=${Math.max(0, Math.floor(guests))}`, { session });
}

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

/* ---- what an apartment holds, and an extra bed during the stay (2026-11-27) ---- */

export type AmenityItem = { name: string; count: number };
export type EntryApartmentAmenities = {
  entryId: string;
  /** The hotel's list of items to pick from, and any a package's usual list adds. */
  known: string[];
  editable: boolean;
  units: Array<{ unitId: string; label: string; packageName: string; roomNumbers: string[]; items: AmenityItem[]; source: "BOOKING" | "PACKAGE" | "NONE" }>;
};

export async function getEntryApartmentAmenities(session: Session, entryId: string) {
  return apiRequest<EntryApartmentAmenities>(`/api/entries/${encodeURIComponent(entryId)}/apartment-amenities`, { session });
}
export async function setEntryApartmentAmenities(session: Session, entryId: string, units: Array<{ unitId: string; items: AmenityItem[] }>) {
  return apiRequest<EntryApartmentAmenities>(`/api/entries/${encodeURIComponent(entryId)}/apartment-amenities`, { method: "PUT", session, body: { units } });
}

export type BedFigures = { net: string; serviceCharge: string; gst: string; total: string };
export type ApartmentExtraBedRow = {
  id: string;
  unitId: string;
  unitLabel: string;
  beds: number;
  fromDate: string;
  toDate: string;
  nights: number;
  ratePerBed: string;
  night: BedFigures;
  all: BedFigures;
  nightsPosted: number;
  note: string | null;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
  createdBy: string;
};
export type ApartmentExtraBeds = {
  entryId: string;
  rate: { rate: string | null; total: string | null; serviceCharge: string | null; gst: string | null };
  units: Array<{ unitId: string; label: string; packageName: string }>;
  stay: { today: string; lastMorning: string | null };
  mayAdd: boolean;
  why: string | null;
  beds: ApartmentExtraBedRow[];
};
export type BedAsk = { unitId: string; beds: number; fromDate: string; toDate: string };

export async function getApartmentExtraBeds(session: Session, entryId: string) {
  return apiRequest<ApartmentExtraBeds>(`/api/entries/${encodeURIComponent(entryId)}/apartment-extra-beds`, { session });
}
export async function previewApartmentExtraBed(session: Session, entryId: string, body: BedAsk) {
  return apiRequest<{ nights: number; ratePerBed: string; night: BedFigures; all: BedFigures; unitLabel: string }>(
    `/api/entries/${encodeURIComponent(entryId)}/apartment-extra-beds/preview`,
    { method: "POST", session, body },
  );
}
export async function addApartmentExtraBed(session: Session, entryId: string, body: BedAsk & { note?: string | null }) {
  return apiRequest<ApartmentExtraBeds & { recordId: string }>(`/api/entries/${encodeURIComponent(entryId)}/apartment-extra-beds`, { method: "POST", session, body });
}
export async function endApartmentExtraBed(session: Session, entryId: string, recordId: string, body: { toDate: string; reason?: string | null }) {
  return apiRequest<ApartmentExtraBeds>(`/api/entries/${encodeURIComponent(entryId)}/apartment-extra-beds/${encodeURIComponent(recordId)}/end`, {
    method: "POST",
    session,
    body,
  });
}
