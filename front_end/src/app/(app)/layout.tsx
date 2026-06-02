import type { ReactNode } from "react";
import { AppOrAdminLayout } from "@/components/layout/app-or-admin-layout";
import { ZoneTransitionProvider } from "@/components/layout/zone-transition";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ZoneTransitionProvider>
      <AppOrAdminLayout>{children}</AppOrAdminLayout>
    </ZoneTransitionProvider>
  );
}
