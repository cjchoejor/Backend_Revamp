/**
 * Compute the full stay-charge breakdown using the hotel's configured GST rate and service-charge
 * rate. Single source of truth used by all guest-facing email templates and the folio total view.
 *
 * Math (per hotel policy):
 *   subTotal       = nightlyRate × nights
 *   serviceCharge  = subTotal × serviceChargeRate
 *   gst            = (subTotal + serviceCharge) × gstRate
 *   total          = subTotal + serviceCharge + gst
 *
 * GST is compound — applied to the subtotal *plus* the service charge.
 *
 * Rates come from ConfigurationEntry (`billing.salesTaxRate`, `billing.serviceChargeRate`) so
 * the L4 admin can change them without a code deploy.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { getActiveConfigEntry } from "../../lib/config-store.js";

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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

/** Compute the full breakdown from a nightly rate + number of nights. */
export async function computeStayCharges(
  db: Db,
  nightlyRate: number,
  nights: number,
): Promise<StayChargeBreakdown> {
  const { gstRate, serviceChargeRate } = await resolveChargeRates(db);
  return computeStayChargesWithRates(nightlyRate, nights, gstRate, serviceChargeRate);
}

/** Pure variant for templates that already know the rates. */
export function computeStayChargesWithRates(
  nightlyRate: number,
  nights: number,
  gstRate: number,
  serviceChargeRate: number,
): StayChargeBreakdown {
  const safeNightly = Number.isFinite(nightlyRate) ? nightlyRate : 0;
  const safeNights = Math.max(1, Math.round(nights));
  const subTotal = round2(safeNightly * safeNights);
  const serviceCharge = round2(subTotal * serviceChargeRate);
  const gst = round2((subTotal + serviceCharge) * gstRate);
  const total = round2(subTotal + serviceCharge + gst);
  return { subTotal, serviceChargeRate, serviceCharge, gstRate, gst, total };
}
