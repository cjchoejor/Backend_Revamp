"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, FileText, Fingerprint, Upload } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { fetchPdfObjectUrl } from "@/lib/api/documents";
import { getChildPolicy } from "@/lib/api/child-policy";
import { listRooms } from "@/lib/api/rooms";
import {
  identityProofFileUrl,
  listIdentityProofs,
  saveGuestIdentityDetail,
  uploadIdentityProof,
  type IdentityProofSummary,
} from "@/lib/api/identity-proofs";
import { seatPartyByComposition } from "@/lib/desk/party-rooms";
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
 *  Entries without a party breakdown fall back to `guestCount` anonymous slots. */
function partySlots(entry: EntryDetail): PartySlot[] {
  const g = entry.guestProfile;
  const primaryName = [g?.firstName, g?.lastName].filter(Boolean).join(" ").trim();
  const adults = Math.max(0, entry.adultCount ?? 0);
  const childAges = entry.childAges ?? [];
  const slots: PartySlot[] = [];
  if (adults > 0 || childAges.length > 0) {
    for (let i = 0; i < adults; i++) {
      slots.push({
        key: `A${i}`,
        label: i === 0 && primaryName ? primaryName : `Adult ${i + 1}`,
        placeholder: i === 0 && primaryName ? primaryName : `Name as on the document`,
      });
    }
    childAges.forEach((age, i) => {
      slots.push({ key: `K${i}`, label: `Child ${i + 1} · ${age}y`, sub: `${age}y`, placeholder: "Name as on the document" });
    });
  } else {
    const n = Math.max(1, entry.guestCount ?? 1);
    for (let i = 0; i < n; i++) {
      slots.push({
        key: `A${i}`,
        label: i === 0 && primaryName ? primaryName : `Guest ${i + 1}`,
        placeholder: i === 0 && primaryName ? primaryName : `Name as on the document`,
      });
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
}: {
  entry: EntryDetail;
  /** S6 rendering (2026-08-11): shows the check-in gate strip — details are REQUIRED for every
   *  guest before "Check in & go live" (VIP bookings exempt). S5 leaves this off. */
  checkInGate?: boolean;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, DetailDraft>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Which guest the open picker is capturing for — set at button-click time, read on change.
  const pendingSlotRef = useRef<PartySlot | null>(null);

  const entryId = entry.id;
  const slots = partySlots(entry);

  const listQuery = useQuery({
    queryKey: ["identity-proofs", entryId],
    queryFn: () => listIdentityProofs(session!, entryId),
    enabled: !!session,
  });
  const items = listQuery.data?.items ?? [];
  // Config-driven (`identity.documentTypes`) — same vocabulary the S6 verification validates
  // against, so nothing offered here can be rejected there.
  const docTypes = listQuery.data?.documentTypes ?? [];
  const coverage = listQuery.data?.coverage;

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
    const m = new Map<string, { roomNumber: string; bedType?: string | null }>();
    for (const r of roomsQuery.data?.items ?? []) m.set(r.id, { roomNumber: r.roomNumber, bedType: r.bedType });
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

  const onFiles = async (files: FileList | null) => {
    const slot = pendingSlotRef.current;
    if (!files || files.length === 0 || !session || !slot) return;
    setBusySlot(slot.key);
    try {
      const name = (drafts[slot.key]?.name ?? "").trim();
      for (const file of Array.from(files)) {
        await uploadIdentityProof(session, entryId, file, {
          subjectKey: slot.key,
          subjectLabel: name || slot.label,
        });
      }
      toast.success(`ID proof stored for ${name || slot.label}`);
      void queryClient.invalidateQueries({ queryKey: ["identity-proofs", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entryId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusySlot(null);
      pendingSlotRef.current = null;
      // Allow re-selecting the same file (e.g. retake after a failure).
      if (cameraRef.current) cameraRef.current.value = "";
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const pickFor = (slot: PartySlot, input: HTMLInputElement | null) => {
    pendingSlotRef.current = slot;
    input?.click();
  };

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
      <div className="block-h">
        <Fingerprint style={{ width: 13, height: 13 }} />
        Guest details &amp; ID proof
        <span className="ln" />
        {slots.length > 0 && (
          <span className={`tag${allCovered ? "" : " warn"}`}>
            {coveredCount} of {slots.length} ID{slots.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {/* Shared pickers — camera-first input opens the camera on phones/tablets; desktops fall
          back to the file dialog. Which guest they capture for is set at button-click time. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onFiles(e.target.files)} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => void onFiles(e.target.files)} />

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
            {slots.map((slot) => {
              const draft = drafts[slot.key] ?? EMPTY_DRAFT;
              const photos = photosFor(slot.key);
              const covered = photos.length > 0;
              // A typed name replaces the generic "Adult 2" label live (the age stays as a
              // muted suffix on child rows so the band is never hidden by a name).
              const typedName = draft.name.trim();
              const displayName = typedName || slot.label;
              const room = roomBySlot.get(slot.key);
              const roomInfo = room ? roomInfoById.get(room) : undefined;
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
                    {roomInfo && (
                      <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginLeft: 19, marginTop: 1 }} title="From the room placement on the Quote step's guest board">
                        Room {roomInfo.roomNumber}
                        {roomInfo.bedType ? ` · ${roomInfo.bedType.charAt(0)}${roomInfo.bedType.slice(1).toLowerCase()}` : ""}
                      </div>
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
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {photos.length > 0 && photoChips(photos)}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busySlot !== null}
                        onClick={() => pickFor(slot, cameraRef.current)}
                        title={`Photograph ${slot.label}'s document — opens the camera on a phone or tablet`}
                      >
                        <Camera style={{ width: 13, height: 13 }} />
                        {busySlot === slot.key ? "…" : ""}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busySlot !== null}
                        onClick={() => pickFor(slot, fileRef.current)}
                        title={`Upload ${slot.label}'s document — image or PDF scan, front and back together is fine`}
                      >
                        <Upload style={{ width: 13, height: 13 }} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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
        Details save as you leave each field. Photos are stored privately on the hotel server
        (never in a public link) and kept per the ID retention policy — the camera button opens the
        device camera on a phone or tablet.{" "}
        {checkInGate ? (
          <>
            This table is the evidence; the identity <i>verification</i> itself is recorded in the
            Guest identity block below.
          </>
        ) : (
          <>
            Everything recorded here carries to Check-in, where each guest needs a document number
            or an ID photo on file before &ldquo;Check in &amp; go live&rdquo; (VIP bookings
            exempt); the identity <i>verification</i> itself is recorded there.
          </>
        )}
      </p>
    </div>
  );
}
