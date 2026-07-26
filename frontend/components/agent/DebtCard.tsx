"use client";
import { useState, useEffect, useCallback } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

interface DebtItem {
  id: string;
  goal_id: string;
  task_id: string | null;
  content: string;
  estimated_hours: number;
  skip_reason: string | null;
  impact: "low" | "medium" | "high";
  status: string;
  created_at: string;
}

const IMPACT_COLOR: Record<string, string> = {
  high:   "text-red-500 bg-red-50 border-red-100",
  medium: "text-amber-500 bg-amber-50 border-amber-100",
  low:    "text-blue-400 bg-blue-50 border-blue-100",
};
const IMPACT_LABEL: Record<string, string> = {
  high: "高", medium: "中", low: "低",
};

export function DebtCard({ goalId }: { goalId: string }) {
  const [debts, setDebts]       = useState<DebtItem[]>([]);
  const [loading, setLoading]   = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<DebtItem[]>(`/api/v1/debts/${goalId}`);
      setDebts(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => { load(); }, [load]);

  const resolve = async (id: string) => {
    setResolving(id);
    try {
      await api.patch(`/api/v1/debts/${id}/resolve`, {});
      setDebts((prev) => prev.filter((d) => d.id !== id));
    } catch {
      // ignore
    } finally {
      setResolving(null);
    }
  };

  if (loading) return null;
  if (!debts.length) return null;

  return (
    <div className="debt-card bg-white rounded-2xl border border-amber-100 overflow-hidden">
      <div className="debt-card-header px-4 py-3 border-b border-amber-50 flex items-center gap-2">
        <AlertTriangle size={14} className="debt-card-icon text-amber-500 flex-shrink-0" />
        <span className="debt-card-title text-xs font-semibold text-amber-700">学习债务 ({debts.length})</span>
      </div>
      <div className="divide-y divide-gray-50">
        {debts.map((d) => (
          <div key={d.id} className="px-4 py-3 flex items-start gap-3">
            <span className={cn(
              "mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0",
              IMPACT_COLOR[d.impact] ?? IMPACT_COLOR.medium,
            )}>
              {IMPACT_LABEL[d.impact] ?? "中"}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-700 leading-snug">{d.content}</p>
              {d.skip_reason && (
                <p className="text-[10px] text-gray-400 mt-0.5 truncate">原因：{d.skip_reason}</p>
              )}
              <p className="text-[10px] text-gray-400 mt-0.5">
                欠账 {d.estimated_hours.toFixed(1)}h · {d.created_at.slice(0, 10)}
              </p>
            </div>
            <button
              onClick={() => resolve(d.id)}
              disabled={resolving === d.id}
              className="debt-resolve flex-shrink-0 flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-lg border border-gray-200 text-gray-500 transition disabled:opacity-40"
            >
              {resolving === d.id
                ? <Loader2 size={10} className="animate-spin" />
                : <CheckCircle2 size={10} />}
              已补
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
