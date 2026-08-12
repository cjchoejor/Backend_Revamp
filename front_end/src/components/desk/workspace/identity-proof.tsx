"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, FileText, Fingerprint, Smartphone, Upload, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { verifyGuestIdentity, type VerificationPath } from "@/lib/api/check-in";
import { fetchPdfObjectUrl } from "@/lib/api/documents";
import { getChildPolicy } from "@/lib/api/child-policy";
import { listRooms } from "@/lib/api/rooms";
import {
  identityProofFileUrl,
  listIdentityProofs,
  mintPhoneCaptureToken,
  saveGuestIdentityDetail,
  uploadIdentityProof,
  type IdentityProofSummary,
} from "@/lib/api/identity-proofs";
import { seatPartyByComposition } from "@/lib/desk/party-rooms";
import { StepAction } from "./step-action";
import type { EntryDetail } from "@/types/api";

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
function ProofThumb({ proof, size = 40 }: { proof: IdentityProofSummary; size?: number }) {
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

  const open = async () => {
    if (!session) return;
    try {
      // Images reuse the already-fetched blob; PDFs (and failed thumbs) fetch on demand.
      const u = url ?? (await fetchPdfObjectUrl(session, identityProofFileUrl(proof.id)));
      const win = window.open(u, "_blank");
      if (win) win.opener = null;
      if (!url) setTimeout(() => URL.revokeObjectURL(u), 60_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open the file");
    }
  };

  return (
    <button
      type="button"
      onClick={open}
      title={`${(proof.documentType ?? "ID").replace(/_/g, " ")} · ${proof.capturedAt.slice(0, 16).replace("T", " ")} — open full size`}
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
    refetchInterval: phoneCapture ? 3000 : false,
  });
  const items = listQuery.data?.items ?? [];
  // Config-driven (`identity.documentTypes`) — same vocabulary the S6 verification validates
  // against, so nothing offered here can be rejected there.
  const docTypes = listQuery.data?.documentTypes ?? [];
  const coverage = listQuery.data?.coverage;
  const returning = listQuery.data?.returningGuest ?? null;

  // Identity VERIFICATION (S6 only — `checkInGate`): moved here from its own block.
  const guest = entry.guestProfile;
  const isVip = !!guest?.vipTier?.trim();
  const identityVerified = !!guest?.identityVerifiedAt;
  const [verificationPath, setVerificationPath] = useState<VerificationPath>(isVip ? "VIP" : "RETURNING_VALID");
  const [pulledFromFile, setPulledFromFile] = useState(false);
  const autoPullRef = useRef(false);

  useEffect(() => {
    setVerificationPath(isVip ? "VIP" : "RETURNING_VALID");
  }, [isVip, guest?.id]);

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

  const detailRow = (key: string) => items.find((p) => p.entryId === entryId && p.subjectKey === key && !p.hasFile);
  const photosFor = (key: string) => items.filter((p) => p.entryId === entryId && p.subjectKey === key && p.hasFile);

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

  /** Blur handler — persists the row when anything actually changed. */
  const saveIfChanged = (slot: PartySlot) => {
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
    const slot = slots.find((s) => s.key === "A0");
    if (!slot) return;
    const row = detailRow("A0");
    if (row?.documentNumber) return;
    autoPullRef.current = true;
    const draft: DetailDraft = { ...draftFromRow(row), num: returning.documentNumber };
    setDrafts((prev) => ({ ...prev, A0: draft }));
    setPulledFromFile(true);
    saveM.mutate({ slot, draft });
    toast.info(`Document number on file (${returning.documentNumber}) pulled into ${slot.label} — confirm it belongs to this guest`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot, keyed on the fetched snapshot
  }, [listQuery.data, session]);

  // The verification panel carries NO document fields of its own (2026-08-12, operator
  // ruling — the guest-detail table below is the ONLY place document type/number are typed).
  // Paths that need a document read it off the MAIN GUEST's row (A0); the button stays
  // locked until that row holds what the chosen path requires.
  const primaryDraft = drafts["A0"] ?? EMPTY_DRAFT;
  const primaryLabel = primaryDraft.name.trim() || slots.find((s) => s.key === "A0")?.label || "the main guest";
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
      toast.success("Identity verified");
      void queryClient.invalidateQueries({ queryKey: ["entry", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Verification failed"),
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

  const photoChips = (proofs: IdentityProofSummary[], showSubject = false) => (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
      {proofs.map((p) => (
        <div key={p.id} style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "center" }}>
          <ProofThumb proof={p} />
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
      </div>

      {!open && (
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0 }}>
          {coverage
            ? `${coverage.filledSlots} of ${coverage.totalSlots} guest${coverage.totalSlots === 1 ? "" : "s"} recorded`
            : "Guest documents & details"}{" "}
          — click the header to open. Everything here carries to Check-in.
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

      {/* Toolbar above the table (2026-08-12, operator ruling — the boxed "Identity
          verification" section is gone; the TABLE is the verification form): S6 puts the
          verification-path select here, the whole-party phone QR sits right. "Record
          verification" waits at the table's bottom. */}
      {(slots.length > 1 || (checkInGate && !identityVerified)) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 10, marginBottom: 6 }}>
          {checkInGate && !identityVerified ? (
            <div className="field" style={{ width: "min(240px, 100%)" }}>
              <label>Verification path</label>
              {/* Defaults to the VIP path for VIP profiles but is never locked (operator
                  ruling 2026-08-11 — the dropdown stays freely selectable). */}
              <select value={verificationPath} onChange={(e) => setVerificationPath(e.target.value as VerificationPath)}>
                <option value="FIRST_TIME">First-time guest</option>
                <option value="RETURNING_VALID">Returning — ID valid</option>
                <option value="RETURNING_EXPIRED">Returning — ID expired</option>
                <option value="VIP">VIP path</option>
              </select>
            </div>
          ) : (
            <span />
          )}
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
              const guestRows = group.items.map((slot) => {
              const draft = drafts[slot.key] ?? EMPTY_DRAFT;
              const photos = photosFor(slot.key);
              const covered = photos.length > 0;
              // A typed name replaces the generic "Adult 2" label live (the age stays as a
              // muted suffix on child rows so the band is never hidden by a name).
              const typedName = draft.name.trim();
              const displayName = typedName || slot.label;
              return (
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
                    {savedFlash === slot.key && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "var(--ok)", fontWeight: 600 }}>saved</span>
                    )}
                  </td>
                  <td style={{ ...td, minWidth: 118 }}>
                    <select
                      style={cellInput}
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
                      style={cellInput}
                      placeholder="Number on the document"
                      value={draft.num}
                      onChange={(e) => setDraft(slot.key, { num: e.target.value })}
                      onBlur={() => saveIfChanged(slot)}
                    />
                  </td>
                  <td style={{ ...td, minWidth: 140 }}>
                    <input
                      className="dinput"
                      style={cellInput}
                      placeholder={slot.placeholder}
                      value={draft.name}
                      onChange={(e) => setDraft(slot.key, { name: e.target.value })}
                      onBlur={() => saveIfChanged(slot)}
                    />
                  </td>
                  <td style={{ ...td, minWidth: 128 }}>
                    <input
                      className="dinput"
                      style={cellInput}
                      type="date"
                      value={draft.dob}
                      onChange={(e) => setDraft(slot.key, { dob: e.target.value })}
                      onBlur={() => saveIfChanged(slot)}
                    />
                  </td>
                  <td style={{ ...td, minWidth: 92 }}>
                    <select
                      style={{ ...cellInput, width: "auto" }}
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
                      {photos.length > 0 && photoChips(photos.slice(0, 1))}
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
                      </div>
                    </div>
                  </td>
                </tr>
              );
              });
              return bandRow ? [bandRow, ...guestRows] : guestRows;
            })}
          </tbody>
        </table>
      </div>

      {/* Record verification — the table's bottom action (2026-08-12, operator ruling: no
          boxed section; the path select sits above the table and THIS is the sign-off). It
          stamps `identityVerifiedAt` — the vouching act that a human checked the documents
          against the guests — and unlocks only once every guest's details are in the table
          (same coverage as the check-in gate; VIP exempt). Document-needing paths record the
          MAIN guest's row. S6 only. */}
      {checkInGate && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {!identityVerified &&
            (verificationPath === "VIP" ? (
              <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
                VIP path — no guest details needed to record the verification.
              </p>
            ) : detailsIncomplete ? (
              <p style={{ fontSize: 11.5, color: "var(--warn)", margin: 0, lineHeight: 1.5 }}>
                Every guest&rsquo;s details go in the table above first
                {coverage ? ` — ${coverage.filledSlots} of ${coverage.totalSlots} recorded` : ""}. The
                verification unlocks when the table is complete.
              </p>
            ) : verifyNeedsDocument ? (
              <p
                style={{
                  fontSize: 11.5,
                  color: verifyMissing ? "var(--warn)" : "var(--ink-3)",
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                {verifyMissing
                  ? `Fill ${primaryLabel}'s document ${
                      verificationPath === "FIRST_TIME" ? "type and number" : "type"
                    } in the table above first — the verification records what's on that row.`
                  : `Records ${primaryLabel}'s document from the table above (${
                      docTypes.find((t) => t.code === primaryDraft.docType)?.name ?? primaryDraft.docType
                    }${verificationPath === "FIRST_TIME" && primaryDraft.num.trim() ? ` · ${primaryDraft.num.trim()}` : ""}).`}
              </p>
            ) : null)}
          <StepAction
            className="btn btn-primary"
            label="Record verification"
            doneLabel={`Verified${guest?.identityVerificationPath ? ` · ${guest.identityVerificationPath}` : ""}`}
            done={identityVerified}
            pending={verifyM.isPending}
            disabled={!guest?.id || verifyMissing || detailsIncomplete}
            onClick={() => verifyM.mutate()}
          />
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

      <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "8px 0 0", lineHeight: 1.5 }}>
        Details save as you leave each field. One ID per guest — upload a scan or hand capture to a
        phone with the QR button; taking or uploading a new one replaces the current ID. Photos are
        stored privately on the hotel server (never in a public link) and kept per the ID retention
        policy.{" "}
        {checkInGate ? (
          <>
            This table is the evidence; the identity <i>verification</i> panel at the top is the
            act that vouches a human checked the documents against the guests.
          </>
        ) : (
          <>
            Everything recorded here carries to Check-in, where each guest needs a document number
            or an ID photo on file before &ldquo;Check in &amp; go live&rdquo; (VIP bookings
            exempt); the identity <i>verification</i> itself is recorded there.
          </>
        )}
      </p>
        </>
      )}

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
            <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
              {phoneCapture.slot
                ? "Scan with the phone's camera (same Wi-Fi as the desk). The page that opens takes the photo, offers a retake, and sends it straight here — no login needed on the phone."
                : "Scan with the phone's camera (same Wi-Fi as the desk). The page lists every guest on this booking — photograph each one and every photo lands on the right row here. No login needed on the phone."}
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
                Code valid until {new Date(phoneCapture.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
