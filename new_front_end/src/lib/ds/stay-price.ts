"use client";

/**
 * What the stay costs as it stands — saved or not (2026-10-12, operator: "in the charges and
 * payments, why is it not showing any prices yet in S2 — we already have some things selected,
 * show those, and update it whenever changes are made").
 *
 * The billing summary prices a booking only once a quotation is on file, so a booking at Inquiry
 * or at Negotiation before its first quote showed nothing. The steps already price what is on
 * their screens: the Inquiry step's room picks (`price-pick`, rooms only) and the Negotiation
 * table (`quotation-preview`, the quote's own arithmetic). Each step PUBLISHES what it holds —
 * saved or not — and the Charges & payments tab and the header total read it here, so the figure
 * follows every change. Every number still comes from the server; nothing is added up here.
 *
 * In order: the Negotiation table when it differs from the saved quotation, or when there is
 * none; else the saved quotation (the billing summary); else the room picks, or the saved room
 * pick, priced rooms only.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { previewQuotationPricing, type QuotationLivePreview, type RoomCompositionInput } from "@/lib/api/quotations";
import type { EntryBillingSummary } from "@/lib/api/entries";
import type { PickPricing } from "@/lib/api/availability";
import { currentPassConfigs } from "@/lib/desk/workspace";
import { cleanPicks, usePickPricing, type BillNight } from "@/components/ds/steps/s1-bill";
import type { AvailabilityOptionSelected, EntryDetail } from "@/types/api";

export type PriceDraft =
  /** The Inquiry step's rooms, per night — `saved` when they are what is on record. */
  | { kind: "PICKS"; perNight: BillNight[]; saved: boolean }
  /** The Negotiation table — `saved` when it matches the quotation on file. */
  | {
      kind: "TABLE";
      roomCompositions: RoomCompositionInput[];
      discount: { percent?: number | null; amount?: number | null } | null;
      saved: boolean;
    };

const draftKey = (entryId: string) => ["price-draft", entryId] as const;

/** A step says what is on its screen. Only a step the booking is AT publishes (not a past one). */
export function usePublishPriceDraft(entryId: string, draft: PriceDraft | null) {
  const qc = useQueryClient();
  const key = draft ? JSON.stringify(draft) : "";
  useEffect(() => {
    if (!draft) return;
    // Typing in the table is priced once it settles, as the table's own total is.
    const t = setTimeout(() => qc.setQueryData(draftKey(entryId), draft), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, entryId, key]);
}

function usePriceDraft(entryId: string): PriceDraft | null {
  const q = useQuery<PriceDraft | null>({
    queryKey: draftKey(entryId),
    queryFn: async () => null,
    enabled: false,
    staleTime: Infinity,
  });
  return q.data ?? null;
}

/** The room pick on record for this pass, as nights — what Inquiry saved. */
export function savedPickNights(entry: EntryDetail): BillNight[] {
  const sealed = currentPassConfigs(entry).find((c) => c.optionSelected != null && !c.isStale) ?? currentPassConfigs(entry).find((c) => c.optionSelected != null);
  const opt = (sealed?.optionSelected ?? null) as AvailabilityOptionSelected | null;
  if (!opt) return [];
  if ("perNight" in opt && Array.isArray(opt.perNight)) {
    return opt.perNight.map((n) => ({ date: n.date.slice(0, 10), roomIds: n.roomIds.map((r) => r.roomId) }));
  }
  const ids = "roomIds" in opt && Array.isArray(opt.roomIds) ? opt.roomIds.map((r) => r.roomId) : "roomId" in opt ? [opt.roomId] : [];
  const out: BillNight[] = [];
  if (!entry.checkInDate || !entry.checkOutDate || !ids.length) return out;
  const end = new Date(`${entry.checkOutDate.slice(0, 10)}T00:00:00Z`).getTime();
  for (let t = new Date(`${entry.checkInDate.slice(0, 10)}T00:00:00Z`).getTime(), i = 0; t < end && i < 366; t += 86_400_000, i++) {
    out.push({ date: new Date(t).toISOString().slice(0, 10), roomIds: ids });
  }
  return out;
}

export type StayPrice = {
  /** Where the figure came from. */
  source: "TABLE" | "QUOTE" | "PICKS" | null;
  amount: number | null;
  currency: string;
  /** The words beside the figure. */
  kind: string;
  /** True when what is shown is not on record yet. */
  unsaved: boolean;
  /** The quotation on file, when the table shown differs from it. */
  savedQuoteAmount: number | null;
  preview: QuotationLivePreview | null;
  pick: PickPricing | null;
  loading: boolean;
};

export function useStayPrice(entry: EntryDetail | null, billing: EntryBillingSummary | null): StayPrice {
  const { session } = useSession();
  const entryId = entry?.id ?? "";
  const draft = usePriceDraft(entryId);
  const live = !!entry && (entry.status === "ACTIVE" || entry.status === "PARKED");
  const quoteAmount = billing?.stayTotal?.amount ?? null;
  const currency = billing?.currency ?? "BTN";

  // A draft counts only while the booking is at the step that published it.
  const table = live && entry?.currentStage === "S2" && draft?.kind === "TABLE" && draft.roomCompositions.length > 0 ? draft : null;
  const useTable = !!table && (!table.saved || quoteAmount == null);
  const preview = useQuery({
    queryKey: ["stay-price-preview", entryId, table ? JSON.stringify([table.roomCompositions, table.discount]) : ""],
    queryFn: () => previewQuotationPricing(session!, entryId, { roomCompositions: table!.roomCompositions, discount: table!.discount }),
    enabled: !!session && useTable,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  const picksDraft = live && entry?.currentStage === "S1" && draft?.kind === "PICKS" && cleanPicks(draft.perNight).length > 0 ? draft : null;
  const atInquiryOrNegotiation = live && (entry?.currentStage === "S1" || entry?.currentStage === "S2");
  const pickNights = entry && !useTable && quoteAmount == null && atInquiryOrNegotiation ? (picksDraft?.perNight ?? savedPickNights(entry)) : [];
  const pick = usePickPricing(entryId, pickNights, pickNights.length > 0);

  if (useTable) {
    const p = preview.data ?? null;
    return {
      source: "TABLE",
      amount: p?.payable ?? null,
      currency: p?.currency ?? currency,
      kind: table!.saved ? "as on the negotiation table" : quoteAmount != null ? "as on the table now · not saved yet" : "as on the negotiation table · not priced into a quotation yet",
      unsaved: !table!.saved,
      savedQuoteAmount: !table!.saved ? quoteAmount : null,
      preview: p,
      pick: null,
      loading: preview.isFetching,
    };
  }
  if (quoteAmount != null) {
    return { source: "QUOTE", amount: quoteAmount, currency, kind: "", unsaved: false, savedQuoteAmount: null, preview: null, pick: null, loading: false };
  }
  if (pick.pricing) {
    const unsaved = !!picksDraft && !picksDraft.saved;
    return {
      source: "PICKS",
      amount: pick.pricing.totals.total,
      currency: pick.pricing.currency ?? currency,
      kind: `rooms only${unsaved ? " · picked, not saved yet" : ", as picked"} — meals and extras are added at Negotiation`,
      unsaved,
      savedQuoteAmount: null,
      preview: null,
      pick: pick.pricing,
      loading: pick.loading,
    };
  }
  return { source: null, amount: null, currency, kind: "", unsaved: false, savedQuoteAmount: null, preview: null, pick: null, loading: pick.loading || preview.isFetching };
}
