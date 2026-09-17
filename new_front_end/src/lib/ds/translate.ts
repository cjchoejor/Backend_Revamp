/**
 * The single shared vocabulary map for backend refusals (FIG 5.9–5.10).
 *
 * The backend's messages are shown as it sent them, with one change: system words become the
 * desk's words. The rule the message states is never rewritten, softened or extended. About fifty
 * of the backend's refusal sentences name a stage code (the contract README counted them); this
 * is where they are translated, and nowhere else.
 */
import { ApiError } from "@/lib/api/client";
import { translateMessage } from "./words";

export { translateMessage };

export type RefusalKind = "rule" | "state" | "authority" | "fault";

export type Refused = {
  kind: RefusalKind;
  message: string;
  /** Individual gate failures when the backend sent several (StageGatesBlockedError). */
  failures: string[];
  blockingCondition?: string;
};

/**
 * Reads any thrown error as one of the four kinds of refusal (FIG 9.3). A rule refused it; the
 * record is in the wrong state; the signed-in role lacks the authority; the system is at fault.
 */
export function readRefusal(err: unknown, fallback = "The system couldn't do this"): Refused {
  if (err instanceof ApiError) {
    const body = (err.body ?? {}) as { error?: string; blockingCondition?: string; details?: { failures?: Array<{ message?: string }> } };
    const kind: RefusalKind =
      err.status === 403
        ? "authority"
        : body.error === "StateTransitionError" || body.error === "StageGateBlockedError" || body.error === "StageGatesBlockedError"
          ? "state"
          : err.status >= 500 || err.status === 0
            ? "fault"
            : "rule";
    const failures = (body.details?.failures ?? []).map((f) => translateMessage(f.message ?? "")).filter(Boolean);
    return { kind, message: translateMessage(err.message || fallback), failures, blockingCondition: body.blockingCondition };
  }
  if (err instanceof Error) return { kind: "fault", message: translateMessage(err.message || fallback), failures: [] };
  return { kind: "fault", message: fallback, failures: [] };
}

/** One line for a toast. */
export function refusalText(err: unknown, fallback?: string): string {
  const r = readRefusal(err, fallback);
  return r.failures.length ? `${r.message} · ${r.failures.join(" · ")}` : r.message;
}
