import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Banknote,
  Bot,
  Building2,
  ClipboardList,
  Cog,
  FileText,
  Gauge,
  HelpCircle,
  KeyRound,
  LayoutDashboard,
  type LucideIcon as _LucideIcon,
  Mail,
  MessageSquare,
  Receipt,
  Settings2,
  Shield,
  Users,
  Workflow,
} from "lucide-react";

export type AdminNavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  description?: string;
};

/**
 * The console's side list: the nine ACIG domains under plain names (see `docs/ACIG-v1_1.md` §6.2 for
 * which service owns what), an Overview at the top and the tools underneath.
 *
 * Each group opens and closes; the one holding the current page opens by itself. See `admin-shell.tsx`.
 */
export type AdminNavGroup = {
  /** The ACIG domain, "01" to "09": a stable id for the group, never shown. */
  domainNumber: string;
  title: string;
  icon: LucideIcon;
  items: AdminNavItem[];
};

/** Pinned-top single link (rendered above all domain groups, no drawer). */
export const overviewNavItem: AdminNavItem = {
  title: "Overview",
  href: "/admin",
  icon: LayoutDashboard,
  description: "Everything in the console",
};

export const adminNavGroups: AdminNavGroup[] = [
  {
    domainNumber: "01",
    title: "The hotel and its people",
    icon: Users,
    items: [
      { title: "Hotel profile", href: "/admin/hotel-profile", icon: Building2, description: "The hotel's name, address, contacts and holidays" },
      { title: "Departments", href: "/admin/departments", icon: ClipboardList, description: "The hotel's departments" },
      { title: "Roles", href: "/admin/roles", icon: KeyRound, description: "Roles, what they may do, how long a sign-in lasts" },
      { title: "Staff", href: "/admin/staff", icon: Users, description: "People, their roles and PINs" },
      { title: "Number prefixes", href: "/admin/id-prefixes", icon: KeyRound, description: "The letters at the start of booking, invoice and other numbers" },
    ],
  },
  {
    domainNumber: "02",
    title: "Rooms and spaces",
    icon: Building2,
    items: [
      { title: "Room types", href: "/admin/room-types", icon: Building2, description: "Kinds of room, what they sleep, their beds" },
      { title: "Rooms", href: "/admin/rooms", icon: Building2, description: "Each room and any fault on it" },
      { title: "Spaces", href: "/admin/spaces", icon: Building2, description: "Halls and event spaces" },
    ],
  },
  {
    domainNumber: "03",
    title: "Rates and limits",
    icon: Receipt,
    items: [
      { title: "Rate plans", href: "/admin/rate-plans", icon: Receipt, description: "Published rates and the walk-in rate" },
      { title: "Seasons", href: "/admin/seasons", icon: Receipt, description: "Dates when rates go up or down" },
      // "Packages" collided with the negotiated RATE packages on the agency and company pages.
      { title: "Stay packages", href: "/admin/packages", icon: Receipt, description: "Packages with inclusions, not agency rates" },
      { title: "Travel agents", href: "/admin/travel-agents", icon: Users, description: "Agencies and their rate packages" },
      { title: "Corporate accounts", href: "/admin/corporate-accounts", icon: Building2, description: "Companies and their rate packages" },
      { title: "Common rate package", href: "/admin/common-rate-package", icon: Banknote, description: "For an agency or company with no package of its own" },
      { title: "House tariff", href: "/admin/house-tariff", icon: Banknote, description: "Extra bed, meals and meal plans for guests with no package" },
      { title: "Limits", href: "/admin/commercial", icon: Receipt, description: "Discounts, credit, free stays, overbooking, write-offs" },
    ],
  },
  {
    domainNumber: "04",
    title: "Rules",
    icon: Workflow,
    items: [
      { title: "House rules", href: "/admin/policies", icon: Workflow, description: "The hotel's rules: time limits, money, children, groups" },
      { title: "Cancellation policies", href: "/admin/cancellation-policies", icon: Receipt, description: "What a guest pays when they cancel or do not come" },
      { title: "Kinds of change", href: "/admin/modes", icon: Workflow, description: "The steps each kind of change to a booking goes through" },
    ],
  },
  {
    domainNumber: "05",
    title: "Messages",
    icon: MessageSquare,
    items: [
      { title: "Channels and replies", href: "/admin/communication-config", icon: MessageSquare, description: "Email, WhatsApp and how long to wait for an answer" },
      { title: "Templates", href: "/admin/templates", icon: FileText, description: "Messages, handoff checklists, invoices and work orders" },
      { title: "VIP arrivals", href: "/admin/vip-routing", icon: Users, description: "Who is told when a VIP arrives" },
    ],
  },
  {
    domainNumber: "06",
    title: "Money and daily running",
    icon: Banknote,
    items: [
      { title: "Payments and bills", href: "/admin/financial", icon: Banknote, description: "Tax rates, advances, reminders and bills" },
      { title: "Daily schedule", href: "/admin/operational", icon: Cog, description: "Night audit, check-in and check-out times, cleaning" },
      { title: "Time limits", href: "/admin/timers-workers", icon: Activity, description: "How long a booking, a hold or a quote can wait" },
    ],
  },
  {
    domainNumber: "07",
    title: "After the stay",
    icon: Shield,
    items: [
      { title: "Feedback and records", href: "/admin/post-stay", icon: Shield, description: "Feedback, reviews, commission, ID documents" },
    ],
  },
  {
    domainNumber: "08",
    title: "Online bookings and AI",
    icon: Bot,
    items: [
      { title: "Online booking sites", href: "/admin/ota-config", icon: Settings2, description: "Booking sites, how often the inbox is read, no-show charges" },
      { title: "AI agent", href: "/admin/ai-agent-config", icon: Bot, description: "What the AI may do and how long it may hold a booking" },
    ],
  },
  {
    domainNumber: "09",
    title: "Everything else",
    icon: HelpCircle,
    items: [
      { title: "Other settings", href: "/admin/configuration", icon: Settings2, description: "Settings that do not belong to another page" },
      { title: "Readiness check", href: "/admin/readiness", icon: Gauge, description: "Is everything set that the desk needs" },
    ],
  },
];

/** Tools, under the groups. */
export const utilityNavItems: AdminNavItem[] = [
  { title: "Audit trail", href: "/admin/audit-trail", icon: Gauge, description: "Who changed what, and when" },
  { title: "System health", href: "/admin/health", icon: Activity, description: "Is the system connected and running" },
  { title: "Email test", href: "/admin/email-test", icon: Mail, description: "Send a test email" },
];


/**
 * Find which domain group contains the given pathname. Used by the sidebar to auto-expand the
 * relevant drawer on page change. Returns the group's `domainNumber`, or null for Overview/Utilities.
 */
export function activeDomainNumber(pathname: string): string | null {
  for (const group of adminNavGroups) {
    if (group.items.some((it) => pathname === it.href || pathname.startsWith(`${it.href}/`))) {
      return group.domainNumber;
    }
  }
  return null;
}
