"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import {
  X, ChevronLeft, Loader2, BookText, BookOpen, BookMarked, Brain,
  Zap, Check, Link2, Search, SlidersHorizontal,
} from "lucide-react";
import { api } from "@/lib/api";
import { productApi, type ApiKnowledgeFile } from "@/lib/technology/productApi";

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
  error?: string;
  onConfirm: (mode: KbMode, intentSupplement: string, pacingMode: PacingMode) => void;
}

const MODES: { value: KbMode; label: string; desc: string; requiresKb: boolean; icon: typeof BookOpen }[] = [
  {
    value: "kb_only",
    label: "仅从参考资料生成",
    desc: "AI 严格基于已关联资料制定计划，不引入资料外知识",
    requiresKb: true,
    icon: BookOpen,
  },
  {
    value: "kb_reference",
    label: "结合参考资料生成",
    desc: "已关联资料作为补充参考，AI 结合通用知识生成更完整的计划",
    requiresKb: true,
    icon: BookMarked,
  },
  {
    value: "no_kb",
    label: "暂不使用参考资料",
    desc: "AI 完全依据目标信息和通用知识生成计划",
    requiresKb: false,
    icon: Brain,
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
  open, hasKb, goalId, goalType, goalTitle, onClose, error, onConfirm,
}: PlanModeSelectorProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedMode, setSelectedMode] = useState<KbMode | null>(null);
  const [contextData, setContextData] = useState<PlanContextData | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [freeText, setFreeText] = useState("");
  const [pacingMode, setPacingMode] = useState<PacingMode>("fixed");
  const [intentPlaceholder, setIntentPlaceholder] = useState("");
  const [referenceFiles, setReferenceFiles] = useState<ApiKnowledgeFile[]>([]);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<Set<string>>(new Set());
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referencesError, setReferencesError] = useState("");
  const [savingReferences, setSavingReferences] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setStep(1);
      setSelectedMode(null);
      setContextData(null);
      setSelectedOptions(new Set());
      setFreeText("");
      setPacingMode("fixed");
      setIntentPlaceholder("");
      setReferenceFiles([]);
      setSelectedReferenceIds(new Set());
      setReferencesError("");
      setSavingReferences(false);
      setReferenceQuery("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !goalId) return;
    let active = true;
    setReferencesLoading(true);
    setReferencesError("");
    void productApi.listKnowledgeFiles()
      .then((items) => {
        if (!active) return;
        setReferenceFiles(items.filter((item) => item.status !== "failed"));
        setSelectedReferenceIds(new Set(items.filter((item) => item.goalIds.includes(goalId)).map((item) => item.id)));
      })
      .catch(() => {
        if (!active) return;
        setReferenceFiles([]);
        setReferencesError("暂时无法读取参考资料，你仍可选择不使用资料生成。");
      })
      .finally(() => { if (active) setReferencesLoading(false); });
    return () => { active = false; };
  }, [goalId, open]);

  function toggleReference(fileId: string) {
    setSelectedReferenceIds((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

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
      const selectedOverview = referenceFiles
        .filter((item) => selectedReferenceIds.has(item.id))
        .map((item) => ({ title: item.name, char_count: item.contentLength, estimated_pages: Math.max(1, Math.ceil(item.contentLength / 600)) }));
      setContextData({ ...data, kb_overview: selectedOverview.length ? selectedOverview : data.kb_overview });
      if (selectedOverview.length > 0 || data.kb_overview.length > 0) setPacingMode("auto");
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

  async function handleConfirm() {
    if (!selectedMode) return;
    setSavingReferences(true);
    setReferencesError("");
    try {
      const changes = referenceFiles.filter((item) => item.goalIds.includes(goalId) !== selectedReferenceIds.has(item.id));
      await Promise.all(changes.map((item) => productApi.updateKnowledgeFile(item.id, {
        goal_ids: selectedReferenceIds.has(item.id)
          ? Array.from(new Set([...item.goalIds, goalId]))
          : item.goalIds.filter((id) => id !== goalId),
      })));
    } catch {
      setReferencesError("资料关联保存失败，请重试后再生成计划。");
      setSavingReferences(false);
      return;
    }
    const optionLines = Array.from(selectedOptions).map((o) => `- ${o}`).join("\n");
    const combined = [optionLines, freeText.trim()].filter(Boolean).join("\n");
    onConfirm(selectedMode, combined, pacingMode);
    setSavingReferences(false);
  }

  const visibleReferenceFiles = useMemo(() => {
    const query = referenceQuery.trim().toLocaleLowerCase("zh-CN");
    return referenceFiles
      .filter((item) => !query || item.name.toLocaleLowerCase("zh-CN").includes(query))
      .sort((a, b) => Number(selectedReferenceIds.has(b.id)) - Number(selectedReferenceIds.has(a.id)));
  }, [referenceFiles, referenceQuery, selectedReferenceIds]);

  if (!open) return null;

  const intentOptions = INTENT_OPTIONS[goalType] ?? INTENT_OPTIONS.skill;
  const displayPlaceholder = intentPlaceholder || (INTENT_PLACEHOLDER[goalType] ?? INTENT_PLACEHOLDER.skill);
  const hasKbOverview = (contextData?.kb_overview?.length ?? 0) > 0;
  const hasSelectedReferences = selectedReferenceIds.size > 0 || hasKb;
  const canConfirm = Boolean(selectedMode) && !savingReferences;

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-label="选择计划生成方式" className="journal-dialog plan-mode-dialog bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="plan-mode-dialog-title flex items-center gap-2">
            {step === 2 && (
              <button type="button" aria-label="返回资料使用方式" onClick={() => setStep(1)} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400">
                <ChevronLeft size={15} />
              </button>
            )}
            <strong className="plan-mode-dialog-title-copy text-gray-800">
              {step === 1 ? "生成学习计划" : "补充学习意图"}
            </strong>
          </div>
          <button type="button" aria-label="关闭计划设置" onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400">
            <X size={16} />
          </button>
        </div>
        {error && <p className="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700" role="alert">{error}</p>}

        {step === 1 ? (
          <div className="plan-mode-first-step p-4 space-y-3">
            <section className="plan-mode-reference-section">
              <header className="plan-mode-section-heading">
                <span className="plan-mode-section-icon"><Link2 size={15} /></span>
                <div><strong>关联参考资料</strong><small>为「{goalTitle || "当前目标"}」选择本次计划可使用的资料</small></div>
                <span>{selectedReferenceIds.size ? `已选 ${selectedReferenceIds.size} 份` : "可选"}</span>
              </header>
              {referenceFiles.length > 4 && (
                <label className="plan-mode-reference-search"><Search size={13} /><input value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} placeholder={`搜索 ${referenceFiles.length} 份资料`} /></label>
              )}
              {referencesLoading ? (
                <p className="plan-mode-reference-empty"><Loader2 size={13} className="animate-spin" />正在读取资料…</p>
              ) : referenceFiles.length ? (
                <div className="plan-mode-reference-list">
                  {visibleReferenceFiles.map((file) => {
                    const selected = selectedReferenceIds.has(file.id);
                    return <button key={file.id} type="button" className={selected ? "is-selected" : ""} aria-pressed={selected} onClick={() => toggleReference(file.id)}><span><BookText size={13} /><b>{file.name}</b></span><i>{selected && <Check size={12} />}</i></button>;
                  })}
                  {!visibleReferenceFiles.length && <p className="plan-mode-reference-no-result">没有匹配的资料</p>}
                </div>
              ) : (
                <p className="plan-mode-reference-empty">暂无可选资料。<Link href="/studio/work/knowledge">前往知识库添加</Link></p>
              )}
              {referencesError && <p className="plan-mode-reference-error" role="alert">{referencesError}</p>}
            </section>
            <div className="plan-mode-section-heading plan-mode-choice-heading"><span className="plan-mode-section-icon"><SlidersHorizontal size={15} /></span><div><strong>选择生成方式</strong><small>确定参考资料在计划中的使用边界</small></div></div>
            <ol className="plan-mode-option-list" aria-label="计划生成方式">
              {MODES.map((m, index) => {
                const disabled = m.requiresKb && !hasSelectedReferences;
                const ModeIcon = m.icon;
                return (
                  <li key={m.value}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => handleNextStep(m.value)}
                      className={`plan-mode-option w-full text-left transition ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
                    >
                      <span className="plan-mode-option-index" aria-hidden="true">0{index + 1}</span>
                      <span className="plan-mode-option-content">
                        <span className="plan-mode-option-heading">
                          <span className="plan-mode-option-icon" aria-hidden="true"><ModeIcon size={15} /></span>
                          <strong className="plan-mode-option-title text-gray-800">{m.label}</strong>
                        </span>
                        <small className="plan-mode-option-description text-gray-500">{m.desc}</small>
                      </span>
                      {m.requiresKb && !hasSelectedReferences && (
                        <span className="plan-mode-option-requirement text-gray-400 ml-auto">需先关联资料</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : contextLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-gray-400 text-sm">
            <Loader2 size={15} className="animate-spin" />加载中…
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto p-4 space-y-4">
            {contextData?.initial_understanding && (
              <div className="rounded-xl border border-accent-muted bg-accent-light px-4 py-3">
                <p className="text-xs font-medium text-accent mb-1.5">AI 的初步理解</p>
                <p className="text-xs text-accent-dark leading-relaxed">{contextData.initial_understanding}</p>
              </div>
            )}

            {hasKbOverview && (
              <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                <p className="text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1">
                  <BookText size={12} />参考资料
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
                        ? "border-accent-muted bg-accent-light text-accent-dark"
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
                className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-none transition"
              />
            </div>

            {hasKbOverview && (
              <div className="plan-mode-pacing-row">
                <div>
                  <span className="plan-mode-pacing-icon"><Zap size={13} /></span>
                  <span><strong>自动估算学习节奏</strong><small>根据所选资料的内容量调整阶段时长</small></span>
                </div>
                <button
                  type="button"
                  aria-label="切换自动估算学习节奏"
                  aria-pressed={pacingMode === "auto"}
                  onClick={() => setPacingMode((p) => (p === "auto" ? "fixed" : "auto"))}
                  className={`relative w-9 h-5 rounded-full transition-colors ${
                    pacingMode === "auto" ? "bg-accent" : "bg-gray-300"
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
              onClick={() => void handleConfirm()}
              className="w-full py-2.5 rounded-xl text-sm font-medium bg-accent text-white hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {savingReferences ? <><Loader2 size={14} className="animate-spin inline mr-1" />正在保存资料关联…</> : "开始生成"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
