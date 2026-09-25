"use client";

/**
 * The trip — one enquiry, more than one stay (2026-09-25, operator ruling).
 *
 * "We stay two nights, go to Punakha, and stay again on the way back" is two bookings: each holds
 * its own rooms for its own nights, is checked in and out on its own and — the operator's choice
 * of the three offered — keeps its own folio, its own bill and its own tax invoice. The room in
 * between has to stay sellable, and a tax invoice covers one stay.
 *
 * What links them is the ENQUIRY. Both stays hang off the same one, so its number is the trip's
 * file number, the agency, the rate package and the notes are shared by construction, and either
 * booking can show the other. The desk never searches for the guest twice, which is also what
 * stops a second guest record being typed by mistake on the return visit.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { bookingHref } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { addReturnStay } from "@/lib/api/entries";
import { fmtRange, plural } from "@/lib/ds/format";
import { stepName, stepNoOfStage } from "@/lib/ds/steps";
import { DsDialog, StepCard, toastRefusal, useRefreshEntry } from "@/components/ds/steps/kit";
import type { EntryDetail, TripStaySummary } from "@/types/api";

/** A trip that is over — the next visit is a fresh enquiry, not a return stay on this one. */
const SEALED = new Set(["CANCELLED", "EXPIRED", "CLOSED"]);

export type Trip = {
  /** Every stay on this enquiry, oldest first, this one included. */
  stays: TripStaySummary[];
  /** Where this booking sits in the trip, 1-based; 0 when the payload carries no list. */
  position: number;
  others: TripStaySummary[];
  /** The last night the trip covers so far — where a return stay starts by default. */
  lastCheckOut: string | null;
};

export function tripOf(entry: EntryDetail): Trip {
  const stays = entry.inquiry?.entries ?? [];
  const others = stays.filter((s) => s.id !== entry.id);
  const lastCheckOut = stays.reduce<string | null>((acc, s) => {
    const co = s.checkOutDate?.slice(0, 10) ?? null;
    return co && (!acc || co > acc) ? co : acc;
  }, null);
  return { stays, position: stays.findIndex((s) => s.id === entry.id) + 1, others, lastCheckOut };
}

