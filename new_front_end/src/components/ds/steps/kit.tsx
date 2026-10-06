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
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useInvoiceRecipient } from "@/hooks/use-invoice-recipient";
import { sendQuotation } from "@/lib/api/quotations";
import { dispatchInvoice } from "@/lib/api/reservation-setup";
import type { EntryDetail, InvoiceSummary, QuotationSummary } from "@/types/api";
import { getEntryBedPlan, setEntryBedPlan } from "@/lib/api/rooms";
import type { BedPlanCell } from "@/components/desk/workspace/room-compositions-table";

/** How a paper leaves the desk. WhatsApp is a RECORD of a hand-over, not a send. */
const CHANNELS = [
  ["EMAIL", "Email · in the booking's thread"],
  ["WHATSAPP", "WhatsApp"],
] as const;
type Channel = (typeof CHANNELS)[number][0];

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

/**
 * A pane of a step — its own tab beside "This step" (2026-09-25, operator, for Stay: "this step
 * can have folio and handoffs; night audit, room change, interim payment, extend the stay, bills
 * and statements, early departure can each be different"). `cards` names the flow cards that
 * live in it, so the to-do can open the pane before scrolling to one.
 */
export type StepPane = { key: string; label: string; cards: string[] };

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
  // A card may hold several items (Check-in's room card: assigned & ready, then the key). It
  // carries the number of the first still open, and ticks only once every one of them is done —
  // ticking on the first alone read as finished with the key still in the drawer.
  const own = card ? items.filter((x) => x.card === card) : [];
  const mine = own.length ? (own.find((x) => !x.met) ?? own[0]) : null;
  const allMet = own.length > 0 && own.every((x) => x.met);
  let waitsFor: FlowItem | undefined;
  if (after) {
    let last = -1;
    items.forEach((x, k) => {
      if (x.card === after) last = k;
    });
    if (last >= 0) waitsFor = items.slice(0, last + 1).find((x) => !x.met);
  }
  return { n: mine?.n, met: mine ? allMet : undefined, waitsFor };
}

export function anchorFor(card: string) {
  return `card-${card}`;
}

/**
 * Take the operator to a card: scroll it into view and light it for a moment, so the section
 * says it is the one they asked for (2026-09-25 — scrolling alone left them hunting for which
 * box had moved).
 */
export function revealCard(el: HTMLElement) {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), 1900);
}

/**
 * The side panel's "To do here": the numbered items, each a way to its card, and beneath them
 * the items that have no card on this screen — listed apart, never numbered. One component for
 * the workspace and the intake screen, so the two lists cannot read differently.
 */
