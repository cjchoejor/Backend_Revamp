import type { Stage } from "@/types/api";

export type StageMeta = {
  id: Stage;
  slug: string;
  label: string;
  shortLabel: string;
  description: string;
  order: number;
};

export const STAGES: StageMeta[] = [
  { id: "S1", slug: "s1", label: "Inquiry & availability", shortLabel: "S1", description: "Capture inquiry and search availability", order: 1 },
  { id: "S2", slug: "s2", label: "Quotation", shortLabel: "S2", description: "Build and send quotations", order: 2 },
  { id: "S3", slug: "s3", label: "Reservation hold", shortLabel: "S3", description: "Committed hold and provisional folio", order: 3 },
  { id: "S4", slug: "s4", label: "Confirmation", shortLabel: "S4", description: "Confirm reservation", order: 4 },
  { id: "S5", slug: "s5", label: "Pre-arrival", shortLabel: "S5", description: "Pre-arrival tasks and readiness", order: 5 },
  { id: "S6", slug: "s6", label: "Check-in", shortLabel: "S6", description: "Room assignment and check-in", order: 6 },
  { id: "S7", slug: "s7", label: "In-stay", shortLabel: "S7", description: "Folio and in-stay operations", order: 7 },
  { id: "S8", slug: "s8", label: "Check-out", shortLabel: "S8", description: "Checkout and settlement prep", order: 8 },
  { id: "S9", slug: "s9", label: "Settlement & close", shortLabel: "S9", description: "Final settlement and close", order: 9 },
];

export const stageById = Object.fromEntries(STAGES.map((s) => [s.id, s])) as Record<Stage, StageMeta>;

export function stageSlug(stage: Stage | string | null | undefined): string {
  if (!stage) return "s1";
  // TERMINAL is not a navigable stage — it's the end state of the workflow. Route to S9
  // (the natural landing) so the user sees the final stage in read-only.
  if (String(stage).toUpperCase() === "TERMINAL") return "s9";
  const meta = stageById[stage as Stage];
  if (meta?.slug) return meta.slug;
  return String(stage).toLowerCase();
}

export function stagePath(entryId: string, stage: Stage | string | null | undefined): string {
  return `/entries/${entryId}/stages/${stageSlug(stage)}`;
}
