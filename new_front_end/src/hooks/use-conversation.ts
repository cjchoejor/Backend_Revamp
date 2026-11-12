"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getConversation, listUnseenReplies } from "@/lib/api/inbox";

/** A booking's email conversation (its enquiry's), read again every minute (2026-11-12). */
export function useConversation(entryId: string | null | undefined) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["conversation", entryId],
    queryFn: () => getConversation(session!, entryId!),
    enabled: !!session && !!entryId,
    staleTime: 20_000,
    refetchInterval: 60_000,
  });
}

/** Guests' replies nobody has looked at yet — for the bell. */
export function useUnseenReplies() {
  const { session } = useSession();
  return useQuery({
    queryKey: ["unseen-replies"],
    queryFn: () => listUnseenReplies(session!),
    enabled: !!session,
    staleTime: 20_000,
    refetchInterval: 60_000,
  });
}
