import type { ReactNode } from "react";
import { DeskShell } from "@/components/desk/desk-shell";
import "@/styles/desk-theme.css";

export default function DeskLayout({ children }: { children: ReactNode }) {
  return <DeskShell>{children}</DeskShell>;
}
