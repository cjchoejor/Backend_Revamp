"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, Mail, RefreshCw, Route, Timer } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
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
import { RoomCompositionPlanner } from "./room-compositions-board";
import { CompetingClaimsBanner } from "./competing-claims";
import { QuotationPreview } from "./quotation-preview";
import { PriceResolutionPanel } from "./price-resolution";
import { money } from "@/lib/desk/workspace";
import { formatDMY } from "@/lib/desk/model";
import { openQuotationPdf } from "@/lib/api/documents";
import { PdfButton } from "./pdf-button";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail, QuotationState, QuotationSummary } from "@/types/api";
import { optionSelectedRoomIds, preferredHoldRoomId } from "@/types/api";

const BK = STAGE_ACTIONS.S2;

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}

// Operator language: a created quote IS the offer, ready to go — "Draft" undersold it
// (operator ruling 2026-08-01). The backend state stays DRAFT; only the label changed.
const STATE_TAG: Record<QuotationState, { label: string; cls: string }> = {
  DRAFT: { label: "Ready to send", cls: "" },
  SENT: { label: "Sent", cls: "warn" },
  ACCEPTED: { label: "Accepted", cls: "" },
  SUPERSEDED: { label: "Superseded", cls: "" },
  EXPIRED: { label: "Expired", cls: "stop" },
};

