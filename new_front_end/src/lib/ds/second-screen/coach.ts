/**
 * The coach — what to do now, what to say to the guest, and what the next press will do
 * (2026-10-07, the second screen, Inquiry first).
 *
 * The desk's to-do list says what is missing ("Availability searched"). The coach says what to
 * DO about it, in the words the operator can use with the guest on the phone, using the house's
 * own figures for the dates being typed. It never decides anything: what is missing comes from the
 * desk's own reading of the step (the "desk" draft), and every figure from the backend.
 */
import type { AvailabilityPreview } from "@/lib/api/availability";
import { fmtDay, fmtRange, money, plural } from "@/lib/ds/format";
import type { DeskDraft, RoomsDraft, StayDraft } from "./drafts";

export type Coach = {
  /** What to do now, as an instruction. */
  now: string;
  /** Why, or how — one line. */
  how: string | null;
  /** Words the operator can say to the guest. */
  say: string | null;
  /** What pressing the next button will do. */
  then: string | null;
  tone: "act" | "fix" | "ready";
  /** The desk card it is done on — clicking the coach on the board takes the desk there. */
  card?: string | null;
};

/** "Standard Double, Nu 6,237.00 for the 3 nights · …" — the house's own figures, joined. */
export function pricePhrase(p: AvailabilityPreview, max = 3): string | null {
  const offer = p.types.filter((t) => t.freeEveryNight > 0 && t.stayPerRoomWithTax != null);
  if (!offer.length) return null;
  const cheap = [...offer].sort((a, b) => (a.stayPerRoomWithTax ?? 0) - (b.stayPerRoomWithTax ?? 0)).slice(0, max);
  return cheap.map((t) => `${t.name} at ${money(t.stayPerRoomWithTax, p.currency)} a room`).join(", ");
}

export function houseSentence(p: AvailabilityPreview): string {
  const when = fmtRange(p.checkInDate, p.checkOutDate);
  const nights = plural(p.nights.length, "night");
  if (p.fits) {
    const prices = pricePhrase(p);
    return `Yes — we have rooms for ${when}. ${prices ? `For the ${nights}: ${prices}, service charge and GST included.` : ""}`.trim();
  }
  const better = p.nearby.find((n) => n.fits);
  return `For ${when} I can offer ${plural(p.freeEveryNight, "room")} for all ${nights}, not the ${p.roomsNeeded} you asked for.${
    better ? ` If you can come ${fmtRange(better.checkInDate, better.checkOutDate)} instead, we have room.` : ""
  }`;
}

/** The Inquiry card each instruction is done on. */
function cardFor(now: string): string | null {
  if (/reach the guest/.test(now)) return "guest";
  if (/dates|who is coming|Save the stay|does not fit/.test(now)) return "stay";
  if (/Ask the house|^Pick|Save the rooms/.test(now)) return "house";
  return null;
}

export function coachInquiry(input: Parameters<typeof coachInquiryNow>[0]): Coach {
  const c = coachInquiryNow(input);
  return { ...c, card: c.card ?? cardFor(c.now) };
}

function coachInquiryNow(input: {
  desk: DeskDraft | null;
  stay: StayDraft | null;
  rooms: RoomsDraft | null;
  preview: AvailabilityPreview | null;
  latestRefusal: string | null;
}): Coach {
  const { desk, stay, rooms, preview, latestRefusal } = input;
  const items = desk?.items ?? [];
  const missing = (label: string) => items.some((i) => i.label === label && !i.met);

  if (stay?.warning) {
    return {
      now: "This party does not fit the rooms asked for",
      how: `${stay.warning}. Raise Rooms on the desk, or check the ages — children under 11 share their parents' bedding.`,
      say: (() => {
        const party = `${plural(stay.adults, "adult")}${stay.children ? ` and ${plural(stay.children, "child", "children")}` : ""}`;
        if (stay.minRooms && preview && preview.roomsNeeded >= stay.minRooms)
          return preview.fits
            ? `For ${party} you would need at least ${plural(stay.minRooms, "room")} — and we have them free for those nights. Shall I take ${stay.minRooms}?`
            : `For ${party} you would need at least ${plural(stay.minRooms, "room")}, and only ${preview.freeEveryNight} are free for all those nights.`;
        return `For ${party} you would need more rooms. Shall I look for more?`;
      })(),
      then: null,
      tone: "fix",
    };
  }
  if (latestRefusal) {
    return { now: "The desk was just refused", how: `${latestRefusal} Put it right on the desk, then try again.`, say: null, then: null, tone: "fix" };
  }
  if (stay) {
    return {
      now: "Save the stay",
      how: "The dates or the party have changed on the desk and are not saved yet. Press Save the stay, then ask the house again.",
      say: preview ? houseSentence(preview) : null,
      then: "Saving keeps the new dates and party on the booking. Then ask the house again for them.",
      tone: "act",
    };
  }
  if (missing("A contact on file")) {
    return {
      now: "Get a way to reach the guest",
      how: "A phone number or an email — on The guest card. An agency booking can use the agency's contact person instead.",
      say: "May I have a phone number or an email, in case we need to reach you about the booking?",
      then: null,
      tone: "act",
    };
  }
  if (missing("Stay dates set")) {
    return { now: "Fix the dates", how: "Check-in and nights, on The stay card.", say: "Which night do you arrive, and for how many nights?", then: null, tone: "act" };
  }
  if (missing("Guest count set")) {
    return {
      now: "Ask who is coming",
      how: "Adults, children and each child's age, on The stay card — the age decides the price.",
      say: "How many adults are coming? And any children — how old are they?",
      then: null,
      tone: "act",
    };
  }
  if (missing("Availability searched")) {
    return {
      now: "Ask the house for these dates",
      how: "Press Ask the house on the desk — the free rooms appear there, and the answer is recorded on the booking.",
      say: preview ? houseSentence(preview) : null,
      then: null,
      tone: "act",
    };
  }
  if (missing("Preferred room selected")) {
    if (rooms && rooms.ready) {
      return {
        now: "Save the rooms",
        how: "Every night has its rooms. Press Save on the rooms table so the booking keeps them.",
        say: null,
        then: "Saving records the rooms for this booking. It does not hold them — another booking can still take them until they are held at Set up.",
        tone: "act",
      };
    }
    const need = rooms?.numberOfRooms ?? preview?.roomsNeeded ?? 1;
    return {
      now: `Pick ${plural(need, "room")} for every night`,
      how: rooms
        ? `${rooms.nightsReady} of ${plural(rooms.nights.length, "night")} have all ${plural(need, "room")}. Click a room's row to take it for the whole stay.`
        : "Click a room's row in the rooms table to take it for the whole stay, or one night's cell for that night only.",
      say: preview ? houseSentence(preview) : null,
      then: null,
      tone: "act",
    };
  }
  if (desk?.gate?.ready) {
    return {
      now: desk.gate.label,
      how: "Everything the inquiry needs is done.",
      say: "Shall I prepare a quotation for you?",
      then: "Moving on stops the inquiry's clock and starts the negotiation's. Nothing is held and nothing is sent to the guest yet — the next step prices the stay.",
      tone: "ready",
    };
  }
  const next = items.find((i) => !i.met);
  return { now: next ? next.label : "Look over the inquiry", how: desk?.gate?.reason ? `The next move waits: ${desk.gate.reason}.` : null, say: null, then: null, tone: "act" };
}

/** "short on 8 Nov (1 free)" */
export function shortWords(p: AvailabilityPreview): string {
  return p.shortNights.map((n) => `${fmtDay(n.date)} (${n.free} free)`).join(", ");
}
