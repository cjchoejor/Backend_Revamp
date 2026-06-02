import type { LucideIcon } from "lucide-react";
import {
  Building2,
  Gauge,
  KeyRound,
  LayoutDashboard,
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

export const adminNav: AdminNavItem[] = [
  { title: "Overview", href: "/admin", icon: LayoutDashboard, description: "Console home & readiness summary" },
  { title: "Hotel profile", href: "/admin/hotel-profile", icon: Users, description: "Property identity & contact metadata" },
  { title: "Departments", href: "/admin/departments", icon: Users, description: "Org registry (codes, active status)" },
  { title: "Roles & sessions", href: "/admin/roles", icon: KeyRound, description: "Roles, permissions, session config" },
  { title: "Configuration", href: "/admin/configuration", icon: Settings2, description: "Keyed configuration (temporal)" },
  { title: "Workflow & thresholds", href: "/admin/workflow", icon: Workflow, description: "Expiry, dwell, payments, tax" },
  { title: "Timers & workers", href: "/admin/timers-workers", icon: Workflow, description: "Background job schedules & SLA windows" },
  { title: "Staff registry", href: "/admin/staff", icon: Users, description: "People, roles, session timeouts" },
  { title: "Room types", href: "/admin/room-types", icon: Building2, description: "Room type registry" },
  { title: "Room inventory", href: "/admin/rooms", icon: Building2, description: "Rooms & deficient categories" },
  { title: "Spaces", href: "/admin/spaces", icon: Building2, description: "Conference & event spaces" },
  { title: "Commercial", href: "/admin/commercial", icon: Receipt, description: "Rate plans & commercial thresholds" },
  { title: "Rate plans", href: "/admin/rate-plans", icon: Receipt, description: "Rate plan registry & walk-in designation" },
  { title: "Seasons", href: "/admin/seasons", icon: Receipt, description: "Season calendar (non-overlapping)" },
  { title: "Packages", href: "/admin/packages", icon: Receipt, description: "Package registry & inclusions" },
  { title: "Cancellation policies", href: "/admin/cancellation-policies", icon: Receipt, description: "Penalty tiers & no-show treatment" },
  { title: "Modes", href: "/admin/modes", icon: Workflow, description: "Operational mode configurations" },
  { title: "Policies", href: "/admin/policies", icon: Workflow, description: "Policy registry (versioned)" },
  { title: "Templates", href: "/admin/templates", icon: KeyRound, description: "Communication, handoff, invoice templates" },
  { title: "Communication channels", href: "/admin/communication-config", icon: KeyRound, description: "Channels, credentials & ack windows" },
  { title: "Financial", href: "/admin/financial", icon: Receipt, description: "Payments, invoices, follow-up intervals" },
  { title: "Operational", href: "/admin/operational", icon: Workflow, description: "Night audit, checkout, SLA windows" },
  { title: "OTA config", href: "/admin/ota-config", icon: Settings2, description: "OTA sources, polling, no-show penalties" },
  { title: "AI agent config", href: "/admin/ai-agent-config", icon: Settings2, description: "Trust levels, credentials, processing locks" },
  { title: "Post-stay & governance", href: "/admin/post-stay", icon: Settings2, description: "Feedback, reviews, commission, identity docs" },
  { title: "VIP routing", href: "/admin/vip-routing", icon: Users, description: "VIP arrival notification routing" },
  { title: "Audit trail", href: "/admin/audit-trail", icon: Gauge, description: "Read-only event history (who did what, when)" },
  { title: "Readiness", href: "/admin/readiness", icon: Gauge, description: "Stage readiness gate checks" },
  { title: "System health", href: "/admin/health", icon: Shield, description: "API connectivity" },
];

export const workflowConfigKeys = [
  { key: "advancePayment.thresholds", label: "Advance payment thresholds" },
  { key: "creditCeiling.proximityThresholds", label: "Credit ceiling proximity" },
  { key: "billing.salesTaxRate", label: "Sales tax rate (decimal)" },
  { key: "expiry.s3.committedHoldTtlSeconds", label: "S3 committed hold TTL (seconds)" },
  { key: "stageDwell.thresholds", label: "Stage dwell thresholds" },
  { key: "nightAudit.scheduleTime", label: "Night audit schedule" },
  { key: "checkout.cutoffTime", label: "Checkout cutoff time" },
] as const;

export const adminDomains = [
  {
    num: "01",
    name: "Identity & org",
    services: ["HotelProfile", "Department", "Staff", "Role"],
    icon: Users,
  },
  {
    num: "02",
    name: "Inventory",
    services: ["RoomType", "RoomInstance", "SpaceInventory"],
    icon: Building2,
  },
  {
    num: "03",
    name: "Commercial",
    services: ["RatePlan", "Season", "Package", "CommercialThreshold"],
    icon: Receipt,
  },
  {
    num: "04",
    name: "Workflow",
    services: ["WorkflowConfiguration", "Mode", "PolicyRegistry"],
    icon: Workflow,
  },
  {
    num: "05",
    name: "Communications",
    services: ["CommunicationConfig", "HandoffTemplate"],
    icon: KeyRound,
  },
] as const;
