import type { Prisma, PrismaClient } from "@prisma/client";
import { getActiveConfigEntry } from "./config-store.js";
import { AuthorizationError } from "./errors.js";

type Db = PrismaClient | Prisma.TransactionClient;
export type Level = "L1" | "L2" | "L3" | "L4";

/**
 * Who may approve what (2026-11-26, operator: "till now we made approval sections, where only the
 * concerned authority can do it — make it in the admin console as well, where admin can configure who
 * can do it or not with a toggle of true and false").
 *
 * One setting per act, `approvals.<act>.roles` = `{ L1: bool, L2: bool, L3: bool }`. An admin (L4)
 * may always — the console's own people can never be locked out of it. No saved setting means the
 * rule as it was built, so the hotel's server keeps its behaviour until someone changes a toggle.
 * Roles map one to one onto actor levels on this system (front desk L1, FOM L2, GM L3, admin L4).
 *
 * Every gate for these acts reads this module, and the desk reads the same answer through
 * `GET /api/lookups/approvals`, so the screen never offers what the server refuses.
 */
export type ApprovalAct =
  | "LEAVE_OWING"
  | "CHARGE_CORRECTION"
  | "CHECKIN_PAY_LATER"
  | "NEGOTIATION_CHANGE"
  | "ROOM_REMOVE"
  | "ROOM_ADD"
  | "LEAVING_EARLY"
  | "WAIVE_EARLY_FEE";

export const APPROVAL_ACTS: Record<ApprovalAct, { key: string; defaults: Level[]; what: string }> = {
  LEAVE_OWING: { key: "approvals.leaveOwing.roles", defaults: ["L2", "L3"], what: "Letting a guest leave owing" },
  CHARGE_CORRECTION: { key: "approvals.chargeCorrection.roles", defaults: ["L2", "L3"], what: "Correcting a charge on a settled bill" },
  CHECKIN_PAY_LATER: { key: "approvals.checkInPayLater.roles", defaults: ["L2", "L3"], what: "Letting a guest pay the rest of the bill later" },
  NEGOTIATION_CHANGE: { key: "approvals.negotiationChange.roles", defaults: ["L2", "L3"], what: "Changing a booking whose quotation has gone to the guest" },
  ROOM_REMOVE: { key: "approvals.roomRemove.roles", defaults: ["L2", "L3"], what: "Removing a room from a stay" },
  ROOM_ADD: { key: "approvals.roomAdd.roles", defaults: ["L3"], what: "Adding a room to a stay" },
  LEAVING_EARLY: { key: "approvals.leavingEarly.roles", defaults: ["L3"], what: "Recording a guest leaving early" },
  WAIVE_EARLY_FEE: { key: "approvals.waiveEarlyFee.roles", defaults: ["L3"], what: "Waiving the early departure fee" },
};

export const APPROVAL_KEYS = Object.values(APPROVAL_ACTS).map((a) => a.key);

const WORDS: Record<Level, string> = { L1: "the front desk", L2: "the FOM", L3: "the GM", L4: "an admin" };
const ORDER: Level[] = ["L1", "L2", "L3", "L4"];

/** The stored value's shape check, for the config-key registry. */
export function approvalRolesProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "must be { L1, L2, L3 } true or false";
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!["L1", "L2", "L3"].includes(k)) return `unknown role ${k}`;
    if (typeof v !== "boolean") return `${k} must be true or false`;
  }
  return null;
}

/** "the FOM, the GM or an admin". */
export function rolesInWords(levels: Level[]): string {
  const names = ORDER.filter((l) => levels.includes(l)).map((l) => WORDS[l]);
  if (names.length <= 1) return names[0] ?? WORDS.L4;
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

function levelsFrom(value: unknown, defaults: Level[]): Level[] {
  const stored = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const picked = (["L1", "L2", "L3"] as Level[]).filter((l) => (stored && typeof stored[l] === "boolean" ? stored[l] === true : defaults.includes(l)));
  return [...picked, "L4"];
}

export async function readApprovalRoles(db: Db, act: ApprovalAct): Promise<{ act: ApprovalAct; levels: Level[]; words: string; what: string }> {
  const def = APPROVAL_ACTS[act];
  const row = await getActiveConfigEntry(db as PrismaClient, def.key).catch(() => null);
  const levels = levelsFrom(row?.configValue, def.defaults);
  return { act, levels, words: rolesInWords(levels), what: def.what };
}

export async function listApprovalRoles(db: Db): Promise<Record<ApprovalAct, { levels: Level[]; words: string; what: string }>> {
  const out = {} as Record<ApprovalAct, { levels: Level[]; words: string; what: string }>;
  for (const act of Object.keys(APPROVAL_ACTS) as ApprovalAct[]) {
    const r = await readApprovalRoles(db, act);
    out[act] = { levels: r.levels, words: r.words, what: r.what };
  }
  return out;
}

function asLevel(level: string | null | undefined): Level {
  return level === "L2" || level === "L3" || level === "L4" ? level : "L1";
}

export async function mayApprove(db: Db, act: ApprovalAct, level: string | null | undefined): Promise<boolean> {
  return (await readApprovalRoles(db, act)).levels.includes(asLevel(level));
}

/** Refused in words: "Removing a room from a stay is for the FOM, the GM or an admin." */
export async function enforceMayApprove(db: Db, act: ApprovalAct, level: string | null | undefined): Promise<void> {
  const r = await readApprovalRoles(db, act);
  if (!r.levels.includes(asLevel(level))) throw new AuthorizationError(`${r.what} is for ${r.words}.`);
}
