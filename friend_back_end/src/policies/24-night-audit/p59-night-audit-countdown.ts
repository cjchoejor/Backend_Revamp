/**
 * Policy 59 — Night Audit Countdown Policy (DEV-SPEC Part 5).
 *
 * Pure calculation: returns a fireAt timestamp for stay-night audit reminder/countdown.
 */
export function computeNightAuditCountdownFireAt(input: { now: Date; secondsFromNow: number }): Date {
  const s = Number(input.secondsFromNow);
  const ms = Number.isFinite(s) ? Math.max(0, s) * 1000 : 0;
  return new Date(input.now.getTime() + ms);
}

