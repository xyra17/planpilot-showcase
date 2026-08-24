"use client";

import { ArrowRight, Check, ChevronDown, FileSearch, History, LoaderCircle, Pause, Pencil, RotateCcw, Save, ShieldCheck, Target, Trash2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/technology/AuthProvider";
import { ProfileFeedbackCard } from "@/components/technology/companion/ProfileFeedbackCard";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataSyncNotice } from "@/components/ui/DataSyncNotice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/Toast";
import { ApiError } from "@/lib/api";
import { type ManagedPattern, type PatternAudit, learnerApi } from "@/lib/learner-api";
import { productApi, type ApiGoal } from "@/lib/technology/productApi";
import { signalPiloContext } from "@/lib/technology/piloContext";

const PATTERN_LABELS: Record<string, string> = {
  preferred_learning_time: "学习时段", preferred_session_length: "专注时长", weekly_learning_frequency: "学习频率",
  completion_rate_trend: "完成趋势", mastery_velocity: "掌握节奏", delay_pattern: "延期与恢复",
  plan_adherence: "计划执行", estimation_accuracy: "时间估算",
};
const EVENT_LABELS: Record<string, string> = {
  TaskCompleted: "任务完成记录", TaskRescheduled: "任务调整记录", CheckinSubmitted: "学习反馈",
  MasteryRecorded: "掌握状态更新", ProposalFeedbackRecorded: "建议效果反馈",
};

function confidenceCopy(value: number) {
  if (value >= 0.78) return "当前证据相对稳定，但仍不是事实，会随新记录和你的纠正更新。";
  if (value >= 0.55) return "当前只有初步信号，系统会降低它对建议的影响。";
  return "当前证据较弱，不应作为强约束使用。";
}
function scopeLabel(pattern: ManagedPattern) {
  return pattern.goal_id ? "仅当前目标" : pattern.scope === "user" ? "所有目标" : "特定学习内容";
}
function patternImpact(pattern: ManagedPattern) {
  const copies: Record<string, string> = {
    preferred_learning_time: "安排需要集中注意力的任务时，优先参考这段时间。",
    preferred_session_length: "拆分任务时，参考这一专注时长。",
    weekly_learning_frequency: "制定周计划时，避免把学习集中在少数几天。",
    completion_rate_trend: "调整近期计划强度时，参考完成趋势。",
    mastery_velocity: "安排新内容和复习比例时，参考掌握节奏。",
    delay_pattern: "识别延期风险时，更早提供恢复节奏的建议。",
    plan_adherence: "计划偏离后，优先建议恢复连续性。",
    estimation_accuracy: "估算任务时长时，为容易低估的任务预留余量。",
  };
  return copies[pattern.pattern_type] ?? "生成学习建议时，把它作为一条可以纠正的参考。";
}
function formatDate(value: string | null | undefined) {
  if (!value) return "时间待补齐";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric" }).format(new Date(value));
}
function sourceTypes(pattern: ManagedPattern) {
  const labels = Array.from(new Set((pattern.evidence ?? []).map((item) => EVENT_LABELS[item.event_type] ?? "学习行为记录")));
  return labels.length ? labels.slice(0, 3).join("、") : "汇总后的学习行为记录";
}
type PatternAction = "confirm" | "correct" | "set_scope" | "pause" | "forget";
type DelayReason = "business_trip" | "illness_or_care" | "temporary_capacity" | "other_external" | "unexplained";
const DELAY_REASON_LABELS: Record<DelayReason, string> = {
  business_trip: "出差或工作安排",
  illness_or_care: "生病或照护安排",
  temporary_capacity: "本周可用时间临时下降",
  other_external: "其他外部中断",
  unexplained: "恢复计入行为模式",
};

