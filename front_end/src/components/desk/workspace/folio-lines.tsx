"use client";

import { useEffect, useMemo, useState } from "react";
import { Lock, Maximize2, Minimize2 } from "lucide-react";
import type { FolioLineSummary } from "@/types/api";
import { money, moneyOrDash } from "@/lib/desk/workspace";

/**
 * Compact tabular folio (2026-08-21, operator report: "the folio display is looking a bit too
 * elongated and not clear to look at — make it tabular or think of some other way").
 *
 * Two things caused the elongation, and each gets its own fix:
 *
 *  1. Every folio line was a full-height stacked row (description + meta line + amount), so a
 *     multi-room in-house booking — where the night audit posts room charge + SC + GST per room
 *     per night — ran to dozens of rows. It is now a TABLE (Date · Room · Charge · Amount),
 *     scroll-capped with a sticky header so the page never grows with the ledger; the Σ per-room
 *     subtotals and the balance stay pinned below the scroll area, always visible.
 *
 *  2. Two of every three audit lines are TAX COMPANIONS ("Service charge (10.00%) on: …",
 *     "GST (5.00%) on: …"). Each companion now folds into its parent charge's row as a muted
 *     "+ SC … · GST …" sub-line instead of two more full rows — pure display grouping: the
 *     companion lines' own stored amounts are PRINTED, never added up (no desk money math),
 *     and a companion whose parent can't be found renders as its own row, so no line is ever
 *     hidden. Detection mirrors the backend's one-home convention (lib/folio-tax-lines.ts).
 */

/** Mirror of back_end/src/lib/folio-tax-lines.ts — keep the prefixes in step. */
const SC_PREFIX = "Service charge (";
const GST_PREFIX = "GST (";
const TAX_CORR_PREFIX = "Sales tax correction on:";
const SC_CORR_PREFIX = "Service charge correction on:";
/** A charge correction's own line ("Correction for <lineId>: <reason>"). */
const CORRECTION_PREFIX = "Correction for ";

type Companion = { line: FolioLineSummary; kind: "SC" | "GST" };
type FolioRow = { line: FolioLineSummary; companions: Companion[] };

function companionKind(l: FolioLineSummary): "SC" | "GST" | null {
  const d = l.description ?? "";
  if (l.lineType === "SERVICE" && (d.startsWith(SC_PREFIX) || d.startsWith(SC_CORR_PREFIX))) return "SC";
  if (l.lineType === "OTHER" && (d.startsWith(GST_PREFIX) || d.startsWith(TAX_CORR_PREFIX))) return "GST";
  return null;
}
/** A companion posted BY A CORRECTION (its SC / GST delta) rather than by the charge itself. */
function isCorrectionCompanion(l: FolioLineSummary): boolean {
  const d = l.description ?? "";
  return d.startsWith(TAX_CORR_PREFIX) || d.startsWith(SC_CORR_PREFIX);
}

/** True for a service-charge / GST companion line — the ones that ride on a charge and are
 *  never corrected directly (the backend refuses: "correct the underlying charge line"). */
export function isTaxCompanion(l: FolioLineSummary): boolean {
  return companionKind(l) !== null;
}

/** The base-charge description a companion names ("… on: <base>"), or null. */
function companionBase(l: FolioLineSummary): string | null {
  const d = l.description ?? "";
  const i = d.indexOf(" on: ");
  if (i >= 0) return d.slice(i + 5).trim();
  if (d.startsWith(TAX_CORR_PREFIX)) return d.slice(TAX_CORR_PREFIX.length).trim();
  return null;
}

/**
 * Group companions under their parent charge; unmatched companions stay standalone rows.
 *
 * ORDER-INDEPENDENT on purpose: the entry payload serves lines newest-first (postedAt desc),
 * and a backfilled companion (scripts/backfill-night-audit-tax-lines.ts) was posted days after
 * its charge — so array position says nothing about parentage. A companion matches the charge
 * with the same room, the same charge date and the exact base description it names; when two
 * identical charges share a day (two "Dinner" on room 501), the one closest by posting time
 * wins. No match → the companion keeps its own row, so no ledger line is ever hidden.
 */
