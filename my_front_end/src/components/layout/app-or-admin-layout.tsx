"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "./app-shell";

export function AppOrAdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith("/admin")) {
    return <>{children}</>;
  }
  return <AppShell>{children}</AppShell>;
}
