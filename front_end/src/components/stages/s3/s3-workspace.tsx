"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Banknote,
  CheckCircle2,
  Circle,
  FileCheck,
  Lock,
  RefreshCw,
  Shield,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { GroupBadge } from "@/components/entries/group-badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StagePanel } from "@/components/stages/shared/stage-panel";
import { ApiErrorAlert } from "@/components/stages/shared/api-error-alert";
import { ProgressStageButton } from "@/components/stages/shared/progress-stage-button";
import { useStageTransition } from "@/components/stages/shared/stage-transition-context";
import { STAGES, stagePath } from "@/config/stages";
import {
  approveFocGm,
  cancelEntryAtS3,
  confirmCoordinator,
  dispatchInvoice,
  ensureProvisionalFolio,
  getPaymentStatus,
  initiateS3ReEntryToS1,
  initiateS3ReEntryToS2,
  placeCommittedHold,
  recordCancellationDisclosure,
  recordCreditExtension,
  recordFolioPayment,
  reconcileAdvancePayment,
  schedulePaymentMilestones,
} from "@/lib/api/reservation-setup";
import { useConfirm, usePrompt } from "@/components/providers/dialog-provider";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import type { AvailabilityConfigSummary, EntryDetail } from "@/types/api";
import { optionSelectedRoomIds } from "@/types/api";

const BILLING_MODELS = ["GUEST_PAY", "DIRECT_BILL", "TOUR_OPERATOR_VOUCHER"] as const;

type S3WorkspaceProps = {
  entry: EntryDetail;
};