function foldTaxCompanions(lines: FolioLineSummary[]): FolioRow[] {
  const rows: FolioRow[] = [];
  const companions: { line: FolioLineSummary; kind: "SC" | "GST" }[] = [];
  for (const l of lines) {
    const kind = companionKind(l);
    if (kind) companions.push({ line: l, kind });
    else rows.push({ line: l, companions: [] });
  }
  const leftover: FolioRow[] = [];
  for (const c of companions) {
    const base = companionBase(c.line);
    // A correction's SC / GST delta names the ORIGINAL charge (so the backend can find every
    // tax line of that charge later) but is dated with the CORRECTION — so it folds under the
    // "Correction for …" row posted with it: same room, same charge date, nearest in time.
    const candidates = isCorrectionCompanion(c.line)
      ? rows.filter(
          (r) =>
            (r.line.roomId ?? null) === (c.line.roomId ?? null) &&
            r.line.chargeDate?.slice(0, 10) === c.line.chargeDate?.slice(0, 10) &&
            (r.line.description ?? "").startsWith(CORRECTION_PREFIX),
        )
      : rows.filter(
          (r) =>
            (r.line.roomId ?? null) === (c.line.roomId ?? null) &&
            r.line.chargeDate?.slice(0, 10) === c.line.chargeDate?.slice(0, 10) &&
            (base == null || r.line.description === base),
        );
    if (!candidates.length) {
      leftover.push({ line: c.line, companions: [] });
      continue;
    }
    const ct = new Date(c.line.postedAt).getTime();
    candidates.sort(
      (a, b) => Math.abs(new Date(a.line.postedAt).getTime() - ct) - Math.abs(new Date(b.line.postedAt).getTime() - ct),
    );
    candidates[0].companions.push(c);
  }
  // SC before GST on every sub-line — the order the charge maths runs in (GST compounds on
  // net + SC), whatever order the two companions happened to be posted in.
  for (const r of rows) r.companions.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "SC" ? -1 : 1));
  // Orphans keep the ledger's own position semantics: they trail the matched rows rather than
  // interleaving misleadingly (they are rare — a companion whose charge fell off the 100-line
  // window, or a legacy description that names no base).
  return [...rows, ...leftover];
}

const th: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--cream)",
  textAlign: "left",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  padding: "5px 8px",
  borderBottom: "1px solid var(--line-2)",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "5px 8px",
  borderBottom: "1px dashed var(--line)",
  verticalAlign: "top",
  whiteSpace: "nowrap",
};

/** A server-summed bucket's tax split — printed as-is, never added up on the desk. */
type TaxSplit = { base: number; serviceCharge: number; gst: number; total: number };
type Bucket = { roomId: string; roomNumber: string | null; charges: number; lineCount: number; base: number; serviceCharge: number; gst: number };

/** Which slice of the ledger a tab shows: every line, one room's lines, or the roomless ones. */
export type FolioTab = "ALL" | "WHOLE" | { roomId: string };

export type RoomTab = { roomId: string; roomNumber: string };

/** The room tabs a set of lines earns: one per room that has a line (or a server bucket). */
export function roomTabsFor(
  lines: FolioLineSummary[],
  roomNumberById?: Map<string, string>,
  perRoomCharges?: Array<{ roomId: string; roomNumber: string | null }> | null,
): RoomTab[] {
  const ids = new Set<string>();
  for (const l of lines) if (l.roomId) ids.add(l.roomId);
  for (const b of perRoomCharges ?? []) ids.add(b.roomId);
  return Array.from(ids)
    .map((roomId) => ({
      roomId,
      roomNumber: perRoomCharges?.find((b) => b.roomId === roomId)?.roomNumber ?? roomNumberById?.get(roomId) ?? "?",
    }))
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
}

/** Display-only slice of the lines for a tab — never touches any figure. */
export function filterLinesByTab<T extends { roomId?: string | null }>(lines: T[], tab: FolioTab): T[] {
  if (tab === "ALL") return lines;
  if (tab === "WHOLE") return lines.filter((l) => !l.roomId);
  return lines.filter((l) => l.roomId === tab.roomId);
}

export function sameTab(a: FolioTab, b: FolioTab): boolean {
  return typeof a === "string" || typeof b === "string" ? a === b : a.roomId === b.roomId;
}

const tabBtnStyle = (active: boolean): React.CSSProperties => ({
  border: "none",
  borderBottom: active ? "2px solid var(--green)" : "2px solid transparent",
  background: "transparent",
  color: active ? "var(--ink)" : "var(--ink-3)",
  fontWeight: active ? 700 : 600,
  fontSize: 11.5,
  padding: "6px 10px",
  cursor: "pointer",
  whiteSpace: "nowrap",
});

/**
 * The room / whole-booking tab strip — shared by the live folio and the S7 correction picker
 * (2026-08-21, operator request for both), so the two can never disagree about what a tab means.
 */
