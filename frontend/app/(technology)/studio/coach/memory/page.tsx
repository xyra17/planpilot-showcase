"use client";

import {
  Activity,
  ArrowRight,
  BarChart3,
  BrainCircuit,
  CalendarRange,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Database,
  FileSearch,
  FlaskConical,
  Gauge,
  History,
  Layers3,
  LineChart,
  LoaderCircle,
  MessageCircle,
  Pause,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Target,
  Trash2,
  TrendingUp,
  UserRoundCheck,
  UsersRound,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/components/technology/AuthProvider";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/Toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type ActivePattern,
  type CoreValidationReport,
  type DecisionContext,
  type ManagedPattern,
  type PatternAudit,
  type ValidationSnapshot,
  learnerApi,
} from "@/lib/learner-api";
import { productApi, type ApiGoal } from "@/lib/technology/productApi";
import { signalPiloContext } from "@/lib/technology/piloContext";

type PatternGroup = "all" | "temporal" | "behavior" | "knowledge";
type MemoryView = "observations" | "memories" | "validation" | "history";

const PATTERN_META: Record<string, { label: string; group: PatternGroup; icon: typeof Clock3 }> = {
  preferred_learning_time: { label: "学习时段", group: "temporal", icon: Clock3 },
  preferred_session_length: { label: "专注时长", group: "temporal", icon: Clock3 },
  weekly_learning_frequency: { label: "学习频率", group: "temporal", icon: History },
  completion_rate_trend: { label: "完成趋势", group: "behavior", icon: Activity },
  mastery_velocity: { label: "掌握节奏", group: "knowledge", icon: BrainCircuit },
  delay_pattern: { label: "延期模式", group: "behavior", icon: History },
  plan_adherence: { label: "计划执行", group: "behavior", icon: Target },
  estimation_accuracy: { label: "估时特征", group: "behavior", icon: Activity },
};

const EVENT_LABELS: Record<string, string> = {
  TaskCompleted: "完成任务",
  TaskRescheduled: "调整任务时间",
  CheckinSubmitted: "提交学习反馈",
  MasteryRecorded: "更新掌握状态",
  ProposalFeedbackRecorded: "反馈建议效果",
};

function confidenceMeta(value: number) {
  if (value >= 0.78) return { label: "相对稳定信号", tone: "repeated", copy: "这条信号在当前模型中置信度较高，但仍不是经过实验验证的事实。" };
  if (value >= 0.55) return { label: "初步信号", tone: "forming", copy: "这条信号已有一定证据，还需要更多真实执行和你的反馈。" };
  return { label: "弱信号", tone: "observing", copy: "目前证据较弱，不应作为强约束影响规划。" };
}

function scopeLabel(pattern: ActivePattern) {
  return pattern.goal_id ? "仅当前目标" : pattern.scope === "user" ? "跨目标观察" : "特定学习类型";
}

function formatEventDate(value: string | null) {
  if (!value) return "历史记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatUpdatedDate(value: string | null) {
  if (!value) return "仍在观察";
  return `${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value))} 更新`;
}

function formatObservedSince(value: string | null | undefined) {
  if (!value) return "起始时间待补齐";
  return `${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric" }).format(new Date(value))} 起`;
}

function patternImpact(pattern: ActivePattern) {
  const copies: Record<string, string> = {
    preferred_learning_time: "安排高认知任务时，会优先参考这段时间。",
    preferred_session_length: "拆分任务时，会参考这一专注时长。",
    weekly_learning_frequency: "制定周计划时，会避免把学习集中在少数几天。",
    completion_rate_trend: "调整计划强度时，会参考近期完成趋势。",
    mastery_velocity: "安排新内容与复习比例时，会参考近期掌握节奏。",
    delay_pattern: "识别延期风险时，会更早提供恢复节奏的建议。",
    plan_adherence: "计划偏离后，会优先建议恢复连续性。",
    estimation_accuracy: "估算任务时长时，会为容易低估的任务预留余量。",
  };
  return copies[pattern.pattern_type] ?? "生成学习建议时，会把它作为一条可校正的参考信号。";
}

function patternEvidenceLabel(pattern: ActivePattern) {
  const summary = pattern.evidence_summary;
  if (!summary) return `${pattern.evidence_count} 条证据`;
  return `支持 ${summary.supporting_count} · 反向 ${summary.opposing_count}`;
}

function validationStatusMeta(status: CoreValidationReport["status"] | undefined) {
  if (status === "supported") return { label: "已支持", tone: "supported" };
  if (status === "not_supported") return { label: "不支持", tone: "unsupported" };
  if (status === "insufficient_data") return { label: "数据不足", tone: "insufficient" };
  if (status === "not_configured") return { label: "未配置", tone: "unconfigured" };
  return { label: "尚未运行", tone: "pending" };
}

function formatScore(value: number | null | undefined, digits = 3) {
  return typeof value === "number" ? value.toFixed(digits) : "—";
}

function formatPointDelta(value: number | null | undefined) {
  if (typeof value !== "number") return "—";
  const points = value * 100;
  return `${points > 0 ? "+" : ""}${points.toFixed(1)}pp`;
}

function formatInterval(value: [number, number] | null | undefined) {
  if (!value) return "—";
  return `${formatPointDelta(value[0])} ~ ${formatPointDelta(value[1])}`;
}

function sampleProgress(current: number, minimum: number | undefined) {
  if (!minimum) return 0;
  return Math.min(100, Math.round((current / minimum) * 100));
}

function percent(value: number | null | undefined) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "—";
}

