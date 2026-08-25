"use client";

import {
  AlertTriangle,
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
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/technology/AuthProvider";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataSyncNotice } from "@/components/ui/DataSyncNotice";
import { productApi, type ApiGoal, type ApiTask, type GoalProgress } from "@/lib/technology/productApi";
import {
  PRODUCT_STORAGE_KEYS,
  readProductArray,
  writeProductArray,
} from "@/lib/technology/productData";
import { signalPiloContext } from "@/lib/technology/piloContext";
import { ensureGuestDatasetSeeded, guestStoredGoals } from "@/lib/technology/guestData";

type GoalBaseStatus = ApiGoal["status"];
type GoalFilter = "全部" | "进行中" | "有风险" | "已完成" | "已暂停" | "已归档" | "尚未规划";
type ProgressState = "ready" | "loading" | "error";

type Goal = {
  id: string | number;
  name: string;
  type: string;
  progress: number;
  deadline: string;
  deadlineDate?: string;
  daily: string;
  status: GoalBaseStatus;
  isRisk: boolean;
  progressState: ProgressState;
  completedTasks: number | null;
  totalTasks: number | null;
  next: string;
  taskSummary: string;
  rhythmSummary: string;
  debtCount?: number;
  scheduleDeltaDays?: number | null;
};

type GoalMilestone = {
  goalId: string;
  taskId?: string;
  title: string;
  goalName: string;
  detail: string;
  meta: string;
  tone: "attention" | "active" | "ready" | "done" | "neutral";
  priority: number;
  isCurrent: boolean;
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

const INITIAL_GOALS: Goal[] = guestStoredGoals();

function goalRemainingDays(goal: Goal) {
  if (goal.deadline === "长期" || !goal.deadlineDate) return "持续进行";
  const target = new Date(`${goal.deadlineDate}T00:00:00`);
  if (Number.isNaN(target.getTime())) return "持续进行";
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.ceil((target.getTime() - startOfToday.getTime()) / 86_400_000);
}

function goalRemainingLabel(goal: Goal) {
  if (goal.status === "completed") return "已完成";
  const days = goalRemainingDays(goal);
  if (days === "持续进行") return days;
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `剩余 ${days} 天`;
}

function goalStatusLabel(goal: Goal) {
  if (goal.status === "completed") return "已完成";
  if (goal.status === "paused") return "已暂停";
  if (goal.status === "abandoned") return "已归档";
  return goal.isRisk ? "有风险" : "进行中";
}

function legacyStatus(value: unknown, progress: number): GoalBaseStatus {
  if (value === "paused" || value === "已暂停") return "paused";
  if (value === "abandoned" || value === "已归档" || value === "已放弃") return "abandoned";
  if (value === "completed" || value === "已完成" || progress >= 100) return "completed";
  return "active";
}

function normalizeLocalGoal(goal: Goal): Goal {
  const match = String(goal.taskSummary ?? "").match(/(\d+)\s*\/\s*(\d+)/);
  const progress = Number.isFinite(Number(goal.progress)) ? Number(goal.progress) : 0;
  const status = legacyStatus(goal.status, progress);
  const remainingDays = goal.deadlineDate
    ? Math.ceil((new Date(`${goal.deadlineDate}T00:00:00`).getTime() - new Date(`${todayIsoDate()}T00:00:00`).getTime()) / 86_400_000)
    : null;
  const isRisk = status === "active" && (
    Boolean(goal.isRisk)
    || String(goal.status) === "有风险"
    || Number(goal.debtCount ?? 0) > 0
    || Number(goal.scheduleDeltaDays ?? 0) < 0
    || (remainingDays != null && remainingDays < 0)
  );
  return {
    ...goal,
    status,
    isRisk,
    progressState: goal.progressState ?? "ready",
    completedTasks: goal.completedTasks ?? (match ? Number(match[1]) : null),
    totalTasks: goal.totalTasks ?? (match ? Number(match[2]) : null),
  };
}

function goalMilestones(goal: Goal, tasks: SearchableTask[]): GoalMilestone[] {
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
  const debtCount = goal.debtCount ?? 0;
  const behindDays = typeof goal.scheduleDeltaDays === "number" && goal.scheduleDeltaDays < 0
    ? Math.abs(goal.scheduleDeltaDays)
    : 0;
  const isOverdue = typeof remainingDays === "number" && remainingDays < 0;
  const needsPriority = isOverdue || behindDays >= 3 || debtCount >= 3;
  const items: GoalMilestone[] = [];

  if (goal.isRisk) {
    const riskDetail = isOverdue
      ? `已超过截止日期 ${Math.abs(Number(remainingDays))} 天`
      : behindDays > 0
        ? `当前节奏落后计划 ${behindDays} 天`
        : debtCount > 0
          ? `有 ${debtCount} 项待复习知识需要安排`
          : "推进节奏需要重新确认";
    items.push({
      goalId: String(goal.id),
      title: `${goal.name}${riskDetail}`,
      goalName: goal.name,
      detail: riskDetail,
      meta: needsPriority ? "优先处理" : "需要关注",
      tone: "attention",
      priority: 0,
      isCurrent: false,
    });
  }

  if (typeof remainingDays === "number" && remainingDays >= 0 && remainingDays <= 7 && (behindDays > 0 || debtCount > 0)) {
    const deadlineDetail = remainingDays === 0 ? "今天到期" : `距离截止还有 ${remainingDays} 天`;
    items.push({
      goalId: String(goal.id),
      title: `${goal.name}${deadlineDetail}`,
      goalName: goal.name,
      detail: deadlineDetail,
      meta: "临近截止",
      tone: "attention",
      priority: 1,
      isCurrent: false,
    });
  }

  items.push({
    goalId: String(goal.id),
    taskId: goalTasks[0]?.id,
    title: `${goal.name}下一步：${nextAction}`,
    goalName: goal.name,
    detail: `下一步：${nextAction}`,
    meta: goalTasks[0]?.date === todayIsoDate() ? "今日任务" : goalTasks[0] ? "下一项任务" : "持续推进",
    tone: "active",
    priority: 2,
    isCurrent: goalTasks[0]?.date === todayIsoDate(),
  });

  return items;
}

export default function GoalsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status: authStatus } = useAuth();
  const { confirmAction } = useConfirmDialog();
  const [goals, setGoals] = useState<Goal[]>([]);
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
  const [goalMutationVersion, setGoalMutationVersion] = useState(0);
  const [progressRetryVersion, setProgressRetryVersion] = useState(0);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState("");
  const [progressError, setProgressError] = useState("");
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
            || (filter === "进行中" && goal.status === "active")
            || (filter === "有风险" && goal.isRisk)
            || (filter === "已完成" && goal.status === "completed")
            || (filter === "已暂停" && goal.status === "paused")
            || (filter === "已归档" && goal.status === "abandoned")
            || (filter === "尚未规划" && goal.status !== "abandoned" && goal.progressState === "ready" && goal.totalTasks === 0);
        const matchesQuery = !query
          || `${goal.name}${goal.type}${goal.next}`.toLocaleLowerCase("zh-CN").includes(query)
          || matchedGoalIds.has(String(goal.id));
        return matchesFilter && matchesQuery;
      });
    },
    [filter, goals, submittedSearch, taskSearchResults],
  );

  const includedProgressGoals = goals.filter((goal) => goal.status !== "abandoned" && goal.progressState === "ready" && Number(goal.totalTasks) > 0);
  const completedTaskTotal = includedProgressGoals.reduce((total, goal) => total + Number(goal.completedTasks ?? 0), 0);
  const taskTotal = includedProgressGoals.reduce((total, goal) => total + Number(goal.totalTasks ?? 0), 0);
  const completionAverage = taskTotal > 0 ? Math.round((completedTaskTotal / taskTotal) * 100) : 0;
  const riskCount = goals.filter((goal) => goal.isRisk).length;
  const completedCount = goals.filter((goal) => goal.status === "completed").length;
  const unplannedCount = goals.filter((goal) => goal.status !== "abandoned" && goal.progressState === "ready" && goal.totalTasks === 0).length;
  const reviewDueCount = goals.reduce((total, goal) => total + Number(goal.debtCount ?? 0), 0);
  useEffect(() => {
    const piloGoals = goals.filter((goal) => goal.status === "active" || goal.status === "completed");
    signalPiloContext({
      kind: "scope",
      surface: "goals",
      goalIds: piloGoals.filter((goal) => goal.status === "active").map((goal) => String(goal.id)),
      itemCount: piloGoals.length,
      completedCount,
      reviewDueCount,
    });
  }, [completedCount, goals, reviewDueCount]);
  const activeMilestoneGoals = useMemo(
    () => goals.filter((goal) => goal.status === "active"),
    [goals],
  );
  const selectedMilestoneGoal = milestoneScope === "all"
    ? null
    : activeMilestoneGoals.find((goal) => String(goal.id) === milestoneScope) ?? null;
  const allMilestoneItems = useMemo(
    () => (milestoneScope === "all"
      ? activeMilestoneGoals
      : activeMilestoneGoals.filter((goal) => String(goal.id) === milestoneScope))
      .flatMap((goal) => goalMilestones(goal, searchableTasks))
      .sort((first, second) => first.priority - second.priority),
    [activeMilestoneGoals, milestoneScope, searchableTasks],
  );
  const milestoneItems = allMilestoneItems.slice(0, 10);
  const hiddenMilestoneCount = Math.max(0, allMilestoneItems.length - milestoneItems.length);

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
    router.replace("/studio/work/goals/new", { scroll: false });
  }, [router, searchParams]);

  function goalFromApi(goal: ApiGoal, progress?: GoalProgress): Goal {
    const typeLabel: Record<ApiGoal["type"], string> = { exam: "考试备考", certification: "认证学习", skill: "技能提升", reading: "阅读计划", language: "语言学习", habit: "习惯养成" };
    const progressValue = goal.status === "completed"
      ? 100
      : progress?.total_tasks
      ? Math.round((progress.completed_tasks / progress.total_tasks) * 100)
      : Math.round((progress?.avg_completion_rate ?? 0) * 100);
    const deadlineDays = Math.ceil((new Date(`${goal.deadline}T00:00:00`).getTime() - new Date(`${todayIsoDate()}T00:00:00`).getTime()) / 86_400_000);
    const isRisk = goal.status === "active" && (
      (progress?.debt_count ?? 0) > 0
      || (progress?.days_ahead_or_behind ?? 0) < 0
      || deadlineDays < 0
    );
    const deadline = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${goal.deadline}T00:00:00`));
    return {
      id: goal.id,
      name: goal.title,
      type: typeLabel[goal.type],
      progress: progress ? Math.min(100, progressValue) : 0,
      deadline,
      deadlineDate: goal.deadline,
      daily: `${Math.round(goal.daily_hours * 60)} 分钟`,
      status: goal.status,
      isRisk,
      progressState: progress ? "ready" : "error",
      completedTasks: progress?.completed_tasks ?? null,
      totalTasks: progress?.total_tasks ?? null,
      next: progress?.debt_count ? `${progress.debt_count} 项学习债务需要处理` : `${goal.current_level === "beginner" ? "初学" : goal.current_level === "intermediate" ? "进阶" : "高阶"}阶段 · 继续执行当前计划`,
      taskSummary: progress ? `${progress.completed_tasks} / ${progress.total_tasks} 个任务` : "进度暂不可同步",
      rhythmSummary: progress?.debt_count ? `${progress.debt_count} 项知识待复习` : progress ? `连续学习 ${progress.streak_days} 天` : "进度暂不可同步",
      debtCount: progress?.debt_count,
      scheduleDeltaDays: progress?.days_ahead_or_behind,
    };
  }

  useEffect(() => {
    if (authStatus === "loading") {
      setGoals([]);
      setDataLoading(true);
      setDataError("");
      setProgressError("");
      return;
    }
    if (authStatus === "unauthenticated") {
      ensureGuestDatasetSeeded();
      setGoals(readProductArray<Goal>(PRODUCT_STORAGE_KEYS.goals, INITIAL_GOALS).map(normalizeLocalGoal));
      setStorageReady(true);
      setDataLoading(false);
      setDataError("");
      setProgressError("");
      return;
    }
    let active = true;
    setGoals([]);
    setDataLoading(true);
    setDataError("");
    setProgressError("");
    void productApi.listGoals().then(async (items) => {
      let progressRows: GoalProgress[] = [];
      try {
        progressRows = await productApi.getGoalsProgress();
      } catch (reason) {
        if (active) setProgressError(reason instanceof Error ? reason.message : "目标进度暂不可同步");
      }
      if (!active) return;
      const progressByGoal = new Map(progressRows.map((row) => [row.goal_id, row]));
      const mappedGoals = items.map((item) => goalFromApi(item, progressByGoal.get(item.id)));
      if (progressRows.length > 0 && mappedGoals.some((goal) => goal.progressState === "error")) {
        setProgressError("部分目标进度暂不可同步");
      }
      setGoals(mappedGoals);
    }).catch((reason) => {
      if (!active) return;
      setGoals([]);
      setDataError(reason instanceof Error ? reason.message : "目标加载失败");
    })
      .finally(() => { if (active) setDataLoading(false); });
    return () => { active = false; };
  }, [authStatus, goalMutationVersion, progressRetryVersion]);

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
              <div className="goals-filter-menu" role="menu" aria-label="高级目标筛选">
                <button className={filter === "有风险" ? "is-selected" : ""} type="button" role="menuitem" onClick={() => { setFilter("有风险"); setFilterMenuOpen(false); }}><Target size={15} aria-hidden="true" /><span>只看有风险</span>{filter === "有风险" && <Check size={14} aria-hidden="true" />}</button>
                <button type="button" role="menuitem" onClick={() => { setFilter("全部"); setFilterMenuOpen(false); }}><X size={15} aria-hidden="true" /><span>清除筛选</span></button>
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
                    const isArchived = associatedGoal?.status === "abandoned";
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

      {(dataLoading || dataError || progressError) && (
        <DataSyncNotice
          loading={dataLoading && !dataError}
          title={dataError ? "目标同步失败" : progressError ? "目标进度同步失败" : "正在同步目标"}
          message={dataError || progressError || undefined}
          retryLabel="重新加载"
          onRetry={dataError
            ? () => setGoalMutationVersion((version) => version + 1)
            : progressError
              ? () => setProgressRetryVersion((version) => version + 1)
              : undefined}
        />
      )}
      {!dataLoading && dataError && (
        <div className="product-empty-state" role="status">
          <Target size={22} aria-hidden="true" />
          <strong>目标列表暂未显示</strong>
          <p>你的目标数据没有被清空。连接恢复后，点击右上角“重新加载”即可继续。</p>
        </div>
      )}
      {!dataLoading && !dataError && <div className="goals-redesign-grid">
        <section className="goals-list-panel" aria-labelledby="my-goals-heading">
          <header className="goals-panel-heading">
            <h2 id="my-goals-heading" className="sr-only">我的目标</h2>
            <div className="goals-panel-heading-actions">
              <div className="filter-tabs" role="tablist" aria-label="目标状态筛选">
                {(["全部", "进行中", "已完成", "已暂停", "已归档"] as const).map((item) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={filter === item}
                    data-filter={item}
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
                onClick={() => router.push("/studio/work/goals/new")}
              >
                <Plus size={15} /> 新建目标
              </button>
            </div>
          </header>
          <div className={`goals-list ${visibleGoals.length === 0 ? "is-empty" : ""}`} ref={goalsListRef}>
            {visibleGoals.map((goal, index) => {
              const GoalTypeIcon = index === 0 ? Rocket : index === 1 ? LibraryBig : Sprout;
              const taskSummary = goal.taskSummary || (index === 0 ? "16 / 25 个任务" : index === 1 ? "8 / 21 个任务" : "18 / 30 个任务");
              const statusLabel = goalStatusLabel(goal);
              const nextAction = goal.next || "继续执行当前计划";
              return (
                <article
                  className={`goal-list-row tech-goal-card is-${statusLabel}`}
                  key={goal.id}
                  style={{ "--goal-list-delay": `${Math.min(index, 6) * 45}ms` } as CSSProperties}
                >
                  <Link
                    href={`/studio/work/goals/${goal.id}`}
                    aria-label={`查看目标 ${goal.name}`}
                    style={{ position: "absolute", inset: 0, zIndex: 1, borderRadius: "inherit" }}
                  />
                  <span className={`goal-list-icon goal-list-icon-${index % 3}`}><GoalTypeIcon size={18} /></span>
                  <div className="goal-list-main">
                    <div className="goal-list-title-line">
                      <strong>{goal.name}</strong>
                      <small className={`goal-list-status status-${statusLabel}`}>{statusLabel}</small>
                    </div>
                    <p className="goal-list-next"><span>下一步：</span>{nextAction}</p>
                    <div className="goal-list-detail-line">
                      <i><span style={{ width: goal.progressState === "ready" ? `${goal.progress}%` : "0%" }} /></i>
                      <small>{taskSummary} · {goalRemainingLabel(goal)}</small>
                    </div>
                  </div>
                  <div className="goal-list-progress">
                    <strong>{goal.progressState === "ready" ? `${goal.progress}%` : "--"}</strong>
                  </div>
                  <details className="goal-list-menu" style={{ zIndex: 2 }}>
                    <summary
                      aria-label={`管理目标 ${goal.name}`}
                    >
                      <MoreHorizontal size={17} />
                    </summary>
                    <div role="menu">
                      <button type="button" role="menuitem" aria-label={`编辑目标 ${goal.name}`} onClick={() => router.push(`/studio/work/goals/${goal.id}/edit`)}><Pencil size={15} /><span>编辑</span></button>
                      <button type="button" role="menuitem" aria-label={`删除目标 ${goal.name}`} onClick={() => void removeGoal(goal)}><Trash2 size={15} /><span>删除</span></button>
                    </div>
                  </details>
                </article>
              );
            })}
            {visibleGoals.length === 0 && (
              <div className="product-empty-state" role="status">
                <Target size={22} aria-hidden="true" />
                <strong>还没有符合条件的目标</strong>
                <p>创建第一个目标后，计划、任务和知识空间会围绕它组织。</p>
                <button type="button" onClick={() => router.push("/studio/work/goals/new")}><Plus size={15} />新建目标</button>
              </div>
            )}
          </div>
        </section>

        <aside className="goals-side-stack">
          <section className="goal-insight-panel" aria-labelledby="goal-overview-heading">
            <header className="goals-panel-heading">
              <div className="goal-overview-heading-copy">
                <h2 id="goal-overview-heading">总体进度</h2>
                <small>{progressError ? "目标已加载，任务进度暂不可同步" : "根据未归档目标的已有任务计算"}</small>
              </div>
            </header>
            <div className={`goal-donut-layout ${progressError ? "is-unavailable" : ""}`}>
              <div
                className={`goal-donut ${progressError ? "is-unavailable" : ""}`}
                style={{ "--goal-progress-value": `${completionAverage}%` } as CSSProperties}
                aria-label={progressError ? "总体进度暂不可同步" : `未归档目标任务进度 ${completionAverage}%`}
              >
                <div><strong>{progressError ? "—" : `${completionAverage}%`}</strong><span>{progressError ? "进度暂不可用" : "任务进度"}</span></div>
              </div>
              {progressError ? (
                <div className="goal-overview-unavailable-copy" role="status">
                  <span aria-hidden="true"><AlertTriangle size={16} /></span>
                  <div>
                    <strong>进度数据暂未显示</strong>
                    <small>目标本身仍然存在，重新加载后会自动更新任务进度。</small>
                  </div>
                </div>
              ) : (
                <div className="goal-legend">
                  <span data-tone="progress" title="未归档且已有任务的目标" role="button" tabIndex={0} onClick={() => setFilter("全部")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setFilter("全部"); }}><i className="is-planned" />任务完成<strong>{`${completedTaskTotal}/${taskTotal}`}</strong></span>
                  <span data-tone="risk" role="button" tabIndex={0} onClick={() => setFilter("有风险")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setFilter("有风险"); }}><i className="is-risk" />有风险目标<strong>{riskCount} 个</strong></span>
                  <span data-tone="done" role="button" tabIndex={0} onClick={() => setFilter("已完成")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setFilter("已完成"); }}><i className="is-done" />已完成目标<strong>{completedCount} 个</strong></span>
                  {unplannedCount > 0 && <span data-tone="unplanned" role="button" tabIndex={0} onClick={() => setFilter("尚未规划")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setFilter("尚未规划"); }}><i className="is-unplanned" />尚未规划<strong>{unplannedCount} 个</strong></span>}
                </div>
              )}
            </div>
          </section>

          <section className="goal-insight-panel goal-milestones-panel" id="goal-milestones" aria-labelledby="goal-milestones-heading">
            <header className="goals-panel-heading">
              <h2 id="goal-milestones-heading">目标状态</h2>
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
                        <Target size={15} aria-hidden="true" />
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
                          <Sprout size={15} aria-hidden="true" />
                          <span><strong>{goal.name}</strong><small>{goalStatusLabel(goal)} · {goalRemainingLabel(goal)}</small></span>
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
                <Link
                  className={`goal-milestone tone-${milestone.tone}`}
                  key={`${milestone.title}-${index}`}
                  href={`/studio/work/goals/${milestone.goalId}${milestone.taskId ? `?taskId=${encodeURIComponent(milestone.taskId)}` : ""}`}
                  style={{ color: "inherit", textDecoration: "none", "--goal-milestone-delay": `${Math.min(index, 6) * 45}ms` } as CSSProperties}
                >
                  <span className={`goal-milestone-dot ${milestone.isCurrent ? "is-current" : ""}`} />
                  <div>
                    <span className="goal-milestone-title">
                      <strong>{milestone.goalName}</strong>
                      <span>{milestone.detail}</span>
                    </span>
                    <small className={`goal-milestone-status ${milestone.meta === "优先处理" ? "is-priority" : milestone.meta === "临近截止" ? "is-deadline" : ""}`}>{milestone.meta}</small>
                  </div>
                </Link>
              ))}
              {hiddenMilestoneCount > 0 && <p className="goal-milestone-empty">还有 {hiddenMilestoneCount} 项</p>}
              {milestoneItems.length === 0 && <p className="goal-milestone-empty">暂无需要推进的目标；恢复已暂停目标或创建新目标后，这里会汇总下一步。</p>}
            </div>
          </section>
        </aside>

      </div>}
    </div>
  );
}