function isElevated(level?: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

export function QuoteStep({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const segment = entry.segments?.[0] ?? null;
  const segmentId = segment?.id;
  // Actions (draft/send/accept/supersede) bind to the CURRENT segment's quotes only.
  const quotations = useMemo(
    () => (entry.quotations ?? []).filter((q) => !segmentId || q.segmentId === segmentId),
    [entry.quotations, segmentId],
  );
  // The history shows EVERY segment's quotes (2026-08-01, operator request): after a re-entry
  // the prior segment's quotation must stay visible next to the new one, labeled by segment
  // number so old vs current is unambiguous. Prior-segment rows are read-only reference
  // (View / PDF only — the action blocks below never target them).
  const segNoById = useMemo(
    () => new Map((entry.segments ?? []).map((s) => [s.id, s.segmentNumber])),
    [entry.segments],
  );
  const multiSegment = useMemo(
    () => new Set((entry.quotations ?? []).map((q) => q.segmentId)).size > 1,
    [entry.quotations],
  );
  const allQuotations = useMemo(() => {
    // Current segment first, then older segments; newest version first within each.
    return [...(entry.quotations ?? [])].sort((a, b) => {
      const sa = segNoById.get(a.segmentId) ?? 0;
      const sb = segNoById.get(b.segmentId) ?? 0;
      if (sa !== sb) return sb - sa;
      return (b.versionNumber ?? 0) - (a.versionNumber ?? 0);
    });
  }, [entry.quotations, segNoById]);

  const draft = quotations.find((q) => q.state === "DRAFT");
  const sent = quotations.find((q) => q.state === "SENT");
  const accepted = quotations.find((q) => q.state === "ACCEPTED");
  const working = draft ?? sent;

  const sealedPreferred = (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected);
  // The booking's anchor room — claimed on every night when one is (2026-08-06; [0] used to
  // pick whichever room the first night listed first, often the single-night, most-contested
  // room of a per-night seal, and the hold then failed against its other-night holder).
  const preferredRoomId = preferredHoldRoomId(sealedPreferred?.optionSelected ?? null);
  const holds = (entry.speculativeHolds ?? []).filter((h) => !segmentId || h.segmentId === segmentId);
  const activeHold = holds.find((h) => h.state === "PLACED" || h.state === "UPGRADED");

  /**
   * Once the CURRENT segment carries a live proforma (minted at S3 setup), the quote is FINAL
   * (2026-08-06, operator ruling) — the proforma bills its terms, so the backend refuses
   * supersede/discount from that point and the desk closes the negotiation table. Same
   * time-windowed segment attribution the setup step uses (invoices carry no segmentId).
   */
  const proformaLocked = useMemo(() => {
    const segStart = segment?.startedAt ? new Date(segment.startedAt).getTime() : null;
    return (entry.folio?.invoices ?? []).some(
      (inv) =>
        inv.invoiceType === "PROFORMA" &&
        inv.state !== "SUPERSEDED" &&
        !inv.supersededById &&
        (segStart == null || new Date(inv.createdAt).getTime() >= segStart),
    );
  }, [entry.folio?.invoices, segment?.startedAt]);

  const [notes, setNotes] = useState("");
  // Booking-wide discount. Edited inside the composition panel (2026-08-03, operator request):
  // the negotiation happens on the grid, so the figure lives there rather than in a separate
  // form block below. One booking-level figure, given as a PERCENT or a flat AMOUNT
  // (2026-08-06) — `discountUnit` says which; the backend takes either off the grand total.
  const [discountValue, setDiscountValue] = useState("");
  const [discountUnit, setDiscountUnit] = useState<"percent" | "amount">("percent");
  const [discountBasis, setDiscountBasis] = useState("negotiation");
  // What the live quote actually recorded — drives the FOM approval affordance and seeds the
  // fields, so the panel opens showing the discount currently in force rather than blank
  // (a blank field on regenerate would read as "no discount" when the backend would in fact
  // carry the prior one forward).
  const recordedDiscount = useMemo(() => {
    const terms = (working ?? accepted)?.commercialTerms as Record<string, unknown> | null | undefined;
    const d = terms?.requestedDiscount as
      | { discountPercent?: unknown; discountAmount?: unknown; discountBasis?: unknown }
      | undefined;
    if (!d) return null;
    const basis = typeof d.discountBasis === "string" && d.discountBasis.trim() ? d.discountBasis : "negotiation";
    if (typeof d.discountPercent === "number" && d.discountPercent > 0) {
      return { unit: "percent" as const, value: d.discountPercent, basis };
    }
    if (typeof d.discountAmount === "number" && d.discountAmount > 0) {
      return { unit: "amount" as const, value: d.discountAmount, basis };
    }
    return null;
  }, [working, accepted]);
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    const id = (working ?? accepted)?.id ?? null;
    if (seededForRef.current === id) return;
    seededForRef.current = id;
    if (recordedDiscount) {
      setDiscountValue(String(recordedDiscount.value));
      setDiscountUnit(recordedDiscount.unit);
      setDiscountBasis(recordedDiscount.basis);
    }
  }, [working, accepted, recordedDiscount]);
  const [sendChannel, setSendChannel] = useState("EMAIL");
  // Validity window, chosen at GENERATE time (2026-08-06, operator request) — the created quote
  // carries it and its W15 countdown from the moment it exists; sending doesn't restart it.
  const [validDays, setValidDays] = useState("2");
  /**
   * The largest validity the backend will take: 30 days hard cap, and the window must end
   * before check-in. Calendar-day arithmetic only (no money); the backend re-validates.
   */
  const maxValidDays = useMemo(() => {
    const iso = entry.checkInDate?.slice(0, 10);
    const ci = iso ? new Date(`${iso}T00:00:00.000Z`) : null;
    if (!ci || Number.isNaN(ci.getTime())) return 30;
    const t = new Date();
    const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
    const diff = Math.floor((ci.getTime() - today) / 86400_000);
    // Check-in today / past / within a day: the backend clamps to check-in itself — offer 1.
    return Math.max(1, Math.min(30, diff));
  }, [entry.checkInDate]);
  const validDaysNumber = (() => {
    const n = Number(validDays);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, maxValidDays) : null;
  })();
  // The default ("2") can exceed the cap on a near-arrival booking — sync the DISPLAYED value
  // to the clamp so the field never shows a figure the payload wouldn't send.
  useEffect(() => {
    const n = Number(validDays);
    if (Number.isFinite(n) && n > maxValidDays) setValidDays(String(maxValidDays));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxValidDays]);
  const validityEndLabel = useMemo(() => {
    if (validDaysNumber == null) return null;
    return formatDMY(new Date(Date.now() + validDaysNumber * 86400_000).toISOString().slice(0, 10));
  }, [validDaysNumber]);
  // Guest contact for the send-to field. Falls back across the same profile chain the rest of the
  // workspace uses, preferring email. Resolved every render so it survives the entry being briefly
  // replaced by a lighter object (e.g. progressStage's setQueryData) before the refetch restores it.
  const guestContact = entry.guestProfile?.email ?? entry.inquiry?.guestProfile?.email ?? entry.guestProfile?.phone ?? entry.inquiry?.guestProfile?.phone ?? "";
  const [recipient, setRecipient] = useState(guestContact);
  // Auto-pull the guest contact once it's available — a plain useState initializer only reads at
  // mount and could capture an empty value if the profile hadn't loaded yet. Only fills when the
  // field is still empty, so an operator's manual edit is never overwritten.
  useEffect(() => {
    if (guestContact) setRecipient((prev) => prev || guestContact);
  }, [guestContact]);
  const [acceptMethod, setAcceptMethod] = useState<"VERBAL" | "WRITTEN">("VERBAL");
  const [verbatim, setVerbatim] = useState("");
  const [holdBasis, setHoldBasis] = useState("");
  // Hold TTL as three inputs (days / hours / minutes). Default 15 minutes = 0d 0h 15m.
  // Backend API still takes `ttlSeconds`; we derive it at submit time. Strings so operator can
  // type "0.5" or backspace-to-empty without React fighting them.
  const [holdDays, setHoldDays] = useState("0");
  const [holdHours, setHoldHours] = useState("0");
  const [holdMinutes, setHoldMinutes] = useState("15");
  const holdTtlSeconds =
    Math.max(0, Math.floor(Number(holdDays) || 0)) * 86_400
    + Math.max(0, Math.floor(Number(holdHours) || 0)) * 3_600
    + Math.max(0, Math.floor(Number(holdMinutes) || 0)) * 60;
  const [releaseReason, setReleaseReason] = useState("");
  // Which quotation's inline document preview is open in the history block (one at a time).
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Which quote's "How this price was resolved" panel is open (one at a time, like previews).
  const [resolutionId, setResolutionId] = useState<string | null>(null);
  // Per-room composition (Phase E of per-room track, 2026-07-27). Managed by the
  // `RoomCompositionsEditor` child; parent just holds the current array and forwards it
  // in the createQuotation body.
  const [roomCompositions, setRoomCompositions] = useState<RoomCompositionInput[]>([]);
  // Memoised — a fresh array identity every render re-fired the composition editor's
  // sealedRoomIds-keyed effects in a render loop (max update depth). The underlying
  // optionSelected object is stable between refetches, so keying on it is safe.
  const sealedRoomIds = useMemo(
    () => optionSelectedRoomIds(sealedPreferred?.optionSelected),
    [sealedPreferred?.optionSelected],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
    // The inline document preview recomposes from the quotation's current terms — a discount,
    // supersede or send changes what it should show.
    void queryClient.invalidateQueries({ queryKey: ["quotation-preview"] });
    // Sending a quote creates a CommunicationRecord, and superseding cancels its reply window.
    // That feed is its own query key (shared with CommunicationAcceptanceBlock + the workspace
    // checklist) and isn't part of the entry payload — same omission that hid the S3 proforma
    // reply block until a page refresh.
    void queryClient.invalidateQueries({ queryKey: ["entry-communications", entry.id] });
  };
  /**
   * The discount as the API wants it — `{discountPercent}` or `{discountAmount}` per the unit
   * switch, never both. A blank or zero field is NOT the same as "no change": `supersede`
   * carries the prior version's discount forward when the field is omitted, so clearing one has
   * to be sent as an explicit `null`. Only a positive figure is sent as a request — a zero
   * "discount" would otherwise be recorded on the quote and pend FOM approval for nothing.
   */
  const discountPayload = (() => {
    const n = Number(discountValue);
    if (!discountValue.trim() || !Number.isFinite(n) || n <= 0) return null;
    const basis = discountBasis.trim() || "negotiation";
    return discountUnit === "amount"
      ? { discountAmount: n, discountBasis: basis }
      : { discountPercent: n, discountBasis: basis };
  })();

  const wrap = <T,>(fn: () => Promise<T>, msg: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(msg);
      void invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });

  const createM = useMutation(
    wrap(
      () =>
        createQuotation(session!, entry.id, {
          notes: notes.trim() || undefined,
          validDays: validDaysNumber ?? undefined,
          requestedDiscount: discountPayload ?? undefined,
          // Per-room compositions carry the meal plans / extra beds / negotiated rates.
          // The planner always emits one row per sealed room, so the backend's legacy
          // booking-wide mealPlan/extraBedCount fallback is never needed from the desk
          // (its UI was removed 2026-08-01; the API fields remain for other frontends).
          roomCompositions: roomCompositions.length > 0 ? roomCompositions : undefined,
        }),
      "Quote created — ready to send",
    ),
  );
  const approveM = useMutation(
    wrap(() => {
      if (!draft) throw new Error("No quote to adjust");
      return approveQuotationDiscount(session!, draft.id);
    }, "Discount approved"),
  );
  const sendM = useMutation(
    wrap(() => {
      if (!draft) throw new Error("No quote to send");
      // No validDays: the window was set at generation and sending must not restart it.
      return sendQuotation(session!, draft.id, {
        channel: sendChannel,
        recipientAddress: recipient.trim(),
        sentTo: recipient.trim(),
      });
    }, "Quote sent to guest"),
  );
  const acceptM = useMutation(
    wrap(() => {
      if (!sent) throw new Error("No sent quote");
      return acceptQuotation(session!, sent.id, {
        acceptanceMethod: acceptMethod,
        verbatimNote: acceptMethod === "VERBAL" ? verbatim.trim() : undefined,
      });
    }, "Acceptance recorded"),
  );
  const supersedeM = useMutation(
    wrap(() => {
      const id = working?.id ?? sent?.id;
      if (!id) throw new Error("No quote to supersede");
      return supersedeQuotation(session!, id, {
        notes: notes.trim() || undefined,
        // A new round is a new offer — its validity re-anchors to now with the input's value.
        validDays: validDaysNumber ?? undefined,
        // The renegotiated discount, re-priced into the new version. `null` when the operator
        // cleared it — omitting the field would carry the prior version's discount forward,
        // so a cleared discount would silently survive the regeneration.
        requestedDiscount: discountPayload ?? (recordedDiscount ? null : undefined),
        // Renegotiated per-room composition (meal plans, extra beds, negotiated rates, FOC).
        // When the operator edited the composition editor, the regenerated draft re-prices
        // with it; when untouched (empty), the backend carries the prior version's forward.
        roomCompositions: roomCompositions.length > 0 ? roomCompositions : undefined,
      });
    }, "New negotiation round opened"),
  );
  // Resolve the acknowledgement open-loop on a sent quote (guest didn't respond in-window) by
  // recording a custodian decision — FOM+. Without this the open loop has no desk remedy.
  const resolveAckM = useMutation(
    wrap(() => {
      if (!sent) throw new Error("No sent quote");
      return resolveQuotationAckOpenLoop(session!, sent.id, {
        resolutionType: "CUSTODIAN_DECISION",
        decisionReason: verbatim.trim() || "Resolved at desk",
      });
    }, "Acknowledgement loop resolved"),
  );
  const holdM = useMutation(
    wrap(() => {
      if (!preferredRoomId) throw new Error("No preferred room from Inquiry");
      if (!holdBasis.trim()) throw new Error("A reason for the hold is required");
      if (holdTtlSeconds <= 0) throw new Error("Hold duration must be at least one minute");
      return placeSpeculativeHold(session!, entry.id, {
        roomId: preferredRoomId,
        ttlSeconds: holdTtlSeconds,
        commercialBasis: holdBasis.trim(),
      });
    }, "Hold placed"),
  );
  const releaseM = useMutation(
    wrap(() => {
      if (!activeHold) throw new Error("No active hold");
      if (!releaseReason.trim()) throw new Error("A release reason is required");
      return releaseSpeculativeHold(session!, entry.id, activeHold.id, { releaseReason: releaseReason.trim() });
    }, "Hold released"),
  );

  const elevated = isElevated(session?.actorLevel);

  // Persistent highlight: a group stays lit once its action has run for this booking (derived
  // from real quote/hold state, so it survives reloads). `firingKey` adds the "running now" pulse.
  const hasDiscount = quotations.some((q) => {
    const t = q.commercialTerms as Record<string, unknown> | null | undefined;
    if (!t) return false;
    // The pricing pipeline writes `requestedDiscount.discountPercent` OR `.discountAmount`
    // (one of the two — 2026-08-06) and, once folded in, `discountAppliedPercent`. The names
    // read here before (`discountPercent` / `appliedDiscountPercent` / `discount.discountPercent`)
    // never existed on the payload, so the rail's discount group never lit up.
    const req = t.requestedDiscount as { discountPercent?: unknown; discountAmount?: unknown } | undefined;
    const d = req?.discountPercent ?? req?.discountAmount ?? t.discountAppliedPercent;
    return typeof d === "number" && d > 0;
  });
  const sendUsed = quotations.some((q) => q.sentAt != null || q.state === "SENT" || q.state === "ACCEPTED");
  const activeKeys = [
    quotations.length > 0 ? "build" : null,
    hasDiscount ? "discount" : null,
    sendUsed ? "send" : null,
    accepted ? "accept" : null,
    holds.length > 0 ? "hold" : null,
    entry.currentStage !== "S2" ? "advance" : null,
  ].filter(Boolean) as string[];
  const firingKey = createM.isPending
    ? "build"
    : approveM.isPending
      ? "discount"
      : sendM.isPending
        ? "send"
        : acceptM.isPending || supersedeM.isPending
          ? "accept"
          : holdM.isPending || releaseM.isPending
            ? "hold"
            : null;
  const railGroups: RailGroup[] = [
    { key: "build", label: "On creating the quote", items: BK.build },
    { key: "discount", label: "On applying a discount", items: BK.discount },
    { key: "send", label: "On sending the quote", items: BK.send },
    { key: "accept", label: "On recording acceptance", items: BK.accept },
    { key: "hold", label: "On holding a room", items: BK.hold },
    { key: "advance", label: "On advancing to Set up", items: BK.advance },
  ];

  /**
   * The negotiation panel — rooms, meals, extra beds, negotiated rates, FOC and the booking
   * discount, all in one surface. It stays OPEN once a quote exists (2026-08-03, operator
   * request): a quote is a round of a negotiation, not a closed door, so the operator edits
   * here and regenerates rather than being sent back through a collapsed drawer.
   *
   * It holds ONE position on the page whether or not a quote exists — only the button changes
   * ("Create quote" → "Regenerate quote"). An earlier version moved it below the send block
   * once a quote existed, which read as the table vanishing the instant you generated. It
   * closes only on acceptance, where the terms bind and the backend refuses to supersede.
   *
   * That position is FIRST, ahead of the quote history and the send / answer blocks, so that
   * everything a generate produces lands below the button that produced it rather than above
   * the table the operator is standing in.
   */
  const negotiationPanel = accepted ? null : proformaLocked ? (
    // The proforma (Set up) is billing this quote's terms — in-place renegotiation is over, and
    // the backend refuses supersede/discount with QUOTATION_LOCKED_BY_PROFORMA. Say where the
    // path continues rather than showing a table whose button can only fail.
    <div className="block">
      <BlockH>Negotiation closed — proforma issued</BlockH>
      <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.6 }}>
        A proforma invoice has been generated on <b>Set up</b>, so the quote&rsquo;s terms are what the guest
        is being billed — they are final from that point. To change the price, use <b>Re-enter → Quote</b>{" "}
        (a new segment with a fresh quote and a fresh proforma). Changing only the advance requirement
        re-issues the proforma at the same terms from Set up.
      </p>
    </div>
  ) : (
    <div className="block">
      <BlockH>{working ? "Negotiate & regenerate" : "Build the quote"}</BlockH>
      {!sealedPreferred && (
        <p style={{ fontSize: 12, color: "var(--warn)", marginTop: 0 }}>
          A sealed availability configuration from Inquiry is needed first.
        </p>
      )}
      {/* The live-quote fact reads as one strip, not a paragraph — the panel below is the work
          surface and should start as close to the header as possible. */}
      {working && (
        <div
          className="fact b-transit"
          style={{ padding: "7px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between", marginBottom: 10 }}
        >
          <span>
            <b>{working.referenceNumber}</b> · live at <b>{money(working.totalAmount, working.currency)}</b>
          </span>
          <span style={{ color: "var(--ink-3)", fontSize: 11.5 }}>
            edit below &amp; regenerate — this version is kept as history
          </span>
        </div>
      )}
      <RoomCompositionPlanner
        sealedRoomIds={sealedRoomIds}
        entryCheckIn={entry.checkInDate ?? null}
        entryCheckOut={entry.checkOutDate ?? null}
        entryAdults={entry.adultCount ?? entry.guestCount ?? null}
        entryChildAges={entry.childAges ?? null}
        persistKey={entry.id}
        entryId={entry.id}
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
      {/* The footer is the commit block, two rows (2026-08-06, operator request): the note on
          its own full-width row, then the validity window + the button that consumes them both. */}
      <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
        <label>Internal note (optional — not shown to the guest)</label>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. matched last year's corporate rate" />
      </div>
      <div style={{ display: "flex", gap: 11, alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
        <div className="field" style={{ marginBottom: 0, width: 118 }}>
          <label title="How long the offer stands, counting from the moment it is generated — max 30 days, and it must end before check-in">
            Valid for (days)
          </label>
          <input
            type="number"
            min={1}
            max={maxValidDays}
            value={validDays}
            onChange={(e) => {
              const v = e.target.value;
              // Clamp to the check-in/30-day ceiling as it's typed — the backend re-validates.
              const n = Number(v);
              setValidDays(v !== "" && Number.isFinite(n) && n > maxValidDays ? String(maxValidDays) : v);
            }}
          />
        </div>
        {working ? (
          <button className="btn btn-primary" disabled={supersedeM.isPending} onClick={() => supersedeM.mutate()}>
            <RefreshCw style={{ width: 14, height: 14 }} />
            {supersedeM.isPending ? "Regenerating…" : sent ? "Regenerate quote (new round)" : "Regenerate quote"}
          </button>
        ) : (
          <button className="btn btn-primary" disabled={createM.isPending || !sealedPreferred} onClick={() => createM.mutate()}>
            {createM.isPending ? "Creating…" : "Create quote"}
          </button>
        )}
      </div>
      <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "6px 0 0", lineHeight: 1.5 }}>
        {validDaysNumber != null && validityEndLabel ? (
          <>
            The offer stands until <b>{validityEndLabel}</b> — the countdown starts the moment the quote is
            generated and shows under <b>Timers</b> in the live-activity rail.
          </>
        ) : (
          <>Validity must be 1–{maxValidDays} days.</>
        )}{" "}
        {maxValidDays < 30 && <>Capped at {maxValidDays} day{maxValidDays === 1 ? "" : "s"} — it must end before check-in.</>}
      </p>
    </div>
  );

  return (
    <div className="bx-split">
      <div className="bx-main">
      <div className="speak">
        <div className="now">Do this next</div>
        <h2>Shape the price and send the quote.</h2>
        <p>
          The figure is still a range — nothing here binds the guest yet. Build the quote, adjust within your
          margin, send it, and record the guest&rsquo;s answer.
        </p>
      </div>

      {/* Race telltale (2026-08-06): another live booking quoting/billing the same rooms for the
          same nights — seen HERE, before Set up, so the slower booking doesn't take money first
          and lose the room at the committed hold. */}
      <CompetingClaimsBanner entryId={entry.id} />

      {/* The negotiation panel leads the step, and everything the quote produces sits BELOW it
          (2026-08-04, operator report). Quote history used to come first, so generating a quote
          from the button at the panel's foot put the result off-screen ABOVE the whole
          composition table — the operator had to scroll back up past it to see what they had
          just made. Panel first means the new quote appears directly under the button that
          created it. */}
      {negotiationPanel}

      {allQuotations.length > 0 && (
        <div className="block">
          <BlockH>Quote history</BlockH>
          {multiSegment && (
            <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 4px" }}>
              This booking has been re-worked — quotes from earlier segments stay here for reference
              (view only); the current segment&rsquo;s quote is the live one.
            </p>
          )}
          {allQuotations.map((q) => (
            <div key={q.id}>
              <QuoteRow
                q={q}
                segmentNumber={segNoById.get(q.segmentId) ?? null}
                isCurrentSegment={!segmentId || q.segmentId === segmentId}
                showSegment={multiSegment}
                previewOpen={previewId === q.id}
                onTogglePreview={() => setPreviewId((cur) => (cur === q.id ? null : q.id))}
                resolutionOpen={resolutionId === q.id}
                onToggleResolution={() => setResolutionId((cur) => (cur === q.id ? null : q.id))}
              />
              {/* Display-only rendering of the pricing pipeline's stored trail — each version's
                  commercialTerms are immutable, so this is exactly how THAT version priced. */}
              {resolutionId === q.id && <PriceResolutionPanel terms={q.commercialTerms} currency={q.currency} />}
              {/* Old rows that have a stored PDF show the FROZEN artifact (what was actually
                  sent); other rows recompose — safe here even for old versions, because each
                  quotation row's commercialTerms are immutable per version. */}
              {previewId === q.id && (
                <QuotationPreview
                  quotationId={q.id}
                  frozenPdf={(q.state === "SUPERSEDED" || q.state === "EXPIRED") && !!q.pdfStorageKey}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="block">
          <BlockH>Adjust &amp; send · {draft.referenceNumber}</BlockH>
          <div className="field">
            <label>Indicative total (per night)</label>
            <div className="val derived">{money(draft.totalAmount, draft.currency)}</div>
          </div>
          {(() => {
            const t = draft.commercialTerms as Record<string, unknown> | null | undefined;
            const room = typeof t?.roomRate === "number" ? t.roomRate : null;
            const meal = typeof t?.mealTotal === "number" ? t.mealTotal : 0;
            const bed = typeof t?.extraBedTotal === "number" ? t.extraBedTotal : 0;
            const plan = typeof t?.mealPlan === "string" ? t.mealPlan : null;
            if (room == null || (meal === 0 && bed === 0 && !plan)) return null;
            return (
              <div style={{ fontSize: 12, color: "var(--ink-3)", margin: "-2px 0 9px", lineHeight: 1.7 }}>
                <div>Room: {money(room, draft.currency)}</div>
                {plan && (
                  <div>
                    Meals ({plan}): {meal > 0 ? money(meal, draft.currency) : "label only — no rate card"}
                  </div>
                )}
                {bed > 0 && <div>Extra beds: {money(bed, draft.currency)}</div>}
              </div>
            );
          })()}
          {/* The discount figure itself is edited in the negotiation panel above. What stays
              here is the governance step: create/regenerate records the request and defers the
              actor-ceiling check to this approval (the backend skips the ceiling on those
              paths on purpose). */}
          {recordedDiscount && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 13 }}>
              <span className="tag">
                {recordedDiscount.unit === "percent"
                  ? `${recordedDiscount.value}% off`
                  : `Nu ${recordedDiscount.value.toLocaleString()} off`}{" "}
                · {recordedDiscount.basis}
              </span>
              {elevated ? (
                <button className="btn btn-ghost btn-sm" disabled={approveM.isPending || approveM.isSuccess} onClick={() => approveM.mutate()}>
                  {approveM.isPending ? "Approving…" : approveM.isSuccess ? "✓ Discount approved" : "Approve discount (FOM)"}
                </button>
              ) : (
                <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>An FOM approves the discount.</span>
              )}
            </div>
          )}
          <div style={{ height: 10 }} />
          <div className="frow">
            <div className="field">
              <label>Send via</label>
              <select value={sendChannel} onChange={(e) => setSendChannel(e.target.value)}>
                <option value="EMAIL">Email</option>
                <option value="WHATSAPP">WhatsApp</option>
              </select>
            </div>
            {/* Read-only: validity was chosen at generation (footer of the panel above) and
                sending does not restart the clock. */}
            <div className="field">
              <label title="Set when the quote was generated — regenerate to change it">Valid until</label>
              <div className="val derived">
                {draft.validUntil ? formatDMY(draft.validUntil.slice(0, 10)) || draft.validUntil.slice(0, 10) : "—"}
              </div>
            </div>
          </div>
          <div className="field">
            <label>Recipient</label>
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="email or phone" />
          </div>
          <button className="btn btn-primary" disabled={sendM.isPending || !recipient.trim()} onClick={() => sendM.mutate()}>
            <Mail style={{ width: 14, height: 14 }} />
            {sendM.isPending ? "Sending…" : "Send quote to guest"}
          </button>
        </div>
      )}

      {sent && !accepted && (
        <div className="block">
          <BlockH>Record the guest&rsquo;s answer · {sent.referenceNumber}</BlockH>
          <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
            Sent {sent.sentAt?.slice(0, 16) ?? "—"} · valid until {sent.validUntil?.slice(0, 16) ?? "—"}
          </p>
          <div className="field">
            <label>How did they accept?</label>
            <select value={acceptMethod} onChange={(e) => setAcceptMethod(e.target.value as "VERBAL" | "WRITTEN")}>
              <option value="VERBAL">Verbal (staff records)</option>
              <option value="WRITTEN">Written</option>
            </select>
          </div>
          {acceptMethod === "VERBAL" && (
            <div className="field">
              <label>Verbatim note</label>
              <input value={verbatim} onChange={(e) => setVerbatim(e.target.value)} placeholder="What the guest said" />
            </div>
          )}
          {/* Renegotiation now happens in the panel above, which stays open for exactly this
              case: the guest came back wanting changes, so the operator edits the rooms /
              meals / rates / discount there and hits "Regenerate quote (new round)". */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={acceptM.isPending} onClick={() => acceptM.mutate()}>
              {acceptM.isPending ? "Recording…" : "Record acceptance"}
            </button>
            {isElevated(session?.actorLevel) && (
              <button className="btn btn-ghost" disabled={resolveAckM.isPending} onClick={() => resolveAckM.mutate()}>
                Resolve ack loop (FOM)
              </button>
            )}
          </div>
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "7px 0 0" }}>
            No response in-window? An FOM can resolve the acknowledgement open loop as a custodian decision
            (uses the note above as the reason).
          </p>
        </div>
      )}

      {accepted && (
        <>
          <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 13 }}>
            <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
            Accepted · {accepted.referenceNumber} · {money(accepted.totalAmount, accepted.currency)}
          </div>
          {/* Says WHERE the negotiation panel went — it is hidden here on purpose, and the
              backend refuses to supersede an ACCEPTED quotation, so "just regenerate" is not
              an option to offer. */}
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "7px 0 0", lineHeight: 1.5 }}>
            These are the terms the guest agreed to, so the negotiation table is closed. To change
            anything now, re-enter this booking to Quote from Set up — that opens a new segment
            with a fresh quote.
          </p>
        </>
      )}

      <div className="block" style={{ marginTop: 14 }}>
        <BlockH>
          <Timer style={{ width: 13, height: 13 }} />
          Hold the rooms while negotiating (optional)
        </BlockH>
        {activeHold ? (
          <>
            <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12.5, marginBottom: 9 }}>
              {(() => {
                // The hold's real coverage (2026-08-06): every room in the per-night snapshot,
                // anchor included — a pre-snapshot hold covers its anchor room only.
                const covered = new Set<string>(activeHold.roomId ? [activeHold.roomId] : []);
                for (const n of activeHold.perNightBreakdown ?? []) for (const r of n.roomIds) covered.add(r.roomId);
                const anchor = activeHold.room?.roomNumber ?? activeHold.roomId?.slice(0, 8) ?? "—";
                return covered.size > 1
                  ? `Hold on ${covered.size} rooms (all selected · anchor ${anchor})`
                  : `Hold on room ${anchor}`;
              })()}{" "}
              · expires {activeHold.expiresAt.slice(0, 16)}
            </div>
            {elevated && (
              <div className="frow">
                <div className="field">
                  <label>Release reason</label>
                  <input value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} />
                </div>
                <div className="field" style={{ alignSelf: "end" }}>
                  <button className="btn btn-ghost" disabled={releaseM.isPending || !releaseReason.trim()} onClick={() => releaseM.mutate()}>
                    Release hold (FOM)
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="field">
              <label>Why hold {sealedRoomIds.length > 1 ? "these rooms" : "this room"}?</label>
              <input value={holdBasis} onChange={(e) => setHoldBasis(e.target.value)} placeholder="Commercial basis" />
            </div>
            <div className="field">
              <label>Hold for</label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <div>
                  <input
                    type="number"
                    min={0}
                    value={holdDays}
                    onChange={(e) => setHoldDays(e.target.value)}
                    aria-label="Days"
                  />
                  <div style={{ fontSize: 10.5, color: "var(--ink-3, #7a6a52)", textAlign: "center", marginTop: 2 }}>days</div>
                </div>
                <div>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={holdHours}
                    onChange={(e) => setHoldHours(e.target.value)}
                    aria-label="Hours"
                  />
                  <div style={{ fontSize: 10.5, color: "var(--ink-3, #7a6a52)", textAlign: "center", marginTop: 2 }}>hours</div>
                </div>
                <div>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={holdMinutes}
                    onChange={(e) => setHoldMinutes(e.target.value)}
                    aria-label="Minutes"
                  />
                  <div style={{ fontSize: 10.5, color: "var(--ink-3, #7a6a52)", textAlign: "center", marginTop: 2 }}>minutes</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-3, #7a6a52)", marginTop: 6 }}>
                {holdTtlSeconds > 0
                  ? `= ${holdTtlSeconds.toLocaleString()} seconds total`
                  : "Set at least one minute."}
              </div>
            </div>
            <button
              className="btn btn-ghost"
              disabled={holdM.isPending || !preferredRoomId || !holdBasis.trim() || holdTtlSeconds <= 0}
              onClick={() => holdM.mutate()}
            >
              {holdM.isPending
                ? "Placing…"
                : sealedRoomIds.length > 1
                  ? `Place hold on all ${sealedRoomIds.length} selected rooms`
                  : "Place hold on preferred room"}
            </button>
          </>
        )}
      </div>
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={activeKeys} firingKey={firingKey} />
    </div>
  );
}

