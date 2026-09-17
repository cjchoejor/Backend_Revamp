import type { ReactNode } from "react";
import { AppShell } from "@/components/ds/app-shell";
// Order matters (design-system/index.ts): the design system first, then the legacy desk theme the
// working tools still wear, then the bridge that re-points that theme at the new palette, then the
// frame's own additions.
import "@/design-system/styles/fonts.css";
import "@/design-system/styles/tokens.css";
import "@/design-system/styles/components.css";
import "@/styles/desk-theme.css";
import "@/design-system/styles/legacy-bridge.css";
import "@/design-system/styles/frame.css";

export default function DeskFrameLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
