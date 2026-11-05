"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getPhoneRules } from "@/lib/api/phone-rules";
import { START_RULES, type PhoneRules } from "@/lib/ds/phone";

/** The backend's phone table; it does not change while the desk runs, so it is read once. */
export function usePhoneRules(): PhoneRules {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["lookup", "phone-rules"],
    queryFn: () => getPhoneRules(session!),
    enabled: !!session,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return q.data ?? START_RULES;
}
