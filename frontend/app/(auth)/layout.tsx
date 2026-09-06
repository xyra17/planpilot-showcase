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
            <span>ACTION · RECOVERY · MASTERY</span>
            <h1 className="pp-auth-definition">
              <span>把每一天的学习，</span>
              <span>连成长期成长。</span>
            </h1>
            <p>PlanPilot 将目标、任务、笔记与复盘连成持续反馈闭环：先安排今天，偏离后帮助恢复，再用学习证据确认真正掌握。</p>
            <div className="pp-auth-points">
              <div><CheckCircle2 size={17} /><span><strong>今日行动</strong><small>从目标拆出明确、可完成的下一步</small></span></div>
              <div><BrainCircuit size={17} /><span><strong>偏差恢复</strong><small>依据时间、难度与进度重排计划</small></span></div>
              <div><ShieldCheck size={17} /><span><strong>验证掌握</strong><small>用笔记、复盘与练习证据检验完成</small></span></div>
            </div>
          </div>
          <p className="pp-auth-footnote">你的学习数据只用于提供个人学习支持。</p>
        </section>
        <section className="pp-auth-content">{children}</section>
      </main>
    </AuthNativeThemeBoundary>
  );
}
