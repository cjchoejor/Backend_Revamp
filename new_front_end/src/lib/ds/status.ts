/**
 * The booking's status phrase — one word and its qualifier (FIG 5.4, BOOKING-STATUS-MAP §1).
 *
 * FIG 5.4 wants the backend to build this phrase (register SS02-P3). Until it does, the screen
 * maps the facts the lists already carry, exactly as the status map lays them out, and nowhere
 * else: every list and the booking header read it from here, so the same booking never reads two
 * ways. No money is worked out — a balance in a qualifier comes from the API.
 */
import type { ChipTone } from "@/design-system/components/primitives";
import type { EntryDetail } from "@/types/api";
import type { DeskListRow } from "@/lib/api/desk";
import { fmtDateTime, fmtDay, money } from "./format";

export type Standing = { word: string; qualifier: string; tone: ChipTone };

/** The minimal facts the phrase is built from — satisfied by a list row and by the entry detail. */
export type StandingFacts = {
  status: string;
  currentStage: string;
  checkInDate?: string | null;
  reservationPaymentPending?: boolean;
  parkedAt?: string | null;
  parkFollowUpAt?: string | null;
  voucherSent?: boolean | null;
  reserved?: boolean;
  folioState?: string | null;
  holdPlaced?: boolean;
  markerUntil?: string | null;
  quoteState?: string | null;
  quoteValidUntil?: string | null;
  roomNumbers?: string[];
  roomsCount?: number | null;
  noShow?: boolean;
  leftEarly?: boolean;
  bookerName?: string | null;
  billingToAccount?: boolean;
  /** From the money read, when the caller has it. */
  balance?: number | null;
};

const TONE_OF: Record<string, ChipTone> = {
  Reserved: "solid",
  "In-house": "solid",
  "Arriving today": "solid",
  "Checking out": "solid",
  Parked: "quiet",
  Closed: "quiet",
  Cancelled: "quiet",
  Expired: "quiet",
  Declined: "quiet",
  "No-show": "warning",
  "Written off": "warning",
};

function standing(word: string, qualifier = ""): Standing {
  return { word, qualifier, tone: TONE_OF[word] ?? "default" };
}

export function standingOf(f: StandingFacts, hotelToday: string | null): Standing {
  const pending = f.reservationPaymentPending ? "advance pending" : "";
  if (f.status === "PARKED") return standing("Parked", f.parkFollowUpAt ? `follow up ${fmtDay(f.parkFollowUpAt)}` : "");
  if (f.status === "CANCELLED") return standing("Cancelled");
  if (f.status === "EXPIRED") return f.noShow ? standing("No-show") : standing("Expired");
  if (f.folioState === "WRITTEN_OFF") return standing("Written off");
  if (f.folioState === "NO_SHOW_CLOSED" || f.noShow) return standing("No-show");
  if (f.status === "CLOSED") {
    if (f.folioState === "OUTSTANDING" && !(f.balance != null && f.balance <= 0)) {
      return standing(
        "Checked out",
        f.billingToAccount && f.bookerName ? `on ${f.bookerName}'s account` : f.balance != null ? `balance due ${money(f.balance)}` : "balance due",
      );
    }
    return standing("Closed");
  }
  switch (f.currentStage) {
    case "S1":
      return standing("Inquiry");
    case "S2":
      if (f.markerUntil) return standing("Provisional block", `until ${fmtDateTime(f.markerUntil)}`);
      if (f.quoteState === "SENT" || f.quoteState === "ACCEPTED")
        return standing("Quoted", f.quoteState === "ACCEPTED" ? "accepted" : f.quoteValidUntil ? `valid until ${fmtDateTime(f.quoteValidUntil)}` : "");
      if (f.quoteState === "DRAFT") return standing("Negotiation", "quote generated");
      return standing("Negotiation", "not yet quoted");
    case "S3":
      return f.holdPlaced ? standing("Block", pending) : standing("Set up", "not yet blocked");
    case "S4":
      if (f.reserved && f.voucherSent === false) return standing("Reserved", "voucher not sent");
      return standing("Reserved", pending);
    case "S5":
      if (hotelToday && f.checkInDate?.slice(0, 10) === hotelToday) return standing("Arriving today", pending);
      return standing("Reserved", pending);
    case "S6":
      return standing("Checking in");
    case "S7":
      if (f.leftEarly) return standing("Checking out", "left early");
      return standing(
        "In-house",
        f.roomNumbers?.length ? `room${f.roomNumbers.length === 1 ? "" : "s"} ${f.roomNumbers.join(", ")}` : f.roomsCount ? `${f.roomsCount} room${f.roomsCount === 1 ? "" : "s"}` : "",
      );
    case "S8":
      if (f.folioState === "SETTLED") return standing("Checking out", "settled");
      if (f.billingToAccount && f.bookerName) return standing("Checking out", `rooms on ${f.bookerName}`);
      return standing("Checking out", f.balance != null && f.balance > 0 ? `balance due ${money(f.balance)}` : "");
    case "S9":
      if (f.folioState === "OUTSTANDING" && !(f.balance != null && f.balance <= 0))
        return standing("Checked out", f.billingToAccount && f.bookerName ? `on ${f.bookerName}'s account` : "balance due");
      return standing("Checked out", f.folioState === "SETTLED" ? "settled" : "");
    default:
      return standing("Inquiry");
  }
}

