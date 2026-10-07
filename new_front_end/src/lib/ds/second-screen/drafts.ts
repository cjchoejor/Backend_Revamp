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
  /**
   * The card the operator is working in right now — the last one they clicked or typed in.
   * `key` is the card's flow key when it has one ("guest", "stay", "house"), else null; `title`
   * is its heading ("Which rooms · 2 rooms for 3 nights"). The board shows what that card needs.
   */
  focus: { key: string | null; title: string } | null;
  /**
   * What the desk holds only on the screen until the step's commit records it: the guest-present
   * tick at Arrival, the registration tick and the per-room key marks at Check-in.
   */
  local?: { guestPresent?: boolean; registrationConfirmed?: boolean; keysMarked?: string[] };
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
  /** The fewest rooms this party needs (the house's own envelope), when known. */
  minRooms: number | null;
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
