"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getEntry } from "@/lib/api/entries";
import { useSession } from "@/hooks/use-session";
import { Skeleton } from "@/components/ui/skeleton";
import { NewInquiryForm } from "@/components/inquiries/new-inquiry-form";
import { S1Workspace } from "@/components/stages/s1/s1-workspace";
import { S2Workspace } from "@/components/stages/s2/s2-workspace";
import { EntryDetailProvider } from "@/components/stages/shared/entry-detail-context";
import { StageTransitionProvider } from "@/components/stages/shared/stage-transition-context";
import { StepCard } from "./step-card";
import { BookingContextBar } from "./booking-context-bar";
import { BookingFlowProvider } from "./booking-flow-context";
import { BookingTimerPanel } from "./booking-timer-panel";
import { EntryTracePanel } from "@/components/stages/shared/entry-trace-panel";
import type { EntryDetail, AvailabilityConfigSummary, QuotationSummary } from "@/types/api";

type ActiveStep = 1 | 2 | 3;

/**
 * Unified booking flow at /inquiries/new — replaces the previous standalone inquiry intake.
 *
 * Three steps stacked vertically as collapsible cards:
 *   1. Guest & inquiry intake     (NewInquiryForm)
 *   2. Availability — find a room (S1Workspace)
 *   3. Quotation — quote & accept (S2Workspace)
 *
 * The orchestrator owns:
 *   - The created entry's id (after step 1)
 *   - Which step is currently expanded
 *   - Detection of completion signals to auto-advance:
 *       step 2 → 3 once a sealed preferred availability config exists
 *       step 3 → /entries/{id}/stages/s3 once entry.currentStage advances past S2
 *
 * Workspaces are wrapped in <BookingFlowProvider> which causes ProgressStageButton to skip
 * router.push (so we stay on this page); auto-advance happens via entry state changes.
 */
export function BookingFlow() {
  const router = useRouter();
  const { session } = useSession();

  const [entryId, setEntryId] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<ActiveStep>(1);
  // When the operator clicks Edit on a completed step, we expand THAT step (and hold the
  // others in their natural state — completed steps stay completed).
  const [forceEdit, setForceEdit] = useState<ActiveStep | null>(null);

  const entryQuery = useQuery({
    queryKey: ["entry", entryId],
    queryFn: () => getEntry(session!, entryId!),
    enabled: !!entryId && !!session,
    refetchInterval: activeStep === 2 ? 4000 : false,
  });
  const entry = entryQuery.data ?? null;

  // -------------- Completion detection ----------------
  const sealedConfig = useMemo<AvailabilityConfigSummary | null>(() => {
    if (!entry) return null;
    return (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected) ?? null;
  }, [entry]);
  const acceptedQuotation = useMemo<QuotationSummary | null>(() => {
    if (!entry) return null;
    return (entry.quotations ?? []).find((q) => q.state === "ACCEPTED") ?? null;
  }, [entry]);
  const step1Done = !!entryId;
  // Step 2 is "done" only after the entry has actually advanced past S1 (the operator clicked
  // "Progress to S2"). Sealing a preferred config alone is NOT enough — without the stage
  // advance, S2 quotation actions would fail backend guards.
  const step2Done =
    !!entry &&
    !!sealedConfig &&
    entry.currentStage !== "S1";
  const step3Done =
    acceptedQuotation != null ||
    (entry?.currentStage !== undefined && entry.currentStage !== "S1" && entry.currentStage !== "S2");

  // ---------- Auto-advance ----------
  useEffect(() => {
    if (forceEdit) return; // user is editing a past step — don't auto-advance
    if (step1Done && step2Done && activeStep < 3) setActiveStep(3);
    else if (step1Done && !step2Done && activeStep < 2) setActiveStep(2);
  }, [step1Done, step2Done, activeStep, forceEdit]);

  // When the entry transitions past S2 (S3 / further), redirect to the appropriate stage page.
  useEffect(() => {
    if (!entry) return;
    const stage = entry.currentStage;
    if (stage && stage !== "S1" && stage !== "S2") {
      router.push(`/entries/${entry.id}/stages/${String(stage).toLowerCase()}`);
    }
  }, [entry, router]);

  // ---------- Smooth scroll into the active step ----------
  const step2Ref = useRef<HTMLDivElement>(null);
  const step3Ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (forceEdit) return;
    if (activeStep === 2 && step2Ref.current) step2Ref.current.scrollIntoView({ behavior: "smooth", block: "start" });
    if (activeStep === 3 && step3Ref.current) step3Ref.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeStep, forceEdit]);

  // ---------- Step status helpers ----------
  const step1Status = forceEdit === 1 ? "active" : step1Done ? "done" : activeStep === 1 ? "active" : "locked";
  const step2Status = forceEdit === 2 ? "active" : step2Done ? "done" : !step1Done ? "locked" : activeStep === 2 ? "active" : "locked";
  const step3Status = forceEdit === 3 ? "active" : !step2Done ? "locked" : activeStep === 3 ? "active" : step3Done ? "done" : "locked";

  // ---------- Summaries ----------
  const step1Summary = entry ? <Step1Summary entry={entry} /> : null;
  const step2Summary = sealedConfig ? <Step2Summary config={sealedConfig} entry={entry} /> : null;
  const step3Summary = acceptedQuotation ? <Step3Summary quotation={acceptedQuotation} /> : null;

  return (
    <div className="space-y-4 pb-12">
      {entry && (
        <BookingContextBar
          entry={entry}
          sealedConfig={sealedConfig}
          acceptedQuotation={acceptedQuotation}
        />
      )}

      {/* Side panels: only appear once an entry exists. Both are floating overlays that the
          operator can show/hide; their open/closed preference is persisted in localStorage. */}
      {entry && <BookingTimerPanel entryId={entry.id} />}
      {entry && <EntryTracePanel entryId={entry.id} />}

      <div className="mx-auto max-w-5xl space-y-3 px-1">
        <header className="space-y-1 pt-4">
          <h1 className="font-display text-2xl font-semibold tracking-tight">New booking</h1>
          <p className="text-sm text-muted-foreground">
            Complete each step to take an inquiry through to a quotation. The next step unlocks
            as soon as its prerequisites are met.
          </p>
        </header>

        {/* Step 1 — keepMounted so the form's state survives the collapse so "Edit" shows the
            user's previously entered values instead of a fresh empty form. */}
        <StepCard
          step={1}
          status={step1Status}
          title="Guest & inquiry"
          description="Capture the guest and the basic stay details"
          summary={step1Summary}
          onEdit={step1Done ? () => setForceEdit((f) => (f === 1 ? null : 1)) : undefined}
          onClose={() => setForceEdit(null)}
          isEditing={forceEdit === 1}
          keepMounted
        >
          <NewInquiryForm
            hideHeader
            submitLabel="Create inquiry & continue"
            onCreated={(e) => {
              setEntryId(e.id);
              setActiveStep(2);
              setForceEdit(null);
            }}
            editEntry={forceEdit === 1 && entry ? { id: entry.id, version: entry.version } : null}
            onUpdated={() => {
              void entryQuery.refetch();
              setForceEdit(null);
            }}
          />
        </StepCard>

        {/* Step 2 */}
        <div ref={step2Ref}>
          <StepCard
            step={2}
            status={step2Status}
            title="Availability — find a room"
            description="Search availability, select an option, and seal the preferred configuration"
            summary={step2Summary}
            onEdit={step2Done ? () => setForceEdit((f) => (f === 2 ? null : 2)) : undefined}
            onClose={() => setForceEdit(null)}
            isEditing={forceEdit === 2}
            lockedHint={!step1Done ? "Complete step 1 first" : undefined}
          >
            {entry ? (
              <BookingFlowProvider>
                <StageTransitionProvider>
                  <EntryDetailProvider entry={entry} isFetching={entryQuery.isFetching} viewingStage="S1">
                    <S1Workspace entry={entry} />
                  </EntryDetailProvider>
                </StageTransitionProvider>
              </BookingFlowProvider>
            ) : entryQuery.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : null}
          </StepCard>
        </div>

        {/* Step 3 */}
        <div ref={step3Ref}>
          <StepCard
            step={3}
            status={step3Status}
            title="Quotation — quote & accept"
            description="Build the quotation, send it, and progress the booking"
            summary={step3Summary}
            lockedHint={!step2Done ? "Seal a preferred room in step 2 first" : undefined}
          >
            {entry ? (
              <BookingFlowProvider>
                <StageTransitionProvider>
                  <EntryDetailProvider entry={entry} isFetching={entryQuery.isFetching} viewingStage="S2">
                    <S2Workspace entry={entry} />
                  </EntryDetailProvider>
                </StageTransitionProvider>
              </BookingFlowProvider>
            ) : null}
          </StepCard>
        </div>
      </div>
    </div>
  );
}

