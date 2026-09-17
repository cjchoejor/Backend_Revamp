"use client";

/**
 * What Check-out and Closed share: the words for the bill's states, the reads both steps make
 * (the billing summary, the folio documents index, who booked), the bill set out by part, the
 * disputes table, and the one act that issues a tax invoice and sends it.
 *
 * Every figure here is read from the backend. Nothing is added, multiplied or netted on the desk;
 * a figure the backend does not send reads "—".
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { closeDispute, issueFinalInvoice } from "@/lib/api/checkout";
import { progressDispute } from "@/lib/api/in-stay";
import { dispatchInvoice } from "@/lib/api/reservation-setup";
import { getFolioDocuments } from "@/lib/api/documents";
import { getBillingSummary, type EntryBillingSummary } from "@/lib/api/entries";
import { getInquiry } from "@/lib/api/inquiries";
import { guestName } from "@/lib/desk/model";
import { channelWord } from "@/lib/ds/status";
import { refusalText } from "@/lib/ds/translate";
import { fmtStamp } from "@/lib/ds/format";
import type { DisputeSummary, EntryDetail } from "@/types/api";
import { Live, ReasonDialog, StepCard, atLeast, toastRefusal, useRefreshEntry, words } from "./kit";

/* ------------------------------------------------------------------ words */

export const FOLIO_STATE_WORD: Record<string, string> = {
  PROVISIONAL: "provisional",
  LIVE: "live",
  SETTLED: "settled",
  OUTSTANDING: "still owed",
  WRITTEN_OFF: "written off",
  NO_SHOW_CLOSED: "closed as a no-show",
  CLOSED: "closed",
};

/** A tax invoice is issued as a DRAFT row and becomes DISPATCHED when it goes out. */
export const INVOICE_STATE_WORD: Record<string, string> = {
  DRAFT: "issued · not sent",
  DISPATCHED: "sent",
  PAYMENT_TRACKED: "payment recorded",
  RECONCILED: "reconciled",
  SUPERSEDED: "replaced",
  LAPSED: "lapsed",
};

export const INVOICE_TYPE_WORD: Record<string, string> = {
  PROFORMA: "proforma",
  FINAL: "tax invoice",
  INTERIM: "interim bill",
  ADVANCE: "advance invoice",
};

export const BILLING_MODEL_WORD: Record<string, string> = {
  GUEST_PAY: "the guest pays",
  DIRECT_BILL: "billed to the company",
  TOUR_OPERATOR_VOUCHER: "the agent's voucher",
  GOVERNMENT: "billed to the government",
  OTA_PREPAID: "prepaid through the OTA",
  SPLIT: "split between the account and the guest",
};

export const HANDOFF_STATE_WORD: Record<string, string> = {
  CREATED: "raised",
  ASSIGNED: "assigned",
  ACCEPTED: "accepted",
  FULFILLED: "done",
  CLOSED: "closed",
  REJECTED: "turned back",
  CANCELLED: "cancelled",
};

export const DISPUTE_WORD: Record<string, string> = {
  OPEN: "open",
  IN_PROGRESS: "under review",
  REOPENED: "reopened",
  RESOLVED: "resolved",
  CLOSED: "closed",
};

export const DEFICIENCY_WORD: Record<string, string> = {
  NOT_APPLICABLE: "no fault on the room",
  RESOLVED: "the fault was put right",
  UNRESOLVED_AT_CHECKOUT: "the fault is still there",
  RECORDED: "the fault is recorded",
};

/** The billing models where the guest pays nothing at the desk — the account is invoiced. */
export const ON_ACCOUNT_MODELS = new Set(["DIRECT_BILL", "TOUR_OPERATOR_VOUCHER", "GOVERNMENT"]);

export function isOpenDispute(d: DisputeSummary) {
  return d.status === "OPEN" || d.status === "IN_PROGRESS" || d.status === "REOPENED";
}

/** A figure for a table cell — the currency is in the column head. Formats only. */
export function fig(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `– ${s}` : s;
}

/** The night before a stored check-out date — calendar arithmetic on a stay date, not money. */
export function lastStayNight(checkOutIso: string | null | undefined): string | null {
  const m = checkOutIso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(checkOutIso) : null;
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1)).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ the reads */

/** The server-summed money on this booking — the same query key the workspace header uses. */
export function useBilling(entry: EntryDetail) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["billing-summary", entry.id, entry.updatedAt],
    queryFn: () => getBillingSummary(session!, entry.id),
    enabled: !!session,
    refetchInterval: 30_000,
  });
}

/** A key that moves whenever the ledger does — a posting, a payment, the seal, an issued invoice. */
export function ledgerKey(entry: EntryDetail): string {
  const f = entry.folio;
  return [
    entry.currentStage,
    f?.state ?? "",
    f?.lines?.length ?? 0,
    String(f?.outstandingBalance ?? ""),
    f?.payments?.length ?? 0,
    (f?.invoices ?? []).map((i) => `${i.id}:${i.state}`).join(","),
  ].join("|");
}

