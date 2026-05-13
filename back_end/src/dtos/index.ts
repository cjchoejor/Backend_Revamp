/**
 * Cat 13 — DTO catalogue (BACKEND-STRUCTURAL-ATLAS v1.1 §10.2.1–§10.2.20).
 * Folder numbering and names mirror Cat 10 route groups one-to-one.
 *
 * Types reflect current Express route bodies and service `input` shapes; they are not runtime validators unless wired with Zod (etc.).
 */

export * from "./01-session-and-authentication/index.js";
export * from "./02-inquiries/index.js";
export * from "./03-entries/index.js";
export * from "./04-availability/index.js";
export * from "./05-quotations-and-holds/index.js";
export * from "./06-reservations/index.js";
export * from "./07-folios/index.js";
export * from "./08-amendments/index.js";
export * from "./09-cancellations/index.js";
export * from "./10-no-show/index.js";
export * from "./11-handoffs/index.js";
export * from "./12-disputes/index.js";
export * from "./13-work-orders/index.js";
export * from "./14-guest-profiles/index.js";
export * from "./15-night-audit/index.js";
export * from "./16-incidents-and-lost-found/index.js";
export * from "./17-communications/index.js";
export * from "./18-processing-locks/index.js";
export * from "./19-ai-agent-draft-management/index.js";
export * from "./20-voice-notes/index.js";