function RetentionCurve({ profile }: { profile: DecisionContext["cognitive_profile"] }) {
  const curve = profile?.retention_curve ?? [];
  if (curve.length < 2) {
    return <div className="memory-chart-empty"><LineChart size={19} /><span>保持曲线会在有足够掌握记录后出现</span></div>;
  }
  const minDay = Math.min(...curve.map((point) => point.day));
  const maxDay = Math.max(...curve.map((point) => point.day));
  const dayRange = maxDay - minDay;
  const positionedPoints = curve.map((point, index) => {
    const value = Math.max(0, Math.min(1, point.retention));
    const xRatio = dayRange > 0 ? (point.day - minDay) / dayRange : index / Math.max(1, curve.length - 1);
    return {
      day: point.day,
      value,
      x: 40 + xRatio * 920,
      xPercent: 4 + xRatio * 92,
      y: 78 - value * 60,
      yPercent: 18 + (1 - value) * 60,
    };
  });
  let previousLabelX = Number.NEGATIVE_INFINITY;
  const points = positionedPoints.map((point, index) => {
    const showLabel = index === 0 || index === positionedPoints.length - 1 || point.xPercent - previousLabelX >= 11;
    if (showLabel) previousLabelX = point.xPercent;
    return { ...point, showLabel };
  });
  const linePath = points.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1];
    const midpoint = (previous.x + point.x) / 2;
    return `${path} C ${midpoint} ${previous.y}, ${midpoint} ${point.y}, ${point.x} ${point.y}`;
  }, "");
  const areaPath = `${linePath} L ${points.at(-1)?.x ?? 960} 82 L ${points[0]?.x ?? 40} 82 Z`;
  return (
    <div className="memory-retention-chart" role="img" aria-label="学习内容保持率随时间变化的曲线" aria-describedby="memory-retention-description">
      <span className="sr-only" id="memory-retention-description">{points.map((point) => `${point.day === 0 ? "今天" : `${point.day}天`} ${Math.round(point.value * 100)}%`).join("，")}</span>
      <div className="memory-retention-scale" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
      <div className="memory-retention-stage" aria-hidden="true">
        <svg className="memory-retention-plot" viewBox="0 0 1000 100" preserveAspectRatio="none">
          <defs>
            <linearGradient id="memory-retention-stroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="var(--memory-focus-color)" />
              <stop offset="0.55" stopColor="var(--memory-signal-color)" />
              <stop offset="1" stopColor="var(--memory-sky-color)" />
            </linearGradient>
            <linearGradient id="memory-retention-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--memory-focus-color)" stopOpacity="0.3" />
              <stop offset="0.72" stopColor="var(--memory-signal-color)" stopOpacity="0.08" />
              <stop offset="1" stopColor="var(--memory-signal-color)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path className="memory-retention-grid-line" d="M 40 18 H 960 M 40 48 H 960 M 40 78 H 960" />
          <path className="memory-retention-area" d={areaPath} />
          <path className="memory-retention-glow" d={linePath} pathLength="1" />
          <path className="memory-retention-line" d={linePath} pathLength="1" />
        </svg>
        <div className="memory-retention-nodes">
          {points.map((point, index) => (
            <span
              className={`memory-retention-node ${index === 0 ? "is-start" : ""} ${index === points.length - 1 ? "is-end" : ""}`}
              key={point.day}
              style={{ left: `${point.xPercent}%`, top: `${point.yPercent}%` }}
              title={`${point.day === 0 ? "今天" : `${point.day}天`} · 模型估计保持率 ${Math.round(point.value * 100)}%`}
            >
              {point.showLabel ? <b>{Math.round(point.value * 100)}%</b> : null}<i />
            </span>
          ))}
        </div>
        <div className="memory-retention-axis-labels">
          {points.filter((point) => point.showLabel).map((point, index, labels) => <span className={index === 0 ? "is-start" : index === labels.length - 1 ? "is-end" : ""} key={point.day} style={{ left: `${point.xPercent}%` }}>{point.day === 0 ? "今天" : `${point.day}天`}</span>)}
        </div>
      </div>
      <span className="memory-chart-caption">模型估计的记忆保持率；不是对个人能力的评分。</span>
    </div>
  );
}

function MemoryFlow({
  context,
  patterns,
  onSelectView,
  onSelectPattern,
}: {
  context: DecisionContext | null;
  patterns: ActivePattern[];
  onSelectView: (view: MemoryView) => void;
  onSelectPattern: (patternId: string) => void;
}) {
  const memories = context?.memories;
  const eventCount = context?.data_quality.profile_event_count ?? 0;
  const recordedMemoryCount = (memories?.short_term.length ?? 0) + (memories?.episodic.length ?? 0) + (memories?.semantic.length ?? 0);
  const pendingReviewCount = patterns.filter((pattern) => !pattern.user_review_status).length;
  const featured = patterns[0] ?? null;
  const stages = [
    { label: "行为记录", note: "完成、调整、反馈", value: eventCount, suffix: "条", icon: Activity, view: "memories" as MemoryView },
    { label: "学习记忆", note: "短期、经历与长期知识", value: recordedMemoryCount, suffix: "条", icon: History, view: "memories" as MemoryView },
    { label: "学习观察", note: "有证据才会形成规律", value: patterns.length, suffix: "条", icon: BrainCircuit, view: "observations" as MemoryView },
    { label: "待你核对", note: "确认后才持续参与建议", value: pendingReviewCount, suffix: "条", icon: UserRoundCheck, view: "observations" as MemoryView },
  ];
  return (
    <section className="memory-flow-hero" aria-label="学习记忆形成路径">
      <div className="memory-flow-heading">
        <small>LEARNING MEMORY</small>
        <h2>从记录到建议，PlanPilot 只保留有证据的规律。</h2>
        <p>上方展示记忆如何形成；下方只列出当前会参与建议、并且可以由你核对的观察。</p>
      </div>
      <div className="memory-flow-visual">
        <ol className="memory-flow-steps">
          {stages.map(({ label, note, value, suffix, icon: Icon, view }, index) => (
            <li key={label} className={`is-step-${index + 1}`}>
              <button type="button" onClick={() => onSelectView(view)} aria-label={`查看${label}`}>
                <span className="memory-flow-node"><Icon size={17} /></span>
                <span className="memory-flow-step-copy"><strong>{label}</strong><small>{note}</small></span>
                <b>{value}<em>{suffix}</em></b>
              </button>
            </li>
          ))}
        </ol>
        <article className={`memory-featured-observation ${featured ? "" : "is-empty"}`}>
          <div className="memory-featured-label"><span>{featured ? "最近形成的观察" : "观察正在积累"}</span>{featured && <b>{confidenceMeta(featured.confidence).label}</b>}</div>
          {featured ? <>
            <strong>{featured.explanation}</strong>
            <p>{patternImpact(featured)}</p>
            <div><span>{patternEvidenceLabel(featured)}</span><span>{scopeLabel(featured)}</span><button type="button" onClick={() => onSelectPattern(featured.id)}>查看依据 <ArrowRight size={13} /></button></div>
          </> : <p>继续完成任务并反馈建议效果，重复出现的信号才会进入这里。</p>}
        </article>
      </div>
    </section>
  );
}

