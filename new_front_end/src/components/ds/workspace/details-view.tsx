"use client";

/**
 * Booking details — "what the booking is" (prototype, the Booking details tab): the three
 * parties, the stay, the trip and the numbers the booking carries.
 *
 * Since 2026-10-12 the money, the papers, the preference and the notes are not repeated here —
 * they have tabs of their own (Charges & payments · Documents · Guest requests · Notes), and the
 * operator's rule for that pass was that nothing on the booking shows twice. Nothing is edited
 * here: at Inquiry the Edit button opens the Inquiry step, where every section edits in place.
 */
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/design-system";
import { JourneySummaryBlock } from "@/components/desk/workspace/journey-summary";
import { channelWord } from "@/lib/ds/status";
import { nightsOf, plural } from "@/lib/ds/format";
import { StayDates } from "@/components/ds/stay-dates";
import { guestName } from "@/lib/desk/model";
import { reservedThisPass } from "@/lib/desk/workspace";
import { heldRoomIds } from "@/lib/desk/party-rooms";
import { useRoomsList } from "@/hooks/use-desk-data";
import { useBookingRooms } from "@/hooks/use-booking-rooms";
import { roomsHeldWord } from "@/components/ds/steps/s2-shared";
import { Fact, FactBox, Facts, StepCard } from "@/components/ds/steps/kit";
import { TripCard } from "@/components/ds/workspace/return-stay";
import { GuestBookingsCard } from "@/components/ds/workspace/guest-bookings";
import type { EntryDetail } from "@/types/api";
import { HelpHere } from "@/components/ds/help";

const BILLING_WORD: Record<string, string> = {
  TOUR_OPERATOR_VOUCHER: "The package to the account · anything beyond it to the guest",
  DIRECT_BILL: "Everything to the account",
  GUEST_PAY: "Everything to the guest",
};

type Scalars = { corporateClientRef?: string | null };
type Contact = { contactPersonName?: string | null; contactPersonPhone?: string | null };

