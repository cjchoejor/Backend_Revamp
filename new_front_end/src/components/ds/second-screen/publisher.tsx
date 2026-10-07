"use client";

/**
 * The desk's half of the second screen (2026-10-07). Mounted once in the app shell.
 *
 *  - tells the board which booking the desk is on (on every address change, and whenever this
 *    window takes the focus — with two desk windows open, the board follows the one in use);
 *  - mirrors every answer the desk gets from the backend into the board's cache, while a board is
 *    connected;
 *  - answers a board's `hello` with everything at once, so a board opened late is complete.
 *
 * `PublishDraft` is how a step tells the board what is typed but not saved yet. It is a component,
 * not a hook, so it can sit anywhere in a step's markup — including below an early return.
 */
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/ds/toast";
import { Icon } from "@/design-system";
import { useSecondScreen } from "@/hooks/use-second-screen";
import {
  clearDraft,
  deskRecord,
  post,
  publishDraft,
  publishFocus,
  subscribe,
  type CachedQuery,
} from "@/lib/ds/second-screen/channel";
import { linkConnected, startLink } from "@/lib/ds/second-screen/link";
import { openSecondScreen } from "@/lib/ds/second-screen/open";

/** `/bookings/ENT-…` → the booking's id; anything else → null. */
export function entryIdOfPath(path: string): string | null {
  const m = /^\/bookings\/([^/?#]+)/.exec(path);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return id === "new" ? null : id;
}

export function SecondScreenPublisher() {
  const qc = useQueryClient();
  const pathname = usePathname() ?? "";
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  useEffect(() => {
    startLink();
  }, []);

  useEffect(() => {
    const send = () => publishFocus({ path: pathRef.current, entryId: entryIdOfPath(pathRef.current), at: Date.now() });
    send();
    window.addEventListener("focus", send);
    return () => window.removeEventListener("focus", send);
  }, [pathname]);

  useEffect(() => {
    const cache = qc.getQueryCache();
    const asCached = (q: ReturnType<typeof cache.getAll>[number]): CachedQuery => ({
      key: q.queryKey,
      data: q.state.data,
      at: q.state.dataUpdatedAt,
    });
    const offCache = cache.subscribe((ev) => {
      if (ev.type !== "updated" || ev.action.type !== "success" || !linkConnected()) return;
      post({ t: "data", query: asCached(ev.query) });
    });
    const offChannel = subscribe((m) => {
      if (m.t !== "hello") return;
      const rec = deskRecord();
      const queries = cache
        .getAll()
        .filter((q) => q.state.status === "success" && q.state.data !== undefined)
        .map(asCached);
      post({
        t: "snapshot",
        to: m.id,
        focus: document.hasFocus() || !rec.focus ? { path: pathRef.current, entryId: entryIdOfPath(pathRef.current), at: Date.now() } : rec.focus,
        queries,
        drafts: rec.drafts,
        notices: rec.notices,
      });
    });
    return () => {
      offCache();
      offChannel();
    };
  }, [qc]);

  return null;
}

/** What a step has typed or picked and not saved — `value: null` means nothing is unsaved. */
export function PublishDraft({ entryId, kind, value }: { entryId: string; kind: string; value: unknown }) {
  const json = value == null ? null : JSON.stringify(value);
  useEffect(() => {
    if (json == null) {
      clearDraft(entryId, kind);
      return;
    }
    const t = window.setTimeout(() => publishDraft(entryId, kind, JSON.parse(json)), 60);
    return () => window.clearTimeout(t);
  }, [entryId, kind, json]);
  useEffect(() => () => clearDraft(entryId, kind), [entryId, kind]);
  return null;
}

/** The top bar's "Second screen" control: opens or brings forward the board, and says whether it is on. */
export function SecondScreenButton() {
  const { connected } = useSecondScreen();
  return (
    <button
      type="button"
      className={`screen2${connected ? " on" : ""}`}
      title={connected ? "The second screen is open — click to bring it forward" : "Open the second screen on the other monitor"}
      onClick={() =>
        void openSecondScreen().then((ok) => {
          if (!ok) toast.warning("The browser blocked the second screen — allow pop-ups for this site, then try again.");
        })
      }
    >
      <Icon name="eye" />
      <span>2nd screen</span>
      <span className="dot" aria-hidden="true" />
    </button>
  );
}
