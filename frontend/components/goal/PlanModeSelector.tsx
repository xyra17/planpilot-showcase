"use client";

import { useState, useEffect } from "react";
import { X, BookOpen, BookMarked, Brain, ChevronLeft, Loader2, BookText, Zap } from "lucide-react";
import { api } from "@/lib/api";

export type KbMode = "kb_only" | "kb_reference" | "no_kb";
export type PacingMode = "auto" | "fixed";

interface KbOverviewItem {
  title: string;
  char_count: number;
  estimated_pages: number;
}

interface PlanContextData {
  kb_overview: KbOverviewItem[];
  initial_understanding: string;
}

interface PlanModeSelectorProps {
  open: boolean;
  hasKb: boolean;
  goalId: string;
  goalType: "exam" | "certification" | "skill" | "reading" | "language" | "habit";
  goalTitle: string;
  onClose: () => void;
  onConfirm: (mode: KbMode, intentSupplement: string, pacingMode: PacingMode) => void;
}

const MODES: { value: KbMode; label: string; desc: string; icon: React.ReactNode; requiresKb: boolean }[] = [
  {
    value: "kb_only",
    label: "仅从知识库生成",
    desc: "AI 严格基于知识库内容制定计划，不引入库外知识",
    icon: <BookOpen size={16} className="text-blue-600" />,
    requiresKb: true,
  },
  {
    value: "kb_reference",
    label: "参考知识库生成",
    desc: "知识库作为补充参考，AI 结合外部知识生成更全面的计划",
    icon: <BookMarked size={16} className="text-green-600" />,
    requiresKb: true,
  },
  {
    value: "no_kb",
    label: "不参考知识库",
    desc: "AI 完全依据目标信息和通用知识生成计划",
    icon: <Brain size={16} className="text-purple-600" />,
    requiresKb: false,
  },
];

const INTENT_OPTIONS: Record<string, string[]> = {
  exam: [
    "高频考点和真题优先",
    "按模块分阶段，每阶段专项复习",
    "后期冲刺+错题回顾",
    "理解知识点优先于大量刷题",
  ],
  certification: [
    "按考纲章节系统覆盖",
    "每章配套官方真题/模拟题",
    "重点章节加权学习",
    "模拟考验收每个阶段",
  ],
  skill: [
    "理论学习后立即配套实战",
    "以项目为驱动，边学边做",
    "快速入门后深入某个方向",
    "系统学习，不跳过基础",
  ],
  reading: [
    "精读逐章，每章做笔记/摘要",
    "泛读为主，快速抓重点",
    "主题阅读，多书交叉参考",
    "读完每本书输出结构化总结",
  ],
  language: [
    "大量输入（听力+阅读）为主",
    "口语+听力为核心练习",
    "词汇积累+语法系统打底",
    "以考试为目标（四六级/雅思）",
  ],
  habit: [
    "从最小行为开始逐步递增",
    "固定时间地点形成条件反射",
    "先建立节奏，再提升质量",
    "配合打卡激励，不断链",
  ],
};

const INTENT_PLACEHOLDER: Record<string, string> = {
  exam: "例如：数学基础较弱，重点攻大题，最后两周集中刷真题押题…",
  certification: "例如：有一定会计基础，重点看财务报表章节，跳过已掌握的税法部分…",
  skill: "例如：已学过基础语法，希望重点练项目实战，跳过前3章基础部分…",
  reading: "例如：想重点精读第3-5章，每章输出思维导图，附录部分可跳过…",
  language: "例如：词汇量约4000，口语较弱，希望多练听说，跳过初级语法复习…",
  habit: "例如：之前断过几次，早上执行更容易坚持，希望先从10分钟开始慢慢增加…",
};

