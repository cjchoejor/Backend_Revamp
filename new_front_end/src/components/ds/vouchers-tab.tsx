"use client";

/**
 * Billing › Vouchers (2026-11-24, operator: "once we enter the voucher the system treats that the
 * money as already paid and doesn't remind anyone — in the billing section maybe we should show it if
 * it was actually gotten later, like a flag which shows that the transaction has been recorded or not;
 * recorded could mean the agent has done the payment with card, QR and all, and recorded the journal
 * number").
 *
 * Every agency voucher taken at check-out, with whether the agency's money for it has come in. Tick
 * one agency's vouchers and record the money once — an agency often pays several with one transfer.
 * Recording it never moves a guest's bill: the voucher already counted as paid there. Every figure
 * is the server's; nothing is added up here.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, EmptyState, Input } from "@/design-system";
import { BankFields, useBankEntry } from "@/components/ds/bank-fields";
import { DateInput } from "@/components/ds/date-input";
import { Help } from "@/components/ds/help";
import { StayDates } from "@/components/ds/stay-dates";
import { LoadFailed, LoadingBlock, MoreRow, usePaged } from "@/components/ds/ui";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useSession } from "@/hooks/use-session";
import { listVouchers, previewVoucherMoney, recordVoucherMoney, undoVoucherMoney, type VoucherRow } from "@/lib/api/vouchers";
import { fmtDate, fmtDay, fmtStamp, money, plural } from "@/lib/ds/format";
import { Choice, DsDialog, ReasonDialog, toastRefusal } from "./steps/kit";
import { ReqMark } from "./steps/new-inquiry-parts";

type View = "open" | "received" | "all";

const VIEWS = [
  ["open", "Not received yet"],
  ["received", "Received"],
  ["all", "All"],
] as const;

const METHODS = [
  ["BANK_TRANSFER", "Bank transfer"],
  ["MOBILE_PAYMENT", "QR payment"],
  ["CARD", "Card"],
  ["INWARD_REMITTANCE", "Inward remittance"],
  ["CASH", "Cash"],
] as const;

const METHOD_WORD: Record<string, string> = Object.fromEntries(METHODS);

export function useVouchers(view: View) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["vouchers", view],
    queryFn: () => listVouchers(session!, view),
    enabled: !!session,
    staleTime: 20_000,
  });
}

function receivedWords(r: NonNullable<VoucherRow["received"]>) {
  return [
    `Received ${fmtDay(r.receivedOn)}`,
    METHOD_WORD[r.paymentMethod] ?? r.paymentMethod.toLowerCase().replace(/_/g, " "),
    r.bankName,
    r.journalNumber ? `journal ${r.journalNumber}` : null,
    r.reference ? `receipt ${r.reference}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function RecordDialog({ rows, onClose, onDone }: { rows: VoucherRow[]; onClose: () => void; onDone: () => void }) {
  const { session } = useSession();
  const today = useHotelDay()?.today ?? null;
  const [day, setDay] = useState<string>("");
  const [method, setMethod] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const bank = useBankEntry();
  const ids = rows.map((r) => r.paymentId);
  const preview = useQuery({
    queryKey: ["voucher-preview", ids.join(",")],
    queryFn: () => previewVoucherMoney(session!, { paymentIds: ids }),
    enabled: !!session && ids.length > 0,
  });
  const receivedOn = day || today || "";
  const record = useMutation({
    mutationFn: () =>
      recordVoucherMoney(session!, {
        paymentIds: ids,
        receivedOn,
        paymentMethod: method!,
        ...bank.body(method),
        ...(method === "CASH" ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: (r) => {
      toast.success(`Recorded: ${r.party?.name ?? "the agency"} paid ${money(r.total, preview.data?.currency ?? "BTN")} for ${plural(r.count, "voucher")}`);
      onDone();
    },
    onError: (e) => toastRefusal(e, "The money was not recorded"),
  });
  const wait = !receivedOn
    ? "pick the day the money came in"
    : !method
      ? "pick how the agency paid"
      : bank.missing(method)
        ? bank.missing(method)!
        : method === "CASH" && !reference.trim()
          ? "type the cash receipt's number"
          : undefined;
  const party = rows[0]?.party.name ?? "the agency";
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={record.isPending}
      closeX
      title={`${party} paid for ${plural(rows.length, "voucher")}`}
      caseLines={[
        preview.data ? <b key="t">{money(preview.data.total, preview.data.currency)} in all</b> : "Adding them up…",
        "It is not a payment on the guests' bills — the vouchers already counted there.",
      ]}
      footer={
        <>
          <Button kind="quiet" state={record.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button className={wait ? undefined : "go"} icon="check" state={record.isPending ? "working" : wait ? "inert" : "default"} reason={wait} workingLabel="Recording…" onClick={() => record.mutate()}>
            Record the money received
          </Button>
        </>
      }
    >
      <table className="table compact" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th>Booking</th>
            <th>Voucher taken</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.paymentId}>
              <td>
                {r.booking?.guestName ?? "—"} <span className="meta">· {r.booking?.entryId ?? r.paymentId}</span>
              </td>
              <td>{fmtDate(r.takenAt)}</td>
              <td className="num money">{money(r.amount, r.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form2">
        <div className="field">
          <label>The money came in on</label>
          <DateInput value={receivedOn} max={today ?? undefined} onChange={(e) => setDay(e.target.value)} />
        </div>
        <div />
      </div>
      <div className="field">
        <label>
          How the agency paid {method ? null : <ReqMark title="Pick how the agency paid" />}
        </label>
        <Choice options={METHODS} value={method} onChange={setMethod} />
      </div>
      {method ? <BankFields entry={bank} method={method} /> : null}
      {method === "CASH" ? (
        <div className="form2">
          <div className="field">
            <label>
              Cash receipt number {reference.trim() ? null : <ReqMark title="Type the cash receipt's number" />}
            </label>
            <input className={`input${reference.trim() ? "" : " missing"}`} value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
          </div>
          <div />
        </div>
      ) : null}
      <div className="field">
        <label>
          Note <span className="meta">· optional</span>
        </label>
        <input className="input" value={notes} maxLength={500} placeholder="e.g. paid with their October vouchers" onChange={(e) => setNotes(e.target.value)} />
      </div>
    </DsDialog>
  );
}

export function VouchersTab({ tz }: { tz: string }) {
  const { session } = useSession();
  const fom = !!session && session.actorLevel !== "L1";
  const qc = useQueryClient();
  const [view, setView] = useState<View>("open");
  const [text, setText] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [undoing, setUndoing] = useState<VoucherRow | null>(null);
  const q = useVouchers(view);
  const items = q.data?.items ?? [];
  const totals = q.data?.totals;
  const needle = text.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle
        ? items.filter((r) =>
            [r.party.name, r.booking?.guestName, r.booking?.entryId, r.booking?.inquiryId, r.paymentId, r.received?.journalNumber, r.received?.reference]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(needle),
          )
        : items,
    [items, needle],
  );
  const paged = usePaged(shown, 25);
  const tickedRows = items.filter((r) => ticked.includes(r.paymentId));
  const tickedParty = tickedRows[0]?.party.id ?? (tickedRows.length ? "none" : null);
  const refresh = () => {
    setTicked([]);
    void qc.invalidateQueries({ queryKey: ["vouchers"] });
  };
  const undo = useMutation({
    mutationFn: (v: { row: VoucherRow; reason: string }) => undoVoucherMoney(session!, v.row.paymentId, v.reason),
    onSuccess: () => {
      toast.success("Taken back — the voucher reads not received yet");
      setUndoing(null);
      refresh();
    },
    onError: (e) => toastRefusal(e, "It was not taken back"),
  });

  if (q.error && !q.data) return <LoadFailed what="the vouchers" onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <LoadingBlock />;

  return (
    <div data-vouchers>
      {totals ? (
        <div className={`notice${totals.open.count ? " next" : ""}`} style={{ marginBottom: 12 }} data-vouchers-total>
          <span className="rest">
            {totals.open.count ? (
              <>
                <b className="money">{money(totals.open.amount, "BTN")}</b> in {plural(totals.open.count, "voucher")} not received from the agencies yet
              </>
            ) : (
              <b>Every voucher&rsquo;s money has come in</b>
            )}
            {totals.received.count ? <span className="meta"> · {money(totals.received.amount, "BTN")} received for {plural(totals.received.count, "voucher")}</span> : null}
            <Help label="About vouchers">
              At check-out an agency&rsquo;s voucher counts as paid on the guest&rsquo;s bill. The agency still has to pay the hotel. Record it here when their money comes in — it is
              not a payment on the bill, so the bill does not change.
            </Help>
          </span>
        </div>
      ) : null}
      {totals?.byParty.length ? (
        <div className="row-acts" style={{ marginBottom: 12, flexWrap: "wrap" }} data-vouchers-by-agency>
          {totals.byParty.map((b) => (
            <Button key={b.partyId ?? "none"} kind="secondary" compact onClick={() => setText(b.name)} title={`Show ${b.name}'s vouchers`}>
              {b.name} · {money(b.openAmount, "BTN")} · {plural(b.openCount, "voucher")}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="filters">
        <Choice options={VIEWS} value={view} onChange={(v) => { setView(v); setTicked([]); }} />
        <div className="field searchwrap" style={{ width: 320 }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Agency, guest, booking or journal" aria-label="Search the vouchers" />
        </div>
        <span className="meta">{needle ? `${shown.length} of ${items.length}` : plural(items.length, "voucher")}</span>
      </div>
      {tickedRows.length ? (
        <div className="notice next" style={{ margin: "12px 0" }} data-vouchers-ticked>
          <span className="rest">
            <b>{plural(tickedRows.length, "voucher")}</b> ticked · {tickedRows[0].party.name ?? "no agency"}
          </span>
          <Button className="go" icon="check" compact onClick={() => setRecording(true)}>
            Record the money received
          </Button>
          <Button kind="quiet" compact onClick={() => setTicked([])}>
            Untick all
          </Button>
        </div>
      ) : null}
      {shown.length === 0 ? (
        <EmptyState title={view === "open" ? "No voucher is waiting for its money" : "No vouchers here"} />
      ) : (
        <table className="table zebra" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th style={{ width: 36 }} />
              <th>Agency</th>
              <th>Booking</th>
              <th>Stay</th>
              <th>Voucher taken</th>
              <th className="num">Amount</th>
              <th>The agency&rsquo;s money</th>
            </tr>
          </thead>
          <tbody>
            {paged.shown.map((r, i) => {
              const other = tickedParty != null && (r.party.id ?? "none") !== tickedParty;
              const on = ticked.includes(r.paymentId);
              return (
                <tr key={r.paymentId} className={i % 2 ? "alt" : undefined} data-voucher={r.paymentId}>
                  <td>
                    {r.received ? null : (
                      <input
                        type="checkbox"
                        aria-label={`Tick ${r.booking?.guestName ?? r.paymentId}`}
                        checked={on}
                        disabled={other}
                        title={other ? "Another agency's voucher — record each agency's payment on its own" : undefined}
                        onChange={() => setTicked((t) => (on ? t.filter((x) => x !== r.paymentId) : [...t, r.paymentId]))}
                      />
                    )}
                  </td>
                  <td>{r.party.name ?? <span className="meta">no agency</span>}</td>
                  <td>
                    {r.booking ? (
                      <>
                        <Link className="row-link" href={`/bookings/${r.booking.entryId}`}>
                          {r.booking.guestName}
                        </Link>
                        <div className="meta">{r.booking.entryId}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{r.booking ? <StayDates checkIn={r.booking.checkIn} checkOut={r.booking.checkOut} compact /> : "—"}</td>
                  <td>{fmtDate(r.takenAt)}</td>
                  <td className="num money">
                    <b>{money(r.amount, r.currency)}</b>
                  </td>
                  <td>
                    {r.received ? (
                      <div>
                        <Chip tone="success" icon="check">
                          {receivedWords(r.received)}
                        </Chip>
                        <div className="meta">
                          {r.received.batch.count > 1 ? `with ${plural(r.received.batch.count - 1, "other voucher")} · ${money(r.received.batch.total, r.currency)} in all · ` : ""}
                          by {r.received.recordedBy} · {fmtStamp(r.received.recordedAt, tz)}
                          {fom ? (
                            <>
                              {" · "}
                              <Button kind="quiet" compact onClick={() => setUndoing(r)}>
                                Take back
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <Chip tone="warning">Not received yet</Chip>
                    )}
                  </td>
                </tr>
              );
            })}
            <MoreRow more={paged.more} onMore={paged.showMore} colSpan={7} step={25} />
          </tbody>
        </table>
      )}
      {recording && tickedRows.length ? (
        <RecordDialog
          rows={tickedRows}
          onClose={() => setRecording(false)}
          onDone={() => {
            setRecording(false);
            refresh();
          }}
        />
      ) : null}
      <ReasonDialog
        open={!!undoing}
        onClose={() => setUndoing(null)}
        title="Take back the money recorded for this voucher"
        caseLines={undoing ? [`${undoing.booking?.guestName ?? ""} · ${undoing.party.name ?? ""}`, money(undoing.amount, undoing.currency)] : []}
        lead="Only when it was recorded by mistake. The voucher reads not received yet again; History keeps what was recorded."
        confirmLabel="Take it back"
        danger
        busy={undo.isPending}
        onConfirm={(reason) => undoing && undo.mutate({ row: undoing, reason })}
      />
    </div>
  );
}
