"use client";

import {
  BookOpen,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  FileText,
  Home,
  Settings,
  Sparkles,
  Target,
  WandSparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { NotificationBell } from "@/components/NotificationBell";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/stores/authStore";

import { AppBrand } from "@/components/app/AppBrand";
import { ModeSwitch } from "@/components/app/ModeSwitch";

const WORK_NAV = [
  { href: "/work", label: "总览", description: "今天与学习趋势", icon: Home, matches: ["/work", "/dashboard"] },
  { href: "/work/goals", label: "目标", description: "计划与任务", icon: Target, matches: ["/work/goals", "/dashboard/goals"] },
  { href: "/work/knowledge", label: "资料", description: "知识库与摘录", icon: BookOpen, matches: ["/work/knowledge", "/dashboard/knowledge"] },
  { href: "/work/notes", label: "笔记", description: "学习记录与思考", icon: FileText, matches: ["/work/notes", "/dashboard/notes"] },
];

const COACH_NAV = [
  { href: "/coach", label: "学习对话", description: "洞察与建议", icon: BrainCircuit, matches: ["/coach", "/dashboard/coach"] },
  { href: "/coach/workbench", label: "任务协作", description: "复杂任务协作", icon: WandSparkles, matches: ["/coach/workbench", "/dashboard/agent"] },
];

function isItemActive(pathname: string, item: (typeof WORK_NAV)[number]) {
  const exactRoots = new Set(["/work", "/dashboard", "/coach", "/dashboard/coach"]);
  return item.matches.some(
    (prefix) => pathname === prefix || (!exactRoots.has(prefix) && pathname.startsWith(prefix))
  );
}

export interface NavSidebarProps {
  collapsed: boolean;
  onCollapse: () => void;
  onMobileClose: () => void;
  isMobile?: boolean;
}

export function NavSidebar({ collapsed, onCollapse, onMobileClose, isMobile }: NavSidebarProps) {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  const mode: "work" | "coach" =
    pathname.startsWith("/coach") ||
    pathname.startsWith("/dashboard/coach") ||
    pathname.startsWith("/dashboard/agent")
      ? "coach"
      : "work";
  const navItems = mode === "coach" ? COACH_NAV : WORK_NAV;

  return (
    <>
      <div className="pp-sidebar-brand-row">
        <AppBrand compact={collapsed} />
        <div className="flex items-center gap-0.5">
          <NotificationBell />
          {isMobile ? (
            <button
              className="pp-icon-button pp-mobile-only"
              onClick={onMobileClose}
              aria-label="关闭导航"
            >
              <X size={18} />
            </button>
          ) : (
            <button
              className="pp-icon-button pp-desktop-only"
              onClick={onCollapse}
              aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            >
              {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          )}
        </div>
      </div>
      <div className="pp-sidebar-mode">
        <ModeSwitch mode={mode} compact={collapsed} />
      </div>
      <nav
        className="pp-sidebar-nav"
        aria-label={mode === "work" ? "学习空间导航" : "学习伙伴导航"}
      >
{navItems.map((item) => {
          const active = isItemActive(pathname, item as (typeof WORK_NAV)[number]);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn("pp-nav-link", active && "is-active", collapsed && "is-compact")}
              title={collapsed ? item.label : undefined}
            >
              <span className="pp-nav-icon">
                <Icon size={18} />
              </span>
              {!collapsed && (
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="pp-sidebar-bottom">
        {user?.is_admin && (
          <Link href="/admin" className={cn("pp-admin-entry", collapsed && "is-compact")}>
            <Sparkles size={16} />
            {!collapsed && <span>进入管理后台</span>}
          </Link>
        )}
        <Link href="/settings" className={cn("pp-account-link", collapsed && "is-compact")}>
          <span className="pp-avatar">{user?.username?.slice(0, 2).toUpperCase() ?? "?"}</span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <strong>{user?.username}</strong>
              <small>{user?.email}</small>
            </span>
          )}
          {!collapsed && <Settings size={15} />}
        </Link>
      </div>
    </>
  );
}
