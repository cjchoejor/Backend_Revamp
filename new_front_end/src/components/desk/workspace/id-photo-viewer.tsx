"use client";

/**
 * An ID photo beside the guest table (2026-10-29, operator: "when the user clicks on the image it
 * opens a different browser tab — instead show it on the right side, like a pop-up blurring the
 * right side, with a close button, so when a document is not clear the user can look at the image
 * and type side by side").
 *
 * Drawn over the booking file — the right-hand column of the stage layout, blurred behind it — so
 * the guest table on the left stays in reach; on a page without that column it takes the right
 * half of the window. Zoom, turn and Close; Escape closes it too. One photo at a time: opening
 * another replaces it. The viewer fetches its own copy of the file and lets it go on closing.
 */
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

type Shown = { id: string; url: string; mime: string; title: string };

let shown: Shown | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Show a photo (its object URL is the viewer's from now on), or close with null. */
export function showIdPhoto(next: Shown | null) {
  if (shown && shown.url !== next?.url) URL.revokeObjectURL(shown.url);
  shown = next;
  emit();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

/** The area the viewer covers: the booking file when the page has one, else the right half. */
function useArea(open: boolean) {
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const measure = useCallback(() => {
    const file = document.querySelector<HTMLElement>("aside.file");
    const r = file?.getBoundingClientRect();
    if (r && r.width > 240) setBox({ top: r.top, left: r.left, width: r.width, height: Math.min(r.height, window.innerHeight - r.top) });
    else setBox({ top: 0, left: Math.round(window.innerWidth / 2), width: Math.round(window.innerWidth / 2), height: window.innerHeight });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);
  return box;
}

/** Mounted once by the guest table — draws the photo that `showIdPhoto` names. */
export function IdPhotoViewerHost() {
  const s = useSyncExternalStore(subscribe, () => shown, () => null);
  const [zoom, setZoom] = useState(1);
  const [turn, setTurn] = useState(0);
  const box = useArea(!!s);
  useEffect(() => {
    setZoom(1);
    setTurn(0);
  }, [s?.id]);
  useEffect(() => {
    if (!s) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      showIdPhoto(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [s]);
  // Closing with the page: the photo's copy is let go.
  useEffect(() => () => showIdPhoto(null), []);
  if (!s || !box || typeof document === "undefined") return null;
  const isPdf = s.mime === "application/pdf";
  const host = document.querySelector<HTMLElement>("[data-ds-overlays]") ?? document.body;
  const btn: React.CSSProperties = {
    height: 32,
    minWidth: 32,
    padding: "0 10px",
    border: "1px solid var(--line-2, #b9b9b0)",
    borderRadius: 4,
    background: "var(--surface, #fff)",
    color: "var(--ink, #1b1e1c)",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  };
  return createPortal(
    <div
      data-id-photo-viewer=""
      role="dialog"
      aria-label={`ID photo — ${s.title}`}
      style={{
        position: "fixed",
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        zIndex: 83,
        background: "rgba(246, 246, 244, 0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        padding: 12,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--surface, #fff)",
          border: "1px solid var(--line-2, #b9b9b0)",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(20, 24, 22, 0.18)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: "1px solid var(--line, #dcdcd6)" }}>
          <b style={{ flex: 1, minWidth: 0, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</b>
          {isPdf ? null : (
            <>
              <button type="button" style={btn} aria-label="Smaller" onClick={() => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(1)))} disabled={zoom <= 1}>
                −
              </button>
              <span style={{ fontSize: 13, minWidth: 40, textAlign: "center", color: "var(--ink-3, #6b6f6c)" }}>{Math.round(zoom * 100)}%</span>
              <button type="button" style={btn} aria-label="Larger" onClick={() => setZoom((z) => Math.min(4, +(z + 0.5).toFixed(1)))} disabled={zoom >= 4}>
                +
              </button>
              <button type="button" style={btn} aria-label="Turn" title="Turn a quarter" onClick={() => setTurn((t) => (t + 90) % 360)}>
                ↻
              </button>
            </>
          )}
          <button type="button" style={{ ...btn, fontWeight: 600 }} onClick={() => showIdPhoto(null)}>
            Close
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", alignItems: zoom > 1 ? "flex-start" : "center", justifyContent: zoom > 1 ? "flex-start" : "center", background: "var(--surface-2, #f6f6f4)" }}>
          {isPdf ? (
            <iframe title={s.title} src={s.url} style={{ width: "100%", height: "100%", border: 0 }} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- blob object-URL, next/image can't optimise it
            <img
              src={s.url}
              alt={s.title}
              onClick={() => setZoom((z) => (z > 1 ? 1 : 2))}
              style={{
                cursor: zoom > 1 ? "zoom-out" : "zoom-in",
                transform: turn ? `rotate(${turn}deg)` : undefined,
                transition: "transform 120ms ease",
                ...(zoom > 1 ? { width: `${zoom * 100}%`, maxWidth: "none" } : { maxWidth: "100%", maxHeight: "100%" }),
              }}
            />
          )}
        </div>
      </div>
    </div>,
    host,
  );
}
