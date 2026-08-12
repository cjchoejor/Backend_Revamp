"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Check, ImagePlus, RefreshCcw, ShieldCheck, Upload } from "lucide-react";
import {
  fetchPhoneCaptureContext,
  uploadPhoneCapture,
  type PhoneCaptureContext,
  type PhoneCaptureRoom,
  type PhoneCaptureRosterItem,
} from "@/lib/api/identity-proofs";

/**
 * Phone ID-capture page (2026-08-12) — what opens when a phone scans the QR code the desk
 * shows on the guest-detail table. The token in the URL HASH is the whole credential (a hash
 * never reaches server logs; the page reads it client-side): no staff login on the phone,
 * no access to anything but "upload ID photos for this booking".
 *
 * Two modes, decided by the token: a SINGLE-GUEST link captures for the one slot pinned in
 * the token; an ALL-GUESTS link (context returns `roster`) lists the whole party so the
 * phone can walk guest to guest — each photo files under the slot picked here, and the
 * upload route validates that pick against the booking's party, so photos can only ever
 * land on real party members.
 *
 * Deliberately built on a plain `<input type="file" capture>` rather than getUserMedia: the
 * native camera works over plain HTTP on a LAN IP, where getUserMedia requires a secure
 * context and would show a black screen. The native camera app also gives the guest-facing
 * retake loop for free; the page adds its own preview + Retake before anything uploads.
 *
 * Standalone surface — not under the desk shell, no session, self-contained styles.
 */

const palette = {
  bg: "#f7f4ec",
  card: "#ffffff",
  ink: "#2c2a25",
  ink3: "#8a8578",
  line: "#e5e0d3",
  green: "#3d5a3c",
  greenDark: "#2f4630",
  cream: "#efe9db",
  warnBg: "#fdf3e0",
  warnLine: "#d9a441",
  errBg: "#faeae6",
  errLine: "#c0603f",
};

const btnBase: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  width: "100%",
  padding: "16px 18px",
  borderRadius: 14,
  fontSize: 16,
  fontWeight: 600,
  border: `1px solid ${palette.line}`,
  background: palette.card,
  color: palette.ink,
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  ...btnBase,
  background: palette.green,
  borderColor: palette.greenDark,
  color: "#fff",
};

type Phase = "checking" | "invalid" | "ready" | "preview" | "uploading";

/** "Room 205 · Twin · Deluxe Double" — the guest's seated room per the booking's quote.
 *  `compact` drops the room-type name so list rows keep space for the photo count. */
function roomText(room: PhoneCaptureRoom | null | undefined, compact = false): string | null {
  if (!room) return null;
  const bed = room.bedType ? `${room.bedType.charAt(0)}${room.bedType.slice(1).toLowerCase()}` : null;
  return [`Room ${room.roomNumber}`, bed, compact ? null : room.roomTypeName].filter(Boolean).join(" · ");
}

