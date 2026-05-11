import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 16 — Guest Identity Verification
 * SIG-S6: document type must be accepted per `identity.documentTypes` config surface.
 */
export function enforceAcceptedIdentityDocumentType(input: {
  documentType: string;
  acceptedDocumentTypeCodes: Set<string>;
}) {
  if (input.acceptedDocumentTypeCodes.size === 0) return; // allowlist not configured → treat as permissive in this slice
  if (input.acceptedDocumentTypeCodes.has(input.documentType)) return;
  throw new PolicyGateBlockedError("DOCUMENT_TYPE_NOT_ACCEPTED", `Document type not accepted: ${input.documentType}`);
}