function isElevated(level: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

function isGm(level: string) {
  return level === "L3" || level === "L4";
}

export function S3Workspace({ entry }: S3WorkspaceProps) {
  const router = useRouter();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const { startTransition, endTransition } = useStageTransition();
  const meta = STAGES[2];

  const folio = entry.folio ?? null;
  // A released/expired hold (e.g. after a room change re-entry) is treated as "no active hold"
  // so the operator can place a fresh committed hold for the newly chosen room.
  const rawHold = entry.committedHold ?? null;
  const hold = rawHold && rawHold.state !== "RELEASED" && rawHold.state !== "EXPIRED" ? rawHold : null;
  const disclosure = entry.cancellationDisclosure ?? null;

  const acceptedQuotation = useMemo(
    () => (entry.quotations ?? []).find((q) => q.state === "ACCEPTED"),
    [entry.quotations],
  );

  const sealedPreferred = (entry.availabilityConfigs ?? []).find(
    (c: AvailabilityConfigSummary) => c.sealedAt && c.optionSelected,
  );
  const preferredRoomIds = optionSelectedRoomIds(sealedPreferred?.optionSelected);
  const preferredRoomId = preferredRoomIds[0] ?? null;

  const proformaInvoices = (folio?.invoices ?? []).filter((i) => i.invoiceType === "PROFORMA");
  const isGroupLike = entry.useType === "GROUP" || entry.useType === "CONFERENCE";
  const needsMilestones = entry.useType === "CORPORATE" || entry.useType === "CONFERENCE";

  // Default billing model. If the folio already picked one, use that. Otherwise: group-classified
  // entries (Policy 64 set groupBillingMode = GROUP_MASTER at S1) default to DIRECT_BILL — the
  // tour operator / corporate account is billed centrally rather than each guest paying their
  // own portion. Operator can still change it in the dropdown before creating the folio.
  const defaultBillingModel =
    folio?.billingModel ??
    (entry.groupBillingMode === "GROUP_MASTER" ? "DIRECT_BILL" : "GUEST_PAY");
  const [billingModel, setBillingModel] = useState(defaultBillingModel);
  const [noShowStatement, setNoShowStatement] = useState(
    disclosure?.noShowTreatmentStatement ?? "No-show: one night room charge plus applicable taxes.",
  );
  const [paymentAmount, setPaymentAmount] = useState("1");
  const [paymentNotes, setPaymentNotes] = useState("");
  const [reconcileNote, setReconcileNote] = useState("");
  const [creditCeiling, setCreditCeiling] = useState("");
  const [creditReason, setCreditReason] = useState("");
  const [holdJustification, setHoldJustification] = useState("Reservation setup — committed inventory hold");
  const [dispatchTo, setDispatchTo] = useState(entry.guestProfile?.email ?? "");
  const [reEntryReason, setReEntryReason] = useState("");
  const [coordinatorName, setCoordinatorName] = useState("");
  const [coordinatorScope, setCoordinatorScope] = useState("");
  const [milestoneTemplate, setMilestoneTemplate] = useState("DEFAULT");
  const [actionError, setActionError] = useState<unknown>(null);

  const paymentStatusQuery = useQuery({
    queryKey: ["payment-status", entry.id],
    queryFn: () => getPaymentStatus(session!, entry.id),
    enabled: !!session && !!folio?.id,
  });
  const paymentStatus = paymentStatusQuery.data;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["payment-status", entry.id] });
  };

  const wrapMutation = <T,>(fn: () => Promise<T>, successMsg: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      setActionError(null);
      toast.success(successMsg);
      invalidate();
    },
    onError: (e: unknown) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    },
  });

  const folioMutation = useMutation(
    wrapMutation(
      () => ensureProvisionalFolio(session!, entry.id, { billingModel }),
      folio?.billingModel ? "Billing model updated" : "Provisional folio created",
    ),
  );

  const disclosureMutation = useMutation(
    wrapMutation(
      () =>
        recordCancellationDisclosure(session!, entry.id, {
          noShowTreatmentStatement: noShowStatement.trim(),
          disclosedTerms: { tier: "DEFAULT" },
        }),
      "Cancellation disclosure recorded",
    ),
  );

  const paymentMutation = useMutation(
    wrapMutation(
      () => {
        if (!folio) throw new Error("Create folio first");
        return recordFolioPayment(session!, folio.id, {
          entryId: entry.id,
          amount: Number(paymentAmount),
          notes: paymentNotes.trim() || undefined,
        });
      },
      "Advance payment recorded",
    ),
  );

  const reconcileMutation = useMutation(
    wrapMutation(
      () => {
        if (!folio) throw new Error("Create folio first");
        return reconcileAdvancePayment(session!, folio.id, {
          entryId: entry.id,
          note: reconcileNote.trim() || undefined,
        });
      },
      "Advance payment reconciled",
    ),
  );

  const creditMutation = useMutation(
    wrapMutation(
      () =>
        recordCreditExtension(session!, entry.id, {
          ceilingAmount: Number(creditCeiling),
          reason: creditReason.trim(),
        }),
      "Credit extension approved",
    ),
  );

  const holdMutation = useMutation(
    wrapMutation(
      () => {
        if (!preferredRoomId) throw new Error("No preferred room from S1");
        return placeCommittedHold(session!, entry.id, {
          roomId: preferredRoomId,
          commercialJustification: holdJustification.trim(),
        });
      },
      "Committed hold placed",
    ),
  );

  const dispatchMutation = useMutation(
    wrapMutation(
      () => {
        const inv = proformaInvoices.find((i) => i.state === "DRAFT") ?? proformaInvoices[0];
        if (!inv) throw new Error("No proforma invoice");
        return dispatchInvoice(session!, inv.id, { dispatchedTo: dispatchTo.trim() || undefined });
      },
      "Proforma invoice dispatched",
    ),
  );

  const confirmDialog = useConfirm();
  const promptDialog = usePrompt();

  const cancelMutation = useMutation({
    mutationFn: (body: { reason?: string }) => cancelEntryAtS3(session!, entry.id, body),
    onSuccess: () => {
      setActionError(null);
      toast.success("Booking cancelled — hold released, timers cancelled");
      invalidate();
      // Land back on the dashboard since the entry is now terminal.
      router.push("/dashboard");
    },
    onError: (e: unknown) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Cancellation failed");
    },
  });

  async function handleCancel() {
    const reason = await promptDialog({
      title: "Cancel booking at S3",
      message:
        "This will release the committed hold, supersede any in-flight proforma invoice, cancel all scheduled timers (W3/W22/W34), and terminate the entry. The cancellation penalty (if any) per the disclosed terms will be posted to the folio; the net advance will refund. This cannot be undone.",
      placeholder: "Reason (e.g. guest changed plans)",
      confirmLabel: "Continue",
      multiline: true,
    });
    if (reason === null) return;
    const ok = await confirmDialog({
      title: "Confirm cancellation",
      message: `Cancel booking ${entry.id.slice(0, 8)}…? This terminates the entry and cannot be reversed.`,
      confirmLabel: "Cancel booking",
      variant: "danger",
    });
    if (!ok) return;
    cancelMutation.mutate({ reason: reason.trim() || undefined });
  }

  const reEntryS2Mutation = useMutation({
    mutationFn: () =>
      initiateS3ReEntryToS2(session!, entry.id, { reason: reEntryReason.trim() || undefined }),
    onSuccess: () => {
      setActionError(null);
      toast.success("Re-entry to S2 initiated");
      invalidate();
      startTransition({ targetStage: "S2", label: "Rolling back to quotation…" });
      router.push(stagePath(entry.id, "S2"));
    },
    onError: (e: unknown) => {
      endTransition();
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Re-entry failed");
    },
  });

  const reEntryS1Mutation = useMutation({
    mutationFn: () =>
      initiateS3ReEntryToS1(session!, entry.id, { reason: reEntryReason.trim() || undefined }),
    onSuccess: () => {
      setActionError(null);
      toast.success("Re-entry to S1 initiated");
      invalidate();
      startTransition({ targetStage: "S1", label: "Returning to inquiry & availability…" });
      router.push(stagePath(entry.id, "S1"));
    },
    onError: (e: unknown) => {
      endTransition();
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Re-entry failed");
    },
  });

  const coordinatorMutation = useMutation(
    wrapMutation(
      () =>
        confirmCoordinator(session!, entry.id, {
          coordinatorName: coordinatorName.trim(),
          authorityScope: coordinatorScope.trim(),
        }),
      "Coordinator confirmed",
    ),
  );

  const milestonesMutation = useMutation(
    wrapMutation(
      () => schedulePaymentMilestones(session!, entry.id, { templateKey: milestoneTemplate.trim() }),
      "Payment milestones scheduled",
    ),
  );

  const focGmMutation = useMutation(
    wrapMutation(() => approveFocGm(session!, entry.id, {}), "FOC GM approval recorded"),
  );

  const exitChecks = useMemo(() => {
    const hasHold = hold?.state === "PLACED" || hold?.state === "UPGRADED";
    const hasBilling = !!folio?.billingModel;
    const hasPi = proformaInvoices.length > 0;
    const hasDisclosure = !!disclosure?.noShowTreatmentStatement;
    const paymentOk = paymentStatus?.satisfied === true;
    const reconciled = folio?.advancePaymentReconciliationComplete === true;
    const hasContact = !!(entry.guestProfile?.email || entry.guestProfile?.phone);
    const hasAccepted = !!acceptedQuotation;
    return [
      { label: "Accepted quotation (from S2)", ok: hasAccepted },
      { label: "Provisional folio with billing model", ok: hasBilling && folio?.state === "PROVISIONAL" },
      { label: "Cancellation disclosure recorded", ok: hasDisclosure },
      { label: "Advance payment or credit extension", ok: paymentOk },
      { label: "Advance payment reconciled on folio", ok: reconciled },
      { label: "Proforma invoice on folio", ok: hasPi },
      { label: "Committed hold placed", ok: hasHold },
      { label: "Guest contact on profile", ok: hasContact },
    ];
  }, [entry, folio, hold, disclosure, paymentStatus, proformaInvoices, acceptedQuotation]);

  const canConfirmS4 =
    exitChecks.every((c) => c.ok) && entry.currentStage === "S3";

  // Stage-mismatch gate removed — ReadOnlyShell + <fieldset disabled> in stage-page.tsx handles
  // past/future stage viewing. Workspace content always renders.

  return (
    <StagePanel meta={meta}>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reservation setup context</CardTitle>
            <CardDescription>
              SIG-S3 — operational & financial foundation before confirmation (not yet confirmed).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <p>
              <span className="text-muted-foreground">Stay:</span> {entry.checkInDate?.slice(0, 10) ?? "—"} →{" "}
              {entry.checkOutDate?.slice(0, 10) ?? "—"}
            </p>
            <p>
              <span className="text-muted-foreground">Use type:</span> {entry.useType ?? "—"}
            </p>
            {acceptedQuotation && (
              <p className="sm:col-span-2">
                <span className="text-muted-foreground">Accepted quote:</span>{" "}
                <span className="font-medium">{acceptedQuotation.referenceNumber}</span>
                {" · "}
                {acceptedQuotation.currency}{" "}
                {typeof acceptedQuotation.totalAmount === "string"
                  ? acceptedQuotation.totalAmount
                  : acceptedQuotation.totalAmount}
              </p>
            )}
            <p className="sm:col-span-2">
              <span className="text-muted-foreground">Preferred room (S1):</span>{" "}
              {preferredRoomId ? (
                <span className="font-mono text-xs">{preferredRoomId.slice(0, 24)}…</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">Missing</span>
              )}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Provisional folio & billing model</CardTitle>
            <CardDescription>Fix billing model — creates folio, PI draft, and transition record.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {folio && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                Folio <span className="font-mono text-xs">{folio.id.slice(0, 12)}…</span>
                <Badge className="ml-2">{folio.state}</Badge>
                {folio.billingModel && (
                  <span className="ml-2 text-muted-foreground">· {folio.billingModel}</span>
                )}
                <GroupBadge groupBillingMode={entry.groupBillingMode} className="ml-2" />
              </div>
            )}
            <div>
              <label className="text-xs text-muted-foreground">Billing model</label>
              <select
                className="mt-1 flex h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={billingModel}
                onChange={(e) => setBillingModel(e.target.value)}
              >
                {BILLING_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              {entry.groupBillingMode === "GROUP_MASTER" && !folio?.billingModel && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Pre-filled to <span className="font-mono">DIRECT_BILL</span> because this booking was auto-classified as a
                  group at S1. Override if the guests are paying individually.
                </p>
              )}
              {entry.groupBillingMode === "GROUP_MASTER" &&
                billingModel !== "DIRECT_BILL" &&
                billingModel !== "TOUR_OPERATOR_VOUCHER" &&
                session &&
                !isGm(session.actorLevel) && (
                  <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                    Group bookings need L3+ (FOM / GM) authority to leave a group-friendly billing model
                    (<span className="font-mono">DIRECT_BILL</span> or <span className="font-mono">TOUR_OPERATOR_VOUCHER</span>).
                    Save will be rejected — ask an FOM to override.
                  </p>
                )}
            </div>
            <Button variant="gradient" disabled={folioMutation.isPending} onClick={() => folioMutation.mutate()}>
              {folioMutation.isPending
                ? "Saving…"
                : folio
                  ? "Update billing model & ensure PI"
                  : "Create provisional folio"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Cancellation disclosure</CardTitle>
            <CardDescription>Required before committed hold (Policy 34).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {disclosure ? (
              <div className="flex items-start gap-2 rounded-lg border border-[var(--success)]/40 bg-accent p-3 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />
                <div>
                  <p className="font-medium text-[var(--success)]">Disclosure recorded</p>
                  <p className="mt-1">{disclosure.noShowTreatmentStatement}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Recorded {disclosure.disclosedAt.slice(0, 16)}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-xs text-muted-foreground">No-show treatment statement</label>
                  <Input value={noShowStatement} onChange={(e) => setNoShowStatement(e.target.value)} />
                </div>
                <Button
                  variant="outline"
                  disabled={disclosureMutation.isPending || !noShowStatement.trim()}
                  onClick={() => disclosureMutation.mutate()}
                >
                  {disclosureMutation.isPending ? "Saving…" : "Record disclosure"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Banknote className="h-4 w-4" />
              3. Advance payment
            </CardTitle>
            <CardDescription>Record payment, reconcile, or approve credit extension (FOM).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {paymentStatus && (
              <div className="rounded-lg border p-3 text-sm space-y-1">
                <p>
                  Received: <strong>{paymentStatus.totalReceived}</strong> / required{" "}
                  <strong>{paymentStatus.requiredAmount}</strong>
                  {paymentStatus.satisfied ? (
                    <Badge className="ml-2 bg-[var(--success)]/15 text-[var(--success)]">Satisfied</Badge>
                  ) : (
                    <Badge variant="outline" className="ml-2">
                      Shortfall {paymentStatus.shortfall}
                    </Badge>
                  )}
                </p>
                {paymentStatus.creditExtensionActive && (
                  <p className="text-muted-foreground">
                    Credit extension active (ceiling {paymentStatus.ceilingAmount ?? "—"})
                  </p>
                )}
                {paymentStatus.groupBoostApplied && (
                  <p className="text-indigo-700 dark:text-indigo-300">
                    Group booking · advance requirement boosted from{" "}
                    <span className="font-mono">{paymentStatus.groupBoostApplied.baseAmount}</span> by{" "}
                    <span className="font-mono">{paymentStatus.groupBoostApplied.multiplierPercent}%</span>{" "}
                    (registry.groupBooking.advancePaymentBoost)
                  </p>
                )}
                {folio?.advancePaymentReconciliationComplete && (
                  <p className="text-[var(--success)]">Reconciliation complete on folio</p>
                )}
              </div>
            )}
            {(() => {
              const inPayments = (folio?.payments ?? []).filter((p) => p.paymentDirection === "IN");
              if (inPayments.length === 0) return null;
              const total = inPayments.reduce((s, p) => s + Number(p.amount), 0);
              return (
                <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                  <p className="mb-2 font-medium">
                    Already paid on this booking: <strong>{total}</strong>{" "}
                    <span className="text-xs font-normal text-muted-foreground">({inPayments.length} payment{inPayments.length === 1 ? "" : "s"} — carried across any room change)</span>
                  </p>
                  <ul className="space-y-1">
                    {inPayments.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono">{p.currency} {Number(p.amount)}</span>
                        <span className="text-muted-foreground">{p.receivedAt ? p.receivedAt.slice(0, 16).replace("T", " ") : "—"}</span>
                        <span className="flex-1 truncate text-right text-muted-foreground">{p.notes ?? ""}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">Add more below only if additional advance is needed.</p>
                </div>
              );
            })()}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs text-muted-foreground">Payment amount (IN)</label>
                <Input
                  type="number"
                  min={0.01}
                  step="0.01"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  disabled={!folio}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Notes</label>
                <Input
                  value={paymentNotes}
                  onChange={(e) => setPaymentNotes(e.target.value)}
                  disabled={!folio}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!folio || paymentMutation.isPending}
                onClick={() => paymentMutation.mutate()}
              >
                Record payment
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!folio || reconcileMutation.isPending}
                onClick={() => reconcileMutation.mutate()}
              >
                Mark reconciled
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!folio || paymentStatusQuery.isFetching}
                onClick={() => paymentStatusQuery.refetch()}
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                Refresh status
              </Button>
            </div>
            {session && isElevated(session.actorLevel) && (
              <div className="rounded-lg border border-dashed p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Credit extension (FOM+)</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    type="number"
                    placeholder="Ceiling amount"
                    value={creditCeiling}
                    onChange={(e) => setCreditCeiling(e.target.value)}
                  />
                  <Input
                    placeholder="Reason (required)"
                    value={creditReason}
                    onChange={(e) => setCreditReason(e.target.value)}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={creditMutation.isPending || !creditCeiling || !creditReason.trim() || !folio}
                  onClick={() => creditMutation.mutate()}
                >
                  Approve credit extension
                </Button>
              </div>
            )}
            {(folio?.payments ?? []).length > 0 && (
              <p className="text-xs text-muted-foreground">
                {folio!.payments!.length} payment record(s) on folio.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="h-4 w-4" />
              4. Committed hold
            </CardTitle>
            <CardDescription>
              Strong inventory claim with expiry — upgrades S2 speculative hold when present.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {hold ? (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
                <p>
                  <Badge>{hold.state}</Badge>
                  <span className="ml-2 font-mono text-xs">room {hold.roomId?.slice(0, 12) ?? "—"}…</span>
                </p>
                <p className="text-muted-foreground">Expires {hold.expiresAt.slice(0, 16)}</p>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-xs text-muted-foreground">Commercial justification</label>
                  <Input value={holdJustification} onChange={(e) => setHoldJustification(e.target.value)} />
                </div>
                <Button
                  variant="gradient"
                  disabled={
                    holdMutation.isPending ||
                    !preferredRoomId ||
                    !holdJustification.trim() ||
                    !folio?.billingModel ||
                    !disclosure
                  }
                  onClick={() => holdMutation.mutate()}
                >
                  {holdMutation.isPending ? "Placing…" : "Place committed hold"}
                </Button>
                {!disclosure && (
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    Record cancellation disclosure before placing hold.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileCheck className="h-4 w-4" />
              5. Proforma invoice (PI)
            </CardTitle>
            <CardDescription>Dispatch PI to guest — schedules acknowledgement & follow-up timers.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {proformaInvoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">Create folio first — a PI draft is created with the folio.</p>
            ) : (
              <>
                <ul className="space-y-2 text-sm">
                  {proformaInvoices.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between rounded border px-3 py-2">
                      <span className="font-mono text-xs">{inv.id.slice(0, 12)}…</span>
                      <Badge>{inv.state}</Badge>
                    </li>
                  ))}
                </ul>
                <div>
                  <label className="text-xs text-muted-foreground">Dispatch to</label>
                  <Input value={dispatchTo} onChange={(e) => setDispatchTo(e.target.value)} />
                </div>
                <Button
                  variant="outline"
                  disabled={dispatchMutation.isPending || !proformaInvoices.some((i) => i.state === "DRAFT")}
                  onClick={() => dispatchMutation.mutate()}
                >
                  {dispatchMutation.isPending ? "Dispatching…" : "Dispatch PI"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {(isGroupLike || needsMilestones) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Group / corporate requirements</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isGroupLike && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Coordinator confirmation</p>
                  <Input
                    placeholder="Coordinator name"
                    value={coordinatorName}
                    onChange={(e) => setCoordinatorName(e.target.value)}
                  />
                  <Input
                    placeholder="Authority scope"
                    value={coordinatorScope}
                    onChange={(e) => setCoordinatorScope(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      coordinatorMutation.isPending || !coordinatorName.trim() || !coordinatorScope.trim()
                    }
                    onClick={() => coordinatorMutation.mutate()}
                  >
                    Confirm coordinator
                  </Button>
                  {session && isGm(session.actorLevel) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={focGmMutation.isPending}
                      onClick={() => focGmMutation.mutate()}
                    >
                      FOC GM approval
                    </Button>
                  )}
                </div>
              )}
              {needsMilestones && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Payment milestone schedule</p>
                  <Input
                    value={milestoneTemplate}
                    onChange={(e) => setMilestoneTemplate(e.target.value)}
                    placeholder="Template key"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={milestonesMutation.isPending}
                    onClick={() => milestonesMutation.mutate()}
                  >
                    Schedule milestones
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {session && isElevated(session.actorLevel) && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Shield className="h-4 w-4" />
                Back-flow (FOM+)
              </CardTitle>
              <CardDescription>Renegotiate terms (S2) or reconfigure stay (S1).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                placeholder="Reason for re-entry"
                value={reEntryReason}
                onChange={(e) => setReEntryReason(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reEntryS2Mutation.isPending}
                  onClick={() => reEntryS2Mutation.mutate()}
                >
                  Re-enter S2 (rate renegotiation)
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reEntryS1Mutation.isPending}
                  onClick={() => reEntryS1Mutation.mutate()}
                >
                  Re-enter S1 (dates / room type)
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              Cancel booking (terminal)
            </CardTitle>
            <CardDescription>
              SIG-S3 §6.5 — releases the committed hold, supersedes any in-flight proforma invoice,
              cancels all scheduled timers, applies the disclosed cancellation penalty, and refunds
              the net advance. The entry becomes terminal — there&apos;s no undo.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              size="sm"
              disabled={cancelMutation.isPending}
              onClick={handleCancel}
            >
              {cancelMutation.isPending ? "Cancelling…" : "Cancel booking"}
            </Button>
          </CardContent>
        </Card>

        <ApiErrorAlert error={actionError} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">S3 exit checklist</CardTitle>
            <CardDescription>All items required before confirmation (S4)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {exitChecks.map((item) => (
              <div key={item.label} className="flex items-center gap-2 text-sm">
                {item.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className={item.ok ? "text-foreground" : "text-muted-foreground"}>{item.label}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">6. Confirm reservation (S4)</CardTitle>
            <CardDescription>
              Freezes commercial terms and moves to confirmation — not available until checklist passes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!canConfirmS4 && (
              <p className="mb-4 text-sm text-muted-foreground">
                Complete folio, disclosure, payment, committed hold, and PI steps above.
              </p>
            )}
            <ProgressStageButton
              entryId={entry.id}
              version={entry.version}
              targetStage="S4"
              label="Confirm reservation → S4"
              disabled={!canConfirmS4}
            />
          </CardContent>
        </Card>
      </div>
    </StagePanel>
  );
}