/** Which folio documents exist, in which state and why — the backend decides, the desk prints it. */
export function useFolioIndex(entry: EntryDetail) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["folio-documents", entry.id, ledgerKey(entry)],
    queryFn: () => getFolioDocuments(session!, entry.id),
    enabled: !!session && !!entry.folio,
  });
}

type InquiryParty = {
  travelAgent?: { displayName?: string | null } | null;
  corporateAccount?: { displayName?: string | null } | null;
};

/** Who booked and who the invoice is made out to (the agency or company when one booked). */
export function useBookedBy(entry: EntryDetail) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["inquiry", entry.inquiryId],
    queryFn: () => getInquiry(session!, entry.inquiryId),
    enabled: !!session && !!entry.inquiryId,
  });
  const rec = (q.data ?? null) as InquiryParty | null;
  const party = rec?.travelAgent?.displayName ?? rec?.corporateAccount?.displayName ?? null;
  const kind = rec?.travelAgent ? "Travel agent" : rec?.corporateAccount ? "Company" : channelWord(entry.inquiry?.sourceChannel);
  const g = guestName(entry.guestProfile ?? entry.inquiry?.guestProfile ?? null);
  const guest = g === "Guest" ? "the guest" : g;
  return { party, kind, guest, payer: party ?? guest };
}

/* ------------------------------------------------------------------ the tax invoice, issued and sent */

/**
 * Issue a tax invoice and send it in the same act (ruling Z5 — no invoice may exist undispatched).
 * The backend has two calls for this (BE-71 asks for one); the desk makes both. If the send fails
 * after the issue, the invoice stands and its row offers "Send" again.
 */
export function useIssueAndSend(entry: EntryDetail, templateKey?: string) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  return useMutation({
    mutationFn: async () => {
      if (!entry.folio) throw new Error("There is no bill on this booking");
      const inv = (await issueFinalInvoice(session!, entry.folio.id, entry.id, templateKey)) as { id?: string; invoiceNumber?: string | null } | null;
      if (!inv?.id) return { sent: false, number: null as string | null, error: null as unknown };
      const number = inv.invoiceNumber ?? inv.id;
      try {
        await dispatchInvoice(session!, inv.id);
        return { sent: true, number, error: null as unknown };
      } catch (error) {
        return { sent: false, number, error };
      }
    },
    onSuccess: (r) => {
      if (r.sent) toast.success(`Tax invoice ${r.number} issued and sent`);
      else if (r.error) toast.error(`Tax invoice ${r.number} is issued but did not go out — ${refusalText(r.error)}`, { description: "Send it again from its row.", duration: 9000 });
      else toast.warning("The tax invoice is issued — send it from its row");
      refresh([["settlement-targets"]]);
    },
    onError: (e) => toastRefusal(e, "The tax invoice could not be issued"),
  });
}

/** Send an issued invoice that has not gone out yet. */
export function useSendInvoice(entry: EntryDetail) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  return useMutation({
    mutationFn: (invoiceId: string) => dispatchInvoice(session!, invoiceId),
    onSuccess: () => {
      toast.success("Sent — the guest's answer is awaited");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The invoice could not be sent"),
  });
}

/* ------------------------------------------------------------------ the bill by part */

type PartRow = { key: string; label: string; lines: number; base: number; sc: number; gst: number; total: number };

/**
 * The bill set out by what it was for — each room, each space, and the lines naming neither —
 * with the total underneath. The buckets and the total are the billing summary's own figures.
 */
