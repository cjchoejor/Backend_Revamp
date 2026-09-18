"use client";

/**
 * Step 2 · Negotiation — "shape the price" (SS03 §5, prototype `stepCanvas[2]`, Storyboard 02).
 *
 * The rate with its basis, the counter-offer line (not in the backend yet), who sleeps where and
 * their meals (the per-room table — the old planner, kept whole), the two doors — provisional
 * block or send the quote — the quotation as a paper with the guest's answer, earlier versions,
 * and the race with another booking.
 *
 * Generating the quotation is what the gate needs; sending it is not (operator ruling
 * 2026-07-28). Every figure is the backend's: the table prices itself through the live preview,
 * the paper's total comes from the billing summary. Nothing is added up here.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { BindingBox, Button, Chip, Icon, SourceMark } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { getChildPolicy } from "@/lib/api/child-policy";
import { openQuotationPdf } from "@/lib/api/documents";
import { getBillingSummary, getRateReference } from "@/lib/api/entries";
import {
  acceptQuotation,
  approveQuotationDiscount,
  createQuotation,
  placeSpeculativeHold,
  releaseSpeculativeHold,
  resolveQuotationAckOpenLoop,
  sendQuotation,
  supersedeQuotation,
  type RoomCompositionInput,
} from "@/lib/api/quotations";
import { RoomCompositionPlanner } from "@/components/desk/workspace/room-compositions-board";
import { PriceResolutionPanel } from "@/components/desk/workspace/price-resolution";
import { operativeRoomCompositions } from "@/lib/desk/party-rooms";
import { fmtDateTime, fmtStamp, money, plural } from "@/lib/ds/format";
import { optionSelectedRoomIds, preferredHoldRoomId, type EntryDetail, type QuotationSummary, type SpeculativeHoldSummary } from "@/types/api";
import {
  Choice,
  DsDialog,
  Live,
  Notice,
  OtherWays,
  PaperDrawer,
  PapersCard,
  ReasonDialog,
  RequestsCard,
  SeeRow,
  StepCanvas,
  StepCard,
  Tool,
  atLeast,
  toastRefusal,
  useRefreshEntry,
  words,
  type PaperRef,
} from "./kit";
import { CompetingClaimsCard, LEVEL_WORD, passesOf, roomsWord, useCompetingClaims, useRoomNumbers } from "./s2-shared";
import { useInvoiceRecipient } from "@/hooks/use-invoice-recipient";

/* ------------------------------------------------------------------ vocabulary */

const QUOTE_STATE: Record<string, { word: string; tone: "success" | "warning" | "quiet" | "default" }> = {
  DRAFT: { word: "generated · not sent", tone: "quiet" },
  SENT: { word: "sent · awaiting the answer", tone: "warning" },
  ACCEPTED: { word: "accepted", tone: "success" },
  SUPERSEDED: { word: "replaced", tone: "quiet" },
  EXPIRED: { word: "lapsed", tone: "warning" },
};

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
  return d.unit === "percent" ? `${d.value}% off the total` : `${money(d.value, currency)} off the total`;
}

/** Every room a marker covers — the anchor and each room of its per-night snapshot. */
function holdRoomIds(h: SpeculativeHoldSummary): string[] {
  const ids = new Set<string>(h.roomId ? [h.roomId] : []);
  for (const n of h.perNightBreakdown ?? []) for (const r of n.roomIds) ids.add(r.roomId);
  return [...ids];
}

/* ------------------------------------------------------------------ the step */

