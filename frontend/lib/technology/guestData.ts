"use client";

import type { ApiGoal } from "@/lib/technology/productApi";
import { scopedStorageKey } from "@/lib/technology/scopedStorage";

export const GUEST_DATASET_VERSION = 4;
export const GUEST_DATASET_VERSION_KEY = "planpilot:guest-dataset-version";

const PRODUCT_KEYS = {
  goals: "planpilot-v2-goals",
  tasks: "planpilot-v2-tasks",
  notes: "planpilot-v2-notes",
} as const;

function localDate(offset: number) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + offset);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function localTimestamp(daysAgo: number, hour: number, minute: number) {
  const value = new Date();
  value.setDate(value.getDate() - daysAgo);
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
}

function deadlineLabel(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${iso}T12:00:00`));
}

const goalBlueprints = [
  { id: "guest-exam", apiType: "exam", type: "考试备考", title: "研究生英语二 80 分冲刺", days: 96, dailyHours: 1.25, level: "intermediate", progress: 42, completed: 8, total: 19, streakDays: 4, next: "阅读理解 · 主旨题训练", rhythm: "本周完成 4 次训练", status: "active", isRisk: false },
  { id: "guest-cert", apiType: "certification", type: "认证学习", title: "通过 PMP 项目管理认证", days: 128, dailyHours: 0.75, level: "beginner", progress: 28, completed: 5, total: 18, streakDays: 6, next: "整合管理 · 过程组梳理", rhythm: "连续学习 6 天", status: "active", isRisk: false },
  { id: "guest-skill", apiType: "skill", type: "技能提升", title: "掌握 Python 数据分析", days: 72, dailyHours: 1, level: "intermediate", progress: 63, completed: 12, total: 19, streakDays: 5, next: "Pandas · 分组聚合实战", rhythm: "2 个项目里程碑已完成", status: "active", isRisk: false },
  { id: "guest-reading", apiType: "reading", type: "阅读计划", title: "读完《设计心理学》并输出卡片", days: 45, dailyHours: 0.5, level: "beginner", progress: 55, completed: 6, total: 11, streakDays: 3, next: "第 4 章 · 约束与映射", rhythm: "已沉淀 18 张概念卡", status: "active", isRisk: false },
  { id: "guest-language", apiType: "language", type: "语言学习", title: "日语 N2 听读提升", days: 154, dailyHours: 0.75, level: "intermediate", progress: 36, completed: 7, total: 20, streakDays: 2, next: "新闻听力 · 影子跟读", rhythm: "听力正确率提升 9%", status: "active", isRisk: true },
  { id: "guest-habit", apiType: "habit", type: "习惯养成", title: "连续 30 天晨间写作", days: 30, dailyHours: 0.33, level: "beginner", progress: 70, completed: 21, total: 30, streakDays: 21, next: "第 22 天 · 描写一个微小观察", rhythm: "当前连续 21 天", status: "active", isRisk: false },
] as const;

export type GuestStoredGoal = {
  id: string;
  name: string;
  title: string;
  type: string;
  apiType: ApiGoal["type"];
  progress: number;
  deadline: string;
  deadlineDate: string;
  daily: string;
  daily_hours: number;
  current_level: string;
  status: ApiGoal["status"];
  isRisk: boolean;
  progressState: "ready";
  completedTasks: number;
  totalTasks: number;
  next: string;
  taskSummary: string;
  rhythmSummary: string;
  debtCount: number;
  scheduleDeltaDays: number;
  created_at: string;
  work_schedule: "all";
};

export function guestStoredGoals(): GuestStoredGoal[] {
  return goalBlueprints.map((goal, index) => {
    const deadlineDate = localDate(goal.days);
    return {
      id: goal.id,
      name: goal.title,
      title: goal.title,
      type: goal.type,
      apiType: goal.apiType,
      progress: goal.progress,
      deadline: deadlineLabel(deadlineDate),
      deadlineDate,
      daily: `${Math.round(goal.dailyHours * 60)} 分钟`,
      daily_hours: goal.dailyHours,
      current_level: goal.level,
      status: goal.status,
      isRisk: goal.isRisk,
      progressState: "ready",
      completedTasks: goal.completed,
      totalTasks: goal.total,
      next: goal.next,
      taskSummary: `${goal.completed} / ${goal.total} 个任务`,
      rhythmSummary: goal.rhythm,
      debtCount: goal.isRisk ? 2 : 0,
      scheduleDeltaDays: goal.isRisk ? -2 : index % 3,
      created_at: localTimestamp(34 - index * 3, 9, 0),
      work_schedule: "all",
    };
  });
}

export function guestApiGoals(): ApiGoal[] {
  return guestStoredGoals().map((goal) => ({
    id: goal.id,
    type: goal.apiType,
    title: goal.title,
    deadline: goal.deadlineDate,
    daily_hours: goal.daily_hours,
    current_level: goal.current_level,
    status: goal.status,
    created_at: goal.created_at,
    work_schedule: goal.work_schedule,
  }));
}

export type GuestGoalProgress = {
  goal_id: string;
  title: string;
  deadline: string;
  total_tasks: number;
  completed_tasks: number;
  avg_completion_rate: number;
  streak_days: number;
  debt_count: number;
  days_ahead_or_behind: number | null;
};

export function guestGoalProgress(goalId: string): GuestGoalProgress | null {
  const goal = guestStoredGoals().find((item) => item.id === goalId);
  const blueprint = goalBlueprints.find((item) => item.id === goalId);
  if (!goal || !blueprint) return null;
  return {
    goal_id: goal.id,
    title: goal.title,
    deadline: goal.deadlineDate,
    total_tasks: goal.totalTasks,
    completed_tasks: goal.completedTasks,
    avg_completion_rate: goal.progress / 100,
    streak_days: blueprint.streakDays,
    debt_count: goal.debtCount,
    days_ahead_or_behind: goal.scheduleDeltaDays,
  };
}

export type GuestTask = {
  id: string;
  goalId: string;
  goalTitle: string;
  goal: string;
  date: string;
  title: string;
  description: string;
  duration: string;
  estimatedMinutes: number;
  actualMinutes: number | null;
  time: string;
  done: boolean;
  priority: "核心" | "普通优先级" | "低优先级";
  masteryLevel: string;
};

export function guestTasks(): GuestTask[] {
  const task = (id: string, goalId: string, goal: string, offset: number, title: string, description: string, minutes: number, time: string, done: boolean, priority: GuestTask["priority"]): GuestTask => ({
    id, goalId, goalTitle: goal, goal, date: localDate(offset), title, description,
    duration: `${minutes} 分钟`, estimatedMinutes: minutes, actualMinutes: done ? Math.max(15, minutes - 5) : null,
    time, done, priority, masteryLevel: done ? "熟悉" : "学习中",
  });
  return [
    task("guest-task-1", "guest-skill", "掌握 Python 数据分析", 0, "完成 Pandas 分组聚合练习", "用真实订单数据完成 groupby、agg 与多级索引练习。", 45, "19:00", false, "核心"),
    task("guest-task-2", "guest-exam", "研究生英语二 80 分冲刺", 0, "精读一篇经济学人短文", "标记长难句结构，并用一句话概括每段主旨。", 35, "20:00", false, "普通优先级"),
    task("guest-task-3", "guest-habit", "连续 30 天晨间写作", 0, "写 300 字微小观察", "从通勤途中选择一个细节，只描写，不评价。", 20, "07:30", true, "低优先级"),
    task("guest-task-4", "guest-reading", "读完《设计心理学》并输出卡片", 1, "整理“自然映射”概念卡", "为概念补充一个优秀案例和一个反例。", 30, "19:30", false, "普通优先级"),
    task("guest-task-5", "guest-cert", "通过 PMP 项目管理认证", 1, "画出五大过程组关系图", "不看教材回忆 49 个过程的归属，再核对错项。", 40, "20:10", false, "核心"),
    task("guest-task-6", "guest-language", "日语 N2 听读提升", 2, "NHK 新闻影子跟读", "先盲听两遍，再对照文本标出连读和语气变化。", 30, "19:20", false, "普通优先级"),
    task("guest-task-7", "guest-skill", "掌握 Python 数据分析", -1, "清洗缺失值与异常值", "比较删除、填补和标记三种处理策略。", 50, "19:00", true, "核心"),
    task("guest-task-8", "guest-exam", "研究生英语二 80 分冲刺", -2, "复盘阅读主旨题错因", "区分局部信息复述与全文主旨。", 30, "20:20", true, "普通优先级"),
    task("guest-task-9", "guest-reading", "读完《设计心理学》并输出卡片", -3, "完成第 3 章阅读", "记录可见性、反馈与概念模型三个关键词。", 35, "21:00", true, "普通优先级"),
  ];
}

export const GUEST_NOTES = [
  {
    id: "guest-note-python", goalId: "guest-skill", goal: "掌握 Python 数据分析", title: "Pandas 分组聚合：从问题出发选择粒度", date: "今天 20:06",
    content: "今天终于把 groupby 的思路理顺了：先明确分析对象，再决定分组键和聚合粒度。\n\n当问题是“每个城市的月均客单价”时，需要先按城市和月份分组，再计算订单金额的平均值；如果直接按城市聚合，就会丢掉月份变化。\n\n易错点：reset_index 只是把索引还原成列，不会改变聚合结果。下一次练习要比较 agg 命名聚合和透视表两种写法。",
  },
  {
    id: "guest-note-design", goalId: "guest-reading", goal: "读完《设计心理学》并输出卡片", title: "自然映射不是“看起来像”，而是关系可被理解", date: "昨天 21:14",
    content: "自然映射的关键不是拟物，而是控制与结果之间的关系无需额外记忆。\n\n好例子：炉灶旋钮按照灶眼的位置排列。坏例子：四个旋钮排成一行，却没有清楚标注对应哪个灶眼。\n\n产品启发：在时间规划里，拖动任务时应立即展示目标时间段和冲突反馈，让动作与结果保持空间上的连续。",
  },
  {
    id: "guest-note-exam", goalId: "guest-exam", goal: "研究生英语二 80 分冲刺", title: "阅读主旨题错因：把醒目的例子当成中心", date: "8 月 20 日 20:42",
    content: "这次选错不是词汇问题，而是被第二段的案例吸引。文章真正的结构是：提出争议—解释原因—给出有限度的建议。\n\n以后做主旨题先写出每段功能，再看选项是否覆盖全文。只复述某一段细节的选项，即使表述完全正确，也不能作为主旨。",
  },
  {
    id: "guest-note-pmp", goalId: "guest-cert", goal: "通过 PMP 项目管理认证", title: "整合管理：项目经理为什么不能只盯进度", date: "8 月 18 日 19:36",
    content: "整合管理是在范围、进度、成本、质量、资源、沟通、风险和采购之间做整体权衡。\n\n变更请求不能直接执行：先记录影响，进入整体变更控制，经批准后再更新计划和基准。题目里出现“立即实施”通常需要警惕。",
  },
  {
    id: "guest-note-japanese", goalId: "guest-language", goal: "日语 N2 听读提升", title: "影子跟读记录：听不清往往不是生词", date: "8 月 16 日 19:58",
    content: "今天听不清的三个位置都不是陌生词，而是连读、促音和句尾弱化。\n\n练习顺序：盲听两遍—看文本标音—0.8 倍速跟读—原速录音对比。下一次重点观察助词在自然语流中的弱化。",
  },
] as const;

export const GUEST_RESOURCES = [
  { id: "guest-resource-python", name: "电商订单数据分析实战.md", type: "Markdown", library: "未归档", libraries: [], status: "可用于 AI", updated: "今天 18:40", size: "18.6 KB", source: "sample", isDemo: true, goalIds: ["guest-skill"], goalTitles: ["掌握 Python 数据分析"], summary: "从业务问题、数据清洗到分组聚合和可视化，完整记录一次电商订单分析。", contentFormat: "markdown", content: "# 电商订单数据分析实战\n\n## 分析问题\n- 哪些城市贡献了稳定增长？\n- 退款是否集中在特定品类？\n\n## 清洗策略\n1. 订单号去重\n2. 缺失城市标记为待核验\n3. 金额异常值保留并增加审计列\n\n## 下一步\n使用 `groupby` 和命名聚合生成城市月报。" },
  { id: "guest-resource-english", name: "英语二阅读结构识别清单.pdf", type: "PDF", library: "稍后精读", libraries: ["稍后精读"], status: "可用于 AI", updated: "昨天", size: "2.4 MB", source: "sample", isDemo: true, goalIds: ["guest-exam"], goalTitles: ["研究生英语二 80 分冲刺"], summary: "总结转折、因果、举例和观点边界的识别方法，并配有主旨题排除步骤。" },
  { id: "guest-resource-design", name: "《设计心理学》概念卡片.md", type: "Markdown", library: "稍后精读", libraries: ["稍后精读"], status: "可用于 AI", updated: "8 月 20 日", size: "9.8 KB", source: "sample", isDemo: true, goalIds: [], goalTitles: [], summary: "整理可供性、意符、映射、反馈与概念模型，并为每个概念补充产品案例。", contentFormat: "markdown", content: "# 《设计心理学》概念卡\n\n## 可供性\n对象本身允许哪些操作。\n\n## 意符\n告诉用户在哪里、如何操作的可感知线索。\n\n## 映射\n控制与结果之间的对应关系。\n\n> 设计检查：用户能否在操作前预测结果，并在操作后立刻确认结果？" },
  { id: "guest-resource-pmp", name: "PMP 过程组与知识领域矩阵.xlsx", type: "表格", library: "常用模板", libraries: ["常用模板"], status: "可用于 AI", updated: "8 月 19 日", size: "36.2 KB", source: "sample", isDemo: true, goalIds: ["guest-cert"], goalTitles: ["通过 PMP 项目管理认证"], summary: "将过程组、知识领域、关键输入输出和高频情境题线索放在同一张复习矩阵中。" },
  { id: "guest-resource-japanese", name: "NHK 简明新闻听力记录.md", type: "Markdown", library: "未归档", libraries: [], status: "可用于 AI", updated: "8 月 17 日", size: "12.1 KB", source: "sample", isDemo: true, goalIds: ["guest-language"], goalTitles: ["日语 N2 听读提升"], summary: "按日期记录盲听正确率、连读难点、影子跟读录音与复习词组。", contentFormat: "markdown", content: "# NHK 听力记录\n\n## 本周重点\n- 句尾表达的语气差异\n- 助词弱化\n- 数字和日期的快速反应\n\n## 练习方法\n盲听 → 对照文本 → 标记音变 → 影子跟读 → 复述新闻要点。" },
  { id: "guest-resource-writing", name: "晨间写作 30 天题目卡.md", type: "Markdown", library: "未归档", libraries: [], status: "可用于 AI", updated: "8 月 15 日", size: "7.5 KB", source: "sample", isDemo: true, goalIds: [], goalTitles: [], summary: "提供从感官观察、人物动作到观点展开的 30 个低门槛写作题目。", contentFormat: "markdown", content: "# 晨间写作题目卡\n\n1. 描写窗外最先吸引你的颜色\n2. 记录一次没有说出口的感谢\n3. 只用动作描写一个正在等待的人\n4. 为昨天的一个决定写下另一种可能\n\n规则：20 分钟内不停笔，先完成，再修改。" },
] as const;

export type GuestConversation = {
  id: string;
  sessionId: string;
  goalId: string | null;
  goalTitle: string;
  title: string;
  summary: string;
  piloFeedback: string;
  association: string;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt?: string }>;
};

export function guestConversations(): GuestConversation[] {
  const conversation = (id: string, goalId: string | null, goalTitle: string, title: string, summary: string, feedback: string, association: string, daysAgo: number, messages: GuestConversation["messages"], favorite = false): GuestConversation => ({
    id, sessionId: id, goalId, goalTitle, title, summary, piloFeedback: feedback, association, isFavorite: favorite,
    createdAt: localTimestamp(daysAgo, 19, 10), updatedAt: localTimestamp(daysAgo, 19, 42), messages,
  });
  return [
    conversation("guest-chat-python", "guest-skill", "掌握 Python 数据分析", "把数据分析目标拆成第一个项目", "从零散语法学习转向一份可以展示的电商订单分析。", "先完成一个可解释的小闭环：提出问题、清洗数据、生成三张图，再决定是否扩展模型。", "关联 1 个目标 · 2 份资料 · 3 项任务", 0, [
      { id: "gcp-u1", role: "user", content: "我会一些 Python 语法，但一到真实数据就不知道从哪里开始。" },
      { id: "gcp-a1", role: "assistant", content: "先不补更多语法。我们选电商订单数据，只回答三个业务问题，把清洗、聚合和可视化串成一个闭环。" },
      { id: "gcp-u2", role: "user", content: "第一步做什么？" },
      { id: "gcp-a2", role: "assistant", content: "先写下三个问题和每个问题需要的字段，再检查缺失值与重复订单。完成后你会得到一份清晰的数据质量报告。" },
    ], true),
    conversation("guest-chat-exam", "guest-exam", "研究生英语二 80 分冲刺", "复盘阅读主旨题连续失分", "识别出错误主要来自文章结构判断，而不是词汇量。", "接下来三篇阅读先标段落功能，再做主旨题；正确率稳定后再恢复计时。", "关联 1 篇笔记 · 1 份清单 · 4 道错题", 2, [
      { id: "gce-u1", role: "user", content: "最近主旨题总错，但文章里的单词大多认识。" },
      { id: "gce-a1", role: "assistant", content: "从错题看，你常把最醒目的案例当成中心。问题更像结构识别，而不是词汇。" },
      { id: "gce-u2", role: "user", content: "怎么练才不会只是重新做一遍？" },
      { id: "gce-a2", role: "assistant", content: "先遮住选项，用一句话写每段功能，再概括作者最终推进了什么。之后再用选项检查，而不是让选项替你理解文章。" },
    ]),
    conversation("guest-chat-balance", null, "跨目标节奏", "给六类目标安排可持续节奏", "避免每天同时推进所有目标，建立核心、维护与恢复三层节奏。", "工作日只安排一项高认知核心任务；语言和写作作为短维护，阅读放到周末长时段。", "关联 6 个目标 · 本周 9 项任务", 4, [
      { id: "gcb-u1", role: "user", content: "目标很多，我总觉得每个都应该每天推进。" },
      { id: "gcb-a1", role: "assistant", content: "每天碰所有目标会造成频繁切换。可以分成核心推进、短时维护和本周暂停三层。" },
      { id: "gcb-u2", role: "user", content: "这周怎么分？" },
      { id: "gcb-a2", role: "assistant", content: "Python 和英语备考作为核心，日语与晨间写作做 20–30 分钟维护，PMP 和主题阅读各留一个完整时段。任何排程变化先给你预览。" },
    ], true),
    conversation("guest-chat-design", "guest-reading", "读完《设计心理学》并输出卡片", "把读书笔记变成可复用概念卡", "从摘抄转向“概念—案例—反例—产品检查”的结构。", "每章只保留 3–5 张高价值卡片，并在真实页面中验证一次。", "关联 1 个目标 · 18 张卡片", 7, [
      { id: "gcd-u1", role: "user", content: "我摘了很多句子，但读完之后还是记不住。" },
      { id: "gcd-a1", role: "assistant", content: "摘抄保存了原文，却没有迫使你重建概念。试着把每张卡改成概念、自己的解释、案例和反例。" },
      { id: "gcd-u2", role: "user", content: "要把以前的全部重做吗？" },
      { id: "gcd-a2", role: "assistant", content: "不用。先从“映射”和“反馈”两张开始，并拿当前产品页面验证。有效后再逐步整理旧笔记。" },
    ]),
  ];
}

export const GUEST_PATTERNS = [
  { id: "guest-pattern-evening", goal_id: null, scope: "user", pattern_type: "preferred_learning_time", pattern_value: { peak_hours: [19, 20] }, confidence: .84, evidence_count: 21, last_confirmed_at: null, evidence: [], explanation: "工作日晚间 19:00–21:00 更容易完成高认知任务" },
  { id: "guest-pattern-duration", goal_id: null, scope: "user", pattern_type: "preferred_session_length", pattern_value: { minutes: 42 }, confidence: .76, evidence_count: 16, last_confirmed_at: null, evidence: [], explanation: "单次专注控制在 35–45 分钟时，完成率和次日恢复最好" },
  { id: "guest-pattern-recovery", goal_id: null, scope: "user", pattern_type: "plan_adherence", pattern_value: {}, confidence: .72, evidence_count: 12, last_confirmed_at: null, evidence: [], explanation: "延期后先恢复一个最小任务，比集中补偿更容易回到节奏" },
] as const;

export function ensureGuestDatasetSeeded() {
  if (typeof window === "undefined") return;
  const currentVersion = Number(window.localStorage.getItem(GUEST_DATASET_VERSION_KEY) ?? 0);
  if (currentVersion === GUEST_DATASET_VERSION) return;

  const seed = (key: string, value: unknown) => {
    const serialized = JSON.stringify(value);
    window.localStorage.setItem(scopedStorageKey(key, null), serialized);
    window.localStorage.setItem(key, serialized);
  };
  seed(PRODUCT_KEYS.goals, guestStoredGoals());
  seed(PRODUCT_KEYS.tasks, guestTasks());
  seed(PRODUCT_KEYS.notes, GUEST_NOTES);

  window.localStorage.removeItem("planpilot:pilo-conversations:guest");
  window.localStorage.removeItem("planpilot:pilo-demo-archive-version");
  window.localStorage.setItem(GUEST_DATASET_VERSION_KEY, String(GUEST_DATASET_VERSION));
}
