# policycrosscheck

## Source

- Canon: `DEV-SPEC finalization/DEV-SPEC Part 5/DEV-SPEC-001-Part5.md`
- Codebase: `back_end/src/policies/**` (policy IDs inferred from `pNN-*.ts` filenames)

## Table

| Policy ID | Title (Part 5) | Present in `src/policies` (filename)? | Notes |
|---:|---|:---:|---|
| 1 | Availability Query Policy | YES |  |
| 2 | DEFICIENT Condition Surface Policy | YES | `src/policies/19-deficient-condition/p02-deficient-condition-surface-policy.ts` |
| 3 | Initial Custodian Assignment Policy | YES |  |
| 4 | Custodian Reassignment Policy | YES |  |
| 5 | H1 Handoff Custodian Transfer Policy | YES |  |
| 6 | Inquiry Expiry Policy | YES | `src/policies/05-inquiry-lifecycle/p06-inquiry-expiry.ts` |
| 7 | Quotation Validity Policy | YES |  |
| 8 | Committed Hold Expiry Policy | YES |  |
| 9 | Pre-Arrival Period Policy | YES |  |
| 10 | Checkout Due Policy | YES | `src/policies/01-availability/p10-checkout-due.ts` |
| 11 | Post-Stay Payment Follow-Up Policy | YES | `src/policies/13-billing-model/p11-post-stay-payment-follow-up.ts` |
| 12 | Duplicate Inquiry and Entry Creation Gate Policy | YES |  |
| 13 | Multi-Booking Detection Policy | YES |  |
| 14 | Shadow Inventory Visibility Policy | YES | `src/policies/01-availability/p14-shadow-inventory-visibility.ts` |
| 15 | Guest Identity Capture Policy | YES | `src/policies/06-guest-identity/p15-guest-identity-capture.ts` |
| 16 | Guest Identity Verification Policy | YES |  |
| 17 | Guest Data Capture Governance Policy | YES |  |
| 18 | Guest Data Retention and Deletion Policy | YES | `src/policies/18-guest-data-retention/p18-guest-data-retention.ts` |
| 19 | Rate Plan Resolution Policy | YES |  |
| 20 | Commitment Rate Freeze Policy | YES |  |
| 21 | Mid-Stay Rate Amendment Policy | YES | `src/policies/08-pricing-rate-plan/p21-mid-stay-rate-amendment.ts` |
| 22 | Settlement Rate Policy | YES |  |
| 23 | Discount Approval Policy | YES |  |
| 24 | Mid-Stay Discount Policy | YES | `src/policies/09-discount/p24-mid-stay-discount.ts` |
| 25 | Speculative Hold Placement Policy | YES |  |
| 26 | Committed Hold Placement Policy | YES |  |
| 27 | Advance Payment Collection Policy | YES |  |
| 28 | Advance Payment Reconciliation Policy | YES |  |
| 29 | Advance Payment Balance Verification Policy | YES |  |
| 30 | Billing Model Initial Fix Policy | YES |  |
| 31 | Billing Model Activation Policy | YES |  |
| 32 | Billing Model Mid-Stay Transition Policy | YES | `src/policies/13-billing-model/p32-billing-model-mid-stay-transition.ts` |
| 33 | Billing Model Settlement Policy | YES |  |
| 34 | Cancellation Terms Disclosure Policy | YES |  |
| 35 | Cancellation Enforcement Policy | YES |  |
| 36 | Early Departure Policy | YES | `src/policies/03-expiry-parking/p36-early-departure.ts` |
| 37 | FOC Entitlement Calculation Policy | YES |  |
| 38 | FOC Validation Policy | YES |  |
| 39 | FOC Verification Policy | YES |  |
| 40 | Confirmation Authority Policy | YES |  |
| 41 | Overbooking Detection and Trigger Typing Policy | YES |  |
| 42 | Credit Ceiling Mandatory Set Policy | YES |  |
| 43 | Credit Ceiling Commitment Snapshot Carry Policy | YES | `src/policies/18-credit-extension-ceiling/p43-credit-ceiling-commitment-snapshot-carry.ts` |
| 44 | Credit Ceiling Proximity Check Policy | YES |  |
| 45 | Credit Ceiling Active Monitoring Policy | YES |  |
| 46 | Credit Ceiling Final Balance Policy | YES |  |
| 47 | DEFICIENT Surface in Search Policy (Cross-Group Reference) | YES | `src/policies/19-deficient-condition/p47-deficient-surface-in-search-crossref.ts` (cross-ref; satisfied by Policy 2) |
| 48 | DEFICIENT Room Assignment Decision Policy | YES |  |
| 49 | DEFICIENT Carry Policy | YES |  |
| 50 | DEFICIENT Resolution Tracking Policy | YES | `src/policies/19-deficient-condition/p50-deficient-resolution-tracking.ts` |
| 51 | DEFICIENT Inspection Review Policy | YES |  |
| 52 | Communication Acknowledgement Tracking Policy | YES |  |
| 53 | Active Dispute Management Policy | YES | `src/policies/21-service-recovery-dispute/p53-active-dispute-management.ts` |
| 54 | Dispute Gate Stage Progression Policy | YES |  |
| 55 | Dispute Closure Policy | YES | `src/policies/21-service-recovery-dispute/p55-dispute-closure.ts` |
| 56 | No-Show Detection and Determination Policy | YES |  |
| 57 | No-Show Folio Financial Policy | YES | `src/policies/22-no-show/p57-no-show-folio-financial.ts` |
| 58 | Room Change Mode Trigger Policy | YES | `src/policies/01-availability/p58-room-change-mode-trigger.ts` |
| 59 | Night Audit Countdown Policy | YES | `src/policies/24-night-audit/p59-night-audit-countdown.ts` |
| 60 | Night Audit Charge Posting and Completeness Policy | YES |  |
| 61 | Night Audit Overdue Detection Policy | YES |  |
| 62 | Night Audit Stale Record Detection Policy | YES |  |
| 63 | Handoff Lifecycle Policy | YES |  |
| 64 | Group Detection Policy | YES |  |
| 65 | Group Rate Application Policy | YES |  |
| 66 | Group FOC and Billing Split Policy | YES | `src/policies/13-billing-model/p66-group-foc-and-billing-split.ts` |
| 67 | Work Order Lifecycle Policy | YES |  |
| 68 | Commission-Due Record Creation Policy | YES | `src/policies/13-billing-model/p68-commission-due-record-creation.ts` |
| 69 | Session Management and PIN Authentication Policy | YES | `src/policies/01-availability/p69-session-management-and-pin-authentication.ts` |
| 70 | Feedback Solicitation Policy | YES | `src/policies/17-communications/p70-feedback-solicitation.ts` |
| 71 | Processing Lock TTL Policy | YES |  |
| 72 | Processing Lock Priority Queue Policy | YES |  |
| 73 | AI Trust Level Policy | YES | `src/policies/19-ai-governance/p73-ai-trust-level.ts` (placeholder) |
| 74 | AI Authority Boundary Policy | YES | `src/policies/19-ai-governance/p74-ai-authority-boundary.ts` (placeholder) |
| 75 | AI Escalation Policy | YES | `src/policies/19-ai-governance/p75-ai-escalation.ts` (placeholder) |
| 76 | Voice Note Routing Policy | YES | `src/policies/20-voice-notes/p76-voice-note-routing.ts` (placeholder) |
| 77 | Voice Note Review SLA Policy | YES | `src/policies/20-voice-notes/p77-voice-note-review-sla.ts` (placeholder) |

