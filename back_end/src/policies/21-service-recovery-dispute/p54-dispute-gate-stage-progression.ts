import { PolicyGateBlockedError, StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 54 — Dispute Gate Stage Progression Policy.
 *
 * SIG-S7: at S7→S8, `BLOCKED_WITH_OVERRIDE_AVAILABLE` requires GM override record to proceed.
 * SIG-S8 §3.3: at S8→S9 the dispute gate must be CLEAR (no override path).
 */
export function enforceNoOpenDisputesForS9Closure(input: { openDispute: unknown | null | undefined }) {
  if (!input.openDispute) return;
  throw new StageGateBlockedError("Cannot close entry with an open dispute", "DISPUTE_NOT_TERMINAL");
}

export function enforceDisputeGateClearForS8ToS9(input: { gateResult: "CLEAR" | "BLOCKED" | "BLOCKED_WITH_OVERRIDE_AVAILABLE" }) {
  if (input.gateResult === "CLEAR") return;
  throw new StageGateBlockedError(
    "Dispute gate blocks S8→S9 — disputes must be RESOLVED or CLOSED (no override at this transition)",
    "DISPUTE_GATE_BLOCKED",
  );
}

export function enforceDisputeGateAllowsProgress(input: {
  gateResult: "CLEAR" | "BLOCKED_WITH_OVERRIDE_AVAILABLE" | "BLOCKED";
  messageWhenBlockedWithOverride?: string;
}) {
  if (input.gateResult === "CLEAR") return;
  if (input.gateResult === "BLOCKED") {
    // Service layer typically raises StageGateBlockedError upstream; this helper is only used
    // for the override-available branch in this backend slice.
    throw new PolicyGateBlockedError("DISPUTE_GATE_BLOCKED", "Dispute gate is BLOCKED");
  }
  throw new PolicyGateBlockedError(
    "DISPUTE_GATE_BLOCKED",
    input.messageWhenBlockedWithOverride ?? "Dispute gate blocks progression until GM override is recorded",
  );
}

export function enforceDisputeGateOverrideTargetAllowed(input: { targetStage: "S8" | "S9" }) {
  if (input.targetStage === "S9") {
    throw new PolicyGateBlockedError(
      "DISPUTE_OVERRIDE_NOT_AVAILABLE",
      "Dispute gate override is not available for S8→S9",
    );
  }
}

