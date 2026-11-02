"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Help } from "@/components/ds/help";
import { adminNavGroups, utilityNavItems } from "@/config/admin-nav";
import { getAdminOverview } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

export default function AdminOverviewPage() {
  const { session } = useSession();
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => getAdminOverview(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const ready = data?.readiness.ready;

  return (
    <div className="set-page">
      <header className="set-head">
        <div className="title">
          <h1>Admin console</h1>
          <Help label="Admin console">
            Here you set how the hotel runs: rooms, rates, time limits, rules and messages. The desk reads these settings as it works. Nothing here creates or changes a booking.
          </Help>
        </div>
      </header>

      <div className={`home-ready${isLoading ? "" : ready ? " ok" : " gaps"}`}>
        <b>{isLoading ? "Checking…" : ready ? "Everything the desk needs is set" : "Some things the desk needs are missing"}</b>
        <Link href="/admin/readiness">See the readiness check</Link>
      </div>

      <div className="home-grid">
        {adminNavGroups.map((g) => {
          const GroupIcon = g.icon;
          return (
            <section key={g.domainNumber} className="home-card">
              <h2>
                <GroupIcon />
                {g.title}
              </h2>
              <ul>
                {g.items.map((i) => (
                  <li key={i.href}>
                    <Link href={i.href} title={i.description}>
                      {i.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <section className="home-card">
          <h2>Tools</h2>
          <ul>
            {utilityNavItems.map((i) => (
              <li key={i.href}>
                <Link href={i.href} title={i.description}>
                  {i.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
