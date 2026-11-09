import type { Prisma, PrismaClient } from "@prisma/client";
import { getActiveConfigEntry } from "./config-store.js";
import { AuthorizationError } from "./errors.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Level = "L1" | "L2" | "L3" | "L4";

/**
 * Who may mark the money reconciled (2026-11-05, operator: "should only be permitted to GM and admin
 * for now, in admin console, make a setting where they can give permission to other roles as well").
 *
 * The sign-off is what lets a booking with part of its advance go on to check in, so it is a decision
 * about money. The GM and admins can always do it; the setting names the roles that may as well, and
 * no saved setting means nobody else. Roles map one to one onto actor levels on this system.
 */
export const RECONCILE_ALSO_ALLOWED_KEY = "advancePayment.reconciliation.alsoAllowed";

const WORDS: Record<Level, string> = { L1: "the front desk", L2: "the FOM", L3: "the GM", L4: "an admin" };

export async function whoMayReconcile(db: Db): Promise<{ levels: Level[]; words: string }> {
  const row = await getActiveConfigEntry(db as PrismaClient, RECONCILE_ALSO_ALLOWED_KEY);
  const also: unknown[] = Array.isArray(row?.configValue) ? (row!.configValue as unknown[]) : [];
  const levels = (["L1", "L2", "L3", "L4"] as Level[]).filter((l) => l === "L3" || l === "L4" || also.includes(l));
  const names = levels.map((l) => WORDS[l]);
  return { levels, words: `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` };
}

export async function enforceMayReconcile(db: Db, level: Level): Promise<void> {
  const { levels, words } = await whoMayReconcile(db);
  if (!levels.includes(level)) throw new AuthorizationError(`Marking the money reconciled is for ${words}.`);
}
