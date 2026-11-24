"use client";

/**
 * How to use the room chart (2026-11-24, operator: "on the top right corner can you add a tutorial button
 * when clicked it'll show how to use the chart … use that [the chart's shortcuts page] … make it proper and
 * user friendly so the people who look at the tutorial can easily navigate and learn").
 *
 * The guide is one page, `public/help/room-chart.html` — reading the chart, its colours, and the animated
 * examples of selecting, moving and swapping. It opens here in a large pop-up over the page; Close, Esc (in
 * the guide or around it) or a click outside closes it, and the page behind stays where it was.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/design-system";

const GUIDE_URL = "/help/room-chart.html";

export function ChartGuideButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button kind="secondary" className="guide-btn" onClick={() => setOpen(true)}>
        How to use the chart
      </Button>
      {open ? <ChartGuide onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ChartGuide({ onClose }: { onClose: () => void }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => setHost(document.querySelector<HTMLElement>("[data-ds-overlays]") ?? document.body), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Esc pressed inside the guide reaches the desk as a message (the guide's own page sends it).
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && (e.data as { type?: string } | null)?.type === "chart-guide-close") onClose();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    // The page behind holds still while the guide is open.
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
      html.style.overflow = before;
    };
  }, [onClose]);
  if (!host) return null;
  return createPortal(
    <div className="guide-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="guide-box" role="dialog" aria-modal="true" aria-label="How to use the room chart">
        <div className="guide-head">
          <b>How to use the room chart</b>
          <a className="guide-tab" href={GUIDE_URL} target="_blank" rel="noopener">
            Open in a new tab
          </a>
          <Button kind="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        <iframe ref={frame} className="guide-frame" src={`${GUIDE_URL}?embed=1`} title="How to use the room chart" onLoad={() => frame.current?.focus()} />
      </div>
    </div>,
    host,
  );
}
