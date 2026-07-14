/**
 * Compute the full stay-charge breakdown using the hotel's configured GST rate and service-charge
 * rate. Single source of truth used by all guest-facing email templates and the folio total view.
 *
 * Math (per hotel policy):
 *   subTotal       = nightlyRate × nights × roomCount
 *   serviceCharge  = subTotal × serviceChargeRate
 *   gst            = (subTotal + serviceCharge) × gstRate
 *   total          = subTotal + serviceCharge + gst
 *
 * GST is compound — applied to the subtotal *plus* the service charge.
 *
 * `roomCount` defaults to 1 for backwards compatibility with the pre-multi-room call sites,
 * but every new caller should pass the actual number of rooms so multi-room bookings compute
 * the correct total. Read `commercialTerms.roomCount` from the quotation, `entry.numberOfRooms`
 * from the entry, or count `distinctRoomIds` from the sealed availability configuration.
 *
 * Rates come from ConfigurationEntry (`billing.salesTaxRate`, `billing.serviceChargeRate`) so
 * the L4 admin can change them without a code deploy.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { mulMoney, round2 as round2Dec, toDecimal } from "../../lib/money.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type StayChargeBreakdown = {
  /** Room nights only — before service charge or GST. */
  subTotal: number;
  /** Decimal service-charge rate read from config (e.g. 0.10 = 10%). */
  serviceChargeRate: number;
  /** Computed service charge amount. */
  serviceCharge: number;
  /** Decimal GST rate read from config (e.g. 0.05 = 5%). */
  gstRate: number;
  /** Computed GST amount (applied to subTotal + serviceCharge). */
  gst: number;
  /** Final amount the guest pays. */
  total: number;
};

function rateFromConfig(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Round to 2dp via Decimal (half-away-from-zero). Returns a plain number for the public shape
 * of this module — callers persist through Prisma.Decimal columns anyway, but the caller of
 * this helper wants a number for email / display, so the conversion is at the boundary.
 * The IMPORTANT part: rounding happens on Decimal, not float, so `1.005 → 1.01` and not `1.00`.
 */
function round2(n: number): number {
  return Number(round2Dec(n).toFixed(2));
}

/** Resolve current GST + service charge rates from ConfigurationEntry. */
export async function resolveChargeRates(db: Db): Promise<{ gstRate: number; serviceChargeRate: number }> {
  const [gstRow, serviceRow] = await Promise.all([
    getActiveConfigEntry(db as PrismaClient, "billing.salesTaxRate"),
    getActiveConfigEntry(db as PrismaClient, "billing.serviceChargeRate"),
  ]);
  // Hardcoded fallbacks match the seeded defaults so the email is sensible even if config is missing.
  return {
    gstRate: rateFromConfig(gstRow?.configValue, 0.05),
    serviceChargeRate: rateFromConfig(serviceRow?.configValue, 0.1),
  };
}

/**
 * Compute the full breakdown from a per-room nightly rate, number of nights, and an optional
 * roomCount (defaults to 1 for legacy single-room call sites). Multi-room callers must pass
 * roomCount or their totals will be per-room, not per-booking.
 */
export async function computeStayCharges(
  db: Db,
  nightlyRate: number,
  nights: number,
  roomCount: number = 1,
): Promise<StayChargeBreakdown> {
  const { gstRate, serviceChargeRate } = await resolveChargeRates(db);
  return computeStayChargesWithRates(nightlyRate, nights, gstRate, serviceChargeRate, roomCount);
}

/** Pure variant for templates that already know the rates. */
export function computeStayChargesWithRates(
  nightlyRate: number,
  nights: number,
  gstRate: number,
  serviceChargeRate: number,
  roomCount: number = 1,
): StayChargeBreakdown {
  const safeNightly = Number.isFinite(nightlyRate) ? nightlyRate : 0;
  const safeNights = Math.max(1, Math.round(nights));
  const safeRoomCount = Math.max(1, Math.round(roomCount));
  // Decimal-safe: compute the breakdown in Prisma.Decimal so `Math.round(x*100)/100` binary
  // artefacts (e.g. `Math.round(1.005*100)/100 = 1` when it should be 1.01) never occur.
  // The output shape is `number` because email templates / summary UI consume it that way — the
  // conversion sits at the return boundary only.
  const subTotalDec = mulMoney(mulMoney(safeNightly, safeNights), safeRoomCount);
  const serviceChargeDec = round2Dec(mulMoney(subTotalDec, serviceChargeRate));
  const gstDec = round2Dec(mulMoney(subTotalDec.add(serviceChargeDec), gstRate));
  const totalDec = round2Dec(subTotalDec.add(serviceChargeDec).add(gstDec));
  return {
    subTotal: Number(round2Dec(subTotalDec).toFixed(2)),
    serviceChargeRate,
    serviceCharge: Number(serviceChargeDec.toFixed(2)),
    gstRate,
    gst: Number(gstDec.toFixed(2)),
    total: Number(totalDec.toFixed(2)),
  };
}
