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
 * Domain-grouped nav for the L4 admin console. Maps directly to the 9 canonical ACIG domains
 * (see `docs/admin-console-visual.html`) plus a top "Overview" pin and a bottom "Utilities" group
 * for read-only / utility pages.
 *
 * The sidebar renders each `AdminNavGroup` as a collapsible drawer; the drawer containing the
 * currently-active route is auto-expanded by default. See `admin-shell.tsx`.
 */
export type AdminNavGroup = {
  /** "01" through "09" — printed as "DOMAIN 0X". Use "" for pinned groups (Overview/Utilities). */
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
  description: "Console home & readiness summary",
};

export const adminNavGroups: AdminNavGroup[] = [
  {
    domainNumber: "01",
    title: "Identity & Org",
    icon: Users,
    items: [
      { title: "Hotel profile", href: "/admin/hotel-profile", icon: Building2, description: "Property identity & contact metadata" },
      { title: "Departments", href: "/admin/departments", icon: ClipboardList, description: "Org registry (codes, active status)" },
      { title: "Roles & sessions", href: "/admin/roles", icon: KeyRound, description: "Roles, permissions, session config" },
      { title: "Staff registry", href: "/admin/staff", icon: Users, description: "People, roles, session timeouts" },
    ],
  },
  {
    domainNumber: "02",
    title: "Inventory",
    icon: Building2,
    items: [
      { title: "Room types", href: "/admin/room-types", icon: Building2, description: "Room type registry" },
      { title: "Rooms", href: "/admin/rooms", icon: Building2, description: "Rooms & deficient conditions" },
      { title: "Spaces", href: "/admin/spaces", icon: Building2, description: "Conference & event spaces" },
    ],
  },
  {
    domainNumber: "03",
    title: "Commercial",
    icon: Receipt,
    items: [
      { title: "Rate plans", href: "/admin/rate-plans", icon: Receipt, description: "Rate plan registry & walk-in designation" },
      { title: "Seasons", href: "/admin/seasons", icon: Receipt, description: "Season calendar (non-overlapping)" },
      { title: "Packages", href: "/admin/packages", icon: Receipt, description: "Package registry & inclusions" },
      { title: "Commercial thresholds", href: "/admin/commercial", icon: Receipt, description: "Discount, FOC, overbooking, credit ceiling, write-off" },
    ],
  },
  {
    domainNumber: "04",
    title: "Workflow governance",
    icon: Workflow,
    items: [
      { title: "Cancellation policies", href: "/admin/cancellation-policies", icon: Receipt, description: "Penalty tiers & no-show treatment" },
      { title: "Modes", href: "/admin/modes", icon: Workflow, description: "Operational mode configurations" },
      { title: "Policies (registry)", href: "/admin/policies", icon: Workflow, description: "Versioned policy registry" },
    ],
  },
  {
    domainNumber: "05",
    title: "Communications & templates",
    icon: MessageSquare,
    items: [
      { title: "Channels & ack windows", href: "/admin/communication-config", icon: MessageSquare, description: "Channels, credentials, ack windows" },
      { title: "Templates", href: "/admin/templates", icon: FileText, description: "Communication, handoff, invoice, work-order templates" },
      { title: "VIP routing", href: "/admin/vip-routing", icon: Users, description: "VIP arrival notification routing" },
    ],
  },
  {
    domainNumber: "06",
    title: "Financial & operational",
    icon: Banknote,
    items: [
      { title: "Financial settings", href: "/admin/financial", icon: Banknote, description: "Payments, invoices, follow-up intervals, tax rates" },
      { title: "Operational settings", href: "/admin/operational", icon: Cog, description: "Night audit, checkout, room assignment, housekeeping SLA" },
      { title: "Timers & workers", href: "/admin/timers-workers", icon: Activity, description: "Background job schedules not owned by another domain" },
    ],
  },
  {
    domainNumber: "07",
    title: "Post-stay & governance",
    icon: Shield,
    items: [
      { title: "Post-stay & governance", href: "/admin/post-stay", icon: Shield, description: "Feedback, reviews, commission, identity docs" },
    ],
  },
  {
    domainNumber: "08",
    title: "OTA & AI agent",
    icon: Bot,
    items: [
      { title: "OTA config", href: "/admin/ota-config", icon: Settings2, description: "OTA sources, polling, no-show penalties" },
      { title: "AI agent config", href: "/admin/ai-agent-config", icon: Bot, description: "AI agent trust, credentials, processing locks" },
    ],
  },
  {
    domainNumber: "09",
    title: "Generic & readiness",
    icon: HelpCircle,
    items: [
      { title: "Configuration (orphaned)", href: "/admin/configuration", icon: Settings2, description: "Keys not owned by a domain service" },
      { title: "Readiness", href: "/admin/readiness", icon: Gauge, description: "Stage readiness gate checks" },
    ],
  },
];

