"use client";

import { Help } from "@/components/ds/help";
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
    return new Date(iso).toLocaleDateString("en-GB");
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

  // One group per package: the versions that replaced one another (`supersededById`, 2026-11-24),
  // so a renamed package stays one story.
  // Newest first within each, so the top row of a group is what applies today.
  const groups = useMemo(() => {
    const items = q.data?.items ?? [];
    const byId = new Map(items.map((p) => [p.id, p]));
    const newestOf = (p: RatePackageAdmin): RatePackageAdmin => {
      let at = p;
      for (let i = 0; i < 200 && at.supersededById && byId.has(at.supersededById); i++) at = byId.get(at.supersededById)!;
      return at;
    };
    const byKey = new Map<string, RatePackageAdmin[]>();
    for (const p of items) {
      // Under the name its newest version carries: a renamed package moves whole, and a version
      // retired and made again by hand (no link) still sits with its name, as before.
      const key = newestOf(p).name;
      const list = byKey.get(key) ?? [];
      list.push(p);
      byKey.set(key, list);
    }
    for (const list of byKey.values()) list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    return [...byKey.entries()]
      .map(([key, list]) => [key, list, key] as const)
      .sort((a, b) => a[2].localeCompare(b[2]));
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
      <p className="admin-eyebrow flex w-fit items-center gap-2">
        Rate history
        <Help label="Rate history">
          Saving a package never edits it in place. The previous rates are closed off and kept, so a booking can always be worked out again at the rates
          it was quoted on.
        </Help>
      </p>

      {groups.map(([key, versions, name]) => {
        const current = versions.find((v) => !v.effectiveTo) ?? null;
        const isOpen = !!open[key];
        const formerNames = [...new Set(versions.map((v) => v.name))].filter((n) => n !== name);
        return (
          <div key={key} className="admin-panel p-4">
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
                  {formerNames.length ? ` · earlier called ${formerNames.map((n) => `"${n}"`).join(", ")}` : ""}
                </span>
              </div>
              <button
                type="button"
                className="admin-btn admin-btn-ghost admin-btn-sm"
                onClick={() => setOpen((m) => ({ ...m, [key]: !isOpen }))}
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
