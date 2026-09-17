"use client";

/**
 * Pieces Check-in and Stay share: the desk's words for a room's standing, an inline slot for the
 * old per-room controls, and the one way a canvas brings a working block into view.
 */
import { useEffect, type ReactNode } from "react";
import { Icon, type DialogRegister } from "@/design-system";
import type { EntryDetail, RoomAssignmentSummary } from "@/types/api";
import { useStepMode } from "./kit";

/** A room's commercial standing, as the desk says it (never the stored code). */
const CLAIM_WORD: Record<string, string> = {
  FREE: "free",
  SPECULATIVELY_HELD: "marked",
  COMMITTED_HELD: "blocked",
  CONFIRMED: "reserved",
  OCCUPIED: "occupied",
  DEPARTED_DIRTY: "vacated · to clean",
  DEPARTED_CLEAN: "vacated · clean",
};

/** Housekeeping's word for the room. */
const PHYSICAL_WORD: Record<string, string> = {
  AVAILABLE_CLEAN: "clean",
  AVAILABLE_INSPECTED: "inspected",
  DIRTY: "needs cleaning",
  UNDER_MAINTENANCE: "under maintenance",
};

export function claimWord(state?: string | null): string | null {
  if (!state) return null;
  return CLAIM_WORD[state] ?? state.replace(/_/g, " ").toLowerCase();
}

export function physicalWord(state?: string | null): string | null {
  if (!state) return null;
  return PHYSICAL_WORD[state] ?? state.replace(/_/g, " ").toLowerCase();
}

/** Ready for a guest to walk in — the same reading the check-in readiness list makes. */
export function physicallyReady(a: RoomAssignmentSummary): boolean {
  const ps = a.room?.physicalState;
  if (ps) return ps === "AVAILABLE_CLEAN" || ps === "AVAILABLE_INSPECTED";
  return a.deficientAtAssignment ? !!(a.acknowledgementActorId && a.acknowledgementAt) : true;
}

/** One row per room, whatever number of dated rows the booking holds for it. */
export function distinctRoomRows(entry: EntryDetail): RoomAssignmentSummary[] {
  return Array.from(new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a])).values());
}

export function roomLabel(a: RoomAssignmentSummary): string {
  return a.room?.roomNumber ?? a.roomId.slice(0, 8);
}

/**
 * An old per-room control (the bed dropdown, the "initially" cell, the room change) placed
 * inline in a native row. Re-dressed by legacy-bridge.css; inert on a passed step.
 */
export function InlineTool({ children }: { children: ReactNode }) {
  const { past } = useStepMode();
  return (
    <span className="desk-root" style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }} inert={past || undefined}>
      {children}
    </span>
  );
}

/**
 * Bring a working block into view and, when it starts folded, open it. The old blocks fold
 * behind their own header; a click on that header is the only door they offer.
 */
export function revealBlock(id: string, open = true): boolean {
  if (typeof document === "undefined") return false;
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  if (open) {
    const header = el.querySelector<HTMLElement>(".block-h[title='Show this section'], .block-h[title='Click to open']");
    header?.click();
  }
  return true;
}

/**
 * The kit's dialog, wider. `DsDialog` sizes its holder, but `.dialog` is fixed at 460px by the
 * generated stylesheet — a table or a two-column form needs the dialog itself sized. Same markup
 * as the design system's `Dialog`; Escape and a click on the scrim close it unless it is busy.
 */
export function WideDialog({
  open,
  onClose,
  register = "commit",
  title,
  caseLines,
  children,
  footer,
  width,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  register?: DialogRegister;
  title: ReactNode;
  caseLines?: ReactNode[];
  children?: ReactNode;
  footer: ReactNode;
  width: number;
  busy?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);
  if (!open) return null;
  const icon = register === "commit" ? "lock" : register === "danger" ? "alert" : "check";
  return (
    <div className="scrim open" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`dialog ${register}`} role="dialog" aria-modal="true" style={{ width, maxWidth: "100%" }}>
        <div className="body">
          <h3>
            <Icon name={icon} size="lg" />
            {title}
          </h3>
          {caseLines?.length ? (
            <div className="case">
              {caseLines.map((l, i) => (
                <span key={i}>{l}</span>
              ))}
            </div>
          ) : null}
          {children}
        </div>
        <div className="foot">{footer}</div>
      </div>
    </div>
  );
}
