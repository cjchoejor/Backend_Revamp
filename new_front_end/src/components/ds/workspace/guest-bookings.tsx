"use client";

/**
 * This guest's other bookings, on any enquiry (2026-10-19, operator: "add a card on each booking
 * listing the same guest's other bookings"). "This trip" lists the stays of ONE enquiry; a guest's
 * second booking on another enquiry was invisible from the first. Matched on the guest's RECORD,
 * never on the name — two people called Pema Penjor are two records.
 *
 * A booking for the same nights can be combined into this one while both are still at Inquiry or
 * Negotiation — the server's preview says what it would do and refuses everything else in words.
 */
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { DsDialog, StepCard, toastRefusal, useRefreshEntry } from "@/components/ds/steps/kit";
import { Help } from "@/components/ds/help";
import { bookingHref } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { combineBookings, listSameGuestBookings, previewCombineBookings, type SameGuestBooking } from "@/lib/api/guest-bookings";
import { endingOf } from "@/lib/ds/status";
import { fmtDate, fmtRange, plural } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";

const partyWords = (adults: number, children: number) =>
  [plural(adults, "adult"), children ? plural(children, "child", "children") : null].filter(Boolean).join(" · ");

function standingOf(b: SameGuestBooking) {
  if (b.live) return b.status === "PARKED" ? `${b.stageWord} · parked` : b.stageWord;
  const ending = endingOf(b.closedAs);
  return ending ? `${ending.word}${ending.qualifier ? ` · ${ending.qualifier}` : ""}` : b.status === "CLOSED" ? "Closed" : b.status.toLowerCase();
}

export function GuestBookingsCard({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["guest-bookings", entry.id, entry.updatedAt],
    queryFn: () => listSameGuestBookings(session!, entry.id),
    enabled: !!session && !!entry.guestProfile?.id,
    staleTime: 15_000,
  });
  const [combining, setCombining] = useState<SameGuestBooking | null>(null);
  const rows = q.data?.bookings ?? [];
  if (!entry.guestProfile?.id || rows.length === 0) return null;
  const overlapping = rows.filter((r) => r.overlapsThis).length;
  return (
    <StepCard
      title="This guest's other bookings"
      status={`${q.data?.guestName ?? "The guest"} · ${plural(rows.length, "booking")}${overlapping ? `, ${overlapping} over these nights` : ""}`}
      meta="Matched on the guest's record, not the name." 
    >
      <div className="gb-rows">
        {rows.map((b) => (
          <div key={b.entryId} className={`gb-row${b.overlapsThis ? " overlap" : ""}${b.live ? "" : " ended"}`}>
            <span className="gb-dates">
              <b>{b.checkInDate && b.checkOutDate ? fmtRange(b.checkInDate, b.checkOutDate) : "no dates yet"}</b>
              {b.rooms.length ? <span className="sm"> · Room {b.rooms.join(", ")}</span> : null}
              <span className="sm muted"> · {standingOf(b)}</span>
            </span>
            {b.overlapsThis ? <Chip tone="warning">over these nights</Chip> : null}
            {b.sameEnquiry ? <Chip tone="quiet">this trip</Chip> : null}
            <Link className="mono sm" href={bookingHref(b.entryId)}>
              {b.entryId}
            </Link>
            {b.overlapsThis ? (
              b.combine.possible ? (
                <Button kind="secondary" compact onClick={() => setCombining(b)}>
                  Combine into this booking…
                </Button>
              ) : (
                <span className="gb-why">
                  Not combined here
                  <Help label="Why these are not combined">{b.combine.why ?? "—"}</Help>
                </span>
              )
            ) : null}
          </div>
        ))}
      </div>
      {combining ? <CombineDialog entry={entry} other={combining} onClose={() => setCombining(null)} /> : null}
    </StepCard>
  );
}

