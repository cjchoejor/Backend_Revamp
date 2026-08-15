-- Final-invoice guest answer loop (2026-08-17, operator request): the FINAL invoice dispatch
-- now opens the same W22 acknowledgement window as the proforma, so the guest's response —
-- especially the "I'll pay by X" on an OUTSTANDING balance — is recorded evidence.
ALTER TYPE "CommunicationType" ADD VALUE 'FINAL_INVOICE';
