/**
 * History in the staff's own words (2026-11-26, operator: "inquiry should be showing history like
 * what the user has chosen or inputs, like guest names, stay details and all, negotiation should be
 * showing the meal plan input, rates, adults and children allocated to which room types, the rates
 * agreed, quote generated, changed, active and all, do similar for other sections").
 *
 * The record of an act (a TraceEvent) mostly carries ids — "Quotation generated" names its number
 * and nothing it priced. What the act decided lives on the records it points to: the quotation's
 * own rooms, meal plans and figures (immutable per version), the booking, the payment, the hold.
 * This reads those and writes each act's facts as plain lines. It never computes money: every
 * figure is one the record stores.
 *
 * Two acts leave no record of their own and are added here from their own rows: a charge posted
 * at the desk (the folio line), and who pays being set (the payer record).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { classifyFolioLine, NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX, NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX } from "../../lib/folio-tax-lines.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";
import { hotelCalendarYmd } from "../../lib/stay-dates.js";
import { HOTEL_TIMEZONE } from "../infrastructure/pdf-templates/legphel-document-format.js";

type Ev = { id: string; eventType: string; payload: Prisma.JsonValue; timestamp: Date | string; entityId?: string | null };

export type HistoryExtra = {
  id: string;
  eventType: string;
  actorId: string;
  actorName: string;
  actorLevel: string;
  entityType: string;
  entityId: string;
  operation: string;
  payload: Record<string, unknown>;
  timestamp: string;
  stageContext: string | null;
  segmentContext: null;
  correlationId: null;
  inquiryId: string | null;
  entryId: string;
};

const STEP: Record<string, string> = {
  S1: "Inquiry",
  S2: "Negotiation",
  S3: "Set up",
  S4: "Reserve",
  S5: "Arrival",
  S6: "Check-in",
  S7: "Stay",
  S8: "Check-out",
  S9: "Closed",
};

const CAME_IN: Record<string, string> = {
  WALK_IN: "Walk-in",
  DIRECT_ONLINE: "Direct online",
  DIRECT_VOICE: "Direct by phone",
  OTA: "Online travel agency",
  TRAVEL_AGENT: "Travel agent",
  CORPORATE: "Corporate",
  GROUP_MICE: "Group / MICE",
};

const STAY_KIND: Record<string, string> = {
  LEISURE: "Leisure",
  CORPORATE: "Corporate",
  GROUP: "Group",
  APARTMENT: "Apartment",
  EVENT: "Event",
  CONFERENCE: "Conference",
};

const METHOD: Record<string, string> = {
  CASH: "cash",
  CARD: "card",
  MOBILE_PAYMENT: "QR payment",
  BANK_TRANSFER: "bank transfer",
  INWARD_REMITTANCE: "inward remittance",
  VOUCHER: "the agent's voucher",
  DIRECT_BILL: "on account (invoiced)",
};

const PLAN: Record<string, string> = {
  FULL: "the whole amount",
  PARTIAL: "part now, the rest later",
  INSTALLMENTS: "in instalments",
};

const DUE: Record<string, string> = {
  BEFORE_CHECKIN: "before check-in",
  AT_CHECKIN: "at check-in",
  AT_CHECKOUT: "at check-out",
};

const money = (v: unknown): string | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "object" && v !== null && "toString" in v ? Number(String(v)) : NaN;
  if (!Number.isFinite(n)) return null;
  return `Nu ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** A stay date (stored at UTC midnight), read on the UTC calendar. */
const day = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(d);
};

/** A moment, on the hotel's clock. */
const moment = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: HOTEL_TIMEZONE, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const nightsBetween = (a: unknown, b: unknown): number | null => {
  if (!a || !b) return null;
  const n = Math.round((new Date(String(b)).getTime() - new Date(String(a)).getTime()) / 86_400_000);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function stayLine(checkIn: unknown, checkOut: unknown): string | null {
  const a = day(checkIn);
  const b = day(checkOut);
  if (!a || !b) return null;
  const n = nightsBetween(checkIn, checkOut);
  return `Check-in ${a} · Check-out ${b}${n ? ` · ${plural(n, "night")}` : ""}`;
}

function partyLine(p: { adultCount?: unknown; childCount?: unknown; childAges?: unknown; guestCount?: unknown }): string | null {
  const adults = typeof p.adultCount === "number" ? p.adultCount : null;
  const kids = typeof p.childCount === "number" ? p.childCount : null;
  const ages = Array.isArray(p.childAges) ? (p.childAges as unknown[]).filter((x) => typeof x === "number") as number[] : [];
  if (adults == null && kids == null) return typeof p.guestCount === "number" ? plural(p.guestCount, "guest") : null;
  const bits = [plural(adults ?? 0, "adult")];
  if (kids) bits.push(`${plural(kids, "child", "children")}${ages.length ? ` (aged ${ages.join(", ")})` : ""}`);
  return bits.join(", ");
}

function bedAsk(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const words: Record<string, string> = { KING: "King", TWIN: "Twin", QUEEN: "Queen", SINGLE: "Single" };
  const parts = Object.entries(v as Record<string, unknown>)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([k, n]) => `${n} ${words[k] ?? k}`);
  return parts.length ? parts.join(", ") : null;
}

