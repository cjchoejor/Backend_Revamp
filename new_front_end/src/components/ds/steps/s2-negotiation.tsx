"use client";

/**
 * Step 2 · Negotiation — "shape the price" (SS03 §5, prototype `stepCanvas[2]`, Storyboard 02).
 *
 * Who sleeps where and their meals (the per-room table — the old planner, kept whole), the two
 * doors — provisional block or send the quote — the quotation as a paper with the guest's answer, earlier versions,
 * and the race with another booking.
 *
 * Generating the quotation is what the gate needs; sending it is not (operator ruling
 * 2026-07-28). Every figure is the backend's: the table prices itself through the live preview,
 * the paper's total comes from the billing summary. Nothing is added up here.
 */
import { liveQuotesThisPass } from "@/lib/desk/workspace";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BindingBox, Button, Chip, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useBookingRooms } from "@/hooks/use-booking-rooms";
import { getChildPolicy } from "@/lib/api/child-policy";
import { openQuotationPdf } from "@/lib/api/documents";
import { getBillingSummary } from "@/lib/api/entries";
import {
  acceptQuotation,
  approveQuotationDiscount,
  createQuotation,
  placeSpeculativeHold,
  releaseSpeculativeHold,
  resolveQuotationAckOpenLoop,
  sendQuotation,
  supersedeQuotation,
  getQuoteValidityWindow,
  type RoomCompositionInput,
} from "@/lib/api/quotations";
import { RoomCompositionPlanner } from "@/components/desk/workspace/room-compositions-board";
import { nightOverridesCanon } from "@/components/desk/workspace/room-compositions-table";
import { ChangeConfiguration, DecidedConfigurationChanges, WaitingConfigurationChange } from "./s2-configuration";
import { operativeRoomCompositions, roomNightsByRoom, roomStayRangesByRoom } from "@/lib/desk/party-rooms";
import { fmtDateTime, fmtStamp, money, plural } from "@/lib/ds/format";
import { optionSelectedRoomIds, preferredHoldRoomId, type EntryDetail, type QuotationSummary, type SpeculativeHoldSummary } from "@/types/api";
import { Choice, latestDispatched, useCommunications, useReplyAsked, DsDialog, Live, Notice, OtherWaysTabs, ChangeBookingMenu, StageActs, useOpenAlsoWay, PaperDrawer, QuotationSendDialog, ReasonDialog, SeeRow, StepCanvas, StepCard, Tool, atLeast, toastRefusal, type PaperRef, useBedPlan, useOpenFileTab, useRefreshEntry, useStepFlow, useFlowCard, anchorFor, revealCard, words, parkTab, declineTab } from "./kit";
import { usePublishPriceDraft } from "@/lib/ds/stay-price";
import { Help } from "@/components/ds/help";
import type { ChangeBookingItem } from "./kit";
import { CompetingClaimsCard, LEVEL_WORD, passesOf, roomsHeldWord, useCompetingClaims, useRoomNumbers, useRoomTypeNames } from "./s2-shared";
import { useInvoiceRecipient } from "@/hooks/use-invoice-recipient";
import { billNo, proformaBaseNo, quoteNo } from "@/lib/ds/papers";

/* ------------------------------------------------------------------ vocabulary */

const QUOTE_STATE: Record<string, { word: string; tone: "success" | "warning" | "quiet" | "default" }> = {
  // Amber since 2026-11-05 (operator): the guest has not got it, which is the thing to see here.
  DRAFT: { word: "generated · not sent", tone: "warning" },
  SENT: { word: "sent · awaiting the answer", tone: "warning" },
  ACCEPTED: { word: "accepted", tone: "success" },
  SUPERSEDED: { word: "replaced", tone: "quiet" },
  EXPIRED: { word: "lapsed", tone: "warning" },
};

/** A quotation's standing. With its reply off nobody is waiting on the guest, so it reads "sent" (2026-11-03). */
function quoteStanding(state: string, replyNotAsked: boolean) {
  if (state === "SENT" && replyNotAsked) return { word: "sent", tone: "quiet" as const };
  return QUOTE_STATE[state] ?? { word: words(state), tone: "default" as const };
}

const CHANNELS = [
  ["EMAIL", "Email · in the booking's thread"],
  ["WHATSAPP", "WhatsApp"],
] as const;
type Channel = (typeof CHANNELS)[number][0];

const ANSWERS = [
  ["WRITTEN", "They wrote to us"],
  ["VERBAL", "They told us"],
] as const;
type AnswerHow = (typeof ANSWERS)[number][0];

const MARK_FOR = [
  ["SETTING", "The time the settings give"],
  ["CUSTOM", "A time I choose"],
] as const;
type MarkFor = (typeof MARK_FOR)[number][0];

const DEFAULT_MARK_BASIS = "Provisional block while the guest decides — quotation generated";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type RecordedDiscount = { unit: "percent" | "amount"; value: number; basis: string };

function readDiscount(q: QuotationSummary | undefined | null): RecordedDiscount | null {
  const terms = q?.commercialTerms as Record<string, unknown> | null | undefined;
  const d = terms?.requestedDiscount as { discountPercent?: unknown; discountAmount?: unknown; discountBasis?: unknown } | undefined;
  if (!d) return null;
  const basis = typeof d.discountBasis === "string" && d.discountBasis.trim() ? d.discountBasis : "negotiation";
  if (typeof d.discountPercent === "number" && d.discountPercent > 0) return { unit: "percent", value: d.discountPercent, basis };
  if (typeof d.discountAmount === "number" && d.discountAmount > 0) return { unit: "amount", value: d.discountAmount, basis };
  return null;
}

function readDiscountAuthority(q: QuotationSummary | undefined | null): { level: string; at: string | null } | null {
  const terms = q?.commercialTerms as Record<string, unknown> | null | undefined;
  const auth = terms?.discountAuthority as { approvedLevel?: unknown; approvedAt?: unknown } | undefined;
  return auth && typeof auth.approvedLevel === "string"
    ? { level: auth.approvedLevel, at: typeof auth.approvedAt === "string" ? auth.approvedAt : null }
    : null;
}

function discountWords(d: RecordedDiscount, currency?: string): string {
  return d.unit === "percent" ? `${d.value}% off the net value` : `${money(d.value, currency)} off the net value`;
}

/** Every room a marker covers — the anchor and each room of its per-night snapshot. */
function holdRoomIds(h: SpeculativeHoldSummary): string[] {
  const ids = new Set<string>(h.roomId ? [h.roomId] : []);
  for (const n of h.perNightBreakdown ?? []) for (const r of n.roomIds) ids.add(r.roomId);
  return [...ids];
}

/* ------------------------------------------------------------------ the step */

/**
 * Is the table still what the quotation was priced on? Compared field by field over what the
 * grid actually controls, so a stored row carrying extra keys — or a rate stored as a string —
 * does not read as a change. Nothing else is inferred: no quotation at all means unsaved by
 * definition, since there is nothing for the table to match.
 */
