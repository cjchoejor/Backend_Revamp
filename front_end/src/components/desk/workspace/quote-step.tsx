"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, Mail, Percent, Route, Timer } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  acceptQuotation,
  applyQuotationDiscount,
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
import { QuotationPreview } from "./quotation-preview";
import { PriceResolutionPanel } from "./price-resolution";
import { money } from "@/lib/desk/workspace";
import { openQuotationPdf } from "@/lib/api/documents";
import { PdfButton } from "./pdf-button";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail, QuotationState, QuotationSummary } from "@/types/api";
import { optionSelectedRoomIds } from "@/types/api";

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
  const preferredRoomId = optionSelectedRoomIds(sealedPreferred?.optionSelected)[0] ?? null;
  const holds = (entry.speculativeHolds ?? []).filter((h) => !segmentId || h.segmentId === segmentId);
  const activeHold = holds.find((h) => h.state === "PLACED" || h.state === "UPGRADED");

  const [notes, setNotes] = useState("");
  const [discountPercent, setDiscountPercent] = useState("");
  const [discountBasis, setDiscountBasis] = useState("negotiation");
  const [sendChannel, setSendChannel] = useState("EMAIL");
  const [validDays, setValidDays] = useState("2");
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
  };
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
          requestedDiscount:
            discountPercent.trim() !== ""
              ? { discountPercent: Number(discountPercent), discountBasis: discountBasis.trim() || "negotiation" }
              : undefined,
          // Per-room compositions carry the meal plans / extra beds / negotiated rates.
          // The planner always emits one row per sealed room, so the backend's legacy
          // booking-wide mealPlan/extraBedCount fallback is never needed from the desk
          // (its UI was removed 2026-08-01; the API fields remain for other frontends).
          roomCompositions: roomCompositions.length > 0 ? roomCompositions : undefined,
        }),
      "Quote created — ready to send",
    ),
  );
  const discountM = useMutation(
    wrap(() => {
      if (!draft) throw new Error("No quote to adjust");
      return applyQuotationDiscount(session!, draft.id, {
        discountPercent: Number(discountPercent),
        discountBasis: discountBasis.trim() || "negotiation",
      });
    }, "Discount applied"),
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
      return sendQuotation(session!, draft.id, {
        validDays: Number(validDays) || 2,
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
        // Carry the renegotiated discount into the new version so the superseding round
        // re-prices with it (matches the OLD S2 supersede behaviour).
        requestedDiscount:
          discountPercent.trim() !== ""
            ? { discountPercent: Number(discountPercent), discountBasis: discountBasis.trim() || "negotiation" }
            : undefined,
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
    const d = t.discountPercent ?? t.appliedDiscountPercent ?? (t.discount as { discountPercent?: unknown } | undefined)?.discountPercent;
    return typeof d === "number" ? d > 0 : d != null;
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
    : discountM.isPending || approveM.isPending
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

      {!working && !accepted && (
        <div className="block">
          <BlockH>Build the quote</BlockH>
          {!sealedPreferred && (
            <p style={{ fontSize: 12, color: "var(--warn)", marginTop: 0 }}>
              A sealed availability configuration from Inquiry is needed first.
            </p>
          )}
          <div className="field">
            <label>Internal notes (optional)</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Not shown to the guest" />
          </div>
          <div className="frow">
            <div className="field">
              <label>Discount % (optional)</label>
              <input type="number" min={0} max={100} value={discountPercent} onChange={(e) => setDiscountPercent(e.target.value)} />
            </div>
            <div className="field">
              <label>Discount basis</label>
              <input value={discountBasis} onChange={(e) => setDiscountBasis(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3, #7a6a52)", marginBottom: 6 }}>
              PER-ROOM COMPOSITION
            </div>
            <p style={{ fontSize: 11, color: "var(--ink-3, #7a6a52)", margin: "0 0 8px", lineHeight: 1.4 }}>
              Place each guest in a room and pick their meal plan — tap to select, tap a room to place, or drag.
            </p>
            <RoomCompositionPlanner
              sealedRoomIds={sealedRoomIds}
              entryCheckIn={entry.checkInDate ?? null}
              entryCheckOut={entry.checkOutDate ?? null}
              entryAdults={entry.adultCount ?? entry.guestCount ?? null}
              entryChildAges={entry.childAges ?? null}
              persistKey={entry.id}
              entryId={entry.id}
              onChange={setRoomCompositions}
            />
          </div>
          <button className="btn btn-primary" disabled={createM.isPending || !sealedPreferred} onClick={() => createM.mutate()}>
            {createM.isPending ? "Creating…" : "Create quote"}
          </button>
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
          <div className="frow">
            <div className="field">
              <label>Apply discount %</label>
              <input
                type="number"
                value={discountPercent}
                onChange={(e) => {
                  setDiscountPercent(e.target.value);
                  if (discountM.isSuccess) discountM.reset();
                  if (approveM.isSuccess) approveM.reset();
                }}
              />
            </div>
            <div className="field">
              <label>Basis</label>
              <input value={discountBasis} onChange={(e) => setDiscountBasis(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 13 }}>
            <button className="btn btn-ghost btn-sm" disabled={discountM.isPending || !discountPercent} onClick={() => discountM.mutate()}>
              <Percent style={{ width: 13, height: 13 }} />
              {discountM.isPending ? "Applying…" : discountM.isSuccess ? "✓ Discount applied" : "Apply discount"}
            </button>
            {elevated && (
              <button className="btn btn-ghost btn-sm" disabled={approveM.isPending || approveM.isSuccess} onClick={() => approveM.mutate()}>
                {approveM.isPending ? "Approving…" : approveM.isSuccess ? "✓ Discount approved" : "Approve discount (FOM)"}
              </button>
            )}
          </div>
          <div style={{ height: 10 }} />
          <div className="frow">
            <div className="field">
              <label>Send via</label>
              <select value={sendChannel} onChange={(e) => setSendChannel(e.target.value)}>
                <option value="EMAIL">Email</option>
                <option value="WHATSAPP">WhatsApp</option>
              </select>
            </div>
            <div className="field">
              <label>Valid for (days)</label>
              <input type="number" min={1} value={validDays} onChange={(e) => setValidDays(e.target.value)} />
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
          {/* Renegotiation inputs (2026-07-28): the guest came back wanting changes — a new
               discount and/or different per-room composition (meal plans, extra beds,
               negotiated rates). Edit here, then "New round (supersede)" regenerates the
               quote (fresh QUO number, fully re-priced) and the send flow re-arms the email
               + acknowledgement window. Left untouched → prior terms carry forward. */}
          <details style={{ margin: "4px 0 10px" }}>
            <summary style={{ fontSize: 11.5, color: "var(--ink-3)", cursor: "pointer" }}>
              Renegotiate terms for the new round (discount · per-room composition)
            </summary>
            <div className="frow" style={{ marginTop: 8 }}>
              <div className="field">
                <label>New discount %</label>
                <input type="number" min={0} max={100} value={discountPercent} onChange={(e) => setDiscountPercent(e.target.value)} />
              </div>
              <div className="field">
                <label>Discount basis</label>
                <input value={discountBasis} onChange={(e) => setDiscountBasis(e.target.value)} />
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <RoomCompositionPlanner
                sealedRoomIds={sealedRoomIds}
                entryCheckIn={entry.checkInDate ?? null}
                entryCheckOut={entry.checkOutDate ?? null}
                entryAdults={entry.adultCount ?? entry.guestCount ?? null}
                entryChildAges={entry.childAges ?? null}
                persistKey={entry.id}
                entryId={entry.id}
                onChange={setRoomCompositions}
              />
            </div>
          </details>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={acceptM.isPending} onClick={() => acceptM.mutate()}>
              {acceptM.isPending ? "Recording…" : "Record acceptance"}
            </button>
            <button className="btn btn-ghost" disabled={supersedeM.isPending} onClick={() => supersedeM.mutate()}>
              New round (supersede)
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
        <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 13 }}>
          <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
          Accepted · {accepted.referenceNumber} · {money(accepted.totalAmount, accepted.currency)}
        </div>
      )}

      <div className="block" style={{ marginTop: 14 }}>
        <BlockH>
          <Timer style={{ width: 13, height: 13 }} />
          Hold a room while negotiating (optional)
        </BlockH>
        {activeHold ? (
          <>
            <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12.5, marginBottom: 9 }}>
              Hold on room {activeHold.room?.roomNumber ?? activeHold.roomId?.slice(0, 8) ?? "—"} · expires{" "}
              {activeHold.expiresAt.slice(0, 16)}
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
              <label>Why hold this room?</label>
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
              {holdM.isPending ? "Placing…" : "Place hold on preferred room"}
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
