import { TaskStatus } from "@prisma/client";
import { PolicyGateBlockedError, StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 9 — Pre-Arrival Period Policy (S5→S6 normal exit slice).
 * SIG-S5: no PreArrivalTask may remain PENDING at S5 exit.
 */
export function enforceNoPendingPreArrivalTasks(input: { tasks: Array<{ status: TaskStatus; taskType: string }> }) {
  const pending = input.tasks.find((t) => t.status === TaskStatus.PENDING);
  if (!pending) return;
  throw new StageGateBlockedError(`Pre-arrival task still PENDING: ${pending.taskType}`, "PRE_ARRIVAL_TASK_PENDING");
}

/** SIG-S5: task WAIVE requires a mandatory reason. */
export function enforcePreArrivalTaskWaiveRequiresReason(input: { action: "COMPLETE" | "WAIVE"; waivedReason?: string }) {
  if (input.action !== "WAIVE") return;
  if (!input.waivedReason?.trim()) {
    throw new PolicyGateBlockedError("WAIVED_REASON_REQUIRED", "waivedReason is required when action is WAIVE");
  }
}

