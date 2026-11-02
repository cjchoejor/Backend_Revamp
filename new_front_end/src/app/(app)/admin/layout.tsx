import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
// The desk's stylesheets in the desk's order (see the (ds) layout), then the console's own.
import "@/design-system/styles/fonts.css";
import "@/design-system/styles/tokens.css";
import "@/design-system/styles/components.css";
import "@/styles/desk-theme.css";
import "@/design-system/styles/legacy-bridge.css";
import "@/design-system/styles/frame.css";
import "./admin-theme.css";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
