"use client";

/**
 * The pieces every step canvas is built from (Surface Spec 03 and the 13–14 Sep storyboards):
 * a card with its title line, facts as label → value, the "on record" row a signature is made
 * of, a choice among a few words, a paper as a card, the guest's answer to a paper, "Other ways
 * this booking can go", "Requests", "Papers", and one dialog shape.
 *
 * Markup follows the prototype's own helpers (`card`, `docCard`, `V16.fact`, `V16.seeRow`), so
 * the generated components.css and frame.css style it without anything added per screen.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Dialog, Icon, type ButtonProps, type DialogRegister, type IconName } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { acknowledgeCommunication, listEntryCommunications, type EntryCommunication, type EntryCommunicationType } from "@/lib/api/entries";
import {
  getFolioDocuments,
  openCancellationConfirmationPdf,
  openConfirmationVoucherPdf,
  openFolioDocumentPdf,
  openInvoicePdf,
  openQuotationPdf,
  type FolioDocumentKind,
} from "@/lib/api/documents";
import {
  CancellationVoucherPreview,
  FolioDocumentPreview,
  IssuedInvoicePreview,
  ProformaPreview,
  QuotationPreview,
  VoucherPreview,
} from "@/components/desk/workspace/quotation-preview";
import { readRefusal } from "@/lib/ds/translate";
import { fmtDateTime, fmtStamp } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";

/* ------------------------------------------------------------------ the step's mode */

/** Whether the canvas shows the step being worked, or one already passed (read-only). */
export const StepModeContext = createContext<{ past: boolean }>({ past: false });
export const useStepMode = () => useContext(StepModeContext);

/** The canvas frame: the cards stacked, muted when the step is behind the booking. */
export function StepCanvas({ past, children }: { past: boolean; children: ReactNode }) {
  return (
    <StepModeContext.Provider value={{ past }}>
      <div className={`steps-canvas${past ? " past" : ""}`}>{children}</div>
    </StepModeContext.Provider>
  );
}

/** A working control that disappears on a passed step (what was decided still shows). */
export function Live({ children }: { children: ReactNode }) {
  const { past } = useStepMode();
  return past ? null : <>{children}</>;
}

/* ------------------------------------------------------------------ cards */

/**
 * The step as a sequence of things to do (2026-09-25, operator report: "everything is shown at
 * once as soon as the page loads, so the user doesn't know where to start").
 *
 * One list serves both ends: the side panel prints it as the numbered to-do, and each card
 * carries its own number from it. A card whose turn has not come renders as its heading and the
 * one thing it waits for — the rest is out of the way until it can actually be done, which is
 * also why the committed hold no longer sits at the top of Set up asking to be placed before the
 * terms are even disclosed. Nothing becomes unreachable: "Show it anyway" opens a waiting card.
 */
export type FlowItem = { n: number; label: string; met: boolean; card?: string };

const FlowCtx = createContext<{ items: FlowItem[]; on: boolean }>({ items: [], on: false });

/** The card-bearing items of a step's checklist, numbered in the order they are worked. */
export function numberFlow(items: ReadonlyArray<{ label: string; met: boolean; card?: string }>): FlowItem[] {
  let n = 0;
  return items.filter((p) => !!p.card).map((p) => ({ n: ++n, label: p.label, met: p.met, card: p.card }));
}

