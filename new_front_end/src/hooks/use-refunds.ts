"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { listRefunds } from "@/lib/api/refunds";

const FOM_UP = new Set(["L2", "L3", "L4"]);

/** The refunds list. The route carries bank details, so only the FOM, GM and admin ever ask for it. */
export function useRefunds(view: "waiting" | "done") {
  const { session } = useSession();
  const allowed = !!session && FOM_UP.has(session.actorLevel);
  return useQuery({
    queryKey: ["refunds", view],
    queryFn: () => listRefunds(session!, view),
    enabled: allowed,
    staleTime: 20_000,
    refetchInterval: view === "waiting" ? 60_000 : false,
  });
}
