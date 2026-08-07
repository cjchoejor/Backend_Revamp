"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Eye, EyeOff, FileCheck2, FileX2, Mail, Send } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { getEntryTimers, getEntryTrace } from "@/lib/api/entries";
import { resendConfirmationVoucher } from "@/lib/api/confirmation";
import { openConfirmationVoucherPdf, openCancellationConfirmationPdf } from "@/lib/api/documents";
import { PdfButton } from "./pdf-button";
import { CancellationVoucherPreview, VoucherPreview } from "./quotation-preview";
import type { EntryDetail } from "@/types/api";

/**
 * Confirmation voucher — the S4 receipt panel. Surfaces the four things `confirmReservation`
 * does when a booking is frozen (all backend-authoritative — this panel only DISPLAYS them):
 *   1. generates + dispatches the voucher as a tracked communication
 *   2. opens the acknowledgement-window timer (ACKNOWLEDGEMENT_WINDOW_W22)
 *   3. renders the voucher as a write-once, checksum-signed PDF
 *   4. attaches the PDF and emails it to the guest (threaded)
 *
 * Every fact is read from an endpoint that already exists: reservation scalars (props), the
 * timers feed, and the trace feed. No new backend surface. The PDF opens via the existing
 * `GET /api/reservations/:id/confirmation-voucher-pdf` route (renders on demand if not stored).
 */

type Tone = "ok" | "wait" | "warn" | "muted";
const TONE: Record<Tone, { color: string; bg: string }> = {
  ok: { color: "var(--ok)", bg: "var(--green-t)" },
  wait: { color: "var(--warn)", bg: "var(--warn-t)" },
  warn: { color: "var(--stop)", bg: "var(--stop-t)" },
  muted: { color: "var(--ink-3)", bg: "var(--cream-2)" },
};

