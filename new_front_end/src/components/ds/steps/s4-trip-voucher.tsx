"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { getTripVoucher, markTripVoucherNotSent } from "@/lib/api/trip-papers";
import { fmtStamp } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { HeldPapersCard, useHeldDocuments } from "@/components/ds/workspace/held-papers";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { DsDialog, NotSentChip, PaperDrawer, StepCard, toastRefusal, useRefreshEntry, useReplyAsked, type PaperRef } from "./kit";
import { TripAnswerDialog, TripSendDialog } from "./s2-trip-quotation";
import { tripStamp } from "@/components/ds/steps/s2-together";

/**
 * THE TRIP'S CONFIRMATION VOUCHER (2026-11-09, operator: "do the same for proforma and reserve and
 * confirmation voucher"). Made by itself once every stay is reserved. Viewing the stays together it
 * stands in the voucher's place: sending it sends each stay's with it, one email, the trip's.
 */
export function useTripVoucher(entry: EntryDetail) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["trip-voucher", entry.id, tripStamp(entry)],
    placeholderData: (prev) => prev,
    queryFn: () => getTripVoucher(session!, entry.id),
    enabled: !!session,
  });
}

export function TripVoucherCard({ entry, editable, inFlow = false }: { entry: EntryDetail; editable: boolean; inFlow?: boolean }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const clock = useHotelClock(60_000);
  const refresh = useRefreshEntry(entry.id);
  const replyAsked = useReplyAsked(entry.id, "CONFIRMATION_VOUCHER");
  const trip = useTripVoucher(entry);
  const held = useHeldDocuments(entry.id).data ?? [];
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [notOpen, setNotOpen] = useState(false);
  const t = trip.data;
  const after = () => {
    void qc.invalidateQueries({ queryKey: ["trip-voucher"] });
    refresh((t?.stays ?? []).flatMap((s) => [["entry", s.entryId], ["entry-communications", s.entryId], ["held-documents", s.entryId]]));
  };
  const notSent = useMutation({
    mutationFn: (id: string) => markTripVoucherNotSent(session!, id, {}),
    onSuccess: (r) => {
      toast.success(`${r.number} is not being sent — each stay's voucher is marked the same`);
      setNotOpen(false);
      after();
    },
    onError: (e) => toastRefusal(e, "That could not be recorded"),
  });
  if (!t || t.stays.length < 2) return null;
  const cur = t.current;
  const ready = !!cur?.upToDate && t.canMake;
  const label = cur ? `The trip's voucher ${cur.number}` : "The trip's voucher";
  const decided = !!cur?.sentAt || !!cur?.notSent;
  const otherHeld = held.filter((h) => h.decision == null && h.kind !== "CONFIRMATION_VOUCHER");
  const summary = cur?.sentAt
    ? `${cur.number} · ${cur.sentChannel === "WHATSAPP" ? "sent on WhatsApp" : "sent"}${cur.answeredAt ? " · the guest's answer recorded" : ""}`
    : cur?.notSent
      ? `${cur.number} · not sent to the guest`
      : undefined;
  const chip = !cur ? (
    <Chip tone="quiet">waits for every stay</Chip>
  ) : cur.sentAt ? (
    <Chip tone="success" icon="check">
      {cur.sentChannel === "WHATSAPP" ? "sent on WhatsApp" : "sent"}
      {cur.answeredAt ? " · answered" : ""}
    </Chip>
  ) : cur.notSent ? (
    <Chip tone="quiet">not sent</Chip>
  ) : (
    <NotSentChip />
  );
  return (
    <StepCard
      flow={inFlow ? "voucher" : undefined}
      title={cur ? `Confirmation voucher · ${cur.number}` : "Confirmation voucher"}
      icon="file"
      right={chip}
      keepRight
      summary={inFlow && !otherHeld.length ? (cur?.answeredAt || cur?.notSent || (cur?.sentAt && !replyAsked) ? summary : undefined) : undefined}
      meta="One voucher for the stays, made by itself once every stay is reserved. It prints no prices. A change to a stay makes it again, as its next version."
    >
      {cur?.sentAt ? (
        <div className="sm">
          Sent {fmtStamp(cur.sentAt)}
          {cur.sentTo ? <span className="meta"> · to {cur.sentTo}</span> : null}
        </div>
      ) : null}
      {!t.canMake && t.reason ? <p className="sm warn-ink" style={{ marginTop: 8 }}>{t.reason}</p> : null}
      <div className="row-acts" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        {cur ? (
          <Button kind="secondary" compact icon="eye" onClick={() => setPaper({ kind: "trip", id: cur.id, label, tripKind: "VOUCHER" })}>
            Preview
          </Button>
        ) : null}
        {editable && ready ? (
          <Button kind={cur?.sentAt ? "secondary" : "primary"} compact icon="send" onClick={() => setSendOpen(true)}>
            {cur?.sentAt ? "Send again" : "Send"}
          </Button>
        ) : null}
        {editable && ready && !decided ? (
          <Button kind="secondary" compact onClick={() => setNotOpen(true)}>
            Don&rsquo;t send
          </Button>
        ) : null}
        {editable && cur?.sentAt && !cur.answeredAt && replyAsked ? (
          <Button className="go" compact onClick={() => setAnswerOpen(true)}>
            Record the guest&rsquo;s answer
          </Button>
        ) : null}
      </div>
      {t.versions.length > 1 ? (
        <p className="meta" style={{ marginTop: 8 }}>
          Earlier: {t.versions.filter((v) => v.state !== "LIVE").map((v) => v.number).join(" · ")}
        </p>
      ) : null}
      {inFlow && otherHeld.length ? (
        <div style={{ marginTop: 12 }}>
          <HeldPapersCard entryId={entry.id} onlyIds={otherHeld.map((h) => h.id)} tz={clock.tz} title="Also made again by the change — send it or not" />
        </div>
      ) : null}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
      {sendOpen && cur ? <TripSendDialog entry={entry} tripId={cur.id} label={label} word="voucher" onClose={() => setSendOpen(false)} onSent={after} /> : null}
      {answerOpen && cur ? <TripAnswerDialog tripId={cur.id} word="voucher" onClose={() => setAnswerOpen(false)} onDone={after} /> : null}
      {notOpen && cur ? (
        <DsDialog
          open
          onClose={() => setNotOpen(false)}
          busy={notSent.isPending}
          title="Don't send the trip's voucher?"
          footer={
            <>
              <Button kind="quiet" onClick={() => setNotOpen(false)}>
                Not now
              </Button>
              <Button state={notSent.isPending ? "working" : "default"} workingLabel="Recording…" onClick={() => notSent.mutate(cur.id)}>
                Don&rsquo;t send it
              </Button>
            </>
          }
        >
          <p className="sm">Each stay&rsquo;s voucher is marked not sent as well. No answer is then needed from the guest.</p>
        </DsDialog>
      ) : null}
    </StepCard>
  );
}