export function FolioTabStrip({
  roomTabs,
  hasRoomless,
  tab,
  onChange,
  roomTitle,
}: {
  roomTabs: RoomTab[];
  hasRoomless: boolean;
  tab: FolioTab;
  onChange: (tab: FolioTab) => void;
  /** Tooltip for a room tab, given its number. */
  roomTitle?: (roomNumber: string) => string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", overflowX: "auto", background: "var(--cream-2)", borderBottom: "1px solid var(--line-2)" }}>
      <button type="button" style={tabBtnStyle(sameTab(tab, "ALL"))} onClick={() => onChange("ALL")} title="Every line">
        All charges
      </button>
      {roomTabs.map((r) => (
        <button
          key={r.roomId}
          type="button"
          style={tabBtnStyle(sameTab(tab, { roomId: r.roomId }))}
          onClick={() => onChange({ roomId: r.roomId })}
          title={roomTitle ? roomTitle(r.roomNumber) : `Only the charges posted against Room ${r.roomNumber}`}
        >
          Room {r.roomNumber}
        </button>
      ))}
      {hasRoomless && (
        <button type="button" style={tabBtnStyle(sameTab(tab, "WHOLE"))} onClick={() => onChange("WHOLE")} title="Charges posted against the whole booking — no room named">
          Whole booking
        </button>
      )}
    </div>
  );
}

