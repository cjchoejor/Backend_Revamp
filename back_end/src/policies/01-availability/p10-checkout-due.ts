import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 10 — Checkout Due Policy (DEV-SPEC Part 5).
 *
 * Core intent: after governed checkout time, the checkout-due window is breached and
 * timed consequences/workflows should trigger. This policy just evaluates timing.
 */
export function enforceCheckoutNotOverdue(input: { now: Date; checkoutDueAt: Date | null | undefined }) {
  if (!input.checkoutDueAt) return;
  if (input.now.getTime() <= input.checkoutDueAt.getTime()) return;
  throw new PolicyGateBlockedError("CHECKOUT_OVERDUE", "Checkout is overdue");
}

