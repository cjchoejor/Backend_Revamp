"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Mail, Percent, Timer } from "lucide-react";
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
} from "@/lib/api/quotations";
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

const STATE_TAG: Record<QuotationState, { label: string; cls: string }> = {
  DRAFT: { label: "Draft", cls: "" },
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
  const quotations = useMemo(
    () => (entry.quotations ?? []).filter((q) => !segmentId || q.segmentId === segmentId),
    [entry.quotations, segmentId],
  );

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
  const [recipient, setRecipient] = useState(entry.guestProfile?.email ?? entry.guestProfile?.phone ?? "");
  const [acceptMethod, setAcceptMethod] = useState<"VERBAL" | "WRITTEN">("VERBAL");
  const [verbatim, setVerbatim] = useState("");
  const [holdBasis, setHoldBasis] = useState("");
  const [holdTtl, setHoldTtl] = useState("900");
  const [releaseReason, setReleaseReason] = useState("");
  const [mealPlan, setMealPlan] = useState<"" | "CP" | "MAP_LUNCH" | "MAP_DINNER" | "AP">("");
  const [extraBedCount, setExtraBedCount] = useState("0");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
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
          mealPlan: mealPlan || null,
          extraBedCount: Number(extraBedCount) || 0,
        }),
      "Quote drafted",
    ),
  );
  const discountM = useMutation(
    wrap(() => {
      if (!draft) throw new Error("No draft quote");
      return applyQuotationDiscount(session!, draft.id, {
        discountPercent: Number(discountPercent),
        discountBasis: discountBasis.trim() || "negotiation",
      });
    }, "Discount applied"),
  );
  const approveM = useMutation(
    wrap(() => {
      if (!draft) throw new Error("No draft quote");
      return approveQuotationDiscount(session!, draft.id);
    }, "Discount approved"),
  );
  const sendM = useMutation(
    wrap(() => {
      if (!draft) throw new Error("No draft quote");
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
      return placeSpeculativeHold(session!, entry.id, {
        roomId: preferredRoomId,
        ttlSeconds: Number(holdTtl) || 900,
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

      {quotations.length > 0 && (
        <div className="block">
          <BlockH>Quote history</BlockH>
          {quotations.map((q) => (
            <QuoteRow key={q.id} q={q} />
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
          <div className="frow">
            <div className="field">
              <label>Meal plan</label>
              <select value={mealPlan} onChange={(e) => setMealPlan(e.target.value as typeof mealPlan)}>
                <option value="">EP — room only (no meals)</option>
                <option value="CP">CP — breakfast</option>
                <option value="MAP_LUNCH">MAP — breakfast + lunch</option>
                <option value="MAP_DINNER">MAP — breakfast + dinner</option>
                <option value="AP">AP — all meals</option>
              </select>
            </div>
            <div className="field">
              <label>Extra beds</label>
              <input type="number" min={0} max={10} value={extraBedCount} onChange={(e) => setExtraBedCount(e.target.value)} />
            </div>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 9px" }}>
            Meals price per person by age (under-6 free · 6–10 at the child rate · 11+ full) and extra beds
            per night — <b>only for agent/corporate bookings</b> with a rate card; otherwise the meal plan is
            recorded as a label with no charge.
          </p>
          <button className="btn btn-primary" disabled={createM.isPending || !sealedPreferred} onClick={() => createM.mutate()}>
            {createM.isPending ? "Drafting…" : "Create draft quote"}
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
              <label>Hold for (seconds)</label>
              <input type="number" value={holdTtl} onChange={(e) => setHoldTtl(e.target.value)} />
            </div>
            <button className="btn btn-ghost" disabled={holdM.isPending || !preferredRoomId || !holdBasis.trim()} onClick={() => holdM.mutate()}>
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

function QuoteRow({ q }: { q: QuotationSummary }) {
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
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <b>{q.referenceNumber}</b>
        <span className={`tag ${tag.cls}`}>{tag.label}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="mono">{money(q.totalAmount, q.currency)}</span>
        {session && <PdfButton label="Quotation PDF" open={() => openQuotationPdf(session, q.id)} />}
      </span>
    </div>
  );
}
