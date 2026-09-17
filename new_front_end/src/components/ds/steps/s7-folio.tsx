"use client";

/**
 * Stay — the folio and what goes onto it (SS03 amendment T1, T3; prototype `V16.stayBase`,
 * `V16.postOpen`).
 *
 * The folio is the destination: the ledger itself (the old table, which folds each charge's
 * service charge and GST under it and slices by room or space), the backend's own totals, the
 * interim statement. "Post a charge" is shaped as a till's message — outlet · chit · when it was
 * consumed · room · amount — and keyed at the desk until the outlets are integrated. A correction
 * and a credit note are the only other ways a line is added. Nothing here adds money up.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useSession } from "@/hooks/use-session";
import { getFolioDocuments } from "@/lib/api/documents";
import { getBillingSummary } from "@/lib/api/entries";
import { correctFolioCharge, postCreditNote, postFolioCharge } from "@/lib/api/in-stay";
import { fmtDay, money, plural } from "@/lib/ds/format";
import {
  FolioLinesTable,
  chargeTargetSpaces,
  filterLinesByTab,
  isTaxCompanion,
  roomTabsFor,
  spaceNamesFromAllocations,
  spaceTabsFor,
  splitChargeTarget,
  type FolioTab,
} from "@/components/desk/workspace/folio-lines";
import type { EntryDetail, FolioLineSummary } from "@/types/api";
import {
  Choice,
  DsDialog,
  Fact,
  Facts,
  Live,
  PaperDrawer,
  StepCard,
  Tool,
  atLeast,
  toastRefusal,
  useRefreshEntry,
  useStepMode,
  type PaperRef,
} from "./kit";
import { WideDialog } from "./s6-shared";

/* ------------------------------------------------------------------ vocabulary */

/** The outlets a charge comes from (T1). The backend knows three kinds of charge; the outlet
 *  decides which, and names itself on the line. */
export const OUTLETS = [
  { id: "restaurant", label: "Restaurant", lineType: "F_AND_B", prefix: "R" },
  { id: "bar", label: "Bar", lineType: "F_AND_B", prefix: "B" },
  { id: "roomservice", label: "Room service", lineType: "F_AND_B", prefix: "RS" },
  { id: "minibar", label: "Minibar", lineType: "F_AND_B", prefix: "MB" },
  { id: "laundry", label: "Laundry", lineType: "SERVICE", prefix: "L" },
  { id: "transport", label: "Transport", lineType: "SERVICE", prefix: "T" },
  { id: "conference", label: "Conference and events", lineType: "SERVICE", prefix: "C" },
  { id: "shop", label: "Shop", lineType: "OTHER", prefix: "S" },
  { id: "other", label: "Something else", lineType: null, prefix: "X" },
] as const;
export type OutletId = (typeof OUTLETS)[number]["id"];

const KIND_WORD: Record<string, string> = {
  ROOM_CHARGE: "Room",
  F_AND_B: "Food and beverage",
  SERVICE: "Service",
  OTHER: "Other",
  CREDIT_NOTE: "Credit note",
};
const KINDS = [
  ["F_AND_B", "Food and beverage"],
  ["SERVICE", "Service"],
  ["OTHER", "Other"],
] as const;
type Kind = (typeof KINDS)[number][0];

const FOLIO_WORD: Record<string, string> = {
  PROVISIONAL: "not live yet",
  LIVE: "live",
  OUTSTANDING: "owing",
  SETTLED: "settled",
  CLOSED: "closed",
};

/** Who a charge is billed to, read from the folio's billing model. */
export const BILLING_WORD: Record<string, string> = {
  GUEST_PAY: "Everything to the guest",
  DIRECT_BILL: "Everything to the account",
  TOUR_OPERATOR_VOUCHER: "The package to the agent · anything beyond it to the guest",
  GOVERNMENT: "Everything to the government account",
};

/* ------------------------------------------------------------------ shared reads */

export function useBillingSummary(entry: EntryDetail) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["billing-summary", entry.id, entry.updatedAt],
    queryFn: () => getBillingSummary(session!, entry.id),
    enabled: !!session && !!entry.folio?.id,
    refetchInterval: 30_000,
  });
}