function ObservationCard({ pattern, goals, busy, initiallyOpen, onAction, onDelayAttribution }: {
  pattern: ManagedPattern; goals: ApiGoal[]; busy: boolean; initiallyOpen: boolean;
  onAction: (pattern: ManagedPattern, action: PatternAction, values?: { summary?: string; scope?: "user" | "goal"; goal_id?: string | null }) => Promise<boolean>;
  onDelayAttribution: (pattern: ManagedPattern, evidenceId: string, reasonCode: DelayReason, note?: string) => Promise<boolean>;
}) {
  const reduceMotion = useReducedMotion();
  const [evidenceOpen, setEvidenceOpen] = useState(initiallyOpen);
  const [editing, setEditing] = useState(false);
  const [attributingEvidenceId, setAttributingEvidenceId] = useState<string | null>(null);
  const [attributionReason, setAttributionReason] = useState<DelayReason>("business_trip");
  const [attributionNote, setAttributionNote] = useState("");
  const [draft, setDraft] = useState(pattern.explanation);
  const evidenceId = `observation-evidence-${pattern.id}`;
  const supporting = pattern.evidence_summary?.supporting_count ?? pattern.evidence_count;
  const opposing = pattern.evidence_summary?.opposing_count ?? 0;
  const excluded = pattern.evidence_summary?.excluded_count ?? 0;
  const windowLabel = pattern.evidence_summary?.observation_window_days ? `近 ${pattern.evidence_summary.observation_window_days} 天` : `${formatDate(pattern.evidence_summary?.first_observed_at)}起`;
  const prompt = encodeURIComponent(`为什么你会这样建议我？请结合这条暂定观察“${pattern.explanation}”，说明支持和反向证据、观察窗口、适用范围，以及它具体影响了什么。`);
  useEffect(() => { if (initiallyOpen) setEvidenceOpen(true); }, [initiallyOpen]);

  return <article id={`pattern-${pattern.id}`} className={`personalization-observation ${initiallyOpen ? "is-targeted" : ""}`}>
    <header><div className="personalization-observation-title"><small>{PATTERN_LABELS[pattern.pattern_type] ?? "学习观察"} · 暂定表述</small><h3>{pattern.explanation}</h3><span>{pattern.user_review_status === "confirmed" ? "你已确认" : pattern.user_review_status === "corrected" ? "已按你的修正应用" : "等待你确认"}</span></div></header>
    <dl className="personalization-observation-facts">
      <div><dt>来源类型</dt><dd>{sourceTypes(pattern)}</dd></div><div><dt>观察窗口</dt><dd>{windowLabel}</dd></div>
      <div><dt>证据摘要</dt><dd>支持 {supporting} 条 · 反向 {opposing} 条{excluded ? ` · 外部中断 ${excluded} 条` : ""}</dd></div><div className="is-impact"><dt>具体会影响什么</dt><dd>{patternImpact(pattern)}</dd></div>
    </dl>
    <div className="personalization-observation-controls"><label><span>调整范围</span><select value={pattern.goal_id ? `goal:${pattern.goal_id}` : "user"} disabled={busy} onChange={(event) => { const value = event.target.value; void onAction(pattern, "set_scope", value === "user" ? { scope: "user", goal_id: null } : { scope: "goal", goal_id: value.slice(5) }); }} aria-label={`调整“${pattern.explanation}”的适用范围`}><option value="user">所有目标</option>{goals.map((goal) => <option value={`goal:${goal.id}`} key={goal.id}>仅用于：{goal.title}</option>)}</select></label><span className="personalization-current-scope"><Target size={14} />当前：{scopeLabel(pattern)}</span></div>
    {editing && <label className="personalization-correction"><span>修正暂定表述</span><textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={300} /></label>}
    <div className="personalization-observation-actions">
      <button type="button" disabled={busy} onClick={() => void onAction(pattern, "confirm")}><Check size={15} />确认准确</button>
      <button type="button" disabled={busy} onClick={() => { if (editing) void onAction(pattern, "correct", { summary: draft }).then((saved) => { if (saved) setEditing(false); }); else setEditing(true); }}>{editing ? <Save size={15} /> : <Pencil size={15} />}{editing ? "保存修正" : "修正"}</button>
      <button type="button" disabled={busy} onClick={() => void onAction(pattern, "pause")}><Pause size={15} />暂停</button>
      <button type="button" aria-expanded={evidenceOpen} aria-controls={evidenceId} onClick={() => setEvidenceOpen((value) => !value)}><FileSearch size={15} />查看依据<ChevronDown size={14} /></button>
      <Link href={`/studio/coach?pattern=${encodeURIComponent(pattern.id)}&prompt=${prompt}`}>为什么这样建议我<ArrowRight size={14} /></Link>
      <button type="button" className="is-danger" disabled={busy} onClick={() => void onAction(pattern, "forget")}><Trash2 size={15} />永久遗忘</button>
    </div>
    <AnimatePresence initial={false}>{evidenceOpen && <motion.section id={evidenceId} className="personalization-evidence" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}><div><strong>判断说明</strong><p>{confidenceCopy(pattern.confidence)} 这里的强度表示证据是否足够稳定，不是对你动机的概率判断。</p>{pattern.pattern_type === "delay_pattern" && <p>系统保留延期事实；标记为外部中断的记录不会计入“重复延期”模式。</p>}</div><div><strong>支持与反向证据</strong>{pattern.evidence?.length ? <ul>{pattern.evidence.slice(0, 6).map((item, index) => { const itemId = item.evidence_id ?? `${item.event_id}-${index}`; const isAttributing = attributingEvidenceId === itemId; return <li key={itemId} className={item.direction === "excluded" ? "is-excluded" : ""}><span>{item.task_title || EVENT_LABELS[item.event_type] || item.event_type}{item.days_overdue ? ` · 逾期 ${item.days_overdue} 天` : ""}</span><small>{formatDate(item.occurred_at)} · {item.direction === "excluded" ? `已排除：${DELAY_REASON_LABELS[(item.reason_code as DelayReason) || "other_external"]}` : item.direction === "opposing" ? "反向证据" : "支持证据"}</small>{item.correctable && item.evidence_id && <div className="personalization-evidence-action">{item.direction === "excluded" ? <button type="button" disabled={busy} onClick={() => { setAttributingEvidenceId(item.evidence_id!); setAttributionReason("unexplained"); setAttributionNote(""); }}>恢复计入</button> : <button type="button" disabled={busy} onClick={() => { setAttributingEvidenceId(item.evidence_id!); setAttributionReason("business_trip"); setAttributionNote(""); }}>标记外部中断</button>}{isAttributing && <div className="personalization-attribution-editor"><label><span>这次延期的归因</span><select value={attributionReason} onChange={(event) => setAttributionReason(event.target.value as DelayReason)}><option value="business_trip">出差或工作安排</option><option value="illness_or_care">生病或照护安排</option><option value="temporary_capacity">本周可用时间临时下降</option><option value="other_external">其他外部中断</option><option value="unexplained">恢复计入行为模式</option></select></label><textarea aria-label="归因补充说明" value={attributionNote} onChange={(event) => setAttributionNote(event.target.value)} maxLength={500} placeholder="可选：补充当周可用时间或恢复情况" /><button type="button" disabled={busy} onClick={() => void onDelayAttribution(pattern, item.evidence_id!, attributionReason, attributionNote).then((saved) => { if (saved) setAttributingEvidenceId(null); })}>保存归因</button></div>}</div>}</li>; })}</ul> : <p>目前只有聚合摘要，没有可展示的单条记录。</p>}</div></motion.section>}</AnimatePresence>
  </article>;
}

