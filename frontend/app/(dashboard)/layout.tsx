"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Home, Target, BookOpen, FileText, Settings, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { useAuthStore } from "@/lib/stores/authStore";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/NotificationBell";

const navItems = [
  { href: "/dashboard",           label: "首页",   icon: Home     },
  { href: "/dashboard/goals",     label: "我的目标", icon: Target  },
  { href: "/dashboard/knowledge", label: "知识库",  icon: BookOpen },
  { href: "/dashboard/notes",     label: "笔记",   icon: FileText },
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
    <div className="calm-app flex h-screen gap-3 bg-[#f3eee7] p-3">
      <aside className={cn(
        "calm-sidebar flex flex-col flex-shrink-0 transition-all duration-200 overflow-hidden rounded-[26px]",
        collapsed ? "w-14" : "w-56"
      )}>
        {/* Logo + 收缩按钮 */}
        <div className={cn(
          "flex items-center h-[68px] flex-shrink-0",
          collapsed ? "justify-center px-2" : "justify-between px-5"
        )}>
          {!collapsed && (
            <>
              <Link href="/dashboard" className="flex items-center gap-2 whitespace-nowrap">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#fff9f2] text-[#321c04]">
                  <Sparkles size={14} />
                </span>
                <span className="text-lg font-semibold tracking-[-0.03em] text-[#321c04]">
                  Plan<span className="calm-serif font-normal italic">Pilot</span>
                </span>
              </Link>
              <div className="ml-auto mr-1.5">
                <NotificationBell />
              </div>
            </>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-[#e8d9c7] text-[#8b745e] transition flex-shrink-0"
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>
        </div>

        {/* 导航 */}
        <nav className="flex-1 px-2 py-4 space-y-1.5 overflow-hidden">
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
                  "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition",
                  collapsed && "justify-center px-0",
                  isActive
                    ? "bg-[#321c04] text-[#fff9f2]"
                    : "text-[#725f4d] hover:bg-[#eadcca] hover:text-[#321c04]"
                )}
              >
                <Icon size={17} className="flex-shrink-0" />
                {!collapsed && <span className="whitespace-nowrap">{label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* 底部用户区 */}
        <div className="px-2 py-3 flex-shrink-0">
          <Link
            href="/dashboard/settings"
            title={collapsed ? (user?.username ?? "设置") : undefined}
            className={cn(
              "flex items-center gap-2.5 px-2 py-2 rounded-xl transition",
              collapsed && "justify-center",
              pathname === "/dashboard/settings" ? "bg-[#eadcca]" : "hover:bg-[#eadcca]"
            )}
          >
            <div className="w-7 h-7 rounded-full bg-[#321c04] text-[#fff9f2] flex items-center justify-center text-xs font-bold flex-shrink-0">
              {avatarText}
            </div>
            {!collapsed && (
              <>
                <span className="text-sm text-gray-700 font-medium flex-1 truncate whitespace-nowrap">
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

      <main className="calm-main flex-1 overflow-y-auto min-w-0 rounded-[26px]">{children}</main>
    </div>
  );
}
