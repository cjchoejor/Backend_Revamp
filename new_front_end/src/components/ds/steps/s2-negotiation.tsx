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
import { useConversation } from "@/hooks/use-conversation";
import { s2Readiness } from "@/lib/desk/workspace";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BindingBox, Button, Chip, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useBookingRooms } from "@/hooks/use-booking-rooms";
import { QuoteValidityField, canonComps, readDiscount, shownQuotation, useStayTable, type RecordedDiscount, type StayTable } from "./s2-stay-table";
import { useStaysTogether } from "./s2-together";
import { TripCancelWay } from "./s3-trip-cancel";
import { TripNegotiationTable } from "./s2-trip-table";
import { ChangeStaysTogether } from "./s2-change-together";
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
  type TripPreviewStayInput,
} from "@/lib/api/quotations";
import { RoomCompositionPlanner } from "@/components/desk/workspace/room-compositions-board";
import { ChangeConfiguration, DecidedConfigurationChanges, WaitingConfigurationChange } from "./s2-configuration";
import { fmtDateTime, fmtStamp, money, plural } from "@/lib/ds/format";
import type { EntryDetail, QuotationSummary, SpeculativeHoldSummary } from "@/types/api";
import { Choice, latestDispatched, useCommunications, useReplyAsked, DsDialog, Live, Notice, OtherWaysTabs, ChangeBookingMenu, StageActs, useOpenAlsoWay, NotSentChip, PaperDrawer, QuotationSendDialog, ReasonDialog, SeeRow, StepCanvas, StepCard, Tool, atLeast, toastRefusal, type PaperRef, useBedPlan, useOpenFileTab, useRefreshEntry, useStepFlow, useFlowCard, anchorFor, revealCard, words, parkTab, declineTab } from "./kit";
import { usePublishPriceDraft } from "@/lib/ds/stay-price";
import { Help } from "@/components/ds/help";
import type { ChangeBookingItem } from "./kit";
import { CompetingClaimsCard, LEVEL_WORD, passesOf, roomsHeldWord, useCompetingClaims, useRoomNumbers, useRoomTypeNames } from "./s2-shared";
import { useInvoiceRecipient } from "@/hooks/use-invoice-recipient";
import { billNo, proformaBaseNo, quoteNo } from "@/lib/ds/papers";
import { TripQuotationCard, useTripQuotation } from "./s2-trip-quotation";

/* ------------------------------------------------------------------ vocabulary */

const QUOTE_STATE: Record<string, { word: string; tone: "success" | "warning" | "quiet" | "default" }> = {
  // Amber since 2026-11-05 (operator): the guest has not got it, which is the thing to see here.
  DRAFT: { word: "generated · not sent", tone: "warning" },
  SENT: { word: "sent · awaiting the answer", tone: "warning" },
  ACCEPTED: { word: "accepted", tone: "success" },
  SUPERSEDED: { word: "replaced", tone: "quiet" },
  EXPIRED: { word: "lapsed", tone: "warning" },
};

/**
 * A quotation's standing. With its reply off nobody is waiting on the guest, so it reads "sent"
 * (2026-11-03). A reply by email is not an acceptance (2026-11-12): it reads "they replied" until the
 * desk records that they accept it.
 */
