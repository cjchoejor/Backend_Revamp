import { z } from "zod";

/**
 * `POST /api/communications/:id/acknowledge` — record that the guest acknowledged / accepted a
 * governed outbound communication (proforma invoice, confirmation voucher, pre-arrival reminder).
 *
 * Shape mirrors the S2 quotation acceptance body (`acceptQuotationRequestSchema`) so the two read
 * the same at the call site: a method, and — for a verbal response — the operator's verbatim note
 * of what the guest actually said. The VERBAL-requires-note rule is enforced in the policy layer
 * (`enforceAcknowledgementEvidence`) rather than here, so every caller gets it, not just HTTP.
 */
export const acknowledgeCommunicationRequestSchema = z.object({
  method: z.enum(["WRITTEN", "VERBAL"]),
  verbatimNote: z.string().max(1000).optional(),
  /** ISO timestamp — when the guest actually responded, if recorded after the fact. */
  receivedAt: z.string().datetime().optional(),
});

export type AcknowledgeCommunicationRequestDto = z.infer<typeof acknowledgeCommunicationRequestSchema>;