function Step1Summary({ entry }: { entry: EntryDetail }) {
  // entry.inquiry's runtime shape is wider than the exported type — cast to read display fields.
  const inquiry = entry.inquiry as unknown as
    | {
        sourceChannel?: string;
        guestProfile?: { firstName?: string | null; lastName?: string | null };
        travelAgent?: { displayName?: string };
        corporateAccount?: { displayName?: string };
      }
    | null
    | undefined;
  const guest = entry.guestProfile ?? inquiry?.guestProfile ?? null;
  const guestName = guest ? `${guest.firstName ?? ""} ${guest.lastName ?? ""}`.trim() || "Guest" : "Guest";
  const agentLabel = inquiry?.travelAgent?.displayName ?? inquiry?.corporateAccount?.displayName ?? null;
  const partyKind = inquiry?.travelAgent ? "Travel agent" : inquiry?.corporateAccount ? "Corporate" : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <strong className="text-foreground">{guestName}</strong>
      {agentLabel && (
        <span>
          <span className="text-muted-foreground">{partyKind}:</span> {agentLabel}
        </span>
      )}
      <span>
        <span className="text-muted-foreground">Source:</span> {inquiry?.sourceChannel ?? "—"}
      </span>
      <span>
        <span className="text-muted-foreground">Guests:</span> {entry.guestCount}
      </span>
    </div>
  );
}

function Step2Summary({ config }: { config: AvailabilityConfigSummary; entry: EntryDetail | null }) {
  const roomId = config.optionSelected?.roomId as string | undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <strong className="text-foreground">
        Room sealed {roomId && <span className="font-mono text-xs text-muted-foreground">({roomId.slice(0, 8)}…)</span>}
      </strong>
      {config.sealedAt && (
        <span className="text-xs text-muted-foreground">Sealed {new Date(config.sealedAt).toLocaleString()}</span>
      )}
    </div>
  );
}

function Step3Summary({ quotation }: { quotation: QuotationSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <strong className="text-foreground">Quotation accepted</strong>
      <span className="font-mono text-xs">{quotation.referenceNumber ?? quotation.id}</span>
      {quotation.totalAmount != null && (
        <span>
          <span className="text-muted-foreground">Total:</span> {Number(quotation.totalAmount).toFixed(2)} BTN
        </span>
      )}
    </div>
  );
}