const ACCOUNT_MODELS = new Set(["DIRECT_BILL", "TOUR_OPERATOR_VOUCHER"]);

export function factsFromRow(r: DeskListRow, balance?: number | null): StandingFacts {
  const q = r.quotations[0];
  return {
    status: r.status,
    currentStage: r.currentStage,
    checkInDate: r.checkInDate,
    reservationPaymentPending: r.reservationPaymentPending,
    parkedAt: r.parkedAt,
    parkFollowUpAt: r.parkFollowUpAt,
    voucherSent: r.reservation?.confirmationVoucherSent ?? null,
    reserved: !!r.reservation,
    folioState: r.folio?.state ?? null,
    holdPlaced: r.committedHold?.state === "PLACED" || r.committedHold?.state === "CONFIRMED",
    markerUntil: r.speculativeHolds[0]?.expiresAt ?? null,
    quoteState: q?.state ?? null,
    quoteValidUntil: q?.validUntil ?? null,
    roomNumbers: r.roomNumbers,
    roomsCount: r.numberOfRooms,
    noShow: !!r.noShowDetermination,
    leftEarly: !!r.earlyDeparture,
    bookerName: bookerOfRow(r)?.name ?? null,
    billingToAccount: !!r.folio?.billingModel && ACCOUNT_MODELS.has(r.folio.billingModel),
    balance,
  };
}

export function factsFromEntry(e: EntryDetail, balance?: number | null, bookerName?: string | null): StandingFacts {
  const q = (e.quotations ?? [])[0];
  const liveMarker = (e.speculativeHolds ?? []).find((h) => h.state === "PLACED");
  const rooms = Array.from(new Set((e.roomAssignments ?? []).map((a) => a.room?.roomNumber).filter((x): x is string => !!x))).sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  return {
    status: e.status,
    currentStage: e.currentStage,
    checkInDate: e.checkInDate,
    reservationPaymentPending: (e as { reservationPaymentPending?: boolean }).reservationPaymentPending,
    parkedAt: (e as { parkedAt?: string | null }).parkedAt ?? null,
    voucherSent: e.reservation ? e.reservation.confirmationVoucherSent : null,
    reserved: !!e.reservation,
    folioState: e.folio?.state ?? null,
    holdPlaced: e.committedHold?.state === "PLACED" || e.committedHold?.state === "CONFIRMED",
    markerUntil: liveMarker?.expiresAt ?? null,
    quoteState: q?.state ?? null,
    quoteValidUntil: q?.validUntil ?? null,
    roomNumbers: rooms,
    roomsCount: e.numberOfRooms ?? null,
    noShow: !!e.noShowDetermination,
    leftEarly: !!e.earlyDeparture,
    bookerName: bookerName ?? null,
    billingToAccount: !!e.folio?.billingModel && ACCOUNT_MODELS.has(e.folio.billingModel),
    balance,
  };
}

/* ---------- the three parties' names ---------- */

export type BookerKind = "agent" | "company" | "ota" | "direct" | "walk-in";
export type Booker = { kind: BookerKind; name: string; id?: string };

const CHANNEL_WORD: Record<string, string> = {
  WALK_IN: "Walk-in",
  DIRECT: "Direct",
  OTA: "OTA",
  CORPORATE: "Corporate",
  AGENT: "Travel agent",
  TRAVEL_AGENT: "Travel agent",
  EMAIL: "Email",
  PHONE: "Phone",
};

/** "Travel agent", "Walk-in" — how the booking came in, in the desk's words. */
export function channelWord(channel?: string | null): string {
  if (!channel) return "—";
  return CHANNEL_WORD[channel] ?? channel.charAt(0) + channel.slice(1).toLowerCase().replace(/_/g, " ");
}

export function bookerOfRow(r: DeskListRow): Booker | null {
  const inq = r.inquiry;
  if (!inq) return null;
  if (inq.travelAgent) return { kind: "agent", name: inq.travelAgent.displayName, id: inq.travelAgent.id };
  if (inq.corporateAccount) return { kind: "company", name: inq.corporateAccount.displayName, id: inq.corporateAccount.id };
  if (inq.sourceChannel === "OTA") return { kind: "ota", name: "OTA" };
  if (inq.sourceChannel === "WALK_IN") return { kind: "walk-in", name: "Walk-in" };
  return { kind: "direct", name: "the guest direct" };
}

/** The guest's name, or the honest "to come from the agent" when none was given. */
export function guestNameOf(g?: { firstName?: string | null; lastName?: string | null; displayName?: string | null } | null): string {
  if (!g) return "to come from the agent";
  const full = g.displayName?.trim() || [g.firstName, g.lastName].filter(Boolean).join(" ").trim();
  return full || "to come from the agent";
}

export function isNamed(g?: { firstName?: string | null; lastName?: string | null; displayName?: string | null } | null): boolean {
  return guestNameOf(g) !== "to come from the agent";
}
