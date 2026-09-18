"use client";

/**
 * The pre-arrival task list — opened by Reserve, worked at Arrival (ruling R1, P1).
 *
 * One table for both steps: Task · Whose · State, and the desk's Complete / Waive where the step
 * allows them. At Reserve only the front-desk prep tasks carry actions (what the old confirm step
 * offered); at Arrival every task does. Ticking at Reserve records the prep — opening the arrival
 * window re-opens completed tasks so the arrival desk confirms them fresh (backend, 2026-08-10).
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { patchPreArrivalTask } from "@/lib/api/pre-arrival";
import { listIdentityProofs } from "@/lib/api/identity-proofs";
import { fmtStamp, plural } from "@/lib/ds/format";
import type { EntryDetail, PreArrivalTaskSummary } from "@/types/api";
import { ReasonDialog, StepCard, toastRefusal, useRefreshEntry, useStepMode, words } from "./kit";

/** The task list in the desk's words, with whose job each one is (prototype `V16.PREARRIVAL`). */
export const PRE_ARRIVAL_TASKS: Record<string, { label: string; whose: string }> = {
  PAYMENT_RECONCILIATION: { label: "Payment reconciliation", whose: "system" },
  CREDIT_CEILING_CHECK: { label: "Credit-ceiling check", whose: "system" },
  NIGHT_AUDIT_TIMER_REGISTRATION: { label: "Night-audit timer set", whose: "system" },
  BED_CONFIGURATION_CHANGE: { label: "Bed configuration", whose: "housekeeping" },
  PRE_ARRIVAL_COMMUNICATION: { label: "Pre-arrival message to the guest", whose: "desk" },
  SPECIAL_REQUEST_FULFILMENT: { label: "Special request", whose: "desk" },
  LATE_ARRIVAL_MEAL_COORDINATION: { label: "Late-arrival meal with the kitchen", whose: "desk" },
  SITE_VISIT: { label: "Site visit", whose: "sales" },
  UNIT_READINESS_VERIFICATION: { label: "Room readiness", whose: "housekeeping" },
  GUEST_DETAILS_CAPTURED: { label: "Guest details captured", whose: "system" },
};

/** The four front-desk prep tasks the Reserve step lets the desk work before the arrival window. */
export const RESERVE_PREP_TASKS = new Set([
  "PAYMENT_RECONCILIATION",
  "SPECIAL_REQUEST_FULFILMENT",
  "LATE_ARRIVAL_MEAL_COORDINATION",
  "SITE_VISIT",
]);

const ORDER = Object.keys(PRE_ARRIVAL_TASKS);

export function taskLabel(type: string) {
  return PRE_ARRIVAL_TASKS[type]?.label ?? words(type);
}

function stateChip(t: PreArrivalTaskSummary) {
  if (t.status === "COMPLETE") return <Chip tone="success">done</Chip>;
  if (t.status === "WAIVED") return <Chip tone="quiet">waived</Chip>;
  return <Chip tone="warning">open</Chip>;
}

