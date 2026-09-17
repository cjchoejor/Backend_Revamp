import React from "react";
import { Icon, IconName, Button, Chip, Card } from "./primitives";
import { Timer, TimerState, GateChecklist, GateItem, SourceMark } from "./meaning";

/* ---------- table: rows open a workspace; they carry no actions ---------- */
export function Table({ compact, children, className = "", style }: { compact?: boolean; children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return <table className={["table", compact ? "compact" : "", className].filter(Boolean).join(" ")} style={style}>{children}</table>;
}

export function Row({ selected, locked, onOpen, children }: { selected?: boolean; locked?: boolean; onOpen?: () => void; children: React.ReactNode }) {
  const cls = [selected ? "selected" : "", locked ? "locked" : ""].filter(Boolean).join(" ") || undefined;
  return <tr className={cls} onClick={onOpen} aria-selected={selected || undefined}>{children}</tr>;
}

/** The keyboard-focusable target inside a row: whole-row pointer behaviour mirrors it. */
export function RowLink({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return <a className="row-link" href={href} aria-label={label}>{children}</a>;
}

/** Money in a cell: right-aligned, tabular; a dash when the backend has no figure. */
export function MoneyCell({ value }: { value?: string | null }) {
  return <td className={`num ${value ? "money" : "dash"}`}>{value ?? "—"}</td>;
}

/* ---------- room tile: claim standing and physical state, kept apart ---------- */
export type RoomStanding = "free" | "speculatively-held" | "committed-held" | "reserved" | "occupied" | "ooo" | "deficient";
export type RoomPhysical = "clean" | "inspected" | "needs-cleaning" | "out-of-order" | "blocked" | "deficient";
const STANDING_WORD: Record<RoomStanding, string> = { free: "free", "speculatively-held": "Speculatively held", "committed-held": "Committed held", reserved: "Reserved", occupied: "Occupied", ooo: "Out of order", deficient: "Deficient" };
const PHYS_WORD: Record<RoomPhysical, string> = { clean: "Clean", inspected: "Inspected", "needs-cleaning": "Needs cleaning", "out-of-order": "Out of order", blocked: "Blocked", deficient: "Deficient" };
const PHYS_ICON: Record<RoomPhysical, IconName> = { clean: "check", inspected: "check", "needs-cleaning": "broom", "out-of-order": "wrench", blocked: "lock", deficient: "alert" };

export function RoomTile({ number, standing, qualifier, occupant, physical, note, selected, guide, onSelect }: {
  number: string; standing: RoomStanding; qualifier?: React.ReactNode; occupant?: string; physical?: RoomPhysical; note?: React.ReactNode; selected?: boolean; guide?: boolean; onSelect?: () => void;
}) {
  const cls = ["room", standing, selected ? "selected" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls} onClick={onSelect} role={onSelect ? "button" : undefined} tabIndex={onSelect ? 0 : undefined} aria-pressed={selected || undefined}>
      <div className="no">{number}</div>
      <div className="who" style={occupant ? undefined : { color: "var(--ink-4)" }}>{occupant ?? (guide ? "guide room · free" : "free")}</div>
      {standing !== "free" ? (
        <div className="standing" style={standing === "deficient" ? { color: "var(--warning)" } : undefined}>
          {standing === "occupied" ? <Icon name="person" /> : standing === "ooo" ? <Icon name="wrench" /> : standing === "deficient" ? <Icon name="alert" /> : null}
          {STANDING_WORD[standing]}{qualifier ? <span className="meta"> · {qualifier}</span> : null}{guide && standing === "occupied" ? <span className="meta"> · guide room</span> : null}
        </div>
      ) : null}
      {physical ? <div className="phys"><Icon name={PHYS_ICON[physical]} />{PHYS_WORD[physical]}</div> : null}
      {note ? <div className="phys">{note}</div> : null}
    </div>
  );
}

/* ---------- dialogs: two registers and the report ---------- */
export type DialogRegister = "commit" | "danger" | "report";
export function Dialog({ register, title, caseLines, children, footer }: { register: DialogRegister; title: React.ReactNode; caseLines?: React.ReactNode[]; children?: React.ReactNode; footer: React.ReactNode }) {
  const icon: IconName = register === "commit" ? "lock" : register === "danger" ? "alert" : "check";
  return (
    <div className={`dialog ${register}`} role="dialog" aria-modal="true">
      <div className="body">
        <h3><Icon name={icon} size="lg" />{title}</h3>
        {caseLines?.length ? <div className="case">{caseLines.map((l, i) => <span key={i}>{l}</span>)}</div> : null}
        {children}
      </div>
      <div className="foot">{footer}</div>
    </div>
  );
}

/* ---------- document card: rendered by the backend; preview · PDF · print · send · answer ---------- */
export type AnswerStatus = { kind: "answered"; text: React.ReactNode } | { kind: "awaiting"; timer: React.ReactNode; state?: TimerState } | { kind: "none" };
export function DocumentCard({ name, version, generated, amount, sent, answer, superseded, onPreview, onPdf, onPrint, onSend, onVerbal, note }: {
  name: React.ReactNode; version?: React.ReactNode; generated: React.ReactNode; amount?: string; sent?: React.ReactNode; answer?: AnswerStatus; superseded?: React.ReactNode;
  onPreview?: () => void; onPdf?: () => void; onPrint?: () => void; onSend?: () => void; onVerbal?: () => void; note?: React.ReactNode;
}) {
  return (
    <Card sealed={!!superseded}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <h4 className={superseded ? "ink-2" : undefined}><Icon name="file" /> {name}</h4>
        {superseded ? <Chip tone="quiet">{superseded}</Chip> : version ? <Chip>{version}</Chip> : null}
      </div>
      <div className="meta">Generated {generated}{amount ? <> · <span className="money">{amount}</span></> : null}</div>
      {note ? <div className="sm ink-2" style={{ marginTop: 8 }}>{note}</div> : null}
      {!superseded && (sent || answer) ? (
        <div className="sm" style={{ marginTop: 8, display: "grid", gap: 3 }}>
          {sent ? <span><Icon name="check" /> {sent}</span> : null}
          {answer?.kind === "answered" ? <span><Icon name="check" /> {answer.text}</span> : null}
          {answer?.kind === "awaiting" ? <Timer state={answer.state ?? "close"} label="Awaiting the guest's reply" time={answer.timer} /> : null}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
        {onPreview ? <Button kind={superseded ? "quiet" : "secondary"} compact icon="eye" onClick={onPreview}>Preview</Button> : null}
        {!superseded && onPdf ? <Button kind="quiet" compact icon="file" onClick={onPdf}>PDF</Button> : null}
        {!superseded && onPrint ? <Button kind="quiet" compact icon="print" onClick={onPrint}>Print</Button> : null}
        {!superseded && onSend ? <Button kind="quiet" compact icon="send" onClick={onSend}>{sent ? "Send again" : "Send"}</Button> : null}
        {!superseded && onVerbal ? <Button kind="secondary" compact onClick={onVerbal}>Record a verbal answer</Button> : null}
      </div>
    </Card>
  );
}

/* ---------- handoff card ---------- */
export function HandoffCard({ icon = "broom", title, timer, timerState = "close", meta, lines, onOpen, onReassign }: {
  icon?: IconName; title: React.ReactNode; timer?: React.ReactNode; timerState?: TimerState; meta?: React.ReactNode; lines: { done?: boolean; text: React.ReactNode }[]; onOpen?: () => void; onReassign?: () => void;
}) {
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <h4><Icon name={icon} /> {title}</h4>
        {timer ? <Timer state={timerState} label="" time={timer} /> : null}
      </div>
      {meta ? <div className="meta">{meta}</div> : null}
      <div className="sm" style={{ marginTop: 8, display: "grid", gap: 3 }}>
        {lines.map((l, i) => <span key={i} className={l.done ? "ink-2" : undefined}><Icon name={l.done ? "check" : "circle"} /> {l.text}</span>)}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        {onOpen ? <Button kind="secondary" compact onClick={onOpen}>Open checklist</Button> : null}
        {onReassign ? <Button kind="quiet" compact onClick={onReassign}>Reassign</Button> : null}
      </div>
    </Card>
  );
}

/* ---------- console setting: current value, who, when, history, consequence ---------- */
export function ConsoleSetting({ name, value, changedBy, changedAt, was, changes, consequence, onPropose, onHistory }: {
  name: React.ReactNode; value: React.ReactNode; changedBy: React.ReactNode; changedAt: React.ReactNode; was?: React.ReactNode; changes?: number; consequence: React.ReactNode; onPropose?: () => void; onHistory?: () => void;
}) {
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <h4>{name}</h4>
        {typeof changes === "number" ? <Chip tone="quiet" icon="history">{changes} changes</Chip> : null}
      </div>
      <div className="figure" style={{ marginTop: 4 }}>{value}</div>
      <div className="meta">Set by {changedBy} · {changedAt}{was ? <> · was {was}</> : null}</div>
      <div className="sm ink-2" style={{ marginTop: 8 }}>{consequence}</div>
      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        {onPropose ? <Button kind="secondary" compact onClick={onPropose}>Propose a change</Button> : null}
        {onHistory ? <Button kind="quiet" compact onClick={onHistory}>History</Button> : null}
      </div>
    </Card>
  );
}

/* ---------- readiness: "can the hotel run?" — each failing item links to the page that fixes it ---------- */
export function ReadinessList({ title = "Can the hotel run?", items }: { title?: React.ReactNode; items: GateItem[] }) {
  return (
    <Card>
      <h4>{title}</h4>
      <GateChecklist items={items} className="mt-8" />
    </Card>
  );
}

/* ---------- AI draft: visible provenance; nothing leaves without a person ---------- */
export function AiDraftCard({ title, confidence, message, basis, draft, withheld, onApprove, onEdit, onReject, onWrite }: {
  title: React.ReactNode; confidence?: number; message: React.ReactNode; basis: React.ReactNode; draft?: React.ReactNode; withheld?: boolean;
  onApprove?: () => void; onEdit?: () => void; onReject?: () => void; onWrite?: () => void;
}) {
  return (
    <div className={`card ai-card${withheld ? " withheld" : ""}`}>
      <div className="ai-head">
        <div>
          <h4>{title}</h4>
          <span className="ai-mark"><Icon name="ai" />{withheld ? "AI output withheld" : "AI-produced · awaiting human approval"}</span>
        </div>
        {withheld ? <Chip tone="quiet">Below confidence floor</Chip> : typeof confidence === "number" ? <Chip>Confidence {confidence}%</Chip> : null}
      </div>
      <div className="ai-context">
        <div><b>Guest message</b></div>
        <div>{message}</div>
        <div className="meta"><b>{withheld ? "Basis checked:" : "Basis:"}</b> {basis}</div>
      </div>
      <div className="ai-draft">
        {withheld ? <><b>Write the reply.</b> No AI draft is shown. The operator remains responsible for answering the guest, with the same booking and rule context visible.</> : draft}
      </div>
      <div className="ai-actions">
        {withheld ? <Button compact onClick={onWrite}>Write reply</Button> : (
          <>
            <Button compact onClick={onApprove}>Approve</Button>
            <Button kind="secondary" compact onClick={onEdit}>Edit and approve</Button>
            <Button kind="quiet" compact onClick={onReject}>Reject</Button>
            <span className="control-note" style={{ margin: 0 }}>Reject records a reason. Any edit keeps the AI version in history.</span>
          </>
        )}
      </div>
    </div>
  );
}

/** A System-fulfilled line in the side panel: what the system did, when, under what authority. */
export function SystemActivity({ what, when, authority }: { what: React.ReactNode; when: React.ReactNode; authority?: React.ReactNode }) {
  return (
    <div className="row">
      <SourceMark kind="system">{what}</SourceMark>
      <span className="meta">by the system · {when}{authority ? <> · {authority}</> : null}</span>
    </div>
  );
}