/** Every room the plan ever held (a vacated room's minibar is still real), numbered. */
export function useChargeTargets(entry: EntryDetail) {
  return useMemo(() => {
    const byRoom = new Map<string, string>();
    for (const a of entry.roomAssignments ?? []) if (!byRoom.has(a.roomId)) byRoom.set(a.roomId, a.room?.roomNumber ?? a.roomId.slice(0, 6));
    const rooms = Array.from(byRoom, ([roomId, roomNumber]) => ({ roomId, roomNumber })).sort((a, b) =>
      a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true }),
    );
    const spaces = chargeTargetSpaces(entry.spaceAllocations);
    return { rooms, spaces, roomNumberById: byRoom, spaceNameById: spaceNamesFromAllocations(entry.spaceAllocations) };
  }, [entry.roomAssignments, entry.spaceAllocations]);
}

/** "for Room 201" / "for Hall A" / "for the booking itself". */
function targetWord(line: { roomId?: string | null; spaceId?: string | null }, t: ReturnType<typeof useChargeTargets>) {
  if (line.roomId) return `Room ${t.roomNumberById.get(line.roomId) ?? "?"}`;
  if (line.spaceId) return t.spaceNameById.get(line.spaceId) ?? "the space";
  return "no room or space";
}

/** The one place a charge is filed against a room, a space, or neither — same list, same values
 *  (`room:<id>` / `space:<id>`) as the old desk's select. */