export function PreArrivalTasksCard({
  entry,
  title,
  meta,
  actionable,
  guestDetailsHint,
  id,
  movedOn,
}: {
  entry: EntryDetail;
  title: string;
  meta?: React.ReactNode;
  /** Which task types carry Complete / Waive here; `"all"` for every task. */
  actionable: ReadonlySet<string> | "all";
  /** Arrival: the guest-details task says how far the guest table has got. */
  guestDetailsHint?: boolean;
  id?: string;
  /** Reserve's copy once the booking has moved to Arrival: the tasks are worked there now. */
  movedOn?: { onGo: () => void } | null;
}) {
  const { session } = useSession();
  const { past } = useStepMode();
  const clock = useHotelClock(60_000);
  const refresh = useRefreshEntry(entry.id);
  const [waiving, setWaiving] = useState<PreArrivalTaskSummary | null>(null);
  const tasks = [...(entry.preArrivalTasks ?? [])].sort((a, b) => {
    const ia = ORDER.indexOf(a.taskType);
    const ib = ORDER.indexOf(b.taskType);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const proofs = useQuery({
    queryKey: ["identity-proofs", entry.id],
    queryFn: () => listIdentityProofs(session!, entry.id),
    enabled: !!session && !!guestDetailsHint,
  });
  const coverage = proofs.data?.coverage ?? null;

  const act = useMutation({
    mutationFn: (v: { taskId: string; action: "COMPLETE" | "WAIVE"; reason?: string }) =>
      patchPreArrivalTask(session!, v.taskId, { action: v.action, waivedReason: v.reason }),
    onSuccess: (_d, v) => {
      toast.success(v.action === "COMPLETE" ? "Task done — on record" : "Task waived — the reason is on record");
      setWaiving(null);
      refresh([["journey-summary", entry.id]]);
    },
    onError: (e) => toastRefusal(e, "The task could not be updated"),
  });

  const canAct = (t: PreArrivalTaskSummary) =>
    !past && t.status === "PENDING" && (actionable === "all" || actionable.has(t.taskType));
  const open = tasks.filter((t) => t.status === "PENDING").length;

  return (
    <StepCard
      title={title}
      id={id}
      right={tasks.length ? <Chip tone={open ? "warning" : "success"}>{open ? `${open} open` : "all done or waived"}</Chip> : undefined}
    >
      {meta ? <div className="meta" style={{ marginBottom: 8 }}>{meta}</div> : null}
      {movedOn && open > 0 ? (
        <div className="row-acts" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <span className="sm warn-ink">
            The booking is at Arrival now — the {plural(open, "open task")} are done or waived there, not here.
          </span>
          <Button kind="secondary" compact onClick={movedOn.onGo}>
            Go to Arrival
          </Button>
        </div>
      ) : null}
      {tasks.length === 0 ? (
        <p className="meta">
          No tasks on record yet — Reserve opens them; a booking reserved before the list existed gets them when Arrival opens.
        </p>
      ) : (
        <table className="table compact">
          <thead>
            <tr>
              <th>Task</th>
              <th>Whose</th>
              <th>State</th>
              {past ? null : <th />}
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="static">
                <td>
                  {taskLabel(t.taskType)}
                  {t.status === "WAIVED" && t.waivedReason ? <span className="sub">waived — {t.waivedReason}</span> : null}
                  {t.status === "COMPLETE" && t.completedAt ? <span className="sub">done {fmtStamp(t.completedAt, clock.tz)}</span> : null}
                  {guestDetailsHint && t.taskType === "GUEST_DETAILS_CAPTURED" && coverage ? (
                    <span className={`sub${t.status === "PENDING" ? " warn-ink" : ""}`}>
                      {coverage.vipExempt
                        ? "a VIP booking — guest details are not required; it ticks itself"
                        : `${coverage.filledSlots} of ${plural(coverage.totalSlots, "guest")} in the guest table — it ticks itself when everyone is in`}
                    </span>
                  ) : null}
                </td>
                <td>{PRE_ARRIVAL_TASKS[t.taskType]?.whose ?? "desk"}</td>
                <td>{stateChip(t)}</td>
                {past ? null : (
                  <td className="nowrap" style={{ textAlign: "right" }}>
                    {!canAct(t) && t.status === "PENDING" && actionable !== "all" ? (
                      <span className="meta">done at Arrival</span>
                    ) : canAct(t) ? (
                      <span className="row-acts" style={{ justifyContent: "flex-end" }}>
                        <Button
                          kind="secondary"
                          compact
                          state={act.isPending && act.variables?.taskId === t.id ? "working" : "default"}
                          workingLabel="Saving…"
                          onClick={() => act.mutate({ taskId: t.id, action: "COMPLETE" })}
                        >
                          Done
                        </Button>
                        <Button kind="quiet" compact onClick={() => setWaiving(t)}>
                          Waive…
                        </Button>
                      </span>
                    ) : null}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ReasonDialog
        open={!!waiving}
        onClose={() => setWaiving(null)}
        title={waiving ? `Waive · ${taskLabel(waiving.taskType)}` : "Waive the task"}
        caseLines={[entry.id]}
        lead="A waived task no longer holds up the arrival. The reason is written on the task, with your name."
        confirmLabel="Waive"
        placeholder="why this task does not apply to this booking"
        busy={act.isPending}
        onConfirm={(reason) => waiving && act.mutate({ taskId: waiving.id, action: "WAIVE", reason })}
      />
    </StepCard>
  );
}
