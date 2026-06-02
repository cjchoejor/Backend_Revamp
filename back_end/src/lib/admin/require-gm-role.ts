import type { Prisma, PrismaClient } from "@prisma/client";
import { AuthorizationError } from "../errors.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Role codes that satisfy the GM-specific carve-out (ACIG §6.1A.2). */
const GM_ROLE_CODES = new Set(["L4_GM_ADMIN", "ADMIN", "GM"]);

/**
 * ACIG §6.1A.2 — second-tier discriminator beyond `requireActorLevel("L4")`.
 * Resolves the actor against StaffUser and confirms the actor is the GM/Admin.
 * Throws AuthorizationError (HTTP 403, code GM_REQUIRED) otherwise.
 */
export async function requireGmRole(db: Db, actorId: string): Promise<void> {
  const staff = await db.staffUser.findUnique({ where: { id: actorId } });
  const ok =
    !!staff &&
    staff.isActive &&
    (staff.actorLevel === "L4" || GM_ROLE_CODES.has(staff.role));
  if (!ok) {
    throw new AuthorizationError("GM authority required for this operation");
  }
}