function TargetSelect({ value, onChange, targets }: { value: string; onChange: (v: string) => void; targets: ReturnType<typeof useChargeTargets> }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No room / space</option>
      {targets.rooms.map((r) => (
        <option key={r.roomId} value={`room:${r.roomId}`}>
          Room {r.roomNumber}
        </option>
      ))}
      {targets.spaces.length ? (
        <optgroup label="Spaces">
          {targets.spaces.map((sp) => (
            <option key={sp.spaceId} value={`space:${sp.spaceId}`}>
              {sp.spaceName}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}

/* ------------------------------------------------------------------ the folio */

export function FolioCard({
  entry,
  onTab,
  onInterimPayment,
}: {
  entry: EntryDetail;
  onTab: (target: string) => void;
  onInterimPayment: () => void;
}) {
  const { session } = useSession();
  const { past } = useStepMode();
  const folio = entry.folio ?? null;
  const lines = folio?.lines ?? [];
  const billing = useBillingSummary(entry);
  const f = billing.data?.folio ?? null;
  const cur = billing.data?.currency ?? lines[0]?.currency ?? "BTN";
  const targets = useChargeTargets(entry);
  const elevated = atLeast(session?.actorLevel, "L2");
  const folioLive = folio?.state === "LIVE";

  const docs = useQuery({
    queryKey: ["folio-documents", entry.id, entry.currentStage, folio?.state ?? null],
    queryFn: () => getFolioDocuments(session!, entry.id),
    enabled: !!session && !!folio && folio.state !== "PROVISIONAL",
  });
  const interim = docs.data?.documents.find((d) => d.kind === "interim-statement") ?? null;
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [crediting, setCrediting] = useState(false);

  return (
    <StepCard
      title={`The folio · ${FOLIO_WORD[folio?.state ?? ""] ?? "not open"}`}
      right={f ? <Chip tone="quiet">{plural(f.lineCount, "line")}</Chip> : null}
    >
      {!folio ? (
        <span className="meta">No folio on this booking.</span>
      ) : (
        <>
          <Tool inert={false}>
            <FolioLinesTable
              lines={lines}
              roomNumberById={targets.roomNumberById}
              perRoomCharges={f?.perRoomCharges ?? null}
              perSpaceCharges={f?.perSpaceCharges ?? null}
              spaceNameById={targets.spaceNameById}
              unassignedCharges={f?.unassignedCharges ?? null}
              chargeBreakdown={f?.chargeBreakdown ?? null}
              balance={folio.outstandingBalance ?? null}
              currency={cur}
              emptyText="Nothing posted yet · the room charge posts with each night's audit"
              onTabChange={(t: FolioTab) => onTab(typeof t === "string" ? "" : "spaceId" in t ? `space:${t.spaceId}` : `room:${t.roomId}`)}
            />
          </Tool>
          <div className="row-acts" style={{ marginTop: 8, justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="meta">
              received {money(f?.paymentsReceived ?? null, cur)}
              {f?.refunded ? ` · refunded ${money(f.refunded, cur)}` : ""}
              {f?.writtenOff ? ` · written off ${money(f.writtenOff, cur)}` : ""} · balance {money(f?.outstandingBalance ?? folio.outstandingBalance ?? null, cur)}
            </span>
            <span>
              <span className="meta">billed so far </span>
              <b className="money">{money(f?.billedSoFar ?? null, cur)}</b>
            </span>
          </div>
          <div className="row-acts" style={{ marginTop: 12 }}>
            <Button
              kind="secondary"
              compact
              icon="file"
              state={interim?.available ? "default" : "inert"}
              reason={interim && !interim.available ? interim.unavailableReason ?? undefined : undefined}
              onClick={() =>
                setPaper({ kind: "folio", entryId: entry.id, doc: "interim-statement", label: interim?.title ?? "Interim statement", refreshKey: entry.updatedAt })
              }
            >
              Interim statement
            </Button>
            <Live>
              <Button kind="quiet" compact onClick={onInterimPayment}>
                Interim payment
              </Button>
              <Button
                kind="quiet"
                compact
                state={folioLive ? "default" : "inert"}
                title={folioLive ? undefined : "the folio takes corrections while it is live"}
                onClick={() => setCorrecting(true)}
              >
                Correct a charge…
              </Button>
              <Button
                kind="quiet"
                compact
                state={elevated && folioLive ? "default" : "inert"}
                reason={elevated ? undefined : "a credit note is the FOM's"}
                title={folioLive ? undefined : "the folio takes credit notes while it is live"}
                onClick={() => setCrediting(true)}
              >
                Credit note…
              </Button>
            </Live>
          </div>
          <div className="meta" style={{ marginTop: 8 }}>
            Nothing posted is edited — a correction adds an offsetting line beside the original, and its service charge and GST move with it. Service charge and GST post alongside every charge.
          </div>
        </>
      )}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
      {folio && !past ? (
        <>
          <CorrectionDialog entry={entry} open={correcting} onClose={() => setCorrecting(false)} />
          <CreditNoteDialog entry={entry} open={crediting} onClose={() => setCrediting(false)} />
        </>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ post a charge */

export function PostChargeCard({
  entry,
  target,
  setTarget,
}: {
  entry: EntryDetail;
  target: string;
  setTarget: (v: string) => void;
}) {
  const { past } = useStepMode();
  const [outlet, setOutlet] = useState<OutletId | null>(null);
  if (past) return null;
  const folioLive = entry.folio?.state === "LIVE";
  return (
    <StepCard title="Post a charge">
      <div className="row-acts">
        {OUTLETS.map((o) => (
          <Button
            key={o.id}
            kind="quiet"
            compact
            state={folioLive ? "default" : "inert"}
            title={folioLive ? undefined : "charges post once the folio is live — at check-in"}
            onClick={() => setOutlet(o.id)}
          >
            {o.label}
          </Button>
        ))}
      </div>
      {folioLive ? null : <span className="control-note">Charges post once the folio is live — at check-in</span>}
      <div className="meta" style={{ marginTop: 6 }}>
        Each opens the same form, shaped as a till&rsquo;s message: outlet · chit · when it was consumed · room · amount. Routing follows the billing model.
      </div>
      <PostChargeDialog entry={entry} outlet={outlet} setOutlet={setOutlet} target={target} setTarget={setTarget} />
    </StepCard>
  );
}

function PostChargeDialog({
  entry,
  outlet,
  setOutlet,
  target,
  setTarget,
}: {
  entry: EntryDetail;
  outlet: OutletId | null;
  setOutlet: (o: OutletId | null) => void;
  target: string;
  setTarget: (v: string) => void;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const hotelToday = useHotelDay()?.today ?? null;
  const targets = useChargeTargets(entry);
  const o = OUTLETS.find((x) => x.id === outlet) ?? null;

  const [chit, setChit] = useState("");
  const [consumedOn, setConsumedOn] = useState("");
  const [at, setAt] = useState("");
  const [what, setWhat] = useState("");
  const [amount, setAmount] = useState("");
  const [servedBy, setServedBy] = useState("");
  const [kind, setKind] = useState<Kind>("OTHER");
  const [receipt, setReceipt] = useState<FolioLineSummary | null>(null);

  // The consumption day starts as the hotel's today, once it is known — never the machine's.
  const latched = useRef(false);
  useEffect(() => {
    if (latched.current || !hotelToday) return;
    latched.current = true;
    setConsumedOn(hotelToday);
  }, [hotelToday]);

  const lineType: Kind = (o?.lineType as Kind | null) ?? kind;
  const amt = Number.parseFloat(amount);
  const needsChit = o?.id !== "other";
  const missing = !o
    ? "choose the outlet"
    : needsChit && !chit.trim()
      ? "the chit number — it is how the posting is matched to the outlet later"
      : !what.trim()
        ? "what was taken"
        : !Number.isFinite(amt) || amt === 0
          ? "a net amount"
          : null;
  const lines = entry.folio?.lines ?? [];
  const chitSeen =
    !!o && !!chit.trim() && lines.some((l) => l.description.toLowerCase().includes(`${o.label} · chit ${chit.trim()}`.toLowerCase()));

  const description = () => {
    if (!o) return what.trim();
    const parts = [o.id === "other" ? null : o.label, chit.trim() ? `chit ${chit.trim()}` : null, what.trim(), at.trim() ? `at ${at.trim()}` : null, servedBy.trim() ? `served by ${servedBy.trim()}` : null];
    return parts.filter(Boolean).join(" · ");
  };

  const post = useMutation({
    mutationFn: () => {
      if (!entry.folio?.id) throw new Error("There is no folio to post to");
      return postFolioCharge(session!, entry.folio.id, {
        entryId: entry.id,
        lineType,
        description: description(),
        amount: amt,
        chargeDate: consumedOn ? `${consumedOn}T12:00:00.000Z` : undefined,
        ...splitChargeTarget(target),
      });
    },
    onSuccess: (line) => {
      refresh();
      setReceipt(line);
      setOutlet(null);
      setChit("");
      setAt("");
      setWhat("");
      setAmount("");
      setServedBy("");
    },
    onError: (e) => toastRefusal(e, "The charge could not be posted"),
  });

  const billingModel = entry.folio?.billingModel ?? null;

  return (
    <>
      <WideDialog
        open={!!o}
        onClose={() => setOutlet(null)}
        register="commit"
        title="Post a charge"
        width={720}
        busy={post.isPending}
        footer={
          <>
            <Button kind="quiet" state={post.isPending ? "inert" : "default"} onClick={() => setOutlet(null)}>
              Cancel
            </Button>
            <Button state={post.isPending ? "working" : missing ? "inert" : "default"} title={missing ?? undefined} workingLabel="Posting…" onClick={() => post.mutate()}>
              Post
            </Button>
          </>
        }
      >
        <Choice options={OUTLETS.map((x) => [x.id, x.label] as const)} value={outlet} onChange={(v) => setOutlet(v)} />
        <p className="meta" style={{ margin: "8px 0" }}>
          This is the shape a till will send: the outlet, its chit, when it was consumed, the room, the amount. Until then the desk keys it from the paper chit — the folio and this screen are the same either way.
        </p>
        <div className="form2">
          <div className="field">
            <label>Chit number{needsChit ? "" : " · optional"}</label>
            <input className="input" value={chit} placeholder={o ? `${o.prefix}-1182` : ""} onChange={(e) => setChit(e.target.value)} />
            <span className={`hint${chitSeen ? " warn-ink" : ""}`}>
              {chitSeen ? "a chit with this number is already on the folio — a chit posts once" : "the paper chit today · the till's own number later"}
            </span>
          </div>
          <div className="field">
            <label>Room</label>
            <TargetSelect value={target} onChange={setTarget} targets={targets} />
            <span className="hint">a till posts by room; the room finds the booking</span>
          </div>
          <div className="field">
            <label>Consumed on</label>
            <input
              className="input"
              type="date"
              value={consumedOn}
              max={hotelToday ?? undefined}
              disabled={!hotelToday}
              title={hotelToday ? undefined : "checking today's date at the hotel…"}
              onChange={(e) => setConsumedOn(e.target.value)}
            />
            <span className="hint">
              not when it is typed{consumedOn ? ` · ${fmtDay(consumedOn)}` : ""} · a sealed night posts to the open date
            </span>
          </div>
          <div className="field">
            <label>At · optional</label>
            <input className="input" value={at} placeholder="8:15 PM" onChange={(e) => setAt(e.target.value)} />
          </div>
          {o?.id === "other" ? (
            <div className="wide field">
              <label>Kind of charge</label>
              <Choice options={KINDS} value={kind} onChange={setKind} />
              <span className="hint">one of the kinds a tax invoice carries</span>
            </div>
          ) : null}
          <div className="wide field">
            <label>{o?.id === "minibar" ? "What was taken" : "What"}</label>
            <input
              className="input"
              value={what}
              placeholder={o?.id === "minibar" ? "2 × Mineral water 1L, 1 × Beer · Druk 11000" : "dinner · 2 covers"}
              onChange={(e) => setWhat(e.target.value)}
            />
            {o?.id === "minibar" ? (
              <span className="hint">
                counted in the room · the item list with its prices is not in the backend yet, so the total is typed below
              </span>
            ) : null}
          </div>
          <div className="field">
            <label>Net amount · Nu.</label>
            <input className="input money" inputMode="decimal" value={amount} placeholder="1,250.00" onChange={(e) => setAmount(e.target.value.replace(/[^\d.-]/g, ""))} />
            <span className="hint">before service charge and GST — they post alongside</span>
          </div>
          <div className="field">
            <label>Served by · optional</label>
            <input className="input" value={servedBy} placeholder="optional" onChange={(e) => setServedBy(e.target.value)} />
          </div>
          <div className="wide field">
            <label>Goes to</label>
            <select className="input" disabled value="model">
              <option value="model">{billingModel ? BILLING_WORD[billingModel] ?? "as the billing model says" : "as the billing model says"}</option>
            </select>
            <span className="control-note">
              Sending one charge to a different payer is not in the backend yet (BE-41, BE-55) — it follows the booking&rsquo;s billing model
            </span>
          </div>
        </div>
        <div className="meta" style={{ marginTop: 8 }}>
          Kind: <b>{KIND_WORD[lineType] ?? "Other"}</b> · the line reads &ldquo;{description() || "…"}&rdquo;
        </div>
      </WideDialog>
      <DsDialog
        open={!!receipt}
        onClose={() => setReceipt(null)}
        register="report"
        title="Charge posted"
        footer={
          <Button kind="secondary" onClick={() => setReceipt(null)}>
            Done
          </Button>
        }
      >
        {receipt ? (
          <Facts>
            <Fact k="Amount">
              <b className="money">{money(receipt.amount, receipt.currency)}</b>
            </Fact>
            <Fact k="What">{receipt.description}</Fact>
            <Fact k="Kind">{KIND_WORD[receipt.lineType] ?? "Other"}</Fact>
            <Fact k="Filed against">{targetWord(receipt, targets)}</Fact>
            <Fact k="Dated">{fmtDay(receipt.chargeDate)}</Fact>
          </Facts>
        ) : null}
        <p className="meta" style={{ marginTop: 8 }}>
          Service charge and GST post alongside, at the rates the hotel has set.
        </p>
      </DsDialog>
    </>
  );
}

/* ------------------------------------------------------------------ correct a charge */

const tabOf = (k: string): FolioTab =>
  k === "ALL" || k === "WHOLE" ? k : k.startsWith("space:") ? { spaceId: k.slice(6) } : { roomId: k.slice(5) };

function CorrectionDialog({ entry, open, onClose }: { entry: EntryDetail; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const targets = useChargeTargets(entry);
  const billing = useBillingSummary(entry);
  const lines = entry.folio?.lines ?? [];

  // Only charges are correctable: a tax line moves with its charge, and an earlier correction is
  // never itself the thing corrected.
  const correctable = useMemo(
    () =>
      lines.filter(
        (l) => !isTaxCompanion(l) && !l.description.toLowerCase().startsWith("sales tax") && !l.description.toLowerCase().startsWith("correction for"),
      ),
    [lines],
  );
  const roomTabs = useMemo(() => roomTabsFor(correctable, targets.roomNumberById), [correctable, targets.roomNumberById]);
  const spaceTabs = useMemo(
    () => spaceTabsFor(correctable, billing.data?.folio?.perSpaceCharges ?? null, targets.spaceNameById),
    [correctable, billing.data, targets.spaceNameById],
  );
  const hasRoomless = correctable.some((l) => !l.roomId && !l.spaceId);
  const tabs = useMemo(
    () =>
      [
        ["ALL", "All charges"] as const,
        ...roomTabs.map((r) => [`room:${r.roomId}`, `Room ${r.roomNumber}`] as const),
        ...spaceTabs.map((s) => [`space:${s.spaceId}`, s.spaceName] as const),
        ...(hasRoomless ? ([["WHOLE", "No room / space"]] as const) : []),
      ] as ReadonlyArray<readonly [string, string]>,
    [roomTabs, spaceTabs, hasRoomless],
  );

  const [tab, setTab] = useState("ALL");
  const [lineId, setLineId] = useState("");
  const [mode, setMode] = useState<"adjust" | "setNet">("adjust");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!open) return;
    setLineId("");
    setValue("");
    setReason("");
  }, [open]);

  const visible = useMemo(() => filterLinesByTab(correctable, tabOf(tab)), [correctable, tab]);
  const pickTab = (k: string) => {
    setTab(k);
    if (lineId && !filterLinesByTab(correctable, tabOf(k)).some((l) => l.id === lineId)) setLineId("");
  };
  const num = Number.parseFloat(value);
  const missing = !lineId
    ? "pick the charge that is wrong"
    : !Number.isFinite(num) || (mode === "adjust" && num === 0)
      ? mode === "adjust"
        ? "a non-zero adjustment"
        : "the net amount to set it to"
      : !reason.trim()
        ? "the reason"
        : null;

  const save = useMutation({
    mutationFn: () => {
      if (!entry.folio?.id) throw new Error("There is no folio");
      const body: Parameters<typeof correctFolioCharge>[2] = {
        entryId: entry.id,
        originalFolioLineId: lineId,
        reason: reason.trim(),
        correctionDate: new Date().toISOString(),
      };
      if (mode === "setNet") body.correctToAmount = num;
      else body.correctionAmount = num;
      return correctFolioCharge(session!, entry.folio.id, body);
    },
    onSuccess: () => {
      toast.success("Correction posted — its service charge and GST moved with it");
      refresh();
      onClose();
    },
    onError: (e) => toastRefusal(e, "The correction could not be posted"),
  });

  const picked = correctable.find((l) => l.id === lineId) ?? null;
  return (
    <WideDialog
      open={open}
      onClose={onClose}
      register="commit"
      title="Correct a charge"
      caseLines={picked ? [`${picked.description} · ${money(picked.amount, picked.currency)}`] : undefined}
      width={780}
      busy={save.isPending}
      footer={
        <>
          <Button kind="quiet" state={save.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button state={save.isPending ? "working" : missing ? "inert" : "default"} title={missing ?? undefined} workingLabel="Posting…" onClick={() => save.mutate()}>
            Post the correction
          </Button>
        </>
      }
    >
      <p className="sm" style={{ marginTop: 0 }}>
        Nothing posted can be edited or deleted. The correction adds a second line beside the original, so the bill shows both the mistake and the fix; the charge&rsquo;s service charge and GST move with it, at the rates it was taxed at.
      </p>
      {tabs.length > 1 ? <Choice options={tabs} value={tab} onChange={pickTab} /> : null}
      <div style={{ maxHeight: 280, overflow: "auto", marginTop: 8 }}>
        <table className="table compact">
          <thead>
            <tr>
              <th />
              <th>Date</th>
              {tab === "ALL" ? <th>Room / space</th> : null}
              <th>Charge</th>
              <th>Kind</th>
              <th className="num">Net</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr className="static">
                <td colSpan={6} className="meta">
                  Nothing posted here yet
                </td>
              </tr>
            ) : (
              visible.map((l) => (
                <tr key={l.id} className={`pickable${lineId === l.id ? " selected" : ""}`} onClick={() => setLineId(l.id)}>
                  <td style={{ width: 28 }}>
                    <input type="radio" name="s7-correct-line" checked={lineId === l.id} onChange={() => setLineId(l.id)} />
                  </td>
                  <td>{fmtDay(l.chargeDate)}</td>
                  {tab === "ALL" ? <td className={l.roomId || l.spaceId ? undefined : "meta"}>{targetWord(l, targets)}</td> : null}
                  <td>
                    {l.description}
                    <span className="meta"> · {l.nightAuditRecordId ? "the night audit" : "the desk"}</span>
                  </td>
                  <td className="meta">{KIND_WORD[l.lineType] ?? "Other"}</td>
                  <td className="num money">{money(l.amount, l.currency)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="form2" style={{ marginTop: 12 }}>
        <div className="wide field">
          <label>How</label>
          <Choice
            options={[
              ["adjust", "Adjust by an amount"],
              ["setNet", "Set the net to"],
            ]}
            value={mode}
            onChange={(v) => {
              setMode(v);
              setValue("");
            }}
          />
        </div>
        <div className="field">
          <label>{mode === "adjust" ? "Adjust by · Nu. (– to reduce)" : "Set the net to · Nu."}</label>
          <input className="input money" inputMode="decimal" value={value} placeholder={mode === "adjust" ? "-50.00" : "100.00"} onChange={(e) => setValue(e.target.value.replace(/[^\d.-]/g, ""))} />
        </div>
        <div className="field">
          <label>Reason</label>
          <input className="input" value={reason} placeholder="charged twice at the bar" onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
    </WideDialog>
  );
}

/* ------------------------------------------------------------------ credit note */

function CreditNoteDialog({ entry, open, onClose }: { entry: EntryDetail; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const targets = useChargeTargets(entry);
  const [what, setWhat] = useState("");
  const [amount, setAmount] = useState("");
  const [target, setTarget] = useState("");
  useEffect(() => {
    if (!open) return;
    setWhat("");
    setAmount("");
  }, [open]);
  const amt = Number.parseFloat(amount);
  const missing = !what.trim() ? "what the credit is for" : !Number.isFinite(amt) || amt <= 0 ? "an amount above zero" : null;
  const save = useMutation({
    mutationFn: () => {
      if (!entry.folio?.id) throw new Error("There is no folio");
      return postCreditNote(session!, entry.folio.id, {
        entryId: entry.id,
        description: what.trim(),
        amount: amt,
        creditDate: new Date().toISOString(),
        ...splitChargeTarget(target),
      });
    },
    onSuccess: (line) => {
      toast.success(`Credit note posted · ${money(line.amount, line.currency)} · ${targetWord(line, targets)}`);
      refresh();
      onClose();
    },
    onError: (e) => toastRefusal(e, "The credit note could not be posted"),
  });
  return (
    <DsDialog
      open={open}
      onClose={onClose}
      register="commit"
      title="Post a credit note"
      busy={save.isPending}
      footer={
        <>
          <Button kind="quiet" state={save.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button state={save.isPending ? "working" : missing ? "inert" : "default"} title={missing ?? undefined} workingLabel="Posting…" onClick={() => save.mutate()}>
            Post the credit note
          </Button>
        </>
      }
    >
      <p className="sm" style={{ marginTop: 0 }}>
        A credit reduces what the guest owes and stays on the folio as its own line. The FOM&rsquo;s act.
      </p>
      <div className="form2">
        <div className="wide field">
          <label>What it is for</label>
          <input className="input" value={what} placeholder="goodwill for the late room" onChange={(e) => setWhat(e.target.value)} />
        </div>
        <div className="field">
          <label>Amount · Nu.</label>
          <input className="input money" inputMode="decimal" value={amount} placeholder="500.00" onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
        </div>
        <div className="field">
          <label>Against</label>
          <TargetSelect value={target} onChange={setTarget} targets={targets} />
        </div>
      </div>
      <p className="control-note" style={{ marginTop: 8 }}>
        The credit note as a paper is not in the backend yet (BE-47)
      </p>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ chits waiting */

export function ChitsWaitingCard() {
  const { past } = useStepMode();
  if (past) return null;
  return (
    <StepCard title="Chits waiting">
      <span className="meta">Nothing waiting. When a till is integrated, its postings arrive here and the desk only accepts them.</span>
      <div className="row-acts" style={{ marginTop: 8 }}>
        <Button kind="quiet" compact state="inert" reason="A tray of chits and till postings awaiting acceptance is not in the backend yet (BE-68) — key the paper chit through Post a charge">
          Key it in
        </Button>
      </div>
    </StepCard>
  );
}
