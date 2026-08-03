"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  BedDouble,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  FileEdit,
  Handshake,
  Moon,
  Receipt,
  Scale,
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
  acceptHandoff,
  amendEntry,
  buildH4FulfilmentEvidence,
  correctFolioCharge,
  createH4Handoff,
  finalizeDeficientCondition,
  fulfilHandoff,
  getHandoffChecklist,
  getNightAuditRecord,
  openDispute,
  postCreditNote,
  postFolioCharge,
  progressDispute,
  roomChangeReEnterS1,
  runNightAudit,
} from "@/lib/api/in-stay";
import { listRooms } from "@/lib/api/rooms";
import type { HandoffChecklistItem } from "@/lib/api/handoffs";
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
  PaymentRecordSummary,
  RoomAssignmentSummary,
} from "@/types/api";

type S7WorkspaceProps = {
  entry: EntryDetail;
};

function isElevated(level: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

function lastStayNightYmd(checkOutIso: string) {
  const d = new Date(checkOutIso);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1));
  return last.toISOString().slice(0, 10);
}

function terminalDeficientStatus(status: string) {
  return status === "RESOLVED" || status === "UNRESOLVED" || status === "DEFICIENT_UNRESOLVED_AT_CHECKOUT";
}

function h4Initiated(h4: HandoffSummary | undefined) {
  if (!h4 || h4.rejectedAt) return false;
  return ["CREATED", "ACCEPTED", "FULFILLED", "CLOSED"].includes(h4.state);
}

