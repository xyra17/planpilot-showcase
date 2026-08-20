"use client";

import { usePathname } from "next/navigation";

import { AdminShell } from "@/components/app/AdminShell";
import { ProductShell } from "@/components/app/ProductShell";

export default function LegacyDashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname.startsWith("/dashboard/agent-operations")) {
    return <AdminShell>{children}</AdminShell>;
  }
  return <ProductShell>{children}</ProductShell>;
}
