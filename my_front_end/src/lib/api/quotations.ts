import type { QuotationSummary, SpeculativeHoldSummary } from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export async function createQuotation(
  session: Session,
  entryId: string,
  body?: {
    notes?: string;
    requestedDiscount?: { discountPercent: number; discountBasis: string } | null;
    currency?: string;
    focRoomsRequested?: number;
    belowMsrGmWaiver?: { acknowledged: true; rationale: string };
  },
) {
  return apiRequest<QuotationSummary>(`/api/entries/${entryId}/quotations`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}

export async function supersedeQuotation(
  session: Session,
  quotationId: string,
  body?: { notes?: string; requestedDiscount?: { discountPercent: number; discountBasis: string } | null },
) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/supersede`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}

export async function applyQuotationDiscount(
  session: Session,
  quotationId: string,
  body: { discountPercent: number; discountBasis: string; belowMsrGmWaiver?: { acknowledged: true; rationale: string } },
) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/discount`, {
    method: "POST",
    session,
    body,
  });
}

export async function approveQuotationDiscount(session: Session, quotationId: string) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/discount/approve`, {
    method: "POST",
    session,
    body: {},
  });
}

export async function sendQuotation(
  session: Session,
  quotationId: string,
  body: {
    validDays?: number;
    sentTo?: string;
    channel?: string;
    recipientAddress?: string;
  },
) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/send`, {
    method: "POST",
    session,
    body,
  });
}

export async function acceptQuotation(
  session: Session,
  quotationId: string,
  body: { acceptanceMethod?: "WRITTEN" | "VERBAL"; verbatimNote?: string },
) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/accept`, {
    method: "POST",
    session,
    body,
  });
}

export async function resolveQuotationAckOpenLoop(
  session: Session,
  quotationId: string,
  body: {
    resolutionType?: "VERBAL_ACCEPTED" | "WRITTEN_ACCEPTED" | "CUSTODIAN_DECISION";
    note?: string;
    decisionReason?: string;
  },
) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/ack-open-loop/resolve`, {
    method: "POST",
    session,
    body,
  });
}

export async function autoFulfilS2ToS3(session: Session, entryId: string, version: number) {
  return apiRequest<{ id: string; currentStage: string; version: number }>(
    `/api/entries/${entryId}/s2/auto-fulfil-to-s3`,
    { method: "POST", session, body: { version } },
  );
}

export async function placeSpeculativeHold(
  session: Session,
  entryId: string,
  body: {
    roomId?: string;
    spaceId?: string;
    ttlSeconds?: number;
    commercialBasis: string;
    notes?: string;
  },
) {
  return apiRequest<SpeculativeHoldSummary>(`/api/entries/${entryId}/holds/speculative`, {
    method: "POST",
    session,
    body,
  });
}

export async function releaseSpeculativeHold(
  session: Session,
  entryId: string,
  holdId: string,
  body: { releaseReason: string },
) {
  return apiRequest<SpeculativeHoldSummary>(
    `/api/entries/${entryId}/holds/speculative/${holdId}/release`,
    { method: "POST", session, body },
  );
}
