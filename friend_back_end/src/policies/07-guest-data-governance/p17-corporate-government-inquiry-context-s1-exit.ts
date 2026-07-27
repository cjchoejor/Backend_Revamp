import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 17 — Guest / inquiry commercial context (SIG-S1 slice).
 * Corporate or Government source channels require coordinator and client reference on the inquiry.
 */
export function enforceCorporateOrGovernmentInquiryContextForS1Exit(input: {
  sourceChannel: string | null | undefined;
  corporateClientRef: string | null | undefined;
  corporateCoordinator: string | null | undefined;
}) {
  const source = String(input.sourceChannel ?? "").toUpperCase();
  if (source !== "CORPORATE" && source !== "GOVERNMENT") return;
  if (!String(input.corporateClientRef ?? "").trim()) {
    throw new StageGateBlockedError("Corporate/Government client reference required", "MISSING_CORP_CLIENT_REF");
  }
  if (!String(input.corporateCoordinator ?? "").trim()) {
    throw new StageGateBlockedError("Corporate/Government coordinator required", "MISSING_CORP_COORDINATOR");
  }
}