function addDays(ymd: string, days: number): string {
  if (!ymd) return "";
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function partyWords(entry: EntryDetail): string {
  const adults = entry.adultCount ?? entry.guestCount ?? null;
  const children = entry.childCount ?? 0;
  return [
    adults ? plural(adults, "adult") : null,
    children ? plural(children, "child", "children") : null,
    entry.numberOfRooms ? plural(entry.numberOfRooms, "room") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/* ------------------------------------------------------------------ the list */

/** One line per stay of the trip, this one marked, the others opening in the workspace. */
export function TripStays({ entry }: { entry: EntryDetail }) {
  const trip = tripOf(entry);
  if (trip.stays.length < 2) return null;
  return (
    <div className="trip-stays">
      {trip.stays.map((s, i) => {
        const here = s.id === entry.id;
        const off = s.status === "CANCELLED" || s.status === "EXPIRED";
        return (
          <div key={s.id} className="trip-stay">
            <span className="meta">Stay {i + 1}</span>
            <span className={off ? "dash" : "sm"}>
              <b>{fmtRange(s.checkInDate, s.checkOutDate)}</b>
              {s.numberOfRooms ? ` · ${plural(s.numberOfRooms, "room")}` : ""}
              {off
                ? ` · ${s.status === "CANCELLED" ? "cancelled" : "lapsed"}`
                : ` · ${stepName(stepNoOfStage(s.currentStage))}`}
            </span>
            {here ? <Chip tone="accent">this one</Chip> : <Link href={bookingHref(s.id)}>{s.id}</Link>}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ the act */

export function AddReturnStay({ entry, kind = "quiet" }: { entry: EntryDetail; kind?: "quiet" | "secondary" }) {
  const [open, setOpen] = useState(false);
  const sealed = SEALED.has(entry.status ?? "");
  return (
    <>
      <Button
        kind={kind}
        compact
        state={sealed ? "inert" : "default"}
        title={
          sealed
            ? "this booking is closed — the guest's next visit starts a fresh enquiry"
            : "the guest leaves and comes back: a second booking under this enquiry"
        }
        onClick={() => setOpen(true)}
      >
        Add a return stay
      </Button>
      {open ? <ReturnStayDialog entry={entry} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ReturnStayDialog({ entry, onClose }: { entry: EntryDetail; onClose: () => void }) {
  const { session } = useSession();
  const router = useRouter();
  const refresh = useRefreshEntry(entry.id);
  const day = useHotelDay();
  const trip = tripOf(entry);

  const [from, setFrom] = useState(() => trip.lastCheckOut ?? entry.checkOutDate?.slice(0, 10) ?? "");
  const [nights, setNights] = useState("1");
  const nightsN = Math.max(1, parseInt(nights || "1", 10) || 1);
  const to = useMemo(() => addDays(from, nightsN), [from, nightsN]);
  const past = !!day && !!from && from < day.today;
  const ok = !!from && !!to && !past;

  const add = useMutation({
    mutationFn: () => addReturnStay(session!, entry.id, { checkInDate: from, checkOutDate: to }),
    onSuccess: (created) => {
      refresh();
      toast.success(`Return stay added · ${created.id}`, {
        description: `${fmtRange(from, to)} — its own rooms and its own bill, on enquiry ${entry.inquiry?.id ?? "this one"}`,
        duration: 8000,
      });
      onClose();
      router.push(bookingHref(created.id));
    },
    onError: (e) => toastRefusal(e, "The return stay was not added."),
  });

  return (
    <DsDialog
      open
      onClose={onClose}
      busy={add.isPending}
      width={560}
      title="They are coming back"
      caseLines={[entry.inquiry?.id ?? entry.id, `${plural(trip.stays.length, "stay")} so far`]}
      footer={
        <>
          <Button kind="quiet" state={add.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            solid
            state={add.isPending ? "working" : ok ? "default" : "inert"}
            title={!from ? "put in the day they come back" : past ? "a return stay starts today or later" : undefined}
            workingLabel="Adding…"
            onClick={() => add.mutate()}
          >
            Add the return stay
          </Button>
        </>
      }
    >
      <p className="sm">
        A second booking under the same enquiry: it holds its own rooms for its own nights and carries its own bill, so
        the room is free to sell in between. It starts at Inquiry with the rooms still to choose.
      </p>
      <div className="form2" style={{ marginTop: 10 }}>
        <div className="field">
          <label>Coming back on</label>
          <input
            className="input"
            type="date"
            value={from}
            min={day?.today ?? undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Nights</label>
          <input
            className="input"
            inputMode="numeric"
            value={nights}
            onChange={(e) => setNights(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <span className="hint">{to ? `leaving ${fmtRange(from, to)}` : "put in the day they come back"}</span>
        </div>
      </div>
      <p className="meta" style={{ marginTop: 8 }}>
        The same party comes back{partyWords(entry) ? ` — ${partyWords(entry)}` : ""}. Change it on the new booking if it
        differs.{" "}
        {trip.stays.length > 1 ? "A night already on this enquiry is refused: that would be the same stay twice." : ""}
      </p>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ the card */

/** Booking details' "This trip" — every stay of the enquiry, and the way to add the next one. */
export function TripCard({ entry }: { entry: EntryDetail }) {
  const trip = tripOf(entry);
  const many = trip.stays.length > 1;
  return (
    <StepCard
      title="This trip"
      right={<AddReturnStay entry={entry} />}
      meta={
        many
          ? `${plural(trip.stays.length, "stay")} on enquiry ${entry.inquiry?.id ?? "—"} — each one holds its own rooms and carries its own bill.`
          : `One stay, on enquiry ${entry.inquiry?.id ?? "—"}. If the guest leaves and comes back, add the return stay here rather than starting again.`
      }
    >
      {many ? <TripStays entry={entry} /> : null}
    </StepCard>
  );
}
