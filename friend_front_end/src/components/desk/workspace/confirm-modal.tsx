"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Check, Lock } from "lucide-react";

export type DeskConfirmModalProps = {
  open: boolean;
  title: string;
  subtitle?: string;
  /** One-line framing of why this pauses the operator. */
  why: ReactNode;
  /** The named, irreversible consequences — the heart of the pattern. */
  consequences: ReactNode[];
  confirmLabel: string;
  cancelLabel?: string;
  pending?: boolean;
  /** "commit" (green, lock — the default) or "danger" (red, warning — for terminal acts). */
  tone?: "commit" | "danger";
  onConfirm: () => void;
  onClose: () => void;
};

/**
 * The one consequential pause. Reserved for acts that commit money or a room
 * the operator can't quietly reclaim — names exactly what becomes irreversible
 * before it commits. Rendered inside `.desk-root` so the theme tokens apply.
 */
export function DeskConfirmModal({
  open,
  title,
  subtitle,
  why,
  consequences,
  confirmLabel,
  cancelLabel = "Not yet",
  pending = false,
  tone = "commit",
  onConfirm,
  onClose,
}: DeskConfirmModalProps) {
  if (!open) return null;
  const danger = tone === "danger";
  const accent = danger ? "var(--stop)" : "var(--green)";
  const Icon = danger ? AlertTriangle : Lock;
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-top" style={danger ? { background: "var(--stop-t)", borderBottomColor: "#e2b3ac" } : undefined}>
          <div className="modal-ic" style={{ background: accent }}>
            <Icon />
          </div>
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        <div className="modal-body">
          <p className="why">{why}</p>
          <div className="modal-consq">
            {consequences.map((c, i) => (
              <div className="ci" key={i}>
                <Check />
                <span>{c}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </button>
          <button
            className="btn btn-primary"
            style={{ background: accent }}
            onClick={onConfirm}
            disabled={pending}
          >
            <Icon />
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
