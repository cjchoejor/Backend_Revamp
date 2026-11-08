"use client";

/**
 * The stays set up the same, in one table at Negotiation (2026-11-09, operator: "user will configure
 * both stays in the same table"). Each stay is its own `useStayTable` — the very state its table has
 * when it is viewed alone, kept under the same stored copies — so what is done in either view is
 * there in the other, and saving prices each stay into its own quotation.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RoomCompositionsTable, type GroupedSection } from "@/components/desk/workspace/room-compositions-table";
import { usePersistedCompositions } from "@/components/desk/workspace/room-compositions-board";
import { TripCompositionsTable } from "@/components/desk/workspace/trip-compositions-table";
import type { RoomCompositionInput, TripPreviewStayInput } from "@/lib/api/quotations";
import { fmtStay, nightsOf, plural } from "@/lib/ds/format";
import { quoteNo } from "@/lib/ds/papers";
import type { EntryDetail, QuotationSummary } from "@/types/api";
import { toastRefusal } from "./kit";
import { QuoteValidityField, useStayTable, type StayTable } from "./s2-stay-table";

type Report = {
  stayNo: number;
  open: boolean;
  unsaved: boolean;
  faults: string[];
  hasQuote: boolean;
  negotiated: boolean;
  input: TripPreviewStayInput;
};

function roomNightMaps(t: StayTable): Pick<TripPreviewStayInput, "roomNights" | "roomNightDates"> {
  const roomNights: Record<string, number> = {};
  const roomNightDates: Record<string, string[]> = {};
  for (const id of t.sealedRoomIds) {
    const ds = t.roomDates[id]?.dates;
    if (ds && ds.length > 0) {
      roomNights[id] = ds.length;
      roomNightDates[id] = ds.map((d) => d.slice(0, 10));
    }
  }
  return Object.keys(roomNights).length ? { roomNights, roomNightDates } : {};
}

const negotiatedIn = (list: readonly RoomCompositionInput[] | undefined) =>
  (list ?? []).some((c) => [c.negotiatedRoomRate, c.negotiatedExtraBedRate, c.negotiatedBreakfastRate, c.negotiatedLunchRate, c.negotiatedDinnerRate].some((v) => v != null));

function StaySection({
  t,
  entry,
  stayNo,
  mine,
  grouped,
  onReport,
  latest,
}: {
  t: StayTable;
  entry: EntryDetail;
  stayNo: number;
  mine: boolean;
  grouped: GroupedSection;
  onReport: (id: string, r: Report) => void;
  latest: React.MutableRefObject<Record<string, StayTable>>;
}) {
  latest.current[entry.id] = t;
  const { snapshotRef, handleChange } = usePersistedCompositions({
    persistKey: entry.id,
    persistBasis: t.persistBasis,
    sealedRoomIds: t.sealedRoomIds,
    initialCompositions: t.seedCompositions,
    onChange: t.setRoomCompositions,
  });
  const report: Report = {
    stayNo,
    open: t.tableOpen,
    unsaved: t.tableOpen && (t.tableUnsaved || t.validTouched),
    faults: t.tableOpen ? t.tableFaults : [],
    hasQuote: !!(t.working ?? t.accepted),
    negotiated: negotiatedIn(snapshotRef.current ?? undefined),
    input: { entryId: entry.id, roomCompositions: t.roomCompositions, discount: t.discountForPreview, ...roomNightMaps(t) },
  };
  const key = JSON.stringify(report);
  useEffect(() => {
    onReport(entry.id, report);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const nights = nightsOf(entry.checkInDate, entry.checkOutDate);
  const ages = entry.childAges ?? [];
  const band = (
    <>
      <b className="nb-date">
        Stay {stayNo} · {fmtStay(entry.checkInDate, entry.checkOutDate)}
      </b>
      <span className="nb-meta">
        {[
          nights ? plural(nights, "night") : null,
          plural(t.sealedRoomIds.length, "room"),
          ages.length ? `children ${ages.join(", ")}` : null,
          entry.id,
          mine ? "this booking" : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </>
  );
  return (
    <RoomCompositionsTable
      grouped={{ ...grouped, band, foot: t.tableOpen ? <QuoteValidityField t={t} /> : null }}
      readOnly={!t.tableOpen}
      bedPlan={t.beds.byRoom}
      onBedChange={t.beds.set}
      bedAsk={t.beds.ask}
      sealedRoomIds={t.sealedRoomIds}
      entryCheckIn={entry.checkInDate ?? null}
      entryCheckOut={entry.checkOutDate ?? null}
      entryAdults={entry.adultCount ?? entry.guestCount ?? null}
      entryChildAges={entry.childAges ?? null}
      roomDates={t.roomDates}
      roomLabels={t.bookingRooms.labels}
      onFaultsChange={t.setTableFaults}
      entryId={entry.id}
      initial={snapshotRef.current ?? []}
      initialCompositions={t.seedCompositions}
      onChange={handleChange}
      discountValue={t.discountValue}
      discountUnit={t.discountUnit}
      onDiscountChange={(patch) => {
        if (patch.value !== undefined) t.setDiscountValue(patch.value);
        if (patch.unit !== undefined) t.setDiscountUnit(patch.unit);
      }}
    />
  );
}

/** Another stay of the group: its own state, here. A parked one may still be set and priced. */
function OtherStaySection(props: Omit<Parameters<typeof StaySection>[0], "t" | "mine">) {
  const t = useStayTable(props.entry, { past: false, allowParked: true });
  return <StaySection {...props} t={t} mine={false} />;
}

