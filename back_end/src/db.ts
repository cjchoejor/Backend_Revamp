import { Prisma, PrismaClient } from "@prisma/client";
import {
  enforceFolioCannotRevertLiveToProvisional,
  enforceFolioSettledOutstandingGuard,
  enforceOtaOverbookingTriggerTypeUnchanged,
  enforceRoomAssignmentRoomIdUnchangedIfProvided,
  enforceRoomOccupiedToDepartedCleanPath,
  throwDisputeGateOverrideMutationForbidden,
  throwFolioLineMutationForbidden,
  throwFolioLiveCreateForbidden,
  throwNightAuditRecordMutationForbidden,
  throwReservationMutationForbidden,
  throwRoomAssignmentUpdateManyForbidden,
  throwOtaOverbookingTriggerUpdateManyForbidden,
  throwVipArrivalNotificationMutationForbidden,
} from "./policies/01-availability/p01-prisma-extension-blocking-guards.js";

const _base = new PrismaClient();

// SIG-S6/S7: Guard irreversible / immutable records at Prisma layer (delegates to `policies/**`).
const _ext = _base.$extends({
  name: "s6FolioVipGuards",
  query: {
    reservation: {
      async update({ args, query }) {
        // Narrow carve-out (2026-08-07): the confirmation-voucher RENDER METADATA may be
        // written onto an otherwise-immutable Reservation. These six fields are artifact
        // bookkeeping (where the write-once PDF lives, its checksum, who rendered it) — not
        // commercial terms; the frozen deal stays untouchable. Without this the voucher never
        // generated at all: `generateOrLoadConfirmationVoucherPdf` rendered the PDF, then its
        // reservation.update threw RESERVATION_IMMUTABLE and the whole call failed (traced as
        // RESERVATION.CONFIRMATION_VOUCHER_PDF_RENDER_FAILED on every confirm since the
        // per-segment immutability guard landed). Mirrors the invoice pattern, where p68
        // allows dispatch metadata on a rendered invoice while the money fields stay frozen.
        const VOUCHER_RENDER_FIELDS = new Set([
          "confirmationVoucherStorageKey",
          "confirmationVoucherChecksum",
          "confirmationVoucherChecksumAlgo",
          "confirmationVoucherRenderedAt",
          "confirmationVoucherRenderedBy",
          "confirmationVoucherInputSnapshot",
        ]);
        const keys = Object.keys((args.data ?? {}) as Record<string, unknown>);
        if (keys.length > 0 && keys.every((k) => VOUCHER_RENDER_FIELDS.has(k))) {
          return query(args);
        }
        throwReservationMutationForbidden();
      },
      async updateMany() {
        throwReservationMutationForbidden();
      },
      // upsert's update branch would silently overwrite an immutable Reservation — forbid it too so
      // re-confirmation must mint a new per-segment row (SIG-S4 §197 / AC-S4-024). Creation uses
      // reservation.create, which stays allowed.
      async upsert() {
        throwReservationMutationForbidden();
      },
      async delete() {
        throwReservationMutationForbidden();
      },
      async deleteMany() {
        throwReservationMutationForbidden();
      },
    },
    otaConflictOverbookingRecord: {
      async update({ args, query }) {
        const data = args.data as { triggerType?: string } | undefined;
        await enforceOtaOverbookingTriggerTypeUnchanged(_base, args.where, data);
        return query(args);
      },
      async updateMany() {
        throwOtaOverbookingTriggerUpdateManyForbidden();
      },
    },
    folio: {
      async create({ args, query }) {
        const d = args.data as { state?: string } | Prisma.FolioCreateInput;
        if ((d as { state?: string })?.state === "LIVE") {
          throwFolioLiveCreateForbidden();
        }
        return query(args);
      },
      async update({ args, query }) {
        const data = args.data as { state?: string } | undefined;
        await enforceFolioSettledOutstandingGuard(_base, args.where, data);
        await enforceFolioCannotRevertLiveToProvisional(_base, args.where, data);
        return query(args);
      },
    },
    vIPArrivalNotificationEvent: {
      async update() {
        throwVipArrivalNotificationMutationForbidden();
      },
      async updateMany() {
        throwVipArrivalNotificationMutationForbidden();
      },
    },
    folioLine: {
      async update() {
        throwFolioLineMutationForbidden();
      },
      async updateMany() {
        throwFolioLineMutationForbidden();
      },
      async delete() {
        throwFolioLineMutationForbidden();
      },
      async deleteMany() {
        throwFolioLineMutationForbidden();
      },
    },
    nightAuditRecord: {
      async update() {
        throwNightAuditRecordMutationForbidden();
      },
      async updateMany() {
        throwNightAuditRecordMutationForbidden();
      },
      async delete() {
        throwNightAuditRecordMutationForbidden();
      },
      async deleteMany() {
        throwNightAuditRecordMutationForbidden();
      },
    },
    disputeGateOverrideRecord: {
      async update() {
        throwDisputeGateOverrideMutationForbidden();
      },
      async updateMany() {
        throwDisputeGateOverrideMutationForbidden();
      },
    },
    roomAssignment: {
      async update({ args, query }) {
        await enforceRoomAssignmentRoomIdUnchangedIfProvided(_base, args.where, args.data as { roomId?: string } | undefined);
        return query(args);
      },
      async updateMany() {
        throwRoomAssignmentUpdateManyForbidden();
      },
    },
    room: {
      async update({ args, query }) {
        await enforceRoomOccupiedToDepartedCleanPath(_base, args.where, args.data as { currentClaimState?: string } | undefined);
        return query(args);
      },
    },
  },
});

export const prisma = _ext as unknown as PrismaClient;
