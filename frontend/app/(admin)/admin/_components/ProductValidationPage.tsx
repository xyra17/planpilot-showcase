"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  Gauge,
  HeartPulse,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { DataSyncNotice } from "@/components/ui/DataSyncNotice";
import {
  agentControlApi,
  type ProductMetricDetail,
  type ProductValidationReport,
} from "@/lib/agent-control-api";
import { useAuthStore } from "@/lib/stores/authStore";
import { cn } from "@/lib/utils";

const percent = (value: number | null | undefined) =>
  value == null ? "暂无数据" : `${Math.round(value * 100)}%`;

const formatTime = (value: string, timeZone: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(value));

const STATUS_COPY = {
  insufficient_data: {
    title: "证据还在积累",
    detail: "成熟样本还不够，现在只能看过程，不能下业务结论。",
    label: "等待样本",
    icon: Clock3,
  },
  supported: {
    title: "当前证据达到预设线",
    detail: "关键价值指标和负担护栏都达到当前工程预设。",
    label: "达到预设线",
    icon: CheckCircle2,
  },
  not_supported: {
    title: "关键指标仍需改善",
    detail: "成熟样本已经足够，但至少一项关键指标尚未达到预设线。",
    label: "需要改善",
    icon: CircleAlert,
  },
} as const;

type Tone = "blue" | "mint" | "violet" | "amber";

function HeadingActions({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setTarget(document.getElementById("pp-admin-heading-actions")), []);
  return target ? createPortal(children, target) : null;
}

function detailFor(report: ProductValidationReport, key: string): ProductMetricDetail {
  return report.rate_details[key] ?? { numerator: 0, denominator: 0, value: null };
}

function metricState(
  detail: ProductMetricDetail,
  threshold?: number,
  lowerIsBetter = false,
) {
  if (!detail.denominator || detail.value == null) return { label: "等待成熟样本", state: "waiting" };
  if (threshold == null) return { label: "已有数据", state: "ready" };
  const reached = lowerIsBetter ? detail.value <= threshold : detail.value >= threshold;
  return reached
    ? { label: "达到预设线", state: "good" }
    : { label: lowerIsBetter ? "高于预设线" : "低于预设线", state: "attention" };
}

