"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A STORED paper, drawn on the desk page by page (2026-11-07, operator: "in proforma and
 * confirmation voucher and other papers, when the user views it, it should not show the top part
 * like how it is done in quotation, only when sending it can show").
 *
 * A paper that went out — the voucher, a sent or replaced proforma or quotation, an issued tax
 * invoice, the cancellation confirmation — is shown from its stored PDF, never composed again from
 * today's figures (2026-08-02 ruling). The browser's own viewer cannot leave part of a page off, so
 * the file is drawn here with pdf.js, and:
 *   - the empty page margin around the paper is trimmed, so it fills the panel like a live paper;
 *   - in a preview the hotel's heading — its logo, name and address, down to the red line under
 *     them — is left off, as `.dmast{display:none}` leaves it off a live paper. Beside a send it
 *     stays, as the guest sees it.
 * Only the screen's drawing changes: the PDF, Print and what the guest receives are the stored file.
 * When the file cannot be drawn this way, `onFail` hands back to the browser's viewer.
 */
export function PdfPages({ blob, title, hideHeading, onFail }: { blob: Blob; title: string; hideHeading: boolean; onFail: () => void }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"drawing" | "done">("drawing");
  const failRef = useRef(onFail);
  failRef.current = onFail;

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | null = null;
    const host = holder.current;
    setState("drawing");
    (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
      destroy = () => void task.destroy();
      const doc = await task.promise;
      const canvases: HTMLCanvasElement[] = [];
      let cropX: [number, number] | null = null;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = DRAW_WIDTH / base.width;
        const viewport = page.getViewport({ scale });
        const raw = document.createElement("canvas");
        raw.width = Math.floor(viewport.width);
        raw.height = Math.floor(viewport.height);
        const ctx = raw.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no canvas");
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (cancelled) return;
        const ink = readInk(ctx, raw.width, raw.height);
        // The paper's own width is read off the first page and kept for every page.
        if (!cropX) cropX = paperColumns(ink, raw.width, raw.height);
        const rows = keptRows(ink, raw.width, raw.height, {
          first: n === 1,
          hideHeading: hideHeading && n === 1,
        });
        canvases.push(cut(raw, cropX, rows));
      }
      if (cancelled || !host) return;
      host.replaceChildren(
        ...canvases.map((c, i) => {
          c.setAttribute("role", "img");
          c.setAttribute("aria-label", canvases.length > 1 ? `${title} · page ${i + 1} of ${canvases.length}` : title);
          c.style.cssText = "display:block;width:100%;height:auto;background:#fff" + (i ? ";margin-top:10px;border-top:1px dashed #D9D7D1" : "");
          return c;
        }),
      );
      setState("done");
    })().catch(() => {
      if (!cancelled) failRef.current();
    });
    return () => {
      cancelled = true;
      destroy?.();
      host?.replaceChildren();
    };
  }, [blob, hideHeading, title]);

  return (
    <div style={{ background: "#fff" }}>
      {state === "drawing" ? <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "8px 12px" }}>Drawing the paper…</p> : null}
      <div ref={holder} />
    </div>
  );
}

/** Drawn this many pixels wide whatever the panel, then shown at the panel's width — crisp at any size. */
const DRAW_WIDTH = 1600;

/** Per pixel: ink (1) or paper (0). Ink is anything not close to white — the light rule around the
 *  paper (#D9D7D1) and its shadow count as paper, the coloured lines and the text as ink. */
function readInk(ctx: CanvasRenderingContext2D, w: number, h: number): { ink: Uint8Array; mark: Uint8Array } {
  const data = ctx.getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h);
  // `mark`: anything off the page's own background, the light rule and the shadow included — what
  // says where the paper is on its page.
  const mark = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    const lo = Math.min(data[i], data[i + 1], data[i + 2]);
    if (lo < 200) ink[p] = 1;
    if (lo < 244) mark[p] = 1;
  }
  return { ink, mark };
}

