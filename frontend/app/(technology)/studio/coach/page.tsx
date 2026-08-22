"use client";

import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BrainCircuit,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock3,
  Download,
  FileSearch,
  Gauge,
  HeartHandshake,
  History,
  Lightbulb,
  LoaderCircle,
  MessageCircle,
  MessagesSquare,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  TextQuote,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAuth } from "@/components/technology/AuthProvider";
import { PiloAvatar } from "@/components/technology/PiloAvatar";
import { UserAvatar } from "@/components/technology/UserAvatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type ActivePattern,
  type DecisionContext,
  type DecisionProposal,
  learnerApi,
} from "@/lib/learner-api";
import {
  productApi,
  streamAgentMessage,
  type CoachArchiveConversation,
  type ApiGoal,
} from "@/lib/technology/productApi";
import {
  PILO_SURFACE_LABELS,
  parsePiloCoachEntry,
  type PiloCoachEntry,
} from "@/lib/technology/piloCoachRoute";
import {
  clearPiloCoachTransition,
  readPiloCoachTransition,
  type PiloCoachTransition,
} from "@/lib/technology/piloTransition";
import { clearPiloState, signalPiloAgentPhase } from "@/lib/technology/piloState";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};

type DemoProposalState = "pending" | "applied" | "dismissed";

type PiloConversation = {
  id: string;
  sessionId: string;
  goalId: string | null;
  goalTitle: string;
  title: string;
  summary: string;
  piloFeedback: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  association: string;
  isFavorite: boolean;
};

type PiloPreferences = {
  tone: "warm" | "direct" | "socratic";
  initiative: "quiet" | "balanced" | "proactive";
  detail: "brief" | "balanced" | "deep";
  celebrateProgress: boolean;
  motion: "calm" | "lively";
};

type HistoryDateOption = { value: string; label: string };

function HistoryDateSelect({
  label,
  ariaLabel,
  value,
  options,
  onValueChange,
  theme,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  options: HistoryDateOption[];
  onValueChange: (value: string) => void;
  theme: "light" | "dark";
}) {
  return (
    <div className="companion-history-date-field">
      <span className="companion-history-date-field__label">{label}</span>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="companion-history-date-trigger" aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={`companion-history-date-menu is-${theme}`} position="popper" sideOffset={6}>
          {options.map((option) => <SelectItem className="companion-history-date-option" value={option.value} key={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

const PATTERN_LABELS: Record<string, string> = {
  preferred_learning_time: "高效学习时段",
  preferred_session_length: "专注时长",
  weekly_learning_frequency: "学习频率",
  completion_rate_trend: "完成趋势",
  mastery_velocity: "掌握速度",
  delay_pattern: "延期模式",
  plan_adherence: "计划执行",
  estimation_accuracy: "估时特征",
};

const DEMO_MESSAGES: ChatMessage[] = [];

const DEMO_GOALS: ApiGoal[] = [
  {
    id: "demo-goal-algorithm",
    type: "skill",
    title: "算法进阶",
    deadline: "2026-12-31",
    daily_hours: 1.5,
    current_level: "进阶中",
    status: "active",
    created_at: "2026-07-01T08:00:00.000Z",
  },
  {
    id: "demo-goal-data-structure",
    type: "skill",
    title: "数据结构巩固",
    deadline: "2026-11-30",
    daily_hours: 1,
    current_level: "巩固中",
    status: "active",
    created_at: "2026-07-08T08:00:00.000Z",
  },
];

const DEFAULT_PILO_PREFERENCES: PiloPreferences = {
  tone: "warm",
  initiative: "balanced",
  detail: "balanced",
  celebrateProgress: true,
  motion: "calm",
};

const conversationToArchive = (conversation: PiloConversation): CoachArchiveConversation => ({
  id: conversation.id,
  session_id: conversation.sessionId,
  goal_id: conversation.goalId,
  goal_title: conversation.goalTitle,
  title: conversation.title,
  summary: conversation.summary,
  pilo_feedback: conversation.piloFeedback,
  messages: conversation.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    created_at: message.createdAt,
  })),
  association: conversation.association,
  is_favorite: conversation.isFavorite,
  created_at: conversation.createdAt,
  updated_at: conversation.updatedAt,
});

const conversationFromArchive = (conversation: CoachArchiveConversation): PiloConversation => ({
  id: conversation.id,
  sessionId: conversation.session_id,
  goalId: conversation.goal_id,
  goalTitle: conversation.goal_title,
  title: conversation.title,
  summary: conversation.summary,
  piloFeedback: conversation.pilo_feedback,
  messages: conversation.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.created_at,
  })),
  association: conversation.association,
  isFavorite: Boolean(conversation.is_favorite),
  createdAt: conversation.created_at,
  updatedAt: conversation.updated_at,
});

const demoTimestamp = (daysAgo: number, hour: number, minute: number) => {
  const value = new Date();
  value.setDate(value.getDate() - daysAgo);
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
};

const formatMessageTime = (createdAt?: string) => {
  if (!createdAt) return "";
  const value = new Date(createdAt);
  if (Number.isNaN(value.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
};

const restoreMessageTimes = (conversation: PiloConversation) => {
  const start = new Date(conversation.createdAt).getTime();
  const end = new Date(conversation.updatedAt).getTime();
  const validStart = Number.isNaN(start) ? Date.now() : start;
  const validEnd = Number.isNaN(end) ? validStart : Math.max(validStart, end);
  const interval = conversation.messages.length > 1 ? (validEnd - validStart) / (conversation.messages.length - 1) : 0;
  return conversation.messages.map((message, index) => ({
    ...message,
    createdAt: message.createdAt ?? new Date(validStart + interval * index).toISOString(),
  }));
};

const demoMonthTimestamp = (monthOffset: number, day: number, hour: number, minute: number) => {
  const value = new Date();
  value.setMonth(value.getMonth() + monthOffset, day);
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
};

const DEMO_ARCHIVE_VERSION = 2;
const DEMO_ARCHIVE_VERSION_KEY = "planpilot:pilo-demo-archive-version";

const DEMO_CONVERSATIONS: PiloConversation[] = [
  {
    id: "demo-plan-adjustment",
    sessionId: "demo-plan-adjustment",
    goalId: null,
    goalTitle: "算法进阶",
    title: "调整本周算法计划",
    summary: "周五负荷过高，重新安排动态规划练习与恢复时间。",
    piloFeedback: "保留核心练习，把 95 分钟恢复空间留到周末；这次调整先试一周。",
    association: "关联 4 个任务 · 1 条待确认方案",
    isFavorite: true,
    createdAt: demoTimestamp(0, 9, 20),
    updatedAt: demoTimestamp(0, 10, 6),
    messages: [
      { id: "demo-1-u1", role: "user", content: "这周算法题比预计慢，周五还排了两组动态规划，我担心做不完。" },
      { id: "demo-1-a1", role: "assistant", content: "我看了最近的完成节奏。周五继续维持原负荷会比较吃力，我们可以先保住最重要的一组练习，把恢复空间留出来。" },
      { id: "demo-1-u2", role: "user", content: "可以，但我不想把核心练习全部往后拖。" },
      { id: "demo-1-a2", role: "assistant", content: "明白。那就保留核心练习，只把一组补充题移到周末，预计释放 95 分钟。先试一周，任何计划变化都由你确认。" },
    ],
  },
  {
    id: "demo-linked-list-review",
    sessionId: "demo-linked-list-review",
    goalId: null,
    goalTitle: "数据结构巩固",
    title: "复盘链表错题",
    summary: "定位双指针的重复错误，并安排三天后的短复习。",
    piloFeedback: "错误主要发生在边界更新，不需要重做整章；三天后做一次 20 分钟检索练习。",
    association: "关联 1 篇笔记 · 6 道错题",
    isFavorite: false,
    createdAt: demoTimestamp(1, 20, 40),
    updatedAt: demoTimestamp(1, 21, 12),
    messages: [
      { id: "demo-2-u1", role: "user", content: "我今天链表双指针又错了两题，是不是应该把整章重新学一遍？" },
      { id: "demo-2-a1", role: "assistant", content: "先不用重学整章。你重复出错的位置集中在快慢指针的边界更新，而不是概念本身。" },
      { id: "demo-2-u2", role: "user", content: "那怎么复习更有效？" },
      { id: "demo-2-a2", role: "assistant", content: "今天只整理两个错误触发点，三天后安排一次 20 分钟无提示练习。我会把你的链表笔记和这 6 道错题一起关联进复习。" },
    ],
  },
  {
    id: "demo-load-recovery",
    sessionId: "demo-load-recovery",
    goalId: null,
    goalTitle: "跨目标节奏",
    title: "降低学习负荷",
    summary: "连续延期后停止集中补偿，先恢复可持续的连续性。",
    piloFeedback: "接下来三天每天保留 45 分钟高优任务，暂缓补偿欠下的全部进度。",
    association: "关联 2 个目标 · 近期 3 次延期",
    isFavorite: false,
    createdAt: demoTimestamp(3, 19, 10),
    updatedAt: demoTimestamp(3, 19, 36),
    messages: [
      { id: "demo-3-u1", role: "user", content: "我连续延期了三天，想周末一次性全部补回来。" },
      { id: "demo-3-a1", role: "assistant", content: "我理解你想尽快追回进度，但一次性补偿很可能继续打乱节奏。我们先把连续性找回来。" },
      { id: "demo-3-u2", role: "user", content: "那这周应该做到什么程度？" },
      { id: "demo-3-a2", role: "assistant", content: "接下来三天每天只保留 45 分钟最高优任务，其余欠账先不追。等完成节奏稳定后，再决定哪些内容值得补。" },
    ],
  },
  {
    id: "demo-monthly-review",
    sessionId: "demo-monthly-review",
    goalId: null,
    goalTitle: "算法进阶",
    title: "整理本月薄弱题型",
    summary: "把本月反复出错的题型整理成下一轮练习重点。",
    piloFeedback: "先保留状态转移和边界判断两类，不需要把所有错题重新做一遍。",
    association: "关联 2 篇笔记 · 8 道错题",
    isFavorite: false,
    createdAt: demoMonthTimestamp(0, 1, 18, 40),
    updatedAt: demoMonthTimestamp(0, 1, 19, 8),
    messages: [
      { id: "demo-4-u1", role: "user", content: "这个月错题有点散，我不知道该从哪里重新开始。" },
      { id: "demo-4-a1", role: "assistant", content: "先按重复错误归类，不按章节重学。状态转移和边界判断出现得最多，可以作为下一轮重点。" },
      { id: "demo-4-u2", role: "user", content: "那其他错题暂时不管吗？" },
      { id: "demo-4-a2", role: "assistant", content: "先保留记录，不急着全部重做。等两类高频问题稳定后再补剩余内容。" },
    ],
  },
  {
    id: "demo-previous-month",
    sessionId: "demo-previous-month",
    goalId: null,
    goalTitle: "学习节奏",
    title: "复盘上月学习节奏",
    summary: "回看上月完成情况，减少计划过密造成的连续延期。",
    piloFeedback: "晚间高认知任务控制在一项，连续完成比一次安排三项更适合你。",
    association: "关联 1 份月度复盘 · 3 条规律",
    isFavorite: true,
    createdAt: demoMonthTimestamp(-1, 12, 20, 10),
    updatedAt: demoMonthTimestamp(-1, 12, 20, 42),
    messages: [
      { id: "demo-5-u1", role: "user", content: "上个月计划经常拖到第二天，是不是安排得太松了？" },
      { id: "demo-5-a1", role: "assistant", content: "更像是晚间高认知任务叠得太多，不是太松。连续完成比集中补偿更重要。" },
      { id: "demo-5-u2", role: "user", content: "下个月怎么控制？" },
      { id: "demo-5-a2", role: "assistant", content: "每个晚间只放一项高认知任务，其余作为可选项，再观察两周。" },
    ],
  },
];

const DEMO_PATTERNS: ActivePattern[] = [
  {
    id: "demo-evening",
    goal_id: null,
    scope: "user",
    pattern_type: "preferred_learning_time",
    pattern_value: { peak_hours: [19, 20] },
    confidence: 0.82,
    evidence_count: 18,
    last_confirmed_at: null,
    evidence: [],
    explanation: "工作日晚间 19:00–21:00 更容易完成高认知任务",
  },
  {
    id: "demo-recovery",
    goal_id: null,
    scope: "user",
    pattern_type: "plan_adherence",
    pattern_value: {},
    confidence: 0.74,
    evidence_count: 11,
    last_confirmed_at: null,
    evidence: [],
    explanation: "延期后先恢复连续性，比集中补偿更容易坚持",
  },
  {
    id: "demo-duration",
    goal_id: null,
    scope: "user",
    pattern_type: "preferred_session_length",
    pattern_value: { minutes: 45 },
    confidence: 0.69,
    evidence_count: 9,
    last_confirmed_at: null,
    evidence: [],
    explanation: "高负荷周将单次学习控制在 45 分钟左右更稳定",
  },
];

const DEMO_RESOURCES = [
  "动态规划题型总结.pdf",
  "链表双指针笔记",
  "前端面试高频题.md",
];

const QUICK_PROMPTS = [
  { label: "讨论观察", prompt: "我想先讨论你刚才的观察，请解释它对我当前学习安排的影响", icon: MessagesSquare, kind: "discuss" },
  { label: "解释节奏", prompt: "解释我最近的学习节奏和风险", icon: Clock3, kind: "rhythm" },
  { label: "安排复习", prompt: "从资料库里安排一次针对性复习", icon: RefreshCw, kind: "review" },
];

const INPUT_BOUNDARY_NOTES = [
  "Pilo 会给建议，但不会替你做决定",
  "调整会先生成预览，确认后才会应用",
  "Pilo 不会自动修改你的计划或长期记忆",
] as const;

const MORE_PILO_PROMPTS = [
  ["复盘进展", "帮我复盘最近一周的完成情况、变化和下一步"],
  ["检查知识盲点", "结合近期任务、错题和笔记，帮我找出反复卡住的知识点"],
  ["拆分目标", "把当前目标拆成几个清晰阶段，并给出最小可执行的下一步"],
  ["修正学习观察", "我想检查并修正你对我的长期学习观察"],
];

const COACH_THEME_STORAGE_KEY = "planpilot:coach-theme-v1";

const PILO_TONE_OPTIONS: Array<{ value: PiloPreferences["tone"]; label: string; description: string }> = [
  { value: "warm", label: "温暖平和", description: "先理解感受，再一起梳理行动" },
  { value: "direct", label: "直接清晰", description: "快速指出问题，给出明确下一步" },
  { value: "socratic", label: "提问引导", description: "用问题帮助你自己形成判断" },
];

const PILO_INITIATIVE_OPTIONS: Array<{ value: PiloPreferences["initiative"]; label: string; description: string }> = [
  { value: "quiet", label: "安静陪伴", description: "只在你主动发起时回应" },
  { value: "balanced", label: "适时出现", description: "发现明显风险或机会时提醒" },
  { value: "proactive", label: "主动跟进", description: "主动复盘进度并询问下一步" },
];

const PILO_DETAIL_OPTIONS: Array<{ value: PiloPreferences["detail"]; label: string }> = [
  { value: "brief", label: "简洁" },
  { value: "balanced", label: "平衡" },
  { value: "deep", label: "深入" },
];

const confidenceMeta = (value: number) => {
  if (value >= 0.78) return { label: "多次验证", tone: "stable" };
  if (value >= 0.55) return { label: "仍需观察", tone: "forming" };
  return { label: "仅作参考", tone: "observing" };
};

const openingPatternGuidance = (pattern?: ActivePattern) => {
  if (!pattern) return "你不需要先把问题整理好。计划变了、学不动了，或者只是有点乱，都可以直接告诉我。";

  switch (pattern.pattern_type) {
    case "preferred_learning_time":
      return "把最费脑的一小步放进这个时段即可，不必塞满任务。是否调整，由你决定。";
    case "preferred_session_length":
      return "与其拉长一次学习，不如先按这个时长完成一轮，再根据感受决定要不要继续。";
    case "weekly_learning_frequency":
    case "completion_rate_trend":
    case "delay_pattern":
    case "plan_adherence":
      return "先不用急着补齐全部进度。我们可以从最重要的一小步恢复连续性，再由你决定是否调整。";
    case "mastery_velocity":
      return "这反映的是当前理解速度，不是能力结论。可以先针对卡点做一次短复习，再看结果。";
    case "estimation_accuracy":
      return "计划时间和实际投入可能有偏差。可以先校准下一项任务，不必一次改完整周计划。";
    default:
      return "这是一项仍需要与你确认的学习规律。我们可以先看依据，再决定是否调整。";
  }
};

const compactConversationText = (value: string, limit = 34) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
};

const localDateKey = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;

const monthKey = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;

const getStartOfCurrentWeek = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
};

