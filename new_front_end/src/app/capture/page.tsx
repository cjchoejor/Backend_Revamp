"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, BedDouble, Camera, Check, ImagePlus, RefreshCcw, ShieldCheck, X } from "lucide-react";
import {
  fetchPhoneCaptureContext,
  uploadPhoneCapture,
  type PhoneCaptureContext,
  type PhoneCaptureRoom,
  type PhoneCaptureRosterItem,
} from "@/lib/api/identity-proofs";
import { shrinkForUpload } from "@/lib/phone-id-reader";

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
 * context and would show a black screen. The native camera app also gives the retake loop.
 *
 * Send at once, read at the desk (2026-10-23, operator: "just send the compressed photo
 * directly to the website and let it start analysing there"): the phone no longer reads the
 * document itself. A photo is shrunk and sent the moment it is taken, the next guest comes up
 * straight away, and several photos may be on their way at once — each with its own line saying
 * whether it is sending, sent or did not send (with Retry). The server reads every photo it
 * receives (W39, two at a time) and the desk shows each one's progress. The document type is
 * picked BEFORE the shot and travels with the photo to guide the reading.
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
  errInk: "#a8341c",
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
  // Longhands, not `border`: a button switches between this and btnPrimary, which sets the colour.
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: palette.line,
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

type Phase = "checking" | "invalid" | "ready";

/** One photo on its way to the desk, or already there. */
type SendTask = {
  id: number;
  /** The party slot it files under; null on a single-guest link (the token names the slot). */
  slotKey: string | null;
  label: string;
  file: File;
  /** The shrunk JPEG, once made — kept so Retry sends the same bytes. */
  blob: Blob | null;
  fileName: string;
  thumbUrl: string | null;
  documentType: string;
  status: "preparing" | "sending" | "sent" | "failed";
  error: string | null;
};

const isBusy = (t: SendTask | undefined) => !!t && (t.status === "preparing" || t.status === "sending");

/** "Room 205 · Twin · Deluxe Double" — the guest's seated room per the booking's quote.
 *  `compact` drops the room-type name so list rows keep space for the photo count. */
function roomText(room: PhoneCaptureRoom | null | undefined, compact = false): string | null {
  if (!room) return null;
  const bed = room.bedType ? `${room.bedType.charAt(0)}${room.bedType.slice(1).toLowerCase()}` : null;
  return [`Room ${room.roomNumber}`, bed, compact ? null : room.roomTypeName].filter(Boolean).join(" · ");
}

/** "25 Oct" from a night's YYYY-MM-DD — a stay date, read on its own calendar. */
function dayMonth(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** "then Room 305 from 25 Oct" — where a guest who changes rooms moves on later nights. */
function laterText(s: PhoneCaptureRosterItem): string | null {
  const later = s.laterRooms ?? [];
  if (!later.length) return null;
  return "then " + later.map((l) => `Room ${l.room.roomNumber} from ${dayMonth(l.fromNight)}`).join(", then ");
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: `1px solid ${palette.line}`,
  fontSize: 15,
  background: "#fff",
  color: palette.ink,
};

/** Small rotating spinner for a photo on its way (standalone page — no desk stylesheet). */
function Spin({ size = 15 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `2.5px solid ${palette.green}`,
        borderTopColor: "transparent",
        display: "inline-block",
        animation: "capspin 0.7s linear infinite",
        flexShrink: 0,
      }}
    />
  );
}

/** The photo's small copy beside its line, or an empty square while it is still being made. */
function Thumb({ url, size = 44 }: { url: string | null; size?: number }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- local object-URL thumbnail
    <img src={url} alt="" style={{ width: size, height: size, objectFit: "cover", borderRadius: 8, border: `1px solid ${palette.line}`, flexShrink: 0 }} />
  ) : (
    <span style={{ width: size, height: size, borderRadius: 8, background: palette.cream, border: `1px solid ${palette.line}`, flexShrink: 0 }} />
  );
}