export function S7Workspace({ entry }: S7WorkspaceProps) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const meta = STAGES[6];

  const reservation = entry.reservation;
  const folio = entry.folio;
  const folioLines = (folio?.lines ?? []) as FolioLineSummary[];
  const handoffs = (entry.handoffs ?? []) as HandoffSummary[];
  const disputes = (entry.disputes ?? []) as DisputeSummary[];
  const h2 = handoffs.find((h) => h.handoffType === "H2" && h.stageContext === "S6");
  const h3 = handoffs.find((h) => h.handoffType === "H3" && h.stageContext === "S6");
  const h4 = handoffs.find((h) => h.handoffType === "H4");
  const assignments = (entry.roomAssignments ?? []) as RoomAssignmentSummary[];
  const latestAssignment = assignments[0];
  const deficientRecords =
    latestAssignment?.room?.deficientConditionRecords ?? ([] as DeficientConditionSummary[]);

  const checkOutIso = reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? "";
  const lastNightYmd = checkOutIso ? lastStayNightYmd(checkOutIso) : "";

  const [chargeLineType, setChargeLineType] = useState("F_AND_B");
  const [chargeDescription, setChargeDescription] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeDate, setChargeDate] = useState(() => new Date().toISOString().slice(0, 10));

  const [correctLineId, setCorrectLineId] = useState("");
  const [correctReason, setCorrectReason] = useState("");
  const [correctionMode, setCorrectionMode] = useState<"ADJUST" | "SET_NET">("ADJUST");
  const [correctionInput, setCorrectionInput] = useState("");

  const [disputeTitle, setDisputeTitle] = useState("");
  const [disputeDescription, setDisputeDescription] = useState("");

  const [h4Checklist, setH4Checklist] = useState<Record<string, boolean>>({});
  const [h4DeficientFlag, setH4DeficientFlag] = useState("NOT_APPLICABLE");

  const [amendPath, setAmendPath] = useState<"PATH_2">("PATH_2");
  const [amendType, setAmendType] = useState("INCLUSION_CHANGE");
  const [amendReason, setAmendReason] = useState("");
  const [amendNewTerms, setAmendNewTerms] = useState("");
  const [roomChangeId, setRoomChangeId] = useState("");
  const [roomChangeReason, setRoomChangeReason] = useState("");

  const [nightAuditDate, setNightAuditDate] = useState(lastNightYmd || new Date().toISOString().slice(0, 10));
  const [actionError, setActionError] = useState<unknown>(null);

  const nightAuditQuery = useQuery({
    queryKey: ["night-audit", lastNightYmd],
    queryFn: () => getNightAuditRecord(session!, lastNightYmd),
    enabled: !!session && !!lastNightYmd && entry.currentStage === "S7",
  });

  const h4ChecklistQuery = useQuery({
    queryKey: ["handoff-checklist", "H4"],
    queryFn: () => getHandoffChecklist(session!, "H4"),
    enabled: !!session && !!h4 && h4.state === "CREATED",
  });
  const h4ChecklistItems = (h4ChecklistQuery.data?.items ?? []) as HandoffChecklistItem[];

  const roomsCatalogQuery = useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session && isElevated(session.actorLevel) && entry.currentStage === "S7",
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    if (lastNightYmd) void queryClient.invalidateQueries({ queryKey: ["night-audit", lastNightYmd] });
  };

  const postChargeMutation = useMutation({
    mutationFn: () => {
      const amount = Number.parseFloat(chargeAmount);
      if (!folio?.id || !Number.isFinite(amount)) throw new Error("Valid amount required");
      return postFolioCharge(session!, folio.id, {
        entryId: entry.id,
        lineType: chargeLineType,
        description: chargeDescription.trim() || chargeLineType,
        amount,
        chargeDate: chargeDate ? `${chargeDate}T12:00:00.000Z` : undefined,
      });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Charge posted");
      setChargeDescription("");
      setChargeAmount("");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Post charge failed");
    },
  });

  const correctMutation = useMutation({
    mutationFn: () => {
      const value = Number.parseFloat(correctionInput);
      if (!folio?.id || !correctLineId || !Number.isFinite(value)) {
        throw new Error("Line and amount required");
      }
      if (correctionMode === "ADJUST" && value === 0) {
        throw new Error("Adjustment cannot be zero");
      }
      return correctFolioCharge(session!, folio.id, {
        entryId: entry.id,
        originalFolioLineId: correctLineId,
        reason: correctReason.trim(),
        ...(correctionMode === "ADJUST"
          ? { correctionAmount: value }
          : { correctToAmount: value }),
        correctionDate: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Correction posted (offsetting line)");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Correction failed");
    },
  });

  const creditNoteMutation = useMutation({
    mutationFn: () => {
      const amount = Number.parseFloat(chargeAmount);
      if (!folio?.id || !Number.isFinite(amount) || amount <= 0) throw new Error("Valid amount required");
      return postCreditNote(session!, folio.id, {
        entryId: entry.id,
        description: chargeDescription.trim() || "Credit note",
        amount,
        creditDate: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Credit note posted");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Credit note failed");
    },
  });

  const createH4Mutation = useMutation({
    mutationFn: () => createH4Handoff(session!, entry.id, { notes: "S7 pre-checkout coordination" }),
    onSuccess: () => {
      setActionError(null);
      toast.success("H4 pre-checkout handoff created");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "H4 creation failed");
    },
  });

  const acceptH4Mutation = useMutation({
    mutationFn: () => {
      if (!h4) throw new Error("No H4");
      const completion: Record<string, boolean> = {};
      for (const item of h4ChecklistItems) {
        completion[item.code] = h4Checklist[item.code] === true;
      }
      return acceptHandoff(session!, h4.id, completion);
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("H4 accepted");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "H4 accept failed");
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

  const nightAuditRunMutation = useMutation({
    mutationFn: () => runNightAudit(session!, `${nightAuditDate}T00:00:00.000Z`),
    onSuccess: (rec) => {
      setActionError(null);
      toast.success(`Night audit ${rec.runStatus} for ${nightAuditDate}`);
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Night audit failed");
    },
  });

  const openDisputeMutation = useMutation({
    mutationFn: () => {
      if (!folio?.id) throw new Error("No folio");
      return openDispute(session!, {
        entryId: entry.id,
        folioId: folio.id,
        title: disputeTitle.trim(),
        description: disputeDescription.trim() || undefined,
      });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Dispute opened");
      setDisputeTitle("");
      setDisputeDescription("");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Open dispute failed");
    },
  });

  const amendMutation = useMutation({
    mutationFn: () => {
      const segmentId = entry.segments?.[0]?.id;
      if (!segmentId) throw new Error("No segment on entry");
      return amendEntry(session!, entry.id, {
        amendmentType: amendType,
        segmentId,
        amendmentPath: amendPath,
        requestedBy: session!.userId,
        authorisedBy: session!.userId,
        authorityBasis: "FOM mid-stay amendment",
        reason: amendReason.trim(),
        newTermsSummary: amendNewTerms.trim(),
        stageAtAmendment: "S7",
      });
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Amendment recorded");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Amendment failed");
    },
  });

  const roomChangeMutation = useMutation({
    mutationFn: () =>
      roomChangeReEnterS1(session!, entry.id, {
        newRoomId: roomChangeId.trim(),
        reason: roomChangeReason.trim(),
      }),
    onSuccess: () => {
      setActionError(null);
      toast.success("Room change — entry re-entered at S1 for new segment");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Room change failed");
    },
  });

  const deficientFinalizeMutation = useMutation({
    mutationFn: ({
      id,
      status,
      notes,
    }: {
      id: string;
      status: "RESOLVED" | "UNRESOLVED";
      notes?: string;
    }) => finalizeDeficientCondition(session!, id, { status, resolutionNotes: notes }),
    onSuccess: () => {
      setActionError(null);
      toast.success("DEFICIENT status updated");
      invalidate();
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "DEFICIENT update failed");
    },
  });

  const openDisputes = disputes.filter((d) => d.status === "OPEN" || d.status === "IN_PROGRESS");
  const deficientNeedsFinal = deficientRecords.some((d) => !terminalDeficientStatus(d.status));
  const nightAuditOk = nightAuditQuery.data?.runStatus === "COMPLETE";
  const hasCharges = folioLines.length > 0;
  const folioLive = folio?.state === "LIVE";
  const folioPayments = (folio?.payments ?? []) as PaymentRecordSummary[];
  const folioWriteOffs = folio?.writeOffRecords ?? [];
  const folioLedger = useMemo(
    () => computeFolioLedger(folio, folioLines, folioPayments, folioWriteOffs),
    [folio, folioLines, folioPayments, folioWriteOffs],
  );
  const hasFolioLedgerRows =
    folioLines.length > 0 || folioPayments.length > 0 || folioWriteOffs.length > 0;
  const displayOutstanding = folioOutstandingForDisplay(folioLedger, hasFolioLedgerRows);
  const selectedCorrectLine = folioLines.find((l) => l.id === correctLineId);
  const correctionPreview = useMemo(() => {
    const value = Number.parseFloat(correctionInput);
    if (!selectedCorrectLine || !Number.isFinite(value)) return null;
    const original = Number.parseFloat(String(selectedCorrectLine.amount));
    if (!Number.isFinite(original)) return null;
    if (correctionMode === "ADJUST") {
      return { original, delta: value, targetNet: original + value, mode: "ADJUST" as const };
    }
    return { original, delta: value - original, targetNet: value, mode: "SET_NET" as const };
  }, [correctionInput, correctionMode, selectedCorrectLine]);

  const correctableLines = useMemo(
    () =>
      folioLines.filter(
        (l) =>
          !l.description.toLowerCase().startsWith("sales tax") &&
          !l.description.toLowerCase().startsWith("correction for"),
      ),
    [folioLines],
  );

  const h4MandatoryComplete = h4ChecklistItems
    .filter((i) => i.mandatory)
    .every((i) => h4Checklist[i.code] === true);

  const s7ExitChecks = useMemo(
    () => [
      {
        label: "Folio LIVE",
        ok: folioLive,
        detail: folio?.state,
      },
      {
        label: "Night audit complete (final stay night)",
        ok: nightAuditOk,
        detail: lastNightYmd ? `${lastNightYmd}: ${nightAuditQuery.data?.runStatus ?? "not run"}` : "Set checkout date",
      },
      {
        label: "Charges posted to folio",
        ok: hasCharges,
        detail: `${folioLines.length} line(s)`,
      },
      {
        label: "H4 pre-checkout initiated",
        ok: h4Initiated(h4),
        detail: h4 ? h4.state : "Create H4 before exit",
      },
      {
        label: "DEFICIENT final status (if any)",
        ok: deficientRecords.length === 0 || !deficientNeedsFinal,
        detail:
          deficientRecords.length === 0
            ? "None on room"
            : deficientNeedsFinal
              ? "Resolve or mark UNRESOLVED"
              : "All terminal",
      },
      {
        label: "No blocking open disputes (review)",
        ok: openDisputes.length === 0,
        detail: openDisputes.length > 0 ? `${openDisputes.length} open — GM override may be required` : undefined,
      },
    ],
    [
      folioLive,
      folio?.state,
      nightAuditOk,
      lastNightYmd,
      nightAuditQuery.data?.runStatus,
      hasCharges,
      folioLines.length,
      h4,
      deficientRecords.length,
      deficientNeedsFinal,
      openDisputes.length,
    ],
  );

  const canProgressS8 = s7ExitChecks.every((c) => c.ok);

  // Stage-mismatch gate removed — ReadOnlyShell handles past/future stage viewing.

  return (
    <StagePanel meta={meta}>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">In-stay context</CardTitle>
            <CardDescription>
              SIG-S7 — live folio, daily night audit, H4 before checkout, governed exit to S8.
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
                {folioLedger.currency} {displayOutstanding.toFixed(2)}
              </strong>
              {folio?.advancePaymentReconciliationComplete && (
                <Badge variant="outline" className="ml-2">
                  Advance reconciled
                </Badge>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Charges {folioLedger.lineTotal.toFixed(2)} − payments in {folioLedger.paymentsIn.toFixed(2)}
                {folioLedger.paymentsOut > 0 ? ` + refunds ${folioLedger.paymentsOut.toFixed(2)}` : ""}
                {folioLedger.writeOffTotal > 0
                  ? ` − write-offs ${folioLedger.writeOffTotal.toFixed(2)}`
                  : ""}
                {folioLedger.storedOutstanding != null &&
                Math.abs(folioLedger.storedOutstanding - folioLedger.computedOutstanding) > 0.01
                  ? ` (folio stored ${folioLedger.storedOutstanding.toFixed(2)})`
                  : ""}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Stay:</span>{" "}
              {reservation?.frozenCheckInDate?.slice(0, 10) ?? "—"} →{" "}
              {reservation?.frozenCheckOutDate?.slice(0, 10) ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Billing:</span> {folio?.billingModel ?? "—"}
            </div>
            {latestAssignment?.room?.roomNumber && (
              <div>
                <span className="text-muted-foreground">Room:</span> {latestAssignment.room.roomNumber}{" "}
                <Badge variant="outline">OCCUPIED</Badge>
              </div>
            )}
            {entry.keysIssuedCount != null && (
              <div>
                <span className="text-muted-foreground">Keys issued:</span> {entry.keysIssuedCount}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Receipt className="h-4 w-4" />
              Folio charges (live)
            </CardTitle>
            <CardDescription>Post point-of-service charges — lines are immutable; use corrections for fixes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!folioLive && (
              <p className="text-sm text-destructive">Folio must be LIVE (complete S6 check-in first).</p>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Line type</span>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={chargeLineType}
                  onChange={(e) => setChargeLineType(e.target.value)}
                >
                  <option value="F_AND_B">F &amp; B</option>
                  <option value="SERVICE">Service</option>
                  <option value="OTHER">Other</option>
                </select>
              </label>
              <label className="space-y-1 text-sm sm:col-span-2">
                <span className="text-muted-foreground">Description</span>
                <Input value={chargeDescription} onChange={(e) => setChargeDescription(e.target.value)} />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Amount (BTN)</span>
                <Input value={chargeAmount} onChange={(e) => setChargeAmount(e.target.value)} type="number" min={0} step="0.01" />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Charge date</span>
                <Input type="date" value={chargeDate} onChange={(e) => setChargeDate(e.target.value)} />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={postChargeMutation.isPending || !folioLive}
                onClick={() => postChargeMutation.mutate()}
              >
                Post charge
              </Button>
              {isElevated(session?.actorLevel ?? "L1") && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={creditNoteMutation.isPending || !folioLive}
                  onClick={() => creditNoteMutation.mutate()}
                >
                  Post credit note (L2+)
                </Button>
              )}
            </div>

            {folioLines.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                      <th className="p-2">ID</th>
                      <th className="p-2">Type</th>
                      <th className="p-2">Description</th>
                      <th className="p-2">Amount</th>
                      <th className="p-2">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {folioLines.map((line) => (
                      <tr key={line.id} className="border-b last:border-0">
                        <td className="p-2 font-mono text-xs">{formatListId(line.id)}</td>
                        <td className="p-2">{line.lineType}</td>
                        <td className="p-2">{line.description}</td>
                        <td className="p-2">
                          {line.currency} {String(line.amount)}
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">
                          {line.chargeDate?.slice(0, 10)}
                          {line.nightAuditRecordId && " · audit"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                        {p.notes ? ` — ${p.notes}` : ""}
                      </span>
                      <span className="font-mono">
                        {p.currency} {String(p.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-2 rounded-lg border border-dashed p-3">
              <p className="text-xs font-medium text-muted-foreground">
                Correct a posted charge. Use Adjust by for ± amounts (e.g. −50 on a 200 line). Use Set net to
                only when you want the final charge amount (e.g. 150). Sales tax
                adjusts automatically. Pick the original charge, not a prior correction row.
              </p>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="correctionMode"
                    checked={correctionMode === "ADJUST"}
                    onChange={() => {
                      setCorrectionMode("ADJUST");
                      setCorrectionInput("");
                    }}
                  />
                  Adjust by ±
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="correctionMode"
                    checked={correctionMode === "SET_NET"}
                    onChange={() => {
                      setCorrectionMode("SET_NET");
                      const line = folioLines.find((l) => l.id === correctLineId);
                      setCorrectionInput(line ? String(line.amount) : "");
                    }}
                  />
                  Set net to
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <select
                  className="h-9 min-w-[200px] flex-1 rounded-md border border-input bg-background px-3 text-sm"
                  value={correctLineId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setCorrectLineId(id);
                    setCorrectionInput("");
                    if (correctionMode === "SET_NET") {
                      const line = folioLines.find((l) => l.id === id);
                      if (line) setCorrectionInput(String(line.amount));
                    }
                  }}
                >
                  <option value="">Select line…</option>
                  {correctableLines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.lineType} — {l.description} ({String(l.amount)})
                    </option>
                  ))}
                </select>
                <Input
                  className="max-w-[140px]"
                  placeholder={correctionMode === "ADJUST" ? "e.g. -50" : "e.g. 150"}
                  value={correctionInput}
                  onChange={(e) => setCorrectionInput(e.target.value)}
                />
                <Input
                  className="min-w-[160px] flex-1"
                  placeholder="Reason"
                  value={correctReason}
                  onChange={(e) => setCorrectReason(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={correctMutation.isPending}
                  onClick={() => correctMutation.mutate()}
                >
                  Post correction
                </Button>
              </div>
              {correctionPreview && (
                <p className="text-xs text-muted-foreground">
                  {correctionMode === "ADJUST" ? (
                    <>
                      Charge {correctionPreview.original.toFixed(2)} {correctionPreview.delta >= 0 ? "+" : ""}
                      {correctionPreview.delta.toFixed(2)} → net{" "}
                      {correctionPreview.targetNet.toFixed(2)}. Folio offset line:{" "}
                      {correctionPreview.delta >= 0 ? "+" : ""}
                      {correctionPreview.delta.toFixed(2)} BTN
                    </>
                  ) : (
                    <>
                      Charge {correctionPreview.original.toFixed(2)} → net{" "}
                      {correctionPreview.targetNet.toFixed(2)}. Folio offset line:{" "}
                      {correctionPreview.delta >= 0 ? "+" : ""}
                      {correctionPreview.delta.toFixed(2)} BTN
                    </>
                  )}
                  {correctionPreview.delta === 0 ? " (no change)" : ""}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Moon className="h-4 w-4" />
              Night audit
            </CardTitle>
            <CardDescription>
              Mandatory for each operating day. Final-night audit must be COMPLETE before S7→S8.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <span className="text-muted-foreground">Final stay night:</span>{" "}
              <strong>{lastNightYmd || "—"}</strong>
              {nightAuditQuery.data && (
                <StatusBadge status={nightAuditQuery.data.runStatus} className="ml-2" />
              )}
            </div>
            {isElevated(session?.actorLevel ?? "L1") && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">Run for date (L2+)</span>
                  <Input type="date" value={nightAuditDate} onChange={(e) => setNightAuditDate(e.target.value)} />
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={nightAuditRunMutation.isPending}
                  onClick={() => nightAuditRunMutation.mutate()}
                >
                  Run night audit
                </Button>
              </div>
            )}
            {!isElevated(session?.actorLevel ?? "L1") && (
              <p className="text-xs text-muted-foreground">Night audit run requires FOM (L2+).</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Handshake className="h-4 w-4" />
              Handoffs — H2, H3, H4
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-4">
              {h2 && (
                <span>
                  H2 (HK): <Badge variant="outline">{h2.state}</Badge>
                </span>
              )}
              {h3 && (
                <span>
                  H3 (F&amp;B): <Badge variant="outline">{h3.state}</Badge>
                </span>
              )}
            </div>

            <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
              <p className="font-medium">H4 — pre-checkout coordination</p>
              {!h4 ? (
                <Button size="sm" variant="outline" disabled={createH4Mutation.isPending} onClick={() => createH4Mutation.mutate()}>
                  Initiate H4
                </Button>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">{formatListId(h4.id)}</span>
                    <Badge variant="outline">{h4.state}</Badge>
                    {h4.isAutoFulfilled && <Badge variant="secondary">Auto-fulfilled</Badge>}
                  </div>
                  {h4.state === "CREATED" && h4ChecklistItems.length > 0 && (
                    <div className="space-y-2">
                      {h4ChecklistItems.map((item) => (
                        <label key={item.code} className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={h4Checklist[item.code] === true}
                            onChange={(e) =>
                              setH4Checklist((prev) => ({ ...prev, [item.code]: e.target.checked }))
                            }
                          />
                          <span>{item.description ?? item.code}</span>
                        </label>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={acceptH4Mutation.isPending || !h4MandatoryComplete}
                        onClick={() => acceptH4Mutation.mutate()}
                      >
                        Accept H4
                      </Button>
                    </div>
                  )}
                  {h4.state === "ACCEPTED" && (
                    <div className="space-y-2">
                      <label className="block text-xs text-muted-foreground">
                        DEFICIENT flag final status (fulfilment evidence)
                      </label>
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
            </div>
          </CardContent>
        </Card>

        {deficientRecords.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4" />
                DEFICIENT conditions
              </CardTitle>
              <CardDescription>Record RESOLVED or UNRESOLVED before checkout — required for S7→S8.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {deficientRecords.map((d) => (
                <div key={d.id} className="rounded-lg border p-3 text-sm">
                  <div className="font-mono text-xs text-muted-foreground">{formatListId(d.id)}</div>
                  <p className="mt-1 font-medium">
                    {d.category}: {d.description}
                  </p>
                  <StatusBadge status={d.status} className="mt-2" />
                  {!terminalDeficientStatus(d.status) && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={deficientFinalizeMutation.isPending}
                        onClick={() =>
                          deficientFinalizeMutation.mutate({
                            id: d.id,
                            status: "RESOLVED",
                            notes: "Resolved during stay",
                          })
                        }
                      >
                        Mark resolved
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={deficientFinalizeMutation.isPending}
                        onClick={() =>
                          deficientFinalizeMutation.mutate({
                            id: d.id,
                            status: "UNRESOLVED",
                            notes: "Unresolved — will carry to checkout",
                          })
                        }
                      >
                        Mark unresolved (checkout)
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Scale className="h-4 w-4" />
              Disputes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {disputes.length > 0 && (
              <ul className="space-y-2">
                {disputes.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 rounded border px-3 py-2">
                    <span className="font-mono text-xs">{formatListId(d.id)}</span>
                    <strong>{d.title}</strong>
                    <StatusBadge status={d.status} />
                    {d.status === "OPEN" && isElevated(session?.actorLevel ?? "L1") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => progressDispute(session!, d.id, "IN_PROGRESS").then(invalidate)}
                      >
                        Start review
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <Input placeholder="Dispute title" value={disputeTitle} onChange={(e) => setDisputeTitle(e.target.value)} />
              <Input
                placeholder="Description (optional)"
                value={disputeDescription}
                onChange={(e) => setDisputeDescription(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={openDisputeMutation.isPending || !disputeTitle.trim()}
              onClick={() => openDisputeMutation.mutate()}
            >
              Open dispute
            </Button>
          </CardContent>
        </Card>

        {isElevated(session?.actorLevel ?? "L1") && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileEdit className="h-4 w-4" />
                Amendments &amp; room change (L2+)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={amendType}
                  onChange={(e) => setAmendType(e.target.value)}
                >
                  <option value="INCLUSION_CHANGE">Inclusion change</option>
                  <option value="MEAL_PLAN_CHANGE">Meal plan change</option>
                  <option value="DISCOUNT">Discount</option>
                </select>
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={amendPath}
                  onChange={(e) => setAmendPath(e.target.value as "PATH_2")}
                >
                  <option value="PATH_2">Path 2 — folio adjustment</option>
                </select>
                <Input
                  className="sm:col-span-2"
                  placeholder="Reason"
                  value={amendReason}
                  onChange={(e) => setAmendReason(e.target.value)}
                />
                <Input
                  className="sm:col-span-2"
                  placeholder="New terms summary"
                  value={amendNewTerms}
                  onChange={(e) => setAmendNewTerms(e.target.value)}
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={amendMutation.isPending || !amendReason.trim() || !amendNewTerms.trim()}
                onClick={() => amendMutation.mutate()}
              >
                Record amendment
              </Button>

              <div className="space-y-2 rounded-lg border border-dashed p-3">
                <p className="text-xs font-medium text-muted-foreground">Room change (S7→S1 re-entry)</p>
                <div className="flex flex-wrap gap-2">
                  <select
                    className="h-9 min-w-[140px] flex-1 rounded-md border border-input bg-background px-3 text-sm"
                    value={roomChangeId}
                    onChange={(e) => setRoomChangeId(e.target.value)}
                  >
                    <option value="">New room…</option>
                    {(roomsCatalogQuery.data?.items ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.roomNumber}
                      </option>
                    ))}
                  </select>
                  <Input
                    className="min-w-[160px] flex-1"
                    placeholder="Reason"
                    value={roomChangeReason}
                    onChange={(e) => setRoomChangeReason(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={roomChangeMutation.isPending || !roomChangeId || !roomChangeReason.trim()}
                    onClick={() => roomChangeMutation.mutate()}
                  >
                    <BedDouble className="mr-1 h-4 w-4" />
                    Change room
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="h-4 w-4" />
              Exit to checkout prep (S7 → S8)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2">
              {s7ExitChecks.map((check) => (
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
              targetStage="S8"
              label="Begin checkout prep → S8"
              disabled={!canProgressS8}
              navigateOnSuccess
            />
            {!canProgressS8 && (
              <p className="text-xs text-muted-foreground">
                Complete all exit conditions. Open disputes may require GM gate override before progression.
              </p>
            )}
          </CardContent>
        </Card>

        <ApiErrorAlert error={actionError} />
      </div>
    </StagePanel>
  );
}