function QuoteRow({
  q,
  segmentNumber,
  isCurrentSegment,
  showSegment,
  previewOpen,
  onTogglePreview,
  resolutionOpen,
  onToggleResolution,
}: {
  q: QuotationSummary;
  segmentNumber: number | null;
  isCurrentSegment: boolean;
  showSegment: boolean;
  previewOpen: boolean;
  onTogglePreview: () => void;
  resolutionOpen: boolean;
  onToggleResolution: () => void;
}) {
  const tag = STATE_TAG[q.state];
  const { session } = useSession();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "8px 0",
        borderBottom: "1px dashed var(--line)",
        fontSize: 13,
        opacity: isCurrentSegment ? 1 : 0.75,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b>{q.referenceNumber}</b>
        {showSegment && (
          <span
            className="tag"
            style={
              isCurrentSegment
                ? { borderColor: "var(--green-t2)", background: "var(--green-t)", color: "var(--green-d)" }
                : undefined
            }
            title={
              isCurrentSegment
                ? "From the segment you are working now"
                : "From an earlier pass of this booking — kept for reference, view only"
            }
          >
            {segmentNumber != null ? `Segment ${segmentNumber}` : "Earlier segment"}
            {isCurrentSegment ? " · current" : ""}
          </span>
        )}
        <span className={`tag ${tag.cls}`}>{tag.label}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="mono">{money(q.totalAmount, q.currency)}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onToggleResolution}
          title="How this price was resolved — the pricing pipeline's recorded trail for this version"
        >
          <Route style={{ width: 14, height: 14 }} />
          {resolutionOpen ? "Hide price" : "Why this price"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onTogglePreview}
          title="Show the quotation document right here — no PDF needed"
        >
          {previewOpen ? <EyeOff style={{ width: 14, height: 14 }} /> : <Eye style={{ width: 14, height: 14 }} />}
          {previewOpen ? "Hide" : "View"}
        </button>
        {session && <PdfButton label="PDF" open={() => openQuotationPdf(session, q.id)} />}
      </span>
    </div>
  );
}
