"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowRight,
  Banknote,
  CheckCircle2,
  Circle,
  FileText,
  Handshake,
  Lock,
  Receipt,
  Scale,
  Search,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { StagePanel } from "@/components/stages/shared/stage-panel";
import { ApiErrorAlert } from "@/components/stages/shared/api-error-alert";
import { STAGES, stagePath } from "@/config/stages";
import {
  closeDispute,
  closeEntryAtS9,
  expirePostCheckoutInspectionWindow,
  dispatchInvoice,
  fulfilHandoff,
  issueFolioInvoice,
  postCreditNote,
  postStayCharge,
  recordInvoicePaymentEvent,
  writeOffOutstanding,
} from "@/lib/api/post-stay";
import { progressDispute } from "@/lib/api/in-stay";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { formatListId } from "@/lib/readable-id";
import { computeFolioLedger, folioOutstandingForDisplay } from "@/lib/folio-ledger";
import type {
  CommissionDueSummary,
  DisputeSummary,
  EntryDetail,
  FolioLineSummary,
  FollowUpTaskSummary,
  HandoffSummary,
  InvoiceSummary,
  PaymentRecordSummary,
  RoomInspectionSummary,
} from "@/types/api";

type S9WorkspaceProps = {
  entry: EntryDetail;
};