function quoteStanding(state: string, replyNotAsked: boolean, replied = false) {
  if (state === "SENT" && replied) return { word: "sent · they replied", tone: "warning" as const };
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
  const stay = useStayTable(entry, { past });
  const together = useStaysTogether(past ? null : entry);
  const { passes, passId, editable, quotations, accepted, working, shown, sealedPreferred, sealedRoomIds, beds, anchorRoomId, tableFaults, setTableFaults, roomDates, proformaLocked, roomCompositions, setRoomCompositions, discountValue, setDiscountValue, discountUnit, setDiscountUnit, recordedDiscount, discountForPreview, tableUnsaved, validWindow, inHours, validUnit, maxValid, validTouched, setValidTouched, validNumber, seedCompositions, createBody, supersedeBody, tableOpen } = stay;
  const elevated = atLeast(session?.actorLevel, "L2");
  // The server's rule (`enforceSpeculativeHoldReleaseAuthority`).
  const mayRelease = atLeast(session?.actorLevel, "L3");
  const extraKeys: ReadonlyArray<ReadonlyArray<unknown>> = [["quotation-preview"], ["competing-claims", entry.id]];

  /* ---- the quotations of this pass, and of every pass ---- */
  const allQuotations = useMemo(
    () =>
      [...(entry.quotations ?? [])].sort((a, b) => {
        const sa = passes.numberById.get(a.segmentId) ?? 0;
        const sb = passes.numberById.get(b.segmentId) ?? 0;
        return sa !== sb ? sb - sa : (b.versionNumber ?? 0) - (a.versionNumber ?? 0);
      }),
    [entry.quotations, passes.numberById],
  );
  /**
   * "Change configuration" (2026-09-30; dates since 2026-10-12) — the stay, the rooms and the party, changed here rather than by
   * re-entering to Inquiry. It takes over this card while it is open: the composition table
   * prices a plan, and editing the plan underneath it would be two tables for one booking.
   */
  const [changing, setChanging] = useState(false);
  const holds = (entry.speculativeHolds ?? []).filter((h) => !passId || h.segmentId === passId);
  const activeHold = holds.find((h) => h.state === "PLACED" || h.state === "UPGRADED") ?? null;
  const lastHold = activeHold ? null : (holds[0] ?? null);

  /* ---- the stays worked together: the block and the change reach all of them (2026-11-09) ---- */
  const stayTables = useRef<Record<string, StayTable>>({});
  const groupStays = useMemo(
    () => (together.active ? [entry, ...together.others].sort((a, b) => together.stayNoOf(a.id) - together.stayNoOf(b.id)) : [entry]),
    [entry, together.active, together.others], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [groupFaults, setGroupFaults] = useState<string[]>([]);
  const [groupInputs, setGroupInputs] = useState<Array<TripPreviewStayInput & { stayNo: number; saved: boolean }>>([]);
  const tableOf = (e: EntryDetail): StayTable | undefined => (e.id === entry.id ? stay : stayTables.current[e.id]);
  const activeHoldOf = (e: EntryDetail) => {
    const pid = passesOf(e).current?.id ?? null;
    return (e.speculativeHolds ?? []).filter((h) => !pid || h.segmentId === pid).find((h) => h.state === "PLACED" || h.state === "UPGRADED") ?? null;
  };
  const markedStays = groupStays.flatMap((e) => {
    const hold = activeHoldOf(e);
    return hold ? [{ e, hold }] : [];
  });
  const staysToMark = groupStays.filter((e) => !activeHoldOf(e));
  const stayWord = (e: EntryDetail) => (together.active ? `Stay ${together.stayNoOf(e.id)} · ` : "");
  const heldWordOf = (e: EntryDetail, ids: string[]) =>
    roomsHeldWord(ids.map((id) => ({ number: roomNos.get(id) ?? null, typeName: typeNames.get(id) ?? null, quiet: tableOf(e)?.bookingRooms.named.has(id) ?? false })));

  /* ---- what the doors hold ---- */
  const [holdWhy, setHoldWhy] = useState("");
  const [markFor, setMarkFor] = useState<MarkFor>("SETTING");
  const [mark, setMark] = useState({ d: "0", h: "0", m: "15" });
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
          discount: discountForPreview,
          ...(together.active && groupInputs.length === groupStays.length ? { together: groupInputs } : {}),
          saved: !tableUnsaved,
        }
      : null,
  );

  const markSeconds =
    Math.max(0, Math.floor(Number(mark.d) || 0)) * 86_400 +
    Math.max(0, Math.floor(Number(mark.h) || 0)) * 3_600 +
    Math.max(0, Math.floor(Number(mark.m) || 0)) * 60;

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
  const [sendTarget, setSendTarget] = useState<{ entry: EntryDetail; q: QuotationSummary } | null>(null);
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
      return supersedeQuotation(session!, working.id, supersedeBody());
    },
    onSuccess: async (q) => {
      toast.success(`Version ${q.versionNumber} generated — the earlier one is kept`);
      setValidTouched(false);
      refresh(extraKeys);
      await goToQuotation();
    },
    onError: (e) => toastRefusal(e, "The quotation could not be generated again"),
  });
  const refreshGroup = () => refresh([...extraKeys, ...together.others.map((o) => ["entry", o.id])]);
  const blockM = useMutation({
    mutationFn: async () => {
      createdRef.current = false;
      const done: Array<{ e: EntryDetail; h: SpeculativeHoldSummary }> = [];
      const failed: Array<{ e: EntryDetail; err: unknown }> = [];
      for (const e of together.active ? staysToMark : [entry]) {
        try {
          const t = tableOf(e);
          if (!t?.anchorRoomId) throw new Error("Choose the rooms at Inquiry first");
          if (!t.working && !t.accepted) {
            await createQuotation(session!, e.id, t.createBody());
            createdRef.current = true;
          }
          const h = await placeSpeculativeHold(session!, e.id, {
            roomId: t.anchorRoomId,
            ttlSeconds: markFor === "CUSTOM" ? markSeconds : undefined,
            commercialBasis: holdWhy.trim() || DEFAULT_MARK_BASIS,
          });
          done.push({ e, h });
        } catch (err) {
          failed.push({ e, err });
        }
      }
      if (done.length === 0 && failed.length > 0) throw failed[0].err;
      return { done, failed };
    },
    onSuccess: ({ done, failed }) => {
      toast.success(
        `${createdRef.current ? "Quotation generated · " : ""}${done
          .map(({ e, h }) => `${stayWord(e)}${plural(holdRoomIds(h).length, "room")} marked until ${fmtDateTime(h.expiresAt, tz)}`)
          .join(" · ")} · nothing sent`,
      );
      for (const f of failed) toastRefusal(f.err, `${stayWord(f.e)}the rooms could not be marked`);
      refreshGroup();
    },
    onError: (e) => {
      toastRefusal(e, createdRef.current ? "The quotation was generated, but the rooms could not be marked" : "The rooms could not be marked");
      if (createdRef.current) refreshGroup();
    },
  });
  const releaseM = useMutation({
    mutationFn: async (reason: string) => {
      if (markedStays.length === 0) throw new Error("No rooms are marked");
      for (const { e, hold } of markedStays) await releaseSpeculativeHold(session!, e.id, hold.id, { releaseReason: reason });
    },
    onSuccess: () => {
      toast.success("The rooms are no longer marked — the quotation stands");
      setReleaseOpen(false);
      refreshGroup();
    },
    onError: (e) => toastRefusal(e, "The rooms could not be released"),
  });


  /* ---- reasons a door stays shut ---- */
  // Only once something is priced: before that, "Quote generated" already holds the move.
  const unsavedItem = tableOpen && !changing && !!working && (tableUnsaved || validTouched) ? "Table changes saved and priced" : null;
  // Stays worked together move on together, so what each still needs is on this list (2026-11-09).
  const [othersUnsaved, setOthersUnsaved] = useState<string[]>([]);
  const othersOpen = together.active
    ? together.others.flatMap((o) =>
        s2Readiness(o)
          .filter((c) => !c.met)
          .map((c) => `Stay ${together.stayNoOf(o.id)} · ${c.label.charAt(0).toLowerCase()}${c.label.slice(1)}`),
      )
    : [];
  const openKey = [...(unsavedItem ? [unsavedItem] : []), ...othersOpen, ...(together.active ? othersUnsaved : [])].join("|");
  useEffect(() => {
    onOpenItems?.(openKey ? openKey.split("|") : []);
  }, [openKey, onOpenItems]);
  useEffect(() => () => onOpenItems?.([]), [onOpenItems]);
  const noRooms = together.active
    ? staysToMark.some((e) => !tableOf(e)?.anchorRoomId)
      ? "choose the rooms at Inquiry first"
      : null
    : !sealedPreferred || !anchorRoomId
      ? "choose the rooms at Inquiry first"
      : null;
  const faultsNow = together.active ? groupFaults : tableFaults;
  /** A table with a fault in it cannot be sent, marked or priced — it is the same basis. */
  const tableReason =
    faultsNow.length > 0
      ? `put the table right first — ${faultsNow[0]}${faultsNow.length > 1 ? ` (and ${faultsNow.length - 1} more)` : ""}`
      : null;
  const blockReason =
    noRooms ??
    tableReason ??
    (markFor === "CUSTOM" && markSeconds <= 0
      ? "set at least a minute"
      : !together.active && validNumber == null && !working && !accepted
        ? `how long the quote stands: 1 to ${plural(maxValid, validUnit)}`
        : null);

  const markedCount = together.active
    ? staysToMark.reduce((n, e) => n + (tableOf(e)?.sealedRoomIds.length ?? 0), 0)
    : activeHold
      ? holdRoomIds(activeHold).length
      : sealedRoomIds.length;
  const anyQuotedToMark = together.active ? staysToMark.every((e) => tableOf(e)?.working || tableOf(e)?.accepted) : !!(working || accepted);
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
  const tableSummary = together.active
    ? [entry, ...together.others]
        .sort((a, b) => together.stayNoOf(a.id) - together.stayNoOf(b.id))
        .map((e) => {
          const q = shownQuotation(e);
          return `Stay ${together.stayNoOf(e.id)}: ${q ? `${q.referenceNumber} · v${q.versionNumber}` : "not priced"}`;
        })
        .join(" · ")
    : pricedQuote
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
      {markedStays.map(({ e, hold }) => (
        <BindingBox key={e.id} family="provisional" stateWord={new Date(hold.expiresAt).getTime() < clock.now ? "expired" : "marked"} style={{ marginTop: 4 }}>
          <div className="sm" style={{ paddingRight: 80 }}>
            {stayWord(e)}
            {heldWordOf(e, holdRoomIds(hold))} marked until <b>{fmtDateTime(hold.expiresAt, tz)}</b> · others can still be sold if someone commits first
          </div>
        </BindingBox>
      ))}
      {markedStays.length === 0 && lastHold ? (
        <div className="sm">
          The last marker {lastHold.state === "EXPIRED" || lastHold.releaseReason === "EXPIRY" ? "ran out" : "was released"}
          {lastHold.releasedAt ? ` on ${fmtStamp(lastHold.releasedAt, tz)}` : ` — it was set to end ${fmtDateTime(lastHold.expiresAt, tz)}`}.
        </div>
      ) : null}
      {otherMarkers.length ? <div className="sm">Also marked by {otherMarkers.map((o) => o.reference ?? o.entryId).join(" · ")}</div> : null}
      <Live>
        <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
          {markedStays.length > 0 ? (
            <SeeRow
              label="Release"
              note={together.active ? "Frees the rooms of every stay marked, with a reason. The quotations stand." : "Frees the rooms, with a reason. The quotation stands."}
              onClick={editable && mayRelease ? () => setReleaseOpen(true) : undefined}
              reason={!editable ? "not at this step" : mayRelease ? undefined : "releasing a marker early is the GM's call"}
            />
          ) : null}
          {staysToMark.length > 0 ? (
            <SeeRow
              kind="primary"
              label={together.active ? (markedStays.length ? "Mark the rest" : staysToMark.length > 2 ? "Mark every stay's rooms" : "Mark both stays' rooms") : "Mark the rooms"}
              note={`${anyQuotedToMark ? "Marks" : "Prices the quotation from the table and marks"} ${plural(markedCount || 1, "room")} ${markLength}. Nothing is sent to the guest. The reason and the time above are used by this block only.`}
              onClick={editable ? () => blockM.mutate() : undefined}
              state={blockM.isPending ? "working" : editable && !blockReason ? "default" : "inert"}
              reason={!editable ? "not at this step" : (blockReason ?? undefined)}
            />
          ) : null}
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
          note: together.active
            ? "Either stay's dates, rooms, adults, children and ages. A quotation priced on the old configuration is retired."
            : "The dates, the rooms, the adults, the children and their ages. A quotation priced on the old configuration is retired.",
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
        title={together.active ? `Who sleeps where, and their meals · ${together.label.toLowerCase()} together` : "Who sleeps where, and their meals"}
        meta="One row per room: the guests by age, their meal plans, extra beds, any negotiated rate and the booking's discount. Saving the table prices it — that is the quotation."
      >
        {changing && together.active ? (
          <ChangeStaysTogether stays={groupStays} stayNoOf={together.stayNoOf} onClose={() => setChanging(false)} onChanged={refreshGroup} />
        ) : changing ? (
          <ChangeConfiguration
            entry={entry}
            onClose={() => setChanging(false)}
            onDone={() => {
              setChanging(false);
              refresh();
            }}
          />
        ) : together.deciding ? (
          <span className="meta">Reading the stays…</span>
        ) : together.active ? (
          <Tool>
            <div onPointerDownCapture={markHandEdit} onKeyDownCapture={markHandEdit} onInputCapture={markHandEdit}>
              <TripNegotiationTable
                entry={entry}
                own={stay}
                others={together.others}
                stayNoOf={together.stayNoOf}
                onOthersUnsaved={setOthersUnsaved}
                latest={stayTables}
                onFaults={setGroupFaults}
                onInputs={setGroupInputs}
                onSaved={() => {
                  refresh(extraKeys);
                  void goToQuotation();
                }}
              />
            </div>
          </Tool>
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
              saveAside={<QuoteValidityField t={stay} />}
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
        {together.active ? null : <ChildrenAges entry={entry} />}
        {/* The rooms and the party are changed HERE, not by re-entering to Inquiry (2026-09-30,
            operator ruling). It sits under the table it changes, and closes while the change is
            being made so there is only ever one plan on screen. */}
        {!changing ? groupStays.map((e) => <WaitingConfigurationChange key={e.id} entry={e} />) : null}
        {/* Change configuration moved into "Change booking" at the end of the step's line, beside
            Cancel booking (2026-10-27, operator). The provisional block is placed from the bar at the
            foot. A marker in place is a state, so it is still said here. */}
        {!changing && !past
          ? markedStays.map(({ e, hold }) => (
              <div key={e.id} className="row-acts" style={{ marginTop: 12, alignItems: "center", gap: 10 }}>
                <span className="sm">
                  <Icon name="clock" /> {stayWord(e)}
                  {heldWordOf(e, holdRoomIds(hold))} marked until <b>{fmtDateTime(hold.expiresAt, tz)}</b>
                </span>
              </div>
            ))
          : null}
        {!changing ? groupStays.map((e) => <DecidedConfigurationChanges key={e.id} entry={e} />) : null}
      </StepCard>

      {/* The live quotation sits directly under the table that priced it (2026-09-30, operator).
          It used to be below the quote and the marker, pages away from the grid whose Save mints
          it — so the round trip "price it · read what that produced" ran down the whole step and
          back. Its VERSION LIST stays at the foot of the step: it is a record to look up, not
          part of the work, and the two swapped places rather than travelling together. */}
      {/* Viewing the stays together shows only the trip's quotation, and Send sends that one; each
          stay's own shows when they are viewed one at a time (2026-11-09, operator). */}
      {together.active ? (
        <TripQuotationCard entry={entry} editable={editable} inFlow />
      ) : shown ? (
        <QuotationCard
          entry={entry}
          q={shown}
          editable={editable}
          elevated={elevated}
          tz={tz}
          nowMs={clock.now}
          onSend={() => setSendTarget({ entry, q: shown })}
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
      {together.active ? <TripQuoteHistoryCard entry={entry} tz={tz} /> : allQuotations.length > 1 ? <QuoteHistoryCard entry={entry} quotations={allQuotations} tz={tz} /> : null}

      <CompetingClaimsCard entryId={entry.id} />
      {/* Other ways as sub-tabs (2026-10-12, operator), each panel what its button used to open. */}
      <OtherWaysTabs
        tabs={[
          { key: "block", label: "Provisional block", content: blockPanel },
          parkTab(parkNow, parking),
          // The answer the house had no way to write down (2026-10-01) — see the Inquiry step.
          // The guest said no is Cancel booking here, opened from Change booking (2026-10-27, operator).
          together.active
            ? { key: "decline", label: "Cancel booking", inBar: false, content: <TripCancelWay entry={entry} stays={[entry, ...together.others]} stayNoOf={together.stayNoOf} /> }
            : declineTab(declineNow, declining, { label: "Cancel booking", act: "Cancel the booking", inBar: false }),
          // The Counter-offer way was taken off (2026-10-27, operator: "remove the counter offer") —
          // it could record nothing; the discount on the table is how a counter-offer is met.
        ]}
      />

      <QuotationSendDialog
        entry={sendTarget?.entry ?? entry}
        target={sendTarget?.q ?? null}
        onClose={() => setSendTarget(null)}
        onSent={() => {
          const other = sendTarget && sendTarget.entry.id !== entry.id ? sendTarget.entry.id : null;
          setSendTarget(null);
          refresh(other ? [...extraKeys, ["entry", other]] : extraKeys);
        }}
      />
      <ReasonDialog
        open={releaseOpen}
        danger
        onClose={() => setReleaseOpen(false)}
        busy={releaseM.isPending}
        title="Release the rooms"
        caseLines={markedStays.length ? markedStays.map(({ e, hold }) => `${stayWord(e)}${heldWordOf(e, holdRoomIds(hold))} marked until ${fmtDateTime(hold.expiresAt, tz)}`) : undefined}
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
  stayNo,
  plain,
}: {
  /** Named with its stay, when several stays' quotations are on one page (2026-11-09). */
  stayNo?: number;
  /** Not one of the step's numbered sections: the other stays' cards. */
  plain?: boolean;
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
  const quoteComm = latestDispatched(useCommunications(entry.id).data?.items, "QUOTATION");
  const replyNotAsked = quoteComm?.acknowledgementStatus === "NOT_ASKED";
  const replyAsked = useReplyAsked(entry.id, "QUOTATION");
  // Their reply by email, recorded against the quotation without accepting it (2026-11-12).
  const conversation = useConversation(entry.id);
  const replied = q.state === "SENT" && quoteComm?.acknowledgementStatus === "RECEIVED";
  const theirReply = replied
    ? (conversation.data?.emails ?? []).find((e) => e.kind === "REPLY" && e.answered?.communicationId === quoteComm?.id) ?? null
    : null;
  // On a trip of several stays the trip's quotation is the guest's paper; this stay's own Send steps back.
  const onTrip = (useTripQuotation(entry).data?.stays.length ?? 0) > 1;
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
  const state = quoteStanding(q.state, replyNotAsked, replied);
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
      flow={plain ? undefined : "quotation"}
      title={`${stayNo ? `Stay ${stayNo} · ` : ""}Quotation · ${q.referenceNumber} · v${q.versionNumber}`}
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
              kind={editable && q.state === "DRAFT" ? (onTrip ? "secondary" : "primary") : "quiet"}
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
              {replied ? (
                <div className="quote-replied" data-quote-replied>
                  <span className="sm">
                    <Icon name="send" /> <b>They replied by email</b>
                    {theirReply ? <> · {fmtDateTime(theirReply.at, tz)}</> : null} — not accepted yet. Record the answer when they agree.
                  </span>
                  {theirReply?.snippet ? <span className="quote-replied-words">&ldquo;{theirReply.snippet}&rdquo;</span> : null}
                </div>
              ) : (
                <span className="sm">
                  <Icon name="clock" /> Awaiting their answer{q.validUntil ? ` — the price holds until ${fmtDateTime(q.validUntil, tz)}` : ""}
                </span>
              )}
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

/** Viewing the stays together, the versions are the trip's own (2026-11-09); each stay's are on its page. */
function TripQuoteHistoryCard({ entry, tz }: { entry: EntryDetail; tz: string }) {
  const q = useTripQuotation(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const versions = [...(q.data?.versions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (versions.length < 2) return null;
  return (
    <StepCard title="Every version of the quotation" meta="The trip's own quotation, with the total each version was made at. Each stay's own versions are on its own page, from the list at the top.">
      <table className="table compact">
        <thead>
          <tr>
            <th>Quotation</th>
            <th>Standing</th>
            <th style={{ textAlign: "right" }}>Total</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const live = v.state === "LIVE";
            return (
              <tr key={v.id} className="static" style={live ? undefined : { opacity: 0.7 }}>
                <td>
                  {v.number}
                  <span className="sub">{fmtStamp(v.createdAt, tz)}</span>
                </td>
                <td>{!live ? <Chip tone="quiet">replaced</Chip> : v.sentAt ? <Chip tone="success">sent</Chip> : <NotSentChip />}</td>
                <td className="money" style={{ textAlign: "right" }}>
                  {money(v.total)}
                </td>
                <td>
                  <div className="row-acts" style={{ justifyContent: "flex-end" }}>
                    <Button kind="quiet" compact icon="eye" onClick={() => setPaper({ kind: "trip", id: v.id, label: `The trip's quotation ${v.number}`, tripKind: "QUOTATION" })}>
                      Preview
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

