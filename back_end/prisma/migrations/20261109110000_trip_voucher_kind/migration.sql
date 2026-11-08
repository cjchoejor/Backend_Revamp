-- A trip has a confirmation voucher of its own too (2026-11-09), beside its quotation and proforma.
ALTER TABLE "trip_papers" DROP CONSTRAINT "trip_papers_kind_check";
ALTER TABLE "trip_papers" ADD CONSTRAINT "trip_papers_kind_check" CHECK ("kind" IN ('QUOTATION', 'PROFORMA', 'VOUCHER'));
