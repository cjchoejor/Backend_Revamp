"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { StayDates } from "@/components/ds/stay-dates";
import { getEntry } from "@/lib/api/entries";
import type { EntryDetail } from "@/types/api";
import { Choice, PapersCard } from "@/components/ds/steps/kit";
import { useTripView } from "@/components/ds/steps/s2-together";
import { TripQuotationCard } from "@/components/ds/steps/s2-trip-quotation";
import { TripProformaCard } from "@/components/ds/steps/s3-trip-proforma";
import { TripVoucherCard } from "@/components/ds/steps/s4-trip-voucher";

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

/**
 * A trip's papers in the booking file (2026-11-09, operator: "on the right panel, it can both together
 * and separate stays quote, do it for all the papers. keep options to view like that"). Together is
 * the trip's own paper; Stay by stay is each stay's papers, with every version. It opens the way the
 * booking head is viewing the stays.
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
  const { stays, stayNoOf } = useTripStays(entry);
  const [head] = useTripView(entry.inquiry?.id);
  const [pick, setPick] = useState<"TOGETHER" | "EACH" | null>(null);
  useEffect(() => setPick(null), [head]);
  const view = pick ?? (head === "together" ? "TOGETHER" : "EACH");
  const editable = !sealed;
  let together: ReactNode;
  if (show === "quotes") together = <TripQuotationCard entry={entry} editable={editable} />;
  else if (show === "proformas") together = <TripProformaCard entry={entry} editable={editable} />;
  else together = <TripVoucherCard entry={entry} editable={editable} />;
  return (
    <>
      <div className="trip-bill-switch">
        <Choice options={[["TOGETHER", "Together"], ["EACH", "Stay by stay"]] as const} value={view} onChange={setPick} />
      </div>
      {view === "TOGETHER"
        ? together
        : stays.filter(has).map((s) => (
            <div key={s.id} className="trip-stay-block">
              <StayBand stay={s} stayNo={stayNoOf(s.id)} />
              <PapersCard entry={s} show={show} title={title} withFolioDocs={false} />
            </div>
          ))}
    </>
  );
}
