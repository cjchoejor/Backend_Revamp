import type { LucideIcon } from "lucide-react";
import { ClipboardList, FileText, LayoutDashboard, ListChecks, Settings2 } from "lucide-react";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  minLevel?: "L1" | "L2" | "L3" | "L4";
};

export const siteConfig = {
  name: "LEGPHEL PMS",
  tagline: "Hotel property management",
  description: "LEGPHEL Hotel — front office operations",
};

export const mainNav: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Inquiries", href: "/inquiries", icon: FileText },
  { title: "Entries", href: "/entries", icon: ListChecks },
];

export const secondaryNav: NavItem[] = [
  { title: "Admin Console", href: "/admin", icon: Settings2, minLevel: "L4" },
  { title: "System health", href: "/admin/health", icon: ClipboardList, minLevel: "L1" },
];
