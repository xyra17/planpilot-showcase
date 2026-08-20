"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  LibraryBig,
  MoreHorizontal,
  Rocket,
  Search,
  Pencil,
  Plus,
  SlidersHorizontal,
  Sprout,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/technology/AuthProvider";
import { GoalCreateDialog } from "@/components/goal/GoalCreateDialog";
import { GoalEditDialog } from "@/components/goal/GoalEditDialog";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { productApi, type ApiGoal, type ApiTask, type GoalProgress } from "@/lib/technology/productApi";
import {
  PRODUCT_STORAGE_KEYS,
  readProductArray,
  writeProductArray,
} from "@/lib/technology/productData";
import { signalPiloState } from "@/lib/technology/piloState";
import { signalPiloContext } from "@/lib/technology/piloContext";

type GoalStatus = "进行中" | "有风险" | "已暂停";
type GoalFilter = "全部" | "进行中" | "有风险" | "已完成" | "已归档";

type Goal = {
  id: string | number;
  name: string;
  type: string;
  progress: number;
  deadline: string;
  deadlineDate?: string;
  daily: string;
  status: GoalStatus;
  next: string;
  taskSummary: string;
  rhythmSummary: string;
  debtCount?: number;
  scheduleDeltaDays?: number | null;
};

type GoalMilestone = {
  title: string;
  meta: string;
  tone: "attention" | "active" | "ready" | "done" | "neutral";
  priority: number;
};

type MilestoneScope = "all" | string;

type SearchableTask = {
  id: string;
  title: string;
  description: string;
  goalId: string;
  goalTitle: string;
  date: string;
  done: boolean;
};

type StoredTask = Partial<ApiTask> & {
  goal?: string;
  duration?: number;
};

function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatTaskDate(value: string) {
  if (!value) return "未安排日期";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(parsed);
}

const INITIAL_GOALS: Goal[] = [
  {
    id: 1,
    name: "算法基础体系化",
    type: "技能提升",
    progress: 64,
    deadline: "9 月 30 日",
    deadlineDate: "2026-09-30",
    daily: "60 分钟",
    status: "进行中",
    next: "动态规划 · 第 3 阶段",
    taskSummary: "16 / 25 个任务",
    rhythmSummary: "连续学习 12 天",
    debtCount: 0,
    scheduleDeltaDays: 1,
  },
  {
    id: 2,
    name: "前端面试准备",
    type: "求职备考",
    progress: 38,
    deadline: "10 月 18 日",
    deadlineDate: "2026-10-18",
    daily: "45 分钟",
    status: "有风险",
    next: "浏览器原理 · 待复习",
    taskSummary: "8 / 21 个任务",
    rhythmSummary: "4 项知识待复习",
    debtCount: 4,
    scheduleDeltaDays: -2,
  },
  {
    id: 3,
    name: "英文技术阅读",
    type: "习惯养成",
    progress: 72,
    deadline: "长期",
    daily: "20 分钟",
    status: "已暂停",
    next: "恢复后从短文开始",
    taskSummary: "18 / 30 个任务",
    rhythmSummary: "暂停中",
    debtCount: 0,
    scheduleDeltaDays: null,
  },
];

function goalRemainingDays(goal: Goal) {
  if (goal.deadline === "长期" || !goal.deadlineDate) return "持续进行";
  const target = new Date(`${goal.deadlineDate}T00:00:00`);
  if (Number.isNaN(target.getTime())) return "持续进行";
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.ceil((target.getTime() - startOfToday.getTime()) / 86_400_000);
}

function goalRemainingLabel(goal: Goal) {
  if (goal.progress >= 100) return "已完成";
  const days = goalRemainingDays(goal);
  if (days === "持续进行") return days;
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `剩余 ${days} 天`;
}