function canonComps(list: readonly RoomCompositionInput[] | undefined): string {
  const n = (v: unknown) => (v == null || v === "" ? "" : String(Number(v)));
  return [...(list ?? [])]
    .map((c) =>
      [
        c.roomId,
        n(c.adultCount ?? 0),
        n(c.cnb6To10Count ?? 0),
        n(c.cnbUnder6Count ?? 0),
        n(c.extraBedCount ?? 0),
        n(c.mealPlanCpCount ?? 0),
        n(c.mealPlanMaplCount ?? 0),
        n(c.mealPlanMapdCount ?? 0),
        n(c.mealPlanApCount ?? 0),
        n(c.mealPlanOthersCount ?? 0),
        n(c.othersBreakfastPax),
        n(c.othersLunchPax),
        n(c.othersDinnerPax),
        n(c.negotiatedRoomRate),
        n(c.negotiatedExtraBedRate),
        n(c.negotiatedBreakfastRate),
        n(c.negotiatedLunchRate),
        n(c.negotiatedDinnerRate),
        c.serviceChargeApplies === false ? "0" : "1",
        c.gstApplies === false ? "0" : "1",
        c.isFoc === true ? "1" : "0",
        nightOverridesCanon(c.nightMealOverrides),
      ].join("~"),
    )
    .sort()
    .join("//");
}


