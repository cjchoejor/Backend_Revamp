/**
 * The journey in the desk's words (FIG 5.1 as amended by ruling F1, 13 Sep 2026).
 * The code's S1–S9 never reach a screen; this is the one place they are translated.
 */
import type { Stage } from "@/types/api";

export const STEP_NAMES = [
  "Inquiry",
  "Negotiation",
  "Set up",
  "Reserve",
  "Arrival",
  "Check-in",
  "Stay",
  "Check-out",
  "Closed",
] as const;
export type StepName = (typeof STEP_NAMES)[number];
export type StepNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** What each step is for — the grey line beside the step title on the canvas. */
export const STEP_NEEDS: Record<StepNo, string> = {
  1: "understand the stay",
  2: "shape the price",
  3: "hold & deposit",
  4: "freeze the booking",
  5: "ready the room",
  6: "keys & live folio",
  7: "daily charges",
  8: "settle up",
  9: "sealed",
};

/** The four phases the rail groups the steps under. */
export const PHASES: Array<[string, StepNo[]]> = [
  ["Booking", [1, 2, 3, 4]],
  ["Arriving", [5, 6]],
  ["Staying", [7, 8]],
  ["Done", [9]],
];

/** The two commitment boundaries — drawn as thresholds on the rail from the first step. */
export const BOUNDARY_STEPS: ReadonlySet<StepNo> = new Set<StepNo>([4, 6]);

export function stepNoOfStage(stage?: Stage | string | null): StepNo {
  const m = /^S([1-9])$/.exec(String(stage ?? ""));
  if (m) return Number(m[1]) as StepNo;
  return stage === "TERMINAL" ? 9 : 1;
}

export function stageOfStepNo(n: StepNo): Stage {
  return `S${n}` as Stage;
}

export function stepName(n: number): StepName {
  return STEP_NAMES[Math.min(9, Math.max(1, n)) - 1];
}