/** The meal plans on a room, as the desk names them. */
function mealsOf(c: Record<string, unknown>): string {
  const n = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : 0);
  const parts: string[] = [];
  if (n("mealPlanCpCount")) parts.push(`breakfast (CP) for ${n("mealPlanCpCount")}`);
  if (n("mealPlanMaplCount")) parts.push(`breakfast and lunch (MAP+L) for ${n("mealPlanMaplCount")}`);
  if (n("mealPlanMapdCount")) parts.push(`breakfast and dinner (MAP+D) for ${n("mealPlanMapdCount")}`);
  if (n("mealPlanApCount")) parts.push(`all meals (AP) for ${n("mealPlanApCount")}`);
  if (n("mealPlanOthersCount")) parts.push(`meals à la carte for ${n("mealPlanOthersCount")}`);
  return parts.length ? parts.join(", ") : "room only";
}

function guestsOf(c: Record<string, unknown>): string {
  const n = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : 0);
  const bits = [plural(n("adultCount"), "adult")];
  if (n("cnb6To10Count")) bits.push(`${plural(n("cnb6To10Count"), "child", "children")} 6–10`);
  if (n("cnbUnder6Count")) bits.push(`${plural(n("cnbUnder6Count"), "child", "children")} under 6`);
  return bits.join(", ");
}

const BILLING_WORDS = (model: string | null | undefined, party: "travel agent" | "corporate" | null) => {
  switch (model) {
    case "TOUR_OPERATOR_VOUCHER":
      return `Package to ${party ?? "the account"} · extras to guest`;
    case "DIRECT_BILL":
      return `Everything to ${party ?? "the account"}`;
    case "GUEST_PAY":
      return "Everything to guest";
    case "GOVERNMENT":
      return "Everything to the government account";
    default:
      return model ? model.replace(/_/g, " ").toLowerCase() : null;
  }
};

