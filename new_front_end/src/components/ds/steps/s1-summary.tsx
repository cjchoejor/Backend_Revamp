"use client";

/**
 * The look back before Negotiation (2026-10-22, operator: "before moving to S2, a pop-up showing
 * all the rooms selected and their prices and the indicative total with taxes and all, and the
 * guest's name and who is enquiring, like the caller — a summed-up summary of what was chosen and
 * happened in S1, so the user can cross-check it once before going to S2; with Go back and edit,
 * and Confirm and move to Negotiation").
 *
 * Every figure is the server's: the same bill the Inquiry step prints (`price-pick`), priced on
 * the rooms as SAVED — the move to Negotiation carries the saved pick, never an unsaved one.
 */
import { StayDates } from "@/components/ds/stay-dates";
import { useBookingRooms } from "@/hooks/use-booking-rooms";
import { useMemo } from "react";
import { Button } from "@/design-system";
import { DsDialog, Fact, Facts } from "./kit";
import { PickBill, TripPickBill, usePickPricing, useTripPickPricing, type BillNight } from "./s1-bill";
import { enumerateNights } from "./use-room-selection";
import { USE_TYPES, bedWord } from "./new-inquiry-parts";
import { currentPassConfigs } from "@/lib/desk/workspace";
import { callerNameOf, channelWord } from "@/lib/ds/status";
import { plural } from "@/lib/ds/format";
import { guestName } from "@/lib/desk/model";
import type { AvailabilityOptionSelected, EntryDetail } from "@/types/api";

/** The saved pick as nights with their rooms — what the move to Negotiation carries. */
function savedPicks(entry: EntryDetail): BillNight[] {
  const seal = currentPassConfigs(entry).find((c) => c.sealedAt && c.optionSelected) ?? null;
  const opt = (seal?.optionSelected ?? null) as AvailabilityOptionSelected | null;
  if (!opt) return [];
  if ("perNight" in opt && Array.isArray(opt.perNight)) {
    return opt.perNight.map((p) => ({ date: String(p.date).slice(0, 10), roomIds: p.roomIds.map((r) => r.roomId) }));
  }
  const ids =
    "roomIds" in opt && Array.isArray(opt.roomIds)
      ? opt.roomIds.map((r) => r.roomId)
      : "roomId" in opt && typeof opt.roomId === "string"
        ? [opt.roomId]
        : [];
  return enumerateNights(entry.checkInDate, entry.checkOutDate).map((date) => ({ date, roomIds: ids }));
}