export function TripNegotiationTable({
  entry,
  own,
  others,
  stayNoOf,
  onOthersUnsaved,
  onSaved,
}: {
  entry: EntryDetail;
  own: StayTable;
  others: EntryDetail[];
  stayNoOf: (id: string) => number;
  /** The other stays' changes not saved yet, for the step's list. */
  onOthersUnsaved: (items: string[]) => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const latest = useRef<Record<string, StayTable>>({});
  const [reports, setReports] = useState<Record<string, Report>>({});
  const onReport = useRef((id: string, r: Report) => setReports((prev) => ({ ...prev, [id]: r }))).current;
  const stays = useMemo(() => [entry, ...others].sort((a, b) => stayNoOf(a.id) - stayNoOf(b.id)), [entry, others]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = stays.map((s) => reports[s.id]).filter((r): r is Report => !!r);
  const faults = stays.flatMap((s) => (reports[s.id]?.faults ?? []).map((f) => `Stay ${stayNoOf(s.id)} — ${f}`));
  const unsaved = list.some((r) => r.unsaved);
  const anyQuote = list.some((r) => r.hasQuote);
  const openCount = list.filter((r) => r.open).length;
  const whichWord = openCount > 2 ? `all ${openCount} stays` : openCount === 2 ? "both stays" : "the stay";

  const othersKey = others
    .filter((o) => reports[o.id]?.unsaved)
    .map((o) => `Stay ${stayNoOf(o.id)} · table changes saved and quoted`)
    .join("|");
  useEffect(() => {
    onOthersUnsaved(othersKey ? othersKey.split("|") : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [othersKey]);
  useEffect(() => () => onOthersUnsaved([]), []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveM = useMutation({
    mutationFn: async () => {
      const done: Array<{ stayNo: number; q: QuotationSummary }> = [];
      const failed: Array<{ stayNo: number; error: unknown }> = [];
      for (const s of stays) {
        if (!reports[s.id]?.unsaved) continue;
        const stayNo = stayNoOf(s.id);
        try {
          const t = latest.current[s.id];
          done.push({ stayNo, q: await t.save() });
          t.setValidTouched(false);
        } catch (error) {
          failed.push({ stayNo, error });
        }
      }
      return { done, failed };
    },
    onSuccess: ({ done, failed }) => {
      if (done.length) toast.success(`Quoted · ${done.map((d) => `stay ${d.stayNo}: ${quoteNo(d.q)}`).join(" · ")}`, { description: "Nothing was sent." });
      for (const f of failed) toastRefusal(f.error, `Stay ${f.stayNo} could not be quoted`);
      for (const s of stays) void qc.invalidateQueries({ queryKey: ["entry", s.id] });
      void qc.invalidateQueries({ queryKey: ["trip-quotation"] });
      void qc.invalidateQueries({ queryKey: ["quotation-preview"] });
      if (failed.length === 0) onSaved();
    },
  });

  return (
    <TripCompositionsTable
      entryId={entry.id}
      ratesStartOpen={list.some((r) => r.negotiated)}
      priceInputs={list.map((r) => r.input)}
      faults={faults}
      unsaved={unsaved}
      saving={saveM.isPending}
      saveLabel={`Save & quote ${whichWord}${anyQuote ? " again" : ""}`}
      onSave={() => saveM.mutate()}
      allReadOnly={list.length > 0 && openCount === 0}
      stays={stays.map((s) => ({
        key: s.id,
        render: (grouped) =>
          s.id === entry.id ? (
            <Fragment key={s.id}>
              <StaySection t={own} entry={s} stayNo={stayNoOf(s.id)} mine grouped={grouped} onReport={onReport} latest={latest} />
            </Fragment>
          ) : (
            <OtherStaySection key={s.id} entry={s} stayNo={stayNoOf(s.id)} grouped={grouped} onReport={onReport} latest={latest} />
          ),
      }))}
    />
  );
}