function CombineDialog({ entry, other, onClose }: { entry: EntryDetail; other: SameGuestBooking; onClose: () => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const [reason, setReason] = useState("");
  const pv = useQuery({
    queryKey: ["combine-preview", entry.id, other.entryId, entry.updatedAt],
    queryFn: () => previewCombineBookings(session!, entry.id, other.entryId),
    enabled: !!session,
    staleTime: 0,
  });
  const run = useMutation({
    mutationFn: () => combineBookings(session!, entry.id, { otherEntryId: other.entryId, reason: reason.trim(), expectedVersion: entry.version }),
    onSuccess: (out) => {
      refresh([["guest-bookings", entry.id]]);
      for (const k of [["entry", out.combinedFrom], ["room-chart"], ["desk-bookings"]]) void qc.invalidateQueries({ queryKey: k });
      toast.success(`${out.combinedFrom} combined into this booking — ${partyWords(out.adults, out.children)} in Room ${out.rooms.join(", ")}`, {
        description: entry.currentStage === "S2" ? "Its quotation was withdrawn — price it again at Negotiation." : undefined,
        duration: 8000,
      });
      if (out.otherEndRefused) toast.warning(out.otherEndRefused, { duration: 10000 });
      for (const n of out.notes) toast.warning(n, { duration: 9000 });
      onClose();
    },
    onError: (e) => toastRefusal(e, "The bookings could not be combined"),
  });
  useEffect(() => {
    if (pv.error) toastRefusal(pv.error, "The combine could not be checked");
  }, [pv.error]);
  const p = pv.data;
  const blockedBy = !p
    ? "Checking with the house…"
    : !p.authority.ok
      ? p.authority.why
      : p.refusals.length
        ? "Something above refuses it"
        : !reason.trim()
          ? "Say why the bookings are being combined"
          : null;
  return (
    <DsDialog
      open
      onClose={() => !run.isPending && onClose()}
      width={640}
      busy={run.isPending}
      title={`Combine ${other.entryId} into this booking`}
      footer={
        <>
          <Button kind="quiet" onClick={onClose} state={run.isPending ? "inert" : "default"}>
            Keep them separate
          </Button>
          <Button kind="primary" state={blockedBy || run.isPending ? "inert" : "default"} onClick={() => !blockedBy && run.mutate()}>
            {run.isPending ? "Combining…" : "Combine the bookings"}
          </Button>
        </>
      }
    >
      <div className="cmb">
        {!p ? (
          <p className="sm muted">Checking with the house…</p>
        ) : (
          <>
            {p.refusals.length || !p.authority.ok ? (
              <ul className="rmv-refusals rmv-moveref" role="alert">
                {!p.authority.ok ? <li>{p.authority.why}</li> : null}
                {p.refusals.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
            <div className="cmb-sides">
              <div className="cmb-side">
                <span className="meta">This booking · {p.kept.stageWord}</span>
                <b>{partyWords(p.kept.adults, p.kept.children)}</b>
                <span className="sm">Room {p.kept.rooms.join(", ") || "—"}</span>
              </div>
              <span className="rmv-arrow">+</span>
              <div className="cmb-side">
                <span className="meta">
                  {p.other.entryId} · {p.other.stageWord}
                </span>
                <b>{partyWords(p.other.adults, p.other.children)}</b>
                <span className="sm">Room {p.other.rooms.join(", ") || "—"}</span>
              </div>
            </div>
            <div className="cmb-after">
              <span className="meta">After</span>
              <b>
                {partyWords(p.after.adults, p.after.children)} · {plural(p.after.numberOfRooms, "room")}
              </b>
              {p.after.nights.map((n) => (
                <span key={n.date} className="sm">
                  {fmtDate(n.date)} · Room {n.rooms.join(", ")}
                </span>
              ))}
            </div>
            <ul className="cmb-cons">
              {p.consequences.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
        <label className="field">
          <span>Why combine them</span>
          <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. the guest wants one booking for the family" />
        </label>
        {blockedBy && p ? <p className="stop-ink sm" style={{ margin: 0, fontWeight: 700 }}>{blockedBy}</p> : null}
      </div>
    </DsDialog>
  );
}
