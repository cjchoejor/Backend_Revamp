-- Guest-details capture as an Arrival checklist item (2026-08-12, operator request).
-- New PreArrivalTaskType value; auto-completed by the identity-proof service when the
-- guest-detail coverage is satisfied (or the booking is VIP-exempt).
ALTER TYPE "PreArrivalTaskType" ADD VALUE 'GUEST_DETAILS_CAPTURED';
