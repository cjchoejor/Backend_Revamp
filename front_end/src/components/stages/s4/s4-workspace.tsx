"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  Circle,
  FileCheck2,
  Handshake,
  Shield,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StagePanel } from "@/components/stages/shared/stage-panel";
import { ApiErrorAlert } from "@/components/stages/shared/api-error-alert";
import { ProgressStageButton } from "@/components/stages/shared/progress-stage-button";
import { useStageTransition } from "@/components/stages/shared/stage-transition-context";
import { activatePreArrival } from "@/lib/api/pre-arrival";
import { STAGES, stagePath } from "@/config/stages";
import { acknowledgeMultiBooking, verifyConference } from "@/lib/api/confirmation";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { formatListId } from "@/lib/readable-id";
import type {
  CommittedHoldSummary,
  EntryDetail,
  HandoffSummary,
  ReservationSummary,
} from "@/types/api";

type S4WorkspaceProps = {
  entry: EntryDetail;
};

function isElevated(level: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

function formatMoney(v: string | number) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2 }) : String(v);
}

export function S4Workspace({ entry }: S4WorkspaceProps) {
  const router = useRouter();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const { startTransition, endTransition } = useStageTransition();
  const meta = STAGES[3];

  const reservation = entry.reservation as ReservationSummary | null | undefined;
  const hold = entry.committedHold as CommittedHoldSummary | null | undefined;
  const handoffs = (entry.handoffs ?? []) as HandoffSummary[];
  const h1Handoffs = handoffs.filter((h) => h.handoffType === "H1");

  const acceptedQuotation = useMemo(
    () => (entry.quotations ?? []).find((q) => q.state === "ACCEPTED"),
    [entry.quotations],
  );

  const [multiBookingNote, setMultiBookingNote] = useState("");
  const [conferenceChecklist, setConferenceChecklist] = useState(
    JSON.stringify({ hallConfirmed: true, seatingConfirmed: true, fnbConfirmed: true }, null, 0),
  );
  const [actionError, setActionError] = useState<unknown>(null);

  type CustodianSignOff = {
    reviewedSnapshot: boolean;
    reviewedVoucherDispatch: boolean;
    reviewedH1Handoff: boolean;
    understoodPreArrivalActivation: boolean;
  };

  const signOffStorageKey = `s4-custodian-signoff-${entry.id}`;
  const [custodianSignOff, setCustodianSignOff] = useState<CustodianSignOff>({
    reviewedSnapshot: false,
    reviewedVoucherDispatch: false,
    reviewedH1Handoff: false,
    understoodPreArrivalActivation: false,
  });

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(signOffStorageKey);
      if (raw) setCustodianSignOff(JSON.parse(raw) as CustodianSignOff);
    } catch {
      /* ignore */
    }
  }, [signOffStorageKey]);

  useEffect(() => {
    sessionStorage.setItem(signOffStorageKey, JSON.stringify(custodianSignOff));
  }, [custodianSignOff, signOffStorageKey]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });

  const multiBookingMutation = useMutation({
    mutationFn: () => acknowledgeMultiBooking(session!, entry.id, multiBookingNote.trim() || undefined),
    onSuccess: () => {
      setActionError(null);
      toast.success("Multi-booking overlap acknowledged");
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Acknowledgement failed");
    },
  });

  const activateS5Mutation = useMutation({
    mutationFn: () => {
      startTransition({ targetStage: "S5", label: "Activating pre-arrival…" });
      return activatePreArrival(session!, entry.id);
    },
    onSuccess: (updated) => {
      setActionError(null);
      queryClient.setQueryData(["entry", entry.id], updated);
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
      toast.success("Pre-arrival activated — now at S5");
      router.push(stagePath(entry.id, "S5"));
    },
    onError: (e) => {
      endTransition();
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Activation failed");
    },
  });

  const conferenceMutation = useMutation({
    mutationFn: () => {
      let checklist: unknown = { verified: true };
      try {
        checklist = JSON.parse(conferenceChecklist);
      } catch {
        checklist = { raw: conferenceChecklist };
      }
      return verifyConference(session!, entry.id, checklist);
    },
    onSuccess: () => {
      setActionError(null);
      toast.success("Conference verification recorded");
    },
    onError: (e) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Verification failed");
    },
  });

  const s3Readiness = useMemo(
    () => [
      { label: "Committed hold (PLACED)", ok: hold?.state === "PLACED" },
      { label: "Provisional folio + billing model", ok: !!entry.folio?.billingModel },
      { label: "Cancellation disclosure", ok: !!entry.cancellationDisclosure },
      { label: "Accepted quotation", ok: !!acceptedQuotation },
      { label: "Guest contact", ok: !!(entry.guestProfile?.email || entry.guestProfile?.phone) },
    ],
    [entry, hold, acceptedQuotation],
  );

  const canConfirm = s3Readiness.every((c) => c.ok) && entry.currentStage === "S3";

  const snapshotComplete = useMemo(() => {
    if (!reservation) return false;
    return (
      reservation.frozenRate != null &&
      !!reservation.frozenRatePlanId &&
      !!reservation.frozenBillingModel &&
      !!reservation.frozenCheckInDate &&
      !!reservation.frozenCheckOutDate &&
      reservation.frozenGuestCount != null
    );
  }, [reservation]);

  const s4SystemOutcomes = useMemo(
    () => [
      {
        label: "Reservation snapshot (frozen commercial terms)",
        ok: snapshotComplete,
        detail: "Set automatically when you confirm at S3→S4",
      },
      {
        label: "Committed hold CONFIRMED",
        ok: hold?.state === "CONFIRMED",
        detail: "Inventory locked at confirmation",
      },
      {
        label: "Confirmation voucher generated & dispatched",
        ok: reservation?.confirmationVoucherSent === true,
        detail: "Communication record created at confirmation",
      },
      {
        label: "H1 handoff (ownership) at S4",
        ok: h1Handoffs.length > 0,
        detail: h1Handoffs[0]?.state ? `State: ${h1Handoffs[0].state}` : undefined,
      },
    ],
    [snapshotComplete, hold, reservation, h1Handoffs],
  );

  const custodianSignOffItems = useMemo(
    () => [
      {
        key: "reviewedSnapshot" as const,
        label: "I have reviewed the frozen rate, billing model, dates, and guest count",
      },
      {
        key: "reviewedVoucherDispatch" as const,
        label: "I have verified the confirmation voucher was sent to the correct guest/agent channel",
      },
      {
        key: "reviewedH1Handoff" as const,
        label: "I have reviewed the H1 handoff and operational ownership for this stay",
      },
      {
        key: "understoodPreArrivalActivation" as const,
        label:
          "I understand S5 opens via the pre-arrival countdown (W4), not manual stage progression — same-day arrivals may activate immediately",
      },
    ],
    [],
  );

  const custodianSignOffComplete = custodianSignOffItems.every((item) => custodianSignOff[item.key]);
  const systemOutcomesComplete = s4SystemOutcomes.every((c) => c.ok);

  if (entry.currentStage !== "S3" && entry.currentStage !== "S4") {
    return (
      <StagePanel meta={meta}>
        <Card>
          <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-medium">Entry is at {entry.currentStage}</p>
            <Button variant="gradient" asChild>
              <Link href={stagePath(entry.id, entry.currentStage)}>
                Open {entry.currentStage}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </StagePanel>
    );
  }

  return (
    <StagePanel meta={meta}>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Confirmation context</CardTitle>
            <CardDescription>
              SIG-S4 — commitment boundary: freeze terms, lock inventory, voucher, ownership (H1).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Stay:</span> {entry.checkInDate?.slice(0, 10) ?? "—"} →{" "}
              {entry.checkOutDate?.slice(0, 10) ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Billing:</span> {entry.folio?.billingModel ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Hold:</span> {hold?.state ?? "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Stage:</span> {entry.currentStage}
            </div>
          </CardContent>
        </Card>

        {entry.currentStage === "S3" && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Pre-confirmation gates</CardTitle>
                <CardDescription>Complete before confirming (SIG-S4 policies).</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {s3Readiness.map((item) => (
                  <div key={item.label} className="flex items-center gap-2 text-sm">
                    {item.ok ? (
                      <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
                    ) : (
                      <Circle className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span>{item.label}</span>
                  </div>
                ))}

                {session && isElevated(session.actorLevel) && (
                  <div className="space-y-4 border-t pt-4">
                    <p className="text-xs font-medium text-muted-foreground">FOM+ prerequisites</p>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Multi-booking acknowledgement note</label>
                      <Input
                        value={multiBookingNote}
                        onChange={(e) => setMultiBookingNote(e.target.value)}
                        placeholder="Separate engagements confirmed"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={multiBookingMutation.isPending}
                        onClick={() => multiBookingMutation.mutate()}
                      >
                        Acknowledge multi-booking overlap
                      </Button>
                    </div>
                    {entry.useType === "CONFERENCE" && (
                      <div className="space-y-2">
                        <label className="text-xs text-muted-foreground">Conference verification (JSON checklist)</label>
                        <Input
                          value={conferenceChecklist}
                          onChange={(e) => setConferenceChecklist(e.target.value)}
                          className="font-mono text-xs"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={conferenceMutation.isPending}
                          onClick={() => conferenceMutation.mutate()}
                        >
                          Record conference verification
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-primary/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <BadgeCheck className="h-4 w-4" />
                  Confirm reservation
                </CardTitle>
                <CardDescription>
                  Runs full S4 confirmation: snapshot, hold CONFIRMED, voucher, H1 handoff, entry → S4.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!canConfirm && (
                  <p className="mb-4 text-sm text-muted-foreground">
                    Finish S3 setup (folio, disclosure, payment, committed hold) on the S3 workspace first.
                  </p>
                )}
                <ProgressStageButton
                  entryId={entry.id}
                  version={entry.version}
                  targetStage="S4"
                  label="Confirm reservation → S4"
                  disabled={!canConfirm}
                />
              </CardContent>
            </Card>
          </>
        )}

        {entry.currentStage === "S4" && reservation && (
          <Card className="border-[var(--success)]/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileCheck2 className="h-4 w-4 text-[var(--success)]" />
                Commitment snapshot
              </CardTitle>
              <CardDescription>Frozen at confirmation — read-only</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="sm:col-span-2">
                <span className="text-muted-foreground">Reservation ID:</span>{" "}
                <span className="font-mono text-xs">{formatListId(reservation.id)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Frozen rate:</span> BTN {formatMoney(reservation.frozenRate)}
              </div>
              <div>
                <span className="text-muted-foreground">Rate plan:</span>{" "}
                <span className="font-mono text-xs">{reservation.frozenRatePlanId.slice(0, 16)}…</span>
              </div>
              <div>
                <span className="text-muted-foreground">Billing model:</span> {reservation.frozenBillingModel}
              </div>
              <div>
                <span className="text-muted-foreground">Guests:</span> {reservation.frozenGuestCount}
              </div>
              <div>
                <span className="text-muted-foreground">Confirmed:</span> {reservation.confirmedAt.slice(0, 16)}
              </div>
              <div>
                <span className="text-muted-foreground">Voucher sent:</span>{" "}
                {reservation.confirmationVoucherSent ? (
                  <Badge className="bg-[var(--success)]/15 text-[var(--success)]">Yes</Badge>
                ) : (
                  <Badge variant="outline">No</Badge>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {entry.currentStage === "S4" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Handshake className="h-4 w-4" />
                H1 handoff (ownership)
              </CardTitle>
              <CardDescription>Created at confirmation — accepted at S5</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {h1Handoffs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No H1 handoff on record.</p>
              ) : (
                h1Handoffs.map((h) => (
                  <div key={h.id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
                    <span>
                      {h.handoffType} · {h.fromRole} → {h.toRole}
                    </span>
                    <Badge>{h.state}</Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        )}

        {entry.currentStage === "S4" && session && isElevated(session.actorLevel) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">FOM+ gates (before / at confirmation)</CardTitle>
              <CardDescription>
                Required by policy before S3→S4 confirm if overlap or conference applies.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Multi-booking acknowledgement note</label>
                <Input
                  value={multiBookingNote}
                  onChange={(e) => setMultiBookingNote(e.target.value)}
                  placeholder="Separate engagements confirmed"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={multiBookingMutation.isPending}
                  onClick={() => multiBookingMutation.mutate()}
                >
                  Acknowledge multi-booking overlap
                </Button>
              </div>
              {entry.useType === "CONFERENCE" && (
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Conference verification (JSON checklist)</label>
                  <Input
                    value={conferenceChecklist}
                    onChange={(e) => setConferenceChecklist(e.target.value)}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={conferenceMutation.isPending}
                    onClick={() => conferenceMutation.mutate()}
                  >
                    Record conference verification
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {entry.currentStage === "S4" && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Confirmation outcomes (system)</CardTitle>
                <CardDescription>
                  These are recorded when you confirm at S3 — not a manual tick list. Review them, then complete
                  custodian sign-off below.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {s4SystemOutcomes.map((item) => (
                  <div key={item.label} className="space-y-0.5">
                    <div className="flex items-center gap-2 text-sm">
                      {item.ok ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" />
                      ) : (
                        <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span>{item.label}</span>
                    </div>
                    {item.detail && <p className="pl-6 text-xs text-muted-foreground">{item.detail}</p>}
                  </div>
                ))}
                {!systemOutcomesComplete && (
                  <p className="text-sm text-destructive">
                    Confirmation data is incomplete — contact support or re-confirm from S3 if policy allows.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="border-primary/30">
              <CardHeader>
                <CardTitle className="text-base">Custodian sign-off (required)</CardTitle>
                <CardDescription>
                  SIG-S4 §1.5 — staff must verify commitment outcomes before pre-arrival (S5) work begins.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {custodianSignOffItems.map((item) => (
                  <label key={item.key} className="flex cursor-pointer items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border"
                      checked={custodianSignOff[item.key]}
                      onChange={(e) =>
                        setCustodianSignOff((prev) => ({ ...prev, [item.key]: e.target.checked }))
                      }
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Pre-arrival → S5</CardTitle>
                <CardDescription>
                  There is no manual S4→S5 progress-stage action. The PRE_ARRIVAL_COUNTDOWN (W4) worker moves the
                  entry to S5 when the window opens (same-day check-in may fire immediately).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Check-in date: {entry.checkInDate?.slice(0, 10) ?? "—"}. This runs the W4 pre-arrival activation
                  (moves the entry to S5 and seeds tasks). Same-day arrivals activate immediately.
                </p>
                {custodianSignOffComplete && systemOutcomesComplete ? (
                  <Button
                    variant="gradient"
                    disabled={activateS5Mutation.isPending}
                    onClick={() => activateS5Mutation.mutate()}
                  >
                    {activateS5Mutation.isPending ? "Activating…" : "Activate pre-arrival → S5"}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                ) : (
                  <Button variant="gradient" disabled>
                    Activate pre-arrival → S5
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                )}
                {(!custodianSignOffComplete || !systemOutcomesComplete) && (
                  <p className="text-xs text-muted-foreground">
                    Complete custodian sign-off and ensure system outcomes are green before opening S5.
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <ApiErrorAlert error={actionError} />

        {entry.currentStage === "S3" && (
          <Card>
            <CardContent className="p-4">
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={stagePath(entry.id, "S3")}
                  onClick={() =>
                    startTransition({
                      targetStage: "S3",
                      label: "Back to reservation setup…",
                    })
                  }
                >
                  <Shield className="mr-2 h-4 w-4" />
                  Back to S3 setup
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </StagePanel>
  );
}