export function BillByPart({ billing, loading, totalOnly }: { billing: EntryBillingSummary | null | undefined; loading?: boolean; totalOnly?: boolean }) {
  const fo = billing?.folio ?? null;
  if (!billing) return <p className="meta">{loading ? "Reading the bill…" : "The bill could not be read."}</p>;
  if (!fo || !fo.chargeBreakdown) return <p className="meta">Nothing has been posted to this bill.</p>;
  const cb = fo.chargeBreakdown;
  const rows: PartRow[] = [
    ...(fo.perRoomCharges ?? []).map((b) => ({ key: `r:${b.roomId}`, label: `Room ${b.roomNumber ?? "—"}`, lines: b.lineCount, base: b.base, sc: b.serviceCharge, gst: b.gst, total: b.charges })),
    ...(fo.perSpaceCharges ?? []).map((b) => ({ key: `s:${b.spaceId}`, label: b.spaceName ?? "A space", lines: b.lineCount, base: b.base, sc: b.serviceCharge, gst: b.gst, total: b.charges })),
    ...(fo.unassignedCharges
      ? [
          {
            key: "none",
            label: "No room / space",
            lines: fo.unassignedCharges.lineCount,
            base: fo.unassignedCharges.base,
            sc: fo.unassignedCharges.serviceCharge,
            gst: fo.unassignedCharges.gst,
            total: fo.unassignedCharges.charges,
          },
        ]
      : []),
  ];
  const cur = billing.currency && billing.currency !== "BTN" ? billing.currency : "Nu.";
  return (
    <table className="table compact">
      <thead>
        <tr>
          <th>Part of the bill</th>
          {totalOnly ? null : (
            <>
              <th className="num">Lines</th>
              <th className="num">Net · {cur}</th>
              <th className="num">Service charge</th>
              <th className="num">GST</th>
            </>
          )}
          <th className="num">Incl. SC &amp; GST{totalOnly ? ` · ${cur}` : ""}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="static">
            <td>{r.label}</td>
            {totalOnly ? null : (
              <>
                <td className="num">{r.lines}</td>
                <td className="num money">{fig(r.base)}</td>
                <td className="num money">{fig(r.sc)}</td>
                <td className="num money">{fig(r.gst)}</td>
              </>
            )}
            <td className="num money">{fig(r.total)}</td>
          </tr>
        ))}
        <tr className="static">
          <td>
            <b>Total</b>
          </td>
          {totalOnly ? null : (
            <>
              <td className="num">{fo.lineCount}</td>
              <td className="num money">
                <b>{fig(cb.base)}</b>
              </td>
              <td className="num money">
                <b>{fig(cb.serviceCharge)}</b>
              </td>
              <td className="num money">
                <b>{fig(cb.gst)}</b>
              </td>
            </>
          )}
          <td className="num money">
            <b>{fig(cb.total)}</b>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ disputes */

/**
 * What the guest queried, what they said, and where it stands. An open dispute keeps the booking
 * from moving on (no override) — the FOM takes it under review, the GM closes it with a reason.
 */
export function DisputesCard({ entry, tz }: { entry: EntryDetail; tz: string }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const disputes = entry.disputes ?? [];
  const fom = atLeast(session?.actorLevel, "L2");
  const gm = atLeast(session?.actorLevel, "L3");
  const [closing, setClosing] = useState<DisputeSummary | null>(null);
  const review = useMutation({
    mutationFn: (id: string) => progressDispute(session!, id, "IN_PROGRESS"),
    onSuccess: () => {
      toast.success("The dispute is under review");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The dispute could not be taken under review"),
  });
  const close = useMutation({
    mutationFn: (v: { id: string; reason: string }) => closeDispute(session!, v.id, v.reason),
    onSuccess: () => {
      toast.success("The dispute is closed");
      setClosing(null);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The dispute could not be closed"),
  });
  if (disputes.length === 0) return null;
  const open = disputes.filter(isOpenDispute);
  return (
    <StepCard
      title="Disputes"
      meta={
        open.length
          ? `${open.length} still open — the booking cannot move on until every dispute is answered, and there is no override.`
          : "Every dispute is answered."
      }
    >
      <table className="table compact">
        <thead>
          <tr>
            <th>What was queried</th>
            <th>The guest says</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {disputes.map((d) => {
            const isOpen = isOpenDispute(d);
            return (
              <tr key={d.id} className="static">
                <td>
                  {d.title}
                  <div className="meta">
                    {d.id} · raised {fmtStamp(d.openedAt, tz)}
                  </div>
                </td>
                <td>{d.description ? d.description : <span className="dash">—</span>}</td>
                <td>
                  <Chip tone={isOpen ? "warning" : "success"}>{DISPUTE_WORD[d.status] ?? words(d.status)}</Chip>
                </td>
                <td className="num">
                  <Live>
                    <div className="row-acts" style={{ justifyContent: "flex-end" }}>
                      {d.status === "OPEN" || d.status === "REOPENED" ? (
                        <Button
                          kind="quiet"
                          compact
                          state={review.isPending ? "working" : fom ? "default" : "inert"}
                          title={fom ? undefined : "Taking a dispute under review needs the FOM"}
                          onClick={() => review.mutate(d.id)}
                        >
                          Start review
                        </Button>
                      ) : null}
                      {isOpen ? (
                        <Button
                          kind="secondary"
                          compact
                          state={gm ? "default" : "inert"}
                          title={gm ? undefined : "Closing a dispute is the GM's"}
                          onClick={() => setClosing(d)}
                        >
                          Close…
                        </Button>
                      ) : null}
                    </div>
                  </Live>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ReasonDialog
        open={!!closing}
        onClose={() => setClosing(null)}
        title="Close the dispute"
        caseLines={closing ? [<b key="t">{closing.title}</b>, closing.id] : undefined}
        lead="The GM's answer to the guest's query. It is recorded with your name; the dispute no longer holds the booking."
        reasonLabel="The answer · recorded on the dispute"
        placeholder="credited in full — only three pieces were sent"
        confirmLabel="Close the dispute"
        busy={close.isPending}
        onConfirm={(reason) => closing && close.mutate({ id: closing.id, reason })}
      />
    </StepCard>
  );
}