/** Utility pages — pinned to the bottom, no domain number. */
export const utilityNavItems: AdminNavItem[] = [
  { title: "Audit trail", href: "/admin/audit-trail", icon: Gauge, description: "Who did what, when" },
  { title: "System health", href: "/admin/health", icon: Activity, description: "API connectivity" },
  { title: "Email test", href: "/admin/email-test", icon: Mail, description: "Verify SMTP & threading" },
];

/** Legacy flat list — preserved as a derived value for any code still importing it. New code
 *  should consume `adminNavGroups` instead. */
export const adminNav: AdminNavItem[] = [
  overviewNavItem,
  ...adminNavGroups.flatMap((g) => g.items),
  ...utilityNavItems,
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

/**
 * The 9 ACIG admin console domains, used by the Overview page's hero card. Source of truth:
 * `docs/admin-console-visual.html` §domains and `docs/ACIG-v1_1.md` §6.2 / §6.3.
 *
 * Service counts: 4 + 3 + 4 + 4 + 3 + 3 + 1 + 2 + 2 = 26. Keep this in sync with the nav above
 * and the hardcoded numbers in `back_end/src/routes/admin/overview-router.ts`.
 */
export const adminDomains = [
  {
    num: "01",
    name: "Identity & org",
    purpose: "The hotel itself, its departments, its people, and the role-permission map.",
    services: ["HotelProfile", "Department", "Staff", "Role"],
    icon: Users,
  },
  {
    num: "02",
    name: "Inventory",
    purpose: "Room types, rooms with deficient-condition tracking, and non-room spaces.",
    services: ["RoomType", "RoomInstance", "SpaceInventory"],
    icon: Building2,
  },
  {
    num: "03",
    name: "Commercial",
    purpose: "Rate plans, seasonal calendars, packages, and every commercial threshold (discount, FOC, overbooking, credit ceiling, write-off).",
    services: ["RatePlan", "Season", "Package", "CommercialThreshold"],
    icon: Receipt,
  },
  {
    num: "04",
    name: "Workflow governance",
    purpose: "Cancellation policy, hold/expiry behaviour, operational modes, and the policy registry.",
    services: ["CancellationPolicy", "WorkflowConfiguration", "Mode", "PolicyRegistry"],
    icon: Workflow,
  },
  {
    num: "05",
    name: "Communications & templates",
    purpose: "Channel credentials, acknowledgement windows, message templates, handoff checklists, and work order templates.",
    services: ["CommunicationConfig", "HandoffTemplate", "WorkOrderTemplate"],
    icon: MessageSquare,
  },
  {
    num: "06",
    name: "Financial & operational",
    purpose: "Advance payment thresholds, invoices, damage rates, night audit, checkout time, room assignment priorities, VIP routing.",
    services: ["FinancialConfiguration", "OperationalSchedule", "VIPNotificationRouting"],
    icon: Banknote,
  },
  {
    num: "07",
    name: "Post-stay & governance",
    purpose: "Feedback templates, review platform links, government portal config, agent commission, ID document types and retention.",
    services: ["PostStayAndGovernance"],
    icon: Shield,
  },
  {
    num: "08",
    name: "OTA & AI agent",
    purpose: "OTA source flags, polling, conflict rules, no-show penalties; AI agent processing locks, voice-note SLAs, escalation routing.",
    services: ["OTAConfiguration", "AIAgentConfig"],
    icon: Bot,
  },
  {
    num: "09",
    name: "Generic & readiness",
    purpose: "Catch-all keyed configuration for anything not owned by a domain service, plus the readiness gate endpoint.",
    services: ["Configuration", "Readiness"],
    icon: HelpCircle,
  },
] as const;
