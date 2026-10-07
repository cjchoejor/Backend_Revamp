/**
 * What is typed but not saved, in words — the board's "Not saved yet" list (2026-10-07).
 *
 * Each helper compares a draft from the desk with what the booking holds and says what moved.
 * Counts and dates only: no money is worked out here (the figures come from the backend).
 */
import type { RoomCompositionInput } from "@/lib/api/quotations";
import type { AvailabilityOptionSelected, EntryDetail } from "@/types/api";
import { optionSelectedRoomIds } from "@/types/api";
import { currentPassConfigs } from "@/lib/desk/workspace";
import { operativeRoomCompositions, foldNightsToRangesLabel } from "@/lib/desk/party-rooms";
import { fmtRange, plural } from "@/lib/ds/format";
import type { RoomsDraft, StayDraft, TableDraft } from "./drafts";

export type NightRooms = Map<string, string[]>;

/** The room pick the booking has SAVED, night by night (empty map when none). */
export function savedNightRooms(entry: EntryDetail, nights: string[]): NightRooms {
  const out: NightRooms = new Map();
  const preferred = currentPassConfigs(entry).find((c) => c.optionSelected != null && !c.isStale) ?? null;
  const opt = (preferred?.optionSelected ?? null) as AvailabilityOptionSelected | null;
  if (!opt) return out;
  if ("perNight" in opt && Array.isArray(opt.perNight) && opt.perNight.length > 0) {
    for (const p of opt.perNight) out.set(String(p.date).slice(0, 10), p.roomIds.map((r) => r.roomId));
    return out;
  }
  const ids = optionSelectedRoomIds(opt).filter(Boolean);
  for (const n of nights) out.set(n, ids);
  return out;
}

export function draftNightRooms(d: RoomsDraft | null | undefined): NightRooms | null {
  if (!d) return null;
  return new Map(d.nights.map((n) => [n.date.slice(0, 10), n.roomIds]));
}

/** "Room 201 added for 7 – 9 Oct" · "Room 202 taken off 8 Oct" */
export function roomsChanges(saved: NightRooms, draft: NightRooms, roomNo: (id: string) => string): string[] {
  const nights = [...new Set([...saved.keys(), ...draft.keys()])].sort();
  const added = new Map<string, string[]>();
  const removed = new Map<string, string[]>();
  for (const n of nights) {
    const s = new Set(saved.get(n) ?? []);
    const d = new Set(draft.get(n) ?? []);
    for (const id of d) if (!s.has(id)) added.set(id, [...(added.get(id) ?? []), n]);
    for (const id of s) if (!d.has(id)) removed.set(id, [...(removed.get(id) ?? []), n]);
  }
  const out: string[] = [];
  for (const [id, ns] of added) out.push(`Room ${roomNo(id)} added for ${foldNightsToRangesLabel(ns)}`);
  for (const [id, ns] of removed) out.push(`Room ${roomNo(id)} taken off ${foldNightsToRangesLabel(ns)}`);
  return out;
}

