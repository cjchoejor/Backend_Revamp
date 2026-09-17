import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type HandoffChecklistItem = {
  code: string;
  mandatory: boolean;
  description?: string;
};

export async function getHandoffChecklist(session: Session, handoffType: string) {
  return apiRequest<{ handoffType: string; items: HandoffChecklistItem[] }>(
    `/api/handoffs/checklists/${encodeURIComponent(handoffType)}`,
    { session },
  );
}
