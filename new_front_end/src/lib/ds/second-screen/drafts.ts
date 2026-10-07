/**
 * What each step sends the second screen. "desk" is the workspace's own reading of the step — the
 * numbered to-do and the forward move, exactly as the desk shows them, so the board can never
 * disagree with it. The others are what the operator has typed or picked and not saved yet.
 */
import type { RoomCompositionInput } from "@/lib/api/quotations";

export type DeskDraft = {
  /** The step on screen, 1–9, and the step the booking is at. */
  viewing: number;
  current: number;
  view: "step" | "other" | "details" | "history";
  items: { label: string; met: boolean; card?: string }[];
  /** The one forward move and whether it is open. */
  gate: { label: string; ready: boolean; reason?: string } | null;
  /** Set when the record is sealed — what the banner says. */
  sealed: string | null;
};

export type StayDraft = {
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  ages: string[];
  rooms: number;
  beds: Record<string, number>;
  /** The envelope's own warning, when the party does not fit. */
  warning: string | null;
};

export type RoomsDraft = {
  nights: { date: string; roomIds: string[] }[];
  numberOfRooms: number;
  nightsReady: number;
  ready: boolean;
};

export type TableDraft = {
  unsaved: boolean;
  faults: string[];
  rooms: RoomCompositionInput[];
  discount: { value: number; unit: "percent" | "amount" } | null;
};