function goalMilestones(goal: Goal, tasks: SearchableTask[], detailed: boolean): GoalMilestone[] {
  const taskMatch = (goal.taskSummary ?? "").match(/(\d+)\s*\/\s*(\d+)/);
  const completedTasks = Number(taskMatch?.[1] ?? 0);
  const totalTasks = Number(taskMatch?.[2] ?? 0);
  const remainingDays = goalRemainingDays(goal);
  const goalTasks = tasks
    .filter((task) => !task.done && (task.goalId === String(goal.id) || task.goalTitle === goal.name))
    .sort((first, second) => {
      if (!first.date && !second.date) return 0;
      if (!first.date) return 1;
      if (!second.date) return -1;
      return first.date.localeCompare(second.date);
    });
  const nextAction = goalTasks[0]?.title || goal.next || "继续执行当前计划";
  const dailyRhythm = goal.daily || "30 分钟";
  const debtCount = goal.debtCount ?? Number(goal.rhythmSummary?.match(/(\d+)\s*项知识待复习/)?.[1] ?? 0);
  const behindDays = typeof goal.scheduleDeltaDays === "number" && goal.scheduleDeltaDays < 0
    ? Math.abs(goal.scheduleDeltaDays)
    : 0;
  const isOverdue = typeof remainingDays === "number" && remainingDays < 0;
  const needsPriority = isOverdue || behindDays >= 3 || debtCount >= 3;
  const items: GoalMilestone[] = [];

  if (goal.status === "有风险") {
    const riskTitle = isOverdue
      ? `${goal.name}已超过截止日期 ${Math.abs(Number(remainingDays))} 天`
      : behindDays > 0
        ? `${goal.name}当前节奏落后计划 ${behindDays} 天`
        : debtCount > 0
          ? `${goal.name}有 ${debtCount} 项待复习知识需要安排`
          : `${goal.name}的推进节奏需要重新确认`;
    items.push({
      title: riskTitle,
      meta: needsPriority ? "优先处理" : "需要关注",
      tone: "attention",
      priority: 0,
    });
  }

  if (typeof remainingDays === "number" && remainingDays >= 0 && remainingDays <= 7) {
    items.push({
      title: remainingDays === 0 ? `${goal.name}今天到期` : `${goal.name}距离截止还有 ${remainingDays} 天`,
      meta: "临近截止",
      tone: "attention",
      priority: 1,
    });
  }

  items.push({
    title: `${goal.name}下一步：${nextAction}`,
    meta: goalTasks[0] ? "下一项任务" : "继续推进",
    tone: "active",
    priority: 2,
  });

  if (totalTasks > 0) {
    items.push({
      title: completedTasks > 0
        ? `${goal.name}已完成 ${completedTasks} / ${totalTasks} 个任务`
        : `${goal.name}还没有完成任务`,
      meta: completedTasks > 0 ? `完成 ${goal.progress}%` : "可以开始",
      tone: completedTasks > 0 ? "active" : "ready",
      priority: 3,
    });
  }

  if (detailed) {
    if (typeof remainingDays === "number" && remainingDays > 7) {
      items.push({
        title: `${goal.name}距离截止还有 ${remainingDays} 天`,
        meta: "时间充足",
        tone: "neutral",
        priority: 4,
      });
    }
    items.push({
      title: `${goal.name}每天计划投入 ${dailyRhythm}`,
      meta: "学习节奏",
      tone: "ready",
      priority: 5,
    });
  }

  return items;
}

