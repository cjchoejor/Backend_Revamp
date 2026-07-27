/**
 * Atlas Cat 05 §4.10 — TimerEngine (`register(input): TimerRegistration`).
 * Canonical pg-boss-backed implementation: `createTimerEngine` in `lib/timer-engine.ts`.
 * Import from this file when code should reference the Atlas engine name rather than `lib/`.
 */
export { createTimerEngine, type TimerEngine, type TimerJobName } from "../lib/timer-engine.js";
