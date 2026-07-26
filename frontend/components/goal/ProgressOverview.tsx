"use client";
import { useEffect, useState } from "react";
import { TrendingUp, TrendingDown, Minus, Flame, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";

interface ProgressData {
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

type BadgeKind = "ok" | "warn" | "neutral";

function Badge({ kind, label }: { kind: BadgeKind; label: string }) {
  const styles: Record<BadgeKind, { text: string; bg: string }> = {
    ok:      { text: "var(--ok-text,#5B8C74)",   bg: "var(--ok-bg,#EEF4F1)" },
    warn:    { text: "var(--warn-text,#B07D4A)", bg: "var(--warn-bg,#F6F1EA)" },
    neutral: { text: "var(--accent)",            bg: "var(--accent-light)" },
  };
  const s = styles[kind];
  return (
    <span
      className={`goal-metric-badge goal-metric-badge-${kind} inline-flex min-w-[36px] items-center justify-center px-1.5 py-0.5 text-[10px] font-medium flex-shrink-0`}
      style={{ color: s.text, backgroundColor: s.bg }}
    >
      {label}
    </span>
  );
}

export function ProgressOverview({ goalId, refreshKey = 0 }: { goalId: string; refreshKey?: number }) {
  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get<ProgressData>(`/api/v1/goals/${goalId}/progress`)
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [goalId, refreshKey]);

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="flex justify-end gap-3">
          <div className="h-4 w-14 rounded bg-gray-100 animate-pulse" />
          <div className="h-4 w-14 rounded bg-gray-100 animate-pulse" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const hasAnyProgress = data.total_tasks > 0 || data.streak_days > 0 || data.avg_completion_rate > 0;
  if (!hasAnyProgress) {
    return (
      <div className="rounded-xl border border-gray-100 bg-white px-4 py-3 text-center">
        <p className="text-xs text-gray-400">计划生成后展示</p>
      </div>
    );
  }

  const completionPct = data.total_tasks > 0
    ? Math.round((data.completed_tasks / data.total_tasks) * 100)
    : 0;

  const daysSign = data.days_ahead_or_behind;
  const hasTrend = daysSign !== null;
  const TrendIcon = !hasTrend ? Minus : daysSign > 0 ? TrendingUp : daysSign < 0 ? TrendingDown : Minus;
  const avgPct = Math.round(data.avg_completion_rate * 100);
  const cardStyle = { borderColor: "var(--border-subtle)", boxShadow: "0 1px 2px rgba(0,0,0,0.03),0 4px 12px rgba(0,0,0,0.03)" };

  return (
    <div className="grid grid-cols-2 gap-2">
      {/* 整体进度 */}
      <div className="bg-white rounded-xl border p-2.5" style={cardStyle}>
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <div className="goal-metric-icon w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
              <CheckCircle2 size={10} style={{ color: "var(--accent)" }} />
            </div>
            <span className="text-xs font-semibold text-gray-700">整体进度</span>
          </div>
          <Badge
            kind={completionPct >= 100 ? "ok" : completionPct >= 50 ? "neutral" : "warn"}
            label={completionPct >= 100 ? "已达标" : completionPct >= 50 ? "进行中" : "待加速"}
          />
        </div>
        <div className="flex items-baseline gap-1 mb-1.5">
          <span className="text-sm font-semibold tracking-tight text-gray-900">{data.total_tasks > 0 ? `${completionPct}%` : "--"}</span>
          {data.total_tasks > 0 && <span className="text-[10px] text-gray-400">{data.completed_tasks}/{data.total_tasks}</span>}
        </div>
        <div className="w-full h-1 rounded-full bg-gray-100 overflow-hidden">
          <div className="h-1 rounded-full transition-all" style={{ width: `${completionPct}%`, backgroundColor: "var(--accent)" }} />
        </div>
      </div>

      {/* 学习债务 */}
      <div className="bg-white rounded-xl border p-2.5" style={cardStyle}>
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <div className="goal-metric-icon w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: data.debt_count > 0 ? "var(--warn-bg,#F6F1EA)" : "var(--ok-bg,#EEF4F1)" }}>
              <AlertTriangle size={10} style={{ color: data.debt_count > 0 ? "var(--warn-text,#B07D4A)" : "var(--ok-text,#5B8C74)" }} />
            </div>
            <span className="text-xs font-semibold text-gray-700">学习债务</span>
          </div>
          <Badge kind={data.debt_count > 0 ? "warn" : "ok"} label={data.debt_count > 0 ? "需关注" : "清零"} />
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-sm font-semibold tracking-tight text-gray-900">{data.total_tasks > 0 ? data.debt_count : "--"}</span>
          {data.total_tasks > 0 && data.debt_count > 0 && <span className="text-[10px] text-gray-400">项逾期</span>}
          {data.total_tasks > 0 && data.debt_count === 0 && <span className="text-[10px] text-gray-400">已清零</span>}
        </div>
      </div>

      {/* 近7日 — 数值在右上角 */}
      <div className="bg-white rounded-xl border p-2.5" style={cardStyle}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <div className="goal-metric-icon w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
              <TrendIcon size={10} style={{ color: "var(--accent)" }} />
            </div>
            <span className="text-xs font-semibold text-gray-700">近7日</span>
          </div>
          <span className="text-sm font-semibold tracking-tight text-gray-900">{avgPct > 0 ? `${avgPct}%` : "--"}</span>
        </div>
        <p className="text-[10px]" style={{
          color: !hasTrend ? "#9ca3af" : daysSign > 0 ? "var(--ok-text,#5B8C74)" : daysSign < 0 ? "var(--warn-text,#B07D4A)" : "#9ca3af"
        }}>
          {!hasTrend ? "数据积累中" : daysSign > 0 ? `超前 ${daysSign} 天` : daysSign < 0 ? `落后 ${Math.abs(daysSign)} 天` : "按时"}
        </p>
      </div>

      {/* 连续打卡 — 数值在右上角 */}
      <div className="bg-white rounded-xl border p-2.5" style={cardStyle}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <div className="goal-metric-icon w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: data.streak_days >= 7 ? "#FFF7ED" : "var(--accent-light)" }}>
              <Flame size={10} style={{ color: data.streak_days >= 7 ? "#F97316" : "var(--accent)" }} />
            </div>
            <span className="text-xs font-semibold text-gray-700">连续打卡</span>
          </div>
          <div className="flex items-baseline gap-0.5">
            <span className="text-sm font-semibold tracking-tight text-gray-900">{data.streak_days}</span>
            <span className="text-[10px] text-gray-400">天</span>
          </div>
        </div>
        <p className="text-[10px]" style={{ color: data.streak_days >= 7 ? "#F97316" : "var(--ok-text,#5B8C74)" }}>
          {data.streak_days >= 7 ? "习惯养成中 🔥" : data.streak_days > 0 ? "坚持中，继续！" : "暂无打卡记录"}
        </p>
      </div>
    </div>
  );
}
