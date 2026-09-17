import React from "react";
import { Icon, IconName, Button, ButtonProps } from "./primitives";

/* ------------------------------------------------------------------
   Meaning-carrying treatments. Two labels on every fact, on two
   channels: SourceMark (glyph beside the fact) and BindingBox (the
   container around it). They never share a channel.
   ------------------------------------------------------------------ */

/* ---------- where a fact came from (glyph + word, never colour) ---------- */
export type SourceKind = "captured" | "derived" | "suggested" | "system" | "ai";
const SOURCE_GLYPH: Record<SourceKind, IconName> = { captured: "pen", derived: "equals", suggested: "spark", system: "auto", ai: "ai" };
const SOURCE_WORD: Record<SourceKind, string> = { captured: "entered", derived: "worked out", suggested: "suggested", system: "done by the system", ai: "AI-produced" };

export function SourceMark({ kind, word, children }: { kind: SourceKind; word?: boolean; children: React.ReactNode }) {
  return (
    <span className={`src ${kind}`} title={SOURCE_WORD[kind]}>
      <Icon name={SOURCE_GLYPH[kind]} className="g" />
      <span>{children}</span>
      {word ? <span className="word">{SOURCE_WORD[kind]}</span> : null}
    </span>
  );
}

/** The attribution line under a System-fulfilled fact: what, when, under what authority. */
export function Attribution({ children }: { children: React.ReactNode }) {
  return <span className="meta">{children}</span>;
}

/* ---------- how binding a fact is (the container) ---------- */
export type BindingFamily = "provisional" | "pending" | "bound";
const BINDING_GLYPH: Record<BindingFamily, IconName> = { provisional: "pen", pending: "lock-open", bound: "lock" };
const BINDING_DEFAULT_WORD: Record<BindingFamily, string> = { provisional: "can be changed", pending: "awaiting", bound: "in force" };

export function BindingBox({ family, stateWord, style, className = "", children }: { family: BindingFamily; stateWord?: React.ReactNode; style?: React.CSSProperties; className?: string; children: React.ReactNode }) {
  return (
    <div className={`bind ${family} ${className}`} style={style}>
      <span className="state"><Icon name={BINDING_GLYPH[family]} />{stateWord ?? BINDING_DEFAULT_WORD[family]}</span>
      {children}
    </div>
  );
}

/* ---------- timers ---------- */
export type TimerState = "running" | "close" | "overdue" | "fired";
export function Timer({ state = "running", label, time }: { state?: TimerState; label: React.ReactNode; time: React.ReactNode }) {
  const icon: IconName = state === "overdue" ? "alert" : state === "fired" ? "check" : "clock";
  return (
    <span className={`timer${state === "running" ? "" : ` ${state}`}`}>
      <Icon name={icon} />{label} <span className="t">{state === "overdue" ? <>overdue {time}</> : time}</span>
    </span>
  );
}

/* ---------- gate checklist ---------- */
export type GateItemState = "met" | "unmet" | "refused";
export interface GateItem { id: string; state: GateItemState; label: React.ReactNode; how?: React.ReactNode }

export interface GateChecklistProps { items: GateItem[]; className?: string }
export function GateChecklist({ items, className = "" }: GateChecklistProps) {
  return (
    <div className={`gate ${className}`}>
      {items.map((it) => (
        <div key={it.id} className={`item ${it.state}`}>
          <Icon name={it.state === "met" ? "check" : it.state === "refused" ? "x" : "circle"} />
          <span>{it.label}{it.how ? <span className="how">{it.how}</span> : null}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- refusal: four kinds, and the reserved place ----------
   `guidance` is filled by the backend. When absent, nothing is rendered in its
   place — no placeholder, no house sentence. `carries` is for what the refusal
   itself already says (the unlocking role, the permitting step): it is different
   each time, so it is not the standing line the rules forbid. */
export type RefusalKind = "rule" | "state" | "authority" | "fault";
const KIND_LABEL: Record<RefusalKind, string> = { rule: "A hotel rule refused this", state: "Not at this step", authority: "Needs a higher role", fault: "The system couldn't do this" };
const KIND_ICON: Record<RefusalKind, IconName> = { rule: "x", state: "info", authority: "lock", fault: "alert" };

export function Refusal({ kind, message, guidance, carries, onWhy, actions }: {
  kind: RefusalKind;
  /** The backend's message, vocabulary translated, rule untouched. */
  message: React.ReactNode;
  /** The backend-supplied rule sentence. Omit when the backend did not send one. */
  guidance?: React.ReactNode;
  /** Something true carried by the refusal itself (who unlocks it, which step permits it). */
  carries?: React.ReactNode;
  onWhy?: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className={`refusal ${kind}`} role="alert">
      <div className="kind"><Icon name={KIND_ICON[kind]} />{KIND_LABEL[kind]}</div>
      <div className="msg">{message}</div>
      {guidance || carries ? (
        <div className="guidance">
          {guidance}{guidance && carries ? " " : null}{carries}
          {onWhy ? <> <a href="#why" onClick={(e: React.MouseEvent<HTMLElement>) => { e.preventDefault(); onWhy(); }}>why?</a></> : null}
        </div>
      ) : null}
      {actions ? <div className="acts">{actions}</div> : null}
    </div>
  );
}

/** Convenience: the retry pair every fault refusal offers. */
export function FaultActions({ onRetry, onEscalate, escalateTo = "FOM" }: { onRetry?: () => void; onEscalate?: () => void; escalateTo?: string }) {
  const compact: Partial<ButtonProps> = { compact: true };
  return (
    <>
      <Button kind="secondary" icon="retry" onClick={onRetry} {...compact}>Retry</Button>
      <Button kind="quiet" onClick={onEscalate} {...compact}>Tell the {escalateTo}</Button>
    </>
  );
}