export default function PlanModeSelector({
  open, hasKb, goalId, goalType, goalTitle, onClose, onConfirm,
}: PlanModeSelectorProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedMode, setSelectedMode] = useState<KbMode | null>(null);
  const [contextData, setContextData] = useState<PlanContextData | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [freeText, setFreeText] = useState("");
  const [pacingMode, setPacingMode] = useState<PacingMode>("fixed");
  const [intentPlaceholder, setIntentPlaceholder] = useState("");

  useEffect(() => {
    if (!open) {
      setStep(1);
      setSelectedMode(null);
      setContextData(null);
      setSelectedOptions(new Set());
      setFreeText("");
      setPacingMode("fixed");
      setIntentPlaceholder("");
    }
  }, [open]);

  async function handleNextStep(mode: KbMode) {
    setSelectedMode(mode);
    setStep(2);
    setContextLoading(true);
    try {
      const [contextResult, placeholderResult] = await Promise.allSettled([
        api.get<PlanContextData>(`/api/v1/agent/plan-context/${goalId}`),
        api.get<{ placeholder: string }>(`/api/v1/agent/intent-placeholder/${goalId}`),
      ]);
      const data = contextResult.status === "fulfilled"
        ? contextResult.value
        : { kb_overview: [], initial_understanding: "" };
      setContextData(data);
      if (data.kb_overview.length > 0) setPacingMode("auto");
      if (placeholderResult.status === "fulfilled" && placeholderResult.value.placeholder) {
        setIntentPlaceholder(placeholderResult.value.placeholder);
      }
    } finally {
      setContextLoading(false);
    }
  }

  function toggleOption(opt: string) {
    setSelectedOptions((prev) => {
      const next = new Set(prev);
      if (next.has(opt)) { next.delete(opt); } else { next.add(opt); }
      return next;
    });
  }

  function handleConfirm() {
    if (!selectedMode) return;
    const optionLines = Array.from(selectedOptions).map((o) => `- ${o}`).join("\n");
    const combined = [optionLines, freeText.trim()].filter(Boolean).join("\n");
    onConfirm(selectedMode, combined, pacingMode);
  }

  if (!open) return null;

  const intentOptions = INTENT_OPTIONS[goalType] ?? INTENT_OPTIONS.skill;
  const displayPlaceholder = intentPlaceholder || (INTENT_PLACEHOLDER[goalType] ?? INTENT_PLACEHOLDER.skill);
  const hasKbOverview = (contextData?.kb_overview?.length ?? 0) > 0;
  const canConfirm = freeText.trim().length > 0 || selectedOptions.size > 0;

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-label="选择计划生成方式" className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            {step === 2 && (
              <button type="button" onClick={() => setStep(1)} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400">
                <ChevronLeft size={15} />
              </button>
            )}
            <span className="text-sm font-semibold text-gray-800">
              {step === 1 ? "步骤一：选择知识库模式" : "步骤二：描述学习意图"}
            </span>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400">
            <X size={16} />
          </button>
        </div>

        {step === 1 ? (
          <div className="p-4 space-y-2">
            {MODES.map((m) => {
              const disabled = m.requiresKb && !hasKb;
              return (
                <button
                  key={m.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleNextStep(m.value)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition ${
                    disabled
                      ? "border-gray-100 bg-gray-50 opacity-40 cursor-not-allowed"
                      : "border-gray-200 hover:border-blue-300 hover:bg-blue-50"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    {m.icon}
                    <span className="text-sm font-medium text-gray-800">{m.label}</span>
                    {m.requiresKb && !hasKb && (
                      <span className="text-xs text-gray-400 ml-auto">需关联知识库</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 pl-6">{m.desc}</p>
                </button>
              );
            })}
          </div>
        ) : contextLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-gray-400 text-sm">
            <Loader2 size={15} className="animate-spin" />加载中…
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto p-4 space-y-4">
            {contextData?.initial_understanding && (
              <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
                <p className="text-xs font-medium text-blue-600 mb-1.5">AI 的初步理解</p>
                <p className="text-xs text-blue-800 leading-relaxed">{contextData.initial_understanding}</p>
              </div>
            )}

            {hasKbOverview && (
              <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                <p className="text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <BookText size={12} />知识库文档
                </p>
                <div className="space-y-1">
                  {contextData!.kb_overview.map((item, i) => (
                    <div key={i} className="flex items-center justify-between text-xs text-gray-600">
                      <span className="truncate flex-1 mr-2">《{item.title}》</span>
                      <span className="text-gray-400 flex-shrink-0">约 {item.estimated_pages} 页</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">快速选择（可多选）</p>
              <div className="grid grid-cols-2 gap-1.5">
                {intentOptions.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => toggleOption(opt)}
                    className={`text-left text-xs px-3 py-2 rounded-lg border transition leading-snug ${
                      selectedOptions.has(opt)
                        ? "border-blue-300 bg-blue-50 text-blue-700"
                        : "border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-gray-500 mb-1.5">
                补充说明
                <span className="ml-1 font-normal text-gray-400">（描述你的基础、重点、跳过内容等）</span>
              </p>
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder={displayPlaceholder}
                rows={3}
                className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none transition"
              />
            </div>

            {hasKbOverview && (
              <div className="flex items-center justify-between px-3 py-2.5 rounded-xl border border-gray-100 bg-gray-50">
                <div className="flex items-center gap-1.5">
                  <Zap size={13} className="text-amber-500" />
                  <span className="text-xs font-medium text-gray-700">自动估算学习节奏</span>
                  <span className="text-xs text-gray-400">（按 KB 字数）</span>
                </div>
                <button
                  type="button"
                  onClick={() => setPacingMode((p) => (p === "auto" ? "fixed" : "auto"))}
                  className={`relative w-9 h-5 rounded-full transition-colors ${
                    pacingMode === "auto" ? "bg-blue-600" : "bg-gray-300"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      pacingMode === "auto" ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            )}

            <button
              type="button"
              disabled={!canConfirm}
              onClick={handleConfirm}
              className="w-full py-2.5 rounded-xl text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              开始生成
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
