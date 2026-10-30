"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * The box a date or time picker opens in (2026-10-29, operator: "please keep a OK or tick button in
 * the calendar and time when the user is choosing them, because the screen doesn't have anywhere
 * to exit those once they have chosen, except clicking outside those fields"). The browser's own
 * pickers had no OK; these have one, beside Cancel.
 *
 * Drawn at the desk's root (`[data-ds-overlays]`, so the desk's colours apply and no scrolling card
 * or size container clips or re-anchors it), else on the page body (the admin console), under the
 * field it belongs to — above it when there is no room below. Escape cancels and is kept from the
 * dialog behind; a press outside cancels too. Its colours fall back to plain values off the desk.
 */

export const pickColours = {
  surface: "var(--surface, #ffffff)",
  surface2: "var(--surface-2, #f6f6f4)",
  line: "var(--line, #dcdcd6)",
  line2: "var(--line-2, #b9b9b0)",
  ink: "var(--ink, #1b1e1c)",
  muted: "var(--ink-3, #6b6f6c)",
  accent: "var(--accent, #1d4f91)",
  accentSoft: "var(--accent-soft, #e7eef8)",
  accentInk: "var(--accent-ink, #173f74)",
  go: "var(--success, #1e7a4f)",
};

export function PickPopover({
  anchor,
  open,
  onCancel,
  children,
  width = 260,
  label,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onCancel: () => void;
  children: ReactNode;
  width?: number;
  label: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    setHost(document.querySelector<HTMLElement>("[data-ds-overlays]") ?? document.body);
  }, []);

  const place = () => {
    const a = anchor.current?.getBoundingClientRect();
    if (!a) return;
    const h = box.current?.offsetHeight ?? 320;
    const below = a.bottom + 6;
    const top = below + h > window.innerHeight - 8 && a.top - 6 - h > 8 ? a.top - 6 - h : below;
    const left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8));
    setPos({ top, left });
  };
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The picker takes Escape first — the dialog behind it stays open.
      e.stopPropagation();
      e.preventDefault();
      onCancel();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, onCancel, anchor]);

  if (!open || !host) return null;
  const style: CSSProperties = {
    position: "fixed",
    top: pos?.top ?? -9999,
    left: pos?.left ?? -9999,
    width,
    zIndex: 96,
    background: pickColours.surface,
    color: pickColours.ink,
    border: `1px solid ${pickColours.line2}`,
    borderRadius: 8,
    boxShadow: "0 8px 24px rgba(20, 24, 22, 0.18)",
    padding: 10,
    fontSize: 14,
  };
  return createPortal(
    <div ref={box} role="dialog" aria-label={label} style={style} data-pick-popover="">
      {children}
    </div>,
    host,
  );
}

/** The picker's foot: what is picked, then Cancel and ✓ OK. */
export function PickFooter({ picked, okLabel = "OK", canOk, onOk, onCancel }: { picked: ReactNode; okLabel?: string; canOk: boolean; onOk: () => void; onCancel: () => void }) {
  const btn: CSSProperties = { height: 32, padding: "0 12px", borderRadius: 4, fontSize: 14, fontWeight: 600, cursor: "pointer" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${pickColours.line}` }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: pickColours.muted }}>{picked}</span>
      <button type="button" onClick={onCancel} style={{ ...btn, background: pickColours.surface, border: `1px solid ${pickColours.line2}`, color: pickColours.ink, fontWeight: 500 }}>
        Cancel
      </button>
      <button
        type="button"
        data-pick-ok=""
        disabled={!canOk}
        onClick={onOk}
        style={{
          ...btn,
          background: canOk ? pickColours.go : pickColours.surface2,
          border: `1px solid ${canOk ? pickColours.go : pickColours.line}`,
          color: canOk ? "#fff" : pickColours.muted,
          cursor: canOk ? "pointer" : "not-allowed",
        }}
      >
        ✓ {okLabel}
      </button>
    </div>
  );
}

/** One choice in a picker's column or grid: picked (accent, bold), open, or shut (muted, not pressable). */
export function pickCell(on: boolean, shut: boolean, extra: CSSProperties = {}): CSSProperties {
  return {
    height: 30,
    border: `1px solid ${on ? pickColours.accent : "transparent"}`,
    borderRadius: 4,
    background: on ? pickColours.accentSoft : "transparent",
    color: shut ? pickColours.line2 : on ? pickColours.accentInk : pickColours.ink,
    fontWeight: on ? 700 : 500,
    fontSize: 14,
    cursor: shut ? "not-allowed" : "pointer",
    textDecoration: shut ? "line-through" : "none",
    padding: 0,
    ...extra,
  };
}
