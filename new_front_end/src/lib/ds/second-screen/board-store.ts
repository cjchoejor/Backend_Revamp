"use client";

/**
 * The board's memory of what the desk has told it (2026-10-07): where the desk is, what is typed
 * but unsaved, and what the operator has been told. Answers from the backend do not live here —
 * they go straight into the board's own React Query cache, under the desk's own keys, so the
 * board reads them exactly as the desk does.
 */
import type { QueryClient } from "@tanstack/react-query";
import { WINDOW_ID, post, setScreenRole, subscribe, type Draft, type Focus, type Notice } from "./channel";
import { onLinkChange, linkConnected, startLink } from "./link";

export type BoardState = {
  focus: Focus | null;
  drafts: Record<string, Draft>;
  notices: Notice[];
  /** True once a desk has answered with everything it knows. */
  synced: boolean;
  version: number;
};

const NOTICE_KEEP = 40;
/** The same words twice within this window are one event (a refusal and the toast that reports it). */
const SAME_EVENT_MS = 4000;

let state: BoardState = { focus: null, drafts: {}, notices: [], synced: false, version: 0 };
const listeners = new Set<() => void>();
let started = false;

function commit(next: Partial<BoardState>) {
  state = { ...state, ...next, version: state.version + 1 };
  for (const fn of listeners) fn();
}

const draftKey = (d: { entryId: string; kind: string }) => `${d.entryId}::${d.kind}`;

function addNotice(n: Notice, list: Notice[]): Notice[] {
  const twin = list.find((x) => x.text === n.text && Math.abs(x.at - n.at) < SAME_EVENT_MS);
  if (twin) return list;
  return [n, ...list].slice(0, NOTICE_KEEP);
}

export function startBoard(qc: QueryClient) {
  if (started || typeof window === "undefined") return;
  started = true;
  setScreenRole("board");
  startLink();
  const hello = () => post({ t: "hello", from: "board", id: WINDOW_ID });
  subscribe((m) => {
    switch (m.t) {
      case "snapshot": {
        if (m.to !== WINDOW_ID) return;
        for (const q of m.queries) qc.setQueryData(q.key, q.data, { updatedAt: q.at });
        const drafts: Record<string, Draft> = {};
        for (const d of m.drafts) drafts[draftKey(d)] = d;
        let notices = state.notices;
        for (const n of [...m.notices].reverse()) notices = addNotice(n, notices);
        commit({ focus: m.focus ?? state.focus, drafts, notices, synced: true });
        return;
      }
      case "data":
        qc.setQueryData(m.query.key, m.query.data, { updatedAt: m.query.at });
        return;
      case "focus":
        commit({ focus: m.focus });
        return;
      case "draft":
        commit({ drafts: { ...state.drafts, [draftKey(m.draft)]: m.draft } });
        return;
      case "draft-clear": {
        const drafts = { ...state.drafts };
        delete drafts[draftKey(m)];
        commit({ drafts });
        return;
      }
      case "notice":
        commit({ notices: addNotice(m.notice, state.notices) });
        return;
      default:
        return;
    }
  });
  // Ask now, and again whenever a desk (re)appears — a desk window that reloaded has lost its
  // drafts, and one opened after the board has never been asked.
  hello();
  let wasConnected = linkConnected();
  onLinkChange(() => {
    const now = linkConnected();
    if (now && !wasConnected) hello();
    wasConnected = now;
  });
  // Until somebody answers, keep asking.
  const retry = window.setInterval(() => {
    if (state.synced) window.clearInterval(retry);
    else hello();
  }, 3000);
}

export function boardState(): BoardState {
  return state;
}

export function onBoardChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function draftOf<T>(s: BoardState, entryId: string | null, kind: string): (Draft & { value: T }) | null {
  if (!entryId) return null;
  return (s.drafts[`${entryId}::${kind}`] as (Draft & { value: T }) | undefined) ?? null;
}
