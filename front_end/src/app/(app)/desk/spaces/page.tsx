"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listSpaces, type SpaceListItem } from "@/lib/api/rooms";
import { DeficiencyPanel } from "@/components/deficiency/deficiency-panel";

/**
 * Conference / event spaces on the desk — the counterpart to `/desk/rooms`.
 *
 * Read-only inventory (creating and renaming spaces stays on `/admin/spaces`, L4) plus fault
 * reporting, so front desk can take a space out of service without waiting for an admin. A
 * space with an open fault is refused by event allocation, exactly as a deficient room leaves
 * the booking pool.
 */

type SpaceStatus = { key: string; label: string; color: string };

function statusOf(s: SpaceListItem): SpaceStatus {
  if (s.isDeficient) return { key: "deficient", label: "Out of service", color: "var(--stop)" };
  if (!s.isAvailable) return { key: "unavailable", label: "Unavailable", color: "var(--ink-2)" };
  if (s.isEventInProgress) return { key: "inuse", label: "Event in progress", color: "var(--amber, #b8860b)" };
  return { key: "ready", label: "Available", color: "var(--green)" };
}

export default function DeskSpacesPage() {
  const { session, isLoading: sessionLoading } = useSession();
  const queryClient = useQueryClient();
  const [faultSpace, setFaultSpace] = useState<{ id: string; code: string; name: string } | null>(null);

  const spacesQuery = useQuery({
    queryKey: ["spaces"],
    queryFn: () => listSpaces(session!),
    enabled: !!session && !sessionLoading,
  });

  // Escape closes the dialog — bound to the document because focus sits inside the form.
  useEffect(() => {
    if (!faultSpace) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFaultSpace(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [faultSpace]);

  const spaces = useMemo(() => spacesQuery.data?.items ?? [], [spacesQuery.data]);
  const isLoading = sessionLoading || spacesQuery.isLoading;
  const outOfService = spaces.filter((s) => s.isDeficient).length;

  return (
    <section className="view">
      <div className="eyebrow">Inventory</div>
      <h1 className="h-lg" style={{ margin: "4px 0 6px" }}>
        Spaces
      </h1>
      <p className="lead">
        Conference and event spaces. Select one to report a fault or review one already raised — a space with
        an open fault is refused by event allocation until it&rsquo;s cleared.
      </p>

      {isLoading ? (
        <p className="lead" style={{ marginTop: 18 }}>
          Loading spaces…
        </p>
      ) : spacesQuery.isError ? (
        // Distinguished from "none configured" on purpose — an outage should not read as a
        // configuration problem and send someone hunting in the admin console.
        <div className="card" style={{ marginTop: 16, padding: "26px 20px", textAlign: "center" }}>
          <p className="lead" style={{ margin: "0 auto" }}>
            Couldn&rsquo;t load spaces. Check that the backend is running, then retry.
          </p>
        </div>
      ) : spaces.length === 0 ? (
        <div className="card" style={{ marginTop: 16, padding: "26px 20px", textAlign: "center" }}>
          <p className="lead" style={{ margin: "0 auto" }}>
            No spaces configured yet. They&rsquo;re added in the admin console under Inventory → Spaces.
          </p>
        </div>
      ) : (
        <>
          <div className="kpibar">
            <div className="kpi">
              <div className="kv">{spaces.length}</div>
              <div className="kk">Total</div>
            </div>
            <div className="kpi">
              <div className="kv">{spaces.filter((s) => statusOf(s).key === "ready").length}</div>
              <div className="kk">
                <span className="d" style={{ background: "var(--green)" }} />
                Available
              </div>
            </div>
            <div className="kpi">
              <div className="kv">{outOfService}</div>
              <div className="kk">
                <span className="d" style={{ background: "var(--stop)" }} />
                Out of service
              </div>
            </div>
          </div>

          <div className="floor" style={{ marginTop: 14 }}>
            <div className="floor-h">All spaces</div>
            <div className="roomgrid">
              {spaces.map((s) => {
                const st = statusOf(s);
                return (
                  <button
                    type="button"
                    key={s.id}
                    className={`room${st.key === "deficient" ? " stop" : ""}`}
                    onClick={() => setFaultSpace({ id: s.id, code: s.code, name: s.name })}
                    title={`Report or review faults on ${s.name}`}
                    style={{ textAlign: "inherit", font: "inherit", cursor: "pointer", border: "none" }}
                  >
                    <div className="rn">{s.code}</div>
                    <div className="rt">
                      {s.name} · {s.capacity || s.defaultCapacity} pax
                    </div>
                    <div className="rs" style={{ color: st.color }}>
                      <span className="d" style={{ background: st.color }} />
                      {st.label}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <p className="lead" style={{ marginTop: 12, fontSize: 12 }}>
            Spaces themselves are created and renamed in the admin console. What you can do here is take one
            out of service when something is wrong with it, and put it back once fixed.
          </p>
        </>
      )}

      {faultSpace && (
        <div className="scrim" onClick={(e) => e.target === e.currentTarget && setFaultSpace(null)} role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Faults on ${faultSpace.name}`}
            style={{ maxWidth: 640 }}
          >
            <div className="modal-top" style={{ background: "var(--stop-t)", borderBottomColor: "#e2b3ac" }}>
              <div className="modal-ic" style={{ background: "var(--stop)" }}>
                <AlertTriangle />
              </div>
              <div>
                <h3>{faultSpace.name}</h3>
                <p>Report a fault, or review one already raised.</p>
              </div>
            </div>
            <div className="modal-body" style={{ maxHeight: "70vh", overflowY: "auto" }}>
              <DeficiencyPanel
                target={{ spaceId: faultSpace.id }}
                targetLabel={faultSpace.code}
                onChanged={() => void queryClient.invalidateQueries({ queryKey: ["spaces"] })}
              />
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setFaultSpace(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
