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
import { useMemo } from "react";
import { Button } from "@/design-system";
import { DsDialog, Fact, Facts } from "./kit";
import { PickBill, usePickPricing, type BillNight } from "./s1-bill";
import { enumerateNights } from "./use-room-selection";
import { USE_TYPES, bedWord } from "./new-inquiry-parts";
import { currentPassConfigs } from "@/lib/desk/workspace";
import { callerNameOf, channelWord } from "@/lib/ds/status";
import { fmtRange, plural } from "@/lib/ds/format";
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
}: {
  entry: EntryDetail;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const picks = useMemo(() => savedPicks(entry), [entry]);
  const bill = usePickPricing(entry.id, picks, open);

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
      width={760}
      title="Check the inquiry before Negotiation"
      help="What the Inquiry step recorded, in one place. The prices are indicative — the room only, as the house prices it today. Meals, extra beds and any agreed rate are set at Negotiation, where the quotation prices them exactly."
      caseLines={[<b key="n">{g ? guestName(g) : caller ?? "—"}</b>, entry.id]}
      footer={
        <>
          <Button kind="quiet" onClick={onClose} state={busy ? "inert" : "default"}>
            Go back and edit
          </Button>
          <Button kind="primary" onClick={onConfirm} state={busy ? "working" : "default"} workingLabel="Moving…">
            Confirm and move to Negotiation
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
            {entry.contactPersonName || entry.contactPersonPhone ? (
              <Fact k="Who is arriving">{[entry.contactPersonName, entry.contactPersonPhone].filter(Boolean).join(" · ")}</Fact>
            ) : null}
          </Facts>
        </section>

        <section>
          <b className="cfg-n">The stay</b>
          <Facts wide>
            <Fact k="Dates">{`${fmtRange(entry.checkInDate, entry.checkOutDate)}${nights ? ` · ${plural(nights, "night")}` : ""}`}</Fact>
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

        <section>
          {bill.pricing ? (
            <PickBill
              pricing={bill.pricing}
              loading={bill.loading}
              title="The rooms chosen"
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
