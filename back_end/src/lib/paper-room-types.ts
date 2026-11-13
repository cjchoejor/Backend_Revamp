import type { Prisma, PrismaClient } from "@prisma/client";
import { getActiveConfigEntry } from "./config-store.js";
import { AuthorizationError, NotFoundError } from "./errors.js";

type Db = PrismaClient | Prisma.TransactionClient;
export type ActorLevel = "L1" | "L2" | "L3" | "L4";

/**
 * Papers to an agency or a company go without room types (2026-11-13, operator: "when sending paper
 * are to be sent without the room types for travel agents and corporates, just number of rooms ...
 * this is to avoid problems later cause maybe they say different room type in the paper and when they
 * come here they get another room, but we allocate the rooms here based on whats free").
 *
 * A booking through a travel agent or a company gets the quotation, the proforma and the confirmation
 * voucher (and the trip's versions of them) with each room named "Room 1 · 2 adults", its package in
 * front, and how many rooms on the stay's line. A room the desk gave by number keeps its number. A
 * walk-in's or a direct guest's papers name the room type as before, and the desk always sees it.
 *
 * Sending such a paper WITH the room types is off until an admin turns it on (`papers.roomTypesForParties`,
 * Channels and replies), and then only the roles ticked there may. Seeing them in the preview is not
 * sending, and is open to everyone; anything that goes out is checked here.
 */
export const PAPER_ROOM_TYPES_KEY = "papers.roomTypesForParties";

const LEVELS: ActorLevel[] = ["L1", "L2", "L3", "L4"];
const WORDS: Record<ActorLevel, string> = { L1: "the front desk", L2: "the FOM", L3: "the GM", L4: "an admin" };

export type RoomTypesRule = { enabled: boolean; levels: ActorLevel[]; words: string };

/** The setting as it stands; no row reads as off. */
export async function readRoomTypesRule(db: Db): Promise<RoomTypesRule> {
  const row = await getActiveConfigEntry(db as PrismaClient, PAPER_ROOM_TYPES_KEY);
  const v = (row?.configValue ?? null) as { enabled?: unknown; levels?: unknown } | null;
  const listed = Array.isArray(v?.levels) ? (v!.levels as unknown[]) : [];
  const levels = LEVELS.filter((l) => listed.includes(l));
  const names = levels.map((l) => WORDS[l]);
  const words = names.length === 0 ? "nobody" : names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return { enabled: v?.enabled === true, levels, words };
}

/** The agency or company a booking's papers are addressed to, or null for a walk-in or direct guest. */
export async function paperPartyOf(db: Db, entryId: string): Promise<string | null> {
  const e = await db.entry.findUnique({
    where: { id: entryId },
    select: {
      inquiry: { select: { travelAgent: { select: { displayName: true } }, corporateAccount: { select: { displayName: true } } } },
    },
  });
  if (!e) throw new NotFoundError("Entry");
  return e.inquiry?.travelAgent?.displayName ?? e.inquiry?.corporateAccount?.displayName ?? null;
}

export type PaperRoomTypes = {
  entryId: string;
  /** The agency or company, when the booking is through one. */
  party: string | null;
  /** True when the booking's papers go without room types unless the desk says otherwise. */
  hiddenByDefault: boolean;
  /** Whether this person may send this booking's papers WITH the room types. */
  mayShow: boolean;
  /** Why not, in words, when they may not. */
  why: string | null;
};

function whyNot(party: string, rule: RoomTypesRule): string {
  return rule.enabled
    ? `Sending papers to ${party} with room types is for ${rule.words}.`
    : `Papers to ${party} go without room types. Sending them with room types is off — an admin turns it on in the admin console, under Channels and replies.`;
}

/** What the desk needs to draw the choice: the default, and whether this person may change it for a send. */
export async function describePaperRoomTypes(db: Db, entryId: string, level: string | null | undefined): Promise<PaperRoomTypes> {
  const party = await paperPartyOf(db, entryId);
  if (!party) return { entryId, party: null, hiddenByDefault: false, mayShow: true, why: null };
  const rule = await readRoomTypesRule(db);
  const mayShow = rule.enabled && rule.levels.includes(level as ActorLevel);
  return { entryId, party, hiddenByDefault: true, mayShow, why: mayShow ? null : whyNot(party, rule) };
}

/**
 * Whether a paper going out hides the room types. `show` is what the desk asked for: true to send
 * them, false to leave them off, undefined for the booking's own default. Asking to show them on an
 * agency's or a company's booking without the setting and the role is refused in words, before
 * anything is written or sent.
 */
export async function resolveRoomTypesFace(db: Db, entryId: string, show: boolean | null | undefined, level: string | null | undefined): Promise<boolean> {
  const party = await paperPartyOf(db, entryId);
  if (!party) return false;
  if (show !== true) return true;
  const rule = await readRoomTypesRule(db);
  if (!(rule.enabled && rule.levels.includes(level as ActorLevel))) throw new AuthorizationError(whyNot(party, rule));
  return false;
}

/** The query string's word for a face: `?roomTypes=hidden|shown`, anything else the booking's default. */
export function readRoomTypesQuery(v: unknown): boolean | undefined {
  const s = String(v ?? "").toLowerCase();
  if (s === "hidden" || s === "none") return true;
  if (s === "shown") return false;
  return undefined;
}

/** A face asked for on screen, or the booking's own default — for a preview, where nothing goes out. */
export async function roomTypesHiddenFor(db: Db, entryId: string, asked: boolean | undefined): Promise<boolean> {
  if (asked !== undefined) return asked;
  return (await paperPartyOf(db, entryId)) !== null;
}
