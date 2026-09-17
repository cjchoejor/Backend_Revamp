/**
 * System words → the desk's words (FIG 5.9–5.10). Kept free of any API import so the request
 * client itself can use it: every refusal the backend sends is read in the desk's words before
 * any screen — new or legacy — shows it. The rule a message states is never rewritten.
 */
import { STEP_NAMES } from "./steps";

const LEVEL_WORD: Record<string, string> = { L1: "the desk", L2: "the FOM", L3: "the GM", L4: "an administrator" };

const PHRASES: Array<[RegExp, string]> = [
  // two-stage arrows first so "S7→S8" reads as one move
  [/\bS([1-9])\s*(?:→|->|to)\s*S([1-9])\b/g, "$STEP$1 → $STEP$2"],
  [/\bspeculative holds?\b/gi, "provisional block"],
  [/\bcommitted holds?\b/gi, "block"],
  [/\bsegments?\b/gi, "pass"],
  [/\bentry\b/g, "booking"],
  [/\bEntry\b/g, "Booking"],
  [/\bentries\b/g, "bookings"],
  [/\bEntries\b/g, "Bookings"],
  [/\bstage\b/g, "step"],
  [/\bStage\b/g, "Step"],
  [/\bat S([1-9])\b/g, "at $STEP$1"],
  [/\bS([1-9])\b/g, "$STEP$1"],
  [/\b(L[1-4])\+?(?![\w-])/g, "$LEVEL$1"],
];

export function translateMessage(message: string): string {
  let out = message;
  for (const [re, rep] of PHRASES) out = out.replace(re, rep);
  out = out.replace(/\$STEP([1-9])/g, (_m, n: string) => STEP_NAMES[Number(n) - 1]);
  out = out.replace(/\$LEVEL(L[1-4])/g, (_m, l: string) => LEVEL_WORD[l] ?? l);
  return out;
}
