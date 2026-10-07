"use client";

/**
 * Is the other screen there? Each side beats every few seconds; a side is "connected" while the
 * other's last beat is recent. A window closing says `bye`, so the desk's chip goes dim at once
 * rather than after the timeout.
 */
import { WINDOW_ID, post, screenRole, subscribe } from "./channel";

const BEAT_MS = 4000;
const LOST_AFTER_MS = 13000;

let started = false;
let lastSeen = 0;
let peers = new Set<string>();
let connected = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (next === connected) return;
  connected = next;
  for (const fn of listeners) fn();
}

export function startLink() {
  if (started || typeof window === "undefined") return;
  started = true;
  const me = screenRole();
  const other = me === "desk" ? "board" : "desk";
  subscribe((m) => {
    if ((m.t === "beat" || m.t === "hello") && m.from === other) {
      lastSeen = Date.now();
      peers.add(m.id);
      set(true);
    } else if (m.t === "bye" && m.from === other) {
      peers.delete(m.id);
      if (peers.size === 0) set(false);
    }
  });
  const beat = () => post({ t: "beat", from: me, id: WINDOW_ID });
  beat();
  window.setInterval(() => {
    beat();
    if (connected && Date.now() - lastSeen > LOST_AFTER_MS) {
      peers = new Set();
      set(false);
    }
  }, BEAT_MS);
  window.addEventListener("pagehide", () => post({ t: "bye", from: me, id: WINDOW_ID }));
}

export function linkConnected() {
  return connected;
}

export function onLinkChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
