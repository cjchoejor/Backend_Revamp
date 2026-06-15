"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  FileText,
  Lock,
  Mail,
  Percent,
  Send,
  Timer,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StagePanel } from "@/components/stages/shared/stage-panel";
import { ApiErrorAlert } from "@/components/stages/shared/api-error-alert";
import { ProgressStageButton } from "@/components/stages/shared/progress-stage-button";
import { useStageTransition } from "@/components/stages/shared/stage-transition-context";
import { STAGES, stagePath } from "@/config/stages";
import {
  acceptQuotation,
  applyQuotationDiscount,
  approveQuotationDiscount,
  autoFulfilS2ToS3,
  createQuotation,
  placeSpeculativeHold,
  releaseSpeculativeHold,
  resolveQuotationAckOpenLoop,
  sendQuotation,
  supersedeQuotation,
} from "@/lib/api/quotations";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type {
  AvailabilityConfigSummary,
  EntryDetail,
  QuotationState,
  QuotationSummary,
  SpeculativeHoldSummary,
} from "@/types/api";

type S2WorkspaceProps = {
  entry: EntryDetail;
};

function formatAmount(amount: string | number, currency: string) {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return `${currency} —`;
  return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function stateBadgeClass(state: QuotationState) {
  switch (state) {
    case "DRAFT":
      return "bg-muted text-muted-foreground";
    case "SENT":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
    case "ACCEPTED":
      return "bg-[var(--success)]/15 text-[var(--success)]";
    case "SUPERSEDED":
      return "bg-muted/50 text-muted-foreground";
    case "EXPIRED":
      return "bg-destructive/10 text-destructive";
    default:
      return "";
  }
}

function isElevated(level: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

export function S2Workspace({ entry }: S2WorkspaceProps) {
  const router = useRouter();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const { startTransition, endTransition } = useStageTransition();
  const meta = STAGES[1];

  const currentSegment = entry.segments?.[0] ?? null;
  const segmentId = currentSegment?.id;

  const segmentQuotations = useMemo(
    () =>
      (entry.quotations ?? []).filter((q) => !segmentId || q.segmentId === segmentId),
    [entry.quotations, segmentId],
  );

  const segmentHolds = useMemo(
    () =>
      (entry.speculativeHolds ?? []).filter((h) => !segmentId || h.segmentId === segmentId),
    [entry.speculativeHolds, segmentId],
  );

  const sealedPreferred = (entry.availabilityConfigs ?? []).find(
    (c: AvailabilityConfigSummary) => c.sealedAt && c.optionSelected,
  );
  const preferredRoomId = sealedPreferred?.optionSelected?.roomId ?? null;

  const draftQuotation = segmentQuotations.find((q) => q.state === "DRAFT");
  const sentQuotation = segmentQuotations.find((q) => q.state === "SENT");
  const acceptedQuotation = segmentQuotations.find((q) => q.state === "ACCEPTED");
  const workingQuotation = draftQuotation ?? sentQuotation;

  const activeHold = segmentHolds.find((h) => h.state === "PLACED" || h.state === "UPGRADED");

  const [notes, setNotes] = useState("");
  const [discountPercent, setDiscountPercent] = useState("");
  const [discountBasis, setDiscountBasis] = useState("negotiation");
  const [sendChannel, setSendChannel] = useState("EMAIL");
  const [recipientAddress, setRecipientAddress] = useState(entry.guestProfile?.email ?? "");
  const [validDays, setValidDays] = useState("2");
  const [acceptMethod, setAcceptMethod] = useState<"VERBAL" | "WRITTEN">("VERBAL");
  const [verbatimNote, setVerbatimNote] = useState("");
  const [holdBasis, setHoldBasis] = useState("");
  const [holdTtl, setHoldTtl] = useState("900");
  const [releaseReason, setReleaseReason] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });

  const wrapMutation = <T,>(fn: () => Promise<T>, successMsg: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      setActionError(null);
      toast.success(successMsg);
      void invalidate();
    },
    onError: (e: unknown) => {
      setActionError(e);
      toast.error(e instanceof ApiError ? e.message : "Action failed");
    },
  });

  const createMutation = useMutation(
    wrapMutation(
      () =>
        createQuotation(session!, entry.id, {
          notes: notes.trim() || undefined,
          requestedDiscount:
            discountPercent.trim() !== ""
              ? { discountPercent: Number(discountPercent), discountBasis: discountBasis.trim() || "negotiation" }
              : undefined,
        }),
      "Quotation draft created",
    ),
  );

  const supersedeMutation = useMutation(
    wrapMutation(
      () => {
        const id = workingQuotation?.id ?? sentQuotation?.id;
        if (!id) throw new Error("No quotation to supersede");
        return supersedeQuotation(session!, id, {
          notes: notes.trim() || undefined,
          requestedDiscount:
            discountPercent.trim() !== ""
              ? { discountPercent: Number(discountPercent), discountBasis: discountBasis.trim() || "negotiation" }
              : undefined,
        });
      },
      "New quotation version created",
    ),
  );

  const discountMutation = useMutation(
    wrapMutation(
      () => {
        if (!draftQuotation) throw new Error("No draft quotation");
        return applyQuotationDiscount(session!, draftQuotation.id, {
          discountPercent: Number(discountPercent),
          discountBasis: discountBasis.trim() || "negotiation",
        });
      },
      "Discount applied",
    ),
  );

  const approveDiscountMutation = useMutation(
    wrapMutation(
      () => {
        if (!draftQuotation) throw new Error("No draft quotation");
        return approveQuotationDiscount(session!, draftQuotation.id);
      },
      "Discount approved",
    ),
  );

  const sendMutation = useMutation(
    wrapMutation(
      () => {
        if (!draftQuotation) throw new Error("No draft quotation");
        return sendQuotation(session!, draftQuotation.id, {
          validDays: Number(validDays) || 2,
          channel: sendChannel,
          recipientAddress: recipientAddress.trim(),
          sentTo: recipientAddress.trim(),
        });
      },
      "Quotation sent",
    ),
  );

  const acceptMutation = useMutation(
    wrapMutation(
      () => {
        if (!sentQuotation) throw new Error("No sent quotation");
        return acceptQuotation(session!, sentQuotation.id, {
          acceptanceMethod: acceptMethod,
          verbatimNote: acceptMethod === "VERBAL" ? verbatimNote.trim() : undefined,
        });
      },
      "Quotation accepted",
    ),
  );

  const resolveAckMutation = useMutation(
    wrapMutation(
      () => {
        if (!sentQuotation) throw new Error("No sent quotation");
        return resolveQuotationAckOpenLoop(session!, sentQuotation.id, {
          resolutionType: "CUSTODIAN_DECISION",
          decisionReason: verbatimNote.trim() || "Resolved at desk",
        });
      },
      "Acknowledgement loop resolved",
    ),
  );

  const holdMutation = useMutation(
    wrapMutation(
      () => {
        if (!preferredRoomId) throw new Error("No preferred room from S1");
        if (!holdBasis.trim()) throw new Error("Commercial basis required");
        return placeSpeculativeHold(session!, entry.id, {
          roomId: preferredRoomId,
          ttlSeconds: Number(holdTtl) || 900,
          commercialBasis: holdBasis.trim(),
        });
      },
      "Speculative hold placed",
    ),
  );

  const releaseHoldMutation = useMutation(
    wrapMutation(
      () => {
        if (!activeHold) throw new Error("No active hold");
        if (!releaseReason.trim()) throw new Error("Release reason required");
        return releaseSpeculativeHold(session!, entry.id, activeHold.id, {
          releaseReason: releaseReason.trim(),
        });
      },
      "Hold released",
    ),
  );

  const autoFulfilMutation = useMutation(
    wrapMutation(
      () => autoFulfilS2ToS3(session!, entry.id, entry.version),
      "Auto-fulfilled to S3",
    ),
  );

  const exitChecks = useMemo(() => {
    const hasAccepted = !!acceptedQuotation;
    const validityOk =
      !acceptedQuotation?.validUntil || new Date(acceptedQuotation.validUntil) > new Date();
    const holdOk =
      segmentHolds.length === 0 ||
      segmentHolds.every((h) => h.state === "PLACED" || h.state === "UPGRADED");
    const hasSealedConfig = !!sealedPreferred;
    return [
      { label: "Sealed availability configuration (from S1)", ok: hasSealedConfig },
      { label: "Accepted quotation on current segment", ok: hasAccepted },
      { label: "Accepted quotation still valid", ok: !acceptedQuotation || validityOk },
      { label: "Speculative holds active (if any placed)", ok: holdOk },
    ];
  }, [acceptedQuotation, segmentHolds, sealedPreferred]);

  const canProgressS3 =
    exitChecks.every((c) => c.ok) && entry.currentStage === "S2" && !!acceptedQuotation;

  const commercialTerms = (workingQuotation ?? acceptedQuotation)?.commercialTerms as
    | Record<string, unknown>
    | undefined;

  // Stage-mismatch gate removed — ReadOnlyShell + <fieldset disabled> in stage-page.tsx handles
  // past/future stage viewing. Workspace content always renders.

  return (
    <StagePanel meta={meta}>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Commercial context</CardTitle>
            <CardDescription>SIG-S2 — negotiation builds on S1 availability selection</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <p>
              <span className="text-muted-foreground">Stay:</span>{" "}
              {entry.checkInDate?.slice(0, 10) ?? "—"} → {entry.checkOutDate?.slice(0, 10) ?? "—"}
            </p>
            <p>
              <span className="text-muted-foreground">Guests / use:</span> {entry.guestCount ?? "—"} ·{" "}
              {entry.useType ?? "—"}
            </p>
            <p>
              <span className="text-muted-foreground">Guest:</span>{" "}
              {entry.guestProfile?.displayName ??
                [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ") ??
                "—"}
            </p>
            <p>
              <span className="text-muted-foreground">Segment:</span> #
              {currentSegment?.segmentNumber ?? entry.segmentNumber ?? 1}
              {currentSegment?.sealedAt && (
                <Badge variant="outline" className="ml-2">
                  prior sealed
                </Badge>
              )}
            </p>
            <p className="sm:col-span-2">
              <span className="text-muted-foreground">Preferred room (S1):</span>{" "}
              {preferredRoomId ? (
                <span className="font-mono text-xs">{preferredRoomId.slice(0, 20)}…</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">Missing — complete S1 first</span>
              )}
            </p>
            {entry.committedHold && (
              <p className="sm:col-span-2 text-amber-700 dark:text-amber-400">
                Prior committed hold may still be running (S3 re-entry). Watch hold expiry during
                renegotiation.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" />
              Quotation versions
            </CardTitle>
            <CardDescription>Version chain is the negotiation history (Q-001, Q-002, …)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {segmentQuotations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No quotations yet for this segment.</p>
            ) : (
              segmentQuotations.map((q) => (
                <QuotationRow key={q.id} quotation={q} isLatest={q.id === segmentQuotations[0]?.id} />
              ))
            )}
          </CardContent>
        </Card>

        {!workingQuotation && !acceptedQuotation && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">1. Create quotation</CardTitle>
              <CardDescription>
                Rates are resolved via the pricing pipeline from the sealed S1 configuration.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-xs text-muted-foreground">Internal notes</label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">Discount % (optional)</label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={discountPercent}
                    onChange={(e) => setDiscountPercent(e.target.value)}
                    placeholder="e.g. 10"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Discount basis</label>
                  <Input value={discountBasis} onChange={(e) => setDiscountBasis(e.target.value)} />
                </div>
              </div>
              <Button
                variant="gradient"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !sealedPreferred}
              >
                {createMutation.isPending ? "Creating…" : "Create draft quotation"}
              </Button>
              {!sealedPreferred && (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  Complete S1 and progress to S2 so the availability configuration is sealed.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {draftQuotation && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">2. Draft — {draftQuotation.referenceNumber}</CardTitle>
              <CardDescription>
                {formatAmount(draftQuotation.totalAmount, draftQuotation.currency)}
                {commercialTerms?.effectiveRate != null && (
                  <span className="ml-2 text-muted-foreground">
                    (nightly effective: {String(commercialTerms.effectiveRate)})
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(commercialTerms?.requestedDiscount as { discountPercent?: number } | undefined)
                ?.discountPercent != null && (
                <p className="flex items-center gap-2 text-sm">
                  <Percent className="h-4 w-4" />
                  Discount requested:{" "}
                  {String(
                    (commercialTerms?.requestedDiscount as { discountPercent: number }).discountPercent,
                  )}
                  % — FOM approval may be required before send.
                </p>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">Apply discount %</label>
                  <Input
                    type="number"
                    value={discountPercent}
                    onChange={(e) => setDiscountPercent(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Basis</label>
                  <Input value={discountBasis} onChange={(e) => setDiscountBasis(e.target.value)} />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={discountMutation.isPending || !discountPercent}
                  onClick={() => discountMutation.mutate()}
                >
                  Apply discount
                </Button>
                {session && isElevated(session.actorLevel) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={approveDiscountMutation.isPending}
                    onClick={() => approveDiscountMutation.mutate()}
                  >
                    Approve discount (FOM)
                  </Button>
                )}
              </div>

              <div className="rounded-lg border p-4 space-y-3">
                <p className="text-sm font-medium flex items-center gap-2">
                  <Send className="h-4 w-4" />
                  Send to guest
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground">Channel</label>
                    <select
                      className="flex h-9 w-full rounded-md border bg-background px-3 text-sm"
                      value={sendChannel}
                      onChange={(e) => setSendChannel(e.target.value)}
                    >
                      <option value="EMAIL">Email</option>
                      <option value="WHATSAPP">WhatsApp</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Valid days</label>
                    <Input
                      type="number"
                      min={1}
                      value={validDays}
                      onChange={(e) => setValidDays(e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-xs text-muted-foreground">Recipient</label>
                    <Input
                      value={recipientAddress}
                      onChange={(e) => setRecipientAddress(e.target.value)}
                      placeholder="email or E.164 phone"
                    />
                  </div>
                </div>
                <Button
                  variant="gradient"
                  disabled={sendMutation.isPending || !recipientAddress.trim()}
                  onClick={() => sendMutation.mutate()}
                >
                  <Mail className="mr-2 h-4 w-4" />
                  {sendMutation.isPending ? "Sending…" : "Send quotation"}
                </Button>
              </div>

              {segmentQuotations.some((q) => q.state === "SENT" || q.state === "SUPERSEDED") && (
                <Button
                  variant="outline"
                  disabled={supersedeMutation.isPending}
                  onClick={() => supersedeMutation.mutate()}
                >
                  New negotiation round (supersede)
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {sentQuotation && !acceptedQuotation && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">3. Sent — {sentQuotation.referenceNumber}</CardTitle>
              <CardDescription>
                Valid until {sentQuotation.validUntil?.slice(0, 16) ?? "—"} · sent{" "}
                {sentQuotation.sentAt?.slice(0, 16) ?? "—"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">Acceptance method</label>
                  <select
                    className="flex h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={acceptMethod}
                    onChange={(e) => setAcceptMethod(e.target.value as "VERBAL" | "WRITTEN")}
                  >
                    <option value="VERBAL">Verbal (staff records)</option>
                    <option value="WRITTEN">Written</option>
                  </select>
                </div>
                {acceptMethod === "VERBAL" && (
                  <div className="sm:col-span-2">
                    <label className="text-xs text-muted-foreground">Verbatim note</label>
                    <Input
                      value={verbatimNote}
                      onChange={(e) => setVerbatimNote(e.target.value)}
                      placeholder="Guest acceptance wording"
                    />
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="gradient"
                  disabled={acceptMutation.isPending}
                  onClick={() => acceptMutation.mutate()}
                >
                  {acceptMutation.isPending ? "Recording…" : "Record acceptance"}
                </Button>
                <Button
                  variant="outline"
                  disabled={supersedeMutation.isPending}
                  onClick={() => supersedeMutation.mutate()}
                >
                  Supersede (new version)
                </Button>
                {session && isElevated(session.actorLevel) && (
                  <Button
                    variant="outline"
                    disabled={resolveAckMutation.isPending}
                    onClick={() => resolveAckMutation.mutate()}
                  >
                    Resolve ack open loop (FOM)
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {acceptedQuotation && (
          <Card className="border-[var(--success)]/40">
            <CardContent className="flex items-center gap-3 p-4">
              <CheckCircle2 className="h-5 w-5 text-[var(--success)]" />
              <div>
                <p className="font-medium">
                  Accepted — {acceptedQuotation.referenceNumber} (
                  {formatAmount(acceptedQuotation.totalAmount, acceptedQuotation.currency)})
                </p>
                <p className="text-xs text-muted-foreground">
                  {acceptedQuotation.acceptedAt?.slice(0, 16) ?? "—"}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Timer className="h-4 w-4" />
              Speculative hold (optional)
            </CardTitle>
            <CardDescription>
              Soft-hold inventory during negotiation — not a committed reservation (S3 only).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeHold ? (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-2">
                <p>
                  <Badge>{activeHold.state}</Badge>
                  <span className="ml-2">
                    Room {activeHold.room?.roomNumber ?? activeHold.roomId?.slice(0, 8) ?? "—"}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  Expires {activeHold.expiresAt.slice(0, 16)} (TTL {activeHold.ttlSeconds}s)
                </p>
                {session && isElevated(session.actorLevel) && (
                  <div className="flex gap-2 pt-2">
                    <Input
                      placeholder="Release reason (required)"
                      value={releaseReason}
                      onChange={(e) => setReleaseReason(e.target.value)}
                    />
                    <Button
                      variant="outline"
                      disabled={releaseHoldMutation.isPending}
                      onClick={() => releaseHoldMutation.mutate()}
                    >
                      Release (FOM)
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div>
                  <label className="text-xs text-muted-foreground">Commercial basis</label>
                  <Input
                    value={holdBasis}
                    onChange={(e) => setHoldBasis(e.target.value)}
                    placeholder="Why this hold is needed"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">TTL (seconds)</label>
                  <Input type="number" value={holdTtl} onChange={(e) => setHoldTtl(e.target.value)} />
                </div>
                <Button
                  variant="outline"
                  disabled={holdMutation.isPending || !preferredRoomId || !holdBasis.trim()}
                  onClick={() => holdMutation.mutate()}
                >
                  {holdMutation.isPending ? "Placing…" : "Place speculative hold on preferred room"}
                </Button>
              </>
            )}
            {segmentHolds.filter((h) => h.state === "RELEASED").length > 0 && (
              <p className="text-xs text-muted-foreground">
                {segmentHolds.filter((h) => h.state === "RELEASED").length} released hold(s) on record.
              </p>
            )}
          </CardContent>
        </Card>

        <ApiErrorAlert error={actionError} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">S2 exit checklist</CardTitle>
            <CardDescription>Required before reservation setup (S3)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {exitChecks.map((item) => (
              <div key={item.label} className="flex items-center gap-2 text-sm">
                {item.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className={item.ok ? "text-foreground" : "text-muted-foreground"}>{item.label}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">4. Progress to S3</CardTitle>
            <CardDescription>Reservation hold & provisional folio (SIG-S3)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!canProgressS3 && (
              <p className="text-sm text-muted-foreground">
                Create, send, and accept a quotation before advancing. Use auto-fulfil only for
                standard package paths with no negotiation.
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <ProgressStageButton
                entryId={entry.id}
                version={entry.version}
                targetStage="S3"
                label="Progress to S3 — Reservation hold"
                disabled={!canProgressS3}
              />
              <Button
                variant="outline"
                disabled={autoFulfilMutation.isPending || !sealedPreferred}
                onClick={() => {
                  startTransition({
                    targetStage: "S3",
                    label: "Auto-fulfilling into reservation hold…",
                  });
                  autoFulfilMutation.mutate(undefined, {
                    onSuccess: () => {
                      void invalidate();
                      router.push(stagePath(entry.id, "S3"));
                    },
                    onError: () => endTransition(),
                  });
                }}
              >
                {autoFulfilMutation.isPending ? "Auto-fulfilling…" : "Auto-fulfil S2→S3 (package rate)"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </StagePanel>
  );
}

function QuotationRow({ quotation, isLatest }: { quotation: QuotationSummary; isLatest: boolean }) {
  const terms = quotation.commercialTerms as Record<string, unknown> | undefined;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm",
        isLatest && "ring-1 ring-primary/30",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{quotation.referenceNumber}</span>
        <Badge className={stateBadgeClass(quotation.state)}>{quotation.state}</Badge>
        {quotation.sealedAt && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" /> sealed
          </span>
        )}
      </div>
      <span>{formatAmount(quotation.totalAmount, quotation.currency)}</span>
      {terms?.notes != null && (
        <p className="w-full text-xs text-muted-foreground">{String(terms.notes)}</p>
      )}
    </div>
  );
}