export function StepFlow({ items, on, children }: { items: FlowItem[]; on: boolean; children: ReactNode }) {
  // The list is rebuilt on every render of the workspace; hold one identity per unchanged list so
  // a card only re-renders when its own number or standing moves.
  const key = `${on}|${items.map((i) => `${i.n}${i.met ? "1" : "0"}${i.card}`).join("~")}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => ({ items, on }), [key]);
  return <FlowCtx.Provider value={value}>{children}</FlowCtx.Provider>;
}

/**
 * Where this card sits in the step: its number, whether it is done, and what it still waits for.
 *
 * `flow` only NUMBERS a card — it takes the number the side panel's to-do gives the same key, and
 * a tick once that item is done. Waiting is declared separately with `after`, naming the card
 * this one depends on, because the dependency is a matter of fact and differs step by step: at
 * Set up the rooms cannot be held until the terms and the bill are done, while in-house the desk
 * posts charges, hands over keys and runs the audit in whatever order the day takes. A card waits
 * until everything up to and including the named card's last item is done.
 */
export function useFlowCard(card?: string, after?: string): { n?: number; met?: boolean; waitsFor?: FlowItem } {
  const { items, on } = useContext(FlowCtx);
  if (!on) return {};
  const i = card ? items.findIndex((x) => x.card === card) : -1;
  const mine = i >= 0 ? items[i] : null;
  let waitsFor: FlowItem | undefined;
  if (after) {
    let last = -1;
    items.forEach((x, k) => {
      if (x.card === after) last = k;
    });
    if (last >= 0) waitsFor = items.slice(0, last + 1).find((x) => !x.met);
  }
  return { n: mine?.n, met: mine?.met, waitsFor };
}

export function anchorFor(card: string) {
  return `card-${card}`;
}

export function StepCard({
  title,
  icon,
  right,
  acts,
  sealed,
  quiet,
  meta,
  children,
  id,
  style,
  flow,
  flowAfter,
}: {
  title?: ReactNode;
  icon?: IconName;
  right?: ReactNode;
  acts?: ReactNode;
  sealed?: boolean;
  quiet?: boolean;
  /** One grey line under the title. */
  meta?: ReactNode;
  children?: ReactNode;
  id?: string;
  style?: React.CSSProperties;
  /** This card's place in the step's flow — the same key the to-do list carries. */
  flow?: string;
  /** This card opens once the named card's items are done — the step's real dependencies. */
  flowAfter?: string;
}) {
  const { n, met, waitsFor } = useFlowCard(flow, flowAfter);
  const [anyway, setAnyway] = useState(false);
  const waiting = !!waitsFor && !anyway;
  return (
    <div
      className={["card", sealed ? "sealed" : "", quiet ? "quiet" : "", n ? "flowed" : "", met ? "flow-done" : "", waiting ? "flow-waiting" : ""]
        .filter(Boolean)
        .join(" ")}
      id={flow ? anchorFor(flow) : id}
      style={style}
    >
      {title ? (
        <div className="card-top">
          <h4>
            {n ? <span className={`cardno${met ? " done" : ""}`}>{met ? <Icon name="check" /> : n}</span> : null}
            {icon ? <Icon name={icon} /> : null}
            {title}
          </h4>
          {waiting ? null : right ? <div className="row-acts">{right}</div> : null}
        </div>
      ) : null}
      {waiting ? (
        <div className="flow-wait">
          <span className="meta">
            after <b>{waitsFor!.n}</b> · {waitsFor!.label}
          </span>
          <Button kind="quiet" compact onClick={() => setAnyway(true)}>
            Show it anyway
          </Button>
        </div>
      ) : (
        <>
          {meta ? <div className="meta" style={{ marginBottom: 8 }}>{meta}</div> : null}
          {children}
          {acts ? (
            <div className="row-acts" style={{ marginTop: 12 }}>
              {acts}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Label → value pairs, the prototype's `dl.pv`. */
export function Facts({ children, wide, style }: { children: ReactNode; wide?: boolean; style?: React.CSSProperties }) {
  return (
    <dl className={`pv${wide ? " wide" : ""}`} style={wide ? { gridTemplateColumns: "150px 1fr", ...style } : style}>
      {children}
    </dl>
  );
}

export function Fact({ k, children, meta }: { k: ReactNode; children?: ReactNode; meta?: ReactNode }) {
  const empty = children === null || children === undefined || children === "" || children === false;
  return (
    <>
      <dt>{k}</dt>
      <dd>
        {empty ? <span className="dash">—</span> : children}
        {meta ? <span className="meta"> · {meta}</span> : null}
      </dd>
    </>
  );
}

/** A single value with its note underneath — the prototype's `V16.fact` (party boxes). */
export function FactBox({ k, v, meta }: { k: ReactNode; v: ReactNode; meta?: ReactNode }) {
  return (
    <div className="fact">
      <span className="k">{k}</span>
      <span className="v">
        {v}
        {meta ? (
          <span className="meta" style={{ display: "block", marginLeft: 0 }}>
            {meta}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** The chip a fact carries once it is on record. */
export function OnRecord({ word = "on record" }: { word?: string }) {
  return (
    <Chip tone="success" icon="check">
      {word}
    </Chip>
  );
}

export type FactState = "on" | "missing" | "word" | "waiting" | "system";

/**
 * One line of a signature (Reserve, Check-in): what the fact is, its value with who recorded it,
 * and either "on record" or the one control that puts it on record (R1, C2).
 */
export function FactLine({
  label,
  value,
  who,
  state,
  action,
}: {
  label: ReactNode;
  value: ReactNode;
  who?: ReactNode;
  state: FactState;
  action?: ReactNode;
}) {
  return (
    <div className={`fact line ${state}`}>
      <span className="k">{label}</span>
      <span className="v">
        {value}
        {who ? <span className="who">{who}</span> : null}
      </span>
      <span className="r">
        {action ??
          (state === "on" || state === "system" ? (
            <OnRecord />
          ) : state === "word" ? (
            <Chip tone="warning">your word</Chip>
          ) : state === "waiting" ? (
            <Chip tone="quiet" icon="clock">
              waiting
            </Chip>
          ) : (
            <Chip tone="warning">not yet</Chip>
          ))}
      </span>
    </div>
  );
}

/** A choice among a few words — the prototype's `.filters` row of compact buttons. */
export function Choice<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: ReadonlyArray<readonly [T, string]>;
  value: T | null | undefined;
  onChange?: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="filters choice">
      {options.map(([v, label]) => (
        <Button
          key={v}
          kind={v === value ? "secondary" : "quiet"}
          compact
          aria-pressed={v === value}
          state={disabled && v !== value ? "inert" : "default"}
          onClick={onChange && !disabled ? () => onChange(v) : undefined}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

/** An action and what it sets off, on one line: "Park… → a reason and a follow-up date". */
export function SeeRow({
  label,
  note,
  onClick,
  state,
  reason,
  kind = "quiet",
}: {
  label: string;
  note: ReactNode;
  onClick?: () => void;
  state?: ButtonProps["state"];
  reason?: string;
  kind?: ButtonProps["kind"];
}) {
  return (
    <div className="seerow">
      <Button kind={kind} compact state={state ?? (onClick ? "default" : "inert")} onClick={onClick} title={reason}>
        {label}
      </Button>
      <span className="meta">→ {note}</span>
      {reason && (state === "inert" || !onClick) ? <span className="meta warn-ink">· {reason}</span> : null}
    </div>
  );
}

/**
 * Where the step's OTHER ways go (2026-09-25, operator: "the things that don't have to be done
 * shouldn't sit in This step — give them a tab of their own").
 *
 * The workspace hands this a place to render into, so cancelling, parking and re-entering live
 * behind their own tab while the step itself only shows what has to be done. The actions stay
 * where they were written — each canvas keeps its own dialogs and state; only where they appear
 * moves. With no slot (a past step, or a canvas rendered on its own) the card renders in place,
 * exactly as before.
 */
const OtherWaysSlotCtx = createContext<HTMLElement | null>(null);

/** Render a card into the step's "other ways" pane when there is one, else in place. */
function beside(card: ReactNode, slot: HTMLElement | null) {
  return slot ? createPortal(card, slot) : card;
}

export function OtherWaysSlot({ node, children }: { node: HTMLElement | null; children: ReactNode }) {
  return <OtherWaysSlotCtx.Provider value={node}>{children}</OtherWaysSlotCtx.Provider>;
}

export function OtherWays({ children }: { children: ReactNode }) {
  const { past } = useStepMode();
  const slot = useContext(OtherWaysSlotCtx);
  const kids = (Array.isArray(children) ? children : [children]).filter(Boolean);
  if (past || kids.length === 0) return null;
  return beside(
    <StepCard title="Other ways this booking can go" quiet>
      <div className="stack sm" style={{ display: "grid", gap: 4 }}>
        {kids}
      </div>
    </StepCard>,
    slot,
  );
}

/** Requests at any step (R2) — the list and its kinds are backend item BE-64. */
export function RequestsCard() {
  const slot = useContext(OtherWaysSlotCtx);
  return beside(
    <StepCard title="Requests">
      <p className="meta">Nothing asked yet — a request can be added at any step, and the form asks the questions that kind needs.</p>
      <Live>
        <div style={{ marginTop: 10, maxWidth: 420 }}>
          <Button
            kind="secondary"
            state="inert"
            reason="Requests by kind — asked, arranged, done — are not in the backend yet (BE-64). A preference goes in the line above the steps."
            style={{ width: "100%" }}
          >
            Add a request…
          </Button>
        </div>
      </Live>
    </StepCard>,
    slot,
  );
}

/** A paper as a card: its name and version, when it was generated, what it says, and its acts. */
export function DocCard({
  name,
  meta,
  lines,
  right,
  acts,
  sealed,
  children,
}: {
  name: ReactNode;
  meta?: ReactNode;
  lines?: ReactNode[];
  right?: ReactNode;
  acts?: ReactNode;
  sealed?: boolean;
  children?: ReactNode;
}) {
  return (
    <StepCard title={name} icon="file" right={right} sealed={sealed} acts={acts}>
      {meta ? <div className="meta">{meta}</div> : null}
      {lines?.length ? (
        <div className="sm" style={{ marginTop: 8, display: "grid", gap: 3 }}>
          {lines.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      ) : null}
      {children}
    </StepCard>
  );
}

/** An old working tool placed inside a native card — re-dressed by legacy-bridge.css. */
export function Tool({ children, inert }: { children: ReactNode; inert?: boolean }) {
  const { past } = useStepMode();
  const off = inert ?? past;
  return <div className="desk-root tool">{off ? <div inert>{children}</div> : children}</div>;
}

/** A plain notice in the prototype's inert box. */
export function Notice({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="notice inert">
      <span className="sm">{children}</span>
      {note ? <span className="control-note" style={{ display: "block" }}>{note}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ dialogs */

export function DsDialog({
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
  width?: number;
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
  return (
    <div className="scrim open" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div style={width ? { width, maxWidth: "100%" } : undefined} className="dialog-holder">
        <Dialog register={register} title={title} caseLines={caseLines} footer={footer}>
          {children}
        </Dialog>
      </div>
    </div>
  );
}

/** A reason is asked for, and the act waits until one is written. */
export function ReasonDialog({
  open,
  onClose,
  title,
  caseLines,
  lead,
  confirmLabel,
  onConfirm,
  busy,
  danger,
  placeholder,
  children,
  extraValid = true,
  extraReason,
  reasonLabel = "Reason",
  minLength = 1,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  caseLines?: ReactNode[];
  lead?: ReactNode;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  busy?: boolean;
  danger?: boolean;
  placeholder?: string;
  children?: ReactNode;
  extraValid?: boolean;
  /** What is missing when `extraValid` is false — said on the locked button instead of the reason. */
  extraReason?: string;
  reasonLabel?: string;
  minLength?: number;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const ok = reason.trim().length >= minLength && extraValid;
  return (
    <DsDialog
      open={open}
      onClose={onClose}
      register={danger ? "danger" : "commit"}
      title={title}
      caseLines={caseLines}
      busy={busy}
      footer={
        <>
          <Button kind="quiet" state={busy ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            kind={danger ? "danger" : "primary"}
            solid={danger}
            state={busy ? "working" : ok ? "default" : "inert"}
            workingLabel="Working…"
            title={ok ? undefined : reason.trim().length < minLength ? "write the reason first" : extraReason ?? "fill in the rest first"}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {lead ? <p className="sm">{lead}</p> : null}
      {children}
      <div className="field">
        <label>{reasonLabel}</label>
        <textarea className="input" rows={2} value={reason} maxLength={500} placeholder={placeholder} onChange={(e) => setReason(e.target.value)} autoFocus />
      </div>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ papers */

export type PaperRef =
  | { kind: "quotation"; id: string; frozen?: boolean; label: string }
  | { kind: "invoice"; id: string; frozen?: boolean; label: string; notice?: string; issued?: boolean }
  | { kind: "voucher"; reservationId: string; label: string }
  | { kind: "cancellation"; entryId: string; label: string }
  | { kind: "folio"; entryId: string; doc: FolioDocumentKind; label: string; refreshKey: string };

/** The paper opens in a side drawer — the document shell the backend rendered. */
export function PaperDrawer({ paper, onClose }: { paper: PaperRef | null; onClose: () => void }) {
  const { session } = useSession();
  useEffect(() => {
    if (!paper) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [paper, onClose]);
  if (!paper || !session) return null;
  const pdf = () => {
    const run =
      paper.kind === "quotation"
        ? openQuotationPdf(session, paper.id)
        : paper.kind === "invoice"
          ? openInvoicePdf(session, paper.id)
          : paper.kind === "voucher"
            ? openConfirmationVoucherPdf(session, paper.reservationId)
            : paper.kind === "cancellation"
              ? openCancellationConfirmationPdf(session, paper.entryId)
              : openFolioDocumentPdf(session, paper.entryId, paper.doc);
    run.catch((e) => toastRefusal(e, "The PDF could not be opened"));
  };
  return (
    <div className="scrim open" style={{ alignItems: "stretch", justifyContent: "flex-end", padding: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-label={paper.label}
        style={{ width: "min(560px, 96vw)", background: "var(--surface)", borderLeft: "1px solid var(--line-2)", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-dialog)" }}
      >
        <div className="card-top" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
          <h4 style={{ margin: 0 }}>
            <Icon name="file" />
            {paper.label}
          </h4>
          <div className="row-acts">
            <Button kind="quiet" compact icon="file" onClick={pdf}>
              PDF
            </Button>
            <Button kind="quiet" compact icon="print" onClick={pdf}>
              Print
            </Button>
            <Button kind="secondary" compact icon="x" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        <div className="desk-root" style={{ overflow: "auto", flex: 1, padding: "8px 12px" }}>
          {paper.kind === "quotation" ? (
            <QuotationPreview quotationId={paper.id} frozenPdf={paper.frozen} />
          ) : paper.kind === "invoice" ? (
            paper.issued ? (
              <IssuedInvoicePreview invoiceId={paper.id} />
            ) : (
              <ProformaPreview invoiceId={paper.id} frozenPdf={paper.frozen} notice={paper.notice} title={paper.label} />
            )
          ) : paper.kind === "voucher" ? (
            <VoucherPreview reservationId={paper.reservationId} />
          ) : paper.kind === "cancellation" ? (
            <CancellationVoucherPreview entryId={paper.entryId} />
          ) : (
            <FolioDocumentPreview entryId={paper.entryId} kind={paper.doc} title={paper.label} refreshKey={paper.refreshKey} />
          )}
        </div>
      </div>
    </div>
  );
}

const INVOICE_WORD: Record<string, string> = {
  PROFORMA: "Proforma",
  FINAL: "Tax invoice",
  INTERIM: "Interim bill",
  ADVANCE: "Advance invoice",
};

/** Every paper this booking has, as buttons that open it (P1 — a draft is never sent). */
export function PapersCard({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const slot = useContext(OtherWaysSlotCtx);
  const [open, setOpen] = useState<PaperRef | null>(null);
  const folioLive = !!entry.folio && ["LIVE", "OUTSTANDING", "SETTLED", "CLOSED"].includes(entry.folio.state);
  const folioDocs = useQuery({
    queryKey: ["folio-documents", entry.id, entry.currentStage, entry.folio?.state ?? null],
    queryFn: () => getFolioDocuments(session!, entry.id),
    enabled: !!session && folioLive,
  });
  const papers = useMemo<PaperRef[]>(() => {
    const out: PaperRef[] = [];
    const quotes = [...(entry.quotations ?? [])].filter((q) => q.state !== "SUPERSEDED").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const q = quotes[0];
    if (q) out.push({ kind: "quotation", id: q.id, label: `Quotation ${q.referenceNumber}`, frozen: q.state !== "DRAFT" && q.state !== "SENT" && q.state !== "ACCEPTED" && !!q.pdfStorageKey });
    for (const inv of entry.folio?.invoices ?? []) {
      if (inv.state === "SUPERSEDED") continue;
      const word = INVOICE_WORD[inv.invoiceType] ?? "Invoice";
      if (inv.invoiceType === "FINAL") out.push({ kind: "invoice", id: inv.id, issued: true, label: `${word} ${inv.invoiceNumber ?? inv.id}` });
      else out.push({ kind: "invoice", id: inv.id, label: `${word} ${inv.invoiceNumber ?? inv.id}` });
    }
    if (entry.reservation?.id) out.push({ kind: "voucher", reservationId: entry.reservation.id, label: "Confirmation voucher" });
    for (const d of folioDocs.data?.documents ?? []) {
      if (!d.available || d.kind === "tax-invoice") continue;
      out.push({ kind: "folio", entryId: entry.id, doc: d.kind, label: d.title, refreshKey: `${entry.updatedAt}` });
    }
    if (entry.status === "CANCELLED") out.push({ kind: "cancellation", entryId: entry.id, label: "Cancellation confirmation" });
    return out;
  }, [entry, folioDocs.data]);
  if (papers.length === 0) return null;
  return beside(
    <StepCard title="Papers">
      <div className="row-acts">
        {papers.map((p) => (
          <Button key={`${p.kind}:${p.label}`} kind="quiet" compact icon="file" onClick={() => setOpen(p)}>
            {p.label}
          </Button>
        ))}
      </div>
      <div className="meta" style={{ marginTop: 6 }}>
        Preview opens the paper as the backend composes it · a draft is never sent
      </div>
      <PaperDrawer paper={open} onClose={() => setOpen(null)} />
    </StepCard>,
    slot,
  );
}

/* ------------------------------------------------------------------ the guest's answer */

export function useCommunications(entryId: string) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["entry-communications", entryId],
    queryFn: () => listEntryCommunications(session!, entryId),
    enabled: !!session,
  });
}

/** The newest dispatched paper of one kind within the current pass. */
export function latestDispatched(items: EntryCommunication[] | undefined, type: EntryCommunicationType, sinceIso?: string | null) {
  return (items ?? [])
    .filter((c) => c.commType === type && c.sendStatus === "DISPATCHED" && (!sinceIso || c.createdAt >= sinceIso))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

const ANSWER_WORD: Record<string, string> = { WRITTEN: "they wrote to us", VERBAL: "they told us" };

/**
 * What the guest said about a paper that went out. Evidence, captured once: "They wrote to us"
 * or "They told us" with the words they used. Nothing to answer until the paper was sent.
 */
export function AnswerLine({
  entryId,
  type,
  sinceIso,
  what,
  tz,
  lockedHint,
}: {
  entryId: string;
  type: EntryCommunicationType;
  sinceIso?: string | null;
  /** "the proforma", "the voucher" */
  what: string;
  tz?: string;
  lockedHint?: string | null;
}) {
  const { session } = useSession();
  const { past } = useStepMode();
  const refresh = useRefreshEntry(entryId);
  const comms = useCommunications(entryId);
  const c = latestDispatched(comms.data?.items, type, sinceIso);
  const [open, setOpen] = useState(false);
  // No default (N8): the operator says which way the answer came.
  const [method, setMethod] = useState<"WRITTEN" | "VERBAL" | null>(null);
  const [words, setWords] = useState("");
  const save = useMutation({
    mutationFn: () => acknowledgeCommunication(session!, c!.id, { method: method!, verbatimNote: words.trim() || undefined }),
    onSuccess: () => {
      toast.success(`Their answer to ${what} is on record`);
      setOpen(false);
      setWords("");
      setMethod(null);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The answer could not be recorded"),
  });
  if (!c) return <span className="meta">{what.charAt(0).toUpperCase() + what.slice(1)} has not gone out yet — nothing to answer.</span>;
  const payload = (c.payload ?? {}) as { acknowledgementMethod?: string; verbatimNote?: string };
  if (c.acknowledgementStatus === "RECEIVED") {
    return (
      <span className="sm">
        <Icon name="check" /> Answered · {ANSWER_WORD[payload.acknowledgementMethod ?? ""] ?? "on record"}
        {c.acknowledgementReceivedAt ? ` · ${fmtStamp(c.acknowledgementReceivedAt, tz)}` : ""}
        {payload.verbatimNote ? <span className="meta"> · “{payload.verbatimNote}”</span> : null}
      </span>
    );
  }
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span className="sm">
        <Icon name="clock" /> Sent {fmtStamp(c.createdAt, tz)} · {c.isOverdue ? <b className="warn-ink">the reply window has passed</b> : c.acknowledgementTimeoutAt ? <>awaiting their reply until {fmtDateTime(c.acknowledgementTimeoutAt, tz)}</> : "awaiting their reply"}
      </span>
      {past ? null : lockedHint ? (
        <span className="meta">{lockedHint}</span>
      ) : !open ? (
        <div className="row-acts">
          <Button kind="secondary" compact state={c.canAcknowledge ? "default" : "inert"} onClick={() => setOpen(true)}>
            Record their answer
          </Button>
        </div>
      ) : (
        <div className="bind provisional" style={{ display: "grid", gap: 8 }}>
          <Choice
            options={[
              ["WRITTEN", "They wrote to us"],
              ["VERBAL", "They told us"],
            ]}
            value={method}
            onChange={setMethod}
          />
          <div className="field">
            <label>{method === "VERBAL" ? "What they said · the words are the record" : method === "WRITTEN" ? "What they wrote · optional" : "Their words"}</label>
            <textarea className="input" rows={2} value={words} onChange={(e) => setWords(e.target.value)} placeholder="'noted, thank you — we will pay on Friday'" />
          </div>
          <div className="row-acts">
            <Button
              compact
              state={save.isPending ? "working" : !method || (method === "VERBAL" && !words.trim()) ? "inert" : "default"}
              title={!method ? "say how the answer came" : method === "VERBAL" && !words.trim() ? "write what they said first" : undefined}
              onClick={() => save.mutate()}
            >
              Record
            </Button>
            <Button kind="quiet" compact onClick={() => setOpen(false)}>
              Not now
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ plumbing */

/** Every step mutation refreshes the same reads. */
export function useRefreshEntry(entryId: string) {
  const qc = useQueryClient();
  return (extra: ReadonlyArray<ReadonlyArray<unknown>> = []) => {
    const keys: ReadonlyArray<ReadonlyArray<unknown>> = [
      ["entry", entryId],
      ["entries"],
      ["desk-bookings"],
      ["entry-timers", entryId],
      ["entry-trace", entryId],
      ["entry-communications", entryId],
      ["billing-summary", entryId],
      ["payment-status", entryId],
      ["folio-documents", entryId],
      ["journey-summary", entryId],
      ["closure-readiness", entryId],
      ...extra,
    ];
    for (const k of keys) void qc.invalidateQueries({ queryKey: k as unknown[] });
  };
}

/** A refusal read in the desk's words, as a toast. */
export function toastRefusal(e: unknown, fallback: string) {
  const r = readRefusal(e, fallback);
  toast.error(r.message, r.failures.length ? { description: r.failures.join(" · "), duration: 9000 } : undefined);
}

export function errMessage(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

export const LEVEL_RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
export function atLeast(level: string | undefined | null, min: "L1" | "L2" | "L3" | "L4") {
  return (LEVEL_RANK[level ?? "L1"] ?? 1) >= LEVEL_RANK[min];
}

/** The current pass's opening instant — papers and answers are read within it. */
export function currentPassStart(entry: EntryDetail): string | null {
  const segs = [...(entry.segments ?? [])].sort((a, b) => (b.segmentNumber ?? 0) - (a.segmentNumber ?? 0));
  return (segs[0] as { startedAt?: string } | undefined)?.startedAt ?? null;
}

/** "BHUTAN INC" → "Bhutan Inc"; "TRAVEL_AGENT" → "Travel agent". */
export function words(code?: string | null): string {
  if (!code) return "";
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
