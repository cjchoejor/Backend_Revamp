/**
 * Atlas Cat 05 §4.8 — CreditCeilingMonitorEngine (`evaluate(input): CreditCeilingResult`).
 * Async threshold notifications are handled by W12 (`workers/w12-credit-ceiling-monitoring-worker.ts`).
 * This synchronous helper is the catalogue-aligned surface for request-path checks (see SIG-S7 credit ceiling ACs).
 */
export type CreditCeilingMonitorInput = {
  /** 0–100 utilization of approved ceiling. */
  utilizationPercent: number;
  /** Advisory threshold percent; SIG default discussion uses 75%. */
  advisoryThresholdPercent?: number;
};

export type CreditCeilingMonitorResult = {
  response: "CLEAR" | "ADVISORY";
  thresholdCrossed: boolean;
};

export function evaluateCreditCeiling(input: CreditCeilingMonitorInput): CreditCeilingMonitorResult {
  const threshold = input.advisoryThresholdPercent ?? 75;
  const crossed = input.utilizationPercent >= threshold;
  return {
    response: crossed ? "ADVISORY" : "CLEAR",
    thresholdCrossed: crossed,
  };
}