export default function PhoneCapturePage() {
  const [token, setToken] = useState<string | null>(null);
  const [ctx, setCtx] = useState<PhoneCaptureContext | null>(null);
  const [roster, setRoster] = useState<PhoneCaptureRosterItem[] | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const [lastSentFor, setLastSentFor] = useState<string | null>(null);
  // All-guests mode: which party member the open camera is capturing for.
  const [activeSlot, setActiveSlot] = useState<PhoneCaptureRosterItem | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  // The token travels in the hash so it never appears in server request logs.
  useEffect(() => {
    const t = window.location.hash.replace(/^#/, "").trim();
    if (!t) {
      setPhase("invalid");
      setError("This page needs the QR code's link — scan the code the desk is showing.");
      return;
    }
    setToken(t);
    fetchPhoneCaptureContext(t)
      .then((c) => {
        setCtx(c);
        setRoster(c.roster);
        if (c.sealed) {
          setPhase("invalid");
          setError("This booking has been closed — nothing more can be added to it.");
        } else {
          setPhase("ready");
        }
      })
      .catch((e) => {
        setPhase("invalid");
        setError(e instanceof Error ? e.message : "This capture link is invalid or has expired.");
      });
  }, []);

  // Object-URL lifecycle for the preview image.
  useEffect(() => {
    if (!pendingFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(pendingFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  const allMode = !!roster;

  const openPicker = (input: HTMLInputElement | null, slot: PhoneCaptureRosterItem | null) => {
    setActiveSlot(slot);
    input?.click();
  };

  const onPicked = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setPendingFile(file);
    setPhase("preview");
    // Allow re-picking the same file (retake produces a same-named capture on some phones).
    if (cameraRef.current) cameraRef.current.value = "";
    if (galleryRef.current) galleryRef.current.value = "";
  };

  const upload = async () => {
    if (!token || !pendingFile) return;
    if (allMode && !activeSlot) return;
    setPhase("uploading");
    setError(null);
    try {
      await uploadPhoneCapture(token, pendingFile, pendingFile.name, allMode ? activeSlot!.key : undefined);
      setSentCount((n) => n + 1);
      setLastSentFor(allMode ? activeSlot!.label : null);
      setPendingFile(null);
      setPhase("ready");
      if (allMode) {
        // Bump the row immediately, then resync counts (and any typed names) from the server.
        setRoster((prev) =>
          prev?.map((s) => (s.key === activeSlot!.key ? { ...s, photoCount: s.photoCount + 1 } : s)) ?? prev,
        );
        fetchPhoneCaptureContext(token)
          .then((c) => setRoster(c.roster))
          .catch(() => {
            /* keep the optimistic counts — the next upload resyncs */
          });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed — try again.");
      setPhase("preview");
    }
  };

  const guestLabel = allMode ? (activeSlot?.label ?? "this guest") : (ctx?.subjectLabel?.trim() || "this guest");
  const storedBefore = ctx?.uploadedCount ?? 0;
  const rosterCovered = roster?.filter((s) => s.photoCount > 0).length ?? 0;

  // All-guests list grouped BY ROOM — the room is the primary heading and its guests sit
  // inside the card, rather than repeating "Room 205" under every name. Roster order is
  // preserved (rooms appear in sealed order); guests without a seat gather at the end.
  const roomGroups: { key: string; room: PhoneCaptureRoom | null; items: PhoneCaptureRosterItem[] }[] = [];
  if (roster) {
    for (const s of roster) {
      const key = s.room ? `room-${s.room.roomNumber}` : "unassigned";
      let g = roomGroups.find((x) => x.key === key);
      if (!g) {
        g = { key, room: s.room, items: [] };
        roomGroups.push(g);
      }
      g.items.push(s);
    }
    roomGroups.sort((a, b) => (a.key === "unassigned" ? 1 : 0) - (b.key === "unassigned" ? 1 : 0));
  }

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: palette.bg,
        color: palette.ink,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "28px 18px 40px",
        fontFamily: "var(--font-hanken), system-ui, sans-serif",
      }}
    >
      <div style={{ width: "100%", maxWidth: 440, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: palette.green }}>
          <ShieldCheck style={{ width: 20, height: 20 }} />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3 }}>LEGPHEL · Guest ID capture</span>
        </div>

        {phase === "checking" && (
          <div style={{ background: palette.card, border: `1px solid ${palette.line}`, borderRadius: 16, padding: 22, fontSize: 15, color: palette.ink3 }}>
            Checking this capture link…
          </div>
        )}

        {phase === "invalid" && (
          <div style={{ background: palette.errBg, border: `1px solid ${palette.errLine}`, borderRadius: 16, padding: 22, fontSize: 15, lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        {ctx && phase !== "invalid" && phase !== "checking" && (
          <>
            <div style={{ background: palette.card, border: `1px solid ${palette.line}`, borderRadius: 16, padding: "16px 18px" }}>
              {allMode ? (
                <>
                  <div style={{ fontSize: 13, color: palette.ink3, marginBottom: 2 }}>Photographing IDs for</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>
                    {roster!.length} guest{roster!.length === 1 ? "" : "s"} on this booking
                  </div>
                  <div style={{ fontSize: 12.5, color: palette.ink3, marginTop: 4 }}>Booking {ctx.entryId}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 13.5, color: rosterCovered === roster!.length ? palette.green : palette.ink3, fontWeight: 600 }}>
                    <Check style={{ width: 15, height: 15 }} />
                    {rosterCovered} of {roster!.length} guests have a photo
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 13, color: palette.ink3, marginBottom: 2 }}>Photographing the ID of</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{guestLabel}</div>
                  <div style={{ fontSize: 12.5, color: palette.ink3, marginTop: 4 }}>
                    Booking {ctx.entryId}
                    {roomText(ctx.room) ? ` · ${roomText(ctx.room)}` : ""}
                  </div>
                  {(storedBefore > 0 || sentCount > 0) && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 13.5, color: palette.green, fontWeight: 600 }}>
                      <Check style={{ width: 15, height: 15 }} />
                      {sentCount > 0
                        ? "ID sent — it's on the desk screen now"
                        : "An ID is already on file — retaking replaces it"}
                    </div>
                  )}
                </>
              )}
            </div>

            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPicked(e.target.files)} />
            <input ref={galleryRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => onPicked(e.target.files)} />

            {phase === "ready" && allMode && (
              <>
                {lastSentFor && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, background: palette.card, border: `1px solid ${palette.line}`, borderRadius: 12, padding: "10px 14px", fontSize: 13.5, color: palette.green, fontWeight: 600 }}>
                    <Check style={{ width: 15, height: 15 }} />
                    Sent for {lastSentFor} — it&rsquo;s on the desk screen now
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {roomGroups.map((g) => {
                    const covered = g.items.filter((s) => s.photoCount > 0).length;
                    const allDone = covered === g.items.length;
                    return (
                      <div
                        key={g.key}
                        style={{
                          background: palette.card,
                          border: `1px solid ${allDone ? palette.green : palette.line}`,
                          borderRadius: 16,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 8,
                            padding: "12px 14px 10px",
                            borderBottom: `1px solid ${palette.line}`,
                            background: palette.cream,
                          }}
                        >
                          <span style={{ fontSize: 17, fontWeight: 700 }}>
                            {g.room ? `Room ${g.room.roomNumber}` : "No room assigned yet"}
                          </span>
                          {g.room && (
                            <span style={{ fontSize: 12, color: palette.ink3 }}>
                              {[
                                g.room.bedType ? `${g.room.bedType.charAt(0)}${g.room.bedType.slice(1).toLowerCase()}` : null,
                                g.room.roomTypeName,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          )}
                          <span
                            style={{
                              marginLeft: "auto",
                              fontSize: 12.5,
                              fontWeight: 700,
                              color: allDone ? palette.green : palette.ink3,
                            }}
                          >
                            {covered}/{g.items.length}
                          </span>
                        </div>
                        {g.items.map((s, i) => (
                          <div
                            key={s.key}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "11px 14px",
                              borderTop: i > 0 ? `1px dashed ${palette.line}` : "none",
                            }}
                          >
                            {s.photoCount > 0 ? (
                              <Check style={{ width: 18, height: 18, color: palette.green, flexShrink: 0 }} />
                            ) : (
                              <span style={{ width: 16, height: 16, borderRadius: 999, border: `2px solid ${palette.line}`, flexShrink: 0 }} />
                            )}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {s.label}
                              </div>
                              <div style={{ fontSize: 12, color: palette.ink3 }}>
                                {s.photoCount > 0 ? "ID on file" : "No ID yet"}
                              </div>
                            </div>
                            {/* One ID per guest — capturing again REPLACES the one on file. */}
                            <button
                              type="button"
                              style={{ ...btnPrimary, width: "auto", padding: "10px 14px", fontSize: 14, borderRadius: 12 }}
                              onClick={() => openPicker(cameraRef.current, s)}
                            >
                              <Camera style={{ width: 17, height: 17 }} />
                              {s.photoCount > 0 ? "Retake" : "Photo"}
                            </button>
                            <button
                              type="button"
                              style={{ ...btnBase, width: "auto", padding: "10px 12px", borderRadius: 12 }}
                              title={
                                s.photoCount > 0
                                  ? `Upload a saved image for ${s.label} — replaces the current ID`
                                  : `Upload a saved image for ${s.label}`
                              }
                              onClick={() => openPicker(galleryRef.current, s)}
                            >
                              <ImagePlus style={{ width: 17, height: 17 }} />
                            </button>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
                {rosterCovered === roster!.length && (
                  <p style={{ fontSize: 13.5, color: palette.ink3, textAlign: "center", margin: "4px 0 0", lineHeight: 1.5 }}>
                    Everyone&rsquo;s covered — you can close this page. Everything sent is already showing at the desk.
                  </p>
                )}
              </>
            )}

            {phase === "ready" && !allMode && (
              <>
                <button type="button" style={btnPrimary} onClick={() => openPicker(cameraRef.current, null)}>
                  <Camera style={{ width: 20, height: 20 }} />
                  {sentCount > 0 || storedBefore > 0 ? "Retake the ID photo" : "Take photo of the ID"}
                </button>
                <button type="button" style={btnBase} onClick={() => openPicker(galleryRef.current, null)}>
                  <ImagePlus style={{ width: 18, height: 18 }} />
                  Choose from gallery
                </button>
                {sentCount > 0 && (
                  <p style={{ fontSize: 13.5, color: palette.ink3, textAlign: "center", margin: "4px 0 0", lineHeight: 1.5 }}>
                    Done? You can close this page — everything sent is already showing at the desk.
                  </p>
                )}
              </>
            )}

            {(phase === "preview" || phase === "uploading") && (
              <>
                {allMode && (
                  <div style={{ fontSize: 14.5, fontWeight: 700, textAlign: "center" }}>
                    For: {guestLabel}
                    {roomText(activeSlot?.room) ? (
                      <span style={{ fontWeight: 500, color: palette.ink3 }}> · {roomText(activeSlot?.room)}</span>
                    ) : null}
                  </div>
                )}
                {previewUrl && pendingFile?.type.startsWith("image/") ? (
                  <div style={{ borderRadius: 16, overflow: "hidden", border: `1px solid ${palette.line}`, background: "#000" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- local object-URL preview */}
                    <img src={previewUrl} alt="ID preview" style={{ width: "100%", maxHeight: "48dvh", objectFit: "contain", display: "block" }} />
                  </div>
                ) : (
                  <div style={{ background: palette.cream, border: `1px solid ${palette.line}`, borderRadius: 16, padding: 20, fontSize: 14.5, color: palette.ink3 }}>
                    {pendingFile?.name ?? "File selected"}
                  </div>
                )}
                <p style={{ fontSize: 14, color: palette.ink3, textAlign: "center", margin: 0, lineHeight: 1.45 }}>
                  Readable and glare-free? Every detail on the document should be legible.
                </p>
                {error && (
                  <div style={{ background: palette.errBg, border: `1px solid ${palette.errLine}`, borderRadius: 12, padding: "10px 14px", fontSize: 13.5 }}>
                    {error}
                  </div>
                )}
                <button type="button" style={{ ...btnPrimary, opacity: phase === "uploading" ? 0.7 : 1 }} disabled={phase === "uploading"} onClick={() => void upload()}>
                  <Upload style={{ width: 18, height: 18 }} />
                  {phase === "uploading" ? "Sending…" : "Use this photo — send to the desk"}
                </button>
                <button type="button" style={btnBase} disabled={phase === "uploading"} onClick={() => openPicker(cameraRef.current, activeSlot)}>
                  <RefreshCcw style={{ width: 17, height: 17 }} />
                  Retake
                </button>
                {allMode && (
                  <button
                    type="button"
                    style={{ ...btnBase, padding: "12px 16px", fontSize: 14.5 }}
                    disabled={phase === "uploading"}
                    onClick={() => {
                      setPendingFile(null);
                      setPhase("ready");
                    }}
                  >
                    Back to the guest list
                  </button>
                )}
              </>
            )}

            <p style={{ fontSize: 12.5, color: palette.ink3, textAlign: "center", margin: "6px 0 0", lineHeight: 1.5 }}>
              One ID per guest — taking a new photo replaces the previous one. The photo goes straight
              to the hotel&rsquo;s own system — nothing is posted anywhere public. This link works for
              about 15 minutes; ask the desk for a fresh code if it expires.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
