"use client";
import { useState } from "react";
import { type ReplanOption, type ReplanOptions } from "@/lib/stores/chatStore";

interface Props {
  options: ReplanOptions;
  onApplied?: (tasks: unknown[]) => void;
}

export function ReplanOptionsCard({ options, onApplied }: Props) {
  const [applying, setApplying] = useState<"a" | "b" | null>(null);
  const [applied, setApplied] = useState(false);

  const applyOption = async (key: "a" | "b") => {
    if (applying || applied) return;
    setApplying(key);
    const option: ReplanOption = key === "a" ? options.option_a : options.option_b;
    try {
      const token = localStorage.getItem("access_token");
      const res = await fetch(`/api/agent/replan/${options.goal_id}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ option }),
      });
      if (res.ok) {
        const data = await res.json();
        setApplied(true);
        onApplied?.(data.tasks ?? []);
      }
    } finally {
      setApplying(null);
    }
  };

  if (applied) {
    return (
      <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-700 font-medium">
        ✓ 重规划已应用，新任务已生成
      </div>
    );
  }

  const OptionCard = ({ optKey, opt }: { optKey: "a" | "b"; opt: ReplanOption }) => (
    <div className="flex-1 border border-gray-200 rounded-xl p-3 flex flex-col gap-2">
      <div>
        <span className="text-xs font-semibold text-gray-700">{opt.label}</span>
        <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>
      </div>
      {opt.new_daily_hours && (
        <p className="text-xs text-blue-600">每日 {opt.new_daily_hours}h</p>
      )}
      {opt.new_deadline && (
        <p className="text-xs text-blue-600">截止 {opt.new_deadline}</p>
      )}
      <p className="text-xs text-amber-600 italic">{opt.trade_off}</p>
      <button
        onClick={() => applyOption(optKey)}
        disabled={!!applying}
        className="mt-auto px-3 py-1.5 text-white text-xs rounded-lg transition disabled:opacity-50"
        style={{ backgroundColor: "var(--accent)" }}
      >
        {applying === optKey ? "应用中..." : "选择此方案"}
      </button>
    </div>
  );

  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-amber-800 mb-2">
        连续多天完成率偏低，请选择重规划方案：
      </p>
      <div className="flex gap-2">
        <OptionCard optKey="a" opt={options.option_a} />
        <OptionCard optKey="b" opt={options.option_b} />
      </div>
    </div>
  );
}