export default function MemoryPage() {
  const { status: authStatus } = useAuth();
  const { confirmAction } = useConfirmDialog();
  const { showToast } = useToast();
  const [goals, setGoals] = useState<ApiGoal[]>([]); const [goalId, setGoalId] = useState("");
  const [patterns, setPatterns] = useState<ManagedPattern[]>([]); const [managedPatterns, setManagedPatterns] = useState<ManagedPattern[]>([]); const [audits, setAudits] = useState<PatternAudit[]>([]);
  const [targetPattern, setTargetPattern] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [personalizationOff, setPersonalizationOff] = useState(false); const [savingPatternId, setSavingPatternId] = useState("");
  const pendingPatterns = useMemo(() => patterns.filter((pattern) => !["confirmed", "corrected", "paused"].includes(pattern.user_review_status ?? "") && pattern.status !== "paused"), [patterns]);
  const appliedPatterns = useMemo(() => patterns.filter((pattern) => ["confirmed", "corrected"].includes(pattern.user_review_status ?? "")), [patterns]);
  const pausedPatterns = useMemo(() => managedPatterns.filter((pattern) => pattern.status === "paused"), [managedPatterns]);

  const load = useCallback(async () => {
    if (authStatus !== "authenticated") return; setLoading(true); setError(""); setPersonalizationOff(false);
    try { const [context, managed, history] = await Promise.all([learnerApi.getDecisionContext(goalId || null), learnerApi.listManagedPatterns(goalId || null), learnerApi.listPatternAudits()]); const merged = [...managed, ...context.active_patterns.filter((row) => !managed.some((item) => item.id === row.id)).map((row) => row as ManagedPattern)]; setPatterns(merged); setManagedPatterns(merged); setAudits(history); }
    catch (reason) { if (reason instanceof ApiError && reason.status === 403 && /个性化/.test(reason.message)) setPersonalizationOff(true); else setError(reason instanceof Error ? reason.message : "个性化与学习偏好加载失败"); }
    finally { setLoading(false); }
  }, [authStatus, goalId]);
  useEffect(() => { if (authStatus !== "authenticated") return; let active = true; void productApi.listGoals().then((rows) => { if (active) setGoals(rows.filter((goal) => goal.status === "active")); }).catch(() => undefined); return () => { active = false; }; }, [authStatus]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get("pattern") ?? ""; setTargetPattern(id); if (!id) return; const timer = window.setTimeout(() => document.getElementById(`pattern-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 180); return () => window.clearTimeout(timer); }, [patterns.length]);
  useEffect(() => { signalPiloContext({ kind: "scope", surface: "review", itemCount: patterns.length, objectId: goalId || "all-personalization-observations", objectTitle: goalId ? goals.find((goal) => goal.id === goalId)?.title ?? "当前目标的学习观察" : "个性化与学习偏好" }); }, [goalId, goals, patterns.length]);

  const handlePatternAction = useCallback(async (pattern: ManagedPattern, action: PatternAction, values: { summary?: string; scope?: "user" | "goal"; goal_id?: string | null } = {}) => {
    const options = {
      confirm: { title: "确认这条观察准确？", description: "确认后会记录你的审核；系统仍会随新证据更新，并允许你继续修正。", confirmLabel: "确认准确", tone: "primary" as const },
      correct: { title: "保存修正后的观察？", description: "你的表述会替代系统的暂定表述，并留下修改记录。", confirmLabel: "保存修正", tone: "warning" as const },
      set_scope: { title: "调整这条观察的范围？", description: "新范围会立即影响后续建议使用这条观察的方式。", confirmLabel: "调整范围", tone: "warning" as const },
      pause: { title: "暂停使用这条观察？", description: "暂停后不会继续影响建议，你可以随时恢复。", confirmLabel: "暂停", tone: "warning" as const },
      forget: { title: "永久遗忘这条观察？", description: "这会删除观察及其证据且无法恢复；修改记录只保留不含观察正文的安全记录。", confirmLabel: "永久遗忘", tone: "danger" as const },
    }[action];
    if (!await confirmAction(options)) return false; setSavingPatternId(pattern.id);
    try { await learnerApi.applyPatternAction(pattern.id, { action, ...values }); await load(); showToast(action === "forget" ? "这条观察已永久遗忘" : "个性化偏好已更新", "success"); return true; }
    catch (reason) { showToast(reason instanceof Error ? reason.message : "观察更新失败", "error"); return false; } finally { setSavingPatternId(""); }
  }, [confirmAction, load, showToast]);
  const handleDelayAttribution = useCallback(async (pattern: ManagedPattern, evidenceId: string, reasonCode: DelayReason, note = "") => {
    const external = reasonCode !== "unexplained";
    if (!await confirmAction({ title: external ? "把这次延期标记为外部中断？" : "恢复把这次延期计入行为模式？", description: external ? "延期事实仍会保留，但这次记录不会参与重复延期模式统计。系统不会判断你的动机，只按你的归因重算。" : "系统会保留原始延期事实，并将这次记录重新计入行为模式统计。", confirmLabel: external ? "标记外部中断" : "恢复计入", tone: "warning" })) return false;
    setSavingPatternId(pattern.id);
    try { await learnerApi.recordDelayAttribution(pattern.id, evidenceId, { reason_code: reasonCode, note }); await load(); showToast(external ? "这次延期已按外部中断重算" : "这次延期已恢复计入模式", "success"); return true; }
    catch (reason) { showToast(reason instanceof Error ? reason.message : "延期归因保存失败", "error"); return false; } finally { setSavingPatternId(""); }
  }, [confirmAction, load, showToast]);
  const restorePattern = useCallback(async (pattern: ManagedPattern) => { if (!await confirmAction({ title: "恢复使用这条观察？", description: "恢复后它会重新参与后续建议。", confirmLabel: "恢复", tone: "primary" })) return; setSavingPatternId(pattern.id); try { await learnerApi.applyPatternAction(pattern.id, { action: "restore" }); await load(); showToast("观察已恢复", "success"); } catch (reason) { showToast(reason instanceof Error ? reason.message : "恢复失败", "error"); } finally { setSavingPatternId(""); } }, [confirmAction, load, showToast]);
  const undoAudit = useCallback(async (audit: PatternAudit) => { if (!await confirmAction({ title: "撤销这次修改？", description: "系统会恢复操作前的状态，并新增一条撤销记录。永久遗忘不可撤销。", confirmLabel: "确认撤销", tone: "warning" })) return; try { await learnerApi.undoPatternAudit(audit.id); await load(); showToast("修改已撤销", "success"); } catch (reason) { showToast(reason instanceof Error ? reason.message : "撤销失败", "error"); } }, [confirmAction, load, showToast]);

  if (authStatus !== "authenticated") return <div className="memory-page personalization-page"><header className="workspace-pagebar personalization-pagebar"><div className="workspace-page-title"><small>PERSONALIZATION</small><h1>个性化与学习偏好</h1><span>登录后查看和纠正系统形成的学习观察</span></div></header><section className="personalization-guest"><ShieldCheck size={22} /><div><h2>登录后管理你的个性化选择</h2><p>这里不会向访客展示示例画像。登录后，你可以查看观察依据、修正、暂停或永久遗忘系统生成的内容。</p></div>{authStatus === "loading" ? <LoaderCircle className="spin" size={20} /> : <Link href="/login?next=%2Fstudio%2Fcoach%2Fmemory">登录继续<ArrowRight size={15} /></Link>}</section></div>;

  return <div className="memory-page personalization-page">
    <header className="workspace-pagebar personalization-pagebar"><div className="workspace-page-title"><small>PERSONALIZATION</small><h1>个性化与学习偏好</h1><p>系统观察是基于记录形成的暂定判断，不是事实。你可以纠正、调整范围、暂停或清除。</p><span>{patterns.length} 条正在使用的观察 · {pendingPatterns.length} 条需要确认</span></div><div className="personalization-scope"><Target size={15} /><Select value={goalId || "all"} onValueChange={(value) => setGoalId(value === "all" ? "" : value)}><SelectTrigger aria-label="选择个性化观察范围"><SelectValue /></SelectTrigger><SelectContent position="popper"><SelectItem value="all">所有学习内容</SelectItem>{goals.map((goal) => <SelectItem value={goal.id} key={goal.id}>{goal.title}</SelectItem>)}</SelectContent></Select></div></header>
    {loading && <DataSyncNotice loading title="正在同步个性化与学习偏好" />}{error && <DataSyncNotice title="个性化与学习偏好同步失败" message={error} retryLabel="重新加载" onRetry={() => void load()} />}
    {personalizationOff && <section className="personalization-off-state"><ShieldCheck size={22} /><div><h2>个性化建议已关闭</h2><p>系统不会读取或生成新的学习观察。你可以在设置中重新开启，或继续管理完整数据导出与隐私选择。</p></div><Link href="/studio/settings#settings-privacy">前往 AI 与隐私设置<ArrowRight size={15} /></Link></section>}
    {!personalizationOff && !error && <main className="personalization-content">
      <ProfileFeedbackCard pendingCount={pendingPatterns.length} />
      <section className="personalization-group" aria-labelledby="pending-observations-title"><header><div><small>NEEDS REVIEW</small><h2 id="pending-observations-title">需要你确认的观察</h2><p>这些判断尚未得到你的确认；请先核对表述、依据和适用范围。</p></div><span>{pendingPatterns.length}</span></header>{pendingPatterns.length ? <div className="personalization-list">{pendingPatterns.map((pattern) => <ObservationCard key={pattern.id} pattern={pattern} goals={goals} busy={savingPatternId === pattern.id} initiallyOpen={targetPattern === pattern.id} onAction={handlePatternAction} onDelayAttribution={handleDelayAttribution} />)}</div> : <div className="personalization-empty">目前没有等待确认的观察。</div>}</section>
      <section className="personalization-group" aria-labelledby="applied-observations-title"><header><div><small>APPLIED</small><h2 id="applied-observations-title">已应用的学习偏好 / 观察</h2><p>这些观察已经过你的确认或修正，仍可随时调整、暂停或遗忘。</p></div><span>{appliedPatterns.length}</span></header>{appliedPatterns.length ? <div className="personalization-list">{appliedPatterns.map((pattern) => <ObservationCard key={pattern.id} pattern={pattern} goals={goals} busy={savingPatternId === pattern.id} initiallyOpen={targetPattern === pattern.id} onAction={handlePatternAction} onDelayAttribution={handleDelayAttribution} />)}</div> : <div className="personalization-empty">确认或修正观察后，会显示在这里。</div>}</section>
      {(pausedPatterns.length > 0 || audits.length > 0) && <details className="personalization-advanced"><summary><span><History size={16} /><strong>高级管理与修改记录</strong><small>{pausedPatterns.length} 条已暂停 · {audits.length} 条修改记录</small></span><ChevronDown size={16} /></summary><div>{pausedPatterns.length > 0 && <section><h3>已暂停的观察</h3>{pausedPatterns.map((pattern) => <article key={pattern.id}><div><strong>{pattern.explanation}</strong><small>暂停后不影响建议 · {formatDate(pattern.first_observed_at)}起观察</small></div><button type="button" disabled={savingPatternId === pattern.id} onClick={() => void restorePattern(pattern)}><RotateCcw size={14} />恢复</button></article>)}</section>}{audits.length > 0 && <section><h3>修改记录</h3>{audits.slice(0, 12).map((audit) => { const labels: Record<PatternAudit["action"], string> = { confirm: "确认准确", correct: "修正表述", correct_evidence: "修正延期归因", set_scope: "调整范围", pause: "暂停", restore: "恢复", forget: "永久遗忘", undo: "撤销修改" }; return <article key={audit.id}><div><strong>{labels[audit.action]}</strong><small>{formatDate(audit.created_at)}{audit.reason ? ` · ${audit.reason}` : ""}</small></div>{audit.reversible && !audit.undone_at && <button type="button" onClick={() => void undoAudit(audit)}><RotateCcw size={14} />撤销</button>}</article>; })}</section>}</div></details>}
    </main>}
  </div>;
}
