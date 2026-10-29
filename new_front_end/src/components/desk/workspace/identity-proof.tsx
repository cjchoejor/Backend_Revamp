"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Eraser, FileText, Fingerprint, Lock, ScanLine, Smartphone, Upload, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { verifyGuestIdentity, type VerificationPath } from "@/lib/api/check-in";

/** The verification path in the desk's words — the same wording as the select below. */
const PATH_WORD: Record<string, string> = {
  FIRST_TIME: "first-time guest",
  RETURNING_VALID: "returning, ID valid",
  RETURNING_EXPIRED: "returning, ID expired",
  VIP: "VIP path",
};
import { fetchPdfObjectUrl } from "@/lib/api/documents";
import { IdPhotoViewerHost, showIdPhoto } from "./id-photo-viewer";
import { getChildPolicy } from "@/lib/api/child-policy";
import { listRooms } from "@/lib/api/rooms";
import {
  applyOcrSuggestion,
  dismissOcrSuggestion,
  identityProofFileUrl,
  listIdentityProofs,
  mintPhoneCaptureToken,
  rerunPhotoOcr,
  confirmGuestIdentityDetails,
  clearGuestIdentitySlot,
  saveGuestIdentityDetail,
  setLeadGuest,
  uploadIdentityProof,
  type IdentityProofSummary,
  type OcrSuggestion,
} from "@/lib/api/identity-proofs";
import { repairPartySeating } from "@/lib/api/entries";
import { partySeatingIssues, seatPartyByComposition } from "@/lib/desk/party-rooms";
import { DeskConfirmModal } from "./confirm-modal";
import { StepAction } from "./step-action";
import type { EntryDetail } from "@/types/api";
import { fmtDateTime, fmtTime, HOTEL_TZ_DEFAULT } from "@/lib/ds/format";
import { Help, HelpHere } from "@/components/ds/help";
import { DsDialog, NotNow } from "@/components/ds/steps/kit";
import { Button } from "@/design-system";

/**
 * Guest-detail table on Arrival (2026-08-10, operator request — "store ID proof of every
 * guest", reshaped the same day into a table): one row per person in the booking's party,
 * columns Passport/permit no · Name · DOB · Gender · ID photo. The party comes from the
 * intake breakdown (adults + per-child ages — the same derivation and stable slot keys
 * A0…/K0… as the guest board), so a 2-adult 2-child booking shows four rows.
 *
 * Typed details save on blur to a per-(entry, guest) DETAIL row (`saveGuestIdentityDetail`,
 * upsert — working data, editable); photos are separate write-once rows filed under the same
 * slot key. Companions have no GuestProfile rows, so both live on `GuestIdentityDocument`
 * with the subject recorded on the row itself.
 *
 * Storage story: photo bytes go to the hotel server's write-once document store (same place
 * as the bill PDFs), never into the database; the desk fetches them back through an
 * authenticated endpoint, so nothing is publicly reachable. Evidence, not verification —
 * nothing here sets `identityVerifiedAt`; the check-in step's verification stays the act
 * that vouches a human compared the documents to the guests.
 */

type PartySlot = { key: string; label: string; placeholder: string; sub?: string };

/** One slot per person in the party — guest-board key scheme so the two surfaces agree.
 *  Labels are GENERIC ("Adult 1", never the profile's name): the booking's guest profile is
 *  the CONTACT PERSON, not necessarily anyone sleeping in the rooms (operator ruling
 *  2026-08-11), so no row is pre-named after them — typed names are the only names shown.
 *  Entries without a party breakdown fall back to `guestCount` anonymous slots. */
function partySlots(entry: EntryDetail): PartySlot[] {
  const adults = Math.max(0, entry.adultCount ?? 0);
  const childAges = entry.childAges ?? [];
  const slots: PartySlot[] = [];
  if (adults > 0 || childAges.length > 0) {
    for (let i = 0; i < adults; i++) {
      slots.push({ key: `A${i}`, label: `Adult ${i + 1}`, placeholder: "Name as on the document" });
    }
    childAges.forEach((age, i) => {
      slots.push({ key: `K${i}`, label: `Child ${i + 1} · ${age}y`, sub: `${age}y`, placeholder: "Name as on the document" });
    });
  } else {
    const n = Math.max(1, entry.guestCount ?? 1);
    for (let i = 0; i < n; i++) {
      slots.push({ key: `A${i}`, label: `Guest ${i + 1}`, placeholder: "Name as on the document" });
    }
  }
  return slots;
}

type DetailDraft = { docType: string; num: string; name: string; dob: string; gender: string };

const EMPTY_DRAFT: DetailDraft = { docType: "", num: "", name: "", dob: "", gender: "" };

/** Backend placeholders a row carries when no document type was picked (the DB column is
 *  non-nullable) — rendered as "unselected" in the dropdown, never as a real choice. */
const UNTYPED_DOC_TYPES = new Set(["PASSPORT_OR_PERMIT", "PHOTO_PROOF"]);

function draftFromRow(row: IdentityProofSummary | undefined): DetailDraft {
  const docType = row?.documentType && !UNTYPED_DOC_TYPES.has(row.documentType) ? row.documentType : "";
  return {
    docType,
    num: row?.documentNumber ?? "",
    name: row?.subjectLabel ?? "",
    dob: row?.dateOfBirth ? row.dateOfBirth.slice(0, 10) : "",
    gender: row?.gender ?? "",
  };
}

function sameDraft(a: DetailDraft, b: DetailDraft): boolean {
  return a.docType === b.docType && a.num === b.num && a.name === b.name && a.dob === b.dob && a.gender === b.gender;
}