function isElevated(level: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

function isGm(level: string) {
  return level === "L3" || level === "L4";
}

function h5Blocking(h5: HandoffSummary | undefined) {
  if (!h5) return false;
  return ["CREATED", "ASSIGNED", "ACCEPTED"].includes(h5.state);
}

function inspectionBlocksClosure(inspections: RoomInspectionSummary[]) {
  const latest = inspections[0];
  if (!latest) return true;
  if (!latest.isDeferred) return false;
  const completed = inspections.some((i) => !i.isDeferred);
  return !completed;
}

export function S9Workspace({ entry }: S9WorkspaceProps) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const meta = STAGES[8];

  const isClosed = entry.status === "CLOSED";
  const folio = entry.folio;
  const folioLines = (folio?.lines ?? []) as FolioLineSummary[];
  const folioPayments = (folio?.payments ?? []) as PaymentRecordSummary[];
  const folioWriteOffs = folio?.writeOffRecords ?? [];
  const invoices = (folio?.invoices ?? []) as InvoiceSummary[];
  const handoffs = (entry.handoffs ?? []) as HandoffSummary[];
  const disputes = (entry.disputes ?? []) as DisputeSummary[];
  const inspections = (entry.roomInspectionRecords ?? []) as RoomInspectionSummary[];
  const h5 = handoffs.find((h) => h.handoffType === "H5");
  const commissionRecords = (entry.commissionDueRecords ?? []) as CommissionDueSummary[];
  const followUpTasks = (entry.followUpTasks ?? []) as FollowUpTaskSummary[];

  const openDisputes = disputes.filter(
    (d) => d.status === "OPEN" || d.status === "IN_PROGRESS" || d.status === "REOPENED",
  );
  const draftInvoices = invoices.filter((i) => i.state === "DRAFT");
  const isNoShow = folio?.state === "NO_SHOW_CLOSED";
  const isGovernment = folio?.billingModel === "GOVERNMENT";
  const latestInvoice = invoices[0];

  const folioLedger = useMemo(
    () => computeFolioLedger(folio, folioLines, folioPayments, folioWriteOffs),
    [folio, folioLines, folioPayments, folioWriteOffs],
  );
  const hasFolioLedgerRows =
    folioLines.length > 0 || folioPayments.length > 0 || folioWriteOffs.length > 0;
  const displayOutstanding = folioOutstandingForDisplay(folioLedger, hasFolioLedgerRows);

  const [postStayDesc, setPostStayDesc] = useState("");
  const [postStayAmount, setPostStayAmount] = useState("");
  const [postStayLineType, setPostStayLineType] = useState("OTHER");
  const [creditDesc, setCreditDesc] = useState("");
  const [creditAmount, setCreditAmount] = useState("");
  const [writeOffAmount, setWriteOffAmount] = useState("");
  const [writeOffReason, setWriteOffReason] = useState("");
  const [paymentEventAmount, setPaymentEventAmount] = useState("");
  const [paymentEventRef, setPaymentEventRef] = useState("");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [disputeCloseReason, setDisputeCloseReason] = useState("");
  const [h5Evidence, setH5Evidence] = useState("Residual obligations resolved");
  const [actionError, setActionError] = useState<unknown>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
  };

  const closureChecks = useMemo(
    () => [
      {
        label: "Entry at S9 (not already closed)",
        ok: isClosed || entry.currentStage === "S9",
        detail: isClosed ? "CLOSED" : entry.currentStage,
      },
      {
        label: "All disputes terminal",
        ok: openDisputes.length === 0,
        detail: openDisputes.length > 0 ? `${openDisputes.length} open` : undefined,
      },
      {
        label: "Invoices dispatched (no DRAFT)",
        ok: draftInvoices.length === 0,
        detail: draftInvoices.length > 0 ? `${draftInvoices.length} draft` : `${invoices.length} invoice(s)`,
      },
      {
        label: "H5 fulfilled or closed",
        ok: !h5Blocking(h5),
        detail: h5 ? h5.state : "None / auto-fulfilled at S8",
      },
      {
        label: "Deferred inspection resolved",
        ok: !inspectionBlocksClosure(inspections),
        detail: inspections[0]
          ? inspections[0].isDeferred
            ? "Complete inspection or record lapse (W9)"
            : "Recorded"
          : "No inspection on file",
      },
      {
        label: "Folio closure path",
        ok:
          isNoShow ||
          folio?.state === "SETTLED" ||
          folio?.state === "WRITTEN_OFF" ||
          (folio?.state === "OUTSTANDING" && displayOutstanding > 0),
        detail: folio?.state ?? "—",
      },
      ...(isGovernment
        ? [
            {
              label: "Government invoice PAYMENT_TRACKED+",
              ok:
                !!latestInvoice &&
                (latestInvoice.state === "PAYMENT_TRACKED" || latestInvoice.state === "RECONCILED"),
              detail: latestInvoice?.state ?? "Issue & track payment",
            },
          ]
        : []),
    ],
    [
      isClosed,
      entry.currentStage,
      openDisputes.length,
      draftInvoices.length,
      invoices.length,
      h5,
      inspections,
      isNoShow,
      folio?.state,
      displayOutstanding,
      isGovernment,
      latestInvoice,
    ],
  );

  const canClose =
    !isClosed &&
    entry.currentStage === "S9" &&
    closureChecks.every((c) => c.ok) &&
    isElevated(session?.actorLevel ?? "L1");

  const closeMutation = useMutation({
    mutationFn: () => closeEntryAtS9(session!, entry.id),
    onSuccess: () => {
      setActionError(null);
      toast.success("Engagement closed — record sealed");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Closure failed");
    },
  });

  const postStayMutation = useMutation({
    mutationFn: () => {
      const amount = Number.parseFloat(postStayAmount);
      if (!folio?.id || !Number.isFinite(amount)) throw new Error("Valid amount required");
      return postStayCharge(session!, folio.id, {
        entryId: entry.id,
        lineType: postStayLineType,
        description: postStayDesc.trim() || "Post-stay charge",
        amount,
        postedAt: new Date().toISOString(),
        isPostStay: true,
      });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Post-stay charge posted (guest notified)");
      setPostStayDesc("");
      setPostStayAmount("");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Post-stay charge failed");
    },
  });

  const writeOffMutation = useMutation({
    mutationFn: () => {
      const amount = Number.parseFloat(writeOffAmount);
      if (!folio?.id || !Number.isFinite(amount) || amount <= 0) throw new Error("Valid amount required");
      if (!writeOffReason.trim()) throw new Error("Write-off reason is required");
      return writeOffOutstanding(session!, folio.id, { amount, reason: writeOffReason.trim() });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Write-off recorded — folio → WRITTEN_OFF");
      setWriteOffAmount("");
      setWriteOffReason("");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Write-off failed");
    },
  });

  const paymentEventMutation = useMutation({
    mutationFn: () => {
      const invId = selectedInvoiceId || invoices[0]?.id;
      if (!invId) throw new Error("Select an invoice");
      const amount = Number.parseFloat(paymentEventAmount);
      const body: Parameters<typeof recordInvoicePaymentEvent>[2] = {
        nextState: "PAYMENT_TRACKED",
        referenceNumber: paymentEventRef.trim() || undefined,
      };
      if (Number.isFinite(amount) && amount > 0) body.amount = amount;
      return recordInvoicePaymentEvent(session!, invId, body);
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Payment event recorded — invoice PAYMENT_TRACKED");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Payment event failed");
    },
  });

  const reconcileMutation = useMutation({
    mutationFn: () => {
      const invId = selectedInvoiceId || invoices[0]?.id;
      if (!invId) throw new Error("Select an invoice");
      return recordInvoicePaymentEvent(session!, invId, { nextState: "RECONCILED" });
    },
    onSuccess: () => {
      toast.success("Invoice reconciled");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reconcile failed"),
  });

  const issueInvoiceMutation = useMutation({
    mutationFn: () => {
      if (!folio?.id) throw new Error("No folio");
      return issueFolioInvoice(session!, folio.id, { entryId: entry.id, templateKey: "final-v1" });
    },
    onSuccess: () => {
      toast.success("Final invoice created (DRAFT — dispatch next)");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Issue invoice failed"),
  });

  const fulfilH5Mutation = useMutation({
    mutationFn: () => {
      if (!h5) throw new Error("No H5");
      // SIG-S9 §2.7 — H5 fulfilment evidence must include `resolutionBasis` explaining how
      // residual financial obligations were resolved (e.g. payment matched, written off, no-action).
      return fulfilHandoff(session!, h5.id, { resolutionBasis: h5Evidence.trim() });
    },
    onSuccess: () => {
      toast.success("H5 fulfilled");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "H5 fulfil failed"),
  });

  // Stage-mismatch gate removed — ReadOnlyShell handles past/future stage viewing.

  return (
    <StagePanel meta={meta}>
      <div className="space-y-6">
        {isClosed && (
          <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30">
            <CardContent className="flex items-start gap-3 p-4 text-sm">
              <Lock className="mt-0.5 h-5 w-5 text-emerald-700 dark:text-emerald-400" />
              <div>
                <p className="font-medium text-emerald-900 dark:text-emerald-100">Engagement sealed</p>
                <p className="text-emerald-800/90 dark:text-emerald-200/90">
                  {entry.closedAt
                    ? `Closed ${new Date(entry.closedAt).toLocaleString()}`
                    : "Entry is CLOSED"}
                  . Folio sealed; inventory claim released. Post-closure changes are additive only (L2/L3).
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Post-stay context</CardTitle>
            <CardDescription>
              SIG-S9 — resolve open loops, match payments, then close the engagement permanently.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Entry:</span>{" "}
              <span className="font-mono">{formatListId(entry.id)}</span>{" "}
              <StatusBadge status={entry.status} />
            </div>
            <div>
              <span className="text-muted-foreground">Use type:</span> {entry.useType ?? "—"}
            </div>
            {folio && (
              <div>
                <span className="text-muted-foreground">Folio:</span>{" "}
                <span className="font-mono">{formatListId(folio.id)}</span>{" "}
                <StatusBadge status={folio.state} />
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Billing:</span> {folio?.billingModel ?? "—"}
            </div>
            <div className="sm:col-span-2">
              <span className="text-muted-foreground">Outstanding:</span>{" "}
              <strong>
                {folio ? `${folioLedger.currency} ${displayOutstanding.toFixed(2)}` : "—"}
              </strong>
              {hasFolioLedgerRows && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Charges {folioLedger.lineTotal.toFixed(2)} − in {folioLedger.paymentsIn.toFixed(2)}
                  {folioLedger.writeOffTotal > 0
                    ? ` − write-offs ${folioLedger.writeOffTotal.toFixed(2)}`
                    : ""}
                </p>
              )}
            </div>
            {entry.inquiry?.agentProfile?.commissionRate != null && (
              <div className="sm:col-span-2 text-xs text-muted-foreground">
                Agent {entry.inquiry.agentProfile.displayName ?? formatListId(entry.inquiry.agentProfile.id)}
                — commission due record created at closure when rate is configured.
              </div>
            )}
          </CardContent>
        </Card>

        {isNoShow && entry.noShowDetermination && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No-show financial closure</CardTitle>
              <CardDescription>
                Folio is NO_SHOW_CLOSED — confirm penalty invoice / refund before close.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <p>
                Determination: <strong>{entry.noShowDetermination.determinationPath}</strong>
              </p>
              {entry.noShowDetermination.decisionReason && (
                <p className="mt-1 text-muted-foreground">{entry.noShowDetermination.decisionReason}</p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Folio details — always visible; useful for historical reading on closed entries. */}
        {folio && (folioLines.length > 0 || folioPayments.length > 0 || invoices.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Folio details</CardTitle>
              <CardDescription>Lines, payments, and invoices on this folio.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {folioLines.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Lines ({folioLines.length})</p>
                  <div className="space-y-1">
                    {folioLines.map((l) => (
                      <div key={l.id} className="flex items-center justify-between gap-2 border-b border-border/50 pb-1 last:border-0">
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-mono text-muted-foreground">{l.lineType}</span>
                          <span className="ml-2">{l.description}</span>
                        </div>
                        <span className="font-mono text-right">{Number(l.amount).toFixed(2)} {l.currency}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {folioPayments.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Payments ({folioPayments.length})</p>
                  <div className="space-y-1">
                    {folioPayments.map((p) => (
                      <div key={p.id} className="flex items-center justify-between gap-2 border-b border-border/50 pb-1 last:border-0">
                        <div className="min-w-0 flex-1 text-xs">
                          <span className="font-mono">{p.paymentDirection}</span>
                          {p.receivedAt && <span className="ml-2 text-muted-foreground">{new Date(p.receivedAt).toLocaleDateString()}</span>}
                          {p.notes && <span className="ml-2 text-muted-foreground">— {p.notes}</span>}
                        </div>
                        <span className="font-mono text-right">{Number(p.amount).toFixed(2)} {p.currency}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {invoices.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Invoices ({invoices.length})</p>
                  <div className="space-y-1">
                    {invoices.map((inv) => {
                      const isGroupInvoice =
                        (inv.templateKey?.startsWith("group-") ?? false) ||
                        (inv.metadata && (inv.metadata as Record<string, unknown>).groupBooking === true);
                      const meta = (inv.metadata ?? {}) as Record<string, unknown>;
                      const roomCount = typeof meta.roomCount === "number" ? meta.roomCount : null;
                      return (
                        <div key={inv.id} className="flex items-center justify-between gap-2 border-b border-border/50 pb-1 last:border-0">
                          <div className="min-w-0 flex-1 text-xs">
                            <span className="font-mono">{formatListId(inv.id)}</span>
                            <span className="ml-2">{inv.invoiceType}</span>
                            <span className="ml-2"><StatusBadge status={inv.state} /></span>
                            {isGroupInvoice && (
                              <span className="ml-2 inline-flex items-center gap-1 rounded border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-800 dark:text-indigo-300">
                                Group{roomCount != null ? ` · ${roomCount} rooms` : ""}
                              </span>
                            )}
                          </div>
                          <span className="font-mono text-right text-muted-foreground">{inv.dispatchedAt ? new Date(inv.dispatchedAt).toLocaleDateString() : ""}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Archive className="h-4 w-4" />
              Loop closure checklist
            </CardTitle>
            <CardDescription>All items must pass before POST /entries/:id/close succeeds.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {closureChecks.map((check) => (
                <li key={check.label} className="flex items-start gap-2 text-sm">
                  {check.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
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
          </CardContent>
        </Card>

        {!isClosed && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Receipt className="h-4 w-4" />
                  Post-stay charges (L2+)
                </CardTitle>
                <CardDescription>
                  Additive folio lines with isPostStay=true and today&apos;s date — guest notification sent
                  automatically.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {isElevated(session?.actorLevel ?? "L1") ? (
                  <div className="flex flex-wrap gap-2">
                    <select
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                      value={postStayLineType}
                      onChange={(e) => setPostStayLineType(e.target.value)}
                    >
                      <option value="OTHER">Other</option>
                      <option value="SERVICE">Service</option>
                      <option value="F_AND_B">F &amp; B</option>
                    </select>
                    <Input
                      className="max-w-[200px]"
                      placeholder="Description"
                      value={postStayDesc}
                      onChange={(e) => setPostStayDesc(e.target.value)}
                    />
                    <Input
                      className="max-w-[100px]"
                      type="number"
                      placeholder="Amount"
                      value={postStayAmount}
                      onChange={(e) => setPostStayAmount(e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={postStayMutation.isPending}
                      onClick={() => postStayMutation.mutate()}
                    >
                      Post charge
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">FOM (L2+) required to post post-stay charges.</p>
                )}

                {folioLines.length > 0 && (
                  <div className="max-h-40 overflow-y-auto rounded-lg border text-sm">
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
                            <td className="p-2">
                              {line.lineType}
                              {line.description.toLowerCase().includes("night audit") && (
                                <Badge variant="outline" className="ml-1 text-[10px]">
                                  S7
                                </Badge>
                              )}
                            </td>
                            <td className="p-2">{line.description}</td>
                            <td className="p-2">
                              {line.currency} {String(line.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4" />
                  Invoices &amp; payment matching
                </CardTitle>
                <CardDescription>
                  Match payments received after checkout to invoices. Most stays already have a FINAL invoice
                  from S8 settlement — use this section to dispatch DRAFT invoices or confirm payment.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <strong>When do you need a new invoice?</strong> Direct-bill and voucher paths usually create a
                  DISPATCHED invoice at S8 checkout. Only use &quot;Create final invoice&quot; if the list below is
                  empty (e.g. cash SETTLED at S8, then post-stay charges added at S9).
                </p>

                {invoices.length === 0 && isElevated(session?.actorLevel ?? "L1") && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={issueInvoiceMutation.isPending}
                      onClick={() => issueInvoiceMutation.mutate()}
                    >
                      Create final invoice (DRAFT)
                    </Button>
                    <span className="text-xs text-muted-foreground self-center">
                      Then dispatch, then record payment if needed
                    </span>
                  </div>
                )}

                {invoices.length > 0 ? (
                  <ul className="space-y-2">
                    {invoices.map((inv) => (
                      <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2">
                        <span>
                          <span className="font-mono text-xs">{formatListId(inv.id)}</span>{" "}
                          {inv.invoiceType} · <StatusBadge status={inv.state} />
                        </span>
                        <div className="flex gap-2">
                          {inv.state === "DRAFT" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                dispatchInvoice(session!, inv.id).then(() => {
                                  toast.success("Invoice dispatched");
                                  invalidate();
                                })
                              }
                            >
                              Dispatch
                            </Button>
                          )}
                          {(inv.state === "DISPATCHED" || inv.state === "PAYMENT_TRACKED") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setSelectedInvoiceId(inv.id)}
                            >
                              {selectedInvoiceId === inv.id ? "Selected" : "Select"}
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">
                    No invoices on this folio yet — create a DRAFT final invoice above if you need to bill after
                    checkout.
                  </p>
                )}

                {isElevated(session?.actorLevel ?? "L1") &&
                  invoices.some((i) => i.state === "DISPATCHED" || i.state === "PAYMENT_TRACKED") && (
                    <div className="rounded-lg border border-dashed p-3 space-y-2">
                      <p className="text-xs font-medium">Record payment event (L2 FOM)</p>
                      <p className="text-xs text-muted-foreground">
                        Use when payment arrives <em>after</em> checkout and must be linked to an invoice: moves
                        DISPATCHED → PAYMENT_TRACKED (required for government billing before close). Optional amount
                        posts a payment on the folio; if the balance hits zero, folio becomes SETTLED. &quot;Reconcile&quot;
                        is a later accounting step (PAYMENT_TRACKED → RECONCILED) and does not block closure.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Input
                          type="number"
                          className="max-w-[120px]"
                          placeholder="Amount"
                          value={paymentEventAmount}
                          onChange={(e) => setPaymentEventAmount(e.target.value)}
                        />
                        <Input
                          className="min-w-[160px] flex-1"
                          placeholder="Reference / proof ref"
                          value={paymentEventRef}
                          onChange={(e) => setPaymentEventRef(e.target.value)}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={paymentEventMutation.isPending}
                          onClick={() => paymentEventMutation.mutate()}
                        >
                          Mark PAYMENT_TRACKED
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={reconcileMutation.isPending}
                          onClick={() => reconcileMutation.mutate()}
                        >
                          Reconcile
                        </Button>
                      </div>
                    </div>
                  )}
              </CardContent>
            </Card>

            {folio?.state === "OUTSTANDING" && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Banknote className="h-4 w-4" />
                    Outstanding balance
                  </CardTitle>
                  <CardDescription>
                    Collect via payment matching (→ SETTLED) or GM write-off (→ WRITTEN_OFF). W8 follow-up runs for
                    governed outstanding.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {isGm(session?.actorLevel ?? "L1") ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">Write-off (GM L3 — mandatory reason)</p>
                      <div className="flex flex-wrap gap-2">
                        <Input
                          type="number"
                          className="max-w-[120px]"
                          placeholder="Amount"
                          value={writeOffAmount}
                          onChange={(e) => setWriteOffAmount(e.target.value)}
                        />
                        <Input
                          className="min-w-[200px] flex-1"
                          placeholder="Reason (required)"
                          value={writeOffReason}
                          onChange={(e) => setWriteOffReason(e.target.value)}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={writeOffMutation.isPending}
                          onClick={() => writeOffMutation.mutate()}
                        >
                          Write off
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      GM authority required for write-off. FOM can record payments against invoices above.
                    </p>
                  )}
                  {isElevated(session?.actorLevel ?? "L1") && (
                    <div className="space-y-2 border-t pt-3">
                      <p className="text-xs text-muted-foreground">Credit note (L2 correction)</p>
                      <div className="flex flex-wrap gap-2">
                        <Input
                          placeholder="Description / reason"
                          value={creditDesc}
                          onChange={(e) => setCreditDesc(e.target.value)}
                        />
                        <Input
                          type="number"
                          className="max-w-[100px]"
                          placeholder="Amount"
                          value={creditAmount}
                          onChange={(e) => setCreditAmount(e.target.value)}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const amount = Number.parseFloat(creditAmount);
                            if (!folio?.id || !Number.isFinite(amount)) return;
                            postCreditNote(session!, folio.id, {
                              entryId: entry.id,
                              description: creditDesc.trim() || "Post-stay credit",
                              amount,
                              creditDate: new Date().toISOString(),
                            })
                              .then(() => {
                                toast.success("Credit note posted");
                                invalidate();
                              })
                              .catch((e) =>
                                toast.error(e instanceof ApiError ? e.message : "Credit note failed"),
                              );
                          }}
                        >
                          Post credit note
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {h5 && h5Blocking(h5) && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Handshake className="h-4 w-4" />
                    H5 — residual obligations
                  </CardTitle>
                  <CardDescription>Fulfil after payment matched, write-off, or confirmed no-action.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Badge variant="outline">{h5.state}</Badge>
                  <label className="block text-xs text-muted-foreground">
                    Resolution basis (required) — how were the residual obligations resolved?
                  </label>
                  <Input
                    value={h5Evidence}
                    onChange={(e) => setH5Evidence(e.target.value)}
                    placeholder="e.g. balance settled, written off, no action required"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={fulfilH5Mutation.isPending || h5Evidence.trim().length < 3}
                    onClick={() => fulfilH5Mutation.mutate()}
                  >
                    Fulfil H5
                  </Button>
                </CardContent>
              </Card>
            )}

            {inspectionBlocksClosure(inspections) && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Search className="h-4 w-4" />
                    Deferred inspection (W9)
                  </CardTitle>
                <CardDescription>
                  Deferred at checkout — window is 18 hours (config{" "}
                  <code className="text-xs">inspection.postCheckout.windowHours</code>), then W9 records lapse so
                  you can close.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-amber-700 dark:text-amber-400">
                <p>
                  Latest inspection is still deferred. After the window passes (or if the server was off and
                  workers catch up on restart), use the button below — or post post-stay damage charges first if
                  needed.
                </p>
                {isElevated(session?.actorLevel ?? "L1") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      expirePostCheckoutInspectionWindow(session!, entry.id)
                        .then(() => {
                          toast.success("Inspection window marked expired (W9)");
                          invalidate();
                        })
                        .catch((e) =>
                          toast.error(e instanceof ApiError ? e.message : "Could not expire window"),
                        )
                    }
                  >
                    Expire inspection window now (FOM)
                  </Button>
                )}
              </CardContent>
              </Card>
            )}

            {disputes.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Scale className="h-4 w-4" />
                    Disputes
                  </CardTitle>
                  <CardDescription>No override at S9 — RESOLVED or CLOSED (GM) required.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {disputes.map((d) => (
                    <div key={d.id} className="rounded border px-3 py-2">
                      <span className="font-mono text-xs">{formatListId(d.id)}</span>{" "}
                      <strong>{d.title}</strong> <StatusBadge status={d.status} />
                      {(d.status === "OPEN" || d.status === "IN_PROGRESS") &&
                        isElevated(session?.actorLevel ?? "L1") && (
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
                        placeholder="Closure reason (GM, mandatory)"
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
                  <Sparkles className="h-4 w-4" />
                  Close engagement
                </CardTitle>
                <CardDescription>
                  L2+ — seals folio, releases room claim, registers W28 feedback &amp; retention timers, creates
                  commission/follow-up records.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  variant="gradient"
                  disabled={!canClose || closeMutation.isPending}
                  onClick={() => closeMutation.mutate()}
                >
                  {closeMutation.isPending ? "Closing…" : "Close entry (permanent)"}
                </Button>
                {!canClose && (
                  <p className="text-xs text-muted-foreground">
                    Resolve all checklist items above. Closure errors from the API will name the blocking loop.
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {(commissionRecords.length > 0 || followUpTasks.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Post-closure records</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {commissionRecords.map((c) => (
                <div key={c.id} className="rounded border px-3 py-2">
                  <span className="font-mono text-xs">{formatListId(c.id)}</span> Commission due ·{" "}
                  <StatusBadge status={c.status} /> · {c.currency}{" "}
                  {c.calculatedAmount != null ? String(c.calculatedAmount) : "—"}
                </div>
              ))}
              {followUpTasks.map((t) => (
                <div key={t.id} className="rounded border px-3 py-2">
                  <span className="font-mono text-xs">{formatListId(t.id)}</span> Follow-up due{" "}
                  {new Date(t.dueAt).toLocaleDateString()}
                  {t.completedAt && " · completed"}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <ApiErrorAlert error={actionError} />
      </div>
    </StagePanel>
  );
}
