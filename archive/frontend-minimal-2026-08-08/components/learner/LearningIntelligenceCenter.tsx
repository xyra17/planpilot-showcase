"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, BrainCircuit, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  type AdaptiveAssessment,
  type DecisionContext,
  learnerApi,
} from "@/lib/learner-api";

const pct = (value: number | null | undefined) =>
  value == null ? "—" : `${Math.round(value * 100)}%`;

function RetentionSparkline({ points }: { points: Array<{ day: number; retention: number }> }) {
  if (!points.length) return <div className="h-16 rounded-xl bg-gray-50" />;
  const path = points
    .map((point, index) => {
      const x = (index / Math.max(1, points.length - 1)) * 220;
      const y = 58 - point.retention * 50;
      return `${index ? "L" : "M"}${x},${y}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 220 64" className="h-16 w-full" role="img" aria-label="未来三十天知识保持曲线">
      <path d={`${path} L220,64 L0,64 Z`} fill="var(--accent-light)" opacity="0.72" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
      {points.map((point, index) => (
        <circle key={point.day} cx={(index / Math.max(1, points.length - 1)) * 220} cy={58 - point.retention * 50} r="2.5" fill="var(--accent)" />
      ))}
    </svg>
  );
}

export function LearningIntelligenceCenter({ goalId }: { goalId: string | null }) {
  const [context, setContext] = useState<DecisionContext | null>(null);
  const [assessment, setAssessment] = useState<AdaptiveAssessment | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      learnerApi.getDecisionContext(goalId),
      goalId ? learnerApi.getAdaptiveAssessment(goalId) : Promise.resolve(null),
    ])
      .then(([nextContext, nextAssessment]) => {
        if (!active) return;
        setContext(nextContext);
        setAssessment(nextAssessment);
      })
      .catch(() => {
        if (active) setContext(null);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [goalId]);

  const cognitive = context?.cognitive_profile;
  const primaryRisk = assessment?.risks[0];
  const insight = useMemo(() => {
    if (primaryRisk?.risk_level === "high") return `“${primaryRisk.title}”存在 ${pct(primaryRisk.failure_probability)} 的未完成风险`;
    if (context?.knowledge_gaps[0]) return `“${context.knowledge_gaps[0].name}”的知识保持率正在下降`;
    if (cognitive?.persistence_score != null) return `当前学习坚持度为 ${pct(cognitive.persistence_score)}`;
    return "继续完成任务与打卡，我会逐步建立你的认知模型";
  }, [cognitive?.persistence_score, context?.knowledge_gaps, primaryRisk]);

  return (
    <section data-testid="learning-intelligence-center" className="overflow-hidden rounded-3xl border border-[var(--accent-muted)] bg-white shadow-[var(--shadow-xs)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-gradient-to-r from-[var(--accent-light)] to-transparent px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--accent)] text-white shadow-sm">
            <BrainCircuit size={20} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-gray-900">学习智能中心</h2>
            <p className="text-xs text-gray-500">认知状态、遗忘趋势与执行风险</p>
          </div>
        </div>
        <Link href="/coach" className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent)]">
          打开学习伙伴 <ArrowRight size={13} />
        </Link>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center text-xs text-gray-400"><RefreshCw size={15} className="mr-2 animate-spin" />分析学习状态…</div>
      ) : (
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-[0.9fr_1.2fr_1fr]">
          <div className="rounded-2xl bg-gray-50 p-4">
            <div className="flex items-center justify-between text-xs text-gray-500"><span>认知画像</span><ShieldCheck size={15} className="text-[var(--accent)]" /></div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div><div className="text-xl font-semibold text-gray-900">{pct(cognitive?.learning_speed)}</div><div className="text-[11px] text-gray-400">学习速度</div></div>
              <div><div className="text-xl font-semibold text-gray-900">{pct(cognitive?.persistence_score)}</div><div className="text-[11px] text-gray-400">坚持度</div></div>
              <div><div className="text-xl font-semibold text-gray-900">{pct(cognitive?.recovery_score)}</div><div className="text-[11px] text-gray-400">恢复力</div></div>
              <div><div className="text-xl font-semibold text-gray-900">{pct(cognitive?.challenge_tolerance)}</div><div className="text-[11px] text-gray-400">挑战耐受</div></div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-100 p-4">
            <div className="flex items-center justify-between">
              <div><div className="text-xs text-gray-500">知识保持曲线</div><div className="mt-1 text-sm font-semibold text-gray-900">当前保持率 {pct(cognitive?.retention_rate)}</div></div>
              <span className="rounded-full bg-[var(--accent-light)] px-2 py-1 text-[10px] font-semibold text-[var(--accent)]">30 天预测</span>
            </div>
            <RetentionSparkline points={cognitive?.retention_curve ?? []} />
            <div className="flex justify-between text-[10px] text-gray-400"><span>今天</span><span>7 天</span><span>30 天</span></div>
          </div>

          <div className={`rounded-2xl p-4 ${primaryRisk?.risk_level === "high" ? "border border-amber-200 bg-amber-50/70" : "bg-gray-50"}`}>
            <div className="flex items-center gap-2 text-xs font-semibold text-gray-700">
              {primaryRisk?.risk_level === "high" ? <AlertTriangle size={15} className="text-amber-600" /> : <Sparkles size={15} className="text-[var(--accent)]" />}
              智能洞察
            </div>
            <p className="mt-3 text-sm leading-6 text-gray-700">{insight}</p>
            <p className="mt-2 text-[11px] text-gray-400">{context?.data_quality.memory_count ?? 0} 条记忆 · {context?.knowledge_gaps.length ?? 0} 个知识缺口 · 任何调整均需确认</p>
          </div>
        </div>
      )}
    </section>
  );
}
