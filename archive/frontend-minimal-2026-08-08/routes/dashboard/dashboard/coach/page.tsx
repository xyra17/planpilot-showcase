"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BrainCircuit,
  BookOpenCheck,
  Check,
  CheckCircle2,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  History,
  Target,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";

import {
  type DecisionContext,
  type DecisionProposal,
  type FeedbackSummary,
  learnerApi,
} from "@/lib/learner-api";
import { useGoalStore } from "@/lib/stores/goalStore";
import { cn } from "@/lib/utils";
import { InlineNotice } from "@/components/ui/InlineNotice";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";

const PATTERN_LABELS: Record<string, string> = {
  preferred_learning_time: "最佳学习时间",
  preferred_session_length: "单次学习时长",
  weekly_learning_frequency: "每周学习频率",
  completion_rate_trend: "完成率趋势",
  mastery_velocity: "掌握速度",
  delay_pattern: "延期模式",
  plan_adherence: "计划遵从度",
  estimation_accuracy: "估时准确度",
};

const STATUS_TONE: Record<string, StatusTone> = {
  pending: "warning",
  accepted: "info",
  applied: "success",
  rejected: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  accepted: "已接受，待应用",
  applied: "已应用",
  rejected: "已拒绝",
};

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function percent(value: number | null | undefined) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function ProposalLifecycle({ proposal }: { proposal: DecisionProposal }) {
  if (proposal.status === "rejected") {
    return <div className="mt-3 rounded-xl bg-gray-50 px-3 py-2 text-[11px] text-gray-500">已创建 → 已拒绝 · 该建议没有修改任何业务数据</div>;
  }
  const completed = {
    已创建: true,
    已接受: ["accepted", "applied"].includes(proposal.status),
    已应用: proposal.status === "applied",
    已反馈: proposal.has_feedback,
  };
  return (
    <div className="mt-3 flex items-center" aria-label="建议生命周期">
      {Object.entries(completed).map(([label, done], index, rows) => (
        <div key={label} className="flex flex-1 items-center last:flex-none">
          <div className="flex flex-col items-center gap-1">
            <span className={cn("h-2.5 w-2.5 rounded-full transition-all duration-500", done ? "scale-110 bg-[var(--accent)] shadow-[0_0_0_4px_var(--accent-light)]" : "bg-gray-200")} />
            <span className={cn("text-[9px]", done ? "font-semibold text-[var(--accent)]" : "text-gray-400")}>{label}</span>
          </div>
          {index < rows.length - 1 && <span className={cn("mb-4 h-px flex-1 transition-colors duration-500", Object.values(completed)[index + 1] ? "bg-[var(--accent)]" : "bg-gray-200")} />}
        </div>
      ))}
    </div>
  );
}