function TrendLine({
  history,
  metricKey,
  label,
}: {
  history: ProductValidationReport[];
  metricKey: string;
  label: string;
}) {
  const points = history
    .slice()
    .reverse()
    .map((item) => item.rate_details[metricKey]?.value)
    .filter((value): value is number => value != null);
  if (points.length < 2) return null;
  const width = 116;
  const height = 32;
  const coordinates = points.map((value, index) => {
    const x = (index / Math.max(1, points.length - 1)) * width;
    const y = height - Math.min(1, Math.max(0, value)) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg className="pp-product-sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}真实历史趋势`}>
      <polyline points={coordinates} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MetricCard({
  title,
  plainLabel,
  detail,
  threshold,
  windowLabel,
  tone,
  icon: Icon,
  history,
  metricKey,
  index,
}: {
  title: string;
  plainLabel: string;
  detail: ProductMetricDetail;
  threshold: number;
  windowLabel: string;
  tone: Tone;
  icon: typeof Target;
  history: ProductValidationReport[];
  metricKey: string;
  index: number;
}) {
  const reduceMotion = useReducedMotion();
  const status = metricState(detail, threshold);
  const progress = detail.value == null ? 0 : Math.min(100, Math.round(detail.value * 100));
  return (
    <motion.article
      className={cn("pp-product-metric", `is-${tone}`)}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, delay: reduceMotion ? 0 : index * 0.045, ease: "easeOut" }}
      data-status={status.state}
    >
      <div className="pp-product-metric-head">
        <span className="pp-product-metric-icon"><Icon size={18} /></span>
        <span className="pp-product-metric-status"><i />{status.label}</span>
      </div>
      <h2>{title}</h2>
      <div className="pp-product-metric-value-row">
        <strong>{percent(detail.value)}</strong>
        <TrendLine history={history} metricKey={metricKey} label={title} />
      </div>
      <p>{plainLabel}</p>
      <div className="pp-product-progress" aria-hidden="true"><span style={{ transform: `scaleX(${progress / 100})` }} /></div>
      <footer><span>{detail.numerator}/{detail.denominator} 个成熟样本</span><span>{windowLabel}</span></footer>
    </motion.article>
  );
}

function JourneyStep({
  number,
  title,
  description,
  detail,
}: {
  number: number;
  title: string;
  description: string;
  detail: ProductMetricDetail;
}) {
  return (
    <div className="pp-product-journey-step">
      <span className="pp-product-step-number">{number}</span>
      <div className="pp-product-step-copy"><strong>{title}</strong><span>{description}</span></div>
      <div className="pp-product-step-value"><strong>{percent(detail.value)}</strong><span>{detail.denominator ? `${detail.numerator}/${detail.denominator} 人` : "样本未成熟"}</span></div>
    </div>
  );
}

function EvidenceRow({
  label,
  description,
  detail,
  threshold,
  lowerIsBetter = false,
}: {
  label: string;
  description: string;
  detail: ProductMetricDetail;
  threshold?: number;
  lowerIsBetter?: boolean;
}) {
  const status = metricState(detail, threshold, lowerIsBetter);
  return (
    <div className="pp-product-evidence-row">
      <div><strong>{label}</strong><span>{description}</span></div>
      <div className="pp-product-evidence-value"><strong>{percent(detail.value)}</strong><span>{detail.denominator ? `${detail.numerator}/${detail.denominator}` : "暂无分母"}</span></div>
      <span className="pp-product-evidence-state" data-status={status.state}>{status.label}</span>
    </div>
  );
}

function ProductSkeleton() {
  return (
    <div className="pp-product-validation pp-product-skeleton" aria-label="正在读取产品验证数据">
      <div className="pp-product-skeleton-line is-wide" />
      <div className="pp-product-skeleton-grid">{[0, 1, 2, 3].map((item) => <div key={item} />)}</div>
      <div className="pp-product-skeleton-panel" />
    </div>
  );
}

export default function ProductValidationPage() {
  const user = useAuthStore((state) => state.user);
  const timeZone = user?.timezone ?? "Asia/Shanghai";
  const [report, setReport] = useState<ProductValidationReport | null>(null);
  const [history, setHistory] = useState<ProductValidationReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [latest, snapshots] = await Promise.all([
        agentControlApi.getLatestProductValidation(),
        agentControlApi.getProductValidationHistory(12),
      ]);
      setReport(latest);
      setHistory(snapshots);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "用户价值数据读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const aggregate = async () => {
    setBusy(true);
    setError(null);
    try {
      await agentControlApi.aggregateProductValidation();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重新计算用户价值数据失败");
    } finally {
      setBusy(false);
    }
  };

  const status = report ? STATUS_COPY[report.status] : STATUS_COPY.insufficient_data;
  const StatusIcon = status.icon;
  const primaryMetrics = useMemo(() => report ? [
    {
      metricKey: "goal_created_10m_rate", title: "10 分钟建好目标", plainLabel: "能否快速完成第一次设置", threshold: report.thresholds.goal_created_10m_rate,
      windowLabel: "10 分钟内", tone: "blue" as const, icon: Target,
    },
    {
      metricKey: "activation_24h_rate", title: "24 小时完成首次行动", plainLabel: "是否真的完成了一项任务", threshold: report.thresholds.activation_24h_rate,
      windowLabel: "24 小时内", tone: "mint" as const, icon: Activity,
    },
    {
      metricKey: "week4_wvlu_retention_rate", title: "第 4 周仍有学习闭环", plainLabel: "行动、证据和复盘调整缺一不可", threshold: report.thresholds.week4_wvlu_retention_rate,
      windowLabel: "第 22–29 天", tone: "violet" as const, icon: HeartPulse,
    },
    {
      metricKey: "recovery_72h_rate", title: "中断后 72 小时内恢复", plainLabel: "是否重新开始或完成任务", threshold: report.thresholds.recovery_72h_rate,
      windowLabel: "72 小时内", tone: "amber" as const, icon: RotateCcw,
    },
  ] : [], [report]);

  return (
    <>
      <HeadingActions>
        <div className="pp-admin-heading-action-group">
          <button type="button" className="pp-product-secondary-action" onClick={() => void load()} disabled={loading || busy}>
            <RefreshCw size={16} className={cn(loading && "animate-spin")} />刷新页面
          </button>
          <button type="button" className="pp-product-primary-action" onClick={() => void aggregate()} disabled={loading || busy}>
            <Sparkles size={16} />{busy ? "计算中…" : report ? "重新计算" : "生成首份数据"}
          </button>
        </div>
      </HeadingActions>

      {error && <DataSyncNotice title="用户价值数据没有更新" message={error} onRetry={() => void load()} />}
      {loading && !report ? <ProductSkeleton /> : !report ? (
        <div className="pp-product-validation">
          <section className="pp-product-empty">
            <span><Database size={24} /></span>
            <div><h2>还没有产品验证快照</h2><p>点击“生成首份数据”，系统会按当前授权范围计算成熟样本，不会把未满观察期的用户算进分母。</p></div>
            <button type="button" onClick={() => void aggregate()} disabled={busy}>{busy ? "计算中…" : "生成首份数据"}<ArrowRight size={17} /></button>
          </section>
        </div>
      ) : (
        <main className="pp-product-validation" data-testid="product-validation-dashboard">
          <section className="pp-product-status" data-status={report.status}>
            <span className="pp-product-status-icon"><StatusIcon size={22} /></span>
            <div className="pp-product-status-copy"><span>本轮判断</span><h2>{status.title}</h2><p>{status.detail}</p></div>
            <div className="pp-product-status-facts">
              <span><Users size={16} /><b>{report.consented_user_count}</b> 位授权用户</span>
              <span><Clock3 size={16} />更新于 {formatTime(report.generated_at, timeZone)}</span>
              <span><ShieldCheck size={16} />{status.label}</span>
            </div>
          </section>

          <section className="pp-product-metric-grid" aria-label="四个关键用户价值指标">
            {primaryMetrics.map((item, index) => (
              <MetricCard key={item.metricKey} {...item} detail={detailFor(report, item.metricKey)} history={history} index={index} />
            ))}
          </section>

          <section className="pp-product-section pp-product-journey">
            <header><div><span>首次价值路径</span><h2>用户从建目标到留下学习证据</h2></div><p>这组数据用来找出用户在哪一步停下，不把“打开页面”当成获得价值。</p></header>
            <div className="pp-product-journey-grid">
              <JourneyStep number={1} title="建好目标" description="注册后 10 分钟内" detail={detailFor(report, "goal_created_10m_rate")} />
              <JourneyStep number={2} title="开始任务" description="目标建立后 24 小时内" detail={detailFor(report, "first_task_started_24h_rate")} />
              <JourneyStep number={3} title="完成任务" description="真正完成首次行动" detail={detailFor(report, "activation_24h_rate")} />
              <JourneyStep number={4} title="留下证据" description="首次完成后 24 小时内" detail={detailFor(report, "first_action_evidence_rate")} />
            </div>
          </section>

          <div className="pp-product-detail-grid">
            <section className="pp-product-section">
              <header><div><span>回来继续</span><h2>偏差恢复</h2></div><RotateCcw size={20} /></header>
              <div className="pp-product-evidence-list">
                <EvidenceRow label="选择了恢复方案" description="必须由用户确认，预览不算" detail={detailFor(report, "recovery_selected_rate")} />
                <EvidenceRow label="72 小时内重新行动" description="重新开始或完成同一目标任务" detail={detailFor(report, "recovery_72h_rate")} threshold={report.thresholds.recovery_72h_rate} />
              </div>
            </section>

            <section className="pp-product-section">
              <header><div><span>长期价值</span><h2>可验证学习闭环</h2></div><HeartPulse size={20} /></header>
              <div className="pp-product-evidence-list">
                <EvidenceRow label="第 4 周仍有闭环" description="行动、证据和复盘调整缺一不可" detail={detailFor(report, "week4_wvlu_retention_rate")} threshold={report.thresholds.week4_wvlu_retention_rate} />
                <EvidenceRow label="第 8 周仍有闭环" description="长期观察项，暂不阻塞首轮放量" detail={detailFor(report, "week8_wvlu_retention_rate")} />
              </div>
            </section>

            <section className="pp-product-section">
              <header><div><span>不要透支用户</span><h2>负担与证据护栏</h2></div><Gauge size={20} /></header>
              <div className="pp-product-evidence-list">
                <EvidenceRow label="28 天跳过或改期" description="是维护负担的代理，不等于主观感受" detail={detailFor(report, "overload_rate_28d")} threshold={report.thresholds.max_overload_rate} lowerIsBetter />
                <EvidenceRow label="离不开产品的用户" description="回答“非常失望”的真实问卷占比" detail={detailFor(report, "very_disappointed_rate")} threshold={report.thresholds.very_disappointed_rate} />
              </div>
            </section>
          </div>

          <details className="pp-product-method">
            <summary><span><Info size={18} />这组数字是怎么算的？</span><span>查看统计口径</span></summary>
            <div>
              <p><strong>统计谁：</strong>只统计当前已开启产品分析的用户；撤回授权后不再进入聚合。</p>
              <p><strong>怎么算时间：</strong>包含观察窗口起点，不包含终点；没满 10 分钟、24 小时、72 小时或对应周次的样本不进入分母。</p>
              <p><strong>如何去重：</strong>首次价值和留存按用户计算一次，恢复按每次明确偏差计算一次。</p>
              <p><strong>当前限制：</strong>预设线尚未经过真实用户校准；它用于提示关注方向，不等于最终业务目标。</p>
            </div>
          </details>
        </main>
      )}
    </>
  );
}
