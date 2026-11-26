"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getApprovals, type ApprovalAct, type ApprovalRule } from "@/lib/api/approvals";

/** Who may approve what, for the person signed in (2026-11-26). Read again every minute and on focus. */
export function useApprovals() {
  const { session } = useSession();
  return useQuery({
    queryKey: ["approvals", session?.actorLevel ?? null],
    queryFn: () => getApprovals(session!),
    enabled: !!session,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * May the person signed in do this act themselves? While the answer is on its way, the rule as built
 * (`fallback`) stands — the server decides either way.
 */
export function useMayApprove(act: ApprovalAct, fallback: boolean): { may: boolean; words: string; loaded: boolean } {
  const q = useApprovals();
  const rule: ApprovalRule | undefined = q.data?.acts[act];
  return { may: rule ? rule.may : fallback, words: rule?.words ?? "the FOM, the GM or an admin", loaded: !!rule };
}

/** Anything at all this person may approve — the bell's quick check runs for them. */
export function useMayApproveAnything(fallback: boolean): boolean {
  const q = useApprovals();
  if (!q.data) return fallback;
  return Object.values(q.data.acts).some((r) => r.may);
}