/** Thumbnail that fetches the image through the authenticated endpoint (blob object-URL). */
function ProofThumb({ proof, size = 40, name }: { proof: IdentityProofSummary; size?: number; /** The guest's name as the table has it now — the viewer's title. */ name?: string }) {
  const { session } = useSession();
  const [url, setUrl] = useState<string | null>(null);
  const isImage = (proof.mimeType ?? "").startsWith("image/");

  useEffect(() => {
    if (!session || !isImage) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    fetchPdfObjectUrl(session, identityProofFileUrl(proof.id))
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        objectUrl = u;
        setUrl(u);
      })
      .catch(() => {
        /* thumb stays a placeholder; opening still reports the real error */
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [session, proof.id, isImage]);

  // Opens beside the table, over the booking file (2026-10-29) — not in another browser tab. The
  // viewer takes a copy of its own, so this thumbnail can let its copy go whenever it likes.
  const open = async () => {
    if (!session) return;
    try {
      const u = await fetchPdfObjectUrl(session, identityProofFileUrl(proof.id));
      const who = name?.trim() || proof.subjectLabel?.trim();
      const kind = proof.documentType && !["PASSPORT_OR_PERMIT", "PHOTO_PROOF"].includes(proof.documentType) ? proof.documentType.replace(/_/g, " ").toLowerCase() : null;
      showIdPhoto({ id: proof.id, url: u, mime: proof.mimeType ?? "image/jpeg", title: [who || "ID photo", kind].filter(Boolean).join(" · ") });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open the file");
    }
  };

  return (
    <button
      type="button"
      onClick={open}
      title={`${(proof.documentType ?? "ID").replace(/_/g, " ")} · ${fmtDateTime(proof.capturedAt, HOTEL_TZ_DEFAULT)} — open it beside the table`}
      style={{
        width: Math.round((size * 4) / 3),
        height: size,
        flexShrink: 0,
        borderRadius: "var(--r-sm)",
        border: "1px solid var(--line-2)",
        background: "var(--cream)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        cursor: "pointer",
        padding: 0,
      }}
    >
      {isImage && url ? (
        // eslint-disable-next-line @next/next/no-img-element -- blob object-URL, next/image can't optimise it
        <img src={url} alt={proof.fileName ?? "ID proof"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <FileText style={{ width: 16, height: 16, color: "var(--ink-3)" }} />
      )}
    </button>
  );
}

const cellInput: React.CSSProperties = { width: "100%", minWidth: 0, fontSize: 12, padding: "5px 7px" };
/** A CONFIRMED row stays fully READABLE while it is locked (2026-08-21) — the operator has to
 *  be able to check what was recorded; the browser's default disabled grey hides it. */
const lockedCell: React.CSSProperties = {
  opacity: 1,
  color: "var(--ink)",
  background: "var(--cream-2)",
  borderStyle: "dashed",
  cursor: "not-allowed",
};
const DOB_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type DobParts = { d: string; m: string; y: string };

function dobSplit(v: string): DobParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? { d: String(Number(m[3])), m: String(Number(m[2])), y: m[1] } : { d: "", m: "", y: "" };
}

/** "YYYY-MM-DD" when the three boxes make a real date, "" when all three are empty, null otherwise. */
function dobCompose(p: DobParts): string | null {
  if (!p.d && !p.m && !p.y) return "";
  const d = Number(p.d);
  const mo = Number(p.m);
  const y = Number(p.y);
  if (!/^\d{4}$/.test(p.y) || !d || !mo) return null;
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return `${p.y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A date of birth as three boxes — day, month, year (2026-10-23, operator: the browser's own
 * calendar made the desk scroll back year by year to reach 1950). The year is typed, so nothing
 * scrolls; the day moves on to the month and the month to the year by themselves. A date is
 * handed up only once the three make a real one ("" when all three are emptied); a half-typed
 * date stays in the boxes, outlined, until it is finished.
 */
function DobField({
  value,
  onChange,
  onDone,
  disabled,
  boxStyle,
  warn,
  label,
}: {
  value: string;
  onChange: (ymd: string) => void;
  /** Focus left the three boxes. */
  onDone: () => void;
  disabled?: boolean;
  boxStyle: React.CSSProperties;
  /** The age check's message, when the date does not fit the row. */
  warn?: string | null;
  label: string;
}) {
  const [parts, setParts] = useState<DobParts>(() => dobSplit(value));
  const monthRef = useRef<HTMLSelectElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);
  // A date from outside (the saved row, Apply) replaces the boxes; a half-typed one is not a date yet.
  useEffect(() => {
    setParts((cur) => (dobCompose(cur) === value ? cur : dobSplit(value)));
  }, [value]);
  const update = (patch: Partial<DobParts>) => {
    const next = { ...parts, ...patch };
    setParts(next);
    const v = dobCompose(next);
    if (v !== null && v !== value) onChange(v);
  };
  const incomplete = dobCompose(parts) === null;
  const bad = incomplete || !!warn;
  const look: React.CSSProperties = bad ? { ...boxStyle, borderColor: "var(--stop)", boxShadow: "0 0 0 1px var(--stop)" } : boxStyle;
  const title = incomplete ? "Not a full date yet — the day, the month and the year" : (warn ?? undefined);
  return (
    <div
      role="group"
      aria-label={`${label} — date of birth`}
      aria-invalid={bad ? true : undefined}
      title={title}
      style={{ display: "flex", gap: 3 }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDone();
      }}
    >
      <input
        className="dinput"
        aria-label="Day"
        inputMode="numeric"
        maxLength={2}
        placeholder="DD"
        disabled={disabled}
        // A click selects what is there, so the next keystroke replaces it rather than editing half of it.
        onFocus={(e) => e.currentTarget.select()}
        value={parts.d}
        style={{ ...look, width: 34, textAlign: "center", padding: "5px 2px" }}
        onChange={(e) => {
          const d = e.target.value.replace(/\D/g, "").slice(0, 2);
          update({ d });
          // Two digits, or a first digit that cannot start a two-digit day, and the month is next.
          if (d.length === 2 || (d.length === 1 && Number(d) > 3)) monthRef.current?.focus();
        }}
      />
      <select
        ref={monthRef}
        // A box like the day and the year beside it (2026-10-29, operator: "the document type, month
        // and gender need boxes as well, or else the user can easily miss them").
        className="dinput"
        aria-label="Month"
        disabled={disabled}
        value={parts.m}
        style={{ ...look, width: 62, padding: "5px 2px" }}
        onChange={(e) => {
          update({ m: e.target.value });
          if (e.target.value) yearRef.current?.focus();
        }}
      >
        <option value="">Mon</option>
        {DOB_MONTHS.map((name, i) => (
          <option key={name} value={String(i + 1)}>
            {name}
          </option>
        ))}
      </select>
      <input
        ref={yearRef}
        className="dinput"
        aria-label="Year"
        inputMode="numeric"
        maxLength={4}
        placeholder="YYYY"
        disabled={disabled}
        onFocus={(e) => e.currentTarget.select()}
        value={parts.y}
        style={{ ...look, width: 50, textAlign: "center", padding: "5px 2px" }}
        onChange={(e) => update({ y: e.target.value.replace(/\D/g, "").slice(0, 4) })}
        onKeyDown={(e) => {
          if (e.key === "Backspace" && !parts.y) monthRef.current?.focus();
        }}
      />
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--ink-3)",
  padding: "4px 6px",
  borderBottom: "1px solid var(--line-2)",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = { padding: "6px 6px", borderBottom: "1px dashed var(--line)", verticalAlign: "middle" };

const GENDER_WORD: Record<string, string> = { M: "Male", F: "Female", X: "Other" };

/** Where a reading is, in words, and how far along the bar it sits when the stage begins. */
const READ_STAGES: Record<string, { words: string; from: number; to: number; usual: number }> = {
  QUEUED: { words: "Waiting its turn", from: 4, to: 14, usual: 4 },
  QR: { words: "Looking for a QR code", from: 14, to: 30, usual: 2 },
  STRIP: { words: "Reading the passport strip", from: 30, to: 45, usual: 3 },
  TEXT: { words: "Reading the printed text", from: 45, to: 94, usual: 12 },
};

/**
 * The reading of one ID photo, over its Scan-again button (2026-10-23, operator: "a small progress
 * bar showing the image is being read and done"). While it runs: the stage in words, the seconds,
 * and a bar that moves through the stages the server reports (it never claims the end before the
 * server does). When it ends: green with what was found, amber when nothing could be read (the
 * row stays as it was, so this line is the only sign), red when the reading failed or stopped.
 */
function OcrProgress({ suggestion, fetchedAt }: { suggestion: OcrSuggestion; fetchedAt: number }) {
  // Seconds come from the server's answer; this machine only adds the time since it arrived.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const since = Math.max(0, (now - fetchedAt) / 1000);
  const later = (s: number | null | undefined) => (s == null ? null : s + since);
  const shell = (tone: string, fill: number, label: React.ReactNode, title?: string, live = false) => (
    <div role={live ? "status" : undefined} aria-live={live ? "polite" : undefined} title={title} style={{ width: 150, display: "grid", gap: 3 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: tone, display: "flex", alignItems: "center", gap: 4, lineHeight: 1.25 }}>{label}</div>
      <div style={{ height: 5, borderRadius: 3, background: "var(--line)", overflow: "hidden" }}>
        <div className="ocr-fill" style={{ height: "100%", width: `${Math.max(3, Math.min(100, fill))}%`, background: tone, borderRadius: 3 }} />
      </div>
    </div>
  );
  if (suggestion.status === "PENDING") {
    if (suggestion.stalled) {
      return shell("var(--stop)", 100, <><AlertTriangle style={{ width: 12, height: 12 }} /> The reading stopped — scan again</>, "No progress for several minutes.", true);
    }
    const st = READ_STAGES[suggestion.stage ?? "QUEUED"] ?? READ_STAGES.QUEUED;
    const inStage = later(suggestion.stageForSeconds) ?? 0;
    // Moves within the stage as time passes, slowing as it nears the stage's end — never past it.
    const within = 1 - Math.exp(-inStage / st.usual);
    const fill = st.from + (st.to - st.from) * within;
    const reading = later(suggestion.readingForSeconds);
    const secs = reading == null ? null : Math.round(reading);
    return shell(
      "var(--accent, #2f6fdf)",
      fill,
      <>
        <ScanLine style={{ width: 12, height: 12 }} /> {st.words}
        {secs != null ? <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>· {secs}s</span> : null}
      </>,
      undefined,
      true,
    );
  }
  const ended = later(suggestion.endedForSeconds);
  const endedMs = ended == null ? Number.POSITIVE_INFINITY : ended * 1000;
  const took = suggestion.readSeconds != null ? ` in ${Math.round(suggestion.readSeconds)}s` : "";
  if (suggestion.status === "READY" && endedMs < 20_000) {
    const n = Object.values(suggestion.fields ?? {}).filter(Boolean).length;
    return shell("var(--ok)", 100, <><Check style={{ width: 12, height: 12 }} /> Read{took} · {n} detail{n === 1 ? "" : "s"} below</>, undefined, true);
  }
  if (suggestion.status === "EMPTY") {
    return shell(
      "var(--warn)",
      100,
      <><AlertTriangle style={{ width: 12, height: 12 }} /> Nothing could be read{took}</>,
      "Retake the photo flat, in good light, with the whole page in the frame — or type the details.",
      endedMs < 20_000,
    );
  }
  if (suggestion.status === "FAILED") {
    return shell("var(--stop)", 100, <><AlertTriangle style={{ width: 12, height: 12 }} /> The reading failed — scan again</>, suggestion.error ?? undefined, endedMs < 20_000);
  }
  return null;
}

/** Amber "Detected from the ID photo" strip — the machine's read, never mistaken for verified data. */
function SuggestionStrip({
  suggestion,
  docTypeName,
  busy,
  onApply,
  onDismiss,
  lockedHint = null,
}: {
  suggestion: OcrSuggestion;
  docTypeName: (code: string) => string;
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
  /** Set when the row is CONFIRMED — Apply would write into a locked row, so it says why. */
  lockedHint?: string | null;
}) {
  const f = suggestion.fields ?? {};
  const c = suggestion.fieldConfidence ?? {};
  const tick = (k: keyof typeof c) =>
    c[k] === "VERIFIED" ? (
      <span title="Proven by the document's own check digit" style={{ color: "var(--ok)", fontWeight: 700 }}>
        {" "}✓
      </span>
    ) : null;
  const parts: React.ReactNode[] = [];
  if (f.documentType) parts.push(<span key="t">{docTypeName(f.documentType)}{tick("documentType")}</span>);
  if (f.documentNumber) parts.push(<span key="n" style={{ fontFamily: "var(--font-plex-mono)" }}>{f.documentNumber}{tick("documentNumber")}</span>);
  else if (f.documentNumberLast4) parts.push(<span key="n4" style={{ fontFamily: "var(--font-plex-mono)" }}>number ending {f.documentNumberLast4}</span>);
  if (f.fullName) parts.push(<span key="nm">{f.fullName}{tick("fullName")}</span>);
  if (f.dateOfBirth) parts.push(<span key="d">DOB {f.dateOfBirth}{tick("dateOfBirth")}</span>);
  if (f.gender) parts.push(<span key="g">{GENDER_WORD[f.gender] ?? f.gender}{tick("gender")}</span>);
  if (f.nationality) parts.push(<span key="na">{f.nationality}</span>);
  const origin =
    suggestion.engine === "PHONE_QR" || suggestion.engine === "SERVER_QR"
      ? "from the card's QR"
      : suggestion.engine === "PHONE_MRZ" || suggestion.engine === "SERVER_MRZ"
        ? "from the passport strip"
        : suggestion.engine === "SERVER_LAYOUT"
          ? "by reading the card"
          : "typed on the phone";
  const onPhone = suggestion.engine.startsWith("PHONE_");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        fontSize: 11.5,
        background: "var(--warn-t)",
        border: "1px solid var(--warn)",
        borderRadius: 6,
        padding: "4px 8px",
      }}
    >
      <ScanLine style={{ width: 12, height: 12, color: "var(--warn)" }} />
      <span style={{ fontWeight: 600 }}>Detected {origin}{onPhone ? " (read on the phone)" : ""}:</span>
      {/* Actions sit right after the label so they never scroll out of the table's viewport. */}
      <span style={{ display: "inline-flex", gap: 6 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !!lockedHint}
          onClick={onApply}
          title={lockedHint ?? "Write these into the row above (you can still edit them after)"}
        >
          Apply
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onDismiss} title="Not this guest's details — hide the suggestion">
          Dismiss
        </button>
      </span>
      <span style={{ display: "inline-flex", gap: 10, flexWrap: "wrap" }}>
        {parts.length ? parts.map((p, i) => <span key={i}>{p}</span>) : <span style={{ color: "var(--ink-3)" }}>nothing usable</span>}
      </span>
      {/* A date of birth that does not fit this guest's row is said before Apply (2026-10-23). */}
      {suggestion.ageCheck && !suggestion.ageCheck.ok && suggestion.ageCheck.message && (
        <div role="alert" className="rct-refusal" style={{ flexBasis: "100%", margin: "2px 0 0", fontSize: 12.5 }}>
          <span className="ic">!</span>
          <span>{suggestion.ageCheck.message}</span>
        </div>
      )}
    </div>
  );
}

export function IdentityProofBlock({
  entry,
  checkInGate = false,
  collapsible = false,
}: {
  entry: EntryDetail;
  /** S6 rendering (2026-08-11): hosts the identity VERIFICATION panel at the top (the act
   *  that sets `identityVerifiedAt` — it lived in its own "Guest identity" block until the
   *  operator asked for it inside this table) and shows the check-in gate strip — details
   *  are REQUIRED for every guest before "Check in & go live" (VIP bookings exempt). S5
   *  leaves this off. */
  checkInGate?: boolean;
  /** S5 rendering (2026-08-12, operator request): the block starts COLLAPSED — header click
   *  toggles. The queries and the returning-guest auto-pull still run while collapsed, so
   *  the header tag stays live and the pulled number lands either way. S6 stays always-open
   *  (the table is a gate there). */
  collapsible?: boolean;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(!collapsible);
  const [drafts, setDrafts] = useState<Record<string, DetailDraft>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  // Clearing a guest's row (2026-10-23): which guest, and what of theirs goes.
  const [clearFor, setClearFor] = useState<PartySlot | null>(null);
  const [clearDetails, setClearDetails] = useState(false);
  const [clearPhoto, setClearPhoto] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Which guest the open picker is capturing for — set at button-click time, read on change.
  const pendingSlotRef = useRef<PartySlot | null>(null);
  // Phone capture handoff (2026-08-12): the open QR modal — one slot, or the WHOLE party
  // (slot null → all-guests token; the phone lists every guest and names one per photo).
  // `baseline` is the photo count at mint time so "received" counts only THIS handoff.
  const [phoneCapture, setPhoneCapture] = useState<{ slot: PartySlot | null; url: string; expiresAt: string; baseline: number } | null>(null);

  const entryId = entry.id;
  const slots = partySlots(entry);

  const listQuery = useQuery({
    queryKey: ["identity-proofs", entryId],
    queryFn: () => listIdentityProofs(session!, entryId),
    enabled: !!session,
    // While a QR modal waits on a phone, poll so the photo lands on screen the moment it
    // uploads — the app-wide staleTime would otherwise sit on the cached list for 5 minutes.
    // Also poll while a server-side OCR read is PENDING so the suggestion lands on screen.
    refetchInterval: (q) => {
      if (phoneCapture) return 3000;
      const pending = (q.state.data?.suggestions ?? []).some((x) => x.status === "PENDING" && !x.stalled);
      return pending ? 1500 : false;
    },
  });
  // Which row is the lead (2026-10-23) — the desk's mark, else the first adult row; the server decides.
  const leadKey = listQuery.data?.leadSubjectKey ?? "A0";
  const items = listQuery.data?.items ?? [];
  // OCR / QR suggestions per photo (2026-08-18) — rendered under the guest's row while
  // unapplied; Apply writes through the same detail save the row's inputs use.
  const suggestions = listQuery.data?.suggestions ?? [];
  // Config-driven (`identity.documentTypes`) — same vocabulary the S6 verification validates
  // against, so nothing offered here can be rejected there.
  const docTypes = listQuery.data?.documentTypes ?? [];
  const coverage = listQuery.data?.coverage;
  const returning = listQuery.data?.returningGuest ?? null;

  // Identity VERIFICATION (S6 only — `checkInGate`): moved here from its own block.
  const guest = entry.guestProfile;
  const isVip = !!guest?.vipTier?.trim();
  // Verified AT THIS STAY — the server's per-booking record, which the check-in gate reads. The
  // profile's own stamp outlives the stay: a returning guest arrived already "verified" by their
  // last check-in, the button showed as done and the old path was seeded over the suggested one
  // (2026-09-18).
  const stayVerification = listQuery.data?.verification ?? null;
  const identityVerified = !!stayVerification;
  // The paths the guest's profile allows, from the server (2026-09-18, SIG-S6 §756). Every guest
  // who was not VIP used to default to "Returning — ID valid", the one path that needs no
  // document, so a first-time guest was verified with nothing on file. Until the answer arrives
  // the default is the strictest path.
  const paths = listQuery.data?.verificationPaths ?? null;
  const suggestedPath: VerificationPath = paths?.suggested ?? (isVip ? "VIP" : "FIRST_TIME");
  const [verificationPath, setVerificationPath] = useState<VerificationPath>(suggestedPath);
  const [pulledFromFile, setPulledFromFile] = useState(false);
  const autoPullRef = useRef(false);

  useEffect(() => {
    // Seed from the RECORDED path when there is one (2026-08-21 — "Make changes" must show the
    // guest type as it stands, not a default), else the path the guest's profile points to.
    setVerificationPath((stayVerification?.path as VerificationPath | null | undefined) ?? suggestedPath);
  }, [suggestedPath, guest?.id, stayVerification?.path]);

  // Which room each guest sits in per the S2 composition. The composition stores COUNTS per
  // room (never who), so this re-derives the seating with the SAME deterministic algorithm
  // the S2 guest board uses to rebuild chips from counts (`deriveFromSeed`): band pools in
  // party order, rooms in sealed order, adults → 6–10s → under-6s per room's counts. Exact
  // when the board did the placing; same-band guests are interchangeable either way.
  const policyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 10 * 60_000,
  });
  const roomsQuery = useQuery({
    queryKey: ["rooms-catalog"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const roomInfoById = useMemo(() => {
    const m = new Map<string, { roomNumber: string; bedType?: string | null; roomTypeName?: string | null }>();
    for (const r of roomsQuery.data?.items ?? [])
      m.set(r.id, { roomNumber: r.roomNumber, bedType: r.bedType, roomTypeName: r.roomType?.name ?? null });
    return m;
  }, [roomsQuery.data]);
  const roomBySlot = useMemo(
    () =>
      seatPartyByComposition(
        entry,
        policyQuery.data?.ageBands.youngChildMaxAge ?? 5,
        policyQuery.data?.ageBands.childMaxAge ?? 10,
      ),
    [entry, policyQuery.data],
  );

  // Seating invariants (2026-08-21, operator ruling — "make sure no room is empty and everyone
  // has a room"): a room change that dropped the composition left guests under "No room
  // assigned yet" here with no way out. The strip names the gap; the button restores it
  // through the backend's governed repair (the setup-only room-change journey — nobody moves,
  // nothing goes to the guest), so the seating becomes the booking's frozen terms again.
  const seatingIssues = useMemo(
    () =>
      partySeatingIssues(
        entry,
        policyQuery.data?.ageBands.youngChildMaxAge ?? 5,
        policyQuery.data?.ageBands.childMaxAge ?? 10,
      ),
    [entry, policyQuery.data],
  );
  const [seatingOpen, setSeatingOpen] = useState(false);
  const canRepairSeating = ["S5", "S6", "S7"].includes(entry.currentStage) && entry.status === "ACTIVE";
  const repairSeatingM = useMutation({
    mutationFn: () => repairPartySeating(session!, entryId),
    onSuccess: (out) => {
      setSeatingOpen(false);
      const lines = out.seating?.lines ?? [];
      if (out.walk.blocked) {
        toast.warning(
          `Seating recorded, but the booking is at ${out.walk.reachedStage}, not back at this step yet: ${out.walk.blocked.message}`,
          { duration: 12000 },
        );
      } else {
        toast.success(lines.length ? `Everyone has a room. ${lines.join(". ")}.` : "Everyone has a room.", { duration: 12000 });
      }
      if (out.seating?.unresolved.length) toast.warning(out.seating.unresolved.join(" · "), { duration: 12000 });
      for (const key of ["entry", "identity-proofs", "entry-trace", "billing-summary", "room-plan-history", "room-change-candidates", "entry-timers"]) {
        void queryClient.invalidateQueries({ queryKey: [key, entryId] });
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not seat the guests"),
  });

  const detailRow = (key: string) => items.find((p) => p.entryId === entryId && p.subjectKey === key && !p.hasFile);
  const photosFor = (key: string) => items.filter((p) => p.entryId === entryId && p.subjectKey === key && p.hasFile);
  // Guest-detail CONFIRMATION (2026-08-21, operator ruling): a confirmed guest's row is
  // read-only — the inputs disable and the backend refuses writes to it — until "Make
  // changes" unlocks it. The flag lives on the row, so a guest confirmed at Arrival is still
  // locked at Check-in and during the Stay, on this terminal and any other.
  const lockedFor = (key: string) => !!detailRow(key)?.detailsConfirmedAt;
  /** Something is on file for this guest — the floor for confirming (the backend re-checks). */
  const hasSomethingFor = (key: string) => {
    const row = detailRow(key);
    return (
      photosFor(key).length > 0 ||
      !!row?.documentNumber?.trim() ||
      !!row?.dateOfBirth ||
      !!row?.gender?.trim() ||
      !!row?.subjectLabel?.trim()
    );
  };
  /** Unsaved input in the row still counts — confirming flushes it before locking. */
  const draftHasContent = (key: string) => {
    const d = drafts[key];
    return !!(d && (d.num.trim() || d.name.trim() || d.dob || d.gender));
  };
  const canConfirmSlot = (key: string) => !lockedFor(key) && (hasSomethingFor(key) || draftHasContent(key));
  /** The suggestion for a slot's NEWEST photo (the one the row shows). */
  const suggestionFor = (key: string): OcrSuggestion | null => {
    const newest = photosFor(key)[0];
    if (!newest) return null;
    return suggestions.find((x) => x.photoDocumentId === newest.id) ?? null;
  };

  // Table rows grouped BY ROOM (2026-08-12, operator request — mirrors the phone page): the
  // room is a band row spanning the table and its guests sit under it, instead of "Room 205"
  // repeating beneath every name. Party order within a room; unseated guests gather last;
  // a booking with no seating at all keeps the flat table (no bands).
  const slotGroups: { key: string; roomId: string | null; items: PartySlot[] }[] = [];
  for (const slot of slots) {
    const roomId = roomBySlot.get(slot.key) ?? null;
    const key = roomId ?? "unassigned";
    let g = slotGroups.find((x) => x.key === key);
    if (!g) {
      g = { key, roomId, items: [] };
      slotGroups.push(g);
    }
    g.items.push(slot);
  }
  slotGroups.sort((a, b) => (a.roomId ? 0 : 1) - (b.roomId ? 0 : 1));
  const showRoomBands = slotGroups.some((g) => g.roomId);
  // Uploaded before the per-guest split (or by a caller that named no one) — shown, never lost.
  const unassigned = items.filter((p) => p.entryId === entryId && p.hasFile && (!p.subjectKey || !slots.some((s) => s.key === p.subjectKey)));
  const earlierStays = items.filter((p) => p.entryId !== entryId && p.hasFile);
  const coveredCount = slots.filter((s) => photosFor(s.key).length > 0).length;
  // S7+ renders the same table as a CORRECTION surface (2026-08-21) — the check-in wording
  // ("carries to Check-in") would be a lie once the guest is in-house.
  const inHouse = ["S7", "S8", "S9"].includes(entry.currentStage);
  const confirmedSlotCount = slots.filter((s) => lockedFor(s.key)).length;
  const confirmableSlots = slots.filter((s) => canConfirmSlot(s.key));
  // "Everything confirmable is confirmed" — rows with nothing on file don't count against it.
  const allLocked = slots.length > 0 && confirmedSlotCount > 0 && confirmableSlots.length === 0;
  // Edit mode = the table is NOT locked (never confirmed, or "Make changes" was pressed). The S6
  // guest type (verification path) is part of the same edit mode (2026-08-21, operator request):
  // it stays changeable while the table is open and a different pick re-records the verification.
  const editMode = !allLocked;
  const recordedPath = (stayVerification?.path as VerificationPath | null | undefined) ?? null;
  const pathChanged = identityVerified && verificationPath !== recordedPath;
  const allCovered = slots.length > 0 && coveredCount === slots.length;

  // Seed drafts from the saved detail rows — but never clobber a slot the operator has
  // touched (a refetch mid-typing must not eat their input).
  useEffect(() => {
    if (!listQuery.data) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const slot of slots) {
        if (touched[slot.key]) continue;
        next[slot.key] = draftFromRow(detailRow(slot.key));
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed off the fetched data snapshot
  }, [listQuery.data]);

  const saveM = useMutation({
    mutationFn: (args: { slot: PartySlot; draft: DetailDraft }) =>
      saveGuestIdentityDetail(session!, entryId, {
        subjectKey: args.slot.key,
        subjectLabel: args.draft.name.trim() || null,
        documentType: args.draft.docType || null,
        documentNumber: args.draft.num.trim() || null,
        dateOfBirth: args.draft.dob || null,
        gender: (args.draft.gender || null) as "MALE" | "FEMALE" | "OTHER" | null,
      }),
    onSuccess: (_d, args) => {
      setSavedFlash(args.slot.key);
      setTimeout(() => setSavedFlash((cur) => (cur === args.slot.key ? null : cur)), 2000);
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the guest details"),
  });

  // Confirm / unlock. Any unsaved edit in the affected rows is FLUSHED first: the operator's
  // last keystroke and the confirm click would otherwise race, and the save would come back
  // refused by the very lock they had just set.
  const confirmM = useMutation({
    mutationFn: async (args: { slots: PartySlot[]; confirmed: boolean }) => {
      if (args.confirmed) {
        for (const slot of args.slots) {
          const draft = drafts[slot.key] ?? EMPTY_DRAFT;
          if (lockedFor(slot.key)) continue;
          if (sameDraft(draft, draftFromRow(detailRow(slot.key)))) continue;
          await saveGuestIdentityDetail(session!, entryId, {
            subjectKey: slot.key,
            subjectLabel: draft.name.trim() || null,
            documentType: draft.docType || null,
            documentNumber: draft.num.trim() || null,
            dateOfBirth: draft.dob || null,
            gender: (draft.gender || null) as "MALE" | "FEMALE" | "OTHER" | null,
          });
        }
      }
      return confirmGuestIdentityDetails(session!, entryId, {
        subjectKeys: args.slots.map((x) => x.key),
        confirmed: args.confirmed,
      });
    },
    onSuccess: (outcome, args) => {
      // Let the refetched rows repopulate the inputs — an untouched draft would otherwise
      // mask what was actually stored, and an unlocked row must show the saved truth.
      setTouched((prev) => {
        const next = { ...prev };
        for (const slot of args.slots) next[slot.key] = false;
        return next;
      });
      const names = outcome.changed.map((c) => c.label).join(", ");
      if (outcome.changed.length) {
        toast.success(
          outcome.confirmed
            ? `Details confirmed for ${names} — the rows are locked until you choose "Make changes"`
            : `${names} unlocked — the details can be edited again`,
        );
      }
      // Never let a partial batch read as a whole one.
      const worthSaying = outcome.skipped.filter((x) => x.reason !== "ALREADY_CONFIRMED" && x.reason !== "NOT_CONFIRMED");
      if (worthSaying.length) toast.warning(worthSaying.map((x) => x.message).join(" · "));
      if (!outcome.changed.length && !worthSaying.length) toast.info("Nothing to change");
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update the confirmation"),
  });

  const applySuggestionM = useMutation({
    mutationFn: (args: { slot: PartySlot; suggestion: OcrSuggestion }) => applyOcrSuggestion(session!, args.suggestion.id),
    onSuccess: (_d, args) => {
      // Let the refetched row repopulate this slot's inputs (the operator's untouched draft
      // would otherwise mask the applied values).
      setTouched((prev) => ({ ...prev, [args.slot.key]: false }));
      setSavedFlash(args.slot.key);
      setTimeout(() => setSavedFlash((cur) => (cur === args.slot.key ? null : cur)), 2000);
      toast.success(`Details from the ID photo applied to ${args.slot.label}`);
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not apply the detected details"),
  });
  const dismissSuggestionM = useMutation({
    mutationFn: (suggestion: OcrSuggestion) => dismissOcrSuggestion(session!, suggestion.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not dismiss"),
  });
  const rerunOcrM = useMutation({
    mutationFn: (photoId: string) => rerunPhotoOcr(session!, photoId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not queue the read"),
  });

  // Clear a guest's row (2026-10-23, operator: "a clear option for both image and text"). What is
  // only typed here and never saved is just emptied on the desk; what is saved goes through the
  // server, which also opens the Arrival checklist's guest-details task again when it must.
  const clearM = useMutation({
    mutationFn: async (args: { slot: PartySlot; details: boolean; photo: boolean }) => {
      const savedHasDetails = !sameDraft(draftFromRow(detailRow(args.slot.key)), EMPTY_DRAFT);
      const hasPhoto = photosFor(args.slot.key).length > 0;
      const details = args.details && savedHasDetails;
      const photo = args.photo && hasPhoto;
      if (!details && !photo) return null;
      return clearGuestIdentitySlot(session!, entryId, { subjectKey: args.slot.key, details, photo });
    },
    onSuccess: (outcome, args) => {
      if (args.details) {
        setTouched((prev) => ({ ...prev, [args.slot.key]: false }));
        setDrafts((prev) => ({ ...prev, [args.slot.key]: EMPTY_DRAFT }));
      }
      const name = outcome?.label ?? args.slot.label;
      const what = [args.details ? "details" : null, outcome?.photosCleared ? (outcome.photosCleared > 1 ? "ID photos" : "ID photo") : null]
        .filter(Boolean)
        .join(" and ");
      toast.success(`${name}'s ${what || "details"} cleared`);
      if (outcome?.taskReopened) toast.warning("The Arrival checklist's guest-details task is open again — this guest needs their details");
      setClearFor(null);
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entry", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entryId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not clear the guest's row"),
  });
  // Mark another adult as the lead (2026-10-23, operator: "add a lead mark").
  const leadM = useMutation({
    mutationFn: (slot: PartySlot) => setLeadGuest(session!, entryId, slot.key),
    onSuccess: (r) => {
      if (r.changed) toast.success(`${r.label} is now the lead`);
      if (r.verificationReset) {
        toast.warning(`The identity verification was for the earlier lead — record it again for ${r.label} before check-in`);
      }
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entry", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entryId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not move the lead"),
  });

  const openClear = (slot: PartySlot) => {
    const draft = drafts[slot.key] ?? EMPTY_DRAFT;
    const hasDetails = !sameDraft(draft, EMPTY_DRAFT) || !sameDraft(draftFromRow(detailRow(slot.key)), EMPTY_DRAFT);
    const hasPhoto = photosFor(slot.key).length > 0;
    setClearDetails(hasDetails);
    setClearPhoto(hasPhoto);
    setClearFor(slot);
  };

  /** Blur handler — persists the row when anything actually changed. */
  const saveIfChanged = (slot: PartySlot) => {
    if (lockedFor(slot.key)) return; // confirmed → read-only (the backend refuses it too)
    const draft = drafts[slot.key] ?? EMPTY_DRAFT;
    const saved = draftFromRow(detailRow(slot.key));
    if (sameDraft(draft, saved)) return;
    if (!session) return;
    saveM.mutate({ slot, draft });
  };

  const setDraft = (key: string, patch: Partial<DetailDraft>) => {
    setTouched((prev) => ({ ...prev, [key]: true }));
    setDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_DRAFT), ...patch } }));
  };

  // Returning guest (2026-08-11, operator request): a document NUMBER is already on file for
  // this guest profile from an earlier booking — pull it into the first adult row and PERSIST
  // it (so the check-in coverage gate sees it) instead of re-asking a known number. ONLY the
  // number (refined same day): the profile is the CONTACT PERSON, not necessarily a guest, so
  // no name is written and the document-type dropdown is left for the operator to pick — never
  // auto-locked to the record's type. One-shot; never fires once this stay has its own number.
  useEffect(() => {
    if (autoPullRef.current || !session || !listQuery.data) return;
    if (!returning?.documentNumber) return;
    const slot = slots.find((s) => s.key === leadKey);
    if (!slot) return;
    const row = detailRow(leadKey);
    if (row?.documentNumber) return;
    if (lockedFor(leadKey)) return; // confirmed row — nothing may write to it unasked
    const draft: DetailDraft = { ...draftFromRow(row), num: returning.documentNumber };
    const documentNumber = returning.documentNumber;
    // Started once the effect has settled (2026-10-23): a save started on the first of
    // development's two effect runs never reports back, and Confirm stays shut behind it.
    const t = setTimeout(() => {
      autoPullRef.current = true;
      setDrafts((prev) => ({ ...prev, [slot.key]: draft }));
      setPulledFromFile(true);
      saveM.mutate({ slot, draft });
      toast.info(`Document number on file (${documentNumber}) pulled into ${slot.label} — confirm it belongs to this guest`);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot, keyed on the fetched snapshot
  }, [listQuery.data, session]);

  // The verification panel carries NO document fields of its own (2026-08-12, operator
  // ruling — the guest-detail table below is the ONLY place document type/number are typed).
  // Paths that need a document read it off the MAIN GUEST's row (A0); the button stays
  // locked until that row holds what the chosen path requires.
  const primaryDraft = drafts[leadKey] ?? EMPTY_DRAFT;
  const primaryLabel = primaryDraft.name.trim() || slots.find((s) => s.key === leadKey)?.label || "the lead";
  const verifyNeedsDocument = verificationPath === "FIRST_TIME" || verificationPath === "RETURNING_EXPIRED";
  const verifyMissing =
    verifyNeedsDocument && (!primaryDraft.docType || (verificationPath === "FIRST_TIME" && !primaryDraft.num.trim()));
  // The vouching act sits BELOW the table (2026-08-12, operator request) and only unlocks
  // once every guest's details are in — the same server-computed coverage the check-in gate
  // uses (VIP bookings exempt there, exempt here too). Choosing the VIP PATH also skips the
  // table requirement outright (same-day ruling): record directly, no guest details needed.
  const detailsIncomplete =
    verificationPath === "VIP" ? false : !coverage || (!coverage.vipExempt && !coverage.satisfied);

  const verifyM = useMutation({
    mutationFn: () => {
      if (!session || !guest?.id) throw new Error("Guest profile required");
      const body: Parameters<typeof verifyGuestIdentity>[2] = { entryId, verificationPath };
      if (verifyNeedsDocument) {
        body.documentType = primaryDraft.docType;
        if (verificationPath === "FIRST_TIME") body.documentNumber = primaryDraft.num.trim();
      }
      return verifyGuestIdentity(session, guest.id, body);
    },
    onSuccess: () => {
      toast.success(identityVerified ? `Identity verification updated · ${PATH_WORD[verificationPath] ?? verificationPath}` : "Identity verified");
      void queryClient.invalidateQueries({ queryKey: ["entry", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Verification failed"),
  });

  /**
   * One button for the table (2026-10-29, operator: "what is the difference between Confirm guest
   * details and Record identity verification … if they both do the same purpose, keep only one
   * button, prominent, on the bottom right"). At Check-in it saves what is still unsaved, records
   * the identity verification — the check the check-in needs — when it is not yet recorded for this
   * stay or the guest type changed, then locks every row with something on file. Before and after
   * Check-in there is no verification to record, and it only locks the rows. A refused verification
   * locks nothing.
   */
  const needsVerify = checkInGate && (!identityVerified || pathChanged);
  const confirmAllM = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("Not signed in");
      for (const slot of slots) {
        const draft = drafts[slot.key] ?? EMPTY_DRAFT;
        if (lockedFor(slot.key)) continue;
        if (sameDraft(draft, draftFromRow(detailRow(slot.key)))) continue;
        await saveGuestIdentityDetail(session, entryId, {
          subjectKey: slot.key,
          subjectLabel: draft.name.trim() || null,
          documentType: draft.docType || null,
          documentNumber: draft.num.trim() || null,
          dateOfBirth: draft.dob || null,
          gender: (draft.gender || null) as "MALE" | "FEMALE" | "OTHER" | null,
        });
      }
      let verified = false;
      if (needsVerify) {
        if (!guest?.id) throw new Error("Guest profile required");
        const body: Parameters<typeof verifyGuestIdentity>[2] = { entryId, verificationPath };
        if (verifyNeedsDocument) {
          body.documentType = primaryDraft.docType;
          if (verificationPath === "FIRST_TIME") body.documentNumber = primaryDraft.num.trim();
        }
        await verifyGuestIdentity(session, guest.id, body);
        verified = true;
      }
      const outcome = await confirmGuestIdentityDetails(session, entryId, { subjectKeys: slots.map((x) => x.key), confirmed: true });
      return { outcome, verified };
    },
    onSuccess: ({ outcome, verified }) => {
      setTouched({});
      const locked = outcome.changed.length;
      toast.success(
        [
          verified ? `Identity verified · ${PATH_WORD[verificationPath] ?? verificationPath}` : null,
          locked ? `${locked === slots.length ? "Every guest's" : `${locked} guests'`} details confirmed — locked until you choose "Make changes"` : null,
        ]
          .filter(Boolean)
          .join(". ") || "Guest details confirmed",
      );
      const worthSaying = outcome.skipped.filter((x) => x.reason !== "ALREADY_CONFIRMED" && x.reason !== "NOT_CONFIRMED");
      if (worthSaying.length) toast.warning(worthSaying.map((x) => x.message).join(" · "));
      void queryClient.invalidateQueries({ queryKey: ["entry", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "The guest details could not be confirmed");
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
    },
  });

  const onFiles = async (files: FileList | null) => {
    const slot = pendingSlotRef.current;
    const file = files?.[0];
    if (!file || !session || !slot) return;
    const replacing = photosFor(slot.key).length > 0;
    setBusySlot(slot.key);
    try {
      const name = (drafts[slot.key]?.name ?? "").trim();
      await uploadIdentityProof(session, entryId, file, {
        subjectKey: slot.key,
        subjectLabel: name || slot.label,
      });
      toast.success(
        replacing ? `ID replaced for ${name || slot.label}` : `ID proof stored for ${name || slot.label}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entryId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusySlot(null);
      pendingSlotRef.current = null;
      // Allow re-selecting the same file (e.g. retake after a failure).
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const pickFor = (slot: PartySlot, input: HTMLInputElement | null) => {
    pendingSlotRef.current = slot;
    input?.click();
  };

  // Photos across the whole party — the all-guests handoff's receipt counter.
  const totalSlotPhotos = slots.reduce((n, s) => n + photosFor(s.key).length, 0);

  // Phone handoff: mint the scoped token (one slot, or `allSlots` for the whole party), build
  // a URL a phone on the hotel Wi-Fi can reach (swapping localhost for the backend's LAN IP
  // when the desk itself browses via loopback), and open the QR modal. The token rides in the
  // URL HASH so it never hits server logs.
  const phoneM = useMutation({
    mutationFn: async (slot: PartySlot | null) => {
      const name = slot ? (drafts[slot.key]?.name ?? "").trim() : "";
      const minted = await mintPhoneCaptureToken(
        session!,
        entryId,
        slot ? { subjectKey: slot.key, subjectLabel: name || slot.label } : { allSlots: true },
      );
      const host = window.location.hostname;
      const loopback = host === "localhost" || host === "127.0.0.1";
      const origin =
        loopback && minted.lanIps.length > 0
          ? `${window.location.protocol}//${minted.lanIps[0]}${window.location.port ? `:${window.location.port}` : ""}`
          : window.location.origin;
      return { slot, url: `${origin}/capture#${minted.token}`, expiresAt: minted.expiresAt };
    },
    onSuccess: ({ slot, url, expiresAt }) => {
      setPhoneCapture({ slot, url, expiresAt, baseline: slot ? photosFor(slot.key).length : totalSlotPhotos });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not create the phone capture code"),
  });

  // Announce arrivals while the QR modal waits — the polling list query is the signal.
  const phoneReceived = phoneCapture
    ? (phoneCapture.slot ? photosFor(phoneCapture.slot.key).length : totalSlotPhotos) - phoneCapture.baseline
    : 0;
  const phoneReceivedRef = useRef(0);
  useEffect(() => {
    if (!phoneCapture) {
      phoneReceivedRef.current = 0;
      return;
    }
    if (phoneReceived > phoneReceivedRef.current) {
      toast.success(
        phoneCapture.slot
          ? `Photo received from the phone for ${phoneCapture.slot.label}`
          : "Photo received from the phone",
      );
    }
    phoneReceivedRef.current = phoneReceived;
  }, [phoneReceived, phoneCapture]);

  const photoChips = (proofs: IdentityProofSummary[], showSubject = false, name?: string) => (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
      {proofs.map((p) => (
        <div key={p.id} style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "center" }}>
          <ProofThumb proof={p} name={name} />
          {showSubject && (
            <span style={{ fontSize: 10, color: "var(--ink-3)", maxWidth: 60, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {p.subjectLabel ?? (p.documentType ?? "ID").replace(/_/g, " ")}
            </span>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="block">
      <div
        className="block-h"
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
        style={collapsible ? { cursor: "pointer", userSelect: "none" } : undefined}
        title={collapsible ? (open ? "Click to collapse" : "Click to open") : undefined}
      >
        {collapsible &&
          (open ? (
            <ChevronDown style={{ width: 13, height: 13 }} />
          ) : (
            <ChevronRight style={{ width: 13, height: 13 }} />
          ))}
        <Fingerprint style={{ width: 13, height: 13 }} />
        Guest details &amp; ID proof
        <span className="ln" />
        {slots.length > 0 && (
          <span className={`tag${allCovered ? "" : " warn"}`}>
            {coveredCount} of {slots.length} ID{slots.length === 1 ? "" : "s"}
          </span>
        )}
        {!seatingIssues.ok && (
          <span className="tag warn" title="Not every guest has a room, or a room has no guests — open the table to seat them">
            Seating needed
          </span>
        )}
      </div>

      {!open && (
        <p style={{ fontSize: 11.5, margin: 0 }}>
          {coverage
            ? `${coverage.filledSlots} of ${coverage.totalSlots} guest${coverage.totalSlots === 1 ? "" : "s"} recorded`
            : "Guest documents & details"}
          <Help label="About the guest details">
            Click the header to open. {inHouse ? "Correct anything that was mis-recorded." : "Everything here carries to Check-in."}
          </Help>
        </p>
      )}

      {open && (
        <>
      {/* Shared upload picker (2026-08-12, operator ruling: ONE ID per guest, desk capture is
          upload-or-phone only — the desk camera button was removed; photographing happens on
          the QR-handoff phone). Single file: a new upload REPLACES the shown ID. Which guest
          it captures for is set at button-click time. */}
      <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => void onFiles(e.target.files)} />

      {/* S6 gate strip (2026-08-11, operator ruling): details are required for every guest
          before check-in — VIP exempt. Server-computed verdict; the desk only words it. */}
      {checkInGate && coverage && (
        coverage.vipExempt ? (
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 8px" }}>
            VIP booking — guest details are <b>not required</b> for check-in. Anything recorded here is kept as evidence.
          </p>
        ) : coverage.satisfied ? (
          <div className="fact b-bound" style={{ padding: "6px 11px", fontSize: 12, marginBottom: 8, width: "100%" }}>
            <Check style={{ width: 13, height: 13, color: "var(--ok)" }} />
            All {coverage.totalSlots} guest{coverage.totalSlots === 1 ? "" : "s"} recorded — the check-in gate is satisfied.
          </div>
        ) : (
          <div
            style={{
              border: "1px solid var(--warn)",
              background: "var(--warn-t)",
              borderRadius: "var(--r-sm)",
              padding: "7px 11px",
              fontSize: 12,
              marginBottom: 8,
              lineHeight: 1.5,
            }}
          >
            <b>Required before check-in:</b> {coverage.filledSlots} of {coverage.totalSlots} guests recorded — missing{" "}
            {coverage.missing.map((m) => m.label).join(", ")}. A typed document number or an ID photo counts.
          </div>
        )
      )}

      {pulledFromFile && returning?.documentNumber && (
        <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "0 0 8px" }}>
          A document number on file from an earlier booking ({returning.documentNumber}) was
          pulled into the first adult row — confirm it belongs to this guest and pick the
          document type.
        </p>
      )}

      {!seatingIssues.ok && (() => {
        const name = (k: string) => drafts[k]?.name.trim() || slots.find((s) => s.key === k)?.label || k;
        const roomNo = (id: string) => roomInfoById.get(id)?.roomNumber ?? "?";
        const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
        const sentence = [
          seatingIssues.unseated.length > 0
            ? `${seatingIssues.unseated.map(name).join(", ")} ${plural(seatingIssues.unseated.length, "has", "have")} no room`
            : null,
          seatingIssues.emptyRooms.length > 0
            ? `Room ${seatingIssues.emptyRooms.map(roomNo).join(", ")} ${plural(seatingIssues.emptyRooms.length, "has", "have")} no guests`
            : null,
          seatingIssues.strayRooms.length > 0
            ? `the recorded composition still names Room ${seatingIssues.strayRooms.map(roomNo).join(", ")}, which this booking no longer holds`
            : null,
        ]
          .filter(Boolean)
          .join("; ");
        return (
          <div
            style={{
              border: "1px solid var(--warn)",
              background: "var(--warn-t)",
              borderRadius: "var(--r-sm)",
              padding: "8px 11px",
              fontSize: 12,
              marginBottom: 8,
              lineHeight: 1.5,
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <AlertTriangle style={{ width: 14, height: 14, flex: "0 0 auto", color: "var(--warn)" }} />
            <div style={{ flex: 1, minWidth: 240 }}>
              <b>{seatingIssues.unseated.length > 0 ? "Not everyone has a room." : "A room has no guests."}</b> {sentence}.
              {canRepairSeating
                ? " Seating them re-records the booking's current rooms with everyone in one (a new pass, re-priced silently — nothing goes to the guest)."
                : " It is repaired from Arrival, Check-in or Stay."}
            </div>
            {canRepairSeating && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={repairSeatingM.isPending}
                onClick={() => setSeatingOpen(true)}
                title="Put every guest in a room and fill every empty room — the system decides where, and tells you"
              >
                {repairSeatingM.isPending ? "Seating…" : "Seat everyone in a room"}
              </button>
            )}
          </div>
        );
      })()}

      {/* Toolbar above the table (2026-08-12, operator ruling — the boxed "Identity
          verification" section is gone; the TABLE is the verification form): S6 puts the
          verification-path select here, the whole-party phone QR sits right. "Record
          verification" waits at the table's bottom. */}
      {(slots.length > 1 || (checkInGate && (!identityVerified || editMode))) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 10, marginBottom: 6 }}>
          {checkInGate && (!identityVerified || editMode) ? (
            <div className="field" style={{ width: "min(260px, 100%)" }}>
              <label>
                Guest type <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>(verification path)</span>
                {identityVerified && (
                  <span style={{ fontWeight: 400, color: pathChanged ? "var(--warn)" : "var(--ink-3)" }}>
                    {pathChanged ? " — changed, update below" : " — as recorded"}
                  </span>
                )}
              </label>
              {/* Defaults to the path the guest's profile points to. A path the profile does
                  not allow is listed but locked, with the server's reason — a first-time guest
                  cannot be "returning", nor anyone VIP without a tier (2026-09-18). */}
              <select value={verificationPath} onChange={(e) => setVerificationPath(e.target.value as VerificationPath)}>
                {(
                  [
                    ["FIRST_TIME", "First-time guest"],
                    ["RETURNING_VALID", "Returning — ID valid"],
                    ["RETURNING_EXPIRED", "Returning — ID expired"],
                    ["VIP", "VIP path"],
                  ] as Array<[VerificationPath, string]>
                ).map(([code, word]) => {
                  const refusedWhy = paths && !paths.allowed.includes(code) ? (paths.refused[code] ?? "does not apply to this guest") : null;
                  return (
                    <option key={code} value={code} disabled={!!refusedWhy && code !== verificationPath} title={refusedWhy ?? undefined}>
                      {refusedWhy ? `${word} — not for this guest` : word}
                    </option>
                  );
                })}
              </select>
              {paths && !paths.allowed.includes(verificationPath) && (
                <div className="sm" style={{ color: "var(--warn)", marginTop: 4 }}>
                  {paths.refused[verificationPath] ?? "This path does not apply to this guest"}
                </div>
              )}
            </div>
          ) : (
            <span />
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {/* One QR for the WHOLE party — the phone lists every guest and files each photo
                under the guest picked there, so nobody scans per-row codes for a big group. */}
            {slots.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={phoneM.isPending}
                onClick={() => phoneM.mutate(null)}
                title="One QR code for the whole party — the phone shows the guest list and each photo files under the guest picked there"
              >
                <Smartphone style={{ width: 13, height: 13 }} />
                Use a phone for all guests
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Guest</th>
              <th style={th}>Document type</th>
              <th style={th}>Document no</th>
              <th style={th}>Name</th>
              <th style={th}>DOB</th>
              <th style={th}>Gender</th>
              <th style={th}>ID photo</th>
            </tr>
          </thead>
          <tbody>
            {(showRoomBands ? slotGroups : [{ key: "flat", roomId: null, items: slots }]).flatMap((group) => {
              const info = group.roomId ? roomInfoById.get(group.roomId) : undefined;
              const coveredInRoom = group.items.filter((s) => photosFor(s.key).length > 0).length;
              const bandRow = showRoomBands ? (
                <tr key={`band-${group.key}`}>
                  <td colSpan={7} style={{ padding: 0, borderBottom: "1px solid var(--line-2)" }}>
                    {/* `width: max-content` keeps the band's text visible at the LEFT of the
                        scrollable table instead of stretching across its full (off-screen)
                        width — the count sits with the room name, not past the last column. */}
                    <div
                      style={{ display: "flex", alignItems: "baseline", gap: 8, background: "var(--cream)", padding: "7px 8px", width: "100%" }}
                      title="From the room placement on the Quote step's guest board"
                    >
                      <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap" }}>
                        {info ? `Room ${info.roomNumber}` : "No room assigned yet"}
                      </span>
                      {info && (
                        <span style={{ fontSize: 11, color: "var(--ink-3)", whiteSpace: "nowrap" }}>
                          {[
                            info.bedType ? `${info.bedType.charAt(0)}${info.bedType.slice(1).toLowerCase()}` : null,
                            info.roomTypeName,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          color: coveredInRoom === group.items.length ? "var(--ok)" : "var(--ink-3)",
                        }}
                        title={`${coveredInRoom} of ${group.items.length} guests in this room have an ID photo`}
                      >
                        · {coveredInRoom}/{group.items.length} IDs
                      </span>
                    </div>
                  </td>
                </tr>
              ) : null;
              const guestRows = group.items.flatMap((slot) => {
              const draft = drafts[slot.key] ?? EMPTY_DRAFT;
              const photos = photosFor(slot.key);
              const covered = photos.length > 0;
              // Confirmed → every typed field on this row is read-only until it is unlocked.
              const locked = lockedFor(slot.key);
              const cell = locked ? { ...cellInput, ...lockedCell } : cellInput;
              const suggestion = suggestionFor(slot.key);
              // Suggestion strip under the row (2026-08-18): READY → amber "Detected from the ID
              // photo … Apply / Dismiss"; the reading itself shows in the photo cell (2026-10-23).
              const suggestionRow =
                suggestion && suggestion.status === "READY" ? (
                  <tr key={`${slot.key}-ocr`}>
                    <td colSpan={7} style={{ padding: "0 6px 6px", borderBottom: "1px dashed var(--line)" }}>
                      <SuggestionStrip
                          suggestion={suggestion}
                          docTypeName={(code) => docTypes.find((d) => d.code === code)?.name ?? code}
                          busy={applySuggestionM.isPending || dismissSuggestionM.isPending}
                          onApply={() => applySuggestionM.mutate({ slot, suggestion })}
                          onDismiss={() => dismissSuggestionM.mutate(suggestion)}
                          lockedHint={
                            lockedFor(slot.key)
                              ? 'These details are confirmed — choose "Make changes" on the row first'
                              : null
                          }
                        />
                    </td>
                  </tr>
                ) : null;
              // A date of birth that does not fit the row (2026-10-23, operator: "so the user doesn't
              // put a child in an adult's row") — the server's check of the SAVED date, shown while the
              // field still holds it; a warning, the date stays saved.
              const savedDetail = detailRow(slot.key);
              const ageWarn =
                savedDetail?.ageCheck && !savedDetail.ageCheck.ok && draft.dob === (savedDetail.dateOfBirth?.slice(0, 10) ?? "")
                  ? savedDetail.ageCheck.message
                  : null;
              const ageRow = ageWarn ? (
                <tr key={`${slot.key}-age`}>
                  <td colSpan={7} style={{ padding: "0 6px 6px" }}>
                    <div role="alert" className="rct-refusal" style={{ margin: 0, fontSize: 12.5 }}>
                      <span className="ic">!</span>
                      <span>
                        {slot.label}: {ageWarn}
                      </span>
                    </div>
                  </td>
                </tr>
              ) : null;
              // A typed name replaces the generic "Adult 2" label live (the age stays as a
              // muted suffix on child rows so the band is never hidden by a name).
              const typedName = draft.name.trim();
              const displayName = typedName || slot.label;
              const row = (
                <tr key={slot.key}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600 }}>
                      {covered ? (
                        <Check style={{ width: 13, height: 13, color: "var(--ok)" }} />
                      ) : (
                        <span style={{ width: 12, height: 12, borderRadius: 999, border: "1.5px solid var(--line-3)", display: "inline-block" }} />
                      )}
                      {displayName}
                      {typedName && slot.sub && <span style={{ color: "var(--ink-3)", fontWeight: 400 }}> · {slot.sub}</span>}
                    </span>
                    {/* The lead mark (2026-10-23): one adult row is the lead — the guest the
                        check-in verification is for. A child row never carries it. */}
                    {slot.key.startsWith("A") &&
                      (() => {
                        const isLead = slot.key === leadKey;
                        const blocked = !isLead && (lockedFor(leadKey) || lockedFor(slot.key));
                        return (
                          <label
                            title={
                              isLead
                                ? "The lead — the guest the check-in verification is for"
                                : blocked
                                  ? 'Confirmed — choose "Make changes" first'
                                  : `Make ${displayName} the lead`
                            }
                            style={{
                              marginLeft: 8,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              padding: "1px 6px 1px 4px",
                              borderRadius: 4,
                              border: `1px solid ${isLead ? "var(--ok)" : "var(--line-2)"}`,
                              background: isLead ? "var(--green-t)" : "transparent",
                              color: isLead ? "var(--ok)" : "var(--ink-3)",
                              fontSize: 10.5,
                              fontWeight: isLead ? 700 : 500,
                              cursor: isLead ? "default" : blocked ? "not-allowed" : "pointer",
                              opacity: blocked ? 0.55 : 1,
                              verticalAlign: "middle",
                            }}
                          >
                            <input
                              type="radio"
                              name={`lead-${entryId}`}
                              aria-label={`${displayName} is the lead`}
                              checked={isLead}
                              disabled={blocked || leadM.isPending}
                              onChange={() => leadM.mutate(slot)}
                              style={{ margin: 0, width: 11, height: 11, accentColor: "var(--ok)" }}
                            />
                            Lead
                          </label>
                        );
                      })()}
                    {savedFlash === slot.key && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "var(--ok)", fontWeight: 600 }}>saved</span>
                    )}
                    {/* Locked rows carry only a glyph (2026-08-21, operator ruling: one overall
                        Confirm / Make changes below the table, no per-row controls). */}
                    {locked && (
                      <span
                        style={{ marginLeft: 6, display: "inline-flex", alignItems: "center", color: "var(--ok)" }}
                        title={`Confirmed ${fmtDateTime(detailRow(slot.key)!.detailsConfirmedAt!, HOTEL_TZ_DEFAULT)} — read-only until "Make changes"`}
                      >
                        <Lock style={{ width: 11, height: 11 }} />
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, minWidth: 118 }}>
                    <select
                      className="dinput"
                      style={cell}
                      disabled={locked}
                      value={draft.docType}
                      onChange={(e) => setDraft(slot.key, { docType: e.target.value })}
                      onBlur={() => saveIfChanged(slot)}
                    >
                      <option value="">—</option>
                      {docTypes.map((t) => (
                        <option key={t.code} value={t.code}>
                          {t.name}
                        </option>
                      ))}
                      {/* A saved type an admin later deactivated stays visible — a select whose
                          value has no option renders blank while keeping the value. */}
                      {draft.docType && !docTypes.some((t) => t.code === draft.docType) && (
                        <option value={draft.docType}>{draft.docType.replace(/_/g, " ")}</option>
                      )}
                    </select>
                  </td>
                  <td style={{ ...td, minWidth: 130 }}>
                    <input
                      className="dinput"
                      style={cell}
                      placeholder="Number on the document"
                      disabled={locked}
                      value={draft.num}
                      onChange={(e) => setDraft(slot.key, { num: e.target.value })}
                      onBlur={() => saveIfChanged(slot)}
                    />
                  </td>
                  <td style={{ ...td, minWidth: 140 }}>
                    <input
                      className="dinput"
                      style={cell}
                      placeholder={slot.placeholder}
                      disabled={locked}
                      value={draft.name}
                      onChange={(e) => setDraft(slot.key, { name: e.target.value })}
                      onBlur={() => saveIfChanged(slot)}
                    />
                  </td>
                  <td style={{ ...td, minWidth: 154 }}>
                    <DobField
                      label={displayName}
                      value={draft.dob}
                      disabled={locked}
                      boxStyle={cell}
                      warn={ageWarn}
                      onChange={(dob) => setDraft(slot.key, { dob })}
                      onDone={() => saveIfChanged(slot)}
                    />
                  </td>
                  <td style={{ ...td, minWidth: 92 }}>
                    <select
                      className="dinput"
                      style={{ ...cell, width: "auto" }}
                      disabled={locked}
                      value={draft.gender}
                      onChange={(e) => {
                        setDraft(slot.key, { gender: e.target.value });
                      }}
                      onBlur={() => saveIfChanged(slot)}
                    >
                      <option value="">—</option>
                      <option value="MALE">Male</option>
                      <option value="FEMALE">Female</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {/* ONE ID per guest (2026-08-12 ruling): only the NEWEST photo renders —
                        a retake/re-upload replaces it on screen (the write-once store keeps
                        the earlier bytes as evidence, but they're no longer "the ID").
                        Thumb above; the two buttons stay one horizontal row. */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {photos.length > 0 && photoChips(photos.slice(0, 1), false, (drafts[slot.key]?.name ?? "").trim() || slot.label)}
                      {covered && suggestion && <OcrProgress suggestion={suggestion} fetchedAt={listQuery.dataUpdatedAt} />}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busySlot !== null}
                          onClick={() => pickFor(slot, fileRef.current)}
                          title={
                            covered
                              ? `Replace ${slot.label}'s ID — upload a new image or PDF scan; the current one is superseded`
                              : `Upload ${slot.label}'s ID — image or PDF scan`
                          }
                        >
                          <Upload style={{ width: 13, height: 13 }} />
                          {busySlot === slot.key ? "…" : ""}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={phoneM.isPending}
                          onClick={() => phoneM.mutate(slot)}
                          title={`Hand capture to a phone — a QR code opens the camera page for ${slot.label}; the photo appears here the moment it's sent`}
                        >
                          <Smartphone style={{ width: 13, height: 13 }} />
                        </button>
                        {covered && (suggestion?.status !== "PENDING" || suggestion.stalled) && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={rerunOcrM.isPending}
                            onClick={() => rerunOcrM.mutate(photos[0].id)}
                            title="Read the ID photo (passport strip / Aadhaar QR) and suggest the details for this row"
                          >
                            <ScanLine style={{ width: 13, height: 13 }} />
                          </button>
                        )}
                        {(covered || !sameDraft(draft, EMPTY_DRAFT)) && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={locked || clearM.isPending}
                            onClick={() => openClear(slot)}
                            aria-label={`Clear ${displayName}'s row`}
                            title={
                              locked
                                ? 'These details are confirmed — choose "Make changes" first'
                                : `Clear ${displayName}'s details, ID photo or both`
                            }
                          >
                            <Eraser style={{ width: 13, height: 13 }} />
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              );
              const rowsForSlot: React.ReactNode[] = [row];
              if (ageRow) rowsForSlot.push(ageRow);
              if (suggestionRow) rowsForSlot.push(suggestionRow);
              return rowsForSlot;
              });
              return bandRow ? [bandRow, ...guestRows] : guestRows;
            })}
          </tbody>
        </table>
      </div>

      {/* One act under the table, at its bottom right (2026-10-29) — see confirmAllM. */}
      {slots.length > 0 && (
        <div className="id-confirm">
          {allLocked && !needsVerify ? (
            <>
              <span className="id-confirm-done">
                <Lock style={{ width: 13, height: 13 }} />
                {checkInGate && identityVerified
                  ? `Guest details confirmed · identity verified${recordedPath ? ` (${PATH_WORD[recordedPath] ?? recordedPath})` : ""}`
                  : "Guest details confirmed — the table is locked"}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={confirmM.isPending}
                onClick={() => confirmM.mutate({ slots, confirmed: false })}
                title="Unlock every guest's details so a mistake can be corrected"
              >
                Make changes
              </button>
            </>
          ) : (
            (() => {
              // Why it waits, said beside it — a refusal the desk can act on.
              const why = !checkInGate
                ? confirmableSlots.length === 0
                  ? "Nothing is recorded for any guest yet"
                  : null
                : needsVerify && detailsIncomplete
                  ? `Every guest's details first${coverage ? ` — ${coverage.filledSlots} of ${coverage.totalSlots} recorded` : ""}`
                  : needsVerify && verifyMissing
                    ? `${primaryLabel}'s document ${verificationPath === "FIRST_TIME" ? "type and number" : "type"} first — the lead's row`
                    : !needsVerify && confirmableSlots.length === 0
                      ? "Nothing is recorded for any guest yet"
                      : null;
              const ready = !why && !!guest?.id;
              return (
                <>
                  <span className={`id-confirm-note${why ? " wait" : ""}`}>
                    {why ??
                      (needsVerify
                        ? verificationPath === "VIP"
                          ? "Records the VIP path and locks the rows"
                          : verifyNeedsDocument
                            ? `Records ${primaryLabel}'s ${docTypes.find((t) => t.code === primaryDraft.docType)?.name ?? primaryDraft.docType}${
                                verificationPath === "FIRST_TIME" && primaryDraft.num.trim() ? ` ${primaryDraft.num.trim()}` : ""
                              } as verified and locks the rows`
                            : "Records the verification and locks the rows"
                        : confirmedSlotCount > 0
                          ? `${confirmedSlotCount} of ${slots.length} confirmed — this locks the rest`
                          : "Locks every row as recorded")}
                  </span>
                  <Help label="About confirming">
                    {checkInGate ? (
                      <>
                        One press: anything not saved yet is saved, the identity is recorded as verified — the check the check-in needs,
                        under the guest type chosen above — and every guest&rsquo;s row is locked. &ldquo;Make changes&rdquo; opens
                        them again; a different guest type then records the verification again.
                      </>
                    ) : (
                      <>Locks every guest&rsquo;s row as recorded; &ldquo;Make changes&rdquo; opens them again. The identity is verified at Check-in.</>
                    )}
                  </Help>
                  <button
                    type="button"
                    className="btn btn-primary btn-go"
                    disabled={!ready || confirmAllM.isPending || saveM.isPending}
                    onClick={() => confirmAllM.mutate()}
                  >
                    <Lock style={{ width: 14, height: 14 }} />
                    {needsVerify && identityVerified ? "Confirm guest details again" : "Confirm guest details"}
                  </button>
                </>
              );
            })()
          )}
        </div>
      )}

      {unassigned.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 4 }}>
            Stored on this booking without a named guest
          </div>
          {photoChips(unassigned, true)}
        </div>
      )}

      {earlierStays.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 4 }}>
            On file from earlier stays
          </div>
          {photoChips(earlierStays, true)}
        </div>
      )}

      {listQuery.isLoading && <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "8px 0 0" }}>Loading stored details…</p>}

      <HelpHere label="About this table">
        Details save as you leave each field. One ID per guest — upload a scan or hand capture to a
        phone with the QR button; taking or uploading a new one replaces the current ID. Photos are
        stored privately on the hotel server (never in a public link) and kept per the ID retention
        policy.{" "}
        {checkInGate ? (
          <>
            Confirm guest details, under the table, records the identity verification the check-in
            needs and locks the rows in one press.
          </>
        ) : inHouse ? (
          <>
            The guest is already checked in — this is where details recorded earlier get corrected.
          </>
        ) : (
          <>
            Everything recorded here carries to Check-in, where each guest needs a document number
            or an ID photo on file before the check-in (VIP bookings exempt); the identity is
            verified there, with the same Confirm guest details.
          </>
        )}{" "}
        <b>Confirm guest details</b> locks the table as recorded — it stays locked at every later
        stage until someone chooses <b>Make changes</b>.
      </HelpHere>
        </>
      )}

      <IdPhotoViewerHost />

      {clearFor &&
        (() => {
          const draft = drafts[clearFor.key] ?? EMPTY_DRAFT;
          const name = draft.name.trim() || clearFor.label;
          const typeName = draft.docType ? (docTypes.find((d) => d.code === draft.docType)?.name ?? draft.docType) : null;
          const facts = [typeName, draft.num.trim() || null, draft.name.trim() || null, draft.dob || null, draft.gender ? (({ MALE: "Male", FEMALE: "Female", OTHER: "Other" } as Record<string, string>)[draft.gender] ?? draft.gender) : null].filter(Boolean);
          const hasDetails = facts.length > 0;
          const photoCount = photosFor(clearFor.key).length;
          const any = (clearDetails && hasDetails) || (clearPhoto && photoCount > 0);
          return (
            <DsDialog
              open
              onClose={() => !clearM.isPending && setClearFor(null)}
              register="danger"
              title={`Clear ${name}'s row`}
              busy={clearM.isPending}
              help={
                <>
                  Cleared details go back to empty. A cleared photo leaves this row and stops counting for check-in;
                  the file itself stays in the hotel&rsquo;s records, and a new photo can be taken straight away.
                </>
              }
              footer={
                <>
                  <NotNow onClick={() => setClearFor(null)} busy={clearM.isPending} />
                  <Button
                    kind="danger"
                    solid
                    state={clearM.isPending ? "working" : any ? "default" : "inert"}
                    workingLabel="Clearing…"
                    title={any ? undefined : "tick what to clear"}
                    onClick={() => clearM.mutate({ slot: clearFor, details: clearDetails && hasDetails, photo: clearPhoto && photoCount > 0 })}
                  >
                    Clear
                  </Button>
                </>
              }
            >
              <div className="field">
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: hasDetails ? "pointer" : "default", opacity: hasDetails ? 1 : 0.55 }}>
                  <input type="checkbox" checked={clearDetails && hasDetails} disabled={!hasDetails} onChange={(e) => setClearDetails(e.target.checked)} />
                  <span>
                    <b>The details</b>
                    <span className="sm" style={{ display: "block", color: "var(--ink-2)" }}>{hasDetails ? facts.join(" · ") : "nothing typed"}</span>
                  </span>
                </label>
              </div>
              <div className="field">
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: photoCount ? "pointer" : "default", opacity: photoCount ? 1 : 0.55 }}>
                  <input type="checkbox" checked={clearPhoto && photoCount > 0} disabled={!photoCount} onChange={(e) => setClearPhoto(e.target.checked)} />
                  <span>
                    <b>The ID photo</b>
                    <span className="sm" style={{ display: "block", color: "var(--ink-2)" }}>
                      {photoCount ? (photoCount > 1 ? `${photoCount} photos on this row` : "the photo on this row") : "no photo"}
                    </span>
                  </span>
                </label>
              </div>
            </DsDialog>
          );
        })()}

      <DeskConfirmModal
        open={seatingOpen}
        title="Seat every guest in a room"
        subtitle="Restores the room plan's occupants — nobody changes rooms"
        why="The recorded composition leaves guests without a room, or a room without guests. Seating them re-records the booking's current rooms with everyone in one."
        consequences={[
          "A new pass opens and the stay is re-priced silently on the same rooms — nothing is sent to the guest.",
          "Guests without a room are seated in the emptiest room with space on every night they stay; a room that had nobody recorded gets them on room-only (set meals through the room-change table if needed).",
          "The audit trail records this as a system seating repair with exactly who went where.",
        ]}
        confirmLabel="Seat everyone"
        pending={repairSeatingM.isPending}
        onConfirm={() => repairSeatingM.mutate()}
        onClose={() => setSeatingOpen(false)}
      />

      {/* Phone-capture QR modal (2026-08-12): scanning opens /capture#<token> on the phone —
          no staff login there, the scoped 15-min token is the whole credential. The proofs
          query polls while this is open, so arrivals show below the QR (and in the table)
          the moment the phone sends them. */}
      {phoneCapture && (
        <div
          onClick={() => setPhoneCapture(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(44, 42, 37, 0.45)",
            zIndex: 90,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--panel, #fff)",
              borderRadius: "var(--r-lg, 14px)",
              border: "1px solid var(--line-2)",
              boxShadow: "0 18px 50px rgba(0,0,0,0.25)",
              width: "min(380px, 100%)",
              padding: "18px 20px 20px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Smartphone style={{ width: 15, height: 15, color: "var(--ink-3)" }} />
              <span style={{ fontSize: 13.5, fontWeight: 700 }}>
                {phoneCapture.slot
                  ? `Photograph ${(drafts[phoneCapture.slot.key]?.name ?? "").trim() || phoneCapture.slot.label}’s ID on a phone`
                  : `Photograph every guest's ID on a phone`}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setPhoneCapture(null)}
                style={{ marginLeft: "auto" }}
                title="Close"
              >
                <X style={{ width: 14, height: 14 }} />
              </button>
            </div>
            <div style={{ display: "flex", justifyContent: "center", padding: "6px 0" }}>
              <div style={{ background: "#fff", padding: 10, borderRadius: 10, border: "1px solid var(--line-2)" }}>
                <QRCodeSVG value={phoneCapture.url} size={196} marginSize={0} />
              </div>
            </div>
            <p style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
              Scan with the phone&rsquo;s camera — same Wi-Fi as the desk.
              <Help label="About the phone">
                {phoneCapture.slot
                  ? "The page that opens takes the photo, offers a retake, and sends it straight here — no login needed on the phone."
                  : "The page lists every guest on this booking — photograph each one and every photo lands on the right row here. No login needed on the phone."}{" "}
                If the ID carries a QR code (Aadhaar, work permit…) or a passport strip, the phone reads the details off it automatically
                and they arrive here as a suggestion.
              </Help>
            </p>
            <div
              style={{
                fontSize: 10.5,
                fontFamily: "var(--font-plex-mono), monospace",
                color: "var(--ink-3)",
                wordBreak: "break-all",
                background: "var(--cream)",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--r-sm)",
                padding: "6px 8px",
              }}
              title="The same link the QR encodes — type it on the phone if scanning is awkward"
            >
              {phoneCapture.url}
            </div>
            {phoneReceived > 0 ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: "var(--ok)" }}>
                <Check style={{ width: 14, height: 14 }} />
                {phoneReceived} photo{phoneReceived === 1 ? "" : "s"} received — showing in the table
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Waiting for photos from the phone…</div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                Code valid until {fmtTime(phoneCapture.expiresAt, HOTEL_TZ_DEFAULT)}
              </span>
              <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: "auto" }} onClick={() => setPhoneCapture(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
