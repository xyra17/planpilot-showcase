"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { CoachFAB } from "@/components/shell/CoachFAB";
import { NavSidebar } from "@/components/shell/NavSidebar";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/stores/authStore";

import { AppProviders } from "./AppProviders";
import { AuthBoundary } from "./AuthBoundary";

export function ProductShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const surface = pathname.startsWith("/coach") || pathname.startsWith("/dashboard/coach") || pathname.startsWith("/dashboard/agent")
    ? "coach"
    : pathname.startsWith("/settings") || pathname.startsWith("/dashboard/settings")
      ? "settings"
      : "work";

  useEffect(() => setMobileOpen(false), [pathname]);

  useEffect(() => {
    if (user?.ui_experience !== "technology") return;
    window.location.replace("/studio/work");
  }, [user?.ui_experience]);

  return (
    <AppProviders>
      <AuthBoundary>
        <div className={`pp-product-shell pp-${surface}-surface`} data-product-surface={surface}>
          <aside className={cn("pp-sidebar", collapsed && "is-collapsed")}>
            <NavSidebar
              collapsed={collapsed}
              onCollapse={() => setCollapsed((v) => !v)}
              onMobileClose={() => setMobileOpen(false)}
            />
          </aside>
          {mobileOpen && (
            <div className="pp-mobile-scrim" onClick={() => setMobileOpen(false)} />
          )}
          {mobileOpen && (
            <aside data-testid="mobile-product-navigation" className="pp-mobile-drawer is-open">
              <NavSidebar
                collapsed={false}
                onCollapse={() => setCollapsed((v) => !v)}
                onMobileClose={() => setMobileOpen(false)}
                isMobile
              />
            </aside>
          )}
          {!mobileOpen && (
            <button
              className="pp-mobile-only fixed top-3 left-3 z-30 w-9 h-9 rounded-xl flex items-center justify-center bg-white/90 border border-gray-100 text-gray-500 shadow-sm hover:bg-white hover:text-gray-800 transition backdrop-blur-sm"
              onClick={() => setMobileOpen(true)}
              aria-label="打开导航"
            >
              <Menu size={17} />
            </button>
          )}
          <div className="pp-product-column">
            <main className="pp-product-main">{children}</main>
          </div>
          <CoachFAB />
        </div>
      </AuthBoundary>
    </AppProviders>
  );
}