export function FolioLinesTable({
  lines,
  roomNumberById,
  perRoomCharges,
  unassignedCharges,
  chargeBreakdown,
  balance,
  currency,
  emptyText = "No charges yet",
  maxHeight = 320,
  onTabChange,
}: {
  lines: FolioLineSummary[];
  roomNumberById?: Map<string, string>;
  /** Server-summed per-room buckets from the billing summary — shown, never added up here. */
  perRoomCharges?: Bucket[] | null;
  unassignedCharges?: Omit<Bucket, "roomId" | "roomNumber"> | null;
  /** The whole ledger's server-summed split (base + SC + GST = billed so far). */
  chargeBreakdown?: TaxSplit | null;
  /** The backend's own outstandingBalance — there is no sum-of-lines on the desk. */
  balance?: string | number | null;
  currency?: string | null;
  emptyText?: string;
  maxHeight?: number;
  /** Fires when the operator opens a tab — the Stay step defaults its "For room" select to it. */
  onTabChange?: (tab: FolioTab) => void;
}) {
  const cur = currency ?? lines[0]?.currency;

  // ── Tabs (2026-08-21, operator request: "show it separately — keep the whole booking and
  // room-wise separately, and apply GST and service charge per tab"). "All charges" is the full
  // ledger; one tab per room shows only that room's lines; "Whole booking" is the roomless
  // lines. Filtering is display-only; every figure in a tab's footer is the server's own
  // bucket split, so nothing is summed on the desk.
  const roomTabs = useMemo(() => roomTabsFor(lines, roomNumberById, perRoomCharges), [lines, perRoomCharges, roomNumberById]);
  const hasRoomless = lines.some((l) => !l.roomId);
  const [tab, setTabState] = useState<FolioTab>("ALL");
  const setTab = (t: FolioTab) => {
    setTabState(t);
    onTabChange?.(t);
  };
  const visibleLines = useMemo(() => filterLinesByTab(lines, tab), [lines, tab]);
  /** The open tab's server-summed split, or null when the backend hasn't sent one. */
  let split: TaxSplit | null = null;
  if (tab === "ALL") split = chargeBreakdown ?? null;
  else if (tab === "WHOLE") {
    split = unassignedCharges
      ? { base: unassignedCharges.base, serviceCharge: unassignedCharges.serviceCharge, gst: unassignedCharges.gst, total: unassignedCharges.charges }
      : null;
  } else {
    const b = perRoomCharges?.find((x) => x.roomId === tab.roomId);
    split = b ? { base: b.base, serviceCharge: b.serviceCharge, gst: b.gst, total: b.charges } : null;
  }

  const rows = useMemo(() => foldTaxCompanions(visibleLines), [visibleLines]);
  const foldedCount = visibleLines.length - rows.length;
  const anyRoom = tab === "ALL" && rows.some((r) => r.line.roomId);

  const [showTax, setShowTax] = useState(false);

  // Expandable (2026-08-21, operator request): the same table lifted to the full-screen layer
  // the S1 room table and the S2 grid use (`.rst-expandwrap.on`), so a long ledger is read
  // whole instead of through a 320px window. Escape closes; the page behind stops scrolling.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);
  const tabLabel = tab === "ALL" ? "All charges" : tab === "WHOLE" ? "Whole booking" : `Room ${roomTabs.find((r) => r.roomId === tab.roomId)?.roomNumber ?? "?"}`;


  return (
    <div className={expanded ? "rst-expandwrap on" : "rst-expandwrap"}>
      {expanded && (
        <div className="rst-expandbar">
          <b>
            Live folio · {tabLabel} · {rows.length} charge{rows.length === 1 ? "" : "s"}
          </b>
          <span className="ln" />
          <button type="button" className="btn btn-ghost" onClick={() => setExpanded(false)} title="Close the expanded folio (Esc)">
            <Minimize2 style={{ width: 13, height: 13 }} /> Close
          </button>
        </div>
      )}
    <div
      className="folio"
      // In the layer the shell is a flex column that fills the screen; only the rows scroll.
      style={expanded ? { display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 } : undefined}
    >
      <div className="folio-h">
        Charges{visibleLines.length > 0 ? ` · ${rows.length}` : ""}
        {foldedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowTax((v) => !v)}
            title="Service-charge and GST companion lines are folded under the charge they belong to — toggle to list every ledger line on its own row"
            style={{
              border: "none",
              background: "rgba(255,255,255,0.16)",
              color: "inherit",
              borderRadius: 999,
              padding: "1px 8px",
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: "0.02em",
              textTransform: "none",
              cursor: "pointer",
            }}
          >
            {showTax ? "fold tax lines" : `+ ${foldedCount} tax lines folded`}
          </button>
        )}
        {!expanded && lines.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            title="Expand the folio to the full screen (Esc closes)"
            style={{
              border: "none",
              background: "rgba(255,255,255,0.16)",
              color: "inherit",
              borderRadius: 999,
              padding: "1px 8px",
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: "0.02em",
              textTransform: "none",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Maximize2 style={{ width: 10, height: 10 }} /> Expand
          </button>
        )}
        <span className="lk">
          <Lock />
          live · append-only
        </span>
      </div>

      {(roomTabs.length > 0 || hasRoomless) && lines.length > 0 && (
        <FolioTabStrip
          roomTabs={roomTabs}
          hasRoomless={hasRoomless}
          tab={tab}
          onChange={setTab}
          roomTitle={(n) => `Only the charges posted against Room ${n}, with their own service charge and GST`}
        />
      )}

      {lines.length === 0 ? (
        <div className="fline">
          <span className="fl-d" style={{ color: "var(--ink-3)" }}>
            {emptyText}
          </span>
        </div>
      ) : visibleLines.length === 0 ? (
        <div className="fline">
          <span className="fl-d" style={{ color: "var(--ink-3)" }}>
            Nothing posted here yet
          </span>
        </div>
      ) : (
        // Lines arrive newest-first from the entry payload, so today's postings sit at the
        // top of the scroll area with no anchoring needed.
        <div
          style={
            expanded
              ? { flex: "1 1 auto", minHeight: 160, overflowY: "auto", overflowX: "auto", background: "var(--paper)" }
              : { maxHeight, overflowY: "auto", overflowX: "auto", background: "var(--paper)" }
          }
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                {anyRoom && <th style={th}>Room</th>}
                <th style={{ ...th, width: "99%" }}>Charge</th>
                <th style={{ ...th, textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((r) => {
                const l = r.line;
                const sys = !!l.nightAuditRecordId;
                const main = (
                  <tr key={l.id}>
                    <td style={{ ...td, color: "var(--ink-2)" }}>{l.chargeDate?.slice(0, 10) ?? "—"}</td>
                    {anyRoom && (
                      <td style={{ ...td, color: l.roomId ? undefined : "var(--ink-4)" }}>
                        {l.roomId ? roomNumberById?.get(l.roomId) ?? "?" : "—"}
                      </td>
                    )}
                    <td style={{ ...td, whiteSpace: "normal", minWidth: 160 }}>
                      <span
                        style={{ marginRight: 5, color: "var(--ink-3)" }}
                        title={sys ? "Posted by the night audit" : "Posted at the desk"}
                      >
                        {sys ? "⚙" : "✎"}
                      </span>
                      {l.description}
                      <span style={{ marginLeft: 6, fontSize: 10, color: "var(--ink-4)" }}>{l.lineType}</span>
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {money(l.amount, l.currency)}
                      {/* The tax companions sit UNDER the amount, in the same column (2026-08-21,
                          operator request: "keep the amounts above the GST and service charge") —
                          printed at their own stored amounts, never summed. */}
                      {!showTax && r.companions.length > 0 && (
                        <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 1, lineHeight: 1.35 }}>
                          {r.companions.map((c) => (
                            <div key={c.line.id} title={c.line.description} style={{ whiteSpace: "nowrap" }}>
                              + {c.kind === "SC" ? "SC" : "GST"} {money(c.line.amount, c.line.currency)}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
                if (!showTax) return [main];
                // Expanded: each companion becomes its own (muted) row, ledger-faithful.
                return [
                  main,
                  ...r.companions.map((c) => (
                    <tr key={c.line.id}>
                      <td style={{ ...td, color: "var(--ink-4)" }}>{c.line.chargeDate?.slice(0, 10) ?? "—"}</td>
                      {anyRoom && (
                        <td style={{ ...td, color: "var(--ink-4)" }}>
                          {c.line.roomId ? roomNumberById?.get(c.line.roomId) ?? "?" : "—"}
                        </td>
                      )}
                      <td style={{ ...td, whiteSpace: "normal", color: "var(--ink-3)", paddingLeft: 26 }}>
                        {c.line.description}
                        <span style={{ marginLeft: 6, fontSize: 10, color: "var(--ink-4)" }}>{c.line.lineType}</span>
                      </td>
                      <td style={{ ...td, textAlign: "right", color: "var(--ink-3)", fontVariantNumeric: "tabular-nums" }}>
                        {money(c.line.amount, c.line.currency)}
                      </td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pinned footer — the summary must stay visible while the ledger scrolls. Every figure is
          SERVER-summed (billing summary); the balance is the folio's own outstandingBalance. */}
      {split && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 8,
            padding: "7px 13px",
            background: "var(--paper)",
            borderTop: "1px solid var(--line-2)",
            fontSize: 11.5,
          }}
          title={
            tab === "ALL"
              ? "The whole ledger, split into charges, service charge and GST — summed on the server"
              : tab === "WHOLE"
                ? "Charges with no room named, with their own service charge and GST — summed on the server"
                : "This room's charges, service charge and GST — summed on the server"
          }
        >
          {(
            [
              ["Charges", split.base],
              ["Service charge", split.serviceCharge],
              ["GST", split.gst],
              [tab === "ALL" ? "Billed so far" : "Total", split.total],
            ] as Array<[string, number]>
          ).map(([label, v]) => (
            <div key={label} style={{ minWidth: 0 }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--ink-3)" }}>{label}</div>
              <div style={{ fontWeight: label === "Total" || label === "Billed so far" ? 700 : 600, fontVariantNumeric: "tabular-nums" }}>{money(v, cur)}</div>
            </div>
          ))}
        </div>
      )}
      {tab === "ALL" && perRoomCharges && perRoomCharges.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "3px 14px",
            padding: "6px 13px",
            background: "var(--cream)",
            borderTop: "1px solid var(--line-2)",
            fontSize: 11.5,
          }}
        >
          {perRoomCharges.map((r) => (
            <button
              key={r.roomId}
              type="button"
              onClick={() => setTab({ roomId: r.roomId })}
              style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", font: "inherit" }}
              title={`${r.lineCount} line${r.lineCount === 1 ? "" : "s"} — summed on the server · open this room's tab`}
            >
              <span style={{ color: "var(--ink-3)" }}>Σ Room {r.roomNumber ?? "?"}</span>{" "}
              <b style={{ fontVariantNumeric: "tabular-nums" }}>{money(r.charges, cur)}</b>
            </button>
          ))}
          {unassignedCharges && (
            <button
              type="button"
              onClick={() => setTab("WHOLE")}
              style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", font: "inherit" }}
              title={`${unassignedCharges.lineCount} line${unassignedCharges.lineCount === 1 ? "" : "s"} with no room named · open the whole-booking tab`}
            >
              <span style={{ color: "var(--ink-3)" }}>Σ Whole booking</span>{" "}
              <b style={{ fontVariantNumeric: "tabular-nums" }}>{money(unassignedCharges.charges, cur)}</b>
            </button>
          )}
        </div>
      )}
      {balance !== undefined && tab === "ALL" && (
        <div className="fline total">
          <span className="fl-mk mk sys">⚙</span>
          <span className="fl-d">Balance due (from folio)</span>
          <span className="fl-a">{moneyOrDash(balance, cur)}</span>
        </div>
      )}
    </div>
    </div>
  );
}
