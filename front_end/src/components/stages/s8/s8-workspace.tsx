"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Handshake,
  KeyRound,
  Receipt,
  Scale,
  Search,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { StagePanel } from "@/components/stages/shared/stage-panel";
import { ApiErrorAlert } from "@/components/stages/shared/api-error-alert";
import { ProgressStageButton } from "@/components/stages/shared/progress-stage-button";
import { STAGES, stagePath } from "@/config/stages";
import {
  buildH4FulfilmentEvidence,
  closeDispute,
  fulfilHandoff,
  initiateSettlement,
  issueFinalInvoice,
  postFolioCharge,
  recordKeyReturn,
  recordRoomInspection,
  reEnterS8ToS7,
} from "@/lib/api/checkout";
import { progressDispute } from "@/lib/api/in-stay";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { formatListId } from "@/lib/readable-id";
import { computeFolioLedger, folioOutstandingForDisplay } from "@/lib/folio-ledger";
import type {
  DeficientConditionSummary,
  DisputeSummary,
  EntryDetail,
  FolioLineSummary,
  HandoffSummary,
  InvoiceSummary,
  KeyReturnSummary,
  PaymentRecordSummary,
  RoomAssignmentSummary,
  RoomInspectionSummary,
} from "@/types/api";
import { dispatchInvoice } from "@/lib/api/reservation-setup";

type S8WorkspaceProps = {
  entry: EntryDetail;
};

