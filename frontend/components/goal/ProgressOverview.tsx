"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Flame,
} from "lucide-react";
import { api } from "@/lib/api";
import { DataSyncNotice } from "@/components/ui/DataSyncNotice";

export interface ProgressData {
  goal_id: string;
  title: string;
  deadline: string;
  total_tasks: number;
  completed_tasks: number;
  avg_completion_rate: number;
  streak_days: number;
  debt_count: number;
  days_ahead_or_behind: number | null;
}

export function ProgressOverview({ goalId, refreshKey = 0, localData }: { goalId: string; refreshKey?: number; localData?: ProgressData }) {
  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (localData) return;
    setLoading(true);
    setError(null);
    api.get<ProgressData>(`/api/v1/goals/${goalId}/progress`)
      .then(setData)
      .catch((reason) => {
        setData(null);
        setError(reason instanceof Error ? reason.message : "进度暂不可同步");
      })
      .finally(() => setLoading(false));
  }, [goalId, localData, refreshKey, retryKey]);

  if (!localData && loading) {
    return (
      <div className="goal-progress-summary is-loading" aria-label="正在读取目标进度">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="goal-progress-skeleton" aria-hidden="true">
            <span />
            <strong />
          </div>
        ))}
      </div>
    );
  }

  if (!localData && (error || !data)) {
    return (
      <DataSyncNotice
        title="目标进度同步失败"
        message={error ?? "进度服务暂时无法连接，目标和任务仍可正常使用。"}
        retryLabel="重新加载"
        onRetry={() => setRetryKey((key) => key + 1)}
      />
    );
  }

  const resolvedData = localData ?? data;
  if (!resolvedData) return null;

  const completionPct = resolvedData.total_tasks > 0
    ? Math.round((resolvedData.completed_tasks / resolvedData.total_tasks) * 100)
    : 0;
  const progressDetail = `${resolvedData.completed_tasks}/${resolvedData.total_tasks} 项完成`;
  const debtDetail = resolvedData.debt_count > 0 ? "项待复习" : "暂无逾期知识";
  const streakDetail = resolvedData.streak_days > 0 ? "保持当前节奏" : "暂无连续记录";
  const progressStatus = completionPct >= 100 ? "已达标" : completionPct >= 50 ? "进行中" : "待加速";
  const debtStatus = resolvedData.debt_count > 0 ? "需关注" : "已清零";

  return (
    <div className="goal-progress-summary" aria-label="目标指标摘要">
      <div
        className="goal-metric-card goal-metric-card-progress"
        data-detail={`${progressDetail} · ${progressStatus}`}
        aria-label={`整体进度 ${completionPct}%，${progressDetail}，${progressStatus}`}
        tabIndex={0}
      >
        <div className="goal-progress-metric-heading">
          <CheckCircle2 size={15} aria-hidden="true" />
          <span>整体进度</span>
        </div>
        <strong className="goal-metric-primary-value">{completionPct}%</strong>
        <span className="goal-metric-hover-detail" aria-hidden="true">
          <span>{progressDetail}</span>
          <em className={completionPct >= 100 ? "is-ok" : completionPct >= 50 ? "is-neutral" : "is-warn"}>{progressStatus}</em>
        </span>
      </div>

      <div
        className={`goal-metric-card goal-metric-card-debt ${resolvedData.debt_count > 0 ? "is-alert" : ""}`}
        data-detail={`${debtDetail} · ${debtStatus}`}
        aria-label={`学习债务 ${resolvedData.debt_count}，${debtDetail}，${debtStatus}`}
        tabIndex={0}
      >
        <div className="goal-progress-metric-heading">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>学习债务</span>
        </div>
        <strong className="goal-metric-primary-value">{resolvedData.debt_count}</strong>
        <span className="goal-metric-hover-detail" aria-hidden="true">
          <span>{debtDetail}</span>
          <em className={resolvedData.debt_count > 0 ? "is-warn" : "is-ok"}>{debtStatus}</em>
        </span>
      </div>

      <div
        className="goal-metric-card goal-metric-card-streak"
        data-detail={streakDetail}
        aria-label={`连续学习 ${resolvedData.streak_days} 天，${streakDetail}`}
        tabIndex={0}
      >
        <div className="goal-progress-metric-heading">
          <Flame size={15} aria-hidden="true" />
          <span>连续学习</span>
        </div>
        <strong className="goal-metric-primary-value">{resolvedData.streak_days}<small>天</small></strong>
        <span className="goal-metric-hover-detail" aria-hidden="true"><span>{streakDetail}</span></span>
      </div>
    </div>
  );
}
