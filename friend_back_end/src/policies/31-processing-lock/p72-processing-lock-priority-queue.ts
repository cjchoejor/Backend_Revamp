/**
 * Policy 72 — Processing Lock Priority Queue Policy
 * SIG-S1: if a prior ACTIVE lock exists, new lock is still created, but response includes an informational notice.
 */
export function formatProcessingLockPriorityNotice(input: { priorActiveLockId: string | null | undefined }): { priorityNotice?: string } {
  return input.priorActiveLockId ? { priorityNotice: `Existing active lock detected: ${input.priorActiveLockId}` } : {};
}