/** The columns the paper takes on its page, with a little room either side; the whole page when unclear. */
function paperColumns({ mark }: { mark: Uint8Array }, w: number, h: number): [number, number] {
  let left = w;
  let right = -1;
  for (let y = 0; y < h; y += 2) {
    const row = y * w;
    for (let x = 0; x < left; x++) if (mark[row + x]) { left = x; break; }
    for (let x = w - 1; x > right; x--) if (mark[row + x]) { right = x; break; }
  }
  if (right <= left || right - left < w * 0.4) return [0, w];
  const pad = Math.round(w * 0.012);
  return [Math.max(0, left - pad), Math.min(w, right + 1 + pad)];
}

type Rows = Array<[number, number]>;

/**
 * The rows of a page worth showing. Each page loses the blank page below what is printed, the first
 * page the blank above it; with `hideHeading`, the first page also loses the heading — everything
 * from the first printed line under the paper's top edge down to the first long line drawn across
 * the paper (the red rule under the address). Nothing is taken when that line cannot be found
 * where a heading would be.
 */
function keptRows({ ink, mark }: { ink: Uint8Array; mark: Uint8Array }, w: number, h: number, o: { first: boolean; hideHeading: boolean }): Rows {
  const rowHas = (arr: Uint8Array, y: number, min: number) => {
    let c = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) if (arr[row + x] && ++c >= min) return true;
    return false;
  };
  let top = 0;
  let bottom = h;
  if (o.first) {
    while (top < h && !rowHas(mark, top, 3)) top++;
  }
  while (bottom > top && !rowHas(mark, bottom - 1, 3)) bottom--;
  const pad = Math.round(w * 0.012);
  const start = Math.max(0, top - pad);
  const end = Math.min(h, bottom + pad);
  if (end - start < 20) return [[0, h]];
  if (!o.hideHeading) return [[start, end]];

  const longest = (y: number) => {
    let best = 0;
    let run = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (ink[row + x]) {
        run++;
        if (run > best) best = run;
      } else run = 0;
    }
    return best;
  };
  const isLine = (y: number) => longest(y) >= w * 0.4;
  // A paper's top edge: solid (the bronze or crimson border) or dashed (a notice's grey border).
  const isEdge = (y: number) => {
    let c = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) if (ink[row + x]) c++;
    return c >= w * 0.3;
  };
  const limit = top + Math.round((bottom - top) * 0.45);
  let y = top;
  // The paper's light outer rule comes first, then the edge along its top (solid or dashed) — both
  // part of the paper, not the heading.
  while (y < limit && !rowHas(ink, y, 2)) y++;
  let edgeEnd = -1;
  if (isEdge(y)) {
    while (y < limit && isEdge(y)) y++;
    edgeEnd = y;
  }
  // The heading starts at the first printed row under that edge…
  while (y < limit && !rowHas(ink, y, 2)) y++;
  const headStart = y;
  // …and ends with the first long line across the paper below it.
  while (y < limit && !isLine(y)) y++;
  if (y >= limit || y - headStart < 8) return [[start, end]];
  while (y < limit && isLine(y)) y++;
  // The blank the heading leaves either side is closed up to a small gap, as on a live paper.
  const gap = Math.round(w * 0.014);
  while (y < bottom && !rowHas(ink, y, 2)) y++;
  const resumeAt = Math.max(headStart, y - gap);
  const keepTo = edgeEnd >= 0 ? Math.min(headStart, edgeEnd + gap) : Math.max(start, headStart - gap);
  return [
    [start, Math.max(start, keepTo)],
    [resumeAt, end],
  ];
}

/** The kept rows of a drawn page, within the paper's columns, as one canvas. */
function cut(raw: HTMLCanvasElement, [x0, x1]: [number, number], rows: Rows): HTMLCanvasElement {
  const width = x1 - x0;
  const height = rows.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = Math.max(1, height);
  const ctx = out.getContext("2d");
  if (!ctx) return raw;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  let at = 0;
  for (const [a, b] of rows) {
    if (b <= a) continue;
    ctx.drawImage(raw, x0, a, width, b - a, 0, at, width, b - a);
    at += b - a;
  }
  return out;
}
