"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getInquiry } from "@/lib/api/inquiries";
import { listEntries } from "@/lib/api/entries";
import { useSession } from "@/hooks/use-session";
import { stagePath } from "@/config/stages";
import { StatusBadge } from "@/components/ui/status-badge";
import { entryListGuestName, formatGuestName } from "@/lib/guest-display-name";
import { deriveInquiryStatus } from "@/lib/inquiry-status";

export default function InquiryDetailPage() {
  const { inquiryId } = useParams<{ inquiryId: string }>();
  const { session } = useSession();

  const inquiryQuery = useQuery({
    queryKey: ["inquiry", inquiryId],
    queryFn: () => getInquiry(session!, inquiryId),
    enabled: !!session,
  });

  const entriesQuery = useQuery({
    queryKey: ["entries", { inquiryId }],
    queryFn: () => listEntries(session!, { inquiryId, limit: 20 }),
    enabled: !!session,
  });

  if (inquiryQuery.isLoading) return <Skeleton className="h-48 w-full" />;

  const inquiry = inquiryQuery.data;
  if (!inquiry) return <p className="text-destructive">Inquiry not found</p>;

  const entries = entriesQuery.data?.items ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Inquiry</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="font-mono text-xs">{inquiry.id}</p>
          <p>Channel: {inquiry.sourceChannel}</p>
          <p className="flex items-center gap-2">
            Status: <StatusBadge status={deriveInquiryStatus(inquiry)} />
          </p>
          <p>Guest: {formatGuestName(inquiry.guestProfile)}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Linked entries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No entries yet</p>
          ) : (
            entries.map((e) => (
              <Button key={e.id} variant="outline" className="w-full justify-between" asChild>
                <Link href={stagePath(e.id, e.currentStage)}>
                  <span className="font-medium">{entryListGuestName(e)}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {e.id.slice(0, 12)}… · {e.currentStage}
                  </span>
                </Link>
              </Button>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