export function S2Negotiation({
  entry,
  past,
  parkNow,
  parking,
  declineNow,
  declining,
  onOpenItems,
}: {
  entry: EntryDetail;
  past: boolean;
  /** Park / turn down at once with the reason typed on the page — Other ways' own panels (2026-10-12). */
  parkNow?: (reason: string) => void;
  parking?: boolean;
  declineNow?: (reason: string) => void;
  declining?: boolean;
  /**
   * What this step still needs that the workspace cannot see (2026-10-19, operator: "the 'save and
   * price it again' button has not turned to 'saved' ... but the move to set up button is still
   * clickable, it shouldnt be"). The table's unsaved edits live here, so the step reports them
   * and the gate holds the move to Set up — the quotation on file is what Set up bills.
   */
  onOpenItems?: (items: string[]) => void;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const clock = useHotelClock(30_000);
  const tz = clock.tz;
  const roomNos = useRoomNumbers();
  // A room the system chose and may still move reads "Deluxe Double · room 1" (2026-10-28).
  const bookingRooms = useBookingRooms(entry);
  // The rooms the system chose, counted by type; a room given by number, by its number (2026-10-29).
  const typeNames = useRoomTypeNames();
  const heldWord = (ids: string[]) =>
    roomsHeldWord(ids.map((id) => ({ number: roomNos.get(id) ?? null, typeName: typeNames.get(id) ?? null, quiet: bookingRooms.named.has(id) })));
  const passes = useMemo(() => passesOf(entry), [entry.segments]); // eslint-disable-line react-hooks/exhaustive-deps
  const passId = passes.current?.id ?? null;
  const editable = !past && entry.currentStage === "S2" && entry.status === "ACTIVE";
  const elevated = atLeast(session?.actorLevel, "L2");
  const extraKeys: ReadonlyArray<ReadonlyArray<unknown>> = [["quotation-preview"], ["competing-claims", entry.id]];

  /* ---- the quotations of this pass, and of every pass ---- */
  const quotations = useMemo(() => (entry.quotations ?? []).filter((q) => !passId || q.segmentId === passId), [entry.quotations, passId]);
  const allQuotations = useMemo(
    () =>
      [...(entry.quotations ?? [])].sort((a, b) => {
        const sa = passes.numberById.get(a.segmentId) ?? 0;
        const sb = passes.numberById.get(b.segmentId) ?? 0;
        return sa !== sb ? sb - sa : (b.versionNumber ?? 0) - (a.versionNumber ?? 0);
      }),
    [entry.quotations, passes.numberById],
  );
  const draft = quotations.find((q) => q.state === "DRAFT");
  const sent = quotations.find((q) => q.state === "SENT");
  const accepted = quotations.find((q) => q.state === "ACCEPTED");
  const working = draft ?? sent;
  const shown = accepted ?? working ?? quotations[0] ?? null;
  // The table opens on the terms the live quote was priced on (2026-09-18). Without a seed it
  // restored only this browser's unsaved edits, so on another terminal — or once the browser's
  // storage was cleared — it opened with the party auto-distributed and NO meals, and "Generate
  // the quote again" would have re-priced the stay without the meals the guest was quoted.
  // After a re-entry it starts from the last terms in force. Read once, at the table's mount.
  // A booking split off another (2026-10-14) and never priced starts from what its rooms carried —
  // their guests, meals, extra beds and the rates they kept.
  const seedCompositions = useMemo(
    () =>
      operativeRoomCompositions(entry) ??
      ((entry.carryOver?.compositions?.length ? entry.carryOver.compositions : null) as ReturnType<typeof operativeRoomCompositions>) ??
      undefined,
    [entry.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  /**
   * What the QUOTATION is priced on right now — re-read on every refresh, unlike the seed above,
   * which is deliberately read once so a save does not yank the operator's grid out from under
   * them. This is the baseline the table is compared against to decide whether it has unsaved
   * changes (2026-09-30).
   */
  const pricedCompositions = useMemo(() => operativeRoomCompositions(entry) ?? [], [entry]);

  /* ---- the rooms chosen at Inquiry, and the marker on them ---- */
  const sealedPreferred = (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected);
  const sealedRoomIds = useMemo(() => optionSelectedRoomIds(sealedPreferred?.optionSelected), [sealedPreferred?.optionSelected]);
  const beds = useBedPlan(entry.id, entry.updatedAt);
  const anchorRoomId = preferredHoldRoomId(sealedPreferred?.optionSelected ?? null);
  /**
   * "Change configuration" (2026-09-30; dates since 2026-10-12) — the stay, the rooms and the party, changed here rather than by
   * re-entering to Inquiry. It takes over this card while it is open: the composition table
   * prices a plan, and editing the plan underneath it would be two tables for one booking.
   */
  const [changing, setChanging] = useState(false);
  /**
   * What the composition table says is wrong with itself (2026-09-30). The table is the ONE
   * judge of whether the configuration may be priced — the step reads its verdict rather than
   * re-deriving one, so the grid's red cells and this page's shut doors always agree.
   */
  const [tableFaults, setTableFaults] = useState<string[]>([]);
  /**
   * Which nights each chosen room actually holds, for the table's leading Dates column
   * (2026-09-30, operator). Derived HERE rather than in the grid because this is where the
   * booking is: `roomStayRangesByRoom` reads the newest sealed pick, then dated assignment
   * rows, then falls back to the whole stay for a uniform plan — the same fold the S5-S7 room
   * rows print, so the desk states one room's nights one way everywhere.
   */
  const roomDates = useMemo(() => {
    // `dates` lets the table reconcile per NIGHT — on a booking that moves rooms mid-stay the
    // rooms are not in use together, so their guests are the same people (2026-10-06).
    const nights = roomNightsByRoom(entry);
    const out: Record<string, { label: string; nights: number; dates?: string[] }> = {};
    for (const [roomId, r] of roomStayRangesByRoom(entry)) {
      out[roomId] = { label: r.label, nights: r.nightCount, dates: nights.get(roomId) ?? [] };
    }
    return out;
  }, [entry]);
  const holds = (entry.speculativeHolds ?? []).filter((h) => !passId || h.segmentId === passId);
  const activeHold = holds.find((h) => h.state === "PLACED" || h.state === "UPGRADED") ?? null;
  const lastHold = activeHold ? null : (holds[0] ?? null);

  /** Once this pass's proforma exists, the quotation's terms are final (2026-08-06 ruling). */
  const proformaLocked = useMemo(() => {
    const start = passes.startedAt ? new Date(passes.startedAt).getTime() : null;
    return (entry.folio?.invoices ?? []).some(
      (inv) =>
        inv.invoiceType === "PROFORMA" &&
        inv.state !== "SUPERSEDED" &&
        !inv.supersededById &&
        (start == null || new Date(inv.createdAt).getTime() >= start),
    );
  }, [entry.folio?.invoices, passes.startedAt]);

  /* ---- what the table and the doors hold ---- */
  const [roomCompositions, setRoomCompositions] = useState<RoomCompositionInput[]>([]);
  const [holdWhy, setHoldWhy] = useState("");
  const [markFor, setMarkFor] = useState<MarkFor>("SETTING");
  const [mark, setMark] = useState({ d: "0", h: "0", m: "15" });
  const [discountValue, setDiscountValue] = useState("");
  const [discountUnit, setDiscountUnit] = useState<"percent" | "amount">("percent");
  const [discountBasis, setDiscountBasis] = useState("negotiation");
  const recordedDiscount = useMemo(() => readDiscount(working ?? accepted), [working, accepted]);
  // `undefined` until the first run: with no quotation yet the id is null, and starting at null
  // skipped the first run, so a discount carried from another booking never reached the table.
  const seededFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = (working ?? accepted)?.id ?? null;
    if (seededFor.current === id) return;
    seededFor.current = id;
    if (recordedDiscount) {
      setDiscountValue(String(recordedDiscount.value));
      setDiscountUnit(recordedDiscount.unit);
      setDiscountBasis(recordedDiscount.basis);
    } else if (!id && entry.carryOver?.discount?.discountPercent) {
      // Not priced yet, split off a booking that had a percentage off: it carries.
      setDiscountValue(String(entry.carryOver.discount.discountPercent));
      setDiscountUnit("percent");
      setDiscountBasis(entry.carryOver.discount.discountBasis || "negotiation");
    } else if (!id && entry.followsEntryId && entry.carryOver?.discount?.discountAmount) {
      // A stay set up the same as another copies a flat amount off too (2026-11-03). A booking split
      // off another does not: that amount stays with the original.
      setDiscountValue(String(entry.carryOver.discount.discountAmount));
      setDiscountUnit("amount");
      setDiscountBasis(entry.carryOver.discount.discountBasis || "negotiation");
    }
  }, [working, accepted, recordedDiscount]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A blank or zero figure is "no discount"; clearing a recorded one must be said as `null`. */
  /**
   * The discount rides on the same save, so a changed one counts as an unsaved change — the
   * quotation would otherwise still carry the old concession while the bar shows the new one.
   */
  const discountMoved =
    (discountValue.trim() === "" ? null : Number(discountValue)) !== (recordedDiscount?.value ?? null) ||
    (recordedDiscount != null && discountUnit !== recordedDiscount.unit);
  const tableUnsaved =
    !working || canonComps(roomCompositions) !== canonComps(pricedCompositions) || discountMoved;

  // The table edited by hand opens the booking file on the price (2026-10-27, as the rooms picked
  // at Inquiry do): Charges & payments › The price, room by room, beside the grid. The seed and a
  // background re-read do not, and the page never moves — only the file's tab changes.
  const openFile = useOpenFileTab();
  const handEditAt = useRef(0);
  const markHandEdit = () => {
    handEditAt.current = Date.now();
  };
  const tableKey = `${canonComps(roomCompositions)}|${discountValue}|${discountUnit}`;
  const lastTableKey = useRef(tableKey);
  useEffect(() => {
    if (tableKey === lastTableKey.current) return;
    lastTableKey.current = tableKey;
    if (!editable || past || Date.now() - handEditAt.current > 2000) return;
    // Only where the file sits beside the step — in the old layout the tab would replace the step.
    if (typeof document !== "undefined" && !document.querySelector(".ws-top")) return;
    openFile("money", "price");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey]);

  // What the table holds, saved or not, for the Charges & payments tab and the header total.
  usePublishPriceDraft(
    entry.id,
    editable
      ? {
          kind: "TABLE",
          roomCompositions,
          discount: (() => {
            const n = Number(discountValue);
            return discountValue.trim() && Number.isFinite(n) && n > 0 ? (discountUnit === "amount" ? { amount: n } : { percent: n }) : null;
          })(),
          saved: !tableUnsaved,
        }
      : null,
  );

  const discountPayload = (() => {
    const n = Number(discountValue);
    if (!discountValue.trim() || !Number.isFinite(n) || n <= 0) return null;
    const basis = discountBasis.trim() || "negotiation";
    return discountUnit === "amount" ? { discountAmount: n, discountBasis: basis } : { discountPercent: n, discountBasis: basis };
  })();

  /* ---- validity: up to check-in, in days; in hours when check-in is today. The rule is the server's. ---- */
  const validityQuery = useQuery({
    queryKey: ["quote-validity", entry.id, entry.checkInDate],
    queryFn: () => getQuoteValidityWindow(session!, entry.id),
    enabled: !!session,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const validWindow = validityQuery.data ?? null;
  const inHours = validWindow?.mode === "HOURS";
  const validUnitMs = inHours ? HOUR_MS : DAY_MS;
  const validUnit = inHours ? "hour" : "day";
  const maxValid = validWindow?.max ?? 0;
  const [validCount, setValidCount] = useState("");
  /**
   * The validity is written by the Save, so changing it after the quote was priced is an unsaved
   * change too (2026-10-12) — without this the Save stayed on "Saved" and the new validity could
   * never be applied. Cleared when a save lands.
   */
  const [validTouched, setValidTouched] = useState(false);
  const changeValid = (v: string) => {
    setValidCount(v);
    setValidTouched(true);
  };
  // It starts as long as it may stand (2026-11-05, operator: "the validity of the quote will be till the
  // check in date"), or at what is left of the quotation on file: a shorter time set stays shorter.
  const offerUntil = liveQuotesThisPass(entry)[0]?.validUntil ?? null;
  useEffect(() => {
    if (!validWindow || validTouched) return;
    const left = offerUntil ? Math.ceil((new Date(offerUntil).getTime() - clock.now) / validUnitMs) : 0;
    setValidCount(String(left >= 1 ? Math.min(left, validWindow.max) : validWindow.max));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validWindow?.mode, validWindow?.max, offerUntil, validTouched]);
  const validNumber = (() => {
    const n = Number(validCount);
    return validWindow && validCount !== "" && Number.isInteger(n) && n >= 1 ? Math.min(n, maxValid) : null;
  })();
  const validityEnd = validNumber == null ? null : clock.now + validNumber * validUnitMs;
  const validityBody = () => (validNumber == null ? {} : inHours ? { validHours: validNumber } : { validDays: validNumber });

  const markSeconds =
    Math.max(0, Math.floor(Number(mark.d) || 0)) * 86_400 +
    Math.max(0, Math.floor(Number(mark.h) || 0)) * 3_600 +
    Math.max(0, Math.floor(Number(mark.m) || 0)) * 60;

  const createBody = () => ({
    ...validityBody(),
    requestedDiscount: discountPayload ?? undefined,
    roomCompositions: roomCompositions.length > 0 ? roomCompositions : undefined,
  });

  /* ---- the acts ---- */
  // Save & price it is also the table's Done (2026-10-27, operator: "when I click Save, or Save &
  // price it again, it should take me to the quotation section"): once the booking is read again
  // with its new quotation, the table folds to its line and the page goes to the quotation. It
  // waits for the table to read as done (its own "changes saved" item clears a render later) and
  // then for the fold itself, so the page moves to where the quotation sits once the table above it
  // is one line — moving first left the card off the top of the screen (found driving it).
  const qc = useQueryClient();
  const flow = useStepFlow();
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const tableFlow = useFlowCard("table");
  const tableMetRef = useRef(false);
  tableMetRef.current = !!tableFlow.met;
  const waitFor = async (test: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!test() && Date.now() < end) await new Promise((r) => window.setTimeout(r, 40));
    return test();
  };
  const goToQuotation = async () => {
    await qc.invalidateQueries({ queryKey: ["entry", entry.id] });
    await waitFor(() => tableMetRef.current, 3000);
    if (!flowRef.current.on) return;
    flowRef.current.done("table", { next: "quotation", reveal: false });
    await waitFor(() => !!document.querySelector('[data-flow="table"].flow-folded'), 1500);
    const el = document.getElementById(anchorFor("quotation"));
    if (el) revealCard(el);
  };
  const [sendTarget, setSendTarget] = useState<QuotationSummary | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const createdRef = useRef(false);

  const generateM = useMutation({
    mutationFn: () => createQuotation(session!, entry.id, createBody()),
    onSuccess: async (q) => {
      toast.success(`Quotation ${quoteNo(q)} generated — nothing sent, no rooms marked`);
      setValidTouched(false);
      refresh(extraKeys);
      await goToQuotation();
    },
    onError: (e) => toastRefusal(e, "The quotation could not be generated"),
  });
  const regenerateM = useMutation({
    mutationFn: () => {
      if (!working) throw new Error("There is no quotation to generate again");
      return supersedeQuotation(session!, working.id, {
        ...validityBody(),
        requestedDiscount: discountPayload ?? (recordedDiscount ? null : undefined),
        roomCompositions: roomCompositions.length > 0 ? roomCompositions : undefined,
      });
    },
    onSuccess: async (q) => {
      toast.success(`Version ${q.versionNumber} generated — the earlier one is kept`);
      setValidTouched(false);
      refresh(extraKeys);
      await goToQuotation();
    },
    onError: (e) => toastRefusal(e, "The quotation could not be generated again"),
  });
  const blockM = useMutation({
    mutationFn: async () => {
      createdRef.current = false;
      if (!anchorRoomId) throw new Error("Choose the rooms at Inquiry first");
      if (!working && !accepted) {
        await createQuotation(session!, entry.id, createBody());
        createdRef.current = true;
      }
      return placeSpeculativeHold(session!, entry.id, {
        roomId: anchorRoomId,
        ttlSeconds: markFor === "CUSTOM" ? markSeconds : undefined,
        commercialBasis: holdWhy.trim() || DEFAULT_MARK_BASIS,
      });
    },
    onSuccess: (h) => {
      toast.success(
        `${createdRef.current ? "Quotation generated · " : ""}${plural(holdRoomIds(h).length, "room")} marked until ${fmtDateTime(h.expiresAt, tz)} · nothing sent`,
      );
      refresh(extraKeys);
    },
    onError: (e) => {
      toastRefusal(e, createdRef.current ? "The quotation was generated, but the rooms could not be marked" : "The rooms could not be marked");
      if (createdRef.current) refresh(extraKeys);
    },
  });
  const releaseM = useMutation({
    mutationFn: (reason: string) => {
      if (!activeHold) throw new Error("No rooms are marked");
      return releaseSpeculativeHold(session!, entry.id, activeHold.id, { releaseReason: reason });
    },
    onSuccess: () => {
      toast.success("The rooms are no longer marked — the quotation stands");
      setReleaseOpen(false);
      refresh(extraKeys);
    },
    onError: (e) => toastRefusal(e, "The rooms could not be released"),
  });


  /* ---- reasons a door stays shut ---- */
  const tableOpen = editable && !accepted && !proformaLocked && !!sealedPreferred;
  // Only once something is priced: before that, "Quote generated" already holds the move.
  const unsavedItem = tableOpen && !changing && !!working && (tableUnsaved || validTouched) ? "Table changes saved and priced" : null;
  useEffect(() => {
    onOpenItems?.(unsavedItem ? [unsavedItem] : []);
  }, [unsavedItem, onOpenItems]);
  useEffect(() => () => onOpenItems?.([]), [onOpenItems]);
  const noRooms = !sealedPreferred || !anchorRoomId ? "choose the rooms at Inquiry first" : null;
  /** A table with a fault in it cannot be sent, marked or priced — it is the same basis. */
  const tableReason =
    tableFaults.length > 0
      ? `put the table right first — ${tableFaults[0]}${tableFaults.length > 1 ? ` (and ${tableFaults.length - 1} more)` : ""}`
      : null;
  const blockReason =
    noRooms ??
    tableReason ??
    (markFor === "CUSTOM" && markSeconds <= 0
      ? "set at least a minute"
      : validNumber == null && !working && !accepted
        ? `how long the quote stands: 1 to ${plural(maxValid, validUnit)}`
        : null);

  const markedCount = activeHold ? holdRoomIds(activeHold).length : sealedRoomIds.length;
  const markLength =
    markFor === "SETTING"
      ? "for the time the settings give"
      : `for ${
          [
            Number(mark.d) > 0 ? plural(Math.floor(Number(mark.d)), "day") : null,
            Number(mark.h) > 0 ? plural(Math.floor(Number(mark.h)), "hour") : null,
            Number(mark.m) > 0 ? plural(Math.floor(Number(mark.m)), "minute") : null,
          ]
            .filter(Boolean)
            .join(" ") || "no time at all"
        }`;

  /* ---- the line the table folds to once it is priced ---- */
  const billingNow = useQuery({
    queryKey: ["billing-summary", entry.id, entry.updatedAt ?? ""],
    queryFn: () => getBillingSummary(session!, entry.id),
    enabled: !!session,
  });
  const pricedQuote = accepted ?? working ?? null;
  const pricedStay = billingNow.data?.stayTotal;
  const partyWords = [
    entry.adultCount != null ? plural(entry.adultCount, "adult") : entry.guestCount != null ? plural(entry.guestCount, "guest") : null,
    entry.childCount ? plural(entry.childCount, "child", "children") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const tableSummary = pricedQuote
    ? [
        sealedRoomIds.length ? heldWord(sealedRoomIds) : null,
        partyWords || null,
        `priced as ${pricedQuote.referenceNumber} · v${pricedQuote.versionNumber}`,
        pricedStay && pricedStay.quotationId === pricedQuote.id ? money(pricedStay.amount, pricedQuote.currency) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  const competing = useCompetingClaims(entry.id);
  const otherMarkers = (competing.data?.items ?? []).filter((i) => i.kind === "SPECULATIVE_HOLD");

  /**
   * The provisional block, as Other ways' first panel (2026-10-12, operator: "this section can be
   * moved to Other ways"). Optional: it marks the rooms while the guest decides and sends nothing;
   * with no quotation yet it prices one first, on the validity set under the table. Its reason and
   * time are read by this act only.
   */
  const blockPanel = (
    <div className="way-form">
      <div className="field">
        <label>Reason · optional</label>
        <input
          className="input"
          value={holdWhy}
          readOnly={!editable}
          placeholder="agent needs two days to confirm with the client"
          onChange={(e) => setHoldWhy(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Mark the rooms for</label>
        <Choice options={MARK_FOR} value={markFor} onChange={setMarkFor} disabled={!editable} />
        {markFor === "CUSTOM" ? (
          <div className="row-acts" style={{ marginTop: 6 }}>
            {(["d", "h", "m"] as const).map((k) => (
              <span key={k} className="count-in sm">
                <input
                  className="input"
                  inputMode="numeric"
                  value={mark[k]}
                  readOnly={!editable}
                  aria-label={k === "d" ? "Days" : k === "h" ? "Hours" : "Minutes"}
                  onChange={(e) => setMark((p) => ({ ...p, [k]: e.target.value.replace(/\D/g, "") }))}
                />
                {k === "d" ? "days" : k === "h" ? "hours" : "minutes"}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {activeHold ? (
        <BindingBox family="provisional" stateWord={new Date(activeHold.expiresAt).getTime() < clock.now ? "expired" : "marked"} style={{ marginTop: 4 }}>
          <div className="sm" style={{ paddingRight: 80 }}>
            {heldWord(holdRoomIds(activeHold))} marked until <b>{fmtDateTime(activeHold.expiresAt, tz)}</b> · others can still be sold
            if someone commits first
          </div>
        </BindingBox>
      ) : lastHold ? (
        <div className="sm">
          The last marker {lastHold.state === "EXPIRED" || lastHold.releaseReason === "EXPIRY" ? "ran out" : "was released"}
          {lastHold.releasedAt ? ` on ${fmtStamp(lastHold.releasedAt, tz)}` : ` — it was set to end ${fmtDateTime(lastHold.expiresAt, tz)}`}.
        </div>
      ) : null}
      {otherMarkers.length ? <div className="sm">Also marked by {otherMarkers.map((o) => o.reference ?? o.entryId).join(" · ")}</div> : null}
      <Live>
        <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
          {activeHold ? (
            <SeeRow
              label="Release"
              note="Frees the rooms, with a reason. The quotation stands."
              onClick={editable && elevated ? () => setReleaseOpen(true) : undefined}
              reason={!editable ? "not at this step" : elevated ? undefined : "releasing a marker early is the FOM's call"}
            />
          ) : (
            <SeeRow
              kind="primary"
              label="Mark the rooms"
              note={`${working || accepted ? "Marks" : "Prices the quotation from the table and marks"} ${plural(markedCount || 1, "room")} ${markLength}. Nothing is sent to the guest. The reason and the time above are used by this block only.`}
              onClick={editable ? () => blockM.mutate() : undefined}
              state={blockM.isPending ? "working" : editable && !blockReason ? "default" : "inert"}
              reason={!editable ? "not at this step" : (blockReason ?? undefined)}
            />
          )}
          <SeeRow
            label="Extend"
            note="Gives the marked rooms more time — once by the desk, then by the FOM. It never re-prices the quotation."
            state="inert"
            reason="Not possible yet — the marked rooms are held until the time shown above."
            notYet
          />
        </div>
      </Live>
    </div>
  );

  /** Change booking — the two ways the booking itself is changed, from the end of the step's line. */
  const openAlsoWay = useOpenAlsoWay();
  const openChange = () => {
    setChanging(true);
    flow.open("table");
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const el = document.getElementById(anchorFor("table"));
        if (el) revealCard(el);
      }),
    );
  };
  const changeItems: ChangeBookingItem[] = past
    ? []
    : [
        {
          key: "configuration",
          label: "Change configuration",
          note: "The dates, the rooms, the adults, the children and their ages. A quotation priced on the old configuration is retired.",
          onSelect: editable ? openChange : undefined,
          reason: editable ? undefined : entry.status === "PARKED" ? "Resume the booking first" : "Not possible on this booking now",
        },
        ...(declineNow
          ? [
              {
                key: "cancel",
                label: "Cancel booking",
                note: "The guest said no. The booking ends, the marked rooms go back on sale and nothing is charged.",
                onSelect: () => openAlsoWay("decline"),
                danger: true,
              },
            ]
          : []),
      ];

  return (
    <StepCanvas past={past}>
      <StageActs>
        <ChangeBookingMenu items={changeItems} />
      </StageActs>

      <StepCard
        flow="table"
        // Always a line, so the card's inside keeps one shape: a summary appearing only once the
        // quotation existed re-mounted the table on the save and lost what it held. It can only
        // fold once the table is priced (its item is the quotation), so the placeholder never shows.
        summary={tableSummary ?? "Not priced yet"}
        noDoneBar
        title="Who sleeps where, and their meals"
        meta="One row per room: the guests by age, their meal plans, extra beds, any negotiated rate and the booking's discount. Saving the table prices it — that is the quotation."
      >
        {changing ? (
          <ChangeConfiguration
            entry={entry}
            onClose={() => setChanging(false)}
            onDone={() => {
              setChanging(false);
              refresh();
            }}
          />
        ) : tableOpen ? (
          <Tool>
            <div onPointerDownCapture={markHandEdit} onKeyDownCapture={markHandEdit} onInputCapture={markHandEdit}>
            {/* The grid alone (2026-10-27, operator: "remove the guest board option, that way you
                don't have to keep the table option as well") — as at Arrival, Check-in and Stay. */}
            <RoomCompositionPlanner
              tableOnly
              bedPlan={beds.byRoom}
              onBedChange={beds.set}
              bedAsk={beds.ask}
              sealedRoomIds={sealedRoomIds}
              entryCheckIn={entry.checkInDate ?? null}
              entryCheckOut={entry.checkOutDate ?? null}
              entryAdults={entry.adultCount ?? entry.guestCount ?? null}
              entryChildAges={entry.childAges ?? null}
              roomDates={roomDates}
              roomLabels={bookingRooms.labels}
              onSave={() => (working ? regenerateM.mutate() : generateM.mutate())}
              saveLabel={working ? "Save & quote it again" : "Save & quote it"}
              saving={generateM.isPending || regenerateM.isPending}
              unsaved={tableUnsaved || validTouched}
              saveAside={
                // A field that reads as one (2026-10-12, operator: "valid for 2 days doesn't seem
                // like something that can be edited at first glance"): a bordered box with − and +,
                // the end date it gives beside it, and the rule behind a "?".
                <div className="rct-valid">
                  <span className="lbl">Quote valid for</span>
                  <span className={`stepper${validNumber == null ? " bad" : ""}`}>
                    <button
                      type="button"
                      aria-label={`One ${validUnit} less`}
                      disabled={!editable || validNumber == null || validNumber <= 1}
                      onClick={() => changeValid(String(Math.max(1, (validNumber ?? 2) - 1)))}
                    >
                      −
                    </button>
                    <input
                      inputMode="numeric"
                      aria-label={`Quote valid for, in ${validUnit}s`}
                      value={validCount}
                      readOnly={!editable || !validWindow}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, "");
                        changeValid(v !== "" && Number(v) > maxValid ? String(maxValid) : v);
                      }}
                    />
                    <span className="unit">{validNumber === 1 ? validUnit : `${validUnit}s`}</span>
                    <button
                      type="button"
                      aria-label={`One ${validUnit} more`}
                      disabled={!editable || (validNumber ?? maxValid) >= maxValid}
                      onClick={() => changeValid(String(Math.min(maxValid, (validNumber ?? 0) + 1)))}
                    >
                      +
                    </button>
                  </span>
                  <span className={`until${validWindow && validNumber == null ? " stop-ink" : ""}`}>
                    {!validWindow ? null : validNumber == null ? (
                      `Enter 1 to ${maxValid}`
                    ) : (
                      <>
                        until <b>{fmtDateTime(validityEnd, tz)}</b>
                      </>
                    )}
                  </span>
                  <Help label="About how long the quote is valid">
                    <p>How long the guest has to accept this price. The time starts when the table is saved. Sending the quote later does not restart it.</p>
                    <p>
                      {inHours
                        ? `Check-in is today, so it is set in hours, up to ${plural(maxValid, "hour")}: the rest of today.`
                        : `It runs up to check-in, ${plural(maxValid, "day")} from today. It can be made shorter, not longer.`}
                    </p>
                  </Help>
                </div>
              }
              onFaultsChange={setTableFaults}
              persistKey={entry.id}
              persistBasis={(working ?? accepted)?.id ?? "none"}
              entryId={entry.id}
              initialCompositions={seedCompositions}
              onChange={setRoomCompositions}
              discountValue={discountValue}
              discountUnit={discountUnit}
              onDiscountChange={(patch) => {
                if (patch.value !== undefined) setDiscountValue(patch.value);
                if (patch.unit !== undefined) setDiscountUnit(patch.unit);
              }}
            />
            </div>
          </Tool>
        ) : (
          <>
            {!sealedPreferred ? (
              <Notice>Choose the rooms at Inquiry first — the table needs them.</Notice>
            ) : accepted && !past ? (
              <Notice>
                The guest accepted these terms, so the table is closed. To change the price, use <b>Renegotiate the price</b> at Set up.
              </Notice>
            ) : proformaLocked && !past ? (
              <Notice>
                A proforma has been issued on these terms, so they are final. To change the price, use <b>Renegotiate the price</b> at Set up.
              </Notice>
            ) : null}
            <CompositionSummary entry={entry} />
          </>
        )}
        <ChildrenAges entry={entry} />
        {/* The rooms and the party are changed HERE, not by re-entering to Inquiry (2026-09-30,
            operator ruling). It sits under the table it changes, and closes while the change is
            being made so there is only ever one plan on screen. */}
        {!changing ? <WaitingConfigurationChange entry={entry} /> : null}
        {/* Change configuration moved into "Change booking" at the end of the step's line, beside
            Cancel booking (2026-10-27, operator). The provisional block is placed from the bar at the
            foot. A marker in place is a state, so it is still said here. */}
        {!changing && !past && activeHold ? (
          <div className="row-acts" style={{ marginTop: 12, alignItems: "center", gap: 10 }}>
            <span className="sm">
              <Icon name="clock" /> {heldWord(holdRoomIds(activeHold))} marked until <b>{fmtDateTime(activeHold.expiresAt, tz)}</b>
            </span>
          </div>
        ) : null}
        {!changing ? <DecidedConfigurationChanges entry={entry} /> : null}
      </StepCard>

      {/* The live quotation sits directly under the table that priced it (2026-09-30, operator).
          It used to be below the quote and the marker, pages away from the grid whose Save mints
          it — so the round trip "price it · read what that produced" ran down the whole step and
          back. Its VERSION LIST stays at the foot of the step: it is a record to look up, not
          part of the work, and the two swapped places rather than travelling together. */}
      {shown ? (
        <QuotationCard
          entry={entry}
          q={shown}
          editable={editable}
          elevated={elevated}
          tz={tz}
          nowMs={clock.now}
          onSend={() => setSendTarget(shown)}
          refreshKeys={extraKeys}
        />
      ) : !past ? (
        // Section 2 before anything is priced: it waits for the table's Save (2026-10-27).
        <StepCard flow="quotation" flowAfter="table" title="The quotation" icon="file">
          <span className="sm">Nothing is priced yet — the table&rsquo;s Save makes the quotation.</span>
        </StepCard>
      ) : null}


      {/* "The quote" card was removed (2026-10-12, operator: "keep the internal note in the pop up
          so that there is only one send button"). The quotation's own Send… is the send; the
          internal note is typed in the send dialog and kept as a note filed with the quotation. */}
      {allQuotations.length > 1 ? <QuoteHistoryCard entry={entry} quotations={allQuotations} tz={tz} /> : null}

      <CompetingClaimsCard entryId={entry.id} />
      {/* Other ways as sub-tabs (2026-10-12, operator), each panel what its button used to open. */}
      <OtherWaysTabs
        tabs={[
          { key: "block", label: "Provisional block", content: blockPanel },
          parkTab(parkNow, parking),
          // The answer the house had no way to write down (2026-10-01) — see the Inquiry step.
          // The guest said no is Cancel booking here, opened from Change booking (2026-10-27, operator).
          declineTab(declineNow, declining, { label: "Cancel booking", act: "Cancel the booking", inBar: false }),
          // The Counter-offer way was taken off (2026-10-27, operator: "remove the counter offer") —
          // it could record nothing; the discount on the table is how a counter-offer is met.
        ]}
      />

      <QuotationSendDialog
        entry={entry}
        target={sendTarget}
        onClose={() => setSendTarget(null)}
        onSent={() => {
          setSendTarget(null);
          refresh(extraKeys);
        }}
      />
      <ReasonDialog
        open={releaseOpen}
        danger
        onClose={() => setReleaseOpen(false)}
        busy={releaseM.isPending}
        title="Release the rooms"
        caseLines={activeHold ? [`${heldWord(holdRoomIds(activeHold))} marked until ${fmtDateTime(activeHold.expiresAt, tz)}`] : undefined}
        lead="The marker is removed. The quotation stands and can still be accepted if the rooms are free then."
        confirmLabel="Release"
        placeholder="agent went elsewhere"
        onConfirm={(r) => releaseM.mutate(r)}
      />
    </StepCanvas>
  );
}

/* ------------------------------------------------------------------ who sleeps where (decided) */

type MealCounts = { cp: number; mapl: number; mapd: number; ap: number; others: number };
const PLAN_SHORT: Array<[keyof MealCounts, string]> = [
  ["cp", "CP"],
  ["mapl", "MAP + lunch"],
  ["mapd", "MAP + dinner"],
  ["ap", "AP"],
  ["others", "à la carte"],
];

/** The table as the backend priced it — for a passed step, an accepted quote, or a final one. */
function CompositionSummary({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const { labels } = useBookingRooms(entry);
  const billing = useQuery({
    queryKey: ["billing-summary", entry.id, entry.updatedAt ?? ""],
    queryFn: () => getBillingSummary(session!, entry.id),
    enabled: !!session,
  });
  const b = billing.data;
  if (!b) return <span className="meta">{billing.isLoading ? "Reading the priced rooms…" : "No priced rooms to show."}</span>;
  if (!b.rooms?.length) {
    return (
      <span className="meta">
        {b.stayTotal.quotationId
          ? "This quotation was priced as a flat rate — there is no room-by-room table."
          : "No quotation yet — the rooms are priced when it is generated."}
      </span>
    );
  }
  const cur = b.currency ?? undefined;
  return (
    <>
      <table className="table compact">
        <thead>
          <tr>
            <th>Room</th>
            <th>Guests</th>
            <th>Extra beds</th>
            <th>Meals</th>
            <th style={{ textAlign: "right" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {b.rooms.map((r, i) => {
            const o = r.occupants;
            const plans = r.mealCounts ? PLAN_SHORT.filter(([k]) => (r.mealCounts?.[k] ?? 0) > 0).map(([k, w]) => `${r.mealCounts![k]} × ${w}`) : [];
            return (
              <tr key={r.roomId ?? i} className="static">
                <td>
                  {r.roomId && labels.has(r.roomId) ? labels.get(r.roomId) : r.roomNumber ? `Room ${r.roomNumber}` : "—"}
                  {r.roomTypeName && !(r.roomId && labels.has(r.roomId)) ? <span className="sub">{r.roomTypeName}</span> : null}
                </td>
                <td>
                  {o ? (
                    <>
                      {plural(o.adults, "adult")}
                      {o.children6To10 ? ` · ${o.children6To10} aged 6–10` : ""}
                      {o.childrenUnder6 ? ` · ${o.childrenUnder6} under 6` : ""}
                    </>
                  ) : (
                    <span className="dash">—</span>
                  )}
                </td>
                <td>{r.extraBedCount || <span className="dash">—</span>}</td>
                <td>
                  {plans.length ? plans.join(" · ") : "room only"}
                  {r.mealsVaryByNight ? <span className="sub">varies by night</span> : null}
                </td>
                <td className="money" style={{ textAlign: "right" }}>
                  {r.isFoc ? <Chip tone="accent">free of charge</Chip> : money(r.total, cur)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row-acts" style={{ marginTop: 8, justifyContent: "space-between" }}>
        <span className="meta">
          {b.rooms.some((r) => r.componentsPreDiscount) ? "room figures include the booking's discount · " : ""}service charge and GST included
        </span>
        <b className="money">
          {money(b.stayTotal.amount, cur)} <span className="meta">{b.stayTotal.frozen ? "as confirmed" : "quoted"}</span>
        </b>
      </div>
    </>
  );
}

function ChildrenAges({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const policy = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 600_000,
  });
  const ages = entry.childAges ?? [];
  const young = policy.data?.ageBands.youngChildMaxAge ?? 5;
  const child = policy.data?.ageBands.childMaxAge ?? 10;
  // With no children there is nothing to say (2026-10-12) — the table's guest columns show it.
  if (!ages.length) return null;
  return (
    <div className="row-acts" style={{ marginTop: 12, alignItems: "center" }}>
      <span className="sm">Children&rsquo;s ages</span>
      <b className="sm">{ages.join(", ")}</b>
      <Help label="About children's ages">
        <p>
          Under {young + 1} are free, {young + 1} to {child} are charged at the child rate, and {child + 1} and over count as adults.
        </p>
        <p>The ages are set at Inquiry.</p>
      </Help>
    </div>
  );
}

/* ------------------------------------------------------------------ the quotation as a paper */

function QuotationCard({
  entry,
  q,
  editable,
  elevated,
  tz,
  nowMs,
  onSend,
  refreshKeys,
}: {
  entry: EntryDetail;
  q: QuotationSummary;
  editable: boolean;
  elevated: boolean;
  tz: string;
  nowMs: number;
  onSend: () => void;
  refreshKeys: ReadonlyArray<ReadonlyArray<unknown>>;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [answerOpen, setAnswerOpen] = useState(false);
  const replyNotAsked = latestDispatched(useCommunications(entry.id).data?.items, "QUOTATION")?.acknowledgementStatus === "NOT_ASKED";
  const replyAsked = useReplyAsked(entry.id, "QUOTATION");
  const [how, setHow] = useState<AnswerHow | null>(null);
  const [said, setSaid] = useState("");
  const [closeLoopOpen, setCloseLoopOpen] = useState(false);

  const billing = useQuery({
    queryKey: ["billing-summary", entry.id, entry.updatedAt ?? ""],
    queryFn: () => getBillingSummary(session!, entry.id),
    enabled: !!session,
  });
  const st = billing.data?.stayTotal;
  const figure = st && st.quotationId === q.id ? st.amount : q.totalAmount;
  const perNight = st && st.quotationId === q.id && st.basis === "PER_NIGHT_TIMES_NIGHTS" ? st.perNightAmount : null;
  const state = quoteStanding(q.state, replyNotAsked);
  const discount = readDiscount(q);
  const authority = readDiscountAuthority(q);
  const validMs = q.validUntil ? new Date(q.validUntil).getTime() : Number.NaN;
  const lapsed = Number.isFinite(validMs) && validMs < nowMs;

  const acceptM = useMutation({
    mutationFn: () =>
      acceptQuotation(session!, q.id, {
        acceptanceMethod: how ?? undefined,
        verbatimNote: how === "VERBAL" ? said.trim() : undefined,
      }),
    onSuccess: () => {
      toast.success(`${quoteNo(q)} accepted — the answer is on record`);
      setAnswerOpen(false);
      setHow(null);
      setSaid("");
      refresh(refreshKeys);
    },
    onError: (e) => toastRefusal(e, "The answer could not be recorded"),
  });
  const closeLoopM = useMutation({
    mutationFn: (reason: string) => resolveQuotationAckOpenLoop(session!, q.id, { resolutionType: "CUSTODIAN_DECISION", decisionReason: reason }),
    onSuccess: () => {
      toast.success("The reply window is closed on the FOM's decision");
      setCloseLoopOpen(false);
      refresh(refreshKeys);
    },
    onError: (e) => toastRefusal(e, "The reply window could not be closed"),
  });
  const approveM = useMutation({
    mutationFn: () => approveQuotationDiscount(session!, q.id),
    onSuccess: () => {
      toast.success("The discount is approved");
      refresh(refreshKeys);
    },
    onError: (e) => toastRefusal(e, "The discount could not be approved"),
  });

  const answerReady = how === "WRITTEN" || (how === "VERBAL" && said.trim().length > 0);

  return (
    <StepCard
      flow="quotation"
      title={`Quotation · ${q.referenceNumber} · v${q.versionNumber}`}
      icon="file"
      right={
        <Chip tone={state.tone} icon={q.state === "ACCEPTED" ? "check" : undefined}>
          {state.word}
        </Chip>
      }
      acts={
        <>
          <Button
            kind="secondary"
            compact
            icon="eye"
            onClick={() =>
              setPaper({
                kind: "quotation",
                id: q.id,
                label: `Quotation ${quoteNo(q)}`,
                frozen: (q.state === "SUPERSEDED" || q.state === "EXPIRED") && !!q.pdfStorageKey,
              })
            }
          >
            Preview
          </Button>
          <Live>
            <Button
              kind={editable && q.state === "DRAFT" ? "primary" : "quiet"}
              compact
              icon="send"
              state={editable && q.state === "DRAFT" ? "default" : "inert"}
              title={
                q.state === "DRAFT"
                  ? editable
                    ? undefined
                    : "not at this step"
                  : q.state === "SENT"
                    ? "already sent"
                    : "only a generated, unsent quotation can be sent"
              }
              onClick={onSend}
            >
              Send
            </Button>
          </Live>
        </>
      }
    >
      <div className="sm">
        Generated {fmtStamp(q.createdAt, tz)} · <span className="money">{money(figure, q.currency)}</span> quoted
        {perNight != null ? ` · ${money(perNight, q.currency)} a night across the stay` : ""}
      </div>
      <div className="sm" style={{ marginTop: 8, display: "grid", gap: 3 }}>
        {q.validUntil ? (
          <span className={lapsed && q.state !== "ACCEPTED" ? "warn-ink" : undefined}>
            <Icon name="clock" /> {lapsed && q.state !== "ACCEPTED" ? "The price lapsed on" : "Price valid until"}{" "}
            <b>{fmtDateTime(q.validUntil, tz)}</b>
            {lapsed && q.state !== "ACCEPTED" && editable ? " — set how long it is valid under the table and save it again" : ""}
          </span>
        ) : null}
        {q.sentAt ? (
          <span>
            <Icon name="send" /> Sent {fmtStamp(q.sentAt, tz)}
            {q.sentTo ? <span className="meta"> · to {q.sentTo}</span> : null}
          </span>
        ) : null}
        {discount ? (
          <span>
            {discountWords(discount, q.currency)} <span className="meta">· {discount.basis}</span>{" "}
            {authority ? (
              <Chip tone="success" icon="check">
                approved when generated · {LEVEL_WORD[authority.level] ?? authority.level}
              </Chip>
            ) : q.state === "DRAFT" ? (
              <Live>
                {elevated ? (
                  <Button
                    kind="secondary"
                    compact
                    state={approveM.isPending ? "working" : editable ? "default" : "inert"}
                    onClick={() => approveM.mutate()}
                  >
                    Approve the discount · FOM
                  </Button>
                ) : (
                  <span className="warn-ink sm">Needs the FOM&rsquo;s approval before it can be sent</span>
                )}
              </Live>
            ) : null}
          </span>
        ) : null}
      </div>

      {q.state === "ACCEPTED" || (replyAsked && !replyNotAsked) ? (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)", display: "grid", gap: 6 }}>
          <b className="sm">The guest&rsquo;s answer</b>
          {q.state === "ACCEPTED" ? (
            <span className="sm">
              <Icon name="check" /> Accepted{q.acceptedAt ? ` · ${fmtStamp(q.acceptedAt, tz)}` : ""}
            </span>
          ) : q.state === "SENT" ? (
            <>
              <span className="sm">
                <Icon name="clock" /> Awaiting their answer{q.validUntil ? ` — the price holds until ${fmtDateTime(q.validUntil, tz)}` : ""}
              </span>
              <Live>
                {!answerOpen ? (
                  <div style={{ display: "grid", gap: 4 }}>
                    <SeeRow
                      kind="secondary"
                      label="Record the answer"
                      note="Records how the guest accepted and the words they used. A spoken answer counts once it is written down."
                      onClick={editable ? () => setAnswerOpen(true) : undefined}
                      reason={editable ? undefined : "not at this step"}
                    />
                    <SeeRow
                      label="No answer — the FOM decides"
                      note="Closes the reply window as the FOM's decision, with a reason."
                      onClick={editable && elevated ? () => setCloseLoopOpen(true) : undefined}
                      reason={!editable ? "not at this step" : elevated ? undefined : "closing the reply window is the FOM's call"}
                    />
                  </div>
                ) : (
                  <div className="bind provisional" style={{ display: "grid", gap: 8 }}>
                    <div className="field">
                      <label>How did they accept?</label>
                      <Choice options={ANSWERS} value={how} onChange={setHow} />
                    </div>
                    {how ? (
                      <div className="field">
                        <label>
                          {how === "VERBAL" ? "What they said · the words are the record" : "They wrote to us — email or WhatsApp; nothing to attach"}
                        </label>
                        {how === "VERBAL" ? (
                          <textarea
                            className="input"
                            rows={2}
                            value={said}
                            onChange={(e) => setSaid(e.target.value)}
                            placeholder="'yes, go ahead with the two rooms'"
                          />
                        ) : null}
                      </div>
                    ) : null}
                    <div className="row-acts">
                      <Button
                        compact
                        state={acceptM.isPending ? "working" : answerReady ? "default" : "inert"}
                        title={answerReady ? undefined : how === "VERBAL" ? "write what they said first" : "choose how they answered first"}
                        onClick={() => acceptM.mutate()}
                      >
                        Record the acceptance
                      </Button>
                      <Button kind="quiet" compact onClick={() => setAnswerOpen(false)}>
                        Not now
                      </Button>
                    </div>
                  </div>
                )}
              </Live>
            </>
          ) : q.state === "DRAFT" ? (
            <span className="sm">Not sent yet.</span>
          ) : (
            <span className="sm">This version is {state.word}.</span>
          )}
        </div>
      ) : null}

      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
      <ReasonDialog
        open={closeLoopOpen}
        onClose={() => setCloseLoopOpen(false)}
        busy={closeLoopM.isPending}
        title="Close the reply window"
        caseLines={[`${quoteNo(q)} · sent ${fmtStamp(q.sentAt, tz)}`]}
        lead="No answer came from the guest. This records the FOM's decision in place of their answer."
        confirmLabel="Record the decision"
        placeholder="agent confirmed by phone to the FOM"
        onConfirm={(r) => closeLoopM.mutate(r)}
      />
    </StepCard>
  );
}

/* ------------------------------------------------------------------ earlier versions */

function QuoteHistoryCard({ entry, quotations, tz }: { entry: EntryDetail; quotations: QuotationSummary[]; tz: string }) {
  const { session } = useSession();
  const passes = passesOf(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const replyNotAsked = latestDispatched(useCommunications(entry.id).data?.items, "QUOTATION")?.acknowledgementStatus === "NOT_ASKED";
  return (
    <StepCard
      title="Every version of the quotation"
      meta={`Each version shows the total it was priced at. A replaced version opens exactly as it was sent.${passes.many ? " Versions from before the booking was last changed are kept for the record — view only." : ""}`}
    >
      <table className="table compact">
        <thead>
          <tr>
            <th>Quotation</th>
            {passes.many ? <th>Pass</th> : null}
            <th>Standing</th>
            <th style={{ textAlign: "right" }}>Total</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {quotations.map((q) => {
            const passNo = passes.numberById.get(q.segmentId) ?? null;
            const current = passNo == null || passNo === passes.currentNumber;
            const st = quoteStanding(q.state, replyNotAsked);
            return (
              <tr key={q.id} className="static" style={current ? undefined : { opacity: 0.7 }}>
                <td>
                  {q.referenceNumber} · v{q.versionNumber}
                  <span className="sub">{fmtStamp(q.createdAt, tz)}</span>
                </td>
                {passes.many ? <td>{passNo != null ? `Pass ${passNo}${current ? " · now" : ""}` : "earlier"}</td> : null}
                <td>
                  <Chip tone={st.tone}>{st.word}</Chip>
                </td>
                <td className="money" style={{ textAlign: "right" }}>
                  {money(q.totalAmount, q.currency)}
                </td>
                <td>
                  <div className="row-acts" style={{ justifyContent: "flex-end" }}>
                    <Button
                      kind="quiet"
                      compact
                      icon="eye"
                      onClick={() =>
                        setPaper({
                          kind: "quotation",
                          id: q.id,
                          label: `Quotation ${q.referenceNumber} · v${q.versionNumber}`,
                          frozen: (q.state === "SUPERSEDED" || q.state === "EXPIRED") && !!q.pdfStorageKey,
                        })
                      }
                    >
                      Preview
                    </Button>
                    <Button
                      kind="quiet"
                      compact
                      icon="file"
                      onClick={() => session && openQuotationPdf(session, q.id).catch((e) => toastRefusal(e, "The PDF could not be opened"))}
                    >
                      PDF
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </StepCard>
  );
}

/* ------------------------------------------------------------------ sending */

