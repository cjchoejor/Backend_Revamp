"use client";

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { listRatePackageHistory, type PackageOwner, type RatePackageAdmin } from "@/lib/api/admin";

/**
 * Every version of every rate package this party has ever had.
 *
 * The Versions tab beside this one lists `EntityVersionSnapshot` rows, which cover the party's
 * IDENTITY — name, contacts, notes. Packages are absent from it by design: they are versioned
 * natively, append-only, so saving a package closes the old row and inserts a new one rather
 * than overwriting anything. That means their history was always recorded but had nowhere to be
 * read, which reads to an operator as "the version history doesn't cover rates".
 *
 * Grouped by package NAME because that is the thing with a history — "Premium" going 2,640 ->
 * 2,700 is one story across two rows, whereas listing 137 rows by date tells no story at all.
 */

const RATE_FIELDS: Array<[keyof RatePackageAdmin, string]> = [
  ["roomBaseRate", "Room"],
  ["extraBedRate", "Extra bed"],
  ["breakfastRate", "Breakfast"],
  ["lunchRate", "Lunch"],
  ["dinnerRate", "Dinner"],
  ["cpRate", "CP"],
  ["mapLunchRate", "MAP+L"],
  ["mapDinnerRate", "MAP+D"],
  ["apRate", "AP"],
];

function money(v: unknown, currency: string): string {
  if (v == null || v === "") return "—";
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? `${currency} ${n.toFixed(2)}` : String(v);
}

function day(iso?: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso.slice(0, 10);
  }
}

export function RatePackageHistory({ owner, ownerLabel }: { owner: PackageOwner; ownerLabel?: string }) {
  const { session } = useSession();
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const q = useQuery({
    queryKey: ["admin", "rate-packages", "history", owner],
    queryFn: () => listRatePackageHistory(session!, owner),
    enabled: !!session,
  });

  // Newest first within each name, so the top row of a group is what applies today.
  const groups = useMemo(() => {
    const items = q.data?.items ?? [];
    const byName = new Map<string, RatePackageAdmin[]>();
    for (const p of items) {
      const list = byName.get(p.name) ?? [];
      list.push(p);
      byName.set(p.name, list);
    }
    for (const list of byName.values()) {
      list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    }
    return [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [q.data]);

  if (q.isLoading) return <p className="admin-muted text-xs">Loading package history…</p>;
  if (q.isError) return <p className="admin-muted text-xs">Could not load package history.</p>;
  if (groups.length === 0) {
    return (
      <p className="admin-muted text-xs">
        No rate packages recorded{ownerLabel ? ` for ${ownerLabel}` : ""} yet — so there is no rate history to show.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="admin-muted text-xs">
        Rate history. Saving a package never edits it in place — the previous rates are closed off and kept, so a
        booking can always be re-derived at the rates it was quoted on.
      </p>

      {groups.map(([name, versions]) => {
        const current = versions.find((v) => !v.effectiveTo) ?? null;
        const isOpen = !!open[name];
        return (
          <div key={name} className="admin-panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="admin-display text-sm">{name}</span>
                {current ? (
                  <span className="admin-tag admin-tag-ok ml-2 text-[10px]">active {money(current.roomBaseRate, current.currency)}</span>
                ) : (
                  <span className="admin-tag ml-2 text-[10px]">retired</span>
                )}
                <span className="admin-muted ml-2 text-[11px]">
                  {versions.length} version{versions.length === 1 ? "" : "s"}
                </span>
              </div>
              <button
                type="button"
                className="admin-btn admin-btn-ghost admin-btn-sm"
                onClick={() => setOpen((m) => ({ ...m, [name]: !isOpen }))}
              >
                {isOpen ? "Hide" : "View"}
              </button>
            </div>

            {isOpen && (
              <div className="mt-3 overflow-x-auto">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>In force</th>
                      {RATE_FIELDS.map(([, label]) => (
                        <th key={label}>{label}</th>
                      ))}
                      <th>Overrides</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v, i) => {
                      // The version that came before this one chronologically is the NEXT row down.
                      const prev = versions[i + 1];
                      return (
                        <Fragment key={v.id}>
                          <tr>
                            <td className="whitespace-nowrap text-xs">
                              {day(v.effectiveFrom)}
                              {v.effectiveTo ? ` – ${day(v.effectiveTo)}` : " – now"}
                              {!v.effectiveTo && <span className="admin-tag admin-tag-ok ml-2 text-[10px]">current</span>}
                              {v.isDefault && <span className="admin-muted ml-2 text-[10px]">default</span>}
                            </td>
                            {RATE_FIELDS.map(([field, label]) => {
                              const val = v[field];
                              const changed = prev != null && String(prev[field] ?? "") !== String(val ?? "");
                              return (
                                <td
                                  key={label}
                                  className="whitespace-nowrap font-mono text-xs"
                                  // A changed figure is the only reason to read a history row, so it
                                  // is marked rather than left for the eye to diff.
                                  style={changed ? { fontWeight: 700 } : undefined}
                                  title={changed ? `was ${money(prev?.[field], v.currency)}` : undefined}
                                >
                                  {money(val, v.currency)}
                                  {changed && <span className="admin-muted ml-1 text-[10px]">▲</span>}
                                </td>
                              );
                            })}
                            <td className="text-xs">
                              {(v.overrides?.length ?? 0) === 0 ? (
                                <span className="admin-muted">—</span>
                              ) : (
                                v.overrides!.map((o) => (
                                  <div key={o.id} className="whitespace-nowrap font-mono">
                                    {o.roomTypeId}: {money(o.roomBaseRate, v.currency)}
                                  </div>
                                ))
                              )}
                            </td>
                          </tr>
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
