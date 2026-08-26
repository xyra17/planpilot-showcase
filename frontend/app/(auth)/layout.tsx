import { BrainCircuit, CheckCircle2, ShieldCheck } from "lucide-react";

import { AppBrand } from "@/components/app/AppBrand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="pp-auth-shell pp-auth-native">
      <section className="pp-auth-story">
        <div className="pp-auth-ambient" aria-hidden="true" />
        <AppBrand href="/studio/work" />
        <div className="pp-auth-story-copy">
          <span>LONG-TERM LEARNING AGENT</span>
          <h1>把每一天的学习，<br />连成长期成长。</h1>
          <p>PlanPilot 观察你的学习节奏、记住有效方法，并在每次调整前把依据交给你。</p>
          <div className="pp-auth-points">
            <div><CheckCircle2 size={17} /><span><strong>清晰执行</strong><small>目标、任务与回顾集中管理</small></span></div>
            <div><BrainCircuit size={17} /><span><strong>长期理解</strong><small>学习伙伴基于行为证据提供建议</small></span></div>
            <div><ShieldCheck size={17} /><span><strong>由你决定</strong><small>任何计划变更都需要你的确认</small></span></div>
          </div>
        </div>
        <p className="pp-auth-footnote">你的学习数据只用于提供个人学习支持。</p>
      </section>
      <section className="pp-auth-content">{children}</section>
    </main>
  );
}