/** "Dates 7 → 15 Oct (was 7 → 12 Oct)" · "Adults 4 (was 2)" */
export function stayChanges(entry: EntryDetail, d: StayDraft): string[] {
  const out: string[] = [];
  const savedIn = entry.checkInDate?.slice(0, 10) ?? "";
  const savedOut = entry.checkOutDate?.slice(0, 10) ?? "";
  if (d.checkIn !== savedIn || d.checkOut !== savedOut)
    out.push(`Dates ${fmtRange(d.checkIn, d.checkOut)} (was ${savedIn ? fmtRange(savedIn, savedOut) : "not set"})`);
  const adults = entry.adultCount ?? entry.guestCount ?? null;
  if (adults !== d.adults) out.push(`Adults ${d.adults} (was ${adults ?? "—"})`);
  const kids = entry.childCount ?? 0;
  const ages = (entry.childAges ?? []).join(", ");
  const draftAges = d.ages.filter((a) => a.trim() !== "").join(", ");
  if (kids !== d.children || ages !== draftAges)
    out.push(
      `Children ${d.children}${draftAges ? ` (ages ${draftAges})` : ""} (was ${kids}${ages ? `, ages ${ages}` : ""})`,
    );
  const rooms = entry.numberOfRooms ?? 1;
  if (rooms !== d.rooms) out.push(`Rooms asked ${d.rooms} (was ${rooms})`);
  const bedWords = (b: Record<string, number> | null | undefined) =>
    Object.entries(b ?? {})
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${n} ${t.charAt(0)}${t.slice(1).toLowerCase()}`)
      .join(", ");
  const savedBeds = bedWords(entry.bedTypeRequest);
  const draftBeds = bedWords(d.beds);
  if (savedBeds !== draftBeds) out.push(`Bed setup ${draftBeds || "none asked"} (was ${savedBeds || "none asked"})`);
  return out;
}

const COMP_FIELDS: ReadonlyArray<readonly [keyof RoomCompositionInput, string]> = [
  ["adultCount", "adults"],
  ["cnb6To10Count", "children 6–10"],
  ["cnbUnder6Count", "children under 6"],
  ["extraBedCount", "extra beds"],
  ["mealPlanCpCount", "on CP"],
  ["mealPlanMaplCount", "on MAP + lunch"],
  ["mealPlanMapdCount", "on MAP + dinner"],
  ["mealPlanApCount", "on AP"],
  ["negotiatedRoomRate", "room rate"],
  ["negotiatedExtraBedRate", "extra-bed rate"],
  ["isFoc", "free of charge"],
  ["serviceChargeApplies", "service charge"],
  ["gstApplies", "GST"],
];

const DEFAULTS: Partial<Record<keyof RoomCompositionInput, unknown>> = { serviceChargeApplies: true, gstApplies: true, isFoc: false };
const norm = (c: RoomCompositionInput | null | undefined, k: keyof RoomCompositionInput): unknown =>
  c?.[k] ?? DEFAULTS[k] ?? (String(k).startsWith("negotiated") ? null : 0);
const show = (v: unknown) => (v == null || v === "" ? "—" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

/** The discount the operative quotation was priced with, in the table's own terms. */
function pricedDiscount(entry: EntryDetail): { value: number; unit: "percent" | "amount" } | null {
  const live = (entry.quotations ?? []).find((q) => q.state === "ACCEPTED") ?? (entry.quotations ?? []).find((q) => q.state === "SENT" || q.state === "DRAFT");
  const d = (live?.commercialTerms as { requestedDiscount?: { discountPercent?: unknown; discountAmount?: unknown } } | null | undefined)?.requestedDiscount;
  if (typeof d?.discountPercent === "number" && d.discountPercent > 0) return { value: d.discountPercent, unit: "percent" };
  if (typeof d?.discountAmount === "number" && d.discountAmount > 0) return { value: d.discountAmount, unit: "amount" };
  return null;
}

/** "Room 201 · adults 2 → 3" — the table against what the quotation was priced on. */
export function tableChanges(entry: EntryDetail, d: TableDraft, roomNo: (id: string) => string): string[] {
  if (!d.unsaved) return [];
  const priced = new Map((operativeRoomCompositions(entry) ?? []).map((c) => [c.roomId, c]));
  const out: string[] = [];
  if (priced.size === 0) out.push("Nothing priced yet — the table becomes the quotation when it is saved");
  for (const row of d.rooms) {
    const was = priced.get(row.roomId);
    if (!was) {
      if (priced.size) out.push(`Room ${roomNo(row.roomId)} · new row (${plural(row.adultCount ?? 0, "adult")})`);
      continue;
    }
    const moved = COMP_FIELDS.filter(([k]) => show(norm(row, k)) !== show(norm(was, k))).map(
      ([k, label]) => `${label} ${show(norm(was, k))} → ${show(norm(row, k))}`,
    );
    if (moved.length) out.push(`Room ${roomNo(row.roomId)} · ${moved.join(" · ")}`);
  }
  const before = pricedDiscount(entry);
  const words = (x: { value: number; unit: string } | null) => (!x ? "none" : x.unit === "percent" ? `${x.value}%` : `Nu ${x.value}`);
  if (words(before) !== words(d.discount)) out.push(`Discount ${words(d.discount)} off the total (was ${words(before)})`);
  return out;
}

/** Which cells of a composition row differ from what was priced — the board marks them amber. */
export function changedCompFields(entry: EntryDetail, row: RoomCompositionInput): Set<keyof RoomCompositionInput> {
  const was = (operativeRoomCompositions(entry) ?? []).find((c) => c.roomId === row.roomId) ?? null;
  const out = new Set<keyof RoomCompositionInput>();
  if (!was) return out;
  for (const [k] of COMP_FIELDS) if (show(norm(row, k)) !== show(norm(was, k))) out.add(k);
  return out;
}
