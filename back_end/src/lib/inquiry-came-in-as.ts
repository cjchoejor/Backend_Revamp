import type { InquiryCameInAs } from "@prisma/client";
import { ValidationError } from "./errors.js";

/**
 * How the guest came in (2026-09-18) — `Inquiry.cameInAs`, beside the coarser `sourceChannel`.
 *
 * `sourceChannel` keeps the five values custodian assignment (Policy 3) is configured for, so a
 * booking made by phone, one made online and a group enquiry all read DIRECT there. The desk's
 * finer choice used to be appended to the inquiry's notes ("Direct (online)") and read back by
 * matching that text — editing the notes silently changed how the guest came in. It now has its
 * own column; every value maps to exactly one channel, so the two can never disagree.
 */
export const CAME_IN_AS_VALUES = [
  "WALK_IN",
  "DIRECT_VOICE",
  "DIRECT_ONLINE",
  "OTA",
  "TRAVEL_AGENT",
  "CORPORATE",
  "GROUP_MICE",
] as const satisfies readonly InquiryCameInAs[];

const CHANNEL_OF: Record<InquiryCameInAs, string> = {
  WALK_IN: "WALK_IN",
  DIRECT_VOICE: "DIRECT",
  DIRECT_ONLINE: "DIRECT",
  OTA: "OTA",
  TRAVEL_AGENT: "AGENT",
  CORPORATE: "CORPORATE",
  GROUP_MICE: "DIRECT",
};

/** The `sourceChannel` a came-in-as value belongs to. */
export function sourceChannelForCameInAs(v: InquiryCameInAs): string {
  return CHANNEL_OF[v];
}

/**
 * Read the old encoding: the channel, plus the marker both desks appended to the notes for the
 * choices DIRECT cannot carry. A plain DIRECT with no marker cannot say voice or online, so it
 * reads as null rather than a guess. `useType` GROUP counts as the group marker (the Group / MICE
 * choice also set it).
 */
export function deriveCameInAs(input: { sourceChannel?: string | null; notes?: string | null; useType?: string | null }): InquiryCameInAs | null {
  const ch = (input.sourceChannel ?? "").trim().toUpperCase();
  const notes = input.notes ?? "";
  if (ch === "WALK_IN") return "WALK_IN";
  if (ch === "OTA") return "OTA";
  if (ch === "AGENT" || ch === "TRAVEL_AGENT") return "TRAVEL_AGENT";
  if (ch === "CORPORATE") return "CORPORATE";
  if (ch === "DIRECT") {
    if (/group \/ mice/i.test(notes) || input.useType === "GROUP") return "GROUP_MICE";
    if (/direct \(online\)/i.test(notes)) return "DIRECT_ONLINE";
    if (/direct \(voice\)/i.test(notes)) return "DIRECT_VOICE";
  }
  return null;
}

/**
 * What an inquiry is created with. Given `cameInAs`, the channel follows from it (and a channel
 * sent alongside must agree). Given only `sourceChannel` — the old desk, API callers — the column
 * is still filled, from the channel and the notes marker.
 */
export function resolveInquiryChannel(input: {
  cameInAs?: string | null;
  sourceChannel?: string | null;
  notes?: string | null;
}): { sourceChannel: string; cameInAs: InquiryCameInAs | null } {
  const raw = input.cameInAs?.trim().toUpperCase() || null;
  if (raw) {
    if (!(CAME_IN_AS_VALUES as readonly string[]).includes(raw)) {
      throw new ValidationError(`cameInAs must be one of ${CAME_IN_AS_VALUES.join(", ")}`);
    }
    const cameInAs = raw as InquiryCameInAs;
    const channel = CHANNEL_OF[cameInAs];
    const sent = input.sourceChannel?.trim().toUpperCase();
    if (sent && sent !== channel && !(channel === "AGENT" && sent === "TRAVEL_AGENT")) {
      throw new ValidationError(`cameInAs ${cameInAs} belongs to channel ${channel}, not ${input.sourceChannel}`);
    }
    return { sourceChannel: input.sourceChannel?.trim() || channel, cameInAs };
  }
  if (!input.sourceChannel?.trim()) throw new ValidationError("sourceChannel or cameInAs is required");
  return { sourceChannel: input.sourceChannel.trim(), cameInAs: deriveCameInAs(input) };
}
