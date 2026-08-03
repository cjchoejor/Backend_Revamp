"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Plus, List } from "lucide-react";
import { StageSummaryRow } from "@/components/dashboard/stage-summary-row";
import { WorkQueueTable } from "@/components/dashboard/work-queue-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listEntries } from "@/lib/api/entries";
import { listInquiries } from "@/lib/api/inquiries";
import { useSession } from "@/hooks/use-session";

export default function DashboardPage() {
  const { session, isLoading: sessionLoading } = useSession();

  const entriesQuery = useQuery({
    queryKey: ["entries", { limit: 200 }],
    queryFn: () => listEntries(session!, { limit: 200 }),
    enabled: !!session && !sessionLoading,
  });

  const inquiriesQuery = useQuery({
    queryKey: ["inquiries", { limit: 50 }],
    queryFn: () => listInquiries(session!, 50),
    enabled: !!session && !sessionLoading,
  });

  const isLoading =
    sessionLoading || entriesQuery.isLoading || inquiriesQuery.isLoading;
  const entries = entriesQuery.data?.items ?? [];
  const inquiries = inquiriesQuery.data?.items ?? [];

  return (
    <div className="mx-auto max-w-7xl space-y-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-wide">Operations overview</h2>
            <p className="text-sm text-muted-foreground">Stage pipeline and active work queue</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/inquiries">
                <Plus className="mr-2 h-4 w-4" />
                Inquiries
              </Link>
            </Button>
            <Button variant="gradient" asChild>
              <Link href="/entries">
                <List className="mr-2 h-4 w-4" />
                All entries
              </Link>
            </Button>
          </div>
        </div>

        <section>
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Stage summary</h3>
          {isLoading ? (
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {Array.from({ length: 9 }).map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : (
            <StageSummaryRow entries={entries} />
          )}
        </section>

        {isLoading ? <Skeleton className="h-80 w-full" /> : <WorkQueueTable entries={entries} inquiries={inquiries} />}
      </div>
  );
}
