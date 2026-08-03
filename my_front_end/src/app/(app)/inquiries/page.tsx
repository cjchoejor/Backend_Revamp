"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/ui/status-badge";
import { listInquiries } from "@/lib/api/inquiries";
import { formatGuestName, guestNameSearchText } from "@/lib/guest-display-name";
import { deriveInquiryStatus } from "@/lib/inquiry-status";
import { formatListId } from "@/lib/readable-id";
import { useSession } from "@/hooks/use-session";

export default function InquiriesPage() {
  const { session } = useSession();
  const [search, setSearch] = useState("");
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["inquiries"],
    queryFn: () => listInquiries(session!, 100),
    enabled: !!session,
  });

  const items = useMemo(() => {
    const list = data?.items ?? [];
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (inq) =>
        inq.id.toLowerCase().includes(q) ||
        guestNameSearchText(inq.guestProfile).includes(q) ||
        formatGuestName(inq.guestProfile).toLowerCase().includes(q) ||
        inq.sourceChannel.toLowerCase().includes(q) ||
        deriveInquiryStatus(inq).toLowerCase().includes(q),
    );
  }, [data?.items, search]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-semibold">Inquiries</h2>
          <p className="text-sm text-muted-foreground">
            S1 intake — guest inquiries before entry creation.{" "}
            <span className="text-amber-800/80 dark:text-amber-400">Open</span> = no entry yet;{" "}
            <span className="text-emerald-800/80 dark:text-emerald-400">Active</span> = at least one
            entry in progress.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search by guest, id, channel…"
            className="max-w-xs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        <Button variant="gradient" asChild>
          <Link href="/inquiries/new">
            <Plus className="mr-2 h-4 w-4" />
            New inquiry
          </Link>
        </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{items.length} inquiries</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : isError ? (
            <p className="py-8 text-center text-sm text-destructive">
              Could not load inquiries{(error as Error)?.message ? `: ${(error as Error).message}` : ""}
            </p>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No inquiries found</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Guest</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">View</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((inq) => (
                  <TableRow key={inq.id}>
                    <TableCell className="font-medium">{formatGuestName(inq.guestProfile)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{formatListId(inq.id)}</TableCell>
                    <TableCell>{inq.sourceChannel}</TableCell>
                    <TableCell>
                      <StatusBadge status={deriveInquiryStatus(inq)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/inquiries/${inq.id}`}>Open</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