export default function CoachPage() {
  const { goals, currentGoalId, fetchGoals } = useGoalStore();
  const [goalId, setGoalId] = useState<string | null>(currentGoalId);
  const [context, setContext] = useState<DecisionContext | null>(null);
  const [proposals, setProposals] = useState<DecisionProposal[]>([]);
  const [feedback, setFeedback] = useState<FeedbackSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedbackDone, setFeedbackDone] = useState<Set<string>>(new Set());
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustmentReason, setAdjustmentReason] = useState("按我的实际安排微调");
  const [adjustmentValues, setAdjustmentValues] = useState<Record<string, string>>({});

  useEffect(() => {
    void fetchGoals();
  }, [fetchGoals]);

  useEffect(() => {
    if (!goalId) {
      const firstActive = goals.find((goal) => goal.status === "active");
      if (firstActive) setGoalId(firstActive.id);
    }
  }, [goalId, goals]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextContext, nextProposals, nextFeedback] = await Promise.all([
        learnerApi.getDecisionContext(goalId),
        learnerApi.listProposals(goalId),
        learnerApi.getFeedbackSummary(goalId),
      ]);
      setContext(nextContext);
      setProposals(nextProposals);
      setFeedback(nextFeedback);
    } catch (err) {
      setError(err instanceof Error ? err.message : "学习伙伴数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rebuild = async () => {
    setBusy("rebuild");
    setError(null);
    try {
      await learnerApi.rebuildProfile();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "画像更新失败");
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    setBusy("generate");
    setError(null);
    try {
      await learnerApi.generateProposal(goalId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "建议生成失败");
    } finally {
      setBusy(null);
    }
  };

  const generateAdaptive = async () => {
    if (!goalId) return;
    setBusy("adaptive");
    setError(null);
    try {
      await learnerApi.generateAdaptiveProposal(goalId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "自适应方案生成失败");
    } finally {
      setBusy(null);
    }
  };

  const proposalAction = async (
    proposal: DecisionProposal,
    action: "accept" | "reject" | "apply"
  ) => {
    setBusy(`${proposal.id}:${action}`);
    setError(null);
    try {
      if (action === "accept") await learnerApi.acceptProposal(proposal.id);
      if (action === "reject")
        await learnerApi.rejectProposal(proposal.id, "当前阶段不适合执行这项调整");
      if (action === "apply") await learnerApi.applyProposal(proposal.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "建议状态更新失败");
    } finally {
      setBusy(null);
    }
  };

  const recordFeedback = async (
    proposalId: string,
    outcome: "helpful" | "neutral" | "unhelpful"
  ) => {
    setBusy(`${proposalId}:feedback`);
    setError(null);
    try {
      await learnerApi.recordFeedback(proposalId, outcome);
      setFeedbackDone((current) => new Set(current).add(proposalId));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "反馈提交失败");
    } finally {
      setBusy(null);
    }
  };

  const beginAdjustment = (proposal: DecisionProposal) => {
    const values: Record<string, string> = {};
    if (proposal.proposal_type === "reduce_daily_load") {
      values.daily_hours = String(proposal.proposed_changes.daily_hours ?? "");
    }
    const updates = proposal.proposed_changes.task_updates;
    if (Array.isArray(updates)) {
      updates.forEach((row) => {
        if (row && typeof row === "object" && "task_id" in row && "scheduled_date" in row) {
          values[String(row.task_id)] = String(row.scheduled_date);
        }
      });
    }
    setAdjustmentValues(values);
    setAdjustingId(proposal.id);
  };

  const submitAdjustment = async (proposal: DecisionProposal) => {
    setBusy(`${proposal.id}:adjust`);
    setError(null);
    try {
      let changes: Record<string, unknown> = {};
      if (proposal.proposal_type === "reduce_daily_load") {
        changes = {
          ...proposal.proposed_changes,
          daily_hours: Number(adjustmentValues.daily_hours),
        };
      } else if (proposal.proposal_type === "reschedule_overdue_tasks") {
        const updates = proposal.proposed_changes.task_updates;
        changes = {
          ...proposal.proposed_changes,
          task_updates: Array.isArray(updates)
            ? updates.map((row) => {
                const item = row as { task_id: string; scheduled_date: string };
                return {
                  ...item,
                  scheduled_date: adjustmentValues[item.task_id] ?? item.scheduled_date,
                };
              })
            : [],
        };
      }
      await learnerApi.adjustProposal(proposal.id, changes, adjustmentReason);
      setAdjustingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "建议调整失败");
    } finally {
      setBusy(null);
    }
  };

  const profile = context?.profile;
  const preferredTime =
    profile?.preferred_hour_start != null && profile.preferred_hour_end != null
      ? `${String(profile.preferred_hour_start).padStart(2, "0")}:00–${String(
          profile.preferred_hour_end
        ).padStart(2, "0")}:00`
      : "—";
  const preferredDays = useMemo(
    () =>
      profile?.preferred_weekdays?.map((day) => WEEKDAYS[day]).filter(Boolean).join("、") ||
      "数据积累中",
    [profile?.preferred_weekdays]
  );

  return (
    <div className="coach-dialogue-page min-h-full">
      <header className="coach-dialogue-toolbar">
        <div className="coach-dialogue-heading">
          <span className="coach-dialogue-heading-icon"><BrainCircuit size={20} /></span>
          <div>
            <h1>学习对话</h1>
            <p>把学习规律变成今天可以执行的一步</p>
          </div>
        </div>
        <div className="coach-dialogue-actions">
          <select
            value={goalId ?? ""}
            onChange={(event) => setGoalId(event.target.value || null)}
            aria-label="选择学习伙伴关注的目标"
          >
            <option value="">全部目标</option>
            {goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
          </select>
          <button onClick={rebuild} disabled={busy !== null} className="coach-secondary-action">
            <RefreshCw size={14} className={cn(busy === "rebuild" && "animate-spin")} />
            更新学习数据
          </button>
        </div>
      </header>

      <main className="coach-dialogue-main">
        {error && (
          <InlineNotice
            tone="danger"
            action={<button onClick={() => setError(null)} className="pp-icon-action rounded-lg p-1" aria-label="关闭错误提示"><X size={15} /></button>}
          >{error}</InlineNotice>
        )}

        {loading && !context ? (
          <div className="coach-dialogue-loading">
            <RefreshCw size={17} className="mr-2 animate-spin" /> 正在整理学习行为…
          </div>
        ) : (
          <div className="coach-dialogue-grid">
            <section data-testid="coach-conversation" className="coach-thread">
              <header className="coach-thread-header">
                <div>
                  <span>你的学习伙伴</span>
                  <h2>今天，我们先处理最重要的一件事</h2>
                </div>
                <StatusBadge
                  tone={context?.data_quality.level === "high" ? "success" : context?.data_quality.level === "medium" ? "warning" : "neutral"}
                  compact
                >
                  {context?.data_quality.level === "high" ? "依据充分" : context?.data_quality.level === "medium" ? "依据形成中" : "正在了解你"}
                </StatusBadge>
              </header>

              <div className="coach-thread-content">
                <article className="coach-message-row">
                  <span className="coach-avatar"><Sparkles size={17} /></span>
                  <div className="coach-message-bubble">
                    <div className="coach-message-meta"><strong>PlanPilot 学习伙伴</strong><span>今日观察</span></div>
                    <p>
                    {context?.active_patterns[0]
                      ? `我注意到：${context.active_patterns[0].explanation}。这不是一次偶然记录，而是从你的长期行为中形成的规律。`
                      : "我还在了解你的学习节奏。继续完成任务和打卡后，我会逐步形成有证据来源的建议。"}
                    </p>
                    {!!context?.active_patterns.length && (
                      <div className="coach-message-evidence">
                        <span>{PATTERN_LABELS[context.active_patterns[0].pattern_type] ?? context.active_patterns[0].pattern_type}</span>
                        <span>{context.active_patterns[0].evidence_count} 条证据</span>
                        <span>置信度 {percent(context.active_patterns[0].confidence)}</span>
                      </div>
                    )}
                  </div>
                </article>

                {!!context?.knowledge_gaps.length && (
                  <article className="coach-message-row">
                    <span className="coach-avatar is-muted"><BookOpenCheck size={16} /></span>
                    <div className="coach-message-bubble is-compact">
                      <div className="coach-message-meta"><strong>复习提醒</strong><span>知识保持</span></div>
                      <p>“{context.knowledge_gaps[0].name}”正在出现遗忘信号，当前保持率为 {percent(context.knowledge_gaps[0].retention)}。可以安排一次短复习，不必重新学习全部内容。</p>
                    </div>
                  </article>
                )}

                <div className="coach-thread-divider"><span>需要你决定的建议</span><em>{proposals.length}</em></div>
                <div className="coach-proposal-list">
                  {proposals.map((proposal) => {
                    const patternNames = proposal.evidence_references
                      .map(
                        (id) =>
                          context?.active_patterns.find((pattern) => pattern.id === id)?.pattern_type
                      )
                      .filter(Boolean)
                      .map((type) => PATTERN_LABELS[type as string] ?? type)
                      .join("、");
                    return (
                      <article
                        key={proposal.id}
                        data-testid="proposal-card"
                        className="coach-proposal-card"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold text-gray-900">{proposal.title}</h3>
                            <p className="mt-1 text-xs leading-5 text-gray-500">{proposal.summary}</p>
                          </div>
                          <StatusBadge tone={STATUS_TONE[proposal.status] ?? "neutral"} compact className="shrink-0">
                            {STATUS_LABEL[proposal.status] ?? proposal.status}
                          </StatusBadge>
                        </div>
                        <div className="coach-proposal-reasoning">
                          {proposal.reasoning.map((reason) => (
                            <p key={reason} className="text-xs leading-5 text-gray-600">
                              · {reason}
                            </p>
                          ))}
                          <div className="mt-2 text-[11px] text-gray-400">
                            依据：{patternNames || "活跃学习规律"} · 建议置信度 {percent(proposal.confidence)}
                          </div>
                          {proposal.agent_trace.invocation_id && (
                            <details className="group mt-3 rounded-2xl border border-cyan-100/80 bg-cyan-50/45 text-[11px] text-cyan-900 transition-all duration-300 open:bg-cyan-50/70">
                              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 font-semibold transition-colors duration-300 hover:text-cyan-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 [&::-webkit-details-marker]:hidden">
                                <span>查看生成详情</span>
                                <span aria-hidden="true" className="text-cyan-500 transition-transform duration-300 group-open:rotate-180">⌄</span>
                              </summary>
                              <div className="grid gap-2 border-t border-cyan-100/80 px-3 pb-3 pt-2.5 sm:grid-cols-3">
                                <div>
                                  <div className="text-[10px] font-medium text-cyan-600/80">生成状态</div>
                                  <div className="mt-0.5 font-semibold">{proposal.agent_trace.fallback ? "安全回退" : "正常生成"}</div>
                                </div>
                                <div>
                                  <div className="text-[10px] font-medium text-cyan-600/80">运行时间</div>
                                  <div className="mt-0.5 font-semibold">{proposal.agent_trace.latency_ms != null ? `${proposal.agent_trace.latency_ms} ms` : "已完成"}</div>
                                </div>
                                <div>
                                  <div className="text-[10px] font-medium text-cyan-600/80">生成于</div>
                                  <div className="mt-0.5 font-semibold">{proposal.created_at ? new Date(proposal.created_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "刚刚"}</div>
                                </div>
                              </div>
                              <p className="px-3 pb-3 text-[10px] leading-4 text-cyan-700/75">这里展示的是与本条建议相关的摘要，不包含内部 Prompt、模型输入或其他账户的数据。</p>
                            </details>
                          )}
                        </div>
                        <ProposalLifecycle proposal={proposal} />
                        {adjustingId === proposal.id && (
                          <div className="mt-3 space-y-3 rounded-xl border border-accent-muted bg-accent-light/50 p-3">
                            {proposal.proposal_type === "reduce_daily_load" && (
                              <label className="block text-xs text-gray-600">
                                每日投入（小时）
                                <input
                                  type="number"
                                  min="0.25"
                                  max="16"
                                  step="0.25"
                                  value={adjustmentValues.daily_hours ?? ""}
                                  onChange={(event) =>
                                    setAdjustmentValues((current) => ({
                                      ...current,
                                      daily_hours: event.target.value,
                                    }))
                                  }
                                  className="mt-1 w-full rounded-lg border border-accent-muted bg-white px-2.5 py-2 outline-none"
                                />
                              </label>
                            )}
                            {proposal.proposal_type === "reschedule_overdue_tasks" &&
                              Array.isArray(proposal.proposed_changes.task_updates) &&
                              proposal.proposed_changes.task_updates.map((row) => {
                                const item = row as { task_id: string; scheduled_date: string };
                                return (
                                  <label key={item.task_id} className="block text-xs text-gray-600">
                                    任务 {item.task_id.slice(0, 8)} 的新日期
                                    <input
                                      type="date"
                                      value={adjustmentValues[item.task_id] ?? item.scheduled_date}
                                      onChange={(event) =>
                                        setAdjustmentValues((current) => ({
                                          ...current,
                                          [item.task_id]: event.target.value,
                                        }))
                                      }
                                      className="mt-1 w-full rounded-lg border border-accent-muted bg-white px-2.5 py-2 outline-none"
                                    />
                                  </label>
                                );
                              })}
                            <input
                              value={adjustmentReason}
                              onChange={(event) => setAdjustmentReason(event.target.value)}
                              placeholder="调整原因"
                              className="w-full rounded-lg border border-accent-muted bg-white px-2.5 py-2 text-xs outline-none"
                            />
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => setAdjustingId(null)}
                                className="rounded-lg px-3 py-1.5 text-xs text-gray-500"
                              >
                                取消
                              </button>
                              <button
                                onClick={() => submitAdjustment(proposal)}
                                disabled={busy !== null || !adjustmentReason.trim()}
                                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                              >
                                保存调整
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="mt-3 flex flex-wrap justify-end gap-2">
                          {proposal.status === "pending" && (
                            <>
                              <button
                                onClick={() => proposalAction(proposal, "reject")}
                                disabled={busy !== null}
                                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                              >
                                <X size={13} /> 拒绝
                              </button>
                              <button
                                onClick={() => beginAdjustment(proposal)}
                                disabled={
                                  busy !== null ||
                                  !["reduce_daily_load", "reschedule_overdue_tasks"].includes(
                                    proposal.proposal_type
                                  )
                                }
                                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-40"
                              >
                                <SlidersHorizontal size={13} /> 调整
                              </button>
                              <button
                                onClick={() => proposalAction(proposal, "accept")}
                                disabled={busy !== null}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-light)] px-3 py-1.5 text-xs font-medium text-[var(--accent)] disabled:opacity-50"
                              >
                                <Check size={13} /> 接受建议
                              </button>
                            </>
                          )}
                          {proposal.status === "accepted" && (
                            <button
                              onClick={() => proposalAction(proposal, "apply")}
                              disabled={busy !== null}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                            >
                              <Zap size={13} /> 应用变更
                            </button>
                          )}
                          {proposal.status === "applied" && !proposal.has_feedback && !feedbackDone.has(proposal.id) && (
                            <div className="flex items-center gap-1.5 text-xs text-gray-400">
                              <span className="mr-1">这项建议有效吗？</span>
                              <button
                                onClick={() => recordFeedback(proposal.id, "helpful")}
                                disabled={busy !== null}
                                className="rounded-lg p-1.5 hover:bg-emerald-50 hover:text-emerald-600"
                                title="有效"
                              >
                                <ThumbsUp size={14} />
                              </button>
                              <button
                                onClick={() => recordFeedback(proposal.id, "neutral")}
                                disabled={busy !== null}
                                className="rounded-lg px-2 py-1 hover:bg-gray-100"
                              >
                                一般
                              </button>
                              <button
                                onClick={() => recordFeedback(proposal.id, "unhelpful")}
                                disabled={busy !== null}
                                className="rounded-lg p-1.5 hover:bg-red-50 hover:text-red-500"
                                title="无效"
                              >
                                <ThumbsDown size={14} />
                              </button>
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                  {!proposals.length && (
                    <div className="coach-proposal-empty">
                      <span><Sparkles size={20} /></span>
                      <div><strong>目前没有需要确认的调整</strong><p>你可以让学习伙伴根据当前规律生成一条有依据的建议。</p></div>
                      <button onClick={generate} disabled={busy !== null || !context?.active_patterns.length}>生成建议</button>
                    </div>
                  )}
                </div>
              </div>
              <footer className="coach-thread-footer">
                <p><CheckCircle2 size={14} />所有计划变更都需要你确认</p>
                <div>
                  <button onClick={generateAdaptive} disabled={busy !== null || !goalId}><BrainCircuit size={14} />规划下一步</button>
                  <button onClick={generate} disabled={busy !== null || !context?.active_patterns.length} className="is-primary"><Sparkles size={14} />生成建议</button>
                </div>
              </footer>
            </section>

            <aside className="coach-context-rail" aria-label="学习伙伴决策上下文">
              <section className="coach-context-card">
                <div className="coach-context-title"><div><span>当前状态</span><h2>学习伙伴正在参考</h2></div><Activity size={17} /></div>
                <div className="coach-snapshot-grid">
                  <div><strong>{percent(profile?.completion_rate_30d)}</strong><span>30 天完成率</span></div>
                  <div><strong>{percent(profile?.consistency_score)}</strong><span>学习一致性</span></div>
                  <div><strong>{preferredTime}</strong><span>{preferredDays}</span></div>
                  <div><strong>{profile?.event_count ?? 0}</strong><span>学习事件</span></div>
                </div>
              </section>

              <section className="coach-context-card">
                <div className="coach-context-title"><div><span>行为依据</span><h2>为什么这样建议</h2></div><Target size={17} /></div>
                <div className="coach-evidence-list">
                  {context?.active_patterns.slice(0, 3).map((pattern) => (
                    <div key={pattern.id}>
                      <span className="coach-evidence-dot" />
                      <div><strong>{PATTERN_LABELS[pattern.pattern_type] ?? pattern.pattern_type}</strong><p>{pattern.explanation}</p><small>{pattern.evidence_count} 条证据 · {percent(pattern.confidence)}</small></div>
                    </div>
                  ))}
                  {!context?.active_patterns.length && <p className="coach-context-empty">长期规律仍在形成</p>}
                </div>
              </section>

              <section className="coach-context-card">
                <div className="coach-context-title"><div><span>长期记忆</span><h2>我记得的学习经历</h2></div><History size={17} /></div>
                <div className="coach-memory-list">
                  {context?.memories.episodic.slice(0, 3).map((memory) => <p key={memory.id}>{memory.summary}</p>)}
                  {!context?.memories.episodic.length && <p className="coach-context-empty">突破、失败与恢复会沉淀在这里</p>}
                </div>
              </section>

              <section className="coach-context-card is-compact">
                <div className="coach-context-title"><div><span>反馈闭环</span><h2>建议正在变得更准确</h2></div><TrendingUp size={17} /></div>
                <div className="coach-feedback-row">
                  <div><strong>{percent(feedback?.accept_rate)}</strong><span>接受率</span></div>
                  <div><strong>{percent(feedback?.apply_rate)}</strong><span>应用率</span></div>
                  <div><strong>{percent(feedback?.pattern_accuracy)}</strong><span>准确率</span></div>
                </div>
              </section>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