export function FlowTodo({
  items,
  also,
  onGo,
}: {
  items: FlowItem[];
  also: ReadonlyArray<{ label: string; met: boolean }>;
  onGo: (card?: string) => void;
}) {
  if (!items.length && !also.length) return null;
  return (
    <div>
      <h4>To do here</h4>
      <div className="todo">
        {items.map((i) => (
          <button key={`${i.n}-${i.card}`} type="button" className={`row-todo${i.met ? " done" : ""}`} onClick={() => onGo(i.card)} title={`Go to ${i.label}`}>
            <span className="n">{i.met ? <Icon name="check" /> : i.n}</span>
            <span className="t">{i.label}</span>
          </button>
        ))}
        {also.length ? (
          <div className="also">
            {also.map((p) => (
              <div key={p.label} className={`row-todo${p.met ? " done" : ""}`} style={{ cursor: "default" }}>
                <span className="n">{p.met ? <Icon name="check" /> : "!"}</span>
                <span className="t">{p.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
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
  heldFor,
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
  /**
   * This card waits for something that is not on this screen — the intake's house card waits for
   * the inquiry to be started, which is the gate bar's button. It is drawn as a waiting card that
   * says so, with no "Show it anyway": what it waits for cannot be done from inside it.
   */
  heldFor?: ReactNode;
}) {
  const { n, met, waitsFor } = useFlowCard(flow, flowAfter);
  const [anyway, setAnyway] = useState(false);
  const held = !!heldFor;
  const waiting = held || (!!waitsFor && !anyway);
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
          {held ? (
            <span className="meta">after · {heldFor}</span>
          ) : (
            <>
              <span className="meta">
                after <b>{waitsFor!.n}</b> · {waitsFor!.label}
              </span>
              <Button kind="quiet" compact onClick={() => setAnyway(true)}>
                Show it anyway
              </Button>
            </>
          )}
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
/**
 * Scroll to another card of the SAME step and flash it (2026-10-06).
 *
 * The workspace's own `goToCard` can also open a pane, which only it knows about; this is the
 * narrow form a canvas needs to point at a sibling card ("send the proforma first" → the
 * proforma). Returns false when the card is not on screen, so the caller can stay quiet rather
 * than offering a button that would do nothing.
 */
export function goToStepCard(card: string): boolean {
  const el = typeof document === "undefined" ? null : document.getElementById(anchorFor(card));
  if (!el) return false;
  revealCard(el);
  return true;
}

/**
 * One act, with its explanation underneath (2026-10-06, operator: "can these be made into proper
 * buttons ... it looks like the words in the button are not fully shown").
 *
 * `SeeRow` puts the caption beside the control, which reads as a sentence with a box at the start
 * and ran off the card when the note was long. Here the button is the row's subject and the
 * caption sits under it, free to wrap.
 *
 * **A held act says what would release it, and offers to take you there.** `heldBy` is the reason
 * in the operator's words; `goTo` names the card that fixes it, so the person presses a button
 * instead of reading an instruction and hunting for the place to carry it out.
 */
export function ActionRow({
  label,
  caption,
  onClick,
  state,
  kind = "quiet",
  heldBy,
  goTo,
  goToLabel,
}: {
  label: string;
  caption: ReactNode;
  onClick?: () => void;
  state?: ButtonProps["state"];
  kind?: ButtonProps["kind"];
  /** Why the act cannot be done yet — shown under the button, in words. */
  heldBy?: string | null;
  /** The card on this step that would release it. */
  goTo?: string;
  goToLabel?: string;
}) {
  const held = !!heldBy;
  return (
    <div className="actrow">
      <Button kind={kind} state={state ?? (onClick ? "default" : "inert")} onClick={onClick} title={heldBy ?? undefined}>
        {label}
      </Button>
      <span className="cap">{caption}</span>
      {held ? (
        <span className="held">
          <span className="why">{heldBy}</span>
          {goTo ? (
            <Button kind="quiet" compact onClick={() => goToStepCard(goTo)}>
              {goToLabel ?? "Take me there"}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

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
/**
 * The booking's bed plan, ready for the composition table's Bed column (2026-10-06).
 *
 * One hook so Negotiation and the rooms table at Arrival / Check-in / Stay cannot describe the
 * same fact differently. A choice is recorded for the stay; from Arrival it also makes the room
 * up that way, and the server says which happened — the toast reads accordingly.
 */
export function useBedPlan(entryId: string) {
  const { session } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["bed-plan", entryId],
    queryFn: () => getEntryBedPlan(session!, entryId),
    enabled: !!session,
  });
  const m = useMutation({
    mutationFn: (v: { roomId: string; bedType: string | null }) => setEntryBedPlan(session!, entryId, v.roomId, v.bedType),
    onSuccess: (out, v) => {
      qc.setQueryData(["bed-plan", entryId], out);
      void qc.invalidateQueries({ queryKey: ["rooms-catalog"] });
      const row = out.rooms.find((r) => r.roomId === v.roomId);
      const word = row?.bedType ? BED_WORDS[row.bedType] ?? row.bedType : "its usual setup";
      toast.success(
        out.applied
          ? `Room ${row?.roomNumber ?? ""} made up as ${word}`.trim()
          : `Room ${row?.roomNumber ?? ""} is to be made up as ${word} — recorded for this stay`.trim(),
      );
      if (out.appliedNote) toast.warning(`The room itself did not follow: ${out.appliedNote}`);
    },
    onError: (e) => toastRefusal(e, "The bed setup could not be changed"),
  });
  const byRoom = useMemo(() => {
    const out: Record<string, BedPlanCell> = {};
    for (const r of q.data?.rooms ?? []) {
      out[r.roomId] = {
        bedType: r.bedType,
        source: r.source,
        usual: r.usual,
        allowed: r.allowed,
        roomNow: r.roomNow,
        appliesNow: r.appliesNow,
      };
    }
    return out;
  }, [q.data]);
  return {
    byRoom,
    ask: q.data?.ask ?? null,
    message: q.data?.message ?? null,
    set: (roomId: string, bedType: string | null) => m.mutate({ roomId, bedType }),
  };
}

const BED_WORDS: Record<string, string> = { KING: "King", QUEEN: "Queen", TWIN: "Twin", SINGLE: "Single" };

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

/**
 * A scrim is rendered at the desk's root, not where its component sits (2026-09-29, operator: the
 * sticky house card sat over an open dialog). The workspace is a size container, which makes it
 * the containing block and a stacking context for anything `position: fixed` inside it — so a
 * dialog opened from the rail lived inside the sticky rail's own stacking context and painted
 * beneath every sticky part that came later on the page. Outside the workspace the scrim covers
 * the real window and sits above all of it.
 */
export function Overlay({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.querySelector<HTMLElement>("[data-ds-overlays]") ?? document.body);
  }, []);
  return host ? createPortal(children, host) : null;
}

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
    <Overlay>
      <div className="scrim open" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
        <div style={width ? { width, maxWidth: "100%" } : undefined} className="dialog-holder">
          <Dialog register={register} title={title} caseLines={caseLines} footer={footer}>
            {children}
          </Dialog>
        </div>
      </div>
    </Overlay>
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
  // A quotation has two faces since 2026-10-06 — with prices, and the copy a guest who asked for
  // one without them receives. Same document, same number; this is how the desk reads the second
  // before sending it.
  const [noPrices, setNoPrices] = useState(false);
  const quotationId = paper?.kind === "quotation" ? paper.id : null;
  useEffect(() => setNoPrices(false), [quotationId]);
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
        ? openQuotationPdf(session, paper.id, { hidePrices: noPrices })
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
    <Overlay>
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
              {paper.kind === "quotation" ? (
                <Button
                  kind="quiet"
                  compact
                  onClick={() => setNoPrices((v) => !v)}
                  title={noPrices ? "Back to the priced quotation" : "The same quotation with the money taken off"}
                >
                  {noPrices ? "With prices" : "Without prices"}
                </Button>
              ) : null}
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
              <QuotationPreview quotationId={paper.id} frozenPdf={noPrices ? false : paper.frozen} hidePrices={noPrices} />
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
    </Overlay>
  );
}

const INVOICE_WORD: Record<string, string> = {
  PROFORMA: "Proforma",
  FINAL: "Tax invoice",
  INTERIM: "Interim bill",
  ADVANCE: "Advance invoice",
};

/** Every paper this booking has, as buttons that open it (P1 — a draft is never sent). */
/**
 * Papers — every version, not just the newest (2026-10-06, operator: "we'll have it save in the
 * system each time, and we can show it a papers tab for these stages and which only shows the
 * history of changes and superseded and the currently working, we can also have the option to
 * email or whatsapp these papers to them there").
 *
 * The card used to show ONE quotation and the live invoices, preview-only. A booking re-priced
 * at Arrival or in-house mints a quotation every time, so the history is the point: which paper
 * is in force now, which it replaced, and when. Superseded versions are kept and readable —
 * their stored PDF prints the figures that were on the table, never today's.
 *
 * Sending is the desk's choice, never automatic. A quotation goes by email or is recorded as
 * handed over on WhatsApp; a bill is dispatched by email. Where the backend has no WhatsApp
 * record for a paper, the row says so rather than offering a button that would do nothing.
 */
export function PapersCard({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const slot = useContext(OtherWaysSlotCtx);
  const [open, setOpen] = useState<PaperRef | null>(null);
  const [sendQuote, setSendQuote] = useState<QuotationSummary | null>(null);
  const [sendInvoice, setSendInvoice] = useState<InvoiceSummary | null>(null);
  const refresh = useRefreshEntry(entry.id);
  const folioLive = !!entry.folio && ["LIVE", "OUTSTANDING", "SETTLED", "CLOSED"].includes(entry.folio.state);
  const folioDocs = useQuery({
    queryKey: ["folio-documents", entry.id, entry.currentStage, entry.folio?.state ?? null],
    queryFn: () => getFolioDocuments(session!, entry.id),
    enabled: !!session && folioLive,
  });

  /** Newest first — the one in force leads, the ones it replaced follow. */
  const quotes = useMemo(
    () => [...(entry.quotations ?? [])].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    [entry.quotations],
  );
  const invoices = useMemo(
    () => [...(entry.folio?.invoices ?? [])].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    [entry.folio?.invoices],
  );

  const others = useMemo<PaperRef[]>(() => {
    const out: PaperRef[] = [];
    if (entry.reservation?.id) out.push({ kind: "voucher", reservationId: entry.reservation.id, label: "Confirmation voucher" });
    for (const d of folioDocs.data?.documents ?? []) {
      if (!d.available || d.kind === "tax-invoice") continue;
      out.push({ kind: "folio", entryId: entry.id, doc: d.kind, label: d.title, refreshKey: `${entry.updatedAt}` });
    }
    if (entry.status === "CANCELLED") out.push({ kind: "cancellation", entryId: entry.id, label: "Cancellation confirmation" });
    return out;
  }, [entry, folioDocs.data]);

  if (quotes.length === 0 && invoices.length === 0 && others.length === 0) return null;

  const liveQuote = (q: QuotationSummary) => q.state === "DRAFT" || q.state === "SENT" || q.state === "ACCEPTED";
  const liveInvoice = (i: InvoiceSummary) => i.state !== "SUPERSEDED";

  return beside(
    <StepCard title="Papers">
      {quotes.length ? (
        <div className="papergrp">
          <div className="h">Quotations</div>
          {quotes.map((q) => (
            <div className="paperrow" key={q.id}>
              <span className="nm">
                <b>{q.referenceNumber}</b>
                {(q.versionNumber ?? 1) > 1 ? <span className="v"> · v{q.versionNumber}</span> : null}
              </span>
              <Chip tone={liveQuote(q) ? "success" : "quiet"}>{QUOTE_WORD[q.state] ?? q.state.toLowerCase()}</Chip>
              <span className="when">{q.createdAt ? fmtStamp(q.createdAt) : ""}</span>
              <span className="acts">
                <Button kind="quiet" compact icon="eye" onClick={() => setOpen({ kind: "quotation", id: q.id, label: `Quotation ${q.referenceNumber}`, frozen: !liveQuote(q) && !!q.pdfStorageKey })}>
                  Preview
                </Button>
                <Live>
                  {liveQuote(q) ? (
                    <Button kind="quiet" compact icon="send" onClick={() => setSendQuote(q)}>
                      Send…
                    </Button>
                  ) : null}
                </Live>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {invoices.length ? (
        <div className="papergrp">
          <div className="h">Bills</div>
          {invoices.map((i) => (
            <div className="paperrow" key={i.id}>
              <span className="nm">
                <b>{i.invoiceNumber ?? i.id}</b>
                <span className="v"> · {INVOICE_WORD[i.invoiceType] ?? "Invoice"}</span>
                {(i.versionNumber ?? 1) > 1 ? <span className="v"> · v{i.versionNumber}</span> : null}
              </span>
              <Chip tone={liveInvoice(i) ? "success" : "quiet"}>{i.state === "SUPERSEDED" ? "replaced" : i.dispatchedAt ? "sent" : i.state.toLowerCase()}</Chip>
              <span className="when">{i.dispatchedAt ? `sent ${fmtStamp(i.dispatchedAt)}` : i.createdAt ? fmtStamp(i.createdAt) : ""}</span>
              <span className="acts">
                <Button kind="quiet" compact icon="eye" onClick={() => setOpen({ kind: "invoice", id: i.id, label: `${INVOICE_WORD[i.invoiceType] ?? "Invoice"} ${i.invoiceNumber ?? i.id}`, issued: i.invoiceType === "FINAL" })}>
                  Preview
                </Button>
                <Live>
                  {liveInvoice(i) ? (
                    <Button kind="quiet" compact icon="send" onClick={() => setSendInvoice(i)}>
                      {i.dispatchedAt ? "Send again…" : "Send…"}
                    </Button>
                  ) : null}
                </Live>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {others.length ? (
        <div className="papergrp">
          <div className="h">Other papers</div>
          <div className="row-acts">
            {others.map((pp) => (
              <Button key={`${pp.kind}:${pp.label}`} kind="quiet" compact icon="file" onClick={() => setOpen(pp)}>
                {pp.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="meta" style={{ marginTop: 8 }}>
        Every version is kept. A replaced paper prints the figures that were on the table when it
        was replaced, never today&rsquo;s · preview never sends anything.
      </div>
      <PaperDrawer paper={open} onClose={() => setOpen(null)} />
      <QuotationSendDialog entry={entry} target={sendQuote} onClose={() => setSendQuote(null)} onSent={() => { setSendQuote(null); refresh(); }} />
      <InvoiceSendDialog entry={entry} target={sendInvoice} onClose={() => setSendInvoice(null)} onSent={() => { setSendInvoice(null); refresh(); }} />
    </StepCard>,
    slot,
  );
}

const QUOTE_WORD: Record<string, string> = {
  DRAFT: "in force",
  SENT: "sent",
  ACCEPTED: "accepted",
  SUPERSEDED: "replaced",
  EXPIRED: "lapsed",
};

/**
 * Send a quotation — by email, or recorded as handed over on WhatsApp (moved into the kit
 * 2026-10-06 so the Negotiation step and the Papers card send the same way; it lived in
 * s2-negotiation and the Papers card would otherwise have grown a second, drifting copy).
 */
export function QuotationSendDialog({
  entry,
  target,
  onClose,
  onSent,
}: {
  entry: EntryDetail;
  target: QuotationSummary | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const { session } = useSession();
  const { tz } = useHotelClock(60_000);
  // Where the quote goes (2026-09-19): the invoices' rule — the agency or company that booked (the
  // quote carries their rates), else the guest — and the backend now sends to what is typed here.
  // The email box used to fall back to the guest's PHONE, and the toast then said "sent by email
  // to +975…" while nothing was emailed.
  const recipient = useInvoiceRecipient(entry);
  const phoneOnFile = (entry.guestProfile?.phone ?? entry.inquiry?.guestProfile?.phone ?? "").trim();
  const [channel, setChannel] = useState<Channel>("EMAIL");
  const [to, setTo] = useState("");
  const [touched, setTouched] = useState(false);
  // "Sometimes guest needs to be sent quotation without the price" (2026-10-06). The offer does
  // not change — same quotation, same number, same validity, and the stored PDF is still the
  // priced one; only the copy the guest receives has the money taken off.
  const [hidePrices, setHidePrices] = useState(false);
  useEffect(() => {
    if (!target || touched) return;
    setTo(channel === "EMAIL" ? recipient.defaultTo : phoneOnFile);
  }, [target, channel, touched, recipient.defaultTo, phoneOnFile]);
  const typed = to.trim();
  const emailish = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed);
  const send = useMutation({
    mutationFn: () =>
      sendQuotation(session!, target!.id, {
        channel,
        recipientAddress: typed,
        sentTo: typed,
        hidePrices,
      }),
    onSuccess: () => {
      const face = hidePrices ? " · without prices" : "";
      toast.success(
        channel === "WHATSAPP"
          ? `${target?.referenceNumber} recorded as sent on WhatsApp to ${typed}${face}`
          : typed
            ? `${target?.referenceNumber} sent by email to ${typed}${face}`
            : `${target?.referenceNumber} recorded as sent — nothing was emailed (no address on file); hand it over or send it on WhatsApp`,
      );
      onSent();
    },
    onError: (e) => toastRefusal(e, "The quotation could not be sent"),
  });
  const hint =
    channel === "WHATSAPP"
      ? "send it on WhatsApp yourself — the desk records the send with this number"
      : !typed
        ? recipient.party
          ? `${recipient.party} has no email on file — type the address, or send it with none and hand the quote over`
          : "no email on file — type one, or send it with none and hand the quote over"
        : !emailish
          ? "that is not an email address"
          : recipient.party && typed === recipient.partyEmail
            ? `${recipient.party}'s email on file — the quote shows their rates`
            : recipient.guestEmail && typed === recipient.guestEmail
              ? recipient.party
                ? `this is the guest's email — the quote is made out to ${recipient.party} and shows its rates`
                : "the guest's email on file"
              : "the send is recorded on the booking with this address";
  if (!target) return null;
  const ok = channel === "WHATSAPP" ? typed.length > 0 : !typed || emailish;
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={send.isPending}
      title={`Send quotation ${target.referenceNumber}`}
      caseLines={[
        `Version ${target.versionNumber}`,
        target.validUntil ? `Price valid until ${fmtDateTime(target.validUntil, tz)} — sending does not restart the clock` : "No validity recorded",
      ]}
      footer={
        <>
          <Button kind="quiet" state={send.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            kind="secondary"
            icon="print"
            onClick={() => session && openQuotationPdf(session, target.id).catch((e) => toastRefusal(e, "The PDF could not be opened"))}
          >
            Print instead
          </Button>
          <Button
            icon="send"
            state={send.isPending ? "working" : ok ? "default" : "inert"}
            title={ok ? undefined : channel === "WHATSAPP" ? "put in the WhatsApp number" : "that is not an email address"}
            workingLabel="Sending…"
            onClick={() => send.mutate()}
          >
            Send now
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Send via</label>
        <Choice
          options={CHANNELS}
          value={channel}
          onChange={(c) => {
            setChannel(c);
            setTouched(false);
          }}
        />
      </div>
      <div className="field">
        <label>{channel === "EMAIL" ? "Email address" : "WhatsApp number"}</label>
        <input
          className="input"
          value={to}
          onChange={(e) => {
            setTouched(true);
            setTo(e.target.value);
          }}
          placeholder={channel === "EMAIL" ? "name@example.com" : "+975 …"}
          autoFocus
        />
        <span className="hint">{hint}</span>
      </div>
      <div className="field">
        <label className="sm" style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={hidePrices} onChange={(e) => setHidePrices(e.target.checked)} />
          Send it without prices
        </label>
        {/* One sentence, ticked or not — a hint that changed length made the dialog jump as the
            box was clicked (2026-10-06, operator: "I don't get why checking that increases the
            box"). */}
        <span className="hint">
          the guest gets the rooms, the nights and the meal plans — no rates, no taxes, no total.
          The record keeps the priced quotation either way.
        </span>
      </div>
    </DsDialog>
  );
}
/** A bill goes out by email; the backend records no WhatsApp send for one. */
function InvoiceSendDialog({
  entry,
  target,
  onClose,
  onSent,
}: {
  entry: EntryDetail;
  target: InvoiceSummary | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const { session } = useSession();
  const recipient = useInvoiceRecipient(entry);
  const [to, setTo] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!target || touched) return;
    setTo(target.dispatchedTo ?? recipient.defaultTo);
  }, [target, touched, recipient.defaultTo]);
  const typed = to.trim();
  const emailish = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed);
  const send = useMutation({
    mutationFn: () => dispatchInvoice(session!, target!.id, { dispatchedTo: typed || undefined }),
    onSuccess: () => {
      toast.success(typed ? `${target?.invoiceNumber ?? "The bill"} sent to ${typed}` : `${target?.invoiceNumber ?? "The bill"} recorded as sent — nothing was emailed; hand it over`);
      onSent();
    },
    onError: (e) => toastRefusal(e, "The bill could not be sent"),
  });
  if (!target) return null;
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={send.isPending}
      title={`Send ${INVOICE_WORD[target.invoiceType] ?? "invoice"} ${target.invoiceNumber ?? target.id}`}
      caseLines={[entry.id, target.dispatchedAt ? "Already sent once — this sends it again" : "Not sent yet"]}
      footer={
        <>
          <Button kind="quiet" state={send.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            icon="send"
            state={send.isPending ? "working" : !typed || emailish ? "default" : "inert"}
            title={!typed || emailish ? undefined : "that is not an email address"}
            workingLabel="Sending…"
            onClick={() => send.mutate()}
          >
            Send now
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Send to</label>
        <input className="input" value={to} onChange={(e) => { setTouched(true); setTo(e.target.value); }} placeholder="email address" />
        <span className="hint">
          {recipient.party ? `${recipient.party} booked — the bill carries their rates` : "the guest's email on file"} · WhatsApp is not
          recorded for a bill yet; hand it over and it stays on the booking either way
        </span>
      </div>
    </DsDialog>
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
