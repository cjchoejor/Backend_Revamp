"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getEntry, listEntries } from "@/lib/api/entries";
import { guestName, partyCaption, stepForStage } from "@/lib/desk/model";
import { deriveFinancials, moneyOrDash } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";

export default function DeskBillingPage() {
  const { session, isLoading: sessionLoading } = useSession();
  const router = useRouter();
  const enabled = !!session && !sessionLoading;

  const entriesQuery = useQuery({
    queryKey: ["entries", { limit: 200 }],
    queryFn: () => listEntries(session!, { limit: 200 }),
    enabled,
  });

  // Folios only exist once a booking reaches Set up (S3+). Fetch detail for those.
  const folioBearing = useMemo(
    () => (entriesQuery.data?.items ?? []).filter((e) => stepForStage(e.currentStage).order >= 3),
    [entriesQuery.data],
  );

  const detailQueries = useQueries({
    queries: folioBearing.map((e) => ({
      queryKey: ["entry", e.id],
      queryFn: () => getEntry(session!, e.id),
      enabled,
    })),
  });

  const rows = useMemo(() => {
    return detailQueries
      .map((q) => q.data)
      .filter((d): d is EntryDetail => !!d)
      .map((entry) => {
        const fin = deriveFinancials(entry);
        // Balance is the backend's folio.outstandingBalance, straight through. This table shows one
        // row per booking, so it deliberately doesn't fetch each one's payment-status just to
        // render an "advance held" figure — open the booking for that.
        let cls: "live" | "prov" | "settled";
        let balance: string;
        if (fin.folio.state === "Settled") {
          cls = "settled";
          balance = "—";
        } else if (fin.folio.state === "Live") {
          cls = "live";
          balance = moneyOrDash(fin.outstanding, fin.currency);
        } else {
          cls = "prov";
          balance = "Provisional";
        }
        return {
          id: entry.id,
          name: guestName(entry.guestProfile ?? entry.inquiry?.guestProfile),
          party: partyCaption(entry),
          state: fin.folio.state,
          cls,
          balance,
        };
      })
      .filter((r) => r.state !== "Not opened");
  }, [detailQueries]);

  const isLoading =
    sessionLoading || entriesQuery.isLoading || detailQueries.some((q) => q.isLoading);

  return (
    <section className="view">
      <div className="eyebrow">Money</div>
      <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
        Folios &amp; balances
      </h1>
      <p className="lead">
        Every folio the property is carrying. Live ones can only grow; settled ones are sealed.
      </p>

      {isLoading ? (
        <p className="lead" style={{ marginTop: 18 }}>
          Loading folios…
        </p>
      ) : rows.length === 0 ? (
        <div className="card" style={{ marginTop: 16, padding: "26px 20px", textAlign: "center" }}>
          <p className="lead" style={{ margin: "0 auto" }}>
            No folios are open yet — they appear once a booking reaches Set up.
          </p>
        </div>
      ) : (
        <>
          <div className="btable-wrap">
            <table className="btable">
              <thead>
                <tr>
                  <th>Guest</th>
                  <th>Stay</th>
                  <th>Folio</th>
                  <th className="bal">Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => router.push(`/desk/bookings/${r.id}`)}>
                    <td className="bg">{r.name}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {r.party}
                    </td>
                    <td>
                      <span className={`fstate ${r.cls}`}>{r.state}</span>
                    </td>
                    <td className="bal">{r.balance}</td>
                    <td>
                      <span className="brow-open">Open →</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="lead" style={{ marginTop: 12, fontSize: 12 }}>
            These are the same folios that live inside each booking — Billing is just the property-wide view.
            Open one and you land in that booking&rsquo;s workspace.
          </p>
        </>
      )}
    </section>
  );
}