function MetricHint({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="memory-metric-hint" aria-label={label}><CircleHelp size={13} /></button>
      </TooltipTrigger>
      <TooltipContent className="memory-help-tooltip" side="top" sideOffset={7} collisionPadding={14}>{children}</TooltipContent>
    </Tooltip>
  );
}

function ValidationResults({ snapshot }: { snapshot: ValidationSnapshot | null }) {
  const reduceMotion = useReducedMotion();
  const reports = new Map(snapshot?.reports.map((report) => [report.experiment_key, report]) ?? []);
  const pattern = reports.get("pattern_validity");
  const prediction = reports.get("prediction_calibration");
  const proposal = reports.get("proposal_utility");
  const personalization = reports.get("personalization_lift");
  const patternBuckets = pattern?.result.buckets ? Object.values(pattern.result.buckets) : [];
  const patternSamples = patternBuckets.length ? Math.min(...patternBuckets.map((bucket) => bucket.sample_count)) : 0;
  const predictionSamples = prediction?.result.outcome_count ?? 0;
  const proposalSamples = proposal?.result.seven_day?.sample_count ?? 0;
  const personalizationSamples = personalization?.result.variants?.length
    ? Math.min(...personalization.result.variants.map((variant) => variant.user_count))
    : 0;
  const cards = [
    {
      key: "pattern",
      icon: BarChart3,
      eyebrow: "PATTERN",
      title: "规律正确性",
      report: pattern,
      primaryLabel: "时段完成率差异",
      primaryValue: formatPointDelta(pattern?.result.evening_minus_afternoon),
      metricLabel: "95% 置信区间",
      metricValue: formatInterval(pattern?.result.difference_95_ci),
      help: "置信区间表示真实差异可能落入的范围；区间跨过 0 时，不宜判定为稳定差异。",
      sample: patternSamples,
      minimum: pattern?.result.minimum_samples_per_bucket,
      sampleLabel: "每个时段",
    },
    {
      key: "prediction",
      icon: Gauge,
      eyebrow: "CALIBRATION",
      title: "风险预测校准",
      report: prediction,
      primaryLabel: "Brier Score",
      primaryValue: formatScore(prediction?.result.brier_score),
      metricLabel: "ECE",
      metricValue: formatScore(prediction?.result.expected_calibration_error),
      help: "Brier 衡量概率预测的整体误差，越低越好；ECE 衡量预测概率与真实发生率之间的偏差。",
      sample: predictionSamples,
      minimum: prediction?.result.thresholds?.minimum_outcomes,
      sampleLabel: "成熟结果",
    },
    {
      key: "proposal",
      icon: TrendingUp,
      eyebrow: "OUTCOME",
      title: "建议实际收益",
      report: proposal,
      primaryLabel: "七日完成率变化",
      primaryValue: formatPointDelta(proposal?.result.seven_day?.mean_delta),
      metricLabel: "七日完成率",
      metricValue: typeof proposal?.result.seven_day?.completion_rate === "number" ? `${(proposal.result.seven_day.completion_rate * 100).toFixed(1)}%` : "—",
      help: "七日变化比较建议应用后的完成表现与应用前基线；接受建议本身不代表产生收益。",
      sample: proposalSamples,
      minimum: proposal?.result.minimum_seven_day_outcomes,
      sampleLabel: "七日结果",
    },
    {
      key: "personalization",
      icon: UsersRound,
      eyebrow: "A/B TEST",
      title: "个性化长期收益",
      report: personalization,
      primaryLabel: "完成率 uplift",
      primaryValue: formatPointDelta(personalization?.result.treatment_minus_control?.completion),
      metricLabel: "过载变化",
      metricValue: formatPointDelta(personalization?.result.treatment_minus_control?.overload),
      help: "uplift 是个性化组相对无个性化组的差异；同时必须检查过载是否上升。",
      sample: personalizationSamples,
      minimum: personalization?.result.minimum_users_per_variant,
      sampleLabel: "每组用户",
    },
  ];

  return (
    <div className="memory-validation-results">
      {cards.map(({ key, icon: Icon, eyebrow, title, report, primaryLabel, primaryValue, metricLabel, metricValue, help, sample, minimum, sampleLabel }, index) => {
        const status = validationStatusMeta(report?.status);
        const progress = sampleProgress(sample, minimum);
        return (
          <motion.article className={`memory-validation-card is-${status.tone}`} key={key} initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : 0.24, delay: reduceMotion ? 0 : index * 0.045 }}>
            <header>
              <span><Icon size={17} /></span>
              <div><small>{eyebrow}</small><h3>{title}</h3></div>
              <b><i />{status.label}</b>
            </header>
            <div className="memory-validation-primary"><small>{primaryLabel}<MetricHint label={`了解${title}指标`}>{help}</MetricHint></small><strong>{primaryValue}</strong></div>
            <dl><div><dt>{metricLabel}<MetricHint label={`了解${metricLabel}`}>{help}</MetricHint></dt><dd>{metricValue}</dd></div><div><dt>样本进度<MetricHint label="了解样本门槛">达到预先设定的最小样本量后，系统才会显示“已支持”或“不支持”。</MetricHint></dt><dd>{sample} / {minimum ?? "—"}</dd></div></dl>
            <div className="memory-validation-progress" role="progressbar" aria-label={`${title}${sampleLabel}样本进度`} aria-valuemin={0} aria-valuemax={minimum ?? 0} aria-valuenow={sample}><i style={{ width: `${progress}%` }} /></div>
            <footer><span>{report ? `${sampleLabel} · ${report.provenance?.window_days ?? "—"} 天窗口 · ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(report.generated_at))} 更新` : "等待首份真实实验报告"}</span>{report?.provenance?.stale && <b>报告已过期</b>}{report?.provenance?.synthetic_data_allowed && <b>非生产环境</b>}</footer>
          </motion.article>
        );
      })}
    </div>
  );
}

