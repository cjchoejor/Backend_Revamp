"use client";

import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type LogoProps = {
  className?: string;
  width?: number;
  height?: number;
  priority?: boolean;
};

export function Logo({ className, width = 180, height = 120, priority }: LogoProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";
  const src = isDark ? "/brand/legphel-logo-dark.png" : "/brand/legphel-logo-light.jpg";

  if (!mounted) {
    return <div className={cn("bg-muted animate-pulse rounded-lg", className)} style={{ width, height }} />;
  }

  return (
    <Image
      src={src}
      alt="LEGPHEL Hotel"
      width={width}
      height={height}
      priority={priority}
      className={cn("object-contain", className)}
    />
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("text-center", className)}>
      <p className="tracking-brand text-xs font-medium uppercase text-foreground/90">Legphel</p>
      <div className="mx-auto my-1 h-px w-12 bg-primary" />
      <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">Hotel</p>
    </div>
  );
}
