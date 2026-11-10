"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { StayDates } from "@/components/ds/stay-dates";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { cancelEntryAtS3, cancelEntryAtS5, declineEntry, previewTripCancellation } from "@/lib/api/reservation-setup";
import { money, plural } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { WaiverTick, useRefundHow } from "./cancel-figures";
import { InlineWay, ReasonDialog, atLeast, useCloseAlsoWay, useRefreshEntry } from "./kit";

/**
 * Cancel booking, viewing the stays together (2026-11-09, operator): it asks which stays. Each goes
 * through its own cancellation, in stay order, and a stay refused is named. Before Set up nothing is
 * charged. From Set up every figure is the server's, stay by stay, with any money that moves between
 * the bills because money paid for the trip is one pot.
 */
export function TripCancelWay(props: { entry: EntryDetail; stays: EntryDetail[]; stayNoOf: (id: string) => number; word?: "booking" | "inquiry" }) {
  return <InlineWay render={(done) => <TripCancelForm {...props} onClose={done} />} />;
}

function TripCancelForm({
  entry,
  stays,
  stayNoOf,
  word = "booking",
  onClose,
}: {
  entry: EntryDetail;
  stays: EntryDetail[];
  stayNoOf: (id: string) => number;
  word?: "booking" | "inquiry";
  onClose: () => void;
}) {
  const { session } = useSession();
  const closeWay = useCloseAlsoWay();
  const refresh = useRefreshEntry(entry.id);
  const gm = atLeast(session?.actorLevel, "L3");
  const [picked, setPicked] = useState<string[]>([]);
  const [waive, setWaive] = useState(false);
  const refund = useRefundHow();
  const ordered = [...stays].sort((a, b) => stayNoOf(a.id) - stayNoOf(b.id));
  const chosen = ordered.filter((s) => picked.includes(s.id)).map((s) => s.id);
  const stage = entry.currentStage;
  const priced = stage !== "S1" && stage !== "S2";
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const preview = useQuery({
    queryKey: ["trip-cancel-preview", entry.id, chosen, waive],
    queryFn: () => previewTripCancellation(session!, entry.id, { stayIds: chosen, waive: gm && waive }),
    enabled: !!session && priced && chosen.length > 0,
    staleTime: 0,
    retry: false,
  });

  const run = useMutation({
    mutationFn: async (reason: string) => {
      const failed: Array<{ id: string; message: string }> = [];
      const done: string[] = [];
      for (const id of chosen) {
        try {
          if (!priced) await declineEntry(session!, id, reason);
          else {
            const body = { reason, ...(gm && waive ? { penaltyWaiverRequested: true } : {}), ...refund.body };
            if (stage === "S3") await cancelEntryAtS3(session!, id, body);
            else await cancelEntryAtS5(session!, id, body);
          }
          done.push(id);
        } catch (e) {
          failed.push({ id, message: e instanceof ApiError ? e.message : "It could not be cancelled." });
        }
      }
      return { done, failed };
    },
    onSuccess: ({ done, failed }) => {
      for (const f of failed) toast.warning(`Stay ${stayNoOf(f.id)} was not cancelled — ${f.message}`);
      if (done.length) toast.success(`${done.map((id) => `Stay ${stayNoOf(id)}`).join(" and ")} cancelled`);
      refresh([
        ...ordered.flatMap((s) => [
          ["entry", s.id],
          ["payment-status", s.id],
          ["billing-summary", s.id],
        ]),
        ["trip-together"],
        ["trip-quotation"],
        ["trip-proforma"],
        ["trip-voucher"],
        ["rooms"],
        ["rooms-catalog"],
      ]);
      if (done.length) {
        setPicked([]);
        onClose();
        closeWay();
      }
    },
  });

  const p = preview.data;
  const waiting = priced && chosen.length > 0 && (preview.isLoading || preview.isFetching);
  const refused = priced && preview.isError ? (preview.error instanceof ApiError ? preview.error.message : "The figures could not be read.") : null;
  const label = word === "inquiry" ? "inquiry" : "booking";
  return (
    <ReasonDialog
      open
      danger
      onClose={onClose}
      busy={run.isPending}
      title="Which stays are cancelled?"
      lead={<>This cannot be undone for a stay you pick. A stay you leave out carries on.</>}
      confirmLabel={chosen.length > 1 ? `Cancel ${plural(chosen.length, "stay")}` : `Cancel the ${chosen.length ? "stay" : label}`}
      placeholder="what the guest or the booker said"
      onConfirm={(r) => run.mutate(r)}
      extraValid={chosen.length > 0 && !waiting && !refused}
      extraReason={chosen.length === 0 ? "pick at least one stay" : (refused ?? "reading the figures")}
    >
      <div className="arrival-pick">
        {ordered.map((st) => {
          const on = picked.includes(st.id);
          return (
            <label key={st.id} className={`arrival-row${on ? " on" : ""}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(st.id)} />
              <b>Stay {stayNoOf(st.id)}</b>
              <StayDates checkIn={st.checkInDate} checkOut={st.checkOutDate} />
              <span className="mono sm muted">{st.id}</span>
            </label>
          );
        })}
      </div>
      {refused ? (
        <p className="rct-refusal" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>
          <span className="ic" aria-hidden="true">
            !
          </span>
          {refused}
        </p>
      ) : null}
      {priced && p ? (
        <div style={{ marginTop: 12 }} data-trip-cancel-figures>
          <table className="table compact">
            <thead>
              <tr>
                <th>Stay</th>
                <th style={{ textAlign: "right" }}>Held for it</th>
                <th style={{ textAlign: "right" }}>Charged</th>
                <th style={{ textAlign: "right" }}>Refunded</th>
              </tr>
            </thead>
            <tbody>
              {p.stays.map((s) => (
                <tr key={s.entryId} className="static">
                  <td className="nowrap">Stay {stayNoOf(s.entryId)}</td>
                  <td className="money" style={{ textAlign: "right" }}>
                    {money(s.advanceReceived)}
                  </td>
                  <td className="money" style={{ textAlign: "right" }}>
                    {money(s.charge)}
                    {!p.waived && s.chargeBeforeCap > s.chargeCapped ? <span className="sub">the terms ask {money(s.chargeBeforeCap)}</span> : null}
                    {s.rule ? <span className="sub" data-cancel-rule>{s.rule}</span> : null}
                  </td>
                  <td className="money" style={{ textAlign: "right" }}>
                    {money(s.refund)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.moves.length ? (
            <ul className="sm" style={{ margin: "8px 0 0", paddingLeft: 18 }} data-trip-moves>
              {p.moves.map((m, i) => (
                <li key={i}>
                  <b>{money(m.amount)}</b> moves from Stay {stayNoOf(m.fromEntryId)}&rsquo;s bill to Stay {stayNoOf(m.toEntryId)}&rsquo;s
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {priced ? (
        <>
          <WaiverTick checked={waive} onChange={setWaive} gm={gm} />
          {refund.fields}
        </>
      ) : null}
    </ReasonDialog>
  );
}