export function InquirySummaryDialog({
  entry,
  open,
  busy,
  onClose,
  onConfirm,
  alsoMoving = [],
  stayNoOf,
}: {
  entry: EntryDetail;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** A trip at Inquiry: the other stays moving with this one (2026-11-07, one Continue moves every stay). */
  alsoMoving?: EntryDetail[];
  stayNoOf?: (id: string) => number;
}) {
  const picks = useMemo(() => savedPicks(entry), [entry]);
  const bill = usePickPricing(entry.id, picks, open && !alsoMoving.length);
  const roomLabels = useBookingRooms(entry).labels;
  // A trip: every stay moving together, priced together on the rooms as SAVED (2026-11-07).
  const tripEntries = useMemo(
    () => (alsoMoving.length ? [entry, ...alsoMoving].sort((a, b) => (stayNoOf?.(a.id) ?? 0) - (stayNoOf?.(b.id) ?? 0)) : []),
    [entry, alsoMoving, stayNoOf],
  );
  const tripStays = tripEntries.map((e) => ({ entryId: e.id, picks: savedPicks(e) }));
  const tripBill = useTripPickPricing(entry.id, tripStays, open && tripEntries.length > 1);
  const noRooms = tripEntries.filter((e) => savedPicks(e).length === 0);

  const inq = entry.inquiry;
  const caller = callerNameOf(inq);
  const callerReach = [
    inq?.callerPhone ? `${inq.callerPhone}${inq.callerOnWhatsApp ? " (WhatsApp)" : ""}` : null,
    inq?.callerEmail ?? null,
  ].filter(Boolean);
  const party = inq?.travelAgent ?? inq?.corporateAccount ?? null;
  const came = channelWord(inq?.sourceChannel, inq?.cameInAs);
  const g = entry.guestProfile ?? null;
  const ages = entry.childAges ?? [];
  const kind = USE_TYPES.find(([k]) => k === entry.useType)?.[1] ?? entry.useType ?? null;
  const nights = enumerateNights(entry.checkInDate, entry.checkOutDate).length;
  const bedAsk = Object.entries(entry.bedTypeRequest ?? {}).filter(([, n]) => n > 0);

  return (
    <DsDialog
      open={open}
      onClose={onClose}
      busy={busy}
      // A trip's stays each read on one line (2026-11-07).
      width={alsoMoving.length ? 940 : 760}
      title="Check the inquiry before Negotiation"
      help="What the Inquiry step recorded, in one place. The prices are indicative — the room only, as the house prices it today. Meals, extra beds and any agreed rate are set at Negotiation, where the quotation prices them exactly."
      caseLines={[<b key="n">{g ? guestName(g) : caller ?? "—"}</b>, entry.id]}
      footer={
        <>
          <Button kind="quiet" onClick={onClose} state={busy ? "inert" : "default"}>
            Go back and edit
          </Button>
          <Button kind="primary" className="go" onClick={onConfirm} state={busy ? "working" : "default"} workingLabel="Moving…">
            {alsoMoving.length ? `Confirm and move ${plural(alsoMoving.length + 1, "stay")} to Negotiation` : "Confirm and move to Negotiation"}
          </Button>
        </>
      }
    >
      <div className="inq-summary">
        <section>
          <b className="cfg-n">Who</b>
          <Facts wide>
            <Fact k="The caller" meta={callerReach.join(" · ") || undefined}>
              {caller ?? (callerReach.length ? "name not taken" : null)}
            </Fact>
            <Fact k="Came in as" meta={party ? [party.contactNumbers?.[0], party.contactEmail].filter(Boolean).join(" · ") || undefined : undefined}>
              {party ? `${party.displayName} · ${came}` : came}
            </Fact>
            <Fact
              k="The guest staying"
              meta={g ? [g.nationality, g.phone, g.email].filter(Boolean).join(" · ") || undefined : undefined}
            >
              {g ? guestName(g) : null}
            </Fact>
            {entry.inquiry?.partyContacts?.length ? (
              <Fact k={entry.inquiry.partyContacts.length > 1 ? "Their contact persons" : "Their contact person"}>
                {entry.inquiry.partyContacts.map((c, i) => (
                  <div key={i}>{[[c.title, c.name].filter(Boolean).join(" "), c.phone].filter(Boolean).join(" · ")}</div>
                ))}
              </Fact>
            ) : null}
            {entry.contactPersonName || entry.contactPersonPhone ? (
              <Fact k="Who is arriving">{[entry.contactPersonName, entry.contactPersonPhone].filter(Boolean).join(" · ")}</Fact>
            ) : null}
          </Facts>
        </section>

        {tripEntries.length ? (
          <section>
            <b className="cfg-n">The stays · {plural(tripEntries.length, "stay")}</b>
            <div className="stay-strips">
              {tripEntries.map((e) => (
                <StayStrip key={e.id} entry={e} stayNo={stayNoOf?.(e.id) ?? 1} firstGuestId={tripEntries[0].guestProfile?.id ?? null} />
              ))}
            </div>
            {inq?.notes ? (
              <Facts wide>
                <Fact k="Preference">{inq.notes}</Fact>
              </Facts>
            ) : null}
          </section>
        ) : (
        <section>
          <b className="cfg-n">The stay</b>
          <Facts wide>
            <Fact k="The stay">
              <StayDates checkIn={entry.checkInDate} checkOut={entry.checkOutDate} />
              {nights ? ` · ${plural(nights, "night")}` : ""}
            </Fact>
            <Fact k="Guests">
              {`${plural(entry.adultCount ?? entry.guestCount ?? 0, "adult")}${
                ages.length ? ` · ${plural(ages.length, "child", "children")} (aged ${ages.join(", ")})` : ""
              }`}
            </Fact>
            <Fact k="Rooms asked for">{entry.numberOfRooms != null ? String(entry.numberOfRooms) : null}</Fact>
            <Fact k="Kind of stay">{kind}</Fact>
            {bedAsk.length ? (
              <Fact k="Beds asked for">{bedAsk.map(([t, n]) => `${n} ${bedWord(t)}`).join(" · ")}</Fact>
            ) : null}
            {inq?.notes ? <Fact k="Preference">{inq.notes}</Fact> : null}
          </Facts>
        </section>
        )}

        <section>
          {tripEntries.length ? (
            noRooms.length ? (
              <p className="stop-ink" role="alert">
                No rooms are saved for {noRooms.map((e) => `stay ${stayNoOf?.(e.id) ?? "?"}`).join(" and ")} yet — go back and save them first.
              </p>
            ) : tripBill.pricing ? (
              <TripPickBill
                trip={tripBill.pricing}
                entries={tripEntries}
                stayNoOf={stayNoOf ?? (() => 1)}
                loading={tripBill.loading}
                title="The rooms chosen"
                help="Indicative, not a quote. Meals, extra beds and any agreed rate are set at Negotiation, where each stay's quotation prices them."
              />
            ) : tripBill.error ? (
              <p className="warn-ink">The rooms could not be priced just now — the move does not depend on it.</p>
            ) : (
              <p className="meta">Pricing the rooms…</p>
            )
          ) : bill.pricing ? (
            <PickBill
              pricing={bill.pricing}
              roomLabels={Object.fromEntries(roomLabels)}
              loading={bill.loading}
              title={alsoMoving.length && stayNoOf ? `Stay ${stayNoOf(entry.id)} · the rooms chosen` : "The rooms chosen"}
              help="Indicative, not a quote. Meals, extra beds and any agreed rate are set at Negotiation."
            />
          ) : picks.length === 0 ? (
            <p className="stop-ink" role="alert">
              No rooms are saved yet — go back and save the rooms first.
            </p>
          ) : bill.error ? (
            <p className="warn-ink">The rooms could not be priced just now — the move does not depend on it.</p>
          ) : (
            <p className="meta">Pricing the rooms…</p>
          )}
        </section>
      </div>
    </DsDialog>
  );
}

