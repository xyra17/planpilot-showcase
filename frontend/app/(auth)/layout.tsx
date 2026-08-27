import { BrainCircuit, CheckCircle2, ShieldCheck } from "lucide-react";

import { AppBrand } from "@/components/app/AppBrand";
import { AuthNativeThemeBoundary } from "@/components/auth/AuthNativeThemeBoundary";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthNativeThemeBoundary>
      <main className="pp-auth-shell pp-auth-native">
        <section className="pp-auth-story">
          <div className="pp-auth-ambient" aria-hidden="true" />
          <AppBrand href="/studio/work" />
          <div className="pp-auth-story-copy">
            <span>YOUR LONG-TERM LEARNING PARTNER</span>
            <h1>把每一天的学习，<br />连成长期成长。</h1>
            <p>PlanPilot 根据你选择保留的学习记录，理解学习节奏、沉淀有效方法；提出调整建议时，也会先说明依据。</p>
            <div className="pp-auth-points">
              <div><CheckCircle2 size={17} /><span><strong>清晰执行</strong><small>目标、任务与回顾集中管理</small></span></div>
              <div><BrainCircuit size={17} /><span><strong>持续理解</strong><small>Pilo 基于学习证据提供个性化建议</small></span></div>
              <div><ShieldCheck size={17} /><span><strong>由你决定</strong><small>计划调整前先说明依据，确认后再执行</small></span></div>
            </div>
          </div>
          <p className="pp-auth-footnote">你的学习数据只用于提供个人学习支持。</p>
        </section>
        <section className="pp-auth-content">{children}</section>
      </main>
    </AuthNativeThemeBoundary>
  );
}