export async function buildHistoryFacts(
  prisma: PrismaClient,
  entryId: string,
  events: Ev[],
): Promise<{ facts: Record<string, string[]>; extra: HistoryExtra[]; stages: Record<string, string> }> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      inquiryId: true,
      checkInDate: true,
      checkOutDate: true,
      adultCount: true,
      childCount: true,
      childAges: true,
      guestCount: true,
      numberOfRooms: true,
      useType: true,
      bedTypeRequest: true,
      contactPersonName: true,
      contactPersonPhone: true,
      inquiry: {
        select: {
          sourceChannel: true,
          cameInAs: true,
          callerTitle: true,
          callerFirstName: true,
          callerLastName: true,
          callerPhone: true,
          callerEmail: true,
          partyContactName: true,
          partyContactPhone: true,
          ratePackageIds: true,
          ratePackageId: true,
          travelAgent: { select: { displayName: true } },
          corporateAccount: { select: { displayName: true } },
        },
      },
      quotations: { select: { id: true, referenceNumber: true, versionNumber: true, totalAmount: true, validUntil: true, commercialTerms: true, createdAt: true } },
      reservations: { select: { id: true, confirmationVoucherNumber: true, frozenCheckInDate: true, frozenCheckOutDate: true, frozenCommercialTerms: true } },
      committedHold: { select: { id: true, perNightBreakdown: true, roomId: true } },
      stageDwellRecords: { select: { stage: true, enteredAt: true }, orderBy: { enteredAt: "asc" } },
      folio: {
        select: {
          id: true,
          invoices: { select: { id: true, invoiceType: true, invoiceNumber: true, documentNumber: true, versionNumber: true, totalAmount: true } },
          payments: { select: { id: true, amount: true, paymentMethod: true, paymentDirection: true, bankName: true, journalNumber: true, createdAt: true, stage: true, notes: true, recordedBy: true } },
          lines: { select: { id: true, lineType: true, description: true, amount: true, chargeDate: true, stage: true, postedBy: true, postedAt: true, nightAuditRecordId: true, roomId: true, billingModel: true } },
        },
      },
    },
  });
  if (!entry) return { facts: {}, extra: [], stages: {} };

  const rooms = await prisma.room.findMany({ select: { id: true, roomNumber: true, roomType: { select: { name: true } } } });
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const roomNo = (id: unknown) => (typeof id === "string" ? roomById.get(id)?.roomNumber ?? null : null);
  const typeOfRoom = (id: unknown) => (typeof id === "string" ? roomById.get(id)?.roomType?.name ?? null : null);
  const roomList = (ids: unknown): string | null => {
    const nos = (Array.isArray(ids) ? ids : []).map(roomNo).filter((x): x is string => !!x);
    const uniq = [...new Set(nos)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return uniq.length ? `${uniq.length > 1 ? "Rooms" : "Room"} ${uniq.join(", ")}` : null;
  };

  const packageIds = new Set<string>(entry.inquiry?.ratePackageIds ?? []);
  if (entry.inquiry?.ratePackageId) packageIds.add(entry.inquiry.ratePackageId);
  const packages = packageIds.size ? await prisma.ratePackage.findMany({ where: { id: { in: [...packageIds] } }, select: { id: true, name: true } }) : [];
  const party = entry.inquiry?.travelAgent?.displayName ? "travel agent" : entry.inquiry?.corporateAccount?.displayName ? "corporate" : null;
  const partyName = entry.inquiry?.travelAgent?.displayName ?? entry.inquiry?.corporateAccount?.displayName ?? null;

  const guestIds = events
    .filter((e) => e.eventType === "ENTRY.GUEST_NAMED")
    .map((e) => (e.payload as { guestProfileId?: string } | null)?.guestProfileId)
    .filter((x): x is string => !!x);
  const guests = guestIds.length
    ? await prisma.guestProfile.findMany({ where: { id: { in: guestIds } }, select: { id: true, title: true, firstName: true, lastName: true, phone: true, email: true } })
    : [];
  const guestById = new Map(guests.map((g) => [g.id, g]));

  const commIds = events.map((e) => (e.payload as { communicationRecordId?: string } | null)?.communicationRecordId).filter((x): x is string => !!x);
  const comms = commIds.length ? await prisma.communicationRecord.findMany({ where: { id: { in: commIds } }, select: { id: true, channel: true, payload: true } }) : [];
  const commById = new Map(comms.map((c) => [c.id, c]));

  const quoteById = new Map(entry.quotations.map((q) => [q.id, q]));
  const invoiceById = new Map((entry.folio?.invoices ?? []).map((i) => [i.id, i]));
  const resById = new Map(entry.reservations.map((r) => [r.id, r]));
  const payments = entry.folio?.payments ?? [];

  const facts: Record<string, string[]> = {};
  const put = (id: string, lines: Array<string | null | undefined | false>) => {
    const keep = lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0);
    if (keep.length) facts[id] = keep;
  };

  // Oldest first, so an intake change can say what it changed from.
  const ordered = [...events].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const stayChangers = new Set(["ENTRY.INTAKE_UPDATED", "ENTRY.STAY_DATES_CHANGED", "ENTRY.NEGOTIATION_CONFIGURATION_AMENDED", "ENTRY.EARLY_DEPARTURE_RECORDED", "ENTRY.ROOM_CHANGED"]);
  const stayChanged = ordered.some((e) => stayChangers.has(e.eventType));
  let intake: Record<string, unknown> | null = null;

  for (const ev of ordered) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.eventType) {
      case "ENTRY.CREATED": {
        const i = entry.inquiry;
        const cameIn = i?.cameInAs ? CAME_IN[i.cameInAs] ?? null : null;
        const caller = i ? [i.callerTitle, i.callerFirstName, i.callerLastName].filter(Boolean).join(" ") : "";
        const pkgNames = packages.map((x) => x.name);
        // What was asked when the booking was made: carried on the record since 2026-11-26; before
        // that, read off the booking only when nothing has changed the stay since.
        const asked = (p.intake ?? null) as Record<string, unknown> | null;
        const src = asked ?? (stayChanged ? null : { ...entry, checkInDate: entry.checkInDate, checkOutDate: entry.checkOutDate });
        intake = asked
          ? { ...asked }
          : src
            ? { checkInDate: entry.checkInDate, checkOutDate: entry.checkOutDate, adultCount: entry.adultCount, childCount: entry.childCount, childAges: entry.childAges, numberOfRooms: entry.numberOfRooms }
            : null;
        put(ev.id, [
          `Came in as: ${cameIn ?? (partyName ? (party === "travel agent" ? "Travel agent" : "Corporate") : "Direct by phone")}${partyName ? ` · ${partyName}` : ""}`,
          pkgNames.length ? `Rate package${pkgNames.length > 1 ? "s" : ""}: ${pkgNames.join(", ")}` : null,
          caller || i?.callerPhone || i?.callerEmail ? `Caller: ${[caller, i?.callerPhone, i?.callerEmail].filter(Boolean).join(" · ")}` : null,
          i?.partyContactName ? `Contact person: ${[i.partyContactName, i.partyContactPhone].filter(Boolean).join(" · ")}` : null,
          src ? stayLine(src.checkInDate, src.checkOutDate) : null,
          src ? `Guests: ${partyLine(src as never) ?? "—"}${typeof src.numberOfRooms === "number" ? ` · ${plural(src.numberOfRooms, "room")} asked` : ""}` : null,
          src && typeof src.useType === "string" ? `Kind of stay: ${STAY_KIND[src.useType] ?? src.useType}` : null,
          src && bedAsk(src.bedTypeRequest) ? `Beds asked: ${bedAsk(src.bedTypeRequest)}` : null,
        ]);
        break;
      }
      case "ENTRY.INTAKE_UPDATED": {
        const prev: Record<string, unknown> | null = intake;
        const lines: string[] = [];
        const changed = (k: string) => k in p && (!prev || JSON.stringify(prev[k]) !== JSON.stringify(p[k]));
        if (changed("checkInDate") || changed("checkOutDate")) {
          const now = stayLine(p.checkInDate ?? prev?.checkInDate, p.checkOutDate ?? prev?.checkOutDate);
          const was = prev ? stayLine(prev.checkInDate, prev.checkOutDate) : null;
          if (now) lines.push(was && was !== now ? `Stay: ${was} → ${now}` : `Stay: ${now}`);
        }
        if (changed("adultCount") || changed("childCount") || changed("childAges")) {
          const now = partyLine({ ...prev, ...p });
          const was = prev ? partyLine(prev) : null;
          if (now) lines.push(was && was !== now ? `Guests: ${was} → ${now}` : `Guests: ${now}`);
        }
        if (changed("numberOfRooms") && typeof p.numberOfRooms === "number") {
          lines.push(typeof prev?.numberOfRooms === "number" ? `Rooms asked: ${prev.numberOfRooms} → ${p.numberOfRooms}` : `Rooms asked: ${p.numberOfRooms}`);
        }
        if (changed("useType") && typeof p.useType === "string") lines.push(`Kind of stay: ${STAY_KIND[p.useType] ?? p.useType}`);
        if (changed("bedTypeRequest")) lines.push(`Beds asked: ${bedAsk(p.bedTypeRequest) ?? "no preference"}`);
        if ("contactPersonName" in p || "contactPersonPhone" in p) {
          const who = [p.contactPersonName, p.contactPersonPhone].filter((x) => typeof x === "string" && x).join(" · ");
          if (who) lines.push(`Who is arriving: ${who}`);
        }
        put(ev.id, lines);
        intake = { ...(prev ?? {}), ...p };
        break;
      }
      case "ENTRY.GUEST_NAMED": {
        const g = typeof p.guestProfileId === "string" ? guestById.get(p.guestProfileId) : null;
        const how: Record<string, string> = { CALLER: "the caller", EXISTING: "a guest on file", NEW: "a new guest record" };
        put(ev.id, [
          g ? `Guest staying: ${guestDisplayName(g)}${g.phone ? ` · ${g.phone}` : ""}${g.email ? ` · ${g.email}` : ""}` : null,
          typeof p.mode === "string" && how[p.mode] ? `Named as ${how[p.mode]}${p.reusedOnFile === true ? " (found on file by phone or email)" : ""}` : null,
          (p.duplicate as { conflictingEntryId?: string } | null)?.conflictingEntryId
            ? `Asked whether it is the same booking as ${(p.duplicate as { conflictingEntryId: string }).conflictingEntryId}`
            : null,
        ]);
        break;
      }
      case "INQUIRY.CALLER_UPDATED":
      case "INQUIRY.SOURCE_CHANGED": {
        const after = (p.after ?? p.to ?? p) as Record<string, unknown>;
        const name = [after.callerTitle, after.callerFirstName, after.callerLastName].filter((x) => typeof x === "string" && x).join(" ");
        put(ev.id, [
          name ? `Caller: ${[name, after.callerPhone, after.callerEmail].filter((x) => typeof x === "string" && x).join(" · ")}` : null,
          typeof after.cameInAs === "string" ? `Came in as: ${CAME_IN[after.cameInAs] ?? after.cameInAs}` : null,
        ]);
        break;
      }
      case "BOOKING_ROOMS.PICKED_BY_TYPE": {
        const per = Array.isArray(p.perNight) ? (p.perNight as Array<{ date?: string; types?: Array<{ type?: string; count?: number }> }>) : [];
        const word = (t: Array<{ type?: string; count?: number }> | undefined) => (t ?? []).map((x) => `${x.count ?? 1} ${x.type ?? "room"}`).join(", ");
        const words = per.map((n) => word(n.types));
        if (words.length && words.every((w) => w === words[0])) put(ev.id, [`Every night: ${words[0]}`]);
        else put(ev.id, per.slice(0, 10).map((n) => `${day(n.date) ?? n.date}: ${word(n.types)}`).concat(per.length > 10 ? [`and ${per.length - 10} more nights`] : []));
        break;
      }
      case "CONFIGURATION_SELECTED": {
        const per = Array.isArray(p.perNight) ? (p.perNight as Array<{ date?: string; roomIds?: unknown[] }>) : [];
        const words = per.map((n) => roomList((n.roomIds ?? []).map((r) => (typeof r === "string" ? r : (r as { roomId?: string })?.roomId))));
        if (words.length && words.every((w) => w === words[0])) put(ev.id, [`Every night: ${words[0] ?? "—"}`]);
        else if (words.length) put(ev.id, per.slice(0, 10).map((n, i) => `${day(n.date) ?? n.date}: ${words[i] ?? "—"}`));
        else put(ev.id, [roomList(p.roomIds)]);
        break;
      }
      case "QUOTATION.CREATED": {
        const q = typeof p.quotationId === "string" ? quoteById.get(p.quotationId) : null;
        if (!q) break;
        const terms = (q.commercialTerms ?? {}) as Record<string, unknown>;
        const comps = Array.isArray(terms.roomCompositions) ? (terms.roomCompositions as Array<Record<string, unknown>>) : [];
        const totals = (terms.compositionTotals ?? null) as { subtotal?: number; serviceCharge?: number; gst?: number; total?: number; perRoom?: Array<Record<string, unknown>> } | null;
        const perRoom = new Map((totals?.perRoom ?? []).map((r) => [r.roomId as string, r]));
        // Rooms that read the very same set out once, as the paper does.
        const groups = new Map<string, { count: number; line: string }>();
        for (const c of comps) {
          const pr = perRoom.get(c.roomId as string) ?? {};
          const type = typeOfRoom(c.roomId) ?? "Room";
          const rate = money(c.negotiatedRoomRate ?? pr.roomRate);
          const beds = typeof c.extraBedCount === "number" && c.extraBedCount > 0 ? ` · ${plural(c.extraBedCount, "extra bed")}` : "";
          const foc = c.isFoc === true ? " · free of charge" : "";
          const line = `${guestsOf(c)} · ${mealsOf(c)}${beds}${rate ? ` · room ${rate} a night${c.negotiatedRoomRate != null ? " (agreed)" : ""}` : ""}${foc}`;
          const key = `${type}|${line}`;
          const g = groups.get(key);
          if (g) g.count += 1;
          else groups.set(key, { count: 1, line: `${type}: ${line}` });
        }
        const roomLines = [...groups.values()].map((g) => (g.count > 1 ? `${g.count} × ${g.line.replace(/^([^:]+): /, "$1, each: ")}` : g.line));
        const disc = (terms.compositionDiscount ?? terms.requestedDiscount ?? null) as { discountPercent?: number; discountAmount?: number; amountOffTotal?: number; netReduction?: number } | null;
        const discLine = disc
          ? disc.discountPercent
            ? `Discount: ${disc.discountPercent}%`
            : disc.discountAmount
              ? `Discount: ${money(disc.discountAmount)} off`
              : null
          : null;
        const pkg = (terms.ratePackage as { name?: string } | null)?.name ?? null;
        const byType = terms.ratePackagesByType ? Object.values(terms.ratePackagesByType as Record<string, { packageName?: string }>).map((x) => x.packageName).filter(Boolean) : [];
        const pkgs = [...new Set([pkg, ...byType].filter((x): x is string => !!x))];
        put(ev.id, [
          ...roomLines,
          pkgs.length ? `Priced on the package${pkgs.length > 1 ? "s" : ""}: ${pkgs.join(", ")}` : null,
          discLine,
          totals?.total != null
            ? `Total ${money(totals.total)} (net ${money(totals.subtotal)?.replace("Nu ", "")} + service charge ${money(totals.serviceCharge)?.replace("Nu ", "")} + GST ${money(totals.gst)?.replace("Nu ", "")})`
            : q.totalAmount != null
              ? `Total ${money(q.totalAmount)}`
              : null,
          q.validUntil ? `Valid until ${moment(q.validUntil)}` : null,
          q.versionNumber > 1 ? `Version ${q.versionNumber} of ${q.referenceNumber.replace(/-v\d+$/, "")} — it replaces version ${q.versionNumber - 1}` : null,
        ]);
        break;
      }
      case "QUOTATION.SENT": {
        const c = typeof p.communicationRecordId === "string" ? commById.get(p.communicationRecordId) : null;
        const to = (c?.payload as { intendedRecipient?: string; to?: string } | null)?.intendedRecipient ?? (c?.payload as { to?: string } | null)?.to ?? null;
        put(ev.id, [
          c ? `${c.channel === "WHATSAPP" ? "On WhatsApp" : c.channel === "EMAIL" ? "By email" : String(c.channel).toLowerCase()}${to ? ` to ${to}` : ""}` : null,
          p.pricesShown === false ? "Sent without the prices" : null,
          p.validUntil ? `Valid until ${moment(p.validUntil)}` : null,
        ]);
        break;
      }
      case "SPECULATIVE_HOLD.PLACED":
        put(ev.id, [roomList(p.roomIds ?? [p.roomId]), p.expiresAt ? `Held until ${moment(p.expiresAt)}` : null]);
        break;
      case "COMMITTED_HOLD.PLACED": {
        const per = entry.committedHold?.id === p.committedHoldId ? entry.committedHold?.perNightBreakdown : null;
        const ids = Array.isArray(per)
          ? (per as Array<{ roomIds?: Array<{ roomId?: string } | string> }>).flatMap((n) => (n.roomIds ?? []).map((r) => (typeof r === "string" ? r : r.roomId)))
          : [p.roomId];
        put(ev.id, [roomList(ids), p.expiresAt ? `Blocked until ${moment(p.expiresAt)}${p.expirySource === "BOOKING" ? " (the time set for this booking)" : ""}` : null]);
        break;
      }
      case "ADVANCE_PAYMENT.REQUIREMENT_SET": {
        const basis = (p.basis ?? {}) as { mode?: string; percent?: number; baseTotal?: number };
        put(ev.id, [
          basis.mode === "PERCENT" && basis.percent != null
            ? `${basis.percent}% of the quotation's ${money(basis.baseTotal)} — ${money(p.requiredAmount)}`
            : p.requiredAmount != null
              ? `${money(p.requiredAmount)}`
              : p.mode === "CLEAR"
                ? "No advance asked"
                : null,
        ]);
        break;
      }
      case "ADVANCE_PAYMENT.PLAN_RECORDED":
        put(ev.id, [
          typeof p.plan === "string"
            ? `${
                p.plan === "FULL"
                  ? `The whole amount${typeof p.balanceDueAt === "string" ? ` ${DUE[p.balanceDueAt] ?? ""}` : ", now"}`
                  : p.plan === "INSTALLMENTS"
                    ? `In instalments${typeof p.balanceDueAt === "string" ? `, the last ${DUE[p.balanceDueAt] ?? ""}` : ""}`
                    : `Part now${typeof p.balanceDueAt === "string" ? `, the rest ${DUE[p.balanceDueAt] ?? ""}` : ", the rest later"}`
              }${p.promisedBy ? ` — promised by ${moment(p.promisedBy)}` : ""}`
            : null,
          typeof p.note === "string" && p.note.trim() ? `They said: “${p.note.trim()}”` : null,
        ]);
        break;
      case "FOLIO.PAYMENT_RECORDED":
      case "ADVANCE_PAYMENT.RECORDED": {
        const at = new Date(ev.timestamp).getTime();
        const pay =
          (typeof p.paymentId === "string" ? payments.find((x) => x.id === p.paymentId) : null) ??
          payments
            .filter((x) => x.paymentDirection === "IN" && (p.amount == null || Number(x.amount) === Number(p.amount)))
            .sort((a, b) => Math.abs(a.createdAt.getTime() - at) - Math.abs(b.createdAt.getTime() - at))[0];
        const close = pay && Math.abs(pay.createdAt.getTime() - at) < 120_000 ? pay : null;
        put(ev.id, [
          close
            ? `${money(close.amount)} by ${METHOD[close.paymentMethod ?? ""] ?? (close.paymentMethod ?? "").toLowerCase()}${close.bankName ? ` · ${close.bankName}` : ""}${close.journalNumber ? ` · journal ${close.journalNumber}` : ""}`
            : p.amount != null
              ? money(p.amount)
              : null,
          typeof p.stage === "string" && STEP[p.stage] ? `Taken at ${STEP[p.stage]}` : null,
        ]);
        break;
      }
      case "INVOICE.CREATED": {
        const inv = typeof p.invoiceId === "string" ? invoiceById.get(p.invoiceId) : null;
        const kind: Record<string, string> = { PROFORMA: "Proforma", FINAL: "Tax invoice", INTERIM: "Mid-stay bill" };
        if (inv)
          put(ev.id, [
            `${kind[inv.invoiceType] ?? "Invoice"} ${inv.documentNumber ?? inv.invoiceNumber ?? inv.id}${inv.versionNumber > 1 ? ` · version ${inv.versionNumber}` : ""}`,
            inv.totalAmount != null ? `Total ${money(inv.totalAmount)}` : null,
          ]);
        break;
      }
      case "RESERVATION_CONFIRMED":
      case "RESERVATION.CONFIRMED": {
        const r = typeof p.reservationId === "string" ? resById.get(p.reservationId) : null;
        if (!r) break;
        const t = (r.frozenCommercialTerms ?? null) as { compositionTotals?: { total?: number } } | null;
        put(ev.id, [
          stayLine(r.frozenCheckInDate, r.frozenCheckOutDate),
          r.confirmationVoucherNumber ? `Confirmation voucher ${r.confirmationVoucherNumber}` : null,
          t?.compositionTotals?.total != null ? `Reserved at ${money(t.compositionTotals.total)}` : null,
          p.reconfirmation === true ? "Reserved again after a change" : null,
        ]);
        break;
      }
      case "CHECK_IN.KEYS_ISSUED":
        put(ev.id, [roomList(p.issuedKeyRoomIds), typeof p.keyCount === "number" ? plural(p.keyCount, "key") : null]);
        break;
      case "GUEST.IDENTITY_VERIFIED": {
        const path: Record<string, string> = { FIRST_TIME: "a first-time guest", RETURNING: "a returning guest", RETURNING_EXPIRED: "a returning guest, document renewed", VIP: "a VIP" };
        put(ev.id, [
          typeof p.documentType === "string" ? `Document: ${p.documentType.replace(/_/g, " ").toLowerCase()}` : null,
          typeof p.verificationPath === "string" ? `As ${path[p.verificationPath] ?? p.verificationPath.toLowerCase()}` : null,
        ]);
        break;
      }
      case "NIGHT_AUDIT.BOOKING_NIGHT_POSTED": {
        // "Night audit room charge · Room 202" + "Night audit meal plan · Room 202" → one line.
        const ls = Array.isArray(p.lines) ? (p.lines as string[]) : [];
        const roomsOf = (prefix: string) => [...new Set(ls.filter((l) => l.startsWith(prefix)).map((l) => /Room (\S+)/.exec(l)?.[1]).filter(Boolean))];
        const roomCharge = roomsOf(NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX);
        const meals = roomsOf(NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX);
        put(ev.id, [
          p.operatingDate ? `The night of ${day(p.operatingDate)}` : null,
          roomCharge.length ? `Room charge${meals.length ? " and meal plan" : ""} posted for ${roomCharge.length > 1 ? "Rooms" : "Room"} ${roomCharge.join(", ")}` : ls.length ? ls.join(" · ") : null,
        ]);
        break;
      }
      case "SETTLEMENT.COMPLETED":
      case "SETTLEMENT.PARTIAL":
      case "SETTLEMENT.OUTSTANDING":
        put(ev.id, [
          p.settledAmount != null ? `${money(p.settledAmount)} by ${METHOD[String(p.settlementMethod)] ?? String(p.settlementMethod ?? "").toLowerCase()}` : null,
          p.billingModel ? `Who pays: ${BILLING_WORDS(String(p.billingModel), party)}` : null,
          p.outstandingAfter != null ? (Number(p.outstandingAfter) > 0 ? `Still owed after it: ${money(p.outstandingAfter)}` : "Nothing left owed") : null,
        ]);
        break;
      // A charge corrected after the bill was settled (2026-11-26).
      case "FOLIO.CHARGE_CORRECTED_AFTER_SETTLEMENT": {
        const vr = Array.isArray(p.voucherReduced) ? (p.voucherReduced as Array<{ amount: number }>) : [];
        const rd = p.refundDue as { amount?: number; payerName?: string } | null;
        const ir = Array.isArray(p.invoicesReplaced) ? (p.invoicesReplaced as Array<{ oldRef: string; newId: string }>) : [];
        put(ev.id, [
          p.delta != null ? `Net ${Number(p.delta) < 0 ? "down" : "up"} by ${money(Math.abs(Number(p.delta)))}, its service charge and GST with it` : null,
          p.reason ? `Why: "${String(p.reason)}"` : null,
          p.payer ? `On ${String(p.payer)}'s share` : null,
          ...vr.map((v) => `The agency's voucher reduced by ${money(v.amount)}`),
          rd?.amount ? `To refund: ${money(rd.amount)} to ${rd.payerName ?? "the payer"}` : null,
          ...ir.map((i) => `Tax invoice ${i.oldRef} replaced by ${i.newId}`),
          Number(p.owedNow) > 0 ? `Owed now: ${money(p.owedNow)}` : null,
        ]);
        break;
      }
      // Leaving owing at Check-out, asked of the FOM (2026-11-26).
      case "LEAVE_OWING.REQUESTED":
        put(ev.id, [
          p.amountOwed != null ? `Owed: ${money(p.amountOwed)}` : null,
          p.guestWords ? `The guest said: "${String(p.guestWords)}"` : null,
        ]);
        break;
      case "LEAVE_OWING.APPROVED":
        put(ev.id, [
          p.amountOwed != null ? `Left owing: ${money(p.amountOwed)}` : null,
          p.payBy ? `Pay by ${hotelCalendarYmd(new Date(String(p.payBy))).split("-").reverse().join("/")}` : "No time limit",
          p.note ? `The FOM's note: "${String(p.note)}"` : null,
        ]);
        break;
      case "LEAVE_OWING.REJECTED":
        put(ev.id, [p.note ? `Why: "${String(p.note)}"` : null]);
        break;
      case "KEY_RETURN.RECORDED":
        put(ev.id, [
          Array.isArray(p.returnedRoomIds) && (p.returnedRoomIds as unknown[]).length ? `Returned: ${roomList(p.returnedRoomIds)}` : null,
          Array.isArray(p.lostRoomIds) && (p.lostRoomIds as unknown[]).length ? `Lost: ${roomList(p.lostRoomIds)}` : null,
          typeof p.keyCountIssued === "number" && p.keyCountIssued > 0 ? `${p.keyCountReturned ?? 0} of ${p.keyCountIssued} keys back` : null,
        ]);
        break;
      case "ENTRY.STAGE_TRANSITION": {
        const to = (p.toStage ?? p.to) as string | undefined;
        if (to === "S2" && entry.inquiry) {
          // Moving to Negotiation: what the inquiry asked, as it stood.
          if (intake) put(ev.id, [stayLine(intake.checkInDate, intake.checkOutDate), partyLine(intake) ? `Guests: ${partyLine(intake)}` : null]);
        }
        break;
      }
      default:
        break;
    }
  }

  // ---- acts with no record of their own ----
  const extra: HistoryExtra[] = [];
  const staffIds = new Set<string>();
  const lines = (entry.folio?.lines ?? []).filter(
    (l) =>
      !l.nightAuditRecordId &&
      classifyFolioLine(l) === "CHARGE" &&
      !l.description.startsWith(NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX) &&
      !l.description.startsWith(NIGHT_AUDIT_MEAL_PLAN_DESCRIPTION_PREFIX) &&
      l.lineType !== "ROOM_CHARGE",
  );
  for (const l of lines) staffIds.add(l.postedBy);
  const transitions = entry.folio
    ? await prisma.billingModelTransitionRecord.findMany({
        where: { folioId: entry.folio.id, folioLineId: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, fromModel: true, toModel: true, createdAt: true, createdBy: true, reason: true, changeSource: true },
      })
    : [];
  for (const t of transitions) staffIds.add(t.createdBy);
  const staff = staffIds.size ? await prisma.staffUser.findMany({ where: { id: { in: [...staffIds] } }, select: { id: true, fullName: true, actorLevel: true } }) : [];
  const staffById = new Map(staff.map((s) => [s.id, s]));
  const dwell = entry.stageDwellRecords;
  const stageAt = (t: Date): string | null => {
    let s: string | null = null;
    for (const d of dwell) if (d.enteredAt.getTime() <= t.getTime()) s = d.stage;
    return s;
  };
  const base = (id: string, eventType: string, at: Date, actorId: string, stage: string | null, payload: Record<string, unknown>): HistoryExtra => ({
    id,
    eventType,
    actorId,
    actorName: staffById.get(actorId)?.fullName ?? actorId,
    actorLevel: staffById.get(actorId)?.actorLevel ?? "SYSTEM",
    entityType: "Folio",
    entityId: entry.folio?.id ?? entryId,
    operation: "CREATE",
    payload,
    timestamp: at.toISOString(),
    stageContext: stage,
    segmentContext: null,
    correlationId: null,
    inquiryId: entry.inquiryId,
    entryId,
  });
  for (const l of lines) {
    const id = `line-${l.id}`;
    const credit = l.lineType === "CREDIT_NOTE";
    extra.push(base(id, credit ? "FOLIO.CREDIT_NOTE_POSTED" : "FOLIO.CHARGE_POSTED", l.postedAt, l.postedBy, l.stage, { description: l.description }));
    put(id, [
      `${l.description} · ${money(l.amount)}${credit ? "" : " before service charge and GST"}`,
      l.roomId ? `For ${roomList([l.roomId])}` : null,
      l.billingModel ? `Goes to: ${l.billingModel === "GUEST_PAY" ? "the guest" : partyName ?? "the account"}` : null,
    ]);
  }
  for (const t of transitions) {
    const id = `payer-${t.id}`;
    extra.push(base(id, "FOLIO.WHO_PAYS_SET", t.createdAt, t.createdBy, stageAt(t.createdAt), { changeSource: t.changeSource }));
    put(id, [
      t.fromModel && t.fromModel !== t.toModel
        ? `${BILLING_WORDS(t.fromModel, party)} → ${BILLING_WORDS(t.toModel, party)}`
        : BILLING_WORDS(t.toModel, party),
      t.reason ? t.reason : null,
    ]);
  }
  // An act recorded with no step (rooms picked, the guest named, reserved) goes under the step the
  // booking was at when it happened — read off the booking's own step records.
  const stages: Record<string, string> = {};
  for (const ev of events as Array<Ev & { stageContext?: string | null }>) {
    if (ev.stageContext) continue;
    const s = stageAt(new Date(ev.timestamp));
    if (s) stages[ev.id] = s;
  }
  return { facts, extra, stages };
}