export function DetailsView({
  entry,
  booker,
  custodian,
  onEdit,
}: {
  entry: EntryDetail;
  booker: string | null;
  custodian: string | null;
  /** At Inquiry: open the Inquiry step, where the caller, who is asking and the stay edit in place. */
  onEdit: (() => void) | null;
}) {
  const [journey, setJourney] = useState(false);
  const g = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const inq = (entry.inquiry ?? {}) as Scalars;
  const contact = entry as EntryDetail & Contact;

  const co = entry.actualCheckOutDate ?? entry.checkOutDate;
  const nights = nightsOf(entry.checkInDate, co);
  // Before Arrival assigns them, the rooms the booking holds are named from its newest pick.
  const roomList = useRoomsList().data?.items;
  // A room the system chose and may still move reads "Deluxe Double · room 1" until Arrival.
  const bookingRoomNames = useBookingRooms(entry);
  const held = (entry.roomAssignments ?? []).length
    ? []
    : heldRoomIds(entry)
        .map((id) => roomList?.find((r) => r.id === id))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true }));
  const rooms = Array.from(new Set((entry.roomAssignments ?? []).map((a) => a.room?.roomNumber).filter((x): x is string => !!x))).sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  const types = Array.from(new Set((entry.roomAssignments ?? []).map((a) => (a.room as { roomType?: { name?: string } } | undefined)?.roomType?.name).filter(Boolean)));
  const ages = entry.childAges?.length ? ` (ages ${entry.childAges.join(", ")})` : "";
  const party =
    [entry.adultCount ? plural(entry.adultCount, "adult") : null, entry.childCount ? `${plural(entry.childCount, "child", "children")}${ages}` : null].filter(Boolean).join(" · ") ||
    (entry.guestCount ? plural(entry.guestCount, "guest") : "");
  const beds = entry.bedTypeRequest
    ? Object.entries(entry.bedTypeRequest)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${n} ${t.charAt(0) + t.slice(1).toLowerCase()}`)
        .join(" · ")
    : "";
  const res = reservedThisPass(entry) ? entry.reservation : null;
  const model = entry.folio?.billingModel ?? null;
  // The agency or company on the booking, with its own contact (2026-09-29) — the party's record,
  // printed beside the guest so the desk knows whom to ring about the booking.
  const bookedThrough = entry.inquiry?.travelAgent ?? entry.inquiry?.corporateAccount ?? null;

  return (
    <>
      <h3>
        Booking details <span className="need">what the booking is</span>
      </h3>
      <div className="steps-canvas">
        <StepCard
          title="The three parties"
          right={
            <Button
              kind="secondary"
              compact
              icon="pen"
              state={onEdit ? "default" : "inert"}
              title={onEdit ? "the Inquiry step edits the caller, who is asking and the stay in place" : "after the inquiry, dates and party change through a re-entry"}
              onClick={onEdit ?? undefined}
            >
              Edit at the Inquiry step
            </Button>
          }
        >
          <div className="grid3">
            <FactBox
              k="Guest"
              v={g?.id ? <Link href={`/guests/${g.id}`}>{guestName(g)}</Link> : <span className="name-i">to come from the agent</span>}
              meta={[g?.phone, g?.email].filter(Boolean).join(" · ") || "no contact of their own on file"}
            />
            <FactBox
              k="Booked by"
              v={bookedThrough?.displayName ?? booker ?? channelWord(entry.inquiry?.sourceChannel, entry.inquiry?.cameInAs)}
              meta={
                bookedThrough
                  ? [channelWord(entry.inquiry?.sourceChannel, entry.inquiry?.cameInAs), ...(bookedThrough.contactNumbers ?? []), bookedThrough.contactEmail]
                      .filter(Boolean)
                      .join(" · ") || undefined
                  : booker
                    ? channelWord(entry.inquiry?.sourceChannel, entry.inquiry?.cameInAs)
                    : undefined
              }
            />
            <FactBox k="Billed to" v={model ? BILLING_WORD[model] ?? model : "not set yet"} meta={model ? undefined : "chosen at Set up"} />
          </div>
          <Facts wide style={{ marginTop: 10 }}>
            <Fact k="Arriving">{[contact.contactPersonName, contact.contactPersonPhone].filter(Boolean).join(" · ")}</Fact>
            <Fact k="Custodian">{custodian}</Fact>
            {g?.vipTier ? <Fact k="VIP">{g.vipTier}</Fact> : null}
          </Facts>
        </StepCard>

        <StepCard title="The stay">
          <Facts wide>
            {/* Check-in and Check-out by name, as in the header (2026-10-27). */}
            <Fact k="Dates">
              <StayDates checkIn={entry.checkInDate} checkOut={co} />
            </Fact>
            <Fact k="Nights">{nights ? plural(nights, "night") : "—"}</Fact>
            <Fact k="Rooms" meta={beds ? `asked for ${beds}` : undefined}>
              {rooms.length
                ? `${rooms.length} · ${rooms.join(", ")}${types.length ? ` · ${types.join(", ")}` : ""}`
                : held.length
                  ? `${roomsHeldWord(held.map((r) => ({ number: r.roomNumber, typeName: r.roomType?.name ?? null, quiet: bookingRoomNames.named.has(r.id) })))} · held for the guest, assigned at Arrival`
                  : `${entry.numberOfRooms ?? "—"} · not yet assigned`}
            </Fact>
            <Fact k="Guests">{party}</Fact>
          </Facts>
          <HelpHere label="Where the money is">The price and the money are in Charges &amp; payments.</HelpHere>
        </StepCard>

        <TripCard entry={entry} />
        <GuestBookingsCard entry={entry} />

        <StepCard title="Numbers">
          <Facts wide>
            <Fact k="Enquiry">{entry.inquiry?.id}</Fact>
            <Fact k="Booking">{entry.id}</Fact>
            {entry.splitFromEntryId ? (
              <Fact k="Split off">
                <Link className="mono" href={`/bookings/${entry.splitFromEntryId}`}>
                  {entry.splitFromEntryId}
                </Link>
                {entry.carryOver?.rooms?.length
                  ? ` · ${entry.carryOver.rooms.map((r) => (r.roomNumber === r.fromRoomNumber ? `Room ${r.roomNumber}` : `Room ${r.fromRoomNumber} → ${r.roomNumber}`)).join(", ")}`
                  : ""}
              </Fact>
            ) : null}
            <Fact k="Reservation">{res?.id}</Fact>
            <Fact k="Their reference">{inq.corporateClientRef}</Fact>
            {(entry.segmentNumber ?? 1) > 1 ? <Fact k="Pass">{entry.segmentNumber}</Fact> : null}
          </Facts>
        </StepCard>

        <StepCard
          title="Everything chosen so far"
          right={
            <Button kind="quiet" compact onClick={() => setJourney((v) => !v)}>
              {journey ? "Hide" : "Show"}
            </Button>
          }
          meta="The journey from Inquiry to Reserve in one read — dates, party, rooms, the quote, the hold, the money."
        >
          {journey ? (
            <div className="desk-root tool">
              <JourneySummaryBlock entryId={entry.id} />
            </div>
          ) : null}
        </StepCard>

      </div>
    </>
  );
}
