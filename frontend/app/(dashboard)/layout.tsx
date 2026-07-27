"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Home, Target, BookOpen, FileText, Settings, ChevronLeft, ChevronRight, Sparkles, Bot } from "lucide-react";
import { useAuthStore } from "@/lib/stores/authStore";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/NotificationBell";
import { ToastProvider } from "@/components/ui/Toast";
import { ConfirmDialogProvider } from "@/components/ui/ConfirmDialog";

const navItems = [
  { href: "/dashboard",           label: "首页",   icon: Home     },
  { href: "/dashboard/goals",     label: "我的目标", icon: Target  },
  { href: "/dashboard/knowledge", label: "知识库",  icon: BookOpen },
  { href: "/dashboard/notes",     label: "笔记",   icon: FileText },
  { href: "/dashboard/agent",     label: "Agent 工作台", icon: Bot },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, initFromStorage } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => { initFromStorage(); }, [initFromStorage]);

  useEffect(() => {
    if (typeof window !== "undefined" && !localStorage.getItem("access_token")) {
      router.replace("/login");
    }
  }, [router]);

  const avatarText = user?.username?.slice(0, 2).toUpperCase() ?? "?";

  return (
    <ToastProvider>
    <ConfirmDialogProvider>
    <div className="calm-app flex h-screen bg-white">
      <aside className={cn(
        "calm-sidebar bg-white border-r border-gray-100 flex flex-col flex-shrink-0 transition-all duration-200 overflow-hidden",
        collapsed ? "w-14" : "w-56"
      )}>
        {/* Logo + 收缩按钮 */}
        <div className={cn(
          "calm-sidebar-header flex items-center border-b border-gray-100 h-[60px] flex-shrink-0",
          collapsed ? "justify-center px-2" : "justify-between px-5"
        )}>
          {!collapsed && (
            <>
              <Link href="/dashboard" className="flex items-center gap-2 whitespace-nowrap">
                <span className="calm-brand-icon hidden h-8 w-8 items-center justify-center rounded-full">
                  <Sparkles size={14} />
                </span>
                <span className="calm-brand-text text-lg font-semibold tracking-[-0.03em] text-gray-900">
                  PlanPilot
                </span>
              </Link>
              <div className="ml-auto mr-1.5">
                <NotificationBell />
              </div>
            </>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="calm-collapse w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 transition flex-shrink-0"
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>
        </div>

        {/* 导航 */}
        <nav className="flex-1 px-2 py-4 space-y-1 overflow-hidden">
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive = href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                className={cn(
                  "calm-nav-item flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition",
                  collapsed && "justify-center px-0",
                  isActive
                    ? "calm-nav-active bg-blue-50 text-blue-600"
                    : "calm-nav-idle text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                )}
                style={isActive ? { background: "var(--accent-light)", color: "var(--accent)" } : {}}
              >
                <Icon size={17} className="flex-shrink-0" />
                {!collapsed && <span className="calm-nav-label whitespace-nowrap">{label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* 底部用户区 */}
        <div className="calm-user-area px-2 py-3 border-t border-gray-100 flex-shrink-0">
          <Link
            href="/dashboard/settings"
            title={collapsed ? (user?.username ?? "设置") : undefined}
            className={cn(
              "flex items-center gap-2.5 px-2 py-2 rounded-xl transition",
              collapsed && "justify-center",
              pathname === "/dashboard/settings" ? "bg-gray-100" : "hover:bg-gray-50"
            )}
          >
            <div className="calm-avatar w-7 h-7 rounded-full text-white flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: "var(--accent)" }}>
              {avatarText}
            </div>
            {!collapsed && (
              <>
                <span className="calm-user-label text-sm text-gray-700 font-medium flex-1 truncate whitespace-nowrap">
                  {user?.username ?? "..."}
                </span>
                <Settings
                  size={14}
                  className={cn(
                    "flex-shrink-0",
                    pathname === "/dashboard/settings" ? "text-gray-700" : "text-gray-400"
                  )}
                />
              </>
            )}
          </Link>
        </div>
      </aside>

      <main className="calm-main flex-1 overflow-y-auto min-w-0">{children}</main>
    </div>
    </ConfirmDialogProvider>
    </ToastProvider>
  );
}