function PatternRow({ pattern, initiallyOpen, goals, busy, onAction }: {
  pattern: ActivePattern;
  initiallyOpen: boolean;
  goals: ApiGoal[];
  busy: boolean;
  onAction: (
    pattern: ActivePattern,
    action: "confirm" | "correct" | "set_scope" | "pause" | "forget",
    values?: { summary?: string; scope?: "user" | "goal"; goal_id?: string | null },
  ) => Promise<void>;
}) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(initiallyOpen);
  const [editing, setEditing] = useState(false);
  const [draftSummary, setDraftSummary] = useState(pattern.explanation);
  const meta = PATTERN_META[pattern.pattern_type] ?? { label: "学习规律", group: "behavior" as PatternGroup, icon: BrainCircuit };
  const confidence = confidenceMeta(pattern.confidence);
  const Icon = meta.icon;
  const detailsId = `pattern-details-${pattern.id}`;
  const discussion = encodeURIComponent(`我想理解你对我的这条观察：“${pattern.explanation}”。请说明时间窗口、支持和反对它的证据，以及它具体影响了哪些建议。`);
  const correction = encodeURIComponent(`我想核对你对我的这条观察：“${pattern.explanation}”。当前范围是“${scopeLabel(pattern)}”，共有 ${pattern.evidence_count} 条支持记录。请先和我确认哪里不准确、适用范围应该是什么；在我明确确认前，不要修改长期记忆。`);

  useEffect(() => {
    if (initiallyOpen) setOpen(true);
  }, [initiallyOpen]);

  return (
    <article id={`pattern-${pattern.id}`} className={`memory-pattern-row is-${confidence.tone} ${open ? "is-open" : ""}`}>
      <button type="button" className="memory-pattern-summary" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}>
        <span className="memory-pattern-icon"><Icon size={17} /></span>
        <span className="memory-pattern-copy">
          <span className="memory-pattern-meta"><b>学习观察</b><span>{meta.label}</span><span>{scopeLabel(pattern)}</span>{pattern.user_review_status === "confirmed" && <em>用户已确认</em>}{pattern.user_review_status === "corrected" && <em>用户已修正</em>}</span>
          <strong>{pattern.explanation}</strong>
          <span className="memory-pattern-impact"><b>影响</b>{patternImpact(pattern)}</span>
        </span>
        <span className="memory-pattern-state">
          <span className={`memory-confidence is-${confidence.tone}`}>{confidence.label}</span>
          <small>{patternEvidenceLabel(pattern)} · {formatUpdatedDate(pattern.last_confirmed_at)}</small>
          <ChevronDown size={16} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={detailsId} className="memory-pattern-details" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}>
            <div className="memory-evidence-list">
              <header><strong>最近的支持记录</strong><span>安全摘要</span></header>
              <dl className="memory-evidence-summary" aria-label="观察证据摘要">
                <div><dt>支持记录</dt><dd>{pattern.evidence_summary?.supporting_count ?? pattern.evidence_count}</dd></div>
                <div><dt>反向记录</dt><dd>{pattern.evidence_summary?.opposing_count ?? 0}</dd></div>
                <div><dt>观察跨度</dt><dd>{formatObservedSince(pattern.evidence_summary?.first_observed_at)}</dd></div>
              </dl>
              <p className="memory-evidence-context">观察口径：{pattern.evidence_summary?.observation_window_days ? `近 ${pattern.evidence_summary.observation_window_days} 天` : "持续更新"} · {pattern.evidence_summary?.timezone ?? "用户当前时区"}{pattern.evidence_summary?.last_impacted_proposal_id ? " · 已关联最近一次建议结果" : ""}</p>
              {pattern.evidence.length ? pattern.evidence.slice(0, 4).map((evidence, index) => (
                <div className={evidence.direction ? `is-${evidence.direction}` : ""} key={`${evidence.event_id}-${index}`}>
                  <span><i /><strong>{EVENT_LABELS[evidence.event_type] ?? evidence.event_type}</strong></span>
                  <small>{formatEventDate(evidence.occurred_at)}{evidence.direction === "opposing" ? " · 反向证据" : evidence.source === "proposal_feedback" ? " · 建议结果反馈" : ""}</small>
                </div>
              )) : <p>当前只有聚合结果，暂时没有可展示的单条记录。</p>}
            </div>
            <aside>
              <small>如何理解</small>
              <p>{confidence.copy} 明确设置的目标约束始终优先。</p>
              {editing && <label className="memory-pattern-edit"><span>修改观察表述</span><textarea value={draftSummary} onChange={(event) => setDraftSummary(event.target.value)} maxLength={300} /></label>}
              <label className="memory-pattern-scope-control"><span>适用范围</span><select value={pattern.scope === "goal" ? `goal:${pattern.goal_id ?? ""}` : "user"} disabled={busy} onChange={(event) => {
                const value = event.target.value;
                void onAction(pattern, "set_scope", value === "user" ? { scope: "user", goal_id: null } : { scope: "goal", goal_id: value.slice(5) });
              }}><option value="user">跨目标观察</option>{goals.map((goal) => <option key={goal.id} value={`goal:${goal.id}`}>仅用于：{goal.title}</option>)}</select></label>
              <div className="memory-pattern-review-actions">
                <button type="button" disabled={busy} onClick={() => void onAction(pattern, "confirm")}><Check size={15} />确认准确</button>
                <button type="button" disabled={busy} onClick={() => {
                  if (editing) void onAction(pattern, "correct", { summary: draftSummary }).then(() => setEditing(false));
                  else setEditing(true);
                }}>{editing ? <Save size={15} /> : <Pencil size={15} />}{editing ? "保存修正" : "修改表述"}</button>
              </div>
              <details className="memory-pattern-more">
                <summary>更多管理<ChevronDown size={14} /></summary>
                <div>
                  <button type="button" disabled={busy} onClick={() => void onAction(pattern, "pause")}><Pause size={15} />暂停使用</button>
                  <button type="button" className="is-danger" disabled={busy} onClick={() => void onAction(pattern, "forget")}><Trash2 size={15} />永久遗忘</button>
                </div>
              </details>
              <div className="memory-pattern-explain-actions">
                <Link href={`/studio/coach?pattern=${encodeURIComponent(pattern.id)}&prompt=${discussion}`}><FileSearch size={15} />解释依据</Link>
                <Link className="is-secondary" href={`/studio/coach?pattern=${encodeURIComponent(pattern.id)}&prompt=${correction}`}><RefreshCw size={15} />与 Pilo 核对</Link>
              </div>
            </aside>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

