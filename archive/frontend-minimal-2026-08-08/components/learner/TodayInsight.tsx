"use client";

import Link from "next/link";
import { ArrowRight, BrainCircuit, Clock3 } from "lucide-react";
import { useMemo, useState } from "react";

import { type DecisionContext } from "@/lib/learner-api";

function hourLabel(value: unknown) {
  return typeof value === "number" ? `${String(value).padStart(2, "0")}:00` : null;
}

export function TodayInsight({ goalId: _goalId, compact, inline }: { goalId: string | null; compact?: boolean; inline?: boolean }) {
  void _goalId;
  // MOCK — 看完效果后删掉，恢复下方 useEffect
  const [context] = useState<DecisionContext>({
    profile: { completion_rate_30d: 0.82 } as never,
    cognitive_profile: null,
    memories: {} as never,
    knowledge_gaps: [],
    active_patterns: [
      {
        id: "p1",
        goal_id: null,
        scope: "global",
        pattern_type: "preferred_learning_time",
        pattern_value: { peak_hours: [21] },
        confidence: 0.87,
        evidence_count: 14,
        last_confirmed_at: null,
        evidence: [],
        explanation: "",
      },
    ],
    recent_events: [],
    goal_context: null,
    data_quality: { profile_event_count: 14 } as never,
  });

  // useEffect(() => {
  //   let active = true;
  //   learnerApi
  //     .getDecisionContext(goalId)
  //     .then((result) => active && setContext(result))
  //     .catch(() => active && setContext(null));
  //   return () => {
  //     active = false;
  //   };
  // }, [goalId]);

  const insight = useMemo(() => {
    const patterns = context?.active_patterns ?? [];
    const timePattern = patterns.find(
      (pattern) => pattern.pattern_type === "preferred_learning_time"
    );
    const peakHours = timePattern?.pattern_value.peak_hours;
    const firstHour = Array.isArray(peakHours) ? hourLabel(peakHours[0]) : null;
    if (timePattern && firstHour) {
      return {
        title: `你的高效学习时段在 ${firstHour} 左右`,
        recommendation: "建议把今天最重要、认知负荷最高的任务优先放在这个时段。",
        confidence: timePattern.confidence,
      };
    }
    const delayPattern = patterns.find((pattern) => pattern.pattern_type === "delay_pattern");
    if (delayPattern) {
      return {
        title: "近期任务出现了稳定的延期信号",
        recommendation: "建议先缩小今日任务量，再逐步恢复稳定节奏。",
        confidence: delayPattern.confidence,
      };
    }
    const completion = context?.profile?.completion_rate_30d;
    if (completion != null) {
      return {
        title: `近 30 天任务完成率为 ${Math.round(completion * 100)}%`,
        recommendation:
          completion >= 0.7
            ? "当前节奏较稳定，继续保持固定学习窗口。"
            : "从一个更小、可完成的今日目标开始。",
        confidence: null,
      };
    }
    return null;
  }, [context]);

  if (inline) {
    if (!insight) return null;
    return (
      <div className="home-greeting-insight" data-testid="home-greeting-insight">
        <p className="home-greeting-insight-title">
          <Clock3 size={13} aria-hidden="true" />
          <strong>{insight.title}</strong>
        </p>
        <p className="home-greeting-insight-copy">{insight.recommendation}</p>
      </div>
    );
  }

  if (compact) {
    if (!insight) return null;
    return (
      <div className="brief-learning-insight" data-testid="home-learning-insight">
        <div className="brief-learning-insight-icon"><Clock3 size={14} /></div>
        <div className="min-w-0 flex-1">
          <p className="brief-learning-insight-title">{insight.title}</p>
          <p className="brief-learning-insight-copy">{insight.recommendation}</p>
        </div>
        {insight.confidence != null && (
          <Link href="/coach" className="brief-learning-insight-evidence" aria-label={`查看置信度 ${Math.round(insight.confidence * 100)}% 的依据`}>
            依据 {Math.round(insight.confidence * 100)}% <ArrowRight size={10} />
          </Link>
        )}
      </div>
    );
  }

  return (
    <section
      data-testid="today-ai-insight"
      className="rounded-2xl border border-[var(--accent-muted)] bg-white p-5 shadow-[var(--shadow-xs)]"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-light)] text-[var(--accent)]">
          {insight ? <Clock3 size={17} /> : <BrainCircuit size={17} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900">今日 AI 洞察</h2>
            {insight?.confidence != null && (
              <span className="rounded-full bg-[var(--accent-light)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">
                置信度 {Math.round(insight.confidence * 100)}%
              </span>
            )}
          </div>
          {insight ? (
            <>
              <p className="mt-1 text-sm text-gray-700">{insight.title}</p>
              <p className="mt-1 text-xs leading-5 text-gray-500">{insight.recommendation}</p>
            </>
          ) : (
            <p className="mt-1 text-xs leading-5 text-gray-500">
              完成更多任务与打卡后，这里会显示基于长期行为证据的个性化洞察。
            </p>
          )}
        </div>
        <Link
          href="/coach"
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-[var(--accent)]"
        >
          查看依据 <ArrowRight size={12} />
        </Link>
      </div>
    </section>
  );
}