/**
 * One stay of a trip on one line (2026-11-07, operator: "the stay can show, stay 1 and stay 2, and
 * their infos can be shown in the same line — the guest, rooms and kind of stay — in a creative
 * way"): its number, its dates, then each fact as a small labelled box, like the dates' own.
 */
function StayStrip({ entry, stayNo, firstGuestId }: { entry: EntryDetail; stayNo: number; firstGuestId: string | null }) {
  const nights = enumerateNights(entry.checkInDate, entry.checkOutDate).length;
  const ages = entry.childAges ?? [];
  const kind = USE_TYPES.find(([k]) => k === entry.useType)?.[1] ?? entry.useType ?? null;
  const beds = Object.entries(entry.bedTypeRequest ?? {}).filter(([, n]) => n > 0);
  // The guest is the trip's; a stay naming someone else says so.
  const otherGuest = entry.guestProfile && entry.guestProfile.id !== firstGuestId ? guestName(entry.guestProfile) : null;
  const box = (k: string, v: string | null) =>
    v ? (
      <span className="sfact">
        <span className="lbl">{k}</span>
        <b>{v}</b>
      </span>
    ) : null;
  return (
    <div className="stay-strip">
      <span className="ss-no">
        Stay {stayNo}
      </span>
      <StayDates checkIn={entry.checkInDate} checkOut={entry.checkOutDate} />
      {nights ? <span className="ss-nights">{plural(nights, "night")}</span> : null}
      <span className="ss-facts">
        {box(
          "Guests",
          `${plural(entry.adultCount ?? entry.guestCount ?? 0, "adult")}${ages.length ? `, ${plural(ages.length, "child", "children")} (${ages.join(", ")})` : ""}`,
        )}
        {box("Rooms", entry.numberOfRooms != null ? String(entry.numberOfRooms) : null)}
        {box("Stay", kind)}
        {beds.length ? box("Beds", beds.map(([t, n]) => `${n} ${bedWord(t)}`).join(" · ")) : null}
        {otherGuest ? box("Guest", otherGuest) : null}
      </span>
    </div>
  );
}
