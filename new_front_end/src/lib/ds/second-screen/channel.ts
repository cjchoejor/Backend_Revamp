"use client";

/**
 * The second screen's line to the desk (2026-10-07).
 *
 * The desk runs on two monitors of one computer: the working screen (monitor 1) and a read-only
 * board (monitor 2, `/second-screen`). Both are windows of the same browser, so they talk over a
 * `BroadcastChannel` — no server, nothing leaves the machine, and a message arrives in the other
 * window in the same instant it is sent.
 *
 * What travels, desk → board:
 *  - `focus`    which booking and step the desk is on, so the board follows it;
 *  - `data`     every answer the desk gets from the backend, so the board shows exactly what the
 *               desk just read (the board's own React Query cache is filled with it);
 *  - `draft`    what the operator has typed or picked and NOT saved yet, so the board can show
 *               it as "not saved";
 *  - `notice`   every message the desk shows (the toasts) and every refusal from the backend.
 * And board → desk: `hello` when a board opens (answered with a `snapshot` of all of the above, so
 * a board opened late never starts blank) and a `beat` every few seconds from both sides, so each
 * knows whether the other is still there.
 *
 * A window is the DESK unless it says otherwise: the board calls `setScreenRole("board")` first,
 * and nothing a board does is ever sent back as a draft, a notice or data.
 */

export const CHANNEL_NAME = "legphel-desk";
export const PROTOCOL = 1;

export type ScreenRole = "desk" | "board";

export type Focus = {
  /** The desk's address, path only. */
  path: string;
  /** The booking open on the desk, when one is. */
  entryId: string | null;
  at: number;
};

export type Draft = {
  entryId: string;
  /** What the draft is: "desk" (the workspace's own reading), "s1.stay", "s1.rooms", "s2.table", … */
  kind: string;
  value: unknown;
  at: number;
};

export type NoticeTone = "error" | "warning" | "success" | "info";

export type Notice = {
  id: string;
  tone: NoticeTone;
  text: string;
  detail?: string;
  /** "refusal" when it came straight from the backend, "toast" when the desk said it. */
  source: "refusal" | "toast";
  at: number;
  entryId: string | null;
};

export type CachedQuery = { key: readonly unknown[]; data: unknown; at: number };

export type Message =
  | { t: "hello"; from: "board"; id: string }
  | { t: "snapshot"; to: string; focus: Focus | null; queries: CachedQuery[]; drafts: Draft[]; notices: Notice[] }
  | { t: "focus"; focus: Focus }
  | { t: "data"; query: CachedQuery }
  | { t: "draft"; draft: Draft }
  | { t: "draft-clear"; entryId: string; kind: string }
  | { t: "notice"; notice: Notice }
  | { t: "beat"; from: ScreenRole; id: string }
  | { t: "bye"; from: ScreenRole; id: string };

type Envelope = { v: number; m: Message };

let role: ScreenRole = "desk";
let channel: BroadcastChannel | null = null;
const listeners = new Set<(m: Message) => void>();

/** This window's own id — a board answers only the desk that answered it. */
export const WINDOW_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `w-${Math.random().toString(36).slice(2)}`;

export function setScreenRole(r: ScreenRole) {
  role = r;
}
export function screenRole(): ScreenRole {
  return role;
}

function open(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (ev: MessageEvent<Envelope>) => {
    const env = ev.data;
    if (!env || env.v !== PROTOCOL || !env.m) return;
    for (const fn of listeners) fn(env.m);
  };
  return channel;
}

export function post(m: Message) {
  const ch = open();
  if (!ch) return;
  try {
    ch.postMessage({ v: PROTOCOL, m } satisfies Envelope);
  } catch {
    /* an answer that cannot be cloned is simply not mirrored */
  }
}

export function subscribe(fn: (m: Message) => void): () => void {
  open();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/* ---- the desk's own record of what it has told a board, for the snapshot ---- */

const drafts = new Map<string, Draft>();
const notices: Notice[] = [];
let lastFocus: Focus | null = null;
const NOTICE_KEEP = 40;

const draftKey = (entryId: string, kind: string) => `${entryId}::${kind}`;

export function publishDraft(entryId: string, kind: string, value: unknown) {
  if (role !== "desk") return;
  const draft: Draft = { entryId, kind, value, at: Date.now() };
  drafts.set(draftKey(entryId, kind), draft);
  post({ t: "draft", draft });
}

export function clearDraft(entryId: string, kind: string) {
  if (role !== "desk") return;
  if (!drafts.delete(draftKey(entryId, kind))) return;
  post({ t: "draft-clear", entryId, kind });
}

export function publishNotice(n: Omit<Notice, "id" | "at" | "entryId"> & { entryId?: string | null }) {
  if (role !== "desk" || typeof window === "undefined") return;
  const text = n.text.trim();
  if (!text) return;
  const notice: Notice = {
    ...n,
    text,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    entryId: n.entryId ?? lastFocus?.entryId ?? null,
  };
  notices.unshift(notice);
  notices.length = Math.min(notices.length, NOTICE_KEEP);
  post({ t: "notice", notice });
}

export function publishFocus(focus: Focus) {
  if (role !== "desk") return;
  lastFocus = focus;
  post({ t: "focus", focus });
}

export function deskRecord(): { focus: Focus | null; drafts: Draft[]; notices: Notice[] } {
  return { focus: lastFocus, drafts: [...drafts.values()], notices: [...notices] };
}
