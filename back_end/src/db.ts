import { Prisma, PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError, StateTransitionError } from "./lib/errors.js";

const _base = new PrismaClient();

// SIG-S6/S7: Guard irreversible / immutable records at Prisma layer.
const _ext = _base.$extends({
  name: "s6FolioVipGuards",
  query: {
    folio: {
      async create({ args, query }) {
        const d = args.data as { state?: string } | Prisma.FolioCreateInput;
        if ((d as { state?: string })?.state === "LIVE") {
          throw new PolicyGateBlockedError("FOLIO_LIVE_CREATE_FORBIDDEN", "LIVE folios must be created via FolioService.convertToLive()");
        }
        return query(args);
      },
      async update({ args, query }) {
        const data = args.data as { state?: string } | undefined;
        if (data?.state === "SETTLED") {
          const cur = await _base.folio.findFirst({ where: args.where as any });
          const nextOutRaw =
            (data as any)?.outstandingBalance !== undefined && (data as any)?.outstandingBalance !== null
              ? (data as any).outstandingBalance
              : cur?.outstandingBalance;
          const out = nextOutRaw != null ? Number(nextOutRaw.toString()) : 0;
          if (out > 0) {
            throw new StateTransitionError("Cannot set SETTLED while outstanding balance remains", "SETTLED_WITH_BALANCE_FORBIDDEN");
          }
        }
        if (data?.state === "PROVISIONAL") {
          const cur = await _base.folio.findFirst({ where: args.where as any });
          if (cur?.state === "LIVE") {
            throw new StateTransitionError("LIVE folio cannot revert to PROVISIONAL", "FOLIO_REVERSION_FORBIDDEN");
          }
        }
        return query(args);
      },
    },
    vIPArrivalNotificationEvent: {
      async update({ query }) {
        throw new PolicyGateBlockedError("VIP_NOTIFICATION_IMMUTABLE", "VIPArrivalNotificationEvent is immutable after creation");
      },
      async updateMany({ query }) {
        throw new PolicyGateBlockedError("VIP_NOTIFICATION_IMMUTABLE", "VIPArrivalNotificationEvent is immutable after creation");
      },
    },
    folioLine: {
      async update() {
        throw new StateTransitionError("FolioLine is immutable after posting", "FOLIO_LINE_IMMUTABLE");
      },
      async updateMany() {
        throw new StateTransitionError("FolioLine is immutable after posting", "FOLIO_LINE_IMMUTABLE");
      },
      async delete() {
        throw new StateTransitionError("FolioLine is immutable after posting", "FOLIO_LINE_IMMUTABLE");
      },
      async deleteMany() {
        throw new StateTransitionError("FolioLine is immutable after posting", "FOLIO_LINE_IMMUTABLE");
      },
    },
    nightAuditRecord: {
      async update() {
        throw new PolicyGateBlockedError("NIGHT_AUDIT_IMMUTABLE", "NightAuditRecord is immutable after creation");
      },
      async updateMany() {
        throw new PolicyGateBlockedError("NIGHT_AUDIT_IMMUTABLE", "NightAuditRecord is immutable after creation");
      },
      async delete() {
        throw new PolicyGateBlockedError("NIGHT_AUDIT_IMMUTABLE", "NightAuditRecord is immutable after creation");
      },
      async deleteMany() {
        throw new PolicyGateBlockedError("NIGHT_AUDIT_IMMUTABLE", "NightAuditRecord is immutable after creation");
      },
    },
    disputeGateOverrideRecord: {
      async update() {
        throw new PolicyGateBlockedError("DISPUTE_OVERRIDE_IMMUTABLE", "DisputeGateOverrideRecord is immutable after creation");
      },
      async updateMany() {
        throw new PolicyGateBlockedError("DISPUTE_OVERRIDE_IMMUTABLE", "DisputeGateOverrideRecord is immutable after creation");
      },
    },
    roomAssignment: {
      async update({ args, query }) {
        const data = args.data as { roomId?: string } | undefined;
        if (data?.roomId) {
          const cur = await _base.roomAssignment.findFirst({ where: args.where as any });
          if (cur && cur.roomId !== data.roomId) {
            throw new PolicyGateBlockedError("ROOM_CHANGE_FORBIDDEN_DIRECT_EDIT", "Room change must be governed via segment/re-entry; direct RoomAssignment.roomId edit is forbidden");
          }
        }
        return query(args);
      },
      async updateMany() {
        throw new PolicyGateBlockedError("ROOM_ASSIGNMENT_UPDATE_FORBIDDEN", "RoomAssignment is immutable; create a new assignment for changes");
      },
    },
    room: {
      async update({ args, query }) {
        const data = args.data as { currentClaimState?: string } | undefined;
        if (data?.currentClaimState === "DEPARTED_CLEAN") {
          const cur = await _base.room.findFirst({ where: args.where as any });
          if (cur?.currentClaimState === "OCCUPIED") {
            throw new StateTransitionError(
              "Room must transition OCCUPIED→DEPARTED_DIRTY before DEPARTED_CLEAN",
              "INVALID_ROOM_STATE_TRANSITION",
            );
          }
        }
        return query(args);
      },
    },
  },
});

export const prisma = _ext as unknown as PrismaClient;
