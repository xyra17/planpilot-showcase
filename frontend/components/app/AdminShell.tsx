"use client";

import { ArrowLeft, Beaker, Blocks, Gauge, Menu, RadioTower, ScrollText, ShieldCheck, X } from "lucide-react";
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
    title: "生产运营总览",
    description: "快速查看 Agent 健康度、当前生产策略与反馈学习状态。",
    icon: Gauge,
  },
  {
    href: "/admin/canary",
    label: "Canary 发布",
    title: "Canary 发布管理",
    description: "在离线门禁保护下逐级放量，并在指标异常时执行受控回滚。",
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