export default function GoalsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status: authStatus } = useAuth();
  const { confirmAction } = useConfirmDialog();
  const [goals, setGoals] = useState(INITIAL_GOALS);
  const [storageReady, setStorageReady] = useState(false);
  const [filter, setFilter] = useState<GoalFilter>("全部");
  const [searchTerm, setSearchTerm] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [searchResultsOpen, setSearchResultsOpen] = useState(false);
  const [searchableTasks, setSearchableTasks] = useState<SearchableTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskSearchError, setTaskSearchError] = useState("");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [milestoneScope, setMilestoneScope] = useState<MilestoneScope>("all");
  const [milestoneMenuOpen, setMilestoneMenuOpen] = useState(false);
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [goalDialog, setGoalDialog] = useState<{ mode: "create" } | { mode: "edit"; goalId: string } | null>(null);
  const [goalMutationVersion, setGoalMutationVersion] = useState(0);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState("");
  const headingToolsRef = useRef<HTMLDivElement | null>(null);
  const goalsListRef = useRef<HTMLDivElement | null>(null);
  const milestoneSwitcherRef = useRef<HTMLDivElement | null>(null);
  const milestoneScrollbarTimerRef = useRef<number | null>(null);

  function revealMilestoneScrollbar(event: UIEvent<HTMLDivElement>) {
    const container = event.currentTarget;
    if (milestoneScrollbarTimerRef.current) window.clearTimeout(milestoneScrollbarTimerRef.current);
    container.classList.add("is-scrolling");
    milestoneScrollbarTimerRef.current = window.setTimeout(() => {
      container.classList.remove("is-scrolling");
      milestoneScrollbarTimerRef.current = null;
    }, 720);
  }

  useEffect(() => () => {
    if (milestoneScrollbarTimerRef.current) window.clearTimeout(milestoneScrollbarTimerRef.current);
  }, []);
  const taskSearchResults = useMemo(() => {
    const query = submittedSearch.trim().toLocaleLowerCase("zh-CN");
    if (!query) return [];

    return searchableTasks
      .map((task) => {
        const title = task.title.toLocaleLowerCase("zh-CN");
        const goalTitle = task.goalTitle.toLocaleLowerCase("zh-CN");
        const description = task.description.toLocaleLowerCase("zh-CN");
        const rank = title === query
          ? 0
          : title.startsWith(query)
            ? 1
            : title.includes(query)
              ? 2
              : goalTitle.includes(query)
                ? 3
                : description.includes(query)
                  ? 4
                  : Number.POSITIVE_INFINITY;
        return { task, rank };
      })
      .filter((result) => Number.isFinite(result.rank))
      .sort((first, second) => first.rank - second.rank || second.task.date.localeCompare(first.task.date))
      .map((result) => result.task);
  }, [searchableTasks, submittedSearch]);

  const visibleGoals = useMemo(
    () => {
      const query = submittedSearch.trim().toLocaleLowerCase("zh-CN");
      const matchedGoalIds = new Set(taskSearchResults.map((task) => task.goalId));
      return goals.filter((goal) => {
        const matchesFilter =
          filter === "全部"
            || (filter === "进行中" && goal.status !== "已暂停")
            || (filter === "有风险" && goal.status === "有风险")
            || (filter === "已完成" && goal.progress >= 100)
            || (filter === "已归档" && goal.status === "已暂停");
        const matchesQuery = !query
          || `${goal.name}${goal.type}${goal.next}`.toLocaleLowerCase("zh-CN").includes(query)
          || matchedGoalIds.has(String(goal.id));
        return matchesFilter && matchesQuery;
      });
    },
    [filter, goals, submittedSearch, taskSearchResults],
  );

  const completionAverage = goals.length
    ? Math.round(goals.reduce((total, goal) => total + goal.progress, 0) / goals.length)
    : 0;
  const riskCount = goals.filter((goal) => goal.status === "有风险").length;
  const completedCount = goals.filter((goal) => goal.progress >= 100).length;
  const reviewDueCount = goals.reduce((total, goal) => {
    const match = goal.rhythmSummary?.match(/(\d+)\s*项知识待复习/);
    return total + Number(match?.[1] ?? 0);
  }, 0);
  const donutGradient = `conic-gradient(from -90deg, var(--goal-ring-progress) 0 ${completionAverage}%, var(--goal-ring-track) ${completionAverage}% 100%)`;

  useEffect(() => {
    signalPiloContext({
      kind: "scope",
      surface: "goals",
      itemCount: goals.length,
      completedCount,
      reviewDueCount,
    });
  }, [completedCount, goals.length, reviewDueCount]);
  const activeMilestoneGoals = useMemo(
    () => goals.filter((goal) => goal.status !== "已暂停" && goal.progress < 100),
    [goals],
  );
  const selectedMilestoneGoal = milestoneScope === "all"
    ? null
    : activeMilestoneGoals.find((goal) => String(goal.id) === milestoneScope) ?? null;
  const milestoneItems = useMemo(
    () => (milestoneScope === "all"
      ? activeMilestoneGoals
      : activeMilestoneGoals.filter((goal) => String(goal.id) === milestoneScope))
      .flatMap((goal) => goalMilestones(goal, searchableTasks, milestoneScope !== "all"))
      .sort((first, second) => first.priority - second.priority)
      .slice(0, 10),
    [activeMilestoneGoals, milestoneScope, searchableTasks],
  );

  useEffect(() => {
    if (milestoneScope !== "all" && !activeMilestoneGoals.some((goal) => String(goal.id) === milestoneScope)) {
      setMilestoneScope("all");
    }
  }, [activeMilestoneGoals, milestoneScope]);

  useEffect(() => {
    const closeTransientMenus = (event: PointerEvent) => {
      const target = event.target as Node;

      if (!headingToolsRef.current?.contains(target)) {
        setFilterMenuOpen(false);
        setSearchResultsOpen(false);
      }
      if (!milestoneSwitcherRef.current?.contains(target)) setMilestoneMenuOpen(false);
      goalsListRef.current
        ?.querySelectorAll<HTMLDetailsElement>(".goal-list-menu[open]")
        .forEach((menu) => {
          if (!menu.contains(target)) menu.open = false;
        });
    };

    document.addEventListener("pointerdown", closeTransientMenus);
    return () => document.removeEventListener("pointerdown", closeTransientMenus);
  }, []);

  useEffect(() => {
    if (searchParams.get("create") !== "1") return;
    setGoalDialog({ mode: "create" });
    router.replace("/studio/work/goals", { scroll: false });
  }, [router, searchParams]);

  function goalFromApi(goal: ApiGoal, progress?: GoalProgress): Goal {
    const typeLabel: Record<ApiGoal["type"], string> = { exam: "考试备考", certification: "认证学习", skill: "技能提升", reading: "阅读计划", language: "语言学习", habit: "习惯养成" };
    const progressValue = goal.status === "completed"
      ? 100
      : progress?.total_tasks
      ? Math.round((progress.completed_tasks / progress.total_tasks) * 100)
      : Math.round((progress?.avg_completion_rate ?? 0) * 100);
    const isRisk = (progress?.debt_count ?? 0) > 0 || (progress?.days_ahead_or_behind ?? 0) < 0;
    const status: GoalStatus = goal.status === "paused" || goal.status === "abandoned" ? "已暂停" : isRisk ? "有风险" : "进行中";
    const deadline = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${goal.deadline}T00:00:00`));
    return {
      id: goal.id,
      name: goal.title,
      type: typeLabel[goal.type],
      progress: Math.min(100, progressValue),
      deadline,
      deadlineDate: goal.deadline,
      daily: `${Math.round(goal.daily_hours * 60)} 分钟`,
      status,
      next: progress?.debt_count ? `${progress.debt_count} 项学习债务需要处理` : `${goal.current_level === "beginner" ? "初学" : goal.current_level === "intermediate" ? "进阶" : "高阶"}阶段 · 继续执行当前计划`,
      taskSummary: progress?.total_tasks ? `${progress.completed_tasks} / ${progress.total_tasks} 个任务` : "0 / 0 个任务",
      rhythmSummary: progress?.debt_count ? `${progress.debt_count} 项知识待复习` : `连续学习 ${progress?.streak_days ?? 0} 天`,
      debtCount: progress?.debt_count ?? 0,
      scheduleDeltaDays: progress?.days_ahead_or_behind ?? null,
    };
  }

  function closeGoalDialog() {
    setSelectedGoal(null);
  }

  useEffect(() => {
    if (authStatus === "loading") return;
    if (authStatus === "unauthenticated") {
      setGoals(readProductArray(PRODUCT_STORAGE_KEYS.goals, INITIAL_GOALS));
      setStorageReady(true);
      return;
    }
    let active = true;
    setDataLoading(true); setDataError("");
    void productApi.listGoals().then(async (items) => {
      const progressRows = await Promise.all(items.map((item) => productApi.getGoalProgress(item.id).catch(() => undefined)));
      if (active) setGoals(items.map((item, index) => goalFromApi(item, progressRows[index])));
    }).catch((reason) => { if (active) setDataError(reason instanceof Error ? reason.message : "目标加载失败"); })
      .finally(() => { if (active) setDataLoading(false); });
    return () => { active = false; };
  }, [authStatus, goalMutationVersion]);

  useEffect(() => {
    if (authStatus === "loading") return;

    if (authStatus === "unauthenticated") {
      const storedTasks = readProductArray<StoredTask>(PRODUCT_STORAGE_KEYS.tasks, []);
      setSearchableTasks(storedTasks
        .filter((task) => task.id != null && typeof task.title === "string")
        .map((task) => {
          const matchedGoal = goals.find((goal) =>
            String(goal.id) === String(task.goalId ?? "") || goal.name === (task.goalTitle ?? task.goal)
          );
          return {
            id: String(task.id),
            title: String(task.title),
            description: String(task.description ?? ""),
            goalId: String(task.goalId ?? matchedGoal?.id ?? ""),
            goalTitle: String(task.goalTitle ?? task.goal ?? matchedGoal?.name ?? "未关联目标"),
            date: String(task.date ?? ""),
            done: Boolean(task.done),
          };
        }));
      setTaskSearchError("");
      setTasksLoading(false);
      return;
    }

    let active = true;
    setTasksLoading(true);
    setTaskSearchError("");
    void productApi.listTasks()
      .then((items) => {
        if (!active) return;
        setSearchableTasks(items.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description ?? "",
          goalId: task.goalId,
          goalTitle: task.goalTitle,
          date: task.date,
          done: task.done,
        })));
      })
      .catch((reason) => {
        if (!active) return;
        setTaskSearchError(reason instanceof Error ? reason.message : "任务索引加载失败");
      })
      .finally(() => { if (active) setTasksLoading(false); });
    return () => { active = false; };
  }, [authStatus, goals]);

  useEffect(() => {
    if (!storageReady || authStatus === "authenticated") return;
    writeProductArray(PRODUCT_STORAGE_KEYS.goals, goals);
  }, [authStatus, goals, storageReady]);

  useEffect(() => {
    if (!selectedGoal) return;

    function closeDialog(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      closeGoalDialog();
    }

    window.addEventListener("keydown", closeDialog);
    return () => window.removeEventListener("keydown", closeDialog);
  }, [selectedGoal]);

  function submitTaskSearch() {
    const query = searchTerm.trim();
    setSubmittedSearch(query);
    setSearchResultsOpen(Boolean(query));
    setFilterMenuOpen(false);
  }

  function openSearchResult(task: SearchableTask) {
    if (!task.goalId) {
      setTaskSearchError("这个历史任务没有关联目标，暂时无法定位详情。只保留在搜索结果中。");
      return;
    }
    router.push(`/studio/work/goals/${task.goalId}?taskId=${encodeURIComponent(task.id)}`);
  }

  async function toggleGoalPause(goal: Goal) {
    signalPiloState("checking", { source: "goals:status" });
    const nextStatus: GoalStatus = goal.status === "已暂停" ? "进行中" : "已暂停";
    if (authStatus === "authenticated" && typeof goal.id === "string") {
      try { await productApi.updateGoal(goal.id, { status: nextStatus === "已暂停" ? "paused" : "active" }); }
      catch (reason) { signalPiloState("failure", { source: "goals:status", duration: 4_200 }); setDataError(reason instanceof Error ? reason.message : "目标状态更新失败"); return; }
    }
    setGoals((current) => current.map((item) => item.id === goal.id ? { ...item, status: nextStatus } : item));
    setSelectedGoal((current) => current?.id === goal.id ? { ...current, status: nextStatus } : current);
    signalPiloState("success", {
      source: "goals:status",
      reason: nextStatus === "进行中" ? "这个目标重新开始生长" : "目标状态已经更新",
      duration: nextStatus === "进行中" ? 6_400 : 3_200,
      accessory: nextStatus === "进行中" ? "wristwarmers" : undefined,
      lifeAction: nextStatus === "进行中" ? "nurture-growth" : undefined,
    });
  }

  async function removeGoal(goal: Goal) {
    const confirmed = await confirmAction({
      title: `删除目标“${goal.name}”？`,
      description: "目标关联的计划与任务将一并删除，此操作无法撤销。",
      confirmLabel: "确认删除",
      cancelLabel: "保留目标",
      tone: "danger",
    });
    if (!confirmed) return;
    if (authStatus === "authenticated" && typeof goal.id === "string") {
      try { await productApi.deleteGoal(goal.id); }
      catch (reason) { setDataError(reason instanceof Error ? reason.message : "目标删除失败"); return; }
    }
    setGoals((current) => current.filter((item) => item.id !== goal.id));
    closeGoalDialog();
  }

  return (
    <div className="resource-page tech-goals-page">
      <header className="workspace-pagebar goals-redesign-heading">
        <div className="workspace-page-title">
          <small>GOALS</small>
          <h1>目标管理</h1>
          <span>规划长期方向，持续推进每一个重要目标</span>
        </div>
        <div className="goals-heading-actions">
          <div className="goals-filter-actions goals-heading-tools" ref={headingToolsRef}>
            <label className="goals-heading-search-field">
              <Search size={15} />
              <input
                value={searchTerm}
                onChange={(event) => {
                  setSearchTerm(event.target.value);
                  if (!event.target.value) {
                    setSubmittedSearch("");
                    setSearchResultsOpen(false);
                  }
                }}
                onFocus={() => { if (submittedSearch) setSearchResultsOpen(true); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitTaskSearch();
                  if (event.key === "Escape") setSearchResultsOpen(false);
                }}
                placeholder="搜索任务或目标"
                aria-label="搜索全部任务，包括历史任务"
              />
              {searchTerm && (
                <button
                  type="button"
                  className="goals-search-clear"
                  aria-label="清除搜索"
                  onClick={() => {
                    setSearchTerm("");
                    setSubmittedSearch("");
                    setSearchResultsOpen(false);
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </label>
            <button
              type="button"
              className={`goals-search-icon-button ${searchResultsOpen ? "is-active" : ""}`}
              aria-label="执行任务搜索"
              data-tooltip="搜索全部任务，包含已完成和历史任务"
              onClick={submitTaskSearch}
            >
              <Search size={17} />
            </button>
            <button
              type="button"
              className={`goals-filter-button ${filterMenuOpen ? "is-active" : ""}`}
              aria-label="高级筛选目标"
              aria-expanded={filterMenuOpen}
              data-tooltip={filterMenuOpen ? undefined : "高级筛选：按目标状态查看"}
              onClick={() => setFilterMenuOpen((current) => !current)}
            >
              <SlidersHorizontal size={17} />
            </button>
            {filterMenuOpen && (
              <div className="goals-filter-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => { setFilter("有风险"); setFilterMenuOpen(false); }}>只看有风险</button>
                <button type="button" role="menuitem" onClick={() => { setFilter("全部"); setFilterMenuOpen(false); }}>清除筛选</button>
              </div>
            )}
            {searchResultsOpen && (
              <section className="goals-task-search-results" aria-label="任务搜索结果" aria-live="polite">
                <header>
                  <div>
                    <strong>任务搜索</strong>
                    <span>{tasksLoading ? "正在检索全部任务…" : `找到 ${taskSearchResults.length} 个任务`}</span>
                  </div>
                  <button type="button" aria-label="关闭任务搜索结果" onClick={() => setSearchResultsOpen(false)}><X size={14} /></button>
                </header>
                {taskSearchError && <p className="goals-task-search-message is-error">{taskSearchError}</p>}
                {!tasksLoading && !taskSearchError && taskSearchResults.length === 0 && (
                  <p className="goals-task-search-message">没有找到“{submittedSearch}”对应的任务，请检查完整名称或关键词。</p>
                )}
                <div className="goals-task-search-list">
                  {taskSearchResults.map((task) => {
                    const associatedGoal = goals.find((goal) => String(goal.id) === task.goalId);
                    const isArchived = associatedGoal?.status === "已暂停";
                    const isHistorical = Boolean(task.date && task.date < todayIsoDate());
                    const statusLabel = isArchived ? "已归档" : task.done ? "已完成" : isHistorical ? "历史任务" : "待完成";
                    return (
                      <button type="button" key={task.id} className="goals-task-search-result" onClick={() => openSearchResult(task)}>
                        <span className="goals-task-search-copy">
                          <strong>{task.title}</strong>
                          <small>{task.goalTitle} · {formatTaskDate(task.date)}</small>
                        </span>
                        <span className={`goals-task-search-status is-${isArchived || task.done || isHistorical ? "history" : "active"}`}>{statusLabel}</span>
                        <ChevronRight size={15} />
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        </div>
      </header>

      {(dataLoading || dataError) && <div className={`product-data-state ${dataError ? "is-error" : ""}`} role={dataError ? "alert" : "status"}>{dataLoading ? "正在同步目标…" : dataError}<button type="button" onClick={() => window.location.reload()}>刷新</button></div>}

      <div className="goals-redesign-grid">
        <section className="goals-list-panel" aria-labelledby="my-goals-heading">
          <header className="goals-panel-heading">
            <h2 id="my-goals-heading" className="sr-only">我的目标</h2>
            <div className="goals-panel-heading-actions">
              <div className="filter-tabs" role="tablist" aria-label="目标状态筛选">
                {(["全部", "进行中", "已完成", "已归档"] as const).map((item) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={filter === item}
                    key={item}
                    className={filter === item ? "is-active" : ""}
                    onClick={() => setFilter(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="primary-action goals-panel-create"
                onClick={() => setGoalDialog({ mode: "create" })}
              >
                <Plus size={15} /> 新建目标
              </button>
            </div>
          </header>
          <div className="goals-list" ref={goalsListRef}>
            {visibleGoals.map((goal, index) => {
              const GoalTypeIcon = index === 0 ? Rocket : index === 1 ? LibraryBig : Sprout;
              const taskSummary = goal.taskSummary || (index === 0 ? "16 / 25 个任务" : index === 1 ? "8 / 21 个任务" : "18 / 30 个任务");
              const statusLabel = goal.status === "已暂停" ? "已归档" : goal.status;
              const nextAction = goal.next || "继续执行当前计划";
              return (
                <article
                  className={`goal-list-row tech-goal-card is-${goal.status}`}
                  key={goal.id}
                  style={{ "--goal-list-delay": `${Math.min(index, 6) * 45}ms` } as CSSProperties}
                  role="link"
                  tabIndex={0}
                  aria-label={`查看目标 ${goal.name}`}
                  onClick={() => router.push(`/studio/work/goals/${goal.id}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") router.push(`/studio/work/goals/${goal.id}`);
                  }}
                >
                  <span className={`goal-list-icon goal-list-icon-${index % 3}`}><GoalTypeIcon size={18} /></span>
                  <div className="goal-list-main">
                    <div className="goal-list-title-line">
                      <strong>{goal.name}</strong>
                      <small className={`goal-list-status status-${goal.status}`}>{statusLabel}</small>
                    </div>
                    <p className="goal-list-next"><span>下一步：</span>{nextAction}</p>
                    <div className="goal-list-detail-line">
                      <i><span style={{ width: `${goal.progress}%` }} /></i>
                      <small>{taskSummary} · {goalRemainingLabel(goal)}</small>
                    </div>
                  </div>
                  <div className="goal-list-progress">
                    <strong>{goal.progress}%</strong>
                  </div>
                  <details className="goal-list-menu" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                    <summary
                      aria-label={`管理目标 ${goal.name}`}
                    >
                      <MoreHorizontal size={17} />
                    </summary>
                    <div role="menu">
                      <button type="button" role="menuitem" aria-label={`编辑目标 ${goal.name}`} onClick={() => setGoalDialog({ mode: "edit", goalId: String(goal.id) })}><Pencil size={13} />编辑</button>
                      <button type="button" role="menuitem" aria-label={`删除目标 ${goal.name}`} onClick={() => void removeGoal(goal)}><Trash2 size={13} />删除</button>
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="goals-side-stack">
          <section className="goal-insight-panel" aria-labelledby="goal-overview-heading">
            <header className="goals-panel-heading">
              <h2 id="goal-overview-heading">总体进度</h2>
            </header>
            <div className="goal-donut-layout">
              <div className="goal-donut" style={{ background: donutGradient }} aria-label={`总体进度 ${completionAverage}%`}>
                <div><strong>{completionAverage}%</strong><span>平均进度</span></div>
              </div>
              <div className="goal-legend">
                <span><i className="is-planned" />平均进度<strong>{completionAverage}%</strong></span>
                <span><i className="is-risk" />有风险目标<strong>{riskCount} 个</strong></span>
                <span><i className="is-done" />已完成目标<strong>{completedCount} 个</strong></span>
              </div>
            </div>
          </section>

          <section className="goal-insight-panel goal-milestones-panel" id="goal-milestones" aria-labelledby="goal-milestones-heading">
            <header className="goals-panel-heading">
              <h2 id="goal-milestones-heading">目标状态摘要</h2>
              {activeMilestoneGoals.length >= 2 && (
                <div className="goal-milestone-switcher" ref={milestoneSwitcherRef}>
                  <button
                    type="button"
                    className="goal-milestone-switcher-trigger"
                    aria-label={`切换目标动态范围：${selectedMilestoneGoal?.name ?? "全部目标"}`}
                    aria-haspopup="listbox"
                    aria-expanded={milestoneMenuOpen}
                    data-tooltip="切换目标动态范围"
                    onClick={() => setMilestoneMenuOpen((open) => !open)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setMilestoneMenuOpen(false);
                    }}
                  >
                    <span>{selectedMilestoneGoal?.name ?? "全部目标"}</span>
                    <ChevronDown size={13} aria-hidden="true" />
                  </button>
                  {milestoneMenuOpen && (
                    <div className="goal-milestone-switcher-menu" role="listbox" aria-label="目标动态范围">
                      <button
                        type="button"
                        role="option"
                        aria-selected={milestoneScope === "all"}
                        className={milestoneScope === "all" ? "is-selected" : ""}
                        onClick={() => { setMilestoneScope("all"); setMilestoneMenuOpen(false); }}
                      >
                        <span><strong>全部进行中目标</strong><small>按优先级聚合</small></span>
                        {milestoneScope === "all" && <Check size={13} aria-hidden="true" />}
                      </button>
                      {activeMilestoneGoals.map((goal) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={milestoneScope === String(goal.id)}
                          className={milestoneScope === String(goal.id) ? "is-selected" : ""}
                          key={goal.id}
                          onClick={() => { setMilestoneScope(String(goal.id)); setMilestoneMenuOpen(false); }}
                        >
                          <span><strong>{goal.name}</strong><small>{goal.status} · {goalRemainingLabel(goal)}</small></span>
                          {milestoneScope === String(goal.id) && <Check size={13} aria-hidden="true" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </header>
            <div className="goal-milestones-list" onScroll={revealMilestoneScrollbar}>
              {milestoneItems.map((milestone, index) => (
                <div className={`goal-milestone tone-${milestone.tone}`} key={`${milestone.title}-${index}`}>
                  <span className={`goal-milestone-dot ${index === 0 ? "is-current" : ""}`} />
                  <div>
                    <span className="goal-milestone-title">{milestone.title}</span>
                    <small className={`goal-milestone-status ${milestone.meta === "优先处理" ? "is-priority" : milestone.meta === "临近截止" ? "is-deadline" : ""}`}>{milestone.meta}</small>
                  </div>
                </div>
              ))}
              {milestoneItems.length === 0 && <p className="goal-milestone-empty">暂无需要推进的目标；恢复已暂停目标或创建新目标后，这里会汇总下一步。</p>}
            </div>
          </section>
        </aside>

      </div>
      {!dataLoading && visibleGoals.length === 0 && <div className="product-empty-state"><Target size={22} /><strong>还没有符合条件的目标</strong><p>创建第一个目标后，计划、任务和知识空间会围绕它组织。</p><button type="button" onClick={() => setGoalDialog({ mode: "create" })}><Plus size={15} />新建目标</button></div>}

      {selectedGoal && (
        <div className="dialog-backdrop" onMouseDown={closeGoalDialog}>
          <section
            className="app-dialog compact-dialog goal-detail-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedGoal.name}详情`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div><small>GOAL DETAIL</small><h2>{selectedGoal.name}</h2></div>
              <button
                type="button"
                aria-label="关闭目标详情"
                onClick={closeGoalDialog}
              >
                <X size={17} />
              </button>
            </header>
            <div className="goal-detail-grid">
              <div><span>目标类型</span><strong>{selectedGoal.type}</strong></div>
              <div><span>当前状态</span><strong>{selectedGoal.status}</strong></div>
              <div><span>截止日期</span><strong>{selectedGoal.deadline}</strong></div>
              <div><span>每日投入</span><strong>{selectedGoal.daily}</strong></div>
            </div>
            <div className="goal-detail-next">
              <span>下一步</span>
              <strong>{selectedGoal.next}</strong>
            </div>
            <footer>
              <button type="button" className="danger-quiet" onClick={() => void removeGoal(selectedGoal)}>删除目标</button>
              <button type="button" onClick={() => void toggleGoalPause(selectedGoal)}>{selectedGoal.status === "已暂停" ? "恢复目标" : "暂停目标"}</button>
              <button type="button" onClick={closeGoalDialog}>关闭</button>
            </footer>
          </section>
        </div>
      )}

      {goalDialog?.mode === "create" && (
        <GoalCreateDialog
          onClose={() => setGoalDialog(null)}
          onGoalChanged={() => setGoalMutationVersion((version) => version + 1)}
        />
      )}

      {goalDialog?.mode === "edit" && (
        <GoalEditDialog
          goalId={goalDialog.goalId}
          onClose={() => setGoalDialog(null)}
          onGoalChanged={() => setGoalMutationVersion((version) => version + 1)}
        />
      )}

    </div>
  );
}