export function S2Negotiation({ entry, past, onPark }: { entry: EntryDetail; past: boolean; onPark?: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const clock = useHotelClock(30_000);
  const tz = clock.tz;
  const roomNos = useRoomNumbers();
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
  const seedCompositions = useMemo(() => operativeRoomCompositions(entry) ?? undefined, [entry.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- the rooms chosen at Inquiry, and the marker on them ---- */
  const sealedPreferred = (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected);
  const sealedRoomIds = useMemo(() => optionSelectedRoomIds(sealedPreferred?.optionSelected), [sealedPreferred?.optionSelected]);
  const anchorRoomId = preferredHoldRoomId(sealedPreferred?.optionSelected ?? null);
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
  const [notes, setNotes] = useState("");
  const [holdWhy, setHoldWhy] = useState("");
  const [markFor, setMarkFor] = useState<MarkFor>("SETTING");
  const [mark, setMark] = useState({ d: "0", h: "0", m: "15" });
  const [discountValue, setDiscountValue] = useState("");
  const [discountUnit, setDiscountUnit] = useState<"percent" | "amount">("percent");
  const [discountBasis, setDiscountBasis] = useState("negotiation");
  const recordedDiscount = useMemo(() => readDiscount(working ?? accepted), [working, accepted]);
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    const id = (working ?? accepted)?.id ?? null;
    if (seededFor.current === id) return;
    seededFor.current = id;
    if (recordedDiscount) {
      setDiscountValue(String(recordedDiscount.value));
      setDiscountUnit(recordedDiscount.unit);
      setDiscountBasis(recordedDiscount.basis);
    }
  }, [working, accepted, recordedDiscount]);

  /** A blank or zero figure is "no discount"; clearing a recorded one must be said as `null`. */
  const discountPayload = (() => {
    const n = Number(discountValue);
    if (!discountValue.trim() || !Number.isFinite(n) || n <= 0) return null;
    const basis = discountBasis.trim() || "negotiation";
    return discountUnit === "amount" ? { discountAmount: n, discountBasis: basis } : { discountPercent: n, discountBasis: basis };
  })();

  /* ---- validity: whole days from now, capped at 30 and at check-in (the server re-checks) ---- */
  const [validDays, setValidDays] = useState("2");
  const checkInMs = entry.checkInDate ? new Date(entry.checkInDate).getTime() : Number.NaN;
  // Mirrors resolveQuotationValidity: the check-in caps the window only while it is still ahead.
  // A same-day booking's check-in (stored at the day's start) has already passed, and capping at
  // it showed a validity that had ended before the quote existed (2026-09-18).
  const checkInAhead = Number.isFinite(checkInMs) && checkInMs > clock.now;
  const maxValidDays = checkInAhead ? Math.max(1, Math.min(30, Math.floor((checkInMs - clock.now) / DAY_MS))) : 30;
  useEffect(() => {
    const n = Number(validDays);
    if (Number.isFinite(n) && n > maxValidDays) setValidDays(String(maxValidDays));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxValidDays]);
  const validDaysNumber = (() => {
    const n = Number(validDays);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, maxValidDays) : null;
  })();
  const validityEnd =
    validDaysNumber == null
      ? null
      : checkInAhead
        ? Math.min(clock.now + validDaysNumber * DAY_MS, checkInMs)
        : clock.now + validDaysNumber * DAY_MS;

  const markSeconds =
    Math.max(0, Math.floor(Number(mark.d) || 0)) * 86_400 +
    Math.max(0, Math.floor(Number(mark.h) || 0)) * 3_600 +
    Math.max(0, Math.floor(Number(mark.m) || 0)) * 60;

  const createBody = () => ({
    notes: notes.trim() || undefined,
    validDays: validDaysNumber ?? undefined,
    requestedDiscount: discountPayload ?? undefined,
    roomCompositions: roomCompositions.length > 0 ? roomCompositions : undefined,
  });

  /* ---- the acts ---- */
  const [sendTarget, setSendTarget] = useState<QuotationSummary | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const createdRef = useRef(false);

  const generateM = useMutation({
    mutationFn: () => createQuotation(session!, entry.id, createBody()),
    onSuccess: (q) => {
      toast.success(`Quotation ${q.referenceNumber} generated — nothing sent, no rooms marked`);
      refresh(extraKeys);
    },
    onError: (e) => toastRefusal(e, "The quotation could not be generated"),
  });
  const regenerateM = useMutation({
    mutationFn: () => {
      if (!working) throw new Error("There is no quotation to generate again");
      return supersedeQuotation(session!, working.id, {
        notes: notes.trim() || undefined,
        validDays: validDaysNumber ?? undefined,
        requestedDiscount: discountPayload ?? (recordedDiscount ? null : undefined),
        roomCompositions: roomCompositions.length > 0 ? roomCompositions : undefined,
      });
    },
    onSuccess: (q) => {
      toast.success(`Version ${q.versionNumber} generated — the earlier one is kept`);
      refresh(extraKeys);
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
  const generateForSendM = useMutation({
    mutationFn: () => createQuotation(session!, entry.id, createBody()),
    onSuccess: (q) => {
      toast.success(`Quotation ${q.referenceNumber} generated — now choose how it goes`);
      refresh(extraKeys);
      setSendTarget(q);
    },
    onError: (e) => toastRefusal(e, "The quotation could not be generated"),
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

  const openSend = () => {
    if (draft) setSendTarget(draft);
    else generateForSendM.mutate();
  };

  /* ---- reasons a door stays shut ---- */
  const tableOpen = editable && !accepted && !proformaLocked && !!sealedPreferred;
  const noRooms = !sealedPreferred || !anchorRoomId ? "choose the rooms at Inquiry first" : null;
  const blockReason =
    noRooms ??
    (markFor === "CUSTOM" && markSeconds <= 0
      ? "set at least a minute"
      : validDaysNumber == null && !working && !accepted
        ? `the validity is 1–${maxValidDays} days`
        : null);
  const sendReason = accepted
    ? "the guest has accepted — nothing to send"
    : sent && !draft
      ? "already sent — generate it again to send a new version"
      : proformaLocked && !draft
        ? "the terms are final — a new pass is needed to send another quote"
        : (noRooms ?? (!draft && validDaysNumber == null ? `the validity is 1–${maxValidDays} days` : null));

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

  const competing = useCompetingClaims(entry.id);
  const otherMarkers = (competing.data?.items ?? []).filter((i) => i.kind === "SPECULATIVE_HOLD");

  return (
    <StepCanvas past={past}>
      <RateCard entry={entry} />

      <StepCard
        title="Who sleeps where, and their meals"
        meta="One row per room — the guests by age band, the meal plans, extra beds, any negotiated rate and the booking's discount. The house prices the quotation from this table; nothing is added up here."
      >
        {tableOpen ? (
          <Tool>
            <RoomCompositionPlanner
              sealedRoomIds={sealedRoomIds}
              entryCheckIn={entry.checkInDate ?? null}
              entryCheckOut={entry.checkOutDate ?? null}
              entryAdults={entry.adultCount ?? entry.guestCount ?? null}
              entryChildAges={entry.childAges ?? null}
              persistKey={entry.id}
              entryId={entry.id}
              initialCompositions={seedCompositions}
              onChange={setRoomCompositions}
              discountValue={discountValue}
              discountUnit={discountUnit}
              discountBasis={discountBasis}
              onDiscountChange={(patch) => {
                if (patch.value !== undefined) setDiscountValue(patch.value);
                if (patch.unit !== undefined) setDiscountUnit(patch.unit);
                if (patch.basis !== undefined) setDiscountBasis(patch.basis);
              }}
            />
          </Tool>
        ) : (
          <>
            {!sealedPreferred ? (
              <Notice>Choose the rooms at Inquiry first — the table needs them.</Notice>
            ) : accepted && !past ? (
              <Notice>
                These are the terms the guest accepted, so the table is closed. To change anything, move to Set up and use{" "}
                <b>Renegotiate the price…</b> — a new pass with a fresh quotation.
              </Notice>
            ) : proformaLocked && !past ? (
              <Notice>
                A proforma has been generated on Set up, so these terms are final — it bills them. A price change is a new pass, through{" "}
                <b>Renegotiate the price…</b> on Set up. Changing only the advance re-issues the proforma at the same terms.
              </Notice>
            ) : null}
            <CompositionSummary entry={entry} />
          </>
        )}
        <ChildrenAges entry={entry} />
      </StepCard>

      <StepCard title="Provisional block, or send the quote">
        <div className="form2" style={{ marginBottom: 10 }}>
          <div className="field">
            <label>Valid for · days</label>
            <input
              className="input narrow"
              inputMode="numeric"
              value={validDays}
              readOnly={!editable}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "");
                const n = Number(v);
                setValidDays(v !== "" && n > maxValidDays ? String(maxValidDays) : v);
              }}
            />
            <span className={`hint${validDaysNumber == null ? " warn-ink" : ""}`}>
              {validDaysNumber == null ? (
                `1 to ${maxValidDays} days`
              ) : (
                <>
                  at most {plural(maxValidDays, "day")}
                  {checkInAhead ? " · ends before check-in" : ""} → <b>{fmtDateTime(validityEnd, tz)}</b>
                </>
              )}
              {working ? ` · used when the quote is generated again` : ""}
            </span>
          </div>
          <div className="field">
            <label>Why hold these rooms · optional</label>
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
          <div className="field">
            <label>Internal note · not shown to the guest</label>
            <input className="input" value={notes} readOnly={!editable} placeholder="optional" onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <div className="grid2">
          <div>
            <b>Provisional block</b>
            <div className="meta">Generates the quotation, sends nothing, marks the rooms.</div>
            {activeHold ? (
              <BindingBox
                family="provisional"
                stateWord={new Date(activeHold.expiresAt).getTime() < clock.now ? "expired" : "marked"}
                style={{ marginTop: 8 }}
              >
                <div className="sm" style={{ paddingRight: 80 }}>
                  {roomsWord(holdRoomIds(activeHold), roomNos)} marked until <b>{fmtDateTime(activeHold.expiresAt, tz)}</b> · others can still be sold
                  if someone commits first
                </div>
              </BindingBox>
            ) : lastHold ? (
              <div className="meta" style={{ marginTop: 8 }}>
                The last marker {lastHold.state === "EXPIRED" || lastHold.releaseReason === "EXPIRY" ? "ran out" : "was released"}
                {lastHold.releasedAt ? ` on ${fmtStamp(lastHold.releasedAt, tz)}` : ` — it was set to end ${fmtDateTime(lastHold.expiresAt, tz)}`}.
              </div>
            ) : null}
            {otherMarkers.length ? (
              <div className="meta" style={{ marginTop: 6 }}>
                also marked by {otherMarkers.map((o) => o.reference ?? o.entryId).join(" · ")}
              </div>
            ) : null}
            <Live>
              <div style={{ marginTop: 10, display: "grid", gap: 4 }}>
                {activeHold ? (
                  <SeeRow
                    label="Release…"
                    note="frees the rooms with a reason; the quotation stands"
                    onClick={editable && elevated ? () => setReleaseOpen(true) : undefined}
                    reason={!editable ? "not at this step" : elevated ? undefined : "releasing a marker early is the FOM's call"}
                  />
                ) : (
                  <SeeRow
                    kind="secondary"
                    label="Provisional block"
                    note={`${working || accepted ? "" : "generates the quotation and "}marks ${plural(markedCount || 1, "room")} ${markLength} · sends nothing`}
                    onClick={editable ? () => blockM.mutate() : undefined}
                    state={blockM.isPending ? "working" : editable && !blockReason ? "default" : "inert"}
                    reason={!editable ? "not at this step" : (blockReason ?? undefined)}
                  />
                )}
                <SeeRow
                  label="Extend"
                  note="once for the desk, then the FOM · never a re-quote"
                  state="inert"
                  reason="Extending a marker or a quotation's validity is not in the backend yet (BE-59)"
                />
              </div>
            </Live>
          </div>
          <div>
            <b>Send the quote</b>
            <div className="meta">Generates and sends. Same quote, same validity — sending doesn&rsquo;t restart the clock.</div>
            {sent ? (
              <div className="sm" style={{ marginTop: 8 }}>
                <Icon name="check" /> {sent.referenceNumber} sent {fmtStamp(sent.sentAt, tz)}
                {sent.sentTo ? <span className="meta"> · to {sent.sentTo}</span> : null}
              </div>
            ) : null}
            <Live>
              <div style={{ marginTop: 10 }}>
                <SeeRow
                  kind="primary"
                  label="Send the quote…"
                  note={
                    draft
                      ? `opens the send for ${draft.referenceNumber} — email or WhatsApp; print it from the paper`
                      : "generates the quotation and opens the send — email or WhatsApp"
                  }
                  onClick={editable ? openSend : undefined}
                  state={generateForSendM.isPending ? "working" : editable && !sendReason ? "default" : "inert"}
                  reason={!editable ? "not at this step" : (sendReason ?? undefined)}
                />
              </div>
            </Live>
          </div>
        </div>

        <Live>
          {editable && !accepted && !proformaLocked ? (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              {working ? (
                <SeeRow
                  label="Generate the quote again"
                  note={`a new version priced from the table above — ${working.referenceNumber} is kept as history, and the validity starts again`}
                  onClick={() => regenerateM.mutate()}
                  state={regenerateM.isPending ? "working" : validDaysNumber == null ? "inert" : "default"}
                  reason={validDaysNumber == null ? `the validity is 1–${maxValidDays} days` : undefined}
                />
              ) : (
                <SeeRow
                  label="Generate the quote only"
                  note="the gate needs a generated quotation — nothing is sent and no rooms are marked"
                  onClick={noRooms ? undefined : () => generateM.mutate()}
                  state={generateM.isPending ? "working" : noRooms || validDaysNumber == null ? "inert" : "default"}
                  reason={noRooms ?? (validDaysNumber == null ? `the validity is 1–${maxValidDays} days` : undefined)}
                />
              )}
            </div>
          ) : null}
        </Live>
      </StepCard>

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
      ) : null}

      {allQuotations.length > 1 ? <QuoteHistoryCard entry={entry} quotations={allQuotations} tz={tz} /> : null}

      <CompetingClaimsCard entryId={entry.id} />
      <RequestsCard />
      <OtherWays>
        {onPark && entry.status === "ACTIVE" ? (
          <SeeRow key="park" label="Park…" note="a reason; the booking waits where it is, its expiry paused, until it is resumed — a long park lapses on its own" onClick={onPark} />
        ) : null}
      </OtherWays>
      <PapersCard entry={entry} />

      <SendDialog
        entry={entry}
        target={sendTarget}
        tz={tz}
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
        caseLines={activeHold ? [`${roomsWord(holdRoomIds(activeHold), roomNos)} marked until ${fmtDateTime(activeHold.expiresAt, tz)}`] : undefined}
        lead="The marker is removed. The quotation stands and can still be accepted if the rooms are free then."
        confirmLabel="Release"
        placeholder="agent went elsewhere"
        onConfirm={(r) => releaseM.mutate(r)}
      />
    </StepCanvas>
  );
}