const conversationTimeLabel = (isoDate: string) => new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(new Date(isoDate));

const proposalStatusLabel: Record<string, string> = {
  pending: "待确认",
  accepted: "已确认",
  applied: "已应用",
  rejected: "已保留原计划",
  expired: "已过期",
};

function proposalChanges(proposal: DecisionProposal) {
  const changes = proposal.proposed_changes ?? {};
  const rows: string[] = [];
  if (typeof changes.daily_hours === "number") {
    rows.push(`每日投入调整为 ${changes.daily_hours} 小时`);
  }
  if (Array.isArray(changes.task_updates)) {
    rows.push(`${changes.task_updates.length} 项任务重新安排时间`);
  }
  if (Array.isArray(changes.tasks_to_create)) {
    rows.push(`新增 ${changes.tasks_to_create.length} 项学习任务`);
  }
  if (Array.isArray(changes.tasks_to_skip)) {
    rows.push(`暂缓 ${changes.tasks_to_skip.length} 项低优先级任务`);
  }
  if (!rows.length) rows.push("这是一条策略建议，不会绕过你的确认修改数据");
  return rows;
}

function CoachProposal({
  proposal,
  busy,
  onConfirm,
  onReject,
  onDiscuss,
  onFeedback,
}: {
  proposal: DecisionProposal;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onDiscuss: () => void;
  onFeedback: (outcome: "helpful" | "unhelpful") => void;
}) {
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const confidence = confidenceMeta(proposal.confidence);
  const canConfirm = proposal.status === "pending" || proposal.status === "accepted";

  return (
    <motion.article
      layout
      className={`companion-proposal is-${proposal.status}`}
      initial={{ opacity: 0, y: reduceMotion ? 0 : 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <header>
        <div>
          <span className="companion-proposal-kicker"><Sparkles size={12} /> 可执行建议</span>
          <h2>{proposal.title}</h2>
        </div>
        <span className={`companion-status is-${proposal.status}`}>
          <i /> {proposalStatusLabel[proposal.status] ?? proposal.status}
        </span>
      </header>
      <p>{proposal.summary}</p>
      <div className="companion-proposal-meta">
        <span>{confidence.label}</span>
        <span>{proposal.evidence_references.length || 1} 组判断依据</span>
        <span>所有变更需确认</span>
      </div>
      <button
        type="button"
        className="companion-details-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown size={14} /> {expanded ? "收起方案详情" : "查看方案详情"}
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="companion-proposal-details"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.22 }}
          >
            <div>
              <small>将会发生</small>
              {proposalChanges(proposal).map((row) => <span key={row}><Check size={13} /> {row}</span>)}
            </div>
            <div>
              <small>为什么</small>
              {(proposal.reasoning.length ? proposal.reasoning : ["依据当前学习节奏与执行状态生成"]).slice(0, 3).map((row) => <span key={row}><CircleDot size={12} /> {row}</span>)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {canConfirm ? (
        <footer>
          <button type="button" className="is-quiet" onClick={onDiscuss} disabled={busy}>先讨论</button>
          {proposal.status === "pending" && <button type="button" className="is-quiet" onClick={onReject} disabled={busy}>暂不调整</button>}
          <button type="button" className="is-primary" onClick={onConfirm} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
            {proposal.status === "accepted" ? "应用变更" : "确认并应用"}
          </button>
        </footer>
      ) : proposal.status === "applied" && !proposal.has_feedback ? (
        <footer className="is-feedback">
          <span><CheckCircle2 size={14} /> 已应用。这次调整有帮助吗？</span>
          <div>
            <button type="button" aria-label="这次调整有帮助" onClick={() => onFeedback("helpful")} disabled={busy}><ThumbsUp size={14} /></button>
            <button type="button" aria-label="这次调整没有帮助" onClick={() => onFeedback("unhelpful")} disabled={busy}><ThumbsDown size={14} /></button>
          </div>
        </footer>
      ) : (
        <footer className="is-resolved"><span><ShieldCheck size={14} /> 这项决定已记录</span></footer>
      )}
    </motion.article>
  );
}

export default function CoachPage() {
  const { status: authStatus, user } = useAuth();
  const reduceMotion = useReducedMotion();
  const [goals, setGoals] = useState<ApiGoal[]>([]);
  const [goalId, setGoalId] = useState("");
  const [resources, setResources] = useState<string[]>([]);
  const [context, setContext] = useState<DecisionContext | null>(null);
  const [proposals, setProposals] = useState<DecisionProposal[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(DEMO_MESSAGES);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [abilitiesOpen, setAbilitiesOpen] = useState(false);
  const [goalMenuOpen, setGoalMenuOpen] = useState(false);
  const [coachTheme, setCoachTheme] = useState<"light" | "dark">("light");
  const [lampPulling, setLampPulling] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [openingObservationExpanded, setOpeningObservationExpanded] = useState(true);
  const [boundaryNoteIndex, setBoundaryNoteIndex] = useState(0);
  const [contextSections, setContextSections] = useState({ patterns: true, retention: true, memories: false, resources: false });
  const [settingsSections, setSettingsSections] = useState({ tone: true, initiative: false, detail: false, behavior: false });
  const [conversations, setConversations] = useState<PiloConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyGoalFilter, setHistoryGoalFilter] = useState("all");
  const [historyGoalMenuOpen, setHistoryGoalMenuOpen] = useState(false);
  const [historyFavoritesOnly, setHistoryFavoritesOnly] = useState(false);
  const [historyWeekDate, setHistoryWeekDate] = useState("");
  const [historyWeekExpanded, setHistoryWeekExpanded] = useState(true);
  const [historyArchiveExpanded, setHistoryArchiveExpanded] = useState(false);
  const [historyArchiveYear, setHistoryArchiveYear] = useState("");
  const [historyArchiveMonth, setHistoryArchiveMonth] = useState("");
  const [historyArchiveDay, setHistoryArchiveDay] = useState("");
  const [pendingDeleteConversationId, setPendingDeleteConversationId] = useState("");
  const [piloPreferences, setPiloPreferences] = useState<PiloPreferences>(DEFAULT_PILO_PREFERENCES);
  const [demoProposalState, setDemoProposalState] = useState<DemoProposalState>("pending");
  const [demoProposalVisible, setDemoProposalVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [coachTransition, setCoachTransition] = useState<PiloCoachTransition | null>(null);
  const [coachTransitionOffset, setCoachTransitionOffset] = useState({ x: 0, y: 0 });
  const [coachTransitionReady, setCoachTransitionReady] = useState(false);
  const [coachTransitionSettled, setCoachTransitionSettled] = useState(false);
  const [coachEntry, setCoachEntry] = useState<PiloCoachEntry | null>(null);
  const sessionIdRef = useRef(typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `session-${Date.now()}`);
  const abortRef = useRef<AbortController | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const historyScrollRef = useRef<HTMLDivElement | null>(null);
  const historyScrollTimerRef = useRef<number | undefined>(undefined);
  const restoringConversationRef = useRef(false);
  const shouldFollowConversationRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const headerPiloRef = useRef<HTMLSpanElement | null>(null);
  const goalPickerRef = useRef<HTMLDivElement | null>(null);
  const goalPickerButtonRef = useRef<HTMLButtonElement | null>(null);
  const lampTimerRef = useRef<number | undefined>(undefined);
  const coachArchiveReadyRef = useRef(false);
  const contextRequestRef = useRef(0);
  const coachArchiveImportRef = useRef<HTMLInputElement | null>(null);
  const initialCoachTransitionRef = useRef<PiloCoachTransition | null | undefined>(undefined);

  const activeGoal = goalId ? goals.find((goal) => goal.id === goalId) ?? null : null;
  const selectedGoal = goals.find((goal) => goal.id === goalId) ?? null;
  const selectedGoalLabel = selectedGoal?.title ?? "不限目标";
  const linkedEntryGoals = (coachEntry?.goalIds ?? [])
    .map((linkedGoalId) => goals.find((goal) => goal.id === linkedGoalId))
    .filter((goal): goal is ApiGoal => Boolean(goal));
  const showOpeningObservation = !coachEntry || coachEntry.entryMode === "observation";
  const conversationStorageKey = `planpilot:pilo-conversations:${user?.id ?? "guest"}`;
  const preferencesStorageKey = `planpilot:pilo-preferences:${user?.id ?? "guest"}`;
  const patterns = authStatus === "unauthenticated" ? DEMO_PATTERNS : context?.active_patterns ?? [];
  const primaryPattern = patterns[0];
  const primaryPatternConfidence = primaryPattern ? confidenceMeta(primaryPattern.confidence) : null;
  const primaryEvidenceCount = primaryPattern?.evidence_count ?? 0;
  const primaryGap = context?.knowledge_gaps[0];
  const dataQuality = context?.data_quality.level ?? (authStatus === "unauthenticated" ? "high" : "low");
  const qualityLabel = authStatus === "loading"
    ? "正在连接学习上下文"
    : dataQuality === "high" ? "已经比较了解你的节奏" : dataQuality === "medium" ? "正在了解你的节奏" : "刚开始了解你";
  const semanticMemories = context?.memories.semantic ?? [];
  const displayUsername = user?.username?.trim() || "访客";
  const hasPendingProposal = authStatus === "authenticated"
    ? proposals.some((proposal) => proposal.status === "pending" || proposal.status === "accepted")
    : demoProposalState === "pending";
  const routedObservation = coachEntry?.entryMode === "observation" ? coachEntry : null;
  const openingObservationTitle = routedObservation?.observationTitle ?? primaryPattern?.explanation ?? "今天想从哪里开始？";
  const openingObservationGuidance = routedObservation?.reason ?? openingPatternGuidance(primaryPattern);

  const scrollConversation = useCallback((edge: "start" | "end", behavior: ScrollBehavior = "auto") => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const feed = feedRef.current;
        if (!feed) return;
        feed.scrollTo({
          top: edge === "end" ? feed.scrollHeight : 0,
          behavior,
        });
      });
    });
  }, []);

  const handleFeedScroll = useCallback(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const distanceFromBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    shouldFollowConversationRef.current = distanceFromBottom < 72;
  }, []);

  const handleHistoryScroll = useCallback(() => {
    const scrollRegion = historyScrollRef.current;
    if (!scrollRegion) return;
    if (historyScrollTimerRef.current) window.clearTimeout(historyScrollTimerRef.current);
    scrollRegion.classList.add("is-scrolling");
    historyScrollTimerRef.current = window.setTimeout(() => {
      scrollRegion.classList.remove("is-scrolling");
      historyScrollTimerRef.current = undefined;
    }, 720);
  }, []);

  useEffect(() => () => {
    if (historyScrollTimerRef.current) window.clearTimeout(historyScrollTimerRef.current);
  }, []);

  const scrollFeedElementIntoView = useCallback((elementId: string, behavior: ScrollBehavior = "smooth") => {
    window.requestAnimationFrame(() => {
      const feed = feedRef.current;
      const element = document.getElementById(elementId);
      if (!feed || !element) return;
      const feedBounds = feed.getBoundingClientRect();
      const elementBounds = element.getBoundingClientRect();
      const targetTop = feed.scrollTop + elementBounds.top - feedBounds.top - Math.max(18, (feed.clientHeight - elementBounds.height) / 2);
      feed.scrollTo({ top: Math.max(0, targetTop), behavior });
    });
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setInterval(() => {
      setBoundaryNoteIndex((current) => (current + 1) % INPUT_BOUNDARY_NOTES.length);
    }, 90_000);
    return () => window.clearInterval(timer);
  }, [reduceMotion]);

  const toggleContextSection = useCallback((section: keyof typeof contextSections) => {
    setContextSections((current) => ({ ...current, [section]: !current[section] }));
  }, []);

  const toggleSettingsSection = useCallback((section: keyof typeof settingsSections) => {
    setSettingsSections((current) => ({ ...current, [section]: !current[section] }));
  }, []);
  const historyGoalOptions = useMemo(() => Array.from(new Set(conversations.map((conversation) => conversation.goalTitle))), [conversations]);
  const filteredConversations = useMemo(() => {
    const query = historyQuery.trim().toLocaleLowerCase("zh-CN");
    return conversations
      .filter((conversation) => historyGoalFilter === "all" || conversation.goalTitle === historyGoalFilter)
      .filter((conversation) => !historyFavoritesOnly || conversation.isFavorite)
      .filter((conversation) => {
        if (!query) return true;
        const searchable = [
          conversation.title,
          conversation.summary,
          conversation.piloFeedback,
          conversation.goalTitle,
          conversation.association,
          ...conversation.messages.map((message) => message.content),
        ].join(" ").toLocaleLowerCase("zh-CN");
        return searchable.includes(query);
      })
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }, [conversations, historyFavoritesOnly, historyGoalFilter, historyQuery]);
  const historyIsFiltering = Boolean(historyQuery.trim()) || historyGoalFilter !== "all" || historyFavoritesOnly;
  const historyWeekDays = useMemo(() => {
    const start = getStartOfCurrentWeek();
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = localDateKey(date);
      const count = filteredConversations.filter((conversation) => localDateKey(new Date(conversation.updatedAt)) === key).length;
      return { date, key, count, weekday: ["一", "二", "三", "四", "五", "六", "日"][index] };
    });
  }, [filteredConversations]);
  const weekStartTime = historyWeekDays[0]?.date.getTime() ?? getStartOfCurrentWeek().getTime();
  const weekEndTime = weekStartTime + 7 * 86_400_000;
  const allWeekConversations = useMemo(() => filteredConversations.filter((conversation) => {
    const updatedAt = new Date(conversation.updatedAt);
    return updatedAt.getTime() >= weekStartTime && updatedAt.getTime() < weekEndTime;
  }), [filteredConversations, weekEndTime, weekStartTime]);
  const weekConversations = useMemo(() => allWeekConversations.filter((conversation) => !historyWeekDate || localDateKey(new Date(conversation.updatedAt)) === historyWeekDate), [allWeekConversations, historyWeekDate]);
  const archiveConversations = useMemo(() => filteredConversations.filter((conversation) => new Date(conversation.updatedAt).getTime() < weekStartTime), [filteredConversations, weekStartTime]);
  const archiveYears = useMemo(() => Array.from(new Set(archiveConversations.map((conversation) => String(new Date(conversation.updatedAt).getFullYear())))).sort((left, right) => Number(right) - Number(left)), [archiveConversations]);
  const selectedArchiveYear = archiveYears.includes(historyArchiveYear) ? historyArchiveYear : (archiveYears[0] ?? "");
  const archiveMonths = useMemo(() => Array.from(new Set(archiveConversations
    .filter((conversation) => String(new Date(conversation.updatedAt).getFullYear()) === selectedArchiveYear)
    .map((conversation) => String(new Date(conversation.updatedAt).getMonth() + 1).padStart(2, "0")))).sort((left, right) => Number(right) - Number(left)), [archiveConversations, selectedArchiveYear]);
  const selectedArchiveMonth = archiveMonths.includes(historyArchiveMonth) ? historyArchiveMonth : (archiveMonths[0] ?? "");
  const archiveDays = useMemo(() => Array.from(new Set(archiveConversations
    .filter((conversation) => monthKey(new Date(conversation.updatedAt)) === `${selectedArchiveYear}-${selectedArchiveMonth}`)
    .map((conversation) => String(new Date(conversation.updatedAt).getDate()).padStart(2, "0")))).sort((left, right) => Number(right) - Number(left)), [archiveConversations, selectedArchiveMonth, selectedArchiveYear]);
  const selectedArchiveDay = archiveDays.includes(historyArchiveDay) ? historyArchiveDay : "";
  const selectedArchiveConversations = useMemo(() => archiveConversations.filter((conversation) => {
    const updatedAt = new Date(conversation.updatedAt);
    return monthKey(updatedAt) === `${selectedArchiveYear}-${selectedArchiveMonth}`
      && (!selectedArchiveDay || String(updatedAt.getDate()).padStart(2, "0") === selectedArchiveDay);
  }), [archiveConversations, selectedArchiveDay, selectedArchiveMonth, selectedArchiveYear]);
  const weekIsExpanded = historyWeekExpanded || historyIsFiltering;
  const archiveIsExpanded = historyArchiveExpanded || historyIsFiltering;
  useEffect(() => {
    const storedTheme = window.localStorage.getItem(COACH_THEME_STORAGE_KEY);
    setCoachTheme(storedTheme === "dark" ? "dark" : "light");
    return () => {
      if (lampTimerRef.current !== undefined) window.clearTimeout(lampTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (initialCoachTransitionRef.current === undefined) {
      initialCoachTransitionRef.current = readPiloCoachTransition();
      clearPiloCoachTransition();
    }
    const transition = initialCoachTransitionRef.current;
    const destination = headerPiloRef.current?.getBoundingClientRect();
    let settleTimer: number | undefined;
    let finishTimer: number | undefined;
    if (!reduceMotion && transition && destination) {
      setCoachTransition(transition);
      setCoachTransitionOffset({
        x: transition.startX - (destination.left + destination.width / 2),
        y: transition.startY - (destination.top + destination.height / 2),
      });
      setCoachTransitionSettled(false);
      settleTimer = window.setTimeout(() => setCoachTransitionSettled(true), 700);
      finishTimer = window.setTimeout(() => {
        setCoachTransition(null);
        setCoachTransitionSettled(false);
      }, 980);
    } else {
      setCoachTransition(null);
      setCoachTransitionSettled(false);
    }
    setCoachTransitionReady(true);
    return () => {
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      if (finishTimer !== undefined) window.clearTimeout(finishTimer);
    };
  }, [reduceMotion]);

  const loadContext = useCallback(async () => {
    if (authStatus !== "authenticated") return;
    if (!user?.id) return;
    const requestId = contextRequestRef.current + 1;
    contextRequestRef.current = requestId;
    setLoading(true);
    setError("");
    try {
      const scope = goalId || null;
      const [nextContext, nextProposals] = await Promise.all([
        learnerApi.getDecisionContext(scope),
        learnerApi.listProposals(scope),
      ]);
      if (requestId !== contextRequestRef.current) return;
      setContext(nextContext);
      setProposals(nextProposals);
    } catch (reason) {
      if (requestId === contextRequestRef.current) setError(reason instanceof Error ? reason.message : "学习上下文加载失败");
    } finally {
      if (requestId === contextRequestRef.current) setLoading(false);
    }
  }, [authStatus, goalId, user?.id]);

  useEffect(() => {
    if (authStatus === "loading") return;
    setContext(null);
    setProposals([]);
    setGoals([]);
    setGoalId("");
    setResources([]);
    setMessages([]);
    if (authStatus === "unauthenticated") {
      setGoals(DEMO_GOALS);
      setGoalId((current) => current && DEMO_GOALS.some((goal) => goal.id === current) ? current : "");
      setMessages(DEMO_MESSAGES);
      setResources(DEMO_RESOURCES);
      return;
    }
    let cancelled = false;
    setMessages([]);
    setLoading(true);
    void Promise.all([productApi.listGoals(), productApi.listKnowledgeFiles()])
      .then(([nextGoals, nextResources]) => {
        if (cancelled) return;
        const activeGoals = nextGoals.filter((goal) => goal.status === "active");
        setGoals(activeGoals);
        setGoalId((current) => current && activeGoals.some((goal) => goal.id === current) ? current : "");
        setResources(nextResources.map((item) => item.name).slice(0, 6));
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "学习伙伴连接失败");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [authStatus, user?.id]);

  useEffect(() => {
    if (authStatus === "loading") return;
    coachArchiveReadyRef.current = false;
    try {
      const savedConversations = window.localStorage.getItem(conversationStorageKey);
      const parsedConversations = savedConversations ? JSON.parse(savedConversations) as PiloConversation[] : null;
      let nextConversations = Array.isArray(parsedConversations) && parsedConversations.length
        ? parsedConversations.map((conversation) => ({ ...conversation, isFavorite: Boolean(conversation.isFavorite) }))
        : authStatus === "unauthenticated" ? DEMO_CONVERSATIONS : [];
      if (authStatus === "unauthenticated") {
        const currentDemoConversations = new Map(DEMO_CONVERSATIONS.map((conversation) => [conversation.id, conversation]));
        nextConversations = nextConversations.map((conversation) => {
          const currentDemo = currentDemoConversations.get(conversation.id);
          return currentDemo ? { ...currentDemo, isFavorite: conversation.isFavorite } : conversation;
        });
      }
      if (authStatus === "unauthenticated" && Number(window.localStorage.getItem(DEMO_ARCHIVE_VERSION_KEY) ?? 0) < DEMO_ARCHIVE_VERSION) {
        const merged = new Map(DEMO_CONVERSATIONS.map((conversation) => [conversation.id, conversation]));
        nextConversations.forEach((conversation) => merged.set(conversation.id, conversation));
        nextConversations = Array.from(merged.values()).sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
        window.localStorage.setItem(DEMO_ARCHIVE_VERSION_KEY, String(DEMO_ARCHIVE_VERSION));
      }
      setConversations(nextConversations);

      const savedPreferences = window.localStorage.getItem(preferencesStorageKey);
      if (savedPreferences) {
        setPiloPreferences({ ...DEFAULT_PILO_PREFERENCES, ...JSON.parse(savedPreferences) as Partial<PiloPreferences> });
      }
    } catch {
      setConversations(authStatus === "unauthenticated" ? DEMO_CONVERSATIONS : []);
      setPiloPreferences(DEFAULT_PILO_PREFERENCES);
    }
    if (authStatus !== "authenticated") {
      coachArchiveReadyRef.current = true;
      return;
    }
    let cancelled = false;
    void productApi.getCoachArchive()
      .then(async (archive) => {
        if (cancelled) return;
        const localRaw = window.localStorage.getItem(conversationStorageKey);
        const localItems = localRaw ? JSON.parse(localRaw) as PiloConversation[] : [];
        const remoteItems = archive.conversations.map(conversationFromArchive);
        const merged = new Map<string, PiloConversation>();
        [...remoteItems, ...(Array.isArray(localItems) ? localItems : [])]
          .sort((left, right) => new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime())
          .forEach((conversation) => merged.set(conversation.id, conversation));
        const nextConversations = Array.from(merged.values()).sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
        setConversations(nextConversations);
        if (archive.preferences) setPiloPreferences({ ...DEFAULT_PILO_PREFERENCES, ...archive.preferences });
        const missingRemoteIds = new Set(archive.conversations.map((item) => item.id));
        await Promise.all(nextConversations.filter((item) => !missingRemoteIds.has(item.id)).map((item) => productApi.saveCoachConversation(conversationToArchive(item))));
      })
      .catch(() => setNotice("账户存档暂时无法连接，当前修改会保留在本地并稍后同步"))
      .finally(() => { coachArchiveReadyRef.current = true; });
    return () => { cancelled = true; };
  }, [authStatus, conversationStorageKey, preferencesStorageKey]);

  useEffect(() => {
    if (authStatus === "loading") return;
    window.localStorage.setItem(conversationStorageKey, JSON.stringify(conversations));
    if (authStatus !== "authenticated" || !coachArchiveReadyRef.current) return;
    const timer = window.setTimeout(() => {
      void Promise.all(conversations.map((conversation) => productApi.saveCoachConversation(conversationToArchive(conversation))))
        .catch(() => setNotice("会话已保存在本机缓存，账户同步将在连接恢复后重试"));
    }, 320);
    return () => window.clearTimeout(timer);
  }, [authStatus, conversationStorageKey, conversations]);

  useEffect(() => {
    if (authStatus === "loading") return;
    window.localStorage.setItem(preferencesStorageKey, JSON.stringify(piloPreferences));
    if (authStatus !== "authenticated" || !coachArchiveReadyRef.current) return;
    const timer = window.setTimeout(() => {
      void productApi.saveCoachPreferences(piloPreferences).catch(() => setNotice("Pilo 偏好将在连接恢复后同步"));
    }, 320);
    return () => window.clearTimeout(timer);
  }, [authStatus, piloPreferences, preferencesStorageKey]);

  useEffect(() => {
    if (!messages.length || authStatus === "loading") return;
    if (restoringConversationRef.current) {
      restoringConversationRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      const conversationId = activeConversationId || sessionIdRef.current;
      const firstUserMessage = messages.find((message) => message.role === "user" && message.content.trim());
      if (!firstUserMessage) return;
      const latestUserMessage = [...messages].reverse().find((message) => message.role === "user" && message.content.trim());
      const latestPiloMessage = [...messages].reverse().find((message) => message.role === "assistant" && message.content.trim());
      const timestamp = new Date().toISOString();
      setConversations((current) => {
        const existing = current.find((conversation) => conversation.id === conversationId);
        const goalTitle = activeGoal?.title ?? "跨目标对话";
        const nextConversation: PiloConversation = {
          id: conversationId,
          sessionId: sessionIdRef.current,
          goalId: goalId || null,
          goalTitle,
          title: existing?.title ?? compactConversationText(firstUserMessage.content, 22),
          summary: compactConversationText(latestUserMessage?.content ?? firstUserMessage.content, 58),
          piloFeedback: compactConversationText(latestPiloMessage?.content ?? "Pilo 正在整理回应", 68),
          messages,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          association: `${goalId ? "关联当前目标" : "跨目标"} · ${messages.length} 条消息`,
          isFavorite: existing?.isFavorite ?? false,
        };
        return [nextConversation, ...current.filter((conversation) => conversation.id !== conversationId)];
      });
      setActiveConversationId(conversationId);
    }, streaming ? 420 : 120);
    return () => window.clearTimeout(timer);
  }, [activeConversationId, activeGoal?.title, authStatus, goalId, messages, streaming]);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const entry = parsePiloCoachEntry(params);
    setCoachEntry(entry);
    if (entry?.prompt) setDraft(entry.prompt);
    if (entry?.goalId) setGoalId(entry.goalId);
    else if (entry?.goalIds?.length === 1) setGoalId(entry.goalIds[0]);
    else if (entry?.surface) setGoalId("");
    if (params.get("pattern")) setContextOpen(true);
    if (window.location.hash === "#proposal") {
      scrollFeedElementIntoView("companion-proposals", reduceMotion ? "auto" : "smooth");
    }
  }, [reduceMotion, scrollFeedElementIntoView]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      shouldFollowConversationRef.current = true;
      scrollConversation("start");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [authStatus, scrollConversation]);

  useEffect(() => {
    if (!messages.length) return;
    if (!shouldFollowConversationRef.current && !restoringConversationRef.current) return;
    scrollConversation("end", streaming || reduceMotion ? "auto" : "smooth");
  }, [messages, reduceMotion, scrollConversation, streaming]);

  useEffect(() => {
    if (previousMessageCountRef.current === 0 && messages.length > 0) {
      setOpeningObservationExpanded(false);
    }
    previousMessageCountRef.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!historyOpen && !contextOpen && !settingsOpen) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      document.querySelector<HTMLElement>(".companion-sidepanel > header button")?.focus();
    }, reduceMotion ? 0 : 180);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHistoryOpen(false);
      setContextOpen(false);
      setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", closeOnEscape);
      window.requestAnimationFrame(() => trigger?.focus());
    };
  }, [contextOpen, historyOpen, reduceMotion, settingsOpen]);

  useEffect(() => {
    if (!abilitiesOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAbilitiesOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [abilitiesOpen]);

  useEffect(() => {
    if (!goalMenuOpen) return;
    const focusTimer = window.setTimeout(() => {
      goalPickerRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus();
    }, reduceMotion ? 0 : 120);
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!goalPickerRef.current?.contains(event.target as Node)) setGoalMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setGoalMenuOpen(false);
      goalPickerButtonRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [goalMenuOpen, reduceMotion]);

  function startNewConversation() {
    abortRef.current?.abort();
    sessionIdRef.current = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `session-${Date.now()}`;
    setMessages([]);
    setDraft("");
    setActiveConversationId("");
    setHistoryOpen(false);
    setContextOpen(false);
    setSettingsOpen(false);
    setOpeningObservationExpanded(true);
    shouldFollowConversationRef.current = true;
    scrollConversation("start", reduceMotion ? "auto" : "smooth");
  }

  function openConversation(conversation: PiloConversation) {
    restoringConversationRef.current = true;
    abortRef.current?.abort();
    sessionIdRef.current = conversation.sessionId;
    setActiveConversationId(conversation.id);
    setMessages(restoreMessageTimes(conversation));
    setGoalId(conversation.goalId && goals.some((goal) => goal.id === conversation.goalId) ? conversation.goalId : "");
    setHistoryOpen(false);
    setDraft("");
    setOpeningObservationExpanded(false);
    shouldFollowConversationRef.current = true;
    scrollConversation("end", reduceMotion ? "auto" : "smooth");
  }

  function toggleConversationFavorite(conversationId: string) {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId
      ? { ...conversation, isFavorite: !conversation.isFavorite }
      : conversation));
  }

  async function deleteArchivedConversation(conversationId: string) {
    const deleted = conversations.find((conversation) => conversation.id === conversationId);
    if (!deleted) return;
    setPendingDeleteConversationId("");
    setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));
    if (activeConversationId === conversationId) {
      sessionIdRef.current = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `session-${Date.now()}`;
      setActiveConversationId("");
      setMessages([]);
      setDraft("");
    }
    try {
      if (authStatus === "authenticated") await productApi.deleteCoachConversation(conversationId);
      setNotice("会话已删除");
    } catch {
      setConversations((current) => [...current, deleted].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()));
      setNotice("删除失败，会话已恢复");
    }
  }

  function exportCoachArchive() {
    const archive = {
      version: 2,
      exportedAt: new Date().toISOString(),
      conversations: conversations.map(conversationToArchive),
      preferences: piloPreferences,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `PlanPilot-Pilo-会话存档-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setNotice(`已导出 ${conversations.length} 次会话，可保存到你选择的文件夹`);
  }

  async function importCoachArchive(file: File) {
    try {
      const raw = JSON.parse(await file.text()) as { conversations?: CoachArchiveConversation[]; preferences?: Partial<PiloPreferences> };
      if (!Array.isArray(raw.conversations)) throw new Error("存档中没有有效会话");
      const imported = raw.conversations.map(conversationFromArchive);
      const merged = new Map(conversations.map((conversation) => [conversation.id, conversation]));
      imported.forEach((conversation) => {
        const existing = merged.get(conversation.id);
        if (!existing || new Date(conversation.updatedAt) > new Date(existing.updatedAt)) merged.set(conversation.id, conversation);
      });
      const next = Array.from(merged.values()).sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      setConversations(next);
      if (raw.preferences) setPiloPreferences({ ...DEFAULT_PILO_PREFERENCES, ...raw.preferences });
      if (authStatus === "authenticated") await productApi.importCoachArchive(raw.conversations);
      setNotice(`已导入 ${imported.length} 次会话${authStatus === "authenticated" ? "并同步到账户" : "；登录后可同步到账户"}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "会话存档导入失败");
    } finally {
      if (coachArchiveImportRef.current) coachArchiveImportRef.current.value = "";
    }
  }

  function togglePiloMotion() {
    const nextMotion = piloPreferences.motion === "lively" ? "calm" : "lively";
    setPiloPreferences((current) => ({ ...current, motion: nextMotion }));
    try {
      const key = "pp-pilo-preferences-v2";
      const stored = window.localStorage.getItem(key);
      const current = stored ? JSON.parse(stored) as Record<string, unknown> : {};
      window.localStorage.setItem(key, JSON.stringify({
        ...current,
        activity: nextMotion === "lively" ? "active" : "gentle",
        particles: true,
      }));
      window.dispatchEvent(new CustomEvent("planpilot:pilo-appearance-changed"));
    } catch {
      // Conversation preferences still save even when appearance storage is unavailable.
    }
  }

  function toggleCoachTheme() {
    setLampPulling(true);
    setCoachTheme((current) => {
      const next = current === "light" ? "dark" : "light";
      window.localStorage.setItem(COACH_THEME_STORAGE_KEY, next);
      return next;
    });
    if (lampTimerRef.current !== undefined) window.clearTimeout(lampTimerRef.current);
    lampTimerRef.current = window.setTimeout(() => setLampPulling(false), reduceMotion ? 0 : 420);
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (!value || streaming) return;
    const userId = `user-${Date.now()}`;
    const assistantId = `assistant-${Date.now()}`;
    const sentAt = new Date().toISOString();
    shouldFollowConversationRef.current = true;
    setMessages((current) => [...current, { id: userId, role: "user", content: value, createdAt: sentAt }]);
    setDraft("");

    if (authStatus !== "authenticated") {
      setMessages((current) => [...current, {
        id: assistantId,
        role: "assistant",
        content: "你还没有登录，请先[登录后继续](/login?next=%2Fstudio%2Fcoach)。登录后，Pilo 会结合你的学习目标和记录，给出更贴合你的建议。",
        createdAt: new Date().toISOString(),
      }]);
      return;
    }

    setStreaming(true);
    setError("");
    setStreamStatus("正在读取本轮学习上下文");
    const piloStreamSource = "agent:coach-stream";
    signalPiloAgentPhase("thinking", { source: piloStreamSource, reason: "正在读取本轮学习上下文" });
    setMessages((current) => [...current, { id: assistantId, role: "assistant", content: "", createdAt: new Date().toISOString() }]);
    abortRef.current = new AbortController();
    let generating = false;
    let finished = false;
    try {
      await streamAgentMessage({
        message: value,
        goal_id: goalId || undefined,
        session_id: sessionIdRef.current,
        pilo_preferences: piloPreferences,
      }, ({ event: streamEvent, data }) => {
        if (streamEvent === "token" && typeof data.text === "string") {
          setStreamStatus("正在组织回答");
          if (!generating) {
            generating = true;
            signalPiloAgentPhase("generating", { source: piloStreamSource });
          }
          setMessages((current) => current.map((message) => message.id === assistantId
            ? { ...message, content: message.content + data.text }
            : message));
        }
        if (streamEvent === "tool_start") {
          const tool = typeof data.tool === "string" ? data.tool : "相关信息";
          setStreamStatus("正在检索相关信息");
          signalPiloAgentPhase(tool.includes("search") ? "retrieving" : "tool", { source: piloStreamSource, tool });
        }
        if (streamEvent === "tool_end" || streamEvent === "verification_start" || streamEvent === "structured") {
          signalPiloAgentPhase("verifying", { source: piloStreamSource });
        }
        if (streamEvent === "confirmation_required") signalPiloAgentPhase("waiting", { source: piloStreamSource });
        if (streamEvent === "recovery" || streamEvent === "retry") signalPiloAgentPhase("recovering", { source: piloStreamSource });
        if (streamEvent === "done") {
          signalPiloAgentPhase("done", { source: piloStreamSource });
          finished = true;
        }
        if (streamEvent === "error") {
          const message = typeof data.message === "string" ? data.message : "学习伙伴响应失败";
          signalPiloAgentPhase("failed", { source: piloStreamSource, reason: message });
          finished = true;
          throw new Error(message);
        }
      }, abortRef.current.signal);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "学习伙伴响应失败";
      if (!/aborted/i.test(message)) {
        if (!finished) signalPiloAgentPhase("failed", { source: piloStreamSource, reason: message });
        finished = true;
        setError(message);
        setMessages((current) => current.map((item) => item.id === assistantId && !item.content
          ? { ...item, content: "暂时无法完成这次回答。你可以稍后重试，已有对话不会丢失。" }
          : item));
      }
    } finally {
      if (!finished) clearPiloState(piloStreamSource, "agent");
      setStreaming(false);
      setStreamStatus("");
    }
  }

  async function generateProposal() {
    if (authStatus !== "authenticated") {
      scrollFeedElementIntoView("demo-proposal", reduceMotion ? "auto" : "smooth");
      return;
    }
    setBusyId("generate");
    setError("");
    try {
      await learnerApi.generateProposal(goalId || null);
      await loadContext();
      setNotice("已生成一条可审阅建议");
      scrollFeedElementIntoView("companion-proposals", reduceMotion ? "auto" : "smooth");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "建议生成失败");
    } finally {
      setBusyId("");
    }
  }

  function scrollToCurrentProposal() {
    const proposalId = authStatus === "authenticated" ? "companion-proposals" : "demo-proposal";
    scrollFeedElementIntoView(proposalId, reduceMotion ? "auto" : "smooth");
  }

  function revealCurrentProposal() {
    if (authStatus !== "authenticated") {
      setDemoProposalVisible(true);
      window.setTimeout(scrollToCurrentProposal, reduceMotion ? 0 : 180);
      return;
    }
    scrollToCurrentProposal();
  }

  async function confirmProposal(proposal: DecisionProposal) {
    setBusyId(proposal.id);
    setError("");
    try {
      if (proposal.status === "pending") await learnerApi.acceptProposal(proposal.id);
      await learnerApi.applyProposal(proposal.id);
      await loadContext();
      setNotice("建议已确认并应用，变更已记录");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "建议应用失败");
    } finally {
      setBusyId("");
    }
  }

  async function rejectProposal(proposal: DecisionProposal) {
    setBusyId(proposal.id);
    try {
      await learnerApi.rejectProposal(proposal.id, "当前阶段不适合这项调整");
      await loadContext();
      setNotice("已保留原计划，这次选择会成为后续判断依据");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "建议状态更新失败");
    } finally {
      setBusyId("");
    }
  }

  async function feedbackProposal(proposal: DecisionProposal, outcome: "helpful" | "unhelpful") {
    setBusyId(proposal.id);
    try {
      await learnerApi.recordFeedback(proposal.id, outcome);
      await loadContext();
      setNotice("反馈已记录，学习伙伴会据此修正判断");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "反馈提交失败");
    } finally {
      setBusyId("");
    }
  }

  const renderHistoryRows = (items: PiloConversation[]) => (
    <div className="companion-thread-list">
      {items.map((conversation, index) => (
        <motion.article
          className={`companion-thread-item ${conversation.id === activeConversationId ? "is-active" : ""} ${pendingDeleteConversationId === conversation.id ? "is-confirming-delete" : ""}`}
          key={conversation.id}
          initial={{ opacity: 0, x: reduceMotion ? 0 : 8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: reduceMotion ? 0 : Math.min(index * 0.04, 0.16), duration: reduceMotion ? 0 : 0.2 }}
        >
          <button type="button" className="companion-thread-open" onClick={() => openConversation(conversation)}>
            <span className="companion-thread-goal"><em><Target size={11} /> {conversation.goalTitle}</em><time><Clock3 size={11} /> {conversationTimeLabel(conversation.updatedAt)}</time></span>
            <span className="companion-thread-heading"><strong>{conversation.title}</strong><span><MessagesSquare size={11} /> {conversation.messages.length} 条消息</span></span>
            <p>{compactConversationText(conversation.summary, 46)}</p>
            <span className="companion-thread-feedback"><span className="companion-thread-pilo-face"><PiloAvatar mood="listening" size={64} instant /></span><span><small>Pilo 最近回应</small><b>{compactConversationText(conversation.piloFeedback, 44)}</b></span></span>
            <span className="companion-thread-association"><span>{conversation.association.split(" · ").map((item, itemIndex) => <i className={item.includes("待确认") ? "is-pending" : ""} key={item}>{itemIndex > 0 && <b>·</b>}{item}</i>)}</span></span>
          </button>
          <span className="companion-thread-row-actions">
            <button type="button" className={conversation.isFavorite ? "is-favorite" : ""} aria-pressed={conversation.isFavorite} aria-label={`${conversation.isFavorite ? "取消收藏" : "收藏"}会话：${conversation.title}`} onClick={() => toggleConversationFavorite(conversation.id)}><Star size={13} /></button>
            {pendingDeleteConversationId === conversation.id
              ? <><button type="button" className="is-confirm-delete" onClick={() => void deleteArchivedConversation(conversation.id)}>确认删除</button><button type="button" aria-label={`取消删除会话：${conversation.title}`} onClick={() => setPendingDeleteConversationId("")}><X size={13} /></button></>
              : <button type="button" className="is-delete" aria-label={`删除会话：${conversation.title}`} onClick={() => setPendingDeleteConversationId(conversation.id)}><Trash2 size={13} /></button>}
          </span>
        </motion.article>
      ))}
    </div>
  );

  const pageTransition = { duration: reduceMotion ? 0 : .18, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <motion.div
      className={`partner-workspace companion-workspace is-${coachTheme}`}
      initial={false}
      animate={{ opacity: 1 }}
    >
      <header className="companion-commandbar">
        <div className="companion-brand">
          <span
            ref={headerPiloRef}
            className={`companion-brand-avatar-shell is-destination ${coachTransition ? "is-transition-active" : ""} ${coachTransitionSettled ? "is-settling" : ""}`}
            aria-label={coachTransition ? "Pilo 正在进入学习伙伴页面" : "Pilo 在学习伙伴页陪伴"}
          >
            {coachTransitionReady && (
              <span
                className="companion-brand-avatar-motion"
                style={coachTransition ? {
                  "--pilo-arrival-x": `${coachTransitionOffset.x}px`,
                  "--pilo-arrival-y": `${coachTransitionOffset.y}px`,
                } as React.CSSProperties : undefined}
              >
                <PiloAvatar
                  mood={coachTransition
                    ? (coachTransitionOffset.x > 0 ? "walking-left" : "walking-right")
                    : streaming ? "working" : "listening"}
                  size={52}
                  priority
                  illuminated={coachTransitionSettled}
                />
              </span>
            )}
          </span>
          <div className="companion-brand-copy">
            <span className="companion-brand-presence"><i /> Pilo · AI 学习伙伴</span>
            <strong><span className="companion-brand-title-desktop">理解你的学习，陪你走得更远</span><span className="companion-brand-title-mobile">Pilo</span></strong>
            <p>{streaming ? "我正在认真想，马上回来。" : "慢慢说，我会帮你理清下一步。"}</p>
          </div>
          <button
            type="button"
            className={`companion-lamp-pull companion-command-tooltip is-${coachTheme} ${lampPulling ? "is-pulling" : ""}`}
            aria-label={coachTheme === "light" ? "拉灯切换到深色模式" : "拉灯切换到明亮模式"}
            aria-pressed={coachTheme === "dark"}
            data-tooltip={coachTheme === "light" ? "切换夜间陪伴模式" : "切换明亮陪伴模式"}
            title={coachTheme === "light" ? "拉一下，关灯" : "拉一下，开灯"}
            onClick={toggleCoachTheme}
          >
            <span className="companion-lamp-pull__shade"><Lightbulb size={18} /></span>
            <span className="companion-lamp-pull__cord" aria-hidden="true"><i /></span>
          </button>
        </div>
        <div className="companion-command-actions">
          <div className={`companion-goal-picker ${goalMenuOpen ? "is-open" : ""}`} ref={goalPickerRef}>
            <button
              type="button"
              className="companion-goal-trigger companion-toolbar-action companion-command-tooltip"
              ref={goalPickerButtonRef}
              aria-label={`本轮聚焦：${selectedGoalLabel}。选择本轮对话优先关注的目标`}
              aria-haspopup="listbox"
              aria-expanded={goalMenuOpen}
              aria-controls="companion-goal-options"
              data-tooltip={goalId ? `本轮优先关注：${selectedGoalLabel}` : "本轮不限定具体目标"}
              onClick={() => setGoalMenuOpen((current) => !current)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                event.preventDefault();
                setGoalMenuOpen(true);
              }}
            >
              <span className="companion-goal-icon"><Target size={18} /></span>
              <span className="companion-goal-copy">
                <small>本轮聚焦</small>
                <strong>{selectedGoalLabel}</strong>
              </span>
              <ChevronDown className="companion-goal-chevron" size={16} aria-hidden="true" />
            </button>
            <AnimatePresence>
              {goalMenuOpen && (
                <motion.div
                  id="companion-goal-options"
                  className="companion-goal-menu"
                  role="listbox"
                  aria-label="选择本轮聚焦目标"
                  initial={{ opacity: 0, y: reduceMotion ? 0 : -6, scale: reduceMotion ? 1 : .98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: reduceMotion ? 0 : -4, scale: reduceMotion ? 1 : .985 }}
                  transition={{ duration: reduceMotion ? 0 : .18, ease: [0.22, 1, 0.36, 1] }}
                  onKeyDown={(event) => {
                    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
                    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
                    const nextIndex = event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? options.length - 1
                        : event.key === "ArrowDown"
                          ? (currentIndex + 1 + options.length) % options.length
                          : (currentIndex - 1 + options.length) % options.length;
                    options[nextIndex]?.focus();
                  }}
                >
                  <div className="companion-goal-menu-context">
                    <BrainCircuit size={20} />
                    <span><strong>长期观察始终参与</strong><small>Pilo 仍会参考跨目标习惯与整体节奏</small></span>
                  </div>
                  <span className="companion-goal-menu-label">选择本轮聚焦</span>
                  <button
                    type="button"
                    role="option"
                    aria-selected={!goalId}
                    className={!goalId ? "is-selected" : ""}
                    onClick={() => {
                      setGoalId("");
                      setGoalMenuOpen(false);
                      window.requestAnimationFrame(() => goalPickerButtonRef.current?.focus());
                    }}
                  >
                    <span className="companion-goal-option-mark"><MessagesSquare size={15} /></span>
                    <span><strong>不限目标</strong><small>讨论整体节奏、取舍或跨目标问题</small></span>
                    {!goalId && <Check size={15} aria-hidden="true" />}
                  </button>
                  {goals.map((goal) => {
                    const selected = goal.id === goalId;
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={selected ? "is-selected" : ""}
                        key={goal.id}
                        onClick={() => {
                          setGoalId(goal.id);
                          setGoalMenuOpen(false);
                          window.requestAnimationFrame(() => goalPickerButtonRef.current?.focus());
                        }}
                      >
                        <span className="companion-goal-option-mark"><Target size={15} /></span>
                        <span><strong>{goal.title}</strong><small>优先使用该目标的任务、资料与进度</small></span>
                        {selected && <Check size={15} aria-hidden="true" />}
                      </button>
                    );
                  })}
                  <p className="companion-goal-menu-note">这里只改变本轮回答的上下文优先级，不会修改长期画像或自动调整计划。</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <button
            type="button"
            className="companion-settings-link companion-toolbar-action companion-command-tooltip"
            aria-label="打开 Pilo 设置"
            aria-expanded={settingsOpen}
            data-tooltip="设置 Pilo 的陪伴方式"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={19} />
            <span>Pilo 设置</span>
          </button>
          <button
            type="button"
            className="companion-icon-button companion-history-link companion-toolbar-action companion-command-tooltip"
            aria-label="查看历史会话"
            aria-expanded={historyOpen}
            data-tooltip="查看历史会话"
            onClick={() => setHistoryOpen(true)}
          >
            <History size={19} />
            <span>历史记录</span>
          </button>
        </div>
      </header>

      <main className="companion-canvas">
        <section className={`companion-chat-panel ${messages.length === 0 && proposals.length === 0 && !demoProposalVisible && !streaming ? "is-opening-only" : "has-conversation"}`}>
          <div className="companion-feed" aria-live="polite" ref={feedRef} onScroll={handleFeedScroll}>
            <div className="companion-day-separator"><span>今天</span></div>
            <motion.article
              className="companion-intro-message is-chat-opening"
              initial={{ opacity: 0, y: reduceMotion ? 0 : 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...pageTransition, delay: reduceMotion ? 0 : 0.08 }}
            >
              <div className="companion-intro-copy">
                <header>
                  <span>Pilo</span>
                  <small>{loading ? "正在看看你的近况…" : "刚刚"}</small>
                </header>
                {coachEntry?.surface && coachEntry.actionLabel && (
                  <section className="companion-entry-context" aria-label="这次对话的页面来源">
                    <div className="companion-entry-context__main">
                      <span className="companion-entry-context__source">
                        来自：{PILO_SURFACE_LABELS[coachEntry.surface]}
                      </span>
                      <strong>{coachEntry.objectTitle || coachEntry.actionLabel}</strong>
                      {coachEntry.objectTitle && <small>准备一起处理：{coachEntry.actionLabel}</small>}
                      {coachEntry.goalScope === "unlinked" && (
                        <small className="companion-entry-context__scope">未关联学习目标 · 本轮保持不限目标</small>
                      )}
                      {coachEntry.goalScope === "linked" && (coachEntry.goalIds?.length ?? 0) === 1 && (
                        <small className="companion-entry-context__scope">
                          关联目标：{linkedEntryGoals[0]?.title ?? "当前目标"} · 已作为本轮聚焦
                        </small>
                      )}
                      {(coachEntry.goalIds?.length ?? 0) > 1 && (
                        <small className="companion-entry-context__scope">
                          关联 {coachEntry.goalIds?.length} 个目标 · 本轮保持不限目标，可在顶部选择
                        </small>
                      )}
                    </div>
                    {coachEntry.reason && <p><Sparkles size={13} />{coachEntry.reason}</p>}
                    {coachEntry.returnTo && (
                      <Link href={coachEntry.returnTo} className="companion-entry-context__return">
                        <ArrowLeft size={14} /> 返回{PILO_SURFACE_LABELS[coachEntry.surface]}
                      </Link>
                    )}
                  </section>
                )}
                {showOpeningObservation && <motion.section
                  className={`companion-insight-card is-opening-card ${messages.length > 0 && !openingObservationExpanded ? "is-collapsed" : ""}`}
                  aria-label="Pilo 的学习观察"
                  initial={{ opacity: 0, x: reduceMotion ? 0 : -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.34, delay: reduceMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
                >
                  <header className="companion-opening-card-header">
                    <span><Sparkles size={14} /> Pilo 的观察</span>
                    <div className="companion-opening-card-actions">
                      <button
                        type="button"
                        aria-label={primaryPattern ? `查看依据，包含 ${primaryEvidenceCount} 条近期记录` : "查看依据"}
                        aria-expanded={contextOpen}
                        onClick={() => setContextOpen(true)}
                      >
                        <FileSearch size={13} />
                        查看依据
                      </button>
                      {messages.length > 0 && (
                        <button
                          type="button"
                          className="companion-observation-toggle"
                          aria-expanded={openingObservationExpanded}
                          aria-label={openingObservationExpanded ? "收起 Pilo 的观察" : "展开 Pilo 的观察"}
                          onClick={() => setOpeningObservationExpanded((current) => !current)}
                        >
                          {openingObservationExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          <span>{openingObservationExpanded ? "收起" : "展开"}</span>
                        </button>
                      )}
                    </div>
                  </header>
                  <div className="companion-opening-summary">
                    <h1>{openingObservationTitle}</h1>
                    <p>{openingObservationGuidance}</p>
                  </div>
                  <div className="companion-insight-meta">
                    <span><Activity size={13} /> {routedObservation ? "相关性：与本轮入口直接相关" : primaryPattern ? `判断状态：${primaryPatternConfidence?.label}` : "我会从你的反馈中逐步了解"}</span>
                    <span><ShieldCheck size={13} /> 不会自动修改计划</span>
                  </div>
                  <footer>
                    {hasPendingProposal ? (
                      <button type="button" className="is-primary" onClick={revealCurrentProposal}>
                        <ArrowRight size={14} /> 查看调整建议
                      </button>
                    ) : (
                      <button type="button" className="is-primary" onClick={() => void generateProposal()} disabled={busyId === "generate" || (authStatus === "authenticated" && !patterns.length)}>
                        {busyId === "generate" ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />} 看看下一步
                      </button>
                    )}
                  </footer>
                </motion.section>}

                {authStatus !== "authenticated" && demoProposalVisible && (
                  <motion.article
                    layout
                    className={`companion-proposal is-${demoProposalState}`}
                    id="demo-proposal"
                    initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: reduceMotion ? 0 : 0.32, delay: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <header><div><span className="companion-proposal-kicker"><Sparkles size={12} /> Pilo 的行动建议</span><h2>给周五留一点呼吸空间</h2></div><span className={`companion-status is-${demoProposalState}`}><i /> {demoProposalState === "pending" ? "等你决定" : demoProposalState === "applied" ? "已经安排好" : "保留原计划"}</span></header>
                    <p>保留核心练习，把恢复空间留到周末。预计释放 95 分钟，也更容易维持连续性。</p>
                    <div className="companion-proposal-meta"><span>先试一周</span><span>不会自动修改</span></div>
                    <footer>
                      {demoProposalState === "pending" ? <><button type="button" className="is-quiet" onClick={() => setDemoProposalState("dismissed")}>这次先不用</button><button type="button" className="is-primary" onClick={() => { setDemoProposalState("applied"); setNotice("好，我帮你把周五的空间留出来了"); }}><Check size={14} /> 好，就这样安排</button></> : <><span><CheckCircle2 size={14} /> Pilo 记住了你的选择</span><button type="button" className="is-quiet" onClick={() => setDemoProposalState("pending")}><RotateCcw size={13} /> 再想想</button></>}
                    </footer>
                  </motion.article>
                )}
              </div>
            </motion.article>

            <AnimatePresence initial={false}>
              {messages.map((message) => (
                <motion.article
                  layout
                  className={`companion-message is-${message.role}`}
                  key={message.id}
                  initial={{ opacity: 0, y: reduceMotion ? 0 : 10, scale: reduceMotion ? 1 : 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.24 }}
                >
                  {message.role === "assistant" ? (
                    <span className="companion-message-avatar is-pilo" aria-hidden="true">
                      <PiloAvatar mood="listening" size={64} instant />
                    </span>
                  ) : (
                    <UserAvatar className="companion-message-avatar is-user" avatarUrl={user?.avatar_url} username={displayUsername} size={34} alt={`${displayUsername}的头像`} />
                  )}
                  <div className="companion-message-bubble">
                    <header className="companion-message-header">
                      <span className="companion-message-author">
                        <strong>{message.role === "assistant" ? "Pilo" : displayUsername}</strong>
                        {message.role === "user" && formatMessageTime(message.createdAt) && <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>}
                      </span>
                      {message.role === "assistant" && message.content && authStatus === "authenticated" && <button type="button" onClick={() => setContextOpen(true)}><FileSearch size={13} /> 查看依据</button>}
                    </header>
                    {message.content ? (
                      <div className="companion-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
                    ) : (
                      <div className="companion-thinking"><i /><i /><i /><span>{streamStatus || "我在想…"}</span></div>
                    )}
                  </div>
                </motion.article>
              ))}
            </AnimatePresence>

            {!!proposals.length && (
              <section className="companion-proposal-stack companion-proposal-in-chat" id="companion-proposals">
                <header><div><small>Pilo 带来了一份方案</small><h2>你可以慢慢看，再决定</h2></div><span>{proposals.length}</span></header>
                {proposals.map((proposal) => (
                  <CoachProposal
                    key={proposal.id}
                    proposal={proposal}
                    busy={busyId === proposal.id}
                    onConfirm={() => void confirmProposal(proposal)}
                    onReject={() => void rejectProposal(proposal)}
                    onDiscuss={() => { setDraft(`我想先讨论“${proposal.title}”，请详细解释依据和取舍。`); document.getElementById("companion-composer")?.focus(); }}
                    onFeedback={(outcome) => void feedbackProposal(proposal, outcome)}
                  />
                ))}
              </section>
            )}
            <div className="companion-feed-end" aria-hidden="true" />
          </div>

          <div className="companion-input-dock">
            <motion.div className="companion-prompt-chips" initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }} animate={{ opacity: 1, y: 0 }}>
              <span className="companion-prompt-label">试试这样问</span>
              {QUICK_PROMPTS.map(({ label, prompt, icon: PromptIcon, kind }, index) => (
                <motion.button
                  type="button"
                  key={prompt}
                  data-prompt-kind={kind}
                  disabled={streaming}
                  onClick={() => { setDraft(prompt); document.getElementById("companion-composer")?.focus(); }}
                  initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: reduceMotion ? 0 : 0.05 + index * 0.05 }}
                  whileHover={reduceMotion || streaming ? undefined : { y: -2 }}
                  whileTap={reduceMotion || streaming ? undefined : { scale: 0.98 }}
                >
                  <PromptIcon size={14} /> <span>{label}</span>
                </motion.button>
              ))}
              <div
                className="companion-more-capabilities"
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAbilitiesOpen(false);
                }}
              >
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={abilitiesOpen}
                  disabled={streaming}
                  onClick={() => setAbilitiesOpen((current) => !current)}
                >
                  <Plus size={13} /> <span>试试其他</span><ChevronDown size={13} />
                </button>
                <AnimatePresence>
                  {abilitiesOpen && (
                    <motion.div
                      className="companion-more-capabilities__menu"
                      role="menu"
                      initial={{ opacity: 0, y: reduceMotion ? 0 : 6, scale: reduceMotion ? 1 : .98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: reduceMotion ? 0 : 4, scale: reduceMotion ? 1 : .985 }}
                      transition={{ duration: reduceMotion ? 0 : .16 }}
                    >
                      {MORE_PILO_PROMPTS.map(([label, prompt]) => (
                        <button
                          type="button"
                          role="menuitem"
                          key={prompt}
                          onClick={() => {
                            setDraft(prompt);
                            setAbilitiesOpen(false);
                            document.getElementById("companion-composer")?.focus();
                          }}
                        >
                          <span>{label}</span><ArrowRight size={13} />
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
            <motion.form
              className="companion-composer"
              onSubmit={sendMessage}
              onFocusCapture={() => setComposerFocused(true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setComposerFocused(false);
              }}
              animate={{ y: composerFocused && !reduceMotion ? -2 : 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="companion-composer-icon"><MessageCircle size={18} /></div>
              <label className="sr-only" htmlFor="companion-composer">给 Pilo 发送消息</label>
              <textarea
                id="companion-composer"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="把现在的情况告诉 Pilo…"
                rows={1}
                disabled={streaming}
              />
              <div className="companion-composer-side">
                <span>{draft.length ? `${draft.length}` : "Enter 发送"}</span>
                <motion.button type="submit" aria-label={streaming ? "Pilo 正在回复" : "发送给 Pilo"} disabled={!draft.trim() || streaming} whileTap={reduceMotion ? undefined : { scale: 0.9 }}>
                  {streaming ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={18} />}
                </motion.button>
              </div>
            </motion.form>
            <p className="companion-input-note" aria-live="polite"><ShieldCheck size={12} /><span>{INPUT_BOUNDARY_NOTES[boundaryNoteIndex]}</span></p>
          </div>
        </section>
      </main>

      <AnimatePresence>
        {(historyOpen || contextOpen || settingsOpen) && (
          <motion.button
            type="button"
            className="companion-backdrop"
            aria-label={historyOpen ? "关闭历史会话" : settingsOpen ? "关闭 Pilo 设置" : "关闭分析来源"}
            onClick={() => { setHistoryOpen(false); setContextOpen(false); setSettingsOpen(false); }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {historyOpen && (
          <motion.aside
            className={`companion-sidepanel is-history is-${coachTheme}`}
            role="dialog"
            aria-modal="true"
            aria-label="对话记录"
            initial={{ opacity: 0, x: reduceMotion ? 0 : 36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduceMotion ? 0 : 24 }}
            transition={pageTransition}
          >
            <header className="companion-history-header">
              <div><h2>历史会话</h2><p>{conversations.length} 次对话 · {conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0)} 条消息</p></div>
              <div className="companion-history-header__actions">
                <button type="button" className="companion-history-new companion-command-tooltip" data-tooltip="新对话不会清除已有上下文" onClick={startNewConversation} aria-label="开始新对话"><Plus size={16} /><span>新对话</span></button>
                <button type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭历史会话"><X size={17} /></button>
              </div>
            </header>

            <div ref={historyScrollRef} className="companion-sidepanel__scroll companion-history-scroll" onScroll={handleHistoryScroll}>
            <div className="companion-history-tools">
              <label className="companion-history-search">
                <Search size={15} />
                <span className="sr-only">搜索历史会话</span>
                <input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜索问题、Pilo 反馈或关联内容" />
                {historyQuery && <button type="button" onClick={() => setHistoryQuery("")} aria-label="清除历史会话搜索"><X size={13} /></button>}
              </label>
              <div className={`companion-history-filter ${historyGoalMenuOpen ? "is-open" : ""}`} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHistoryGoalMenuOpen(false); }}>
                <Target size={13} />
                <button type="button" aria-label="按目标筛选历史会话" aria-haspopup="listbox" aria-expanded={historyGoalMenuOpen} onClick={() => setHistoryGoalMenuOpen((current) => !current)}>{historyGoalFilter === "all" ? "全部目标" : historyGoalFilter}</button>
                <ChevronDown size={13} aria-hidden="true" />
                {historyGoalMenuOpen && <div className="companion-history-filter__menu" role="listbox" aria-label="历史会话目标">
                  {["all", ...historyGoalOptions].map((goalTitle) => {
                    const selected = historyGoalFilter === goalTitle;
                    return <button type="button" role="option" aria-selected={selected} key={goalTitle} onClick={() => { setHistoryGoalFilter(goalTitle); setHistoryGoalMenuOpen(false); }}><span>{goalTitle === "all" ? "全部目标" : goalTitle}</span>{selected && <Check size={13} />}</button>;
                  })}
                </div>}
              </div>
              <button type="button" className={`companion-history-favorites ${historyFavoritesOnly ? "is-active" : ""}`} aria-pressed={historyFavoritesOnly} aria-label="仅看收藏会话" onClick={() => setHistoryFavoritesOnly((current) => !current)}><Star size={13} /><span>收藏</span></button>
            </div>

            <div className="companion-history-groups">
              <section className={`companion-history-group companion-history-period is-week ${weekIsExpanded ? "is-expanded" : "is-collapsed"}`}>
                  <button type="button" className="companion-history-period-toggle" aria-expanded={weekIsExpanded} aria-label={`${weekIsExpanded ? "收起" : "展开"}本周历史会话`} onClick={() => setHistoryWeekExpanded((current) => !current)}>
                    <span><CalendarDays size={15} /><strong>本周</strong><small>{weekConversations.length} 次会话</small></span>
                    <span className="companion-history-period-toggle__state">{weekIsExpanded ? "收起" : "展开"}<ChevronDown size={14} aria-hidden="true" /></span>
                  </button>
                  <AnimatePresence initial={false}>
                    {weekIsExpanded && (
                      <motion.div className="companion-history-period__content" initial={{ opacity: 0, y: reduceMotion ? 0 : -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }} transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}>
                        <div className="companion-history-weekdays" aria-label="按本周日期筛选历史会话">
                          {historyWeekDays.map((day) => {
                            const selected = historyWeekDate === day.key;
                            const today = day.key === localDateKey(new Date());
                            return <button type="button" className={`${selected ? "is-selected" : ""} ${today ? "is-today" : ""}`} aria-pressed={selected} aria-current={today ? "date" : undefined} aria-label={`${day.date.getMonth() + 1}月${day.date.getDate()}日，周${day.weekday}${today ? "，今天" : ""}，${day.count} 次会话`} key={day.key} onClick={() => setHistoryWeekDate((current) => current === day.key ? "" : day.key)}><small>周{day.weekday}</small><strong>{day.date.getDate()}</strong><i aria-hidden="true" className={day.count ? "has-records" : ""} /></button>;
                          })}
                        </div>
                        {weekConversations.length > 0
                          ? renderHistoryRows(weekConversations)
                          : <div className="companion-history-period-empty">{historyWeekDate ? "这一天还没有会话" : "本周还没有会话"}</div>}
                      </motion.div>
                    )}
                  </AnimatePresence>
              </section>

              <section className={`companion-history-group companion-history-archive ${archiveIsExpanded ? "is-expanded" : "is-collapsed"}`}>
                  <button type="button" className="companion-history-archive-toggle" aria-expanded={archiveIsExpanded} aria-label={`${archiveIsExpanded ? "收起" : "展开"}更早的历史会话`} onClick={() => setHistoryArchiveExpanded((current) => !current)}>
                    <span><History size={15} /><strong>更早</strong><small>{archiveConversations.length} 次记录</small></span>
                    <span className="companion-history-archive-toggle__state">{archiveIsExpanded ? "收起" : "展开"}<ChevronDown size={14} aria-hidden="true" /></span>
                  </button>
                  <AnimatePresence initial={false}>
                    {archiveIsExpanded && (
                      <motion.div className="companion-history-archive__content" initial={{ opacity: 0, y: reduceMotion ? 0 : -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }} transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}>
                        {archiveConversations.length > 0 ? (
                          <>
                            <div className="companion-history-date-picker" aria-label="选择更早会话的日期">
                              <HistoryDateSelect theme={coachTheme} label="年份" ariaLabel="选择历史会话年份" value={selectedArchiveYear} options={archiveYears.map((year) => ({ value: year, label: `${year} 年` }))} onValueChange={(value) => { setHistoryArchiveYear(value); setHistoryArchiveMonth(""); setHistoryArchiveDay(""); }} />
                              <HistoryDateSelect theme={coachTheme} label="月份" ariaLabel="选择历史会话月份" value={selectedArchiveMonth} options={archiveMonths.map((month) => ({ value: month, label: `${Number(month)} 月` }))} onValueChange={(value) => { setHistoryArchiveMonth(value); setHistoryArchiveDay(""); }} />
                              <HistoryDateSelect theme={coachTheme} label="日期" ariaLabel="选择历史会话日期" value={selectedArchiveDay || "all"} options={[{ value: "all", label: "全部日期" }, ...archiveDays.map((day) => ({ value: day, label: `${Number(day)} 日` }))]} onValueChange={(value) => setHistoryArchiveDay(value === "all" ? "" : value)} />
                            </div>
                            {selectedArchiveConversations.length > 0
                              ? renderHistoryRows(selectedArchiveConversations)
                              : <div className="companion-history-period-empty">这个日期还没有会话</div>}
                          </>
                        ) : <div className="companion-history-period-empty">还没有本周以前的会话</div>}
                      </motion.div>
                    )}
                  </AnimatePresence>
              </section>
              {!filteredConversations.length && (
                <div className="companion-history-empty"><Search size={18} /><strong>没有找到相关会话</strong><p>可以换一个关键词，或切换到“全部目标”。</p></div>
              )}
            </div>
            <div className="companion-history-archive-tools" aria-label="会话存档">
              <button type="button" onClick={exportCoachArchive}><Download size={13} /> 导出存档</button>
              <button type="button" onClick={() => coachArchiveImportRef.current?.click()}><Upload size={13} /> 导入存档</button>
              <input ref={coachArchiveImportRef} type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importCoachArchive(file); }} />
            </div>
            </div>
            <p className="companion-panel-note"><ShieldCheck size={14} /> {authStatus === "authenticated" ? "会话正文已同步到账户，可跨设备恢复；也可导出到你选择的文件夹。" : "访客会话仅临时保存在本机；登录后可同步到账户，也可导出存档。"}</p>
          </motion.aside>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {settingsOpen && (
          <motion.aside
            className={`companion-sidepanel is-settings is-${coachTheme}`}
            role="dialog"
            aria-modal="true"
            aria-label="Pilo 设置"
            initial={{ opacity: 0, x: reduceMotion ? 0 : 36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduceMotion ? 0 : 24 }}
            transition={pageTransition}
          >
            <header><div><h2>Pilo 设置</h2><p>Pilo 会按你的偏好更好地回复与陪伴你</p></div><button type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭 Pilo 设置"><X size={17} /></button></header>

            <div className="companion-sidepanel__scroll companion-settings-scroll">
            <section className={`companion-settings-section ${settingsSections.tone ? "is-expanded" : "is-collapsed"}`}>
              <button type="button" className="companion-settings-section__toggle" aria-expanded={settingsSections.tone} aria-controls="pilo-setting-tone" onClick={() => toggleSettingsSection("tone")}><span><HeartHandshake size={15} /><strong>对话语气</strong><small>{PILO_TONE_OPTIONS.find((option) => option.value === piloPreferences.tone)?.label}</small></span><ChevronDown size={16} /></button>
              {settingsSections.tone && <div id="pilo-setting-tone" className="companion-setting-options companion-settings-section__content" role="radiogroup" aria-label="选择对话语气">
                {PILO_TONE_OPTIONS.map((option) => (
                  <button type="button" role="radio" aria-checked={piloPreferences.tone === option.value} className={piloPreferences.tone === option.value ? "is-active" : ""} key={option.value} onClick={() => setPiloPreferences((current) => ({ ...current, tone: option.value }))}>
                    <i /> <span><strong>{option.label}</strong><small>{option.description}</small></span><Check size={14} />
                  </button>
                ))}
              </div>}
            </section>

            <section className={`companion-settings-section ${settingsSections.initiative ? "is-expanded" : "is-collapsed"}`}>
              <button type="button" className="companion-settings-section__toggle" aria-expanded={settingsSections.initiative} aria-controls="pilo-setting-initiative" onClick={() => toggleSettingsSection("initiative")}><span><Gauge size={15} /><strong>陪伴主动性</strong><small>{PILO_INITIATIVE_OPTIONS.find((option) => option.value === piloPreferences.initiative)?.label}</small></span><ChevronDown size={16} /></button>
              {settingsSections.initiative && <div id="pilo-setting-initiative" className="companion-setting-options companion-settings-section__content" role="radiogroup" aria-label="选择陪伴主动性">
                {PILO_INITIATIVE_OPTIONS.map((option) => (
                  <button type="button" role="radio" aria-checked={piloPreferences.initiative === option.value} className={piloPreferences.initiative === option.value ? "is-active" : ""} key={option.value} onClick={() => setPiloPreferences((current) => ({ ...current, initiative: option.value }))}>
                    <i /> <span><strong>{option.label}</strong><small>{option.description}</small></span><Check size={14} />
                  </button>
                ))}
              </div>}
            </section>

            <section className={`companion-settings-section ${settingsSections.detail ? "is-expanded" : "is-collapsed"}`}>
              <button type="button" className="companion-settings-section__toggle" aria-expanded={settingsSections.detail} aria-controls="pilo-setting-detail" onClick={() => toggleSettingsSection("detail")}><span><TextQuote size={15} /><strong>回复信息量</strong><small>{PILO_DETAIL_OPTIONS.find((option) => option.value === piloPreferences.detail)?.label}</small></span><ChevronDown size={16} /></button>
              {settingsSections.detail && <div id="pilo-setting-detail" className="companion-detail-options companion-settings-section__content" role="radiogroup" aria-label="选择回复信息量">
                {PILO_DETAIL_OPTIONS.map((option) => <button type="button" role="radio" aria-checked={piloPreferences.detail === option.value} className={piloPreferences.detail === option.value ? "is-active" : ""} key={option.value} onClick={() => setPiloPreferences((current) => ({ ...current, detail: option.value }))}>{option.label}</button>)}
              </div>}
            </section>

            <section className={`companion-settings-section is-switches ${settingsSections.behavior ? "is-expanded" : "is-collapsed"}`}>
              <button type="button" className="companion-settings-section__toggle" aria-expanded={settingsSections.behavior} aria-controls="pilo-setting-behavior" onClick={() => toggleSettingsSection("behavior")}><span><Sparkles size={15} /><strong>反馈与动作</strong><small>{piloPreferences.motion === "lively" ? "活泼" : "克制"}</small></span><ChevronDown size={16} /></button>
              {settingsSections.behavior && <div id="pilo-setting-behavior" className="companion-settings-section__content companion-setting-switches">
              <button type="button" role="switch" aria-checked={piloPreferences.celebrateProgress} onClick={() => setPiloPreferences((current) => ({ ...current, celebrateProgress: !current.celebrateProgress }))}>
                <span><strong>回应学习进展</strong><small>完成任务或形成连续性时，允许 Pilo 主动肯定</small></span><i className={piloPreferences.celebrateProgress ? "is-on" : ""}><b /></i>
              </button>
              <button type="button" role="switch" aria-checked={piloPreferences.motion === "lively"} onClick={togglePiloMotion}>
                <span><strong>活泼一点的动作</strong><small>让 Pilo 使用更明显的招手、飞行和庆祝动效</small></span><i className={piloPreferences.motion === "lively" ? "is-on" : ""}><b /></i>
              </button>
              </div>}
            </section>
            </div>

            <p className="companion-settings-saved"><CheckCircle2 size={13} /> 设置会自动保存，并从下一条回复开始生效</p>
          </motion.aside>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {contextOpen && (
          <motion.aside
            className={`companion-sidepanel is-context is-${coachTheme}`}
            role="dialog"
            aria-modal="true"
            aria-label="依据来源"
            initial={{ opacity: 0, x: reduceMotion ? 0 : 36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduceMotion ? 0 : 24 }}
            transition={pageTransition}
          >
            <header className="companion-context-header"><div><h2>依据来源</h2><p>Pilo 为什么得出这条观察</p></div><span>结合 {primaryEvidenceCount} 条近期记录</span><button type="button" onClick={() => setContextOpen(false)} aria-label="关闭依据来源"><X size={17} /></button></header>
            <div className="companion-sidepanel__scroll companion-context-scroll">
            <section className="companion-context-scope"><small>本轮观察范围</small><strong>{activeGoal?.title ?? "全局学习视角"}</strong><span><i /> {activeGoal ? `结合长期规律，聚焦 ${activeGoal.title}` : `${qualityLabel} · 综合跨目标规律`}</span></section>
            <section className={`companion-context-section ${contextSections.patterns ? "is-expanded" : "is-collapsed"}`}>
              <button type="button" className="companion-context-section__toggle" aria-expanded={contextSections.patterns} aria-controls="context-patterns" onClick={() => toggleContextSection("patterns")}><span><Activity size={14} /><strong>与你有关的学习习惯</strong><small>{patterns.length} 条</small></span><ChevronDown size={15} /></button>
              {contextSections.patterns && <div id="context-patterns" className="companion-pattern-list">
                {patterns.slice(0, 4).map((pattern) => {
                  const confidence = confidenceMeta(pattern.confidence);
                  return <Link href={`/studio/coach/memory?pattern=${encodeURIComponent(pattern.id)}`} key={pattern.id}><span><Activity size={14} /></span><div><small>{PATTERN_LABELS[pattern.pattern_type] ?? "学习规律"} · {confidence.label}</small><strong>{pattern.explanation}</strong><p>{pattern.evidence_count} 条行为证据 · 查看判断依据</p></div><ArrowRight size={14} /></Link>;
                })}
                {!patterns.length && <div className="companion-context-empty">继续完成任务和反馈建议后，这里会形成可追溯的长期判断。</div>}
              </div>}
            </section>
            {(primaryGap || authStatus !== "authenticated") && <section className={`companion-context-section ${contextSections.retention ? "is-expanded" : "is-collapsed"}`}><button type="button" className="companion-context-section__toggle" aria-expanded={contextSections.retention} aria-controls="context-retention" onClick={() => toggleContextSection("retention")}><span><RefreshCw size={14} /><strong>知识保持</strong><small className="is-attention">待关注</small></span><ChevronDown size={15} /></button>{contextSections.retention && <div id="context-retention" className="companion-gap-card"><FileSearch size={16} /><div><strong>{primaryGap?.name ?? "链表双指针"}</strong><p>{primaryGap ? `当前保持信号 ${Math.round(primaryGap.retention * 100)}%，适合安排一次短复习。` : "预计三天内进入复习窗口，建议安排一次短复习。"}</p></div></div>}</section>}
            <section className={`companion-context-section ${contextSections.memories ? "is-expanded" : "is-collapsed"}`}><button type="button" className="companion-context-section__toggle" aria-expanded={contextSections.memories} aria-controls="context-memories" onClick={() => toggleContextSection("memories")}><span><BrainCircuit size={14} /><strong>本轮参考的长期记录</strong><small>{semanticMemories.length || 2} 条</small></span><ChevronDown size={15} /></button>{contextSections.memories && <div id="context-memories" className="companion-memory-list">{(semanticMemories.length ? semanticMemories.map((item) => item.summary) : ["延期后先恢复连续性，比集中补偿更有效", "高压周的可持续投入约为 45 分钟"]).slice(0, 3).map((item) => <p key={item}><BrainCircuit size={13} /><span>{item}</span></p>)}</div>}</section>
            <section className={`companion-context-section ${contextSections.resources ? "is-expanded" : "is-collapsed"}`}><button type="button" className="companion-context-section__toggle" aria-expanded={contextSections.resources} aria-controls="context-resources" onClick={() => toggleContextSection("resources")}><span><FileSearch size={14} /><strong>本轮可用资料</strong><small>{resources.length} 项</small></span><ChevronDown size={15} /></button>{contextSections.resources && <div id="context-resources" className="companion-resource-list">{resources.slice(0, 4).map((resource) => <Link href={`/studio/work/knowledge?query=${encodeURIComponent(resource)}`} key={resource}><FileSearch size={13} /><span>{resource}</span><ArrowRight size={13} /></Link>)}{!resources.length && <p>当前还没有可检索资料</p>}</div>}</section>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(error || notice) && (
          <motion.div className={`companion-toast ${error ? "is-error" : "is-success"}`} role={error ? "alert" : "status"} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>
            {error ? <X size={15} /> : <CheckCircle2 size={15} />}<span>{error || notice}</span>{error && <button type="button" onClick={() => { setError(""); void loadContext(); }}><RefreshCw size={13} /> 重试</button>}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
