"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { adminDomains } from "@/config/admin-nav";
import { getAdminOverview } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

export default function AdminOverviewPage() {
  const { session } = useSession();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => getAdminOverview(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  return (
    <div className="space-y-10 pb-16">
      <section>
        <p className="admin-eyebrow mb-4">Admin Console · Implementation reference</p>
        <h1 className="admin-display text-4xl leading-tight md:text-5xl">
          The Admin Console <em className="text-primary not-italic">configures.</em>
          <br />
          It does not <em className="text-primary not-italic">operate.</em>
        </h1>
        <p className="admin-muted mt-4 max-w-2xl text-lg">
          Configuration authority for LEGPHEL PMS — parameters the nine operational stages read at runtime. L4 writes
          only; stages never write configuration back.
        </p>
      </section>

      <dl className="admin-stat grid grid-cols-2 md:grid-cols-4">
        <div>
          <dt>Domains</dt>
          <dd>{isLoading ? "—" : data?.domains ?? 9}</dd>
        </div>
        <div>
          <dt>Services</dt>
          <dd>{isLoading ? "—" : data?.services ?? 26}</dd>
        </div>
        <div>
          <dt>Config keys</dt>
          <dd>{isLoading ? "—" : data?.configKeys ?? "—"}</dd>
        </div>
        <div>
          <dt>Readiness</dt>
          <dd className="text-xl">
            {isLoading ? "—" : data?.readiness.ready ? (
              <span className="text-success">OK</span>
            ) : (
              <span className="text-destructive">Gaps</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="admin-callout">
        Writes go to configuration tables only. Operational records (entries, folios, handoffs) are never created
        from this surface.
      </div>

      <section>
        <p className="admin-eyebrow mb-3">Configuration domains</p>
        <h2 className="admin-display mb-6 text-2xl">26 services across 9 domains</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {adminDomains.map((d) => (
            <div key={d.num} className="admin-panel p-5">
              <p className="admin-eyebrow mb-2">Domain {d.num}</p>
              <h3 className="admin-display text-lg">{d.name}</h3>
              <div className="mt-3 flex flex-wrap gap-1">
                {d.services.map((s) => (
                  <span key={s} className="admin-tag">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="admin-muted mt-4 text-sm">
          Full catalogue in ACIG v1.1 — this slice implements configuration, staff, inventory read, and readiness.
        </p>
      </section>

      <section className="flex flex-wrap gap-3">
        <Link href="/admin/configuration" className="admin-btn">
          Open configuration
        </Link>
        <Link href="/admin/readiness" className="admin-btn">
          Run readiness
        </Link>
        <Link href="/admin/staff" className="admin-btn">
          Staff registry
        </Link>
      </section>
    </div>
  );
}