function StepRow({
  icon,
  title,
  tone,
  children,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  tone: Tone;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div style={{ display: "flex", gap: 10, padding: "9px 0", borderBottom: "1px dashed var(--line)" }}>
      <div
        style={{
          flex: "0 0 auto",
          width: 26,
          height: 26,
          borderRadius: 7,
          background: t.bg,
          color: t.color,
          display: "grid",
          placeItems: "center",
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{title}</span>
          {action}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2, wordBreak: "break-word" }}>{children}</div>
      </div>
    </div>
  );
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()} ${hh}:${min}`;
}

export function ConfirmationVoucherBlock({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const res = entry.reservation;

  // Inline document view (2026-08-07, operator request — "view like PI and quotation").
  const [previewOpen, setPreviewOpen] = useState(false);
  // Manual re-send to the guest — prefilled with the profile email, editable for corrections.
  const guestEmail = entry.guestProfile?.email ?? "";
  const [sendTo, setSendTo] = useState(guestEmail);
  useEffect(() => {
    if (guestEmail) setSendTo((prev) => prev || guestEmail);
  }, [guestEmail]);

  const sendM = useMutation({
    mutationFn: () => resendConfirmationVoucher(session!, res!.id, { dispatchedTo: sendTo.trim() || undefined }),
    onSuccess: (out) => {
      toast.success(`Voucher sent to ${out.dispatchedTo}`);
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
      // The re-send creates a fresh CONFIRMATION_VOUCHER communication — the acceptance block
      // reads that feed on its own key.
      void queryClient.invalidateQueries({ queryKey: ["entry-communications", entry.id] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't send the voucher"),
  });

  const timersQ = useQuery({
    queryKey: ["entry-timers", entry.id],
    queryFn: () => getEntryTimers(session!, entry.id),
    enabled: !!session,
  });
  const traceQ = useQuery({
    // Same key + limit as the BackendRail on this step, so we share its cache (and its 8s refresh)
    // instead of registering a second query shape. The confirmation email is the newest trace
    // event at freeze time, so 80 rows always covers it.
    queryKey: ["entry-trace", entry.id],
    queryFn: () => getEntryTrace(session!, entry.id, 80),
    enabled: !!session,
  });

  if (!res) return null;

  // 2 — acknowledgement window: the W22 timer, still scheduled while the guest hasn't acknowledged.
  const ackTimer = timersQ.data?.items.find((t) => t.timerType === "ACKNOWLEDGEMENT_WINDOW_W22");

  // 4 — email: the latest RESERVATION_CONFIRMATION_EMAIL.* trace event tells us what really happened.
  const emailEvents = (traceQ.data?.items ?? []).filter((e) => e.eventType.startsWith("RESERVATION_CONFIRMATION_EMAIL"));
  const emailEvent = emailEvents[0]; // trace comes newest-first
  const emailPayload = (emailEvent?.payload ?? null) as
    | { actualRecipient?: string; intendedRecipient?: string; redirected?: boolean; reason?: string; message?: string }
    | null;

  // 3 — PDF render state.
  const rendered = !!res.confirmationVoucherRenderedAt;
  const checksum = res.confirmationVoucherChecksum ?? null;

  return (
    <div className="block">
      <div className="block-h">
        <FileCheck2 style={{ width: 13, height: 13 }} />
        Confirmation voucher
        <span className="ln" />
      </div>
      <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
        Sent to the guest the moment this booking was frozen. Everything below happened automatically at
        confirmation — this is the record of it.
      </p>

      {/* 1 — generated & dispatched */}
      <StepRow icon={<Send style={{ width: 14, height: 14 }} />} title="Voucher generated &amp; dispatched" tone="ok">
        Recorded as a tracked communication{res.confirmedAt ? ` on ${fmtDateTime(res.confirmedAt)}` : ""}.
      </StepRow>

      {/* 2 — acknowledgement window */}
      <StepRow
        icon={ackTimer ? <Clock style={{ width: 14, height: 14 }} /> : <CheckCircle2 style={{ width: 14, height: 14 }} />}
        title="Acknowledgement window"
        tone={ackTimer ? "wait" : "muted"}
      >
        {timersQ.isLoading
          ? "Checking…"
          : ackTimer
            ? `Open — awaiting guest acknowledgement until ${fmtDateTime(ackTimer.firesAt)}.`
            : "No pending window (auto-acknowledged for OTA, or already elapsed)."}
      </StepRow>

      {/* 3 — PDF rendered, with inline view + open-in-tab actions */}
      <StepRow
        icon={<FileCheck2 style={{ width: 14, height: 14 }} />}
        title="PDF (write-once, checksum-signed)"
        tone={rendered ? "ok" : "muted"}
        action={
          session ? (
            <span style={{ display: "inline-flex", gap: 6 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setPreviewOpen((v) => !v)}
                title="Show the voucher document right here (renders + stores it on first view)"
              >
                {previewOpen ? <EyeOff style={{ width: 14, height: 14 }} /> : <Eye style={{ width: 14, height: 14 }} />}
                {previewOpen ? "Hide" : "View"}
              </button>
              <PdfButton label="PDF" open={() => openConfirmationVoucherPdf(session, res.id)} />
            </span>
          ) : undefined
        }
      >
        {rendered ? (
          <>
            Rendered {fmtDateTime(res.confirmationVoucherRenderedAt)}
            {checksum ? (
              <>
                {" · "}
                <span style={{ fontFamily: "var(--deskmono)" }}>
                  {res.confirmationVoucherChecksumAlgo ?? "SHA-256"} {checksum.slice(0, 12)}…
                </span>
              </>
            ) : null}
          </>
        ) : (
          "Not stored yet — renders on first view."
        )}
      </StepRow>
      {previewOpen && <VoucherPreview reservationId={res.id} />}

      {/* 4 — emailed to guest */}
      <StepRow
        icon={
          emailEvent?.eventType.endsWith(".SENT") ? (
            <Mail style={{ width: 14, height: 14 }} />
          ) : (
            <AlertTriangle style={{ width: 14, height: 14 }} />
          )
        }
        title="Emailed to guest"
        tone={
          traceQ.isLoading
            ? "muted"
            : emailEvent?.eventType.endsWith(".SENT")
              ? "ok"
              : emailEvent
                ? "warn"
                : "muted"
        }
      >
        {traceQ.isLoading ? (
          "Checking…"
        ) : emailEvent?.eventType.endsWith(".SENT") ? (
          <>
            Sent to {emailPayload?.actualRecipient ?? emailPayload?.intendedRecipient ?? entry.guestProfile?.email ?? "the guest"}
            {emailPayload?.redirected ? " (test redirect)" : ""}
            {emailPayload?.intendedRecipient && emailPayload?.redirected
              ? ` · intended for ${emailPayload.intendedRecipient}`
              : ""}
            . Threaded into the guest&rsquo;s conversation.
          </>
        ) : emailEvent?.eventType.endsWith(".SKIPPED") ? (
          <>Skipped — {emailPayload?.reason ?? "no reason recorded"}.</>
        ) : emailEvent?.eventType.endsWith(".ERROR") ? (
          <>Send failed — {emailPayload?.message ?? "unknown error"}.</>
        ) : entry.guestProfile?.email ? (
          <>No email event recorded yet (guest email on file: {entry.guestProfile.email}).</>
        ) : (
          "No guest email on file — nothing was emailed."
        )}
      </StepRow>

      {/* Manual send (2026-08-07, operator request): the automatic send at confirmation may
          have been skipped (no email on file), failed, or the guest wants it again. Sends the
          same email + PDF and opens a fresh reply window. */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", paddingTop: 10 }}>
        <div className="field" style={{ flex: "1 1 220px", marginBottom: 0 }}>
          <label>Send to</label>
          <input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="guest@example.com" />
        </div>
        <button
          className="btn btn-ghost btn-sm"
          disabled={!sendTo.trim() || sendM.isPending}
          onClick={() => sendM.mutate()}
          title="Email the voucher (PDF attached) to this address — recorded as a tracked communication with a fresh reply window"
        >
          <Send style={{ width: 13, height: 13 }} />
          {sendM.isPending ? "Sending…" : "Send to guest"}
        </button>
      </div>
    </div>
  );
}

/**
 * Cancellation voucher (A5) — shown on a CANCELLED booking's read-only record (2026-08-07,
 * operator request). The document was generated when the cancellation committed (or renders
 * lazily on first view) and states what was held, what was retained under the disclosed
 * ladder, and what was refunded.
 */
export function CancellationVoucherBlock({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const [previewOpen, setPreviewOpen] = useState(false);
  if (entry.status !== "CANCELLED") return null;
  return (
    <div className="block" style={{ borderColor: "#e2b3ac" }}>
      <div className="block-h">
        <FileX2 style={{ width: 13, height: 13 }} />
        Cancellation voucher
        <span className="ln" />
      </div>
      <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 0, lineHeight: 1.55 }}>
        The guest-facing record of this cancellation — the advance that was held, what the
        disclosed cancellation terms retained, and what was refunded. Give it to the guest as
        their proof of the outcome.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreviewOpen((v) => !v)}>
          {previewOpen ? <EyeOff style={{ width: 14, height: 14 }} /> : <Eye style={{ width: 14, height: 14 }} />}
          {previewOpen ? "Hide" : "View"}
        </button>
        {session && <PdfButton label="PDF" open={() => openCancellationConfirmationPdf(session, entry.id)} />}
      </div>
      {previewOpen && <CancellationVoucherPreview entryId={entry.id} />}
    </div>
  );
}