function isElevated(level: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

function isGm(level: string) {
  return level === "L3" || level === "L4";
}

function folioTerminal(state: string | undefined) {
  return state === "SETTLED" || state === "OUTSTANDING";
}

export function S8Workspace({ entry }: S8WorkspaceProps) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const meta = STAGES[7];

  const reservation = entry.reservation;
  const folio = entry.folio;
  const folioLines = (folio?.lines ?? []) as FolioLineSummary[];
  const folioInvoices = (folio?.invoices ?? []) as InvoiceSummary[];
  const hasFinalInvoice = folioInvoices.some((i) => i.invoiceType === "FINAL");
  const draftFinalInvoice = folioInvoices.find((i) => i.invoiceType === "FINAL" && i.state === "DRAFT");
  const handoffs = (entry.handoffs ?? []) as HandoffSummary[];
  const disputes = (entry.disputes ?? []) as DisputeSummary[];
  const h4 = handoffs.find((h) => h.handoffType === "H4");
  const h5 = handoffs.find((h) => h.handoffType === "H5");
  const assignments = (entry.roomAssignments ?? []) as RoomAssignmentSummary[];
  const latestAssignment = assignments[0];
  const room = latestAssignment?.room;
  const deficientRecords =
    room?.deficientConditionRecords ?? ([] as DeficientConditionSummary[]);
  const activeDeficient = deficientRecords.find(
    (d) => d.status === "UNRESOLVED" || d.status === "DEFICIENT_UNRESOLVED_AT_CHECKOUT",
  );

  const keyReturns = (entry.keyReturnRecords ?? []) as KeyReturnSummary[];
  const latestKeyReturn = keyReturns[0];
  const inspections = (entry.roomInspectionRecords ?? []) as RoomInspectionSummary[];
  const latestInspection = inspections[0];

  const keysIssued = entry.keysIssuedCount ?? 0;

  const [keysReturned, setKeysReturned] = useState(String(keysIssued || 1));
  const [keyReconcileNote, setKeyReconcileNote] = useState("");

  const [inspectionDeferred, setInspectionDeferred] = useState(false);
  const [deficientFlagStatus, setDeficientFlagStatus] = useState<
    "RESOLVED" | "UNRESOLVED_AT_CHECKOUT" | "NOT_APPLICABLE"
  >(activeDeficient ? "UNRESOLVED_AT_CHECKOUT" : "NOT_APPLICABLE");
  const [inspectorAssessment, setInspectorAssessment] = useState("");
  const [damageFound, setDamageFound] = useState(false);
  const [damageNotes, setDamageNotes] = useState("");

  const [settlementMethod, setSettlementMethod] = useState("CASH");
  const [paymentRef, setPaymentRef] = useState("");
  const [partialAmount, setPartialAmount] = useState("");
  const [fomAckRef, setFomAckRef] = useState("");

  const [finalChargeDesc, setFinalChargeDesc] = useState("");
  const [finalChargeAmount, setFinalChargeAmount] = useState("");

  const [reEntryReason, setReEntryReason] = useState("");
  const [disputeCloseReason, setDisputeCloseReason] = useState("");
  const [h4DeficientFlag, setH4DeficientFlag] = useState("RECORDED");

  const [actionError, setActionError] = useState<unknown>(null);

  const folioSettled = folioTerminal(folio?.state);
  const roomDepartedDirty = room?.currentClaimState === "DEPARTED_DIRTY";
  const openDisputes = disputes.filter((d) => d.status === "OPEN" || d.status === "IN_PROGRESS");
  const folioPayments = (folio?.payments ?? []) as PaymentRecordSummary[];
  const folioWriteOffs = folio?.writeOffRecords ?? [];
  const folioLedger = useMemo(
    () => computeFolioLedger(folio, folioLines, folioPayments, folioWriteOffs),
    [folio, folioLines, folioPayments, folioWriteOffs],
  );
  const hasFolioLedgerRows =
    folioLines.length > 0 || folioPayments.length > 0 || folioWriteOffs.length > 0;
  const frozenRate = reservation?.frozenRate != null ? Number(reservation.frozenRate) : null;

  useEffect(() => {
    setDeficientFlagStatus(activeDeficient ? "UNRESOLVED_AT_CHECKOUT" : "NOT_APPLICABLE");
  }, [activeDeficient?.id]);
  const displayOutstanding = folioOutstandingForDisplay(folioLedger, hasFolioLedgerRows);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
  };

  const keyReturnMutation = useMutation({
    mutationFn: () => {
      const n = Number.parseInt(keysReturned, 10);
      if (!Number.isInteger(n) || n < 0) throw new Error("Invalid key count");
      const body: { keyCountReturned: number; reconciliationNote?: string } = { keyCountReturned: n };
      if (n !== keysIssued) body.reconciliationNote = keyReconcileNote.trim();
      return recordKeyReturn(session!, entry.id, body);
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Key return recorded");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Key return failed");
    },
  });

  const inspectionMutation = useMutation({
    mutationFn: () => {
      if (deficientFlagStatus !== "NOT_APPLICABLE" && !activeDeficient?.id) {
        throw new Error(
          "Choose NOT_APPLICABLE when there is no open DEFICIENT flag on the room, or resolve the flag in S7 first.",
        );
      }
      if (
        deficientFlagStatus === "UNRESOLVED_AT_CHECKOUT" &&
        !inspectorAssessment.trim()
      ) {
        throw new Error("Inspector assessment is required for UNRESOLVED_AT_CHECKOUT.");
      }
      return recordRoomInspection(session!, entry.id, {
        isDeferred: inspectionDeferred,
        deficientFlagStatus,
        deficientConditionId:
          deficientFlagStatus !== "NOT_APPLICABLE" ? activeDeficient!.id : undefined,
        inspectorAssessment:
          deficientFlagStatus === "UNRESOLVED_AT_CHECKOUT" ? inspectorAssessment.trim() : undefined,
        damageFound,
        damageNotes: damageFound ? damageNotes.trim() : undefined,
      });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Room inspection recorded");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Inspection failed");
    },
  });

  const settleMutation = useMutation({
    mutationFn: () => {
      if (!folio?.id || !folio.billingModel) throw new Error("Folio or billing model missing");
      const body: Parameters<typeof initiateSettlement>[2] = {
        settlementMethod,
        billingModelConfirmation: folio.billingModel,
      };
      if (paymentRef.trim()) body.paymentVerificationRef = paymentRef.trim();
      const partial = Number.parseFloat(partialAmount);
      if (Number.isFinite(partial) && partial > 0) body.partialAmount = partial;
      if (fomAckRef.trim()) body.fomAcknowledgementRef = fomAckRef.trim();
      return initiateSettlement(session!, folio.id, body);
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Settlement complete — folio closed; room → DEPARTED_DIRTY");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Settlement failed");
    },
  });

  const finalChargeMutation = useMutation({
    mutationFn: () => {
      const amount = Number.parseFloat(finalChargeAmount);
      if (!folio?.id || !Number.isFinite(amount)) throw new Error("Valid amount required");
      return postFolioCharge(session!, folio.id, {
        entryId: entry.id,
        lineType: "F_AND_B",
        description: finalChargeDesc.trim() || "Final morning charge",
        amount,
        chargeDate: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Final charge posted");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Charge failed");
    },
  });

  const fulfilH4Mutation = useMutation({
    mutationFn: () => {
      if (!h4) throw new Error("No H4");
      return fulfilHandoff(session!, h4.id, buildH4FulfilmentEvidence(h4DeficientFlag));
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("H4 fulfilled");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "H4 fulfil failed");
    },
  });

  const reEntryS7Mutation = useMutation({
    mutationFn: () => reEnterS8ToS7(session!, entry.id, entry.version, reEntryReason.trim()),
    onSuccess: () => {
      setActionError(null);
      toast.success("Returned to S7 for additional charges");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Re-entry failed");
    },
  });

  const s8ExitChecks = useMemo(
    () => [
      {
        label: "Folio settled or governed-outstanding",
        ok: folioSettled,
        detail: folio?.state,
      },
      {
        label: "Keys returned (reconciled)",
        ok: !!latestKeyReturn && (latestKeyReturn.countReconciled || !!latestKeyReturn.reconciliationNote),
        detail: latestKeyReturn
          ? `${latestKeyReturn.keyCountReturned}/${latestKeyReturn.keyCountIssued} returned`
          : undefined,
      },
      {
        label: "Room DEPARTED_DIRTY",
        ok: roomDepartedDirty,
        detail: room?.currentClaimState ?? "Settles with folio completion",
      },
      {
        label: "Room inspection recorded or deferred",
        ok: !!latestInspection,
        detail: latestInspection
          ? latestInspection.isDeferred
            ? "Deferred (W9 timer)"
            : latestInspection.deficientFlagStatus
          : undefined,
      },
      {
        label: "H4 fulfilled (pre-checkout)",
        ok: !!h4 && (h4.state === "FULFILLED" || h4.isAutoFulfilled),
        detail: h4 ? h4.state : "From S7",
      },
      {
        label: "No open disputes",
        ok: openDisputes.length === 0,
        detail: openDisputes.length > 0 ? "Close disputes (GM) before S9" : undefined,
      },
      {
        label: "H5 (created on S9 progression)",
        ok: true,
        detail: h5 ? `Already: ${h5.state}` : "Auto-created when progressing to S9",
      },
    ],
    [
      folioSettled,
      folio?.state,
      latestKeyReturn,
      roomDepartedDirty,
      room?.currentClaimState,
      latestInspection,
      h4,
      openDisputes.length,
      h5,
    ],
  );

  const canProgressS9 = s8ExitChecks.filter((c) => c.label !== "H5 (created on S9 progression)").every((c) => c.ok);

  // Stage-mismatch gate removed — ReadOnlyShell handles past/future stage viewing.

  return (
    <StagePanel meta={meta}>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Checkout context</CardTitle>
            <CardDescription>
              SIG-S8 — compile folio, settle, keys, inspection, then closure prep (S9).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Entry:</span>{" "}
              <span className="font-mono">{formatListId(entry.id)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Inquiry:</span>{" "}
              <span className="font-mono">{formatListId(entry.inquiryId)}</span>
            </div>
            {folio && (
              <div>
                <span className="text-muted-foreground">Folio:</span>{" "}
                <span className="font-mono">{formatListId(folio.id)}</span>{" "}
                <StatusBadge status={folio.state} />
              </div>
            )}
            <div className="sm:col-span-2">
              <span className="text-muted-foreground">Outstanding:</span>{" "}
              <strong>
                {folio ? `${folioLedger.currency} ${displayOutstanding.toFixed(2)}` : "—"}
              </strong>
              {folio && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {hasFolioLedgerRows ? (
                    <>
                      Charges {folioLedger.lineTotal.toFixed(2)} − payments in{" "}
                      {folioLedger.paymentsIn.toFixed(2)}
                      {folioLedger.paymentsOut > 0
                        ? ` + refunds ${folioLedger.paymentsOut.toFixed(2)}`
                        : ""}
                      {folioLedger.writeOffTotal > 0
                        ? ` − write-offs ${folioLedger.writeOffTotal.toFixed(2)}`
                        : ""}
                      {folioLedger.storedOutstanding != null &&
                      Math.abs(folioLedger.storedOutstanding - folioLedger.computedOutstanding) >
                        0.01
                        ? ` (folio stored ${folioLedger.storedOutstanding.toFixed(2)})`
                        : ""}
                    </>
                  ) : (
                    <>Folio lines not loaded — refresh the page to see the full ledger.</>
                  )}
                </p>
              )}
            </div>
            {room?.roomNumber && (
              <div>
                <span className="text-muted-foreground">Room:</span> {room.roomNumber}{" "}
                <StatusBadge status={room.currentClaimState ?? room.physicalState ?? "—"} />
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Billing:</span> {folio?.billingModel ?? "—"}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Handshake className="h-4 w-4" />
              H4 pre-checkout handoff
            </CardTitle>
            <CardDescription>Must be fulfilled from S7 — verify HK/F&amp;B returns before presenting bill.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!h4 ? (
              <p className="text-amber-700 dark:text-amber-400">No H4 on record — initiate at S7 before checkout.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{formatListId(h4.id)}</span>
                  <Badge variant="outline">{h4.state}</Badge>
                </div>
                {h4.state !== "FULFILLED" && !h4.isAutoFulfilled && (
                  <div className="space-y-2">
                    <select
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                      value={h4DeficientFlag}
                      onChange={(e) => setH4DeficientFlag(e.target.value)}
                    >
                      <option value="NOT_APPLICABLE">NOT_APPLICABLE</option>
                      <option value="RESOLVED">RESOLVED</option>
                      <option value="UNRESOLVED_AT_CHECKOUT">UNRESOLVED_AT_CHECKOUT</option>
                      <option value="RECORDED">RECORDED</option>
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={fulfilH4Mutation.isPending}
                      onClick={() => fulfilH4Mutation.mutate()}
                    >
                      Fulfil H4
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Receipt className="h-4 w-4" />
              Folio &amp; final charges
            </CardTitle>
            <CardDescription>
              Post final-morning charges before settlement. Lines are immutable. ROOM_CHARGE lines
              labelled &quot;Night audit room charge&quot; were posted at S7 from the frozen nightly
              rate{frozenRate != null && Number.isFinite(frozenRate) ? ` (BTN ${frozenRate})` : ""}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!folioSettled && folio?.state === "LIVE" && (
              <div className="flex flex-wrap gap-2">
                <Input
                  className="max-w-[200px]"
                  placeholder="Description"
                  value={finalChargeDesc}
                  onChange={(e) => setFinalChargeDesc(e.target.value)}
                />
                <Input
                  className="max-w-[100px]"
                  placeholder="Amount"
                  type="number"
                  value={finalChargeAmount}
                  onChange={(e) => setFinalChargeAmount(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={finalChargeMutation.isPending}
                  onClick={() => finalChargeMutation.mutate()}
                >
                  Post final charge
                </Button>
              </div>
            )}

            {folioPayments.length > 0 && (
              <div className="rounded-lg border p-3 text-sm">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Payments on folio</p>
                <ul className="space-y-1">
                  {folioPayments.map((p) => (
                    <li key={p.id} className="flex justify-between gap-2">
                      <span>
                        {p.paymentDirection} · {p.receivedAt?.slice(0, 10) ?? "—"}
                      </span>
                      <span className="font-mono">
                        {p.currency} {String(p.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {folioLines.length > 0 ? (
              <div className="max-h-48 overflow-y-auto rounded-lg border text-sm">
                <table className="w-full">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                      <th className="p-2">Type</th>
                      <th className="p-2">Description</th>
                      <th className="p-2">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {folioLines.map((line) => (
                      <tr key={line.id} className="border-b last:border-0">
                        <td className="p-2">{line.lineType}</td>
                        <td className="p-2">{line.description}</td>
                        <td className="p-2">
                          {line.currency} {String(line.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No folio lines in view. Charges from S7 appear here after a refresh, or advance from S7 again with
                the latest backend.
              </p>
            )}

            {isElevated(session?.actorLevel ?? "L1") && !folioSettled && (
              <div className="rounded-lg border border-dashed p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Additional charge after checkout started (S8→S7)</p>
                <Input
                  placeholder="Reason for re-entry to S7"
                  value={reEntryReason}
                  onChange={(e) => setReEntryReason(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={reEntryS7Mutation.isPending || !reEntryReason.trim()}
                  onClick={() => reEntryS7Mutation.mutate()}
                >
                  Return to S7 to post charges
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="h-4 w-4" />
              Settlement
            </CardTitle>
            <CardDescription>
              Closes folio (SETTLED or OUTSTANDING) and transitions room to DEPARTED_DIRTY in one step.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {folioSettled ? (
              <p className="text-sm text-emerald-700 dark:text-emerald-400">
                Folio is <strong>{folio?.state}</strong>
                {folio?.closedAt && ` · closed ${new Date(folio.closedAt).toLocaleString()}`}
              </p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Settlement method</span>
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={settlementMethod}
                      onChange={(e) => setSettlementMethod(e.target.value)}
                    >
                      <option value="CASH">Cash</option>
                      <option value="MOBILE_PAYMENT">Mobile payment</option>
                      <option value="BANK_TRANSFER">Bank transfer</option>
                      <option value="DIRECT_BILL">Direct bill</option>
                      <option value="VOUCHER">Voucher</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Payment verification ref</span>
                    <Input value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Partial amount (optional)</span>
                    <Input
                      type="number"
                      value={partialAmount}
                      onChange={(e) => setPartialAmount(e.target.value)}
                      placeholder="Remainder → OUTSTANDING"
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">FOM ack ref (if over ceiling)</span>
                    <Input value={fomAckRef} onChange={(e) => setFomAckRef(e.target.value)} />
                  </label>
                </div>
                <Button
                  variant="gradient"
                  disabled={settleMutation.isPending || folio?.state !== "LIVE"}
                  onClick={() => settleMutation.mutate()}
                >
                  {settleMutation.isPending ? "Settling…" : "Initiate settlement"}
                </Button>
              </>
            )}
            {folioSettled && folio?.id && (
              <div className="space-y-2 border-t pt-3">
                {hasFinalInvoice ? (
                  <p className="text-xs text-muted-foreground">
                    Final invoice already on folio
                    {folioInvoices[0]?.state ? ` (${folioInvoices[0].state})` : ""}.
                    {draftFinalInvoice && " Dispatch the DRAFT below before S9."}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Cash / full-payment paths do not auto-create an invoice — issue one here if the guest needs a
                    formal bill.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {!hasFinalInvoice && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        issueFinalInvoice(session!, folio.id, entry.id)
                          .then(() => {
                            toast.success("Final invoice created (DRAFT)");
                            invalidate();
                          })
                          .catch((e) =>
                            toast.error(e instanceof ApiError ? e.message : "Issue invoice failed"),
                          )
                      }
                    >
                      Issue final invoice (DRAFT)
                    </Button>
                  )}
                  {draftFinalInvoice && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        dispatchInvoice(session!, draftFinalInvoice.id)
                          .then(() => {
                            toast.success("Invoice dispatched");
                            invalidate();
                          })
                          .catch((e) =>
                            toast.error(e instanceof ApiError ? e.message : "Dispatch failed"),
                          )
                      }
                    >
                      Dispatch final invoice
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" />
              Key return
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {latestKeyReturn ? (
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <span className="font-mono text-xs">{formatListId(latestKeyReturn.id)}</span>
                <div className="mt-1">
                  Returned {latestKeyReturn.keyCountReturned} of {latestKeyReturn.keyCountIssued}
                  {latestKeyReturn.countReconciled ? (
                    <span className="text-emerald-600"> · reconciled</span>
                  ) : (
                    <span className="text-amber-600"> · note: {latestKeyReturn.reconciliationNote}</span>
                  )}
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">Keys issued at check-in: {keysIssued}</p>
                <div className="flex flex-wrap gap-2">
                  <Input
                    type="number"
                    min={0}
                    className="max-w-[120px]"
                    value={keysReturned}
                    onChange={(e) => setKeysReturned(e.target.value)}
                  />
                  {Number.parseInt(keysReturned, 10) !== keysIssued && (
                    <Input
                      className="min-w-[200px] flex-1"
                      placeholder="Reconciliation note (required if count differs)"
                      value={keyReconcileNote}
                      onChange={(e) => setKeyReconcileNote(e.target.value)}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={keyReturnMutation.isPending}
                    onClick={() => keyReturnMutation.mutate()}
                  >
                    Record key return
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Search className="h-4 w-4" />
              Room inspection
            </CardTitle>
            <CardDescription>
              Mandatory — may defer post-checkout (W9). If the room has an open DEFICIENT flag, you
              must record RESOLVED or UNRESOLVED_AT_CHECKOUT (not NOT_APPLICABLE).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {activeDeficient && !latestInspection && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                Open DEFICIENT on room ({activeDeficient.category}): choose how checkout inspection
                closes this flag.
              </p>
            )}
            {latestInspection ? (
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <span className="font-mono text-xs">{formatListId(latestInspection.id)}</span>
                <div className="mt-1">
                  {latestInspection.isDeferred ? "Deferred" : "Pre-departure"} · DEFICIENT:{" "}
                  {latestInspection.deficientFlagStatus}
                  {latestInspection.damageFound && " · damage noted"}
                </div>
              </div>
            ) : (
              <div className="space-y-3 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={inspectionDeferred}
                    onChange={(e) => setInspectionDeferred(e.target.checked)}
                  />
                  Defer to post-checkout window
                </label>
                <label className="block space-y-1">
                  <span className="text-muted-foreground">DEFICIENT flag at checkout</span>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-3"
                    value={deficientFlagStatus}
                    onChange={(e) =>
                      setDeficientFlagStatus(e.target.value as typeof deficientFlagStatus)
                    }
                  >
                    {!activeDeficient && (
                      <option value="NOT_APPLICABLE">NOT_APPLICABLE — no open DEFICIENT</option>
                    )}
                    {activeDeficient && (
                      <>
                        <option value="RESOLVED">RESOLVED — flag cleared at inspection</option>
                        <option value="UNRESOLVED_AT_CHECKOUT">
                          UNRESOLVED_AT_CHECKOUT — still open at departure
                        </option>
                      </>
                    )}
                  </select>
                </label>
                {deficientFlagStatus === "UNRESOLVED_AT_CHECKOUT" && (
                  <Input
                    placeholder="Inspector assessment (required)"
                    value={inspectorAssessment}
                    onChange={(e) => setInspectorAssessment(e.target.value)}
                  />
                )}
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={damageFound}
                    onChange={(e) => setDamageFound(e.target.checked)}
                  />
                  Damage found
                </label>
                {damageFound && (
                  <Input
                    placeholder="Damage notes"
                    value={damageNotes}
                    onChange={(e) => setDamageNotes(e.target.value)}
                  />
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={inspectionMutation.isPending}
                  onClick={() => inspectionMutation.mutate()}
                >
                  Record inspection
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {disputes.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Scale className="h-4 w-4" />
                Disputes (S8→S9 gate)
              </CardTitle>
              <CardDescription>No override at S9 — disputes must be RESOLVED or CLOSED (GM).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {disputes.map((d) => (
                <div key={d.id} className="rounded border px-3 py-2">
                  <span className="font-mono text-xs">{formatListId(d.id)}</span>{" "}
                  <strong>{d.title}</strong> <StatusBadge status={d.status} />
                  {(d.status === "OPEN" || d.status === "IN_PROGRESS") && isElevated(session?.actorLevel ?? "L1") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-2"
                      onClick={() => progressDispute(session!, d.id, "IN_PROGRESS").then(invalidate)}
                    >
                      Start review
                    </Button>
                  )}
                </div>
              ))}
              {openDisputes.length > 0 && isGm(session?.actorLevel ?? "L1") && (
                <div className="space-y-2">
                  <Input
                    placeholder="Closure reason (GM)"
                    value={disputeCloseReason}
                    onChange={(e) => setDisputeCloseReason(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!disputeCloseReason.trim()}
                    onClick={() => {
                      const d = openDisputes[0];
                      if (!d) return;
                      closeDispute(session!, d.id, disputeCloseReason.trim()).then(() => {
                        toast.success("Dispute closed");
                        setDisputeCloseReason("");
                        invalidate();
                      });
                    }}
                  >
                    Close first open dispute (GM)
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="h-4 w-4" />
              Complete checkout → S9
            </CardTitle>
            <CardDescription>H5 is created automatically when you progress (SETTLED → auto-fulfil; OUTSTANDING → finance handoff).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2">
              {s8ExitChecks.map((check) => (
                <li key={check.label} className="flex items-start gap-2 text-sm">
                  {check.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div>
                    <span>{check.label}</span>
                    {check.detail && (
                      <span className="ml-2 text-xs text-muted-foreground">{check.detail}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <ProgressStageButton
              entryId={entry.id}
              version={entry.version}
              targetStage="S9"
              label="Proceed to settlement & close (S9)"
              disabled={!canProgressS9}
              navigateOnSuccess
            />
          </CardContent>
        </Card>

        <ApiErrorAlert error={actionError} />
      </div>
    </StagePanel>
  );
}