/* ------------------------------------------------------------------ the rate, with its basis */

function RateCard({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const ref = useQuery({
    queryKey: ["rate-reference", entry.id],
    queryFn: () => getRateReference(session!, entry.id),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const r = ref.data;
  const types = r?.roomTypes ?? [];
  const contracted = types.some((t) => t.roomRateSource === "AGENT_RATE_PACKAGE");
  const pct = (rate: number) => `${(rate * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  return (
    <StepCard title="The rate, with its basis">
      {types.length === 0 ? (
        <span className="meta">{ref.isLoading ? "Reading the rates…" : "The rates show once rooms are chosen at Inquiry."}</span>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {types.map((t) => (
            <div key={t.roomTypeId} style={{ display: "grid", gap: 4 }}>
              {types.length > 1 ? (
                <span className="sm">
                  <b>{t.name}</b>
                  <span className="meta">
                    {" "}
                    · {t.roomNumbers.length === 1 ? "room" : "rooms"} {t.roomNumbers.join(", ")}
                  </span>
                </span>
              ) : null}
              <div className="row-acts">
                <Chip>Published {money(t.standardRate, r?.currency)} / night</Chip>
                {t.roomRateSource === "AGENT_RATE_PACKAGE" ? (
                  <Chip tone="solid">
                    {r?.party?.name ?? "The account"} · {money(t.roomRate, r?.currency)} / night · contracted
                  </Chip>
                ) : null}
                {t.packageName ? <Chip>Package {t.packageName}</Chip> : null}
                {t.msrValue != null ? <Chip tone="quiet">floor {money(t.msrValue, r?.currency)}</Chip> : null}
              </div>
            </div>
          ))}
        </div>
      )}
      {r ? (
        <div className="meta" style={{ marginTop: 6 }}>
          <SourceMark kind="derived">
            {contracted
              ? `${r.party ? words(r.party.type) : "Account"} rate · as contracted`
              : r.party
                ? `${r.party.name} has no package for these rooms · the published rate applies`
                : "the published rate plan"}
          </SourceMark>{" "}
          · service charge {pct(r.serviceChargeRate)} and GST {pct(r.gstRate)} on top · the rate with its basis is BE-17
        </div>
      ) : null}

      <h4 style={{ margin: "12px 0 6px" }}>Counter-offers</h4>
      <div className="meta">
        None yet — the line accumulates: what they asked, who, when, the outcome. It rolls up to the agent&rsquo;s record (BE-39).
      </div>
      <Live>
        <div style={{ marginTop: 10 }}>
          <SeeRow
            kind="secondary"
            label="Record a counter-offer…"
            note="what they asked, by whom, the outcome — below contract or over 10% off needs the FOM"
            state="inert"
            reason="Counter-offers as a recorded line are not in the backend yet (BE-39) — until then the discount is set in the table below"
          />
        </div>
      </Live>
    </StepCard>
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
                  {r.roomNumber ? `Room ${r.roomNumber}` : "—"}
                  {r.roomTypeName ? <span className="sub">{r.roomTypeName}</span> : null}
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
  return (
    <div className="row-acts" style={{ marginTop: 12 }}>
      <span className="meta">Children&rsquo;s ages</span>
      <b className="sm">{ages.length ? ages.join(", ") : "no children"}</b>
      <span className="meta">
        under {young + 1} free · {young + 1}–{child} at the child rate · {child + 1} and over count as adults — from the child policy · ages are set
        at Inquiry
      </span>
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
  const [why, setWhy] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false);
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
  const state = QUOTE_STATE[q.state] ?? { word: words(q.state), tone: "default" as const };
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
      toast.success(`${q.referenceNumber} accepted — the answer is on record`);
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

  const pdf = () => {
    if (!session) return;
    openQuotationPdf(session, q.id).catch((e) => toastRefusal(e, "The PDF could not be opened"));
  };

  const answerReady = how === "WRITTEN" || (how === "VERBAL" && said.trim().length > 0);

  return (
    <StepCard
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
                label: `Quotation ${q.referenceNumber}`,
                frozen: (q.state === "SUPERSEDED" || q.state === "EXPIRED") && !!q.pdfStorageKey,
              })
            }
          >
            Preview
          </Button>
          <Live>
            <Button
              kind="quiet"
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
              Send…
            </Button>
          </Live>
          <Button kind="quiet" compact icon="file" onClick={pdf}>
            PDF
          </Button>
          <Button kind="quiet" compact icon="info" aria-pressed={why} onClick={() => setWhy((v) => !v)}>
            {why ? "Hide the price's basis" : "Why this price"}
          </Button>
        </>
      }
    >
      <div className="meta">
        Generated {fmtStamp(q.createdAt, tz)} · <span className="money">{money(figure, q.currency)}</span> quoted
        {perNight != null ? ` · ${money(perNight, q.currency)} a night across the stay` : ""}
      </div>
      <div className="sm" style={{ marginTop: 8, display: "grid", gap: 3 }}>
        {q.validUntil ? (
          <span className={lapsed && q.state !== "ACCEPTED" ? "warn-ink" : undefined}>
            <Icon name="clock" /> {lapsed && q.state !== "ACCEPTED" ? "The price lapsed on" : "Price valid until"}{" "}
            <b>{fmtDateTime(q.validUntil, tz)}</b>
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
                  <span className="meta">an older quotation — the FOM records the approval here before it can be sent</span>
                )}
              </Live>
            ) : null}
          </span>
        ) : null}
      </div>

      {why ? (
        <Tool inert={false}>
          <PriceResolutionPanel terms={q.commercialTerms} currency={q.currency} />
        </Tool>
      ) : null}

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)", display: "grid", gap: 6 }}>
        <span className="meta">The guest&rsquo;s answer</span>
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
                    label="Record the answer…"
                    note="how they accepted and the words used — a verbal answer counts, once written down"
                    onClick={editable ? () => setAnswerOpen(true) : undefined}
                    reason={editable ? undefined : "not at this step"}
                  />
                  <SeeRow
                    label="No answer — the FOM decides…"
                    note="closes the reply window as the FOM's decision, with a reason"
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
          <span className="meta">Nothing to answer until it has gone out — sending is optional; the gate needs only the generated quotation.</span>
        ) : (
          <span className="meta">This version is {state.word}.</span>
        )}
      </div>

      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
      <ReasonDialog
        open={closeLoopOpen}
        onClose={() => setCloseLoopOpen(false)}
        busy={closeLoopM.isPending}
        title="Close the reply window"
        caseLines={[`${q.referenceNumber} · sent ${fmtStamp(q.sentAt, tz)}`]}
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
  const [why, setWhy] = useState<string | null>(null);
  return (
    <StepCard
      title="Every version of the quotation"
      meta={passes.many ? "Versions from an earlier pass are kept for the record — view only." : undefined}
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
            const st = QUOTE_STATE[q.state] ?? { word: words(q.state), tone: "default" as const };
            return (
              <Fragment key={q.id}>
                <tr className="static" style={current ? undefined : { opacity: 0.7 }}>
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
                      <Button kind="quiet" compact aria-pressed={why === q.id} onClick={() => setWhy((w) => (w === q.id ? null : q.id))}>
                        {why === q.id ? "Hide" : "Why this price"}
                      </Button>
                    </div>
                  </td>
                </tr>
                {why === q.id ? (
                  <tr className="static">
                    <td colSpan={passes.many ? 5 : 4}>
                      <Tool inert={false}>
                        <PriceResolutionPanel terms={q.commercialTerms} currency={q.currency} />
                      </Tool>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="meta" style={{ marginTop: 6 }}>
        The figures are each version&rsquo;s own stored total. A replaced version with a stored paper opens as it was sent.
      </p>
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </StepCard>
  );
}

/* ------------------------------------------------------------------ sending */

function SendDialog({
  entry,
  target,
  tz,
  onClose,
  onSent,
}: {
  entry: EntryDetail;
  target: QuotationSummary | null;
  tz: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const { session } = useSession();
  // Where the quote goes (2026-09-19): the invoices' rule — the agency or company that booked (the
  // quote carries their rates), else the guest — and the backend now sends to what is typed here.
  // The email box used to fall back to the guest's PHONE, and the toast then said "sent by email
  // to +975…" while nothing was emailed.
  const recipient = useInvoiceRecipient(entry);
  const phoneOnFile = (entry.guestProfile?.phone ?? entry.inquiry?.guestProfile?.phone ?? "").trim();
  const [channel, setChannel] = useState<Channel>("EMAIL");
  const [to, setTo] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!target || touched) return;
    setTo(channel === "EMAIL" ? recipient.defaultTo : phoneOnFile);
  }, [target, channel, touched, recipient.defaultTo, phoneOnFile]);
  const typed = to.trim();
  const emailish = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed);
  const send = useMutation({
    mutationFn: () =>
      sendQuotation(session!, target!.id, {
        channel,
        recipientAddress: typed,
        sentTo: typed,
      }),
    onSuccess: () => {
      toast.success(
        channel === "WHATSAPP"
          ? `${target?.referenceNumber} recorded as sent on WhatsApp to ${typed}`
          : typed
            ? `${target?.referenceNumber} sent by email to ${typed}`
            : `${target?.referenceNumber} recorded as sent — nothing was emailed (no address on file); hand it over or send it on WhatsApp`,
      );
      onSent();
    },
    onError: (e) => toastRefusal(e, "The quotation could not be sent"),
  });
  const hint =
    channel === "WHATSAPP"
      ? "send it on WhatsApp yourself — the desk records the send with this number"
      : !typed
        ? recipient.party
          ? `${recipient.party} has no email on file — type the address, or send it with none and hand the quote over`
          : "no email on file — type one, or send it with none and hand the quote over"
        : !emailish
          ? "that is not an email address"
          : recipient.party && typed === recipient.partyEmail
            ? `${recipient.party}'s email on file — the quote shows their rates`
            : recipient.guestEmail && typed === recipient.guestEmail
              ? recipient.party
                ? `this is the guest's email — the quote is made out to ${recipient.party} and shows its rates`
                : "the guest's email on file"
              : "the send is recorded on the booking with this address";
  if (!target) return null;
  const ok = channel === "WHATSAPP" ? typed.length > 0 : !typed || emailish;
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={send.isPending}
      title={`Send quotation ${target.referenceNumber}`}
      caseLines={[
        `Version ${target.versionNumber}`,
        target.validUntil ? `Price valid until ${fmtDateTime(target.validUntil, tz)} — sending does not restart the clock` : "No validity recorded",
      ]}
      footer={
        <>
          <Button kind="quiet" state={send.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            kind="secondary"
            icon="print"
            onClick={() => session && openQuotationPdf(session, target.id).catch((e) => toastRefusal(e, "The PDF could not be opened"))}
          >
            Print instead
          </Button>
          <Button
            icon="send"
            state={send.isPending ? "working" : ok ? "default" : "inert"}
            title={ok ? undefined : channel === "WHATSAPP" ? "put in the WhatsApp number" : "that is not an email address"}
            workingLabel="Sending…"
            onClick={() => send.mutate()}
          >
            Send now
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Send via</label>
        <Choice
          options={CHANNELS}
          value={channel}
          onChange={(c) => {
            setChannel(c);
            setTouched(false);
          }}
        />
      </div>
      <div className="field">
        <label>{channel === "EMAIL" ? "Email address" : "WhatsApp number"}</label>
        <input
          className="input"
          value={to}
          onChange={(e) => {
            setTouched(true);
            setTo(e.target.value);
          }}
          placeholder={channel === "EMAIL" ? "name@example.com" : "+975 …"}
          autoFocus
        />
        <span className="hint">{hint}</span>
      </div>
    </DsDialog>
  );
}
