import type { ReactNode } from "react";
import { AppOrAdminLayout } from "@/components/layout/app-or-admin-layout";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppOrAdminLayout>{children}</AppOrAdminLayout>;
}