export default function MemoryPage() {
  const { status: authStatus } = useAuth();
  const reduceMotion = useReducedMotion();
  const { confirmAction } = useConfirmDialog();
  const { showToast } = useToast();
  const [goals, setGoals] = useState<ApiGoal[]>([]);
  const [goalId, setGoalId] = useState("");
  const [context, setContext] = useState<DecisionContext | null>(null);
  const [validation, setValidation] = useState<ValidationSnapshot | null>(null);
  const [managedPatterns, setManagedPatterns] = useState<ManagedPattern[]>([]);
  const [audits, setAudits] = useState<PatternAudit[]>([]);
  const [savingPatternId, setSavingPatternId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<PatternGroup>("all");
  const [query, setQuery] = useState("");
  const [targetPattern, setTargetPattern] = useState("");
  const [activeView, setActiveView] = useState<MemoryView>("observations");
  const [showAllAudits, setShowAllAudits] = useState(false);

  const patterns = useMemo(() => context?.active_patterns ?? [], [context?.active_patterns]);
  const memories = context?.memories;
  const eventCount = context?.data_quality.profile_event_count ?? 0;
  const memoryCount = memories ? memories.semantic.length + memories.episodic.length + memories.short_term.length : 0;

  const load = useCallback(async () => {
    if (authStatus !== "authenticated") return;
    setLoading(true);
    setError("");
    try {
      const [nextContext, nextValidation, nextManaged, nextAudits] = await Promise.all([
        learnerApi.getDecisionContext(goalId || null),
        learnerApi.getValidationStatus().catch(() => null),
        learnerApi.listManagedPatterns(goalId || null),
        learnerApi.listPatternAudits(),
      ]);
      setContext(nextContext);
      setValidation(nextValidation);
      setManagedPatterns(nextManaged);
      setAudits(nextAudits);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "记忆与画像加载失败");
    } finally {
      setLoading(false);
    }
  }, [authStatus, goalId]);

  const handlePatternAction = useCallback(async (
    pattern: ActivePattern,
    action: "confirm" | "correct" | "set_scope" | "pause" | "forget",
    values: { summary?: string; scope?: "user" | "goal"; goal_id?: string | null } = {},
  ) => {
    const options = {
      confirm: { title: "确认这条观察准确？", description: "确认后会记录你的审核，但系统仍会随新证据更新判断。", confirmLabel: "确认准确", tone: "primary" as const },
      correct: { title: "保存修正后的观察？", description: "新的表述将替代系统生成的表述，并记录到画像审计历史。", confirmLabel: "保存修正", tone: "warning" as const },
      set_scope: { title: "调整观察适用范围？", description: "范围修改会立即影响后续建议使用这条观察的方式。", confirmLabel: "修改范围", tone: "warning" as const },
      pause: { title: "暂停使用这条观察？", description: "暂停后它不会继续影响建议，可随时从暂停列表恢复。", confirmLabel: "暂停使用", tone: "warning" as const },
      forget: { title: "永久遗忘这条观察？", description: "这会删除观察及其证据，无法恢复；审计中只保留不含画像正文的删除记录。", confirmLabel: "永久遗忘", tone: "danger" as const },
    }[action];
    if (!await confirmAction(options)) return;
    setSavingPatternId(pattern.id);
    try {
      await learnerApi.applyPatternAction(pattern.id, { action, ...values });
      await load();
      showToast(action === "forget" ? "这条观察已永久遗忘" : "学习记忆已更新", "success");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "画像更新失败", "error");
    } finally {
      setSavingPatternId("");
    }
  }, [confirmAction, load, showToast]);

  const handleUndoAudit = useCallback(async (audit: PatternAudit) => {
    if (!await confirmAction({ title: "撤销这次画像修改？", description: "系统会恢复到该操作之前的状态，并新增一条撤销记录。", confirmLabel: "确认撤销", tone: "warning" })) return;
    try {
      await learnerApi.undoPatternAudit(audit.id);
      await load();
      showToast("画像修改已撤销", "success");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "撤销失败", "error");
    }
  }, [confirmAction, load, showToast]);

  useEffect(() => {
    if (authStatus !== "authenticated") return;
    let cancelled = false;
    void productApi.listGoals().then((rows) => {
      if (!cancelled) setGoals(rows.filter((goal) => goal.status === "active"));
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "目标加载失败");
    });
    return () => { cancelled = true; };
  }, [authStatus]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const patternId = params.get("pattern") ?? "";
    const requestedView = params.get("view");
    if (["observations", "memories", "validation", "history"].includes(requestedView ?? "")) {
      setActiveView(requestedView as MemoryView);
    }
    setTargetPattern(patternId);
    if (!patternId) return;
    setActiveView("observations");
    const timer = window.setTimeout(() => document.getElementById(`pattern-${patternId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 220);
    return () => window.clearTimeout(timer);
  }, [patterns.length]);

  const selectView = useCallback((view: MemoryView) => {
    setActiveView(view);
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    url.searchParams.delete("pattern");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  const focusPattern = useCallback((patternId: string) => {
    setActiveView("observations");
    setTargetPattern(patternId);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "observations");
    url.searchParams.set("pattern", patternId);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    window.setTimeout(() => document.getElementById(`pattern-${patternId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
  }, []);

  useEffect(() => {
    signalPiloContext({
      kind: "scope",
      surface: "review",
      itemCount: patterns.length + memoryCount,
      objectId: goalId || "all-learning-memory",
      objectTitle: goalId ? goals.find((goal) => goal.id === goalId)?.title ?? "当前目标的学习观察" : "全部学习观察",
    });
  }, [goalId, goals, memoryCount, patterns.length]);

  const filteredPatterns = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return patterns.filter((pattern) => {
      const meta = PATTERN_META[pattern.pattern_type] ?? { group: "behavior" };
      if (filter !== "all" && meta.group !== filter) return false;
      return !normalized || `${pattern.explanation} ${PATTERN_META[pattern.pattern_type]?.label ?? ""}`.toLowerCase().includes(normalized);
    });
  }, [filter, patterns, query]);

  const groupCounts = useMemo(() => patterns.reduce((counts, pattern) => {
    const group = PATTERN_META[pattern.pattern_type]?.group ?? "behavior";
    counts[group] = (counts[group] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>), [patterns]);
  const pausedPatterns = useMemo(
    () => managedPatterns.filter((pattern) => pattern.status === "paused"),
    [managedPatterns],
  );

  if (authStatus !== "authenticated") {
    return (
      <div className="memory-page memory-review-page">
        <header className="workspace-pagebar goals-redesign-heading memory-review-pagebar">
          <div className="workspace-page-title"><small>MEMORY &amp; INSIGHTS</small><h1>学习记忆</h1><span>登录后查看真实行为记录与记忆内容</span></div>
          <Link className="memory-review-back" href="/studio/coach"><MessageCircle size={16} />返回学习伙伴</Link>
        </header>
        <motion.section
          className="memory-guest-state"
          initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 0.8, 0.28, 1] }}
        >
          <span><ShieldCheck size={24} /></span>
          <small>你的数据只属于你</small>
          {authStatus === "loading" ? <LoaderCircle className="spin" size={20} /> : <Link href="/login?next=%2Fstudio%2Fcoach%2Fmemory">登录查看真实画像 <ArrowRight size={15} /></Link>}
          <p>登录后，你可以查看每条观察的来源、适用范围和影响方式，并发起校正。这里不会用示例数据冒充你的画像。</p>
          <div>
            {[
              { icon: Database, title: "来源可追溯", copy: "知道观察来自哪些真实行为" },
              { icon: BrainCircuit, title: "记录与观察分开", copy: "看清发生过什么，以及系统如何理解" },
              { icon: UserRoundCheck, title: "由你核对", copy: "长期校正前需要你的确认" },
            ].map(({ icon: Icon, title, copy }, index) => (
              <motion.article
                key={title}
                initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.22, delay: reduceMotion ? 0 : 0.08 + index * 0.06 }}
              >
                <Icon size={18} />
                <strong>{title}</strong>
                <span>{copy}</span>
              </motion.article>
            ))}
          </div>
        </motion.section>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={180}>
    <div className="memory-page memory-review-page">
      <section className="memory-workboard" aria-label="学习记忆工作区">
      <header className="workspace-pagebar goals-redesign-heading memory-review-pagebar">
          <div className="workspace-page-title">
            <small>MEMORY &amp; INSIGHTS</small>
          <h1>学习记忆</h1>
            <span>{eventCount} 条行为记录 · {memoryCount} 条记忆内容</span>
          </div>
        <div className="memory-review-header-actions">
          <div className="memory-scope-select"><Target size={15} /><span>查看范围</span><Select value={goalId || "all"} onValueChange={(value) => setGoalId(value === "all" ? "" : value)}><SelectTrigger className="memory-scope-trigger" aria-label="选择学习记忆范围"><SelectValue /></SelectTrigger><SelectContent className="memory-scope-menu" position="popper" sideOffset={6}><SelectItem className="memory-scope-option" value="all">所有学习内容</SelectItem>{goals.map((goal) => <SelectItem className="memory-scope-option" value={goal.id} key={goal.id}>{goal.title}</SelectItem>)}</SelectContent></Select></div>
        </div>
      </header>

      <AnimatePresence>
        {(loading || error) && <motion.div className={`memory-review-state ${error ? "is-error" : ""}`} role={error ? "alert" : "status"} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>{loading ? <><LoaderCircle className="spin" size={15} />正在同步学习观察…</> : <><X size={15} />{error}<button type="button" onClick={() => void load()}><RefreshCw size={13} />重试</button></>}</motion.div>}
      </AnimatePresence>

      <nav className="memory-view-tabs" role="tablist" aria-label="学习记忆视图">
        {([
          ["observations", BrainCircuit, "正在使用", patterns.length],
          ["memories", Layers3, "记忆内容", memoryCount],
          ["validation", FlaskConical, "可信度与验证", validation?.reports.length ?? 0],
          ["history", History, "操作记录", audits.length],
        ] as Array<[MemoryView, typeof BrainCircuit, string, number]>).map(([view, Icon, label, count]) => <button type="button" role="tab" aria-selected={activeView === view} className={activeView === view ? "is-active" : ""} key={view} onClick={() => selectView(view)}><Icon size={16} /><span>{label}</span><b>{count}</b></button>)}
      </nav>

      <div className="memory-review-layout">
        <main>
          {activeView === "observations" && <>
          <MemoryFlow context={context} patterns={patterns} onSelectView={selectView} onSelectPattern={focusPattern} />
          <section className="memory-review-section memory-active-patterns" role="tabpanel" aria-label="正在使用的学习观察">
            <header>
              <div><small>由上方路径形成</small><h2>正在使用的学习观察</h2><p>这些是模型基于记录形成的可校正推断，不是对你的能力评判。展开可查看依据、范围和影响方式。</p></div>
              <span>{filteredPatterns.length} / {patterns.length}</span>
            </header>
            {patterns.length >= 5 && <div className="memory-review-tools">
              {patterns.length >= 5 &&
              <div className="memory-review-filters" role="group" aria-label="筛选学习规律">
                {([["all", "全部", patterns.length], ["temporal", "时间与节奏", groupCounts.temporal ?? 0], ["behavior", "执行与恢复", groupCounts.behavior ?? 0], ["knowledge", "知识与掌握", groupCounts.knowledge ?? 0]] as Array<[PatternGroup, string, number]>).filter(([value, , count]) => value === "all" || count > 0).map(([value, label, count]) => <button type="button" aria-pressed={filter === value} className={filter === value ? "is-active" : ""} key={value} onClick={() => setFilter(value)}>{label}<b>{count}</b></button>)}
              </div>
              }
              {patterns.length >= 8 && <label className="memory-review-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索观察" aria-label="搜索学习观察" />{query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索"><X size={14} /></button>}</label>}
            </div>}
            <div className="memory-pattern-list">
              {filteredPatterns.map((pattern) => <PatternRow key={pattern.id} pattern={pattern} initiallyOpen={targetPattern === pattern.id} goals={goals} busy={savingPatternId === pattern.id} onAction={handlePatternAction} />)}
              {!filteredPatterns.length && <div className="memory-review-empty"><Search size={20} /><strong>{patterns.length ? "没有匹配的观察" : "还没有形成可用的学习观察"}</strong><p>{patterns.length ? "尝试切换分类或清除搜索。" : "继续完成任务并反馈建议的真实效果；有足够重复信号后，观察会出现在这里。"}</p>{query && <button type="button" onClick={() => setQuery("")}>清除搜索</button>}</div>}
            </div>
          </section>

          {!!pausedPatterns.length && <section className="memory-review-section memory-paused-section">
            <header><div><small>已暂停</small><h2>暂不影响建议的观察</h2><p>暂停不会删除证据；恢复后才会重新参与建议排序。</p></div><span>{pausedPatterns.length}</span></header>
            <div>{pausedPatterns.map((pattern) => <article key={pattern.id}><span><Pause size={16} /></span><div><strong>{pattern.explanation}</strong><small>{pattern.evidence_count} 条记录 · {formatObservedSince(pattern.first_observed_at)}</small></div><button type="button" onClick={async () => {
              if (!await confirmAction({ title: "恢复使用这条观察？", description: "恢复后，它会重新参与后续建议排序。", confirmLabel: "恢复使用", tone: "primary" })) return;
              setSavingPatternId(pattern.id);
              try { await learnerApi.applyPatternAction(pattern.id, { action: "restore" }); await load(); showToast("观察已恢复", "success"); }
              catch (reason) { showToast(reason instanceof Error ? reason.message : "恢复失败", "error"); }
              finally { setSavingPatternId(""); }
            }} disabled={savingPatternId === pattern.id}><RotateCcw size={14} />恢复使用</button></article>)}</div>
          </section>}
          </>}

          {activeView === "memories" && <section className="memory-review-section memory-layer-section" role="tabpanel" aria-label="记忆内容">
            <header><div><small>PLANPILOT 记住了什么</small><h2>记忆内容</h2><p>这里是发生过的学习状态与经历；它们经过重复和证据积累，才会进入“正在使用”的观察。</p></div><span>{memoryCount} 条</span></header>
            <div className="memory-memory-overview">
              <article className="memory-retention-panel">
                <header><div><small>认知状态快照</small><h3>记忆保持</h3><p>模型按遗忘曲线估计，不是能力评分。</p></div><b>{context?.cognitive_profile ? `${Math.round(context.cognitive_profile.confidence * 100)}% 可信度` : "观察中"}</b></header>
                <RetentionCurve profile={context?.cognitive_profile ?? null} />
              </article>
              <div className="memory-layer-stack" aria-label="三层记忆内容">
                <article className="memory-layer-row is-short"><span><Clock3 size={16} /></span><div><small>短期状态</small><strong>最近发生、暂时相关</strong>{memories?.short_term.length ? memories.short_term.slice(0, 2).map((item) => <p key={item.id}>{item.summary}</p>) : <p className="is-empty">目前没有需要持续关注的近期状态</p>}</div><b>{memories?.short_term.length ?? 0}</b></article>
                <article className="memory-layer-row is-episodic"><span><History size={16} /></span><div><small>重要经历</small><strong>失败、恢复与突破</strong>{memories?.episodic.length ? memories.episodic.slice(0, 2).map((item) => <p key={item.id}>{item.summary}</p>) : <p className="is-empty">值得长期保留的学习经历仍在积累</p>}</div><b>{memories?.episodic.length ?? 0}</b></article>
                <article className="memory-layer-row is-semantic"><span><BrainCircuit size={16} /></span><div><small>长期知识</small><strong>可复用的学习规律</strong>{memories?.semantic.length ? memories.semantic.slice(0, 2).map((item) => <p key={item.id}>{item.summary}</p>) : <p className="is-empty">还没有形成可复用的长期观察</p>}</div><b>{memories?.semantic.length ?? 0}</b></article>
              </div>
            </div>
            <div className="memory-evidence-strip">
              <article><span><TrendingUp size={15} /></span><div><small>知识缺口</small><strong>{context?.knowledge_gaps.length ?? 0} 项需要关注</strong><p>{context?.knowledge_gaps.length ? context.knowledge_gaps.slice(0, 2).map((gap) => `${gap.name} · 保持率 ${percent(gap.retention)}`).join("；") : "目前没有需要优先处理的知识缺口"}</p></div></article>
              <article><span><Activity size={15} /></span><div><small>最近记录</small><strong>{context?.recent_events.length ?? 0} 条近期事件</strong><p>{context?.recent_events.length ? context.recent_events.slice(0, 2).map((event) => EVENT_LABELS[event.event_type] ?? event.event_type).join("、") : "完成任务或提交反馈后，这里会留下事件记录"}</p></div></article>
            </div>
          </section>}

          {activeView === "validation" && <section className="memory-review-section memory-validation-section" role="tabpanel" aria-label="验证结果">
            <header>
              <div><small>产品级验证</small><h2>系统如何验证这些观察</h2><p>这里展示产品级实验结果，不是你的个人准确率；只有真实样本达到门槛，结果才会被标记为已支持或不支持。</p></div>
              <span><FlaskConical size={14} /> 最新实验结果</span>
            </header>
            <details className="memory-validation-technical"><summary><span><Gauge size={15} /><strong>查看技术指标</strong><small>Brier Score、ECE、样本门槛与实验窗口</small></span><ChevronDown size={15} /></summary><ValidationResults snapshot={validation} /></details>
            <details className="memory-validation-disclosure"><summary><span><CalendarRange size={15} /><strong>展示规则与我的数据资格</strong></span><ChevronDown size={15} /></summary><div>测试或合成数据只用于验证管线，不会作为你的画像结论；真实证据不足时，页面保持“观察中”。{validation?.viewer_evidence && <> 你的数据状态：{validation.viewer_evidence.eligible_for_real_evidence ? "可进入真实证据队列" : validation.viewer_evidence.experiments_enabled ? "等待数据质量达标" : "未加入实验数据"}{typeof validation.viewer_evidence.quality_score === "number" ? `（质量 ${(validation.viewer_evidence.quality_score * 100).toFixed(0)}%）` : ""}。</>}</div></details>
          </section>}

          {activeView === "history" && <section className="memory-review-section memory-audit-section" role="tabpanel" aria-label="修改记录">
            <header><div><small>修改记录</small><h2>画像审计与撤销</h2><p>确认、修正、范围调整、暂停和恢复都会留下可追溯记录。</p></div><span>{audits.length}</span></header>
            {audits.length ? <><div className="memory-audit-list">{audits.slice(0, showAllAudits ? 12 : 5).map((audit) => {
              const labels: Record<PatternAudit["action"], string> = { confirm: "确认准确", correct: "修正表述", set_scope: "调整范围", pause: "暂停使用", restore: "恢复使用", forget: "永久遗忘", undo: "撤销修改" };
              return <article key={audit.id}><span><History size={15} /></span><div><strong>{labels[audit.action]}</strong><small>{new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(audit.created_at))}{audit.reason ? ` · ${audit.reason}` : ""}</small></div>{audit.reversible && <button type="button" onClick={() => void handleUndoAudit(audit)}><RotateCcw size={14} />撤销</button>}</article>;
            })}</div>{audits.length > 5 && <button type="button" className="memory-audit-more" aria-expanded={showAllAudits} onClick={() => setShowAllAudits((value) => !value)}>{showAllAudits ? "收起较早记录" : `查看其余 ${Math.min(7, audits.length - 5)} 条记录`}<ChevronDown size={15} /></button>}</> : <div className="memory-audit-empty">还没有用户发起的画像修改</div>}
          </section>}
        </main>

      </div>
      </section>
    </div>
    </TooltipProvider>
  );
}
