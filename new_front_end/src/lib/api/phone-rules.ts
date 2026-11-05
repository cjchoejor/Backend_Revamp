import type { Session } from "@/types/session";
import type { PhoneRules } from "@/lib/ds/phone";
import { apiRequest } from "./client";

/** The country codes, how many digits each number has, and the titles offered (2026-11-05). */
export async function getPhoneRules(session: Session) {
  return apiRequest<PhoneRules>("/api/lookups/phone-rules", { session });
}
