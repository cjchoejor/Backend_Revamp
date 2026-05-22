"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listInquiries } from "@/lib/api/inquiries";
import { useSession } from "@/hooks/use-session";

export default function InquiriesPage() {
  const { session } = useSession();
  const { data, isLoading } = useQuery({
    queryKey: ["inquiries"],
    queryFn: () => listInquiries(session!, 100),
    enabled: !!session,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-2xl font-semibold">Inquiries</h2>
          <p className="text-sm text-muted-foreground">S1 intake — guest inquiries before entry creation</p>
        </div>
        <Button variant="gradient" asChild>
          <Link href="/inquiries/new">
            <Plus className="mr-2 h-4 w-4" />
            New inquiry
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{data?.count ?? 0} inquiries</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Guest</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">View</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.items ?? []).map((inq) => (
                  <TableRow key={inq.id}>
                    <TableCell className="font-mono text-xs">{inq.id.slice(0, 16)}</TableCell>
                    <TableCell>{inq.guestProfile?.displayName ?? inq.guestProfileId}</TableCell>
                    <TableCell>{inq.sourceChannel}</TableCell>
                    <TableCell>{inq.status}</TableCell>
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
