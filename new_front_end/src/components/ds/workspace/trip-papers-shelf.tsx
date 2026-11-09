"use client";

import { useEffect, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { StayDates } from "@/components/ds/stay-dates";
import { getEntry } from "@/lib/api/entries";
import type { EntryDetail } from "@/types/api";
import { fmtStamp } from "@/lib/ds/format";
import { getTripProforma, getTripQuotation, getTripVoucher } from "@/lib/api/trip-papers";
import { Choice, Live, NotSentChip, PaperDrawer, PapersCard, StepCard, useRefreshEntry, useReplyAsked, type PaperRef } from "@/components/ds/steps/kit";
import { useStaysTogether } from "@/components/ds/steps/s2-together";
import { TripAnswerDialog, TripSendDialog } from "@/components/ds/steps/s2-trip-quotation";

/** Every stay of this booking's trip, read in full, in the order the trip has them. */
export function useTripStays(entry: EntryDetail) {
  const { session } = useSession();
  const all = entry.inquiry?.entries ?? [];
  const others = all.filter((s) => s.id !== entry.id);
  const reads = useQueries({
    queries: others.map((s) => ({ queryKey: ["entry", s.id], queryFn: () => getEntry(session!, s.id), enabled: !!session, refetchInterval: 30_000 })),
  });
  const stayNoOf = (id: string) => all.findIndex((s) => s.id === id) + 1;
  const stays = [entry, ...reads.map((r) => r.data).filter((x): x is EntryDetail => !!x)].sort((a, b) => stayNoOf(a.id) - stayNoOf(b.id));
  return { isTrip: all.length > 1, stays, stayNoOf };
}

export function StayBand({ stay, stayNo }: { stay: EntryDetail; stayNo: number }) {
  return (
    <div className="trip-stay-band">
      <span>
        <span className="trip-stay-name">Stay {stayNo}</span> <span className="meta">{stay.id}</span>
      </span>
      <StayDates checkIn={stay.checkInDate} checkOut={stay.checkOutDate} />
    </div>
  );
}

export type TripPaperKind = "quotes" | "proformas" | "others";

const KINDS = {
  quotes: { key: "trip-quotation", get: getTripQuotation, word: "quotation", tripKind: "QUOTATION", comm: "QUOTATION" },
  proformas: { key: "trip-proforma", get: getTripProforma, word: "proforma", tripKind: "PROFORMA", comm: "PROFORMA_INVOICE" },
  others: { key: "trip-voucher", get: getTripVoucher, word: "voucher", tripKind: "VOUCHER", comm: "CONFIRMATION_VOUCHER" },
} as const;

type TripPaperRead = {
  stays: Array<{ entryId: string }>;
  canMake: boolean;
  reason: string | null;
  current: { id: string; number: string; upToDate: boolean; answeredAt: string | null } | null;
  versions: Array<{ id: string; number: string; state: string; createdAt: string; sentAt: string | null }>;
};

/** The trip's paper in the file, a row for each version, as a stay's own papers are listed (2026-11-09). */
function TripPaperRows({ entry, show, title, sealed }: { entry: EntryDetail; show: TripPaperKind; title: string; sealed: boolean }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const K = KINDS[show];
  const replyAsked = useReplyAsked(entry.id, K.comm);
  const q = useQuery({
    queryKey: [K.key, entry.id, entry.updatedAt ?? ""],
    queryFn: (): Promise<TripPaperRead> => K.get(session!, entry.id),
    enabled: !!session,
  });
  const [open, setOpen] = useState<PaperRef | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false);
  const t = q.data;
  if (!t || t.stays.length < 2) return null;
  const cur = t.current;
  const after = () => {
    void qc.invalidateQueries({ queryKey: [K.key] });
    refresh(t.stays.flatMap((s) => [["entry", s.entryId], ["entry-communications", s.entryId], ["held-documents", s.entryId]]));
  };
  const label = cur ? `The trip's ${K.word} ${cur.number}` : `The trip's ${K.word}`;
  const canSend = !sealed && !!cur?.upToDate && t.canMake;
  return (
    <StepCard title={title}>
      {t.versions.length === 0 && t.reason ? <span className="sm">{t.reason}</span> : null}
      <div className="papergrp">
        {t.versions.map((v) => {
          const live = v.state === "LIVE";
          return (
            <div className="paperrow" key={v.id}>
              <span className="nm">
                <b>{v.number}</b>
              </span>
              {!live ? <Chip tone="quiet">replaced</Chip> : v.sentAt ? <Chip tone="success">sent</Chip> : <NotSentChip />}
              <span className="when">{v.sentAt ? `sent ${fmtStamp(v.sentAt)}` : fmtStamp(v.createdAt)}</span>
              <span className="acts">
                <Button kind="quiet" compact icon="eye" onClick={() => setOpen({ kind: "trip", id: v.id, label: `The trip's ${K.word} ${v.number}`, tripKind: K.tripKind })}>
                  Preview
                </Button>
                {live && canSend ? (
                  <Live>
                    <Button kind="quiet" compact icon="send" onClick={() => setSendOpen(true)}>
                      {v.sentAt ? "Send again" : "Send"}
                    </Button>
                  </Live>
                ) : null}
                {live && !sealed && v.sentAt && !cur?.answeredAt && replyAsked ? (
                  <Live>
                    <Button kind="quiet" compact onClick={() => setAnswerOpen(true)}>
                      Record the answer
                    </Button>
                  </Live>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      <PaperDrawer paper={open} onClose={() => setOpen(null)} />
      {sendOpen && cur ? <TripSendDialog entry={entry} tripId={cur.id} label={label} word={K.word} onClose={() => setSendOpen(false)} onSent={after} /> : null}
      {answerOpen && cur ? <TripAnswerDialog tripId={cur.id} word={K.word} onClose={() => setAnswerOpen(false)} onDone={after} /> : null}
    </StepCard>
  );
}

/**
 * A trip's papers in the booking file (2026-11-09, operator: "on the right panel, it can both together
 * and separate stays quote, do it for all the papers. keep options to view like that"). Together is
 * the trip's own paper; Stay by stay is each stay's papers, with every version. On one stay's own
 * page the file lists that stay's papers alone (same day, operator: "i am in stay one but it is
 * showing stay 2s proforma"), with the trip's paper a click away when there is one.
 */
export function TripPapersShelf({
  entry,
  show,
  title,
  sealed,
  has,
}: {
  entry: EntryDetail;
  show: TripPaperKind;
  title: string;
  sealed: boolean;
  /** Whether a stay has any paper of this kind. */
  has: (stay: EntryDetail) => boolean;
}) {
  const { session } = useSession();
  const { stays, stayNoOf } = useTripStays(entry);
  const together = useStaysTogether(entry);
  const K = KINDS[show];
  const tripPaper = useQuery({
    queryKey: [K.key, entry.id, entry.updatedAt ?? ""],
    queryFn: (): Promise<TripPaperRead> => K.get(session!, entry.id),
    enabled: !!session,
  }).data;
  const [pick, setPick] = useState<"TOGETHER" | "EACH" | "OWN" | null>(null);
  useEffect(() => setPick(null), [together.active]);
  const view = pick ?? (together.active ? "TOGETHER" : "OWN");
  const options = together.active
    ? ([["TOGETHER", "Together"], ["EACH", "Stay by stay"]] as const)
    : ([["OWN", "This stay"], ["TOGETHER", "The trip's"]] as const);
  const showSwitch = together.active || (tripPaper?.versions.length ?? 0) > 0;
  return (
    <>
      {showSwitch ? (
        <div className="trip-bill-switch">
          <Choice options={options} value={view} onChange={setPick} />
        </div>
      ) : null}
      {view === "TOGETHER" ? (
        <TripPaperRows entry={entry} show={show} title={title} sealed={sealed} />
      ) : view === "OWN" ? (
        <PapersCard entry={entry} show={show} title={title} withFolioDocs={false} />
      ) : (
        stays
          .filter((s) => together.stayIds.includes(s.id) && has(s))
          .map((s) => (
            <div key={s.id} className="trip-stay-block">
              <StayBand stay={s} stayNo={stayNoOf(s.id)} />
              <PapersCard entry={s} show={show} title={title} withFolioDocs={false} />
            </div>
          ))
      )}
    </>
  );
}
