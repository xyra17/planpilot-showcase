"use client";

import { ArrowLeft, BarChart3, Beaker, Blocks, Database, Gauge, Menu, RadioTower, ScrollText, ShieldCheck, TestTube2, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { AppBrand } from "./AppBrand";
import { AppProviders } from "./AppProviders";
import { AuthBoundary } from "./AuthBoundary";

const ADMIN_NAV = [
  {
    href: "/admin",
    label: "运营总览",
    title: "运营决策总览",
    description: "先看用户有没有获得价值，再看系统和发布是否稳定。",
    icon: Gauge,
  },
  {
    href: "/admin/product",
    label: "产品验证",
    title: "用户价值验证",
    description: "看用户能否快速开始、遇到中断后回来，并形成长期学习闭环。",
    icon: BarChart3,
  },
  {
    href: "/admin/beta",
    label: "行动验证",
    title: "行动功能验证",
    description: "查看行动功能的试用范围、安全状态、使用漏斗和真实案例。",
    icon: TestTube2,
  },
  {
    href: "/admin/canary",
    label: "灰度发布",
    title: "灰度发布管理",
    description: "在质量门禁保护下逐级放量，出现异常时暂停或回滚。",
    icon: RadioTower,
  },
  {
    href: "/admin/experiments",
    label: "实验与评估",
    title: "实验与离线评估",
    description: "比较候选策略、检查基准结果，并管理生产版本与发布记录。",
    icon: Beaker,
  },
  {
    href: "/admin/gateway",
    label: "模型网关",
    title: "模型网关状态",
    description: "监控模型路由、分布式熔断与多 Worker 的运行一致性。",
    icon: Blocks,
  },
  {
    href: "/admin/traces",
    label: "调用审计",
    title: "Agent 调用审计",
    description: "查看全体账户的脱敏调用链、延迟、回退与运行版本。",
    icon: ScrollText,
  },
  {
    href: "/admin/storage",
    label: "存储维护",
    title: "存储垃圾回收",
    description: "预览并清理数据库已无引用的孤儿文件，避免误删正在处理的上传。",
    icon: Database,
  },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => setMobileOpen(false), [pathname]);
  const currentPage =
    ADMIN_NAV.find((item) =>
      item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href)
    ) ?? ADMIN_NAV[0];
  const CurrentPageIcon = currentPage.icon;

  const navigation = (
    <>
      <div className="pp-admin-brand"><AppBrand href="/admin" /><button className="pp-icon-button pp-mobile-only" onClick={() => setMobileOpen(false)}><X size={18} /></button></div>
      <div className="pp-admin-badge"><ShieldCheck size={14} />内部管理后台</div>
      <nav className="pp-admin-nav" aria-label="管理后台导航">
        {ADMIN_NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={currentPage.href === href ? "page" : undefined}
            className={cn(currentPage.href === href && "is-active")}
          >
            <Icon size={17} /><span>{label}</span>
          </Link>
        ))}
      </nav>
      <div className="pp-admin-sidebar-bottom"><Link href="/studio/work"><ArrowLeft size={16} />返回用户产品</Link></div>
    </>
  );

  return (
    <AppProviders>
      <AuthBoundary requireAdmin>
        <div className="pp-admin-shell">
          <aside className="pp-admin-sidebar">{navigation}</aside>
          {mobileOpen && <div className="pp-mobile-scrim" onClick={() => setMobileOpen(false)} />}
          {mobileOpen && <aside className="pp-admin-mobile-drawer is-open">{navigation}</aside>}
          <div className="pp-admin-column">
            <header className="pp-admin-topbar pp-admin-mobile-topbar">
              <button
                className="pp-icon-button pp-mobile-only"
                aria-label="打开管理后台导航"
                onClick={() => setMobileOpen(true)}
              >
                <Menu size={19} />
              </button>
              <span className="pp-admin-mobile-current"><CurrentPageIcon size={17} /><strong>{currentPage.label}</strong></span>
            </header>
            <main className="pp-admin-main">
              <header
                key={currentPage.href}
                className="pp-admin-page-heading"
                data-page={currentPage.href === "/admin" ? "overview" : currentPage.href.split("/").pop()}
              >
                <div className="pp-admin-page-identity">
                  <span className="pp-admin-page-icon" aria-hidden="true"><CurrentPageIcon size={21} /></span>
                  <div>
                    <h1>{currentPage.title}</h1>
                    <p>{currentPage.description}</p>
                  </div>
                </div>
                <div id="pp-admin-heading-actions" className="pp-admin-heading-actions" aria-label="页面操作" />
              </header>
              {children}
            </main>
          </div>
        </div>
      </AuthBoundary>
    </AppProviders>
  );
}