/** What a photo's line says about it. */
function TaskStatus({ task, docName, compact = false }: { task: SendTask; docName: string | null; compact?: boolean }) {
  const doc = docName ? ` · ${docName}` : "";
  if (task.status === "failed") {
    return (
      <span style={{ color: palette.errInk, fontWeight: 700 }}>
        Didn&rsquo;t send{task.error && !compact ? ` — ${task.error}` : ""}
      </span>
    );
  }
  if (task.status === "sent") {
    return (
      <span style={{ color: palette.green, fontWeight: 600 }}>
        Sent{doc}{compact ? "" : " · the desk is reading it"}
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: palette.ink3, fontWeight: 600 }}>
      <Spin size={12} />
      Sending{doc}…
    </span>
  );
}

export default function PhoneCapturePage() {
  const [token, setToken] = useState<string | null>(null);
  const [ctx, setCtx] = useState<PhoneCaptureContext | null>(null);
  const [roster, setRoster] = useState<PhoneCaptureRosterItem[] | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string | null>(null);
  // All-guests mode: which party member the open camera is capturing for.
  const [activeSlot, setActiveSlot] = useState<PhoneCaptureRosterItem | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  // The photos taken on this phone, newest first; one line per guest (a retake replaces it).
  const [tasks, setTasks] = useState<SendTask[]>([]);
  const taskSeq = useRef(0);
  const thumbUrls = useRef<string[]>([]);
  // The document type for the next photo — usually the same for a whole party, so it stays picked.
  const [docType, setDocType] = useState("");
  // How long the code works (2026-10-23): counted from the server's clock, not the phone's.
  const clockOffset = useRef(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // A big party (2026-10-23, operator: "if there are a lot of rooms the list is a burden"):
  // one button walks guest to guest, and a side drawer lists the rooms to jump between.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
        if (c.serverNow) clockOffset.current = Date.parse(c.serverNow) - Date.now();
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

  // The time left on the code, ticking each second; at the end the page says so and stops.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const expiresMs = ctx?.expiresAt ? Date.parse(ctx.expiresAt) : null;
  const leftMs = expiresMs != null ? expiresMs - (nowMs + clockOffset.current) : null;
  useEffect(() => {
    if (leftMs != null && leftMs <= 0 && phase !== "invalid" && phase !== "checking") {
      setPhase("invalid");
      setError("This code has ended. Everything already sent is on the desk — ask the desk for a fresh code to send more.");
    }
  }, [leftMs, phase]);

  // Closing the page while a photo is still on its way would lose it — the browser asks first.
  const anyBusy = tasks.some(isBusy);
  useEffect(() => {
    if (!anyBusy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyBusy]);

  // The thumbnails' object URLs go when the page does.
  useEffect(() => () => thumbUrls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const allMode = !!roster;

  const openPicker = (input: HTMLInputElement | null, slot: PhoneCaptureRosterItem | null) => {
    setActiveSlot(slot);
    input?.click();
  };

  const patchTask = (id: number, patch: Partial<SendTask>) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  /** Shrink (once) and send one photo; the line follows it. */
  const send = async (task: SendTask) => {
    if (!token) return;
    patchTask(task.id, { status: task.blob ? "sending" : "preparing", error: null });
    try {
      let blob = task.blob;
      let fileName = task.fileName;
      if (!blob) {
        const shrunk = await shrinkForUpload(task.file);
        blob = shrunk.blob;
        fileName = shrunk.fileName;
        const thumbUrl = blob.type.startsWith("image/") ? URL.createObjectURL(blob) : null;
        if (thumbUrl) thumbUrls.current.push(thumbUrl);
        patchTask(task.id, { blob, fileName, thumbUrl, status: "sending" });
      }
      await uploadPhoneCapture(token, blob, fileName, task.slotKey ?? undefined, false, task.documentType || undefined);
      patchTask(task.id, { status: "sent" });
      if (task.slotKey) {
        // Bump the row at once, then resync counts (and any typed names) from the server.
        setRoster((prev) => prev?.map((s) => (s.key === task.slotKey ? { ...s, photoCount: s.photoCount + 1 } : s)) ?? prev);
        fetchPhoneCaptureContext(token)
          .then((c) => setRoster(c.roster))
          .catch(() => {
            /* keep the optimistic counts — the next send resyncs */
          });
      }
    } catch (e) {
      // A fetch that never reached the server says it in browser words ("Failed to fetch", "Load
      // failed", "NetworkError…"); the person needs to hear that the connection dropped.
      const msg = e instanceof Error ? e.message : "";
      const offline = e instanceof TypeError || /failed to fetch|load failed|networkerror|network/i.test(msg);
      patchTask(task.id, { status: "failed", error: offline || !msg ? "no connection, check the Wi-Fi" : msg });
    }
  };

  const onPicked = (files: FileList | null) => {
    const file = files?.[0];
    // Allow re-picking the same file (a retake produces a same-named capture on some phones).
    if (cameraRef.current) cameraRef.current.value = "";
    if (galleryRef.current) galleryRef.current.value = "";
    if (!file || !token) return;
    if (allMode && !activeSlot) return;
    setError(null);
    const slotKey = allMode ? activeSlot!.key : null;
    const task: SendTask = {
      id: ++taskSeq.current,
      slotKey,
      label: allMode ? activeSlot!.label : ctx?.subjectLabel?.trim() || "this guest",
      file,
      blob: null,
      fileName: file.name,
      thumbUrl: null,
      documentType: docType,
      status: "preparing",
      error: null,
    };
    // One ID per guest: the new photo's line replaces the earlier one's, as the desk shows only the newest.
    setTasks((prev) => [task, ...prev.filter((t) => t.slotKey !== slotKey)]);
    void send(task);
  };

  const taskFor = (slotKey: string | null) => tasks.find((t) => t.slotKey === slotKey);
  const docName = (code: string) => (code ? (ctx?.documentTypes ?? []).find((d) => d.code === code)?.name ?? code : null);

  const storedBefore = ctx?.uploadedCount ?? 0;
  const sentCount = tasks.filter((t) => t.status === "sent").length;
  const sendingCount = tasks.filter(isBusy).length;
  const failed = tasks.filter((t) => t.status === "failed");
  const hasId = (s: PhoneCaptureRosterItem) => s.photoCount > 0 || taskFor(s.key)?.status === "sent";
  const rosterCovered = roster?.filter(hasId).length ?? 0;

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
  // The next guest still without an ID, in the list's own order; a guest whose photo is on its way
  // (or did not send — that one has its own Retry above) is not asked for again; skipped ones wait.
  const waiting = roomGroups.flatMap((g) => g.items).filter((s) => s.photoCount === 0 && !taskFor(s.key));
  const next = waiting.find((s) => !skipped.includes(s.key)) ?? null;
  const skippedWaiting = waiting.filter((s) => skipped.includes(s.key));
  const roomsDone = roomGroups.filter((g) => g.items.every(hasId)).length;
  const jumpTo = (key: string) => {
    setDrawerOpen(false);
    requestAnimationFrame(() => document.getElementById(`cap-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  // The lines shown under the next guest: every photo that did not send, then the newest few.
  const recent = [...failed, ...tasks.filter((t) => t.status !== "failed")].slice(0, Math.max(4, failed.length));
  const singleTask = taskFor(null);

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
      <style>{"@keyframes capspin{to{transform:rotate(360deg)}}"}</style>
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

        {ctx && phase === "ready" && (
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
                    {sendingCount > 0 ? <span style={{ color: palette.ink3 }}> · {sendingCount} sending</span> : null}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 13, color: palette.ink3, marginBottom: 2 }}>Photographing the ID of</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{ctx.subjectLabel?.trim() || "this guest"}</div>
                  <div style={{ fontSize: 12.5, color: palette.ink3, marginTop: 4 }}>
                    Booking {ctx.entryId}
                    {roomText(ctx.room) ? ` · ${roomText(ctx.room)}` : ""}
                  </div>
                  {storedBefore > 0 && !singleTask && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 13.5, color: palette.green, fontWeight: 600 }}>
                      <Check style={{ width: 15, height: 15 }} />
                      An ID is already on file — retaking replaces it
                    </div>
                  )}
                </>
              )}
            </div>

            {/* How long the code works (2026-10-23): quiet while there is time, amber in the last
                five minutes, red in the last two. */}
            {leftMs != null && leftMs > 0 ? (
              leftMs <= 2 * 60_000 ? (
                <div role="alert" style={{ background: palette.errBg, border: `1px solid ${palette.errLine}`, borderRadius: 12, padding: "10px 14px", fontSize: 14, fontWeight: 700, lineHeight: 1.45 }}>
                  This code ends in {Math.floor(leftMs / 60_000)}:{String(Math.floor((leftMs % 60_000) / 1000)).padStart(2, "0")} — send what you have, then ask the desk for a fresh code.
                </div>
              ) : (
                <div style={{ fontSize: 13, fontWeight: 600, textAlign: "center", color: leftMs <= 5 * 60_000 ? "#9a6a12" : palette.ink3 }}>
                  This code works for {Math.ceil(leftMs / 60_000)} more minutes
                </div>
              )
            ) : null}

            {/* Photos that did not send — on screen until each is sent again or retaken. */}
            {failed.length > 0 && (
              <div role="alert" style={{ display: "flex", alignItems: "center", gap: 10, background: palette.errBg, border: `1px solid ${palette.errLine}`, borderRadius: 12, padding: "10px 14px", fontSize: 14, fontWeight: 700, color: palette.errInk }}>
                <AlertTriangle style={{ width: 18, height: 18, flexShrink: 0 }} />
                {failed.length === 1 ? `${failed[0].label}'s photo didn't send` : `${failed.length} photos didn't send`} — press Retry below
              </div>
            )}

            {/* The document type, picked before the shot (2026-10-23): it guides the desk's reading
                and stays picked for the next guest — a party usually carries one kind. */}
            <label style={{ display: "flex", alignItems: "center", gap: 10, background: palette.card, border: `1px solid ${palette.line}`, borderRadius: 12, padding: "8px 12px" }}>
              <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>Document</span>
              <select aria-label="Document type for the next photo" value={docType} onChange={(e) => setDocType(e.target.value)} style={{ ...inputStyle, padding: "8px 10px", fontSize: 14.5 }}>
                <option value="">Not sure — the desk works it out</option>
                {(ctx.documentTypes ?? []).map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>

            {/* The next guest (2026-10-23): one button that always points at whoever still needs an
                ID, so nobody scrolls a long list to find them. The moment a photo is taken the card
                names the following guest — the photo goes on sending below. Skip leaves someone not
                here yet for later. */}
            {allMode && waiting.length > 0 && (
              <div style={{ background: palette.card, border: `2px solid ${palette.green}`, borderRadius: 16, padding: "14px 16px", display: "grid", gap: 10 }}>
                <div style={{ fontSize: 12.5, color: palette.ink3, fontWeight: 600 }}>
                  Next guest · {waiting.length} still to photograph
                </div>
                {next ? (
                  <>
                    <div>
                      <div style={{ fontSize: 21, fontWeight: 700, lineHeight: 1.2 }}>{next.label}</div>
                      <div style={{ fontSize: 13, color: palette.ink3, marginTop: 3 }}>
                        {[roomText(next.room) ?? "No room assigned yet", laterText(next)].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <button type="button" style={btnPrimary} onClick={() => openPicker(cameraRef.current, next)}>
                      <Camera style={{ width: 20, height: 20 }} />
                      Photograph {next.label}
                    </button>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" style={{ ...btnBase, padding: "11px 12px", fontSize: 14.5 }} onClick={() => openPicker(galleryRef.current, next)}>
                        <ImagePlus style={{ width: 17, height: 17 }} />
                        From gallery
                      </button>
                      <button type="button" style={{ ...btnBase, padding: "11px 12px", fontSize: 14.5 }} onClick={() => setSkipped((p) => [...p, next.key])}>
                        Skip for now
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>
                      {skippedWaiting.length} skipped guest{skippedWaiting.length === 1 ? "" : "s"} still need an ID
                    </div>
                    <button type="button" style={btnPrimary} onClick={() => setSkipped([])}>
                      Go back to the skipped guests
                    </button>
                  </>
                )}
              </div>
            )}

            {!allMode && (
              <>
                <button
                  type="button"
                  style={{ ...btnPrimary, opacity: isBusy(singleTask) ? 0.6 : 1 }}
                  disabled={isBusy(singleTask)}
                  onClick={() => openPicker(cameraRef.current, null)}
                >
                  <Camera style={{ width: 20, height: 20 }} />
                  {isBusy(singleTask) ? "Sending the photo…" : singleTask || storedBefore > 0 ? "Retake the ID photo" : "Take photo of the ID"}
                </button>
                <button type="button" style={btnBase} disabled={isBusy(singleTask)} onClick={() => openPicker(galleryRef.current, null)}>
                  <ImagePlus style={{ width: 18, height: 18 }} />
                  Choose from gallery
                </button>
              </>
            )}

            {/* Each photo's own line — several can be on their way at once. */}
            {recent.length > 0 && (
              <div style={{ background: palette.card, border: `1px solid ${palette.line}`, borderRadius: 16, overflow: "hidden" }}>
                <div style={{ padding: "10px 14px", fontSize: 12.5, color: palette.ink3, fontWeight: 600, borderBottom: `1px solid ${palette.line}`, background: palette.cream }}>
                  {allMode ? "Photos from this phone" : "The photo"}
                  {[
                    sendingCount > 0 ? `${sendingCount} on the way` : null,
                    sentCount > 0 ? (allMode ? `${sentCount} on the desk` : "on the desk") : null,
                    failed.length > 0 ? (allMode ? `${failed.length} didn’t send` : "didn’t send") : null,
                  ]
                    .filter(Boolean)
                    .map((w) => ` · ${w}`)
                    .join("")}
                </div>
                {recent.map((t, i) => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderTop: i > 0 ? `1px dashed ${palette.line}` : "none", background: t.status === "failed" ? palette.errBg : undefined }}>
                    <Thumb url={t.thumbUrl} />
                    <div style={{ minWidth: 0, flex: 1, fontSize: 13 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.label}</div>
                      <TaskStatus task={t} docName={docName(t.documentType)} />
                    </div>
                    {t.status === "failed" && (
                      <button type="button" style={{ ...btnPrimary, width: "auto", padding: "9px 12px", fontSize: 14, borderRadius: 12 }} onClick={() => void send(t)}>
                        <RefreshCcw style={{ width: 15, height: 15 }} />
                        Retry
                      </button>
                    )}
                  </div>
                ))}
                {allMode && tasks.length > recent.length && (
                  <div style={{ padding: "8px 14px", fontSize: 12.5, color: palette.ink3, borderTop: `1px dashed ${palette.line}` }}>
                    and {tasks.length - recent.length} more in the rooms below
                  </div>
                )}
              </div>
            )}

            <div style={{ fontSize: 13, color: palette.ink3, lineHeight: 1.5, textAlign: "center" }}>
              Each photo goes straight to the desk — no need to wait for it. Keep the whole document flat, sharp and free of glare.
            </div>

            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPicked(e.target.files)} />
            <input ref={galleryRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => onPicked(e.target.files)} />

            {allMode && (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {roomGroups.map((g) => {
                    const covered = g.items.filter(hasId).length;
                    const allDone = covered === g.items.length;
                    return (
                      <div
                        key={g.key}
                        id={`cap-${g.key}`}
                        style={{
                          scrollMarginTop: 12,
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
                        {g.items.map((s, i) => {
                          const t = taskFor(s.key);
                          const busy = isBusy(t);
                          return (
                            <div
                              key={s.key}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                padding: "11px 14px",
                                borderTop: i > 0 ? `1px dashed ${palette.line}` : "none",
                                background: t?.status === "failed" ? palette.errBg : undefined,
                              }}
                            >
                              {t ? (
                                <Thumb url={t.thumbUrl} size={34} />
                              ) : s.photoCount > 0 ? (
                                <Check style={{ width: 18, height: 18, color: palette.green, flexShrink: 0 }} />
                              ) : (
                                <span style={{ width: 16, height: 16, borderRadius: 999, border: `2px solid ${palette.line}`, flexShrink: 0 }} />
                              )}
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {s.label}
                                </div>
                                <div style={{ fontSize: 12 }}>
                                  {t ? (
                                    <TaskStatus task={t} docName={null} compact />
                                  ) : (
                                    <span style={{ color: palette.ink3 }}>{s.photoCount > 0 ? "ID on file" : "No ID yet"}</span>
                                  )}
                                  {laterText(s) ? <span style={{ color: palette.ink3 }}> · {laterText(s)}</span> : null}
                                </div>
                              </div>
                              {t?.status === "failed" && (
                                <button
                                  type="button"
                                  style={{ ...btnPrimary, width: "auto", padding: "10px 12px", fontSize: 14, borderRadius: 12 }}
                                  onClick={() => void send(t)}
                                >
                                  <RefreshCcw style={{ width: 15, height: 15 }} />
                                  Retry
                                </button>
                              )}
                              {/* One ID per guest — capturing again REPLACES the one on file. Not while
                                  the last one is still on its way: the two would reach the desk out of order. */}
                              <button
                                type="button"
                                disabled={busy}
                                aria-label={`${hasId(s) || t ? "Retake" : "Photograph"} ${s.label}`}
                                title={hasId(s) || t ? `Retake ${s.label}'s ID` : `Photograph ${s.label}'s ID`}
                                style={{
                                  ...(t?.status === "failed" ? btnBase : btnPrimary),
                                  width: "auto",
                                  padding: t?.status === "failed" ? "10px 12px" : "10px 14px",
                                  fontSize: 14,
                                  borderRadius: 12,
                                  opacity: busy ? 0.5 : 1,
                                }}
                                onClick={() => openPicker(cameraRef.current, s)}
                              >
                                <Camera style={{ width: 17, height: 17 }} />
                                {t?.status === "failed" ? null : hasId(s) || t ? "Retake" : "Photo"}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                style={{ ...btnBase, width: "auto", padding: "10px 12px", borderRadius: 12, opacity: busy ? 0.5 : 1 }}
                                title={hasId(s) ? `Upload a saved image for ${s.label} — replaces the current ID` : `Upload a saved image for ${s.label}`}
                                onClick={() => openPicker(galleryRef.current, s)}
                              >
                                <ImagePlus style={{ width: 17, height: 17 }} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
                {rosterCovered === roster!.length && !anyBusy && (
                  <p style={{ fontSize: 13.5, color: palette.ink3, textAlign: "center", margin: "4px 0 0", lineHeight: 1.5 }}>
                    Everyone&rsquo;s covered — you can close this page. Everything sent is already at the desk.
                  </p>
                )}
              </>
            )}

            {!allMode && singleTask?.status === "sent" && (
              <p style={{ fontSize: 13.5, color: palette.ink3, textAlign: "center", margin: "4px 0 0", lineHeight: 1.5 }}>
                Done? You can close this page — the photo is already at the desk.
              </p>
            )}

            {/* The rooms drawer (2026-10-23, operator: "a side tab which can collapse and open, and it
                contains the rooms"): a tab on the right edge opens the list of rooms with how many
                IDs each has; a tap jumps to that room. Only for a party in more than one room. */}
            {allMode && roomGroups.length > 1 && (
              <>
                <button
                  type="button"
                  aria-expanded={drawerOpen}
                  aria-label={`Rooms — ${roomsDone} of ${roomGroups.length} done`}
                  onClick={() => setDrawerOpen(true)}
                  style={{
                    position: "fixed",
                    right: 0,
                    top: "50%",
                    transform: "translateY(-50%)",
                    zIndex: 20,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                    padding: "12px 7px",
                    border: `1px solid ${palette.greenDark}`,
                    borderRight: "none",
                    borderRadius: "12px 0 0 12px",
                    background: palette.green,
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <BedDouble style={{ width: 17, height: 17 }} />
                  <span style={{ writingMode: "vertical-rl", letterSpacing: 0.5 }}>Rooms · {roomsDone}/{roomGroups.length}</span>
                </button>
                {drawerOpen && (
                  <div
                    role="dialog"
                    aria-label="Rooms"
                    onClick={() => setDrawerOpen(false)}
                    style={{ position: "fixed", inset: 0, zIndex: 30, background: "rgba(20, 18, 14, 0.35)", display: "flex", justifyContent: "flex-end" }}
                  >
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        width: "min(320px, 84vw)",
                        height: "100dvh",
                        overflowY: "auto",
                        background: palette.bg,
                        borderLeft: `1px solid ${palette.line}`,
                        padding: "18px 14px 28px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 18, fontWeight: 700 }}>Rooms</span>
                        <button
                          type="button"
                          aria-label="Close the rooms"
                          onClick={() => setDrawerOpen(false)}
                          style={{ ...btnBase, width: "auto", marginLeft: "auto", padding: "8px 10px", borderRadius: 10 }}
                        >
                          <X style={{ width: 17, height: 17 }} />
                        </button>
                      </div>
                      <div style={{ fontSize: 13, color: palette.ink3 }}>
                        {rosterCovered} of {roster!.length} guests · {roomsDone} of {roomGroups.length} rooms done
                      </div>
                      {roomGroups.map((g) => {
                        const covered = g.items.filter(hasId).length;
                        const done = covered === g.items.length;
                        return (
                          <button
                            key={g.key}
                            type="button"
                            onClick={() => jumpTo(g.key)}
                            style={{
                              ...btnBase,
                              justifyContent: "flex-start",
                              padding: "12px 14px",
                              fontSize: 15,
                              borderColor: done ? palette.green : palette.line,
                            }}
                          >
                            {done ? (
                              <Check style={{ width: 17, height: 17, color: palette.green, flexShrink: 0 }} />
                            ) : (
                              <span style={{ width: 15, height: 15, borderRadius: 999, border: `2px solid ${palette.line}`, flexShrink: 0 }} />
                            )}
                            <span>{g.room ? `Room ${g.room.roomNumber}` : "No room yet"}</span>
                            <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 700, color: done ? palette.green : palette.ink3 }}>
                              {covered}/{g.items.length}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}

            <p style={{ fontSize: 12.5, color: palette.ink3, textAlign: "center", margin: "6px 0 0", lineHeight: 1.5 }}>
              One ID per guest — taking a new photo replaces the previous one. The photo goes straight
              to the hotel&rsquo;s own system — nothing is posted anywhere public.
              {expiresMs != null
                ? ` This code works until ${new Date(expiresMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}; ask the desk for a fresh code after that.`
                : " Ask the desk for a fresh code if it stops working."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
