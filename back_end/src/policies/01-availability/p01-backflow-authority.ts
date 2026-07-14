/**
 * Authority gates for the 9 backflows wired 2026-07-14.
 * Spec references: SIG-S2 §1.3, SIG-S4 §3.1, SIG-S5 §1.3, SIG-S7 §3.3, Part3 §3.2.4.
 *
 * Each gate throws PolicyGateBlockedError with a specific code the frontend can pattern-match.
 * L4 is always sufficient (admin override); no gate refuses L4.
 */
import { PolicyGateBlockedError } from "../../lib/errors.js";

type Level = "L1" | "L2" | "L3" | "L4";
const rank: Record<Level, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

function requireLevel(actor: Level, min: Level, code: string, msg: string) {
  if (rank[actor] < rank[min]) throw new PolicyGateBlockedError(code, msg);
}

/** SIG-S2 §1.3 — S2→S1 (date / room-type change → re-search). L1+ allowed. */
export function enforceS2ToS1BackflowAuthority(input: { actorLevel: Level }) {
  requireLevel(input.actorLevel, "L1", "AUTH_REQUIRED_L1", "L1+ authority required for S2→S1 backflow");
}

/** SIG-S4 §3.1 — S4→S1 (post-confirm date change). FOM+. */
export function enforceS4ToS1BackflowAuthority(input: { actorLevel: Level }) {
  requireLevel(input.actorLevel, "L2", "AUTH_REQUIRED_L2", "FOM authority required for S4→S1 backflow (post-confirmation date change)");
}

/** SIG-S4 §3.1 — S4→S2 (post-confirm rate change). FOM+ (spec: FOM/GM). */
export function enforceS4ToS2BackflowAuthority(input: { actorLevel: Level }) {
  requireLevel(input.actorLevel, "L2", "AUTH_REQUIRED_L2", "FOM authority required for S4→S2 backflow (post-confirmation rate change)");
}

/** SIG-S4 §3.1 — S4→S3 (post-confirm billing-model change). FOM+ (spec: FOM/GM). */
export function enforceS4ToS3BackflowAuthority(input: { actorLevel: Level }) {
  requireLevel(input.actorLevel, "L2", "AUTH_REQUIRED_L2", "FOM authority required for S4→S3 backflow (post-confirmation billing-model change)");
}

/** SIG-S5 §1.3 — S5→S1 (config error → re-search from pre-arrival). FOM+. */
export function enforceS5ToS1BackflowAuthority(input: { actorLevel: Level }) {
  requireLevel(input.actorLevel, "L2", "AUTH_REQUIRED_L2", "FOM authority required for S5→S1 backflow (pre-arrival re-search)");
}

/**
 * SIG-S7 §3.3 — S7→S2 (mid-stay rate revision / full renegotiation). GM (L3+).
 * Rate revision in-house is the highest-authority backflow.
 */
export function enforceS7ToS2BackflowAuthority(input: { actorLevel: Level }) {
  requireLevel(input.actorLevel, "L3", "AUTH_REQUIRED_L3", "GM authority required for S7→S2 backflow (mid-stay rate revision)");
}

/** SIG-S7 §3.3 — S7→S3 (mid-stay billing-model change). FOM+ (spec: FOM/GM). */
export function enforceS7ToS3BackflowAuthority(input: { actorLevel: Level }) {
  requireLevel(input.actorLevel, "L2", "AUTH_REQUIRED_L2", "FOM authority required for S7→S3 backflow (mid-stay billing-model change)");
}

/** SIG-S7 §3.3 — S7→S4 (date extension). FOM+ (spec: FOM/GM). */
export function enforceS7ToS4BackflowAuthority(input: { actorLevel: Level }) {
  requireLevel(input.actorLevel, "L2", "AUTH_REQUIRED_L2", "FOM authority required for S7→S4 backflow (date extension)");
}

/** Part3 §3.2.4 — Any→S2 complaint / goodwill commercial adjustment. FOM+ (spec: FOM/GM). */
export function enforceComplaintResolutionBackflowAuthority(input: { actorLevel: Level }) {
  requireLevel(input.actorLevel, "L2", "AUTH_REQUIRED_L2", "FOM authority required for Any→S2 complaint resolution");
}
