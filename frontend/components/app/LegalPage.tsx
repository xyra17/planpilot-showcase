import Link from "next/link";

import { AppBrand } from "@/components/app/AppBrand";

export function LegalPage({
  title,
  updatedAt,
  children,
}: {
  title: string;
  updatedAt: string;
  children: React.ReactNode;
}) {
  return (
    <main className="pp-legal-shell">
      <header className="pp-legal-header">
        <AppBrand href="/login" />
        <Link href="/login">返回登录</Link>
      </header>
      <article className="pp-legal-card">
        <p className="pp-legal-kicker">PLANPILOT LEGAL</p>
        <h1>{title}</h1>
        <p className="pp-legal-date">更新日期：{updatedAt}</p>
        <div className="pp-legal-content">{children}</div>
      </article>
    </main>
  );
}
