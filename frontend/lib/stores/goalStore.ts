import { create } from "zustand";
import { api } from "@/lib/api";

export type GoalType = "exam" | "certification" | "skill" | "reading" | "language" | "habit";
export type GoalStatus = "active" | "completed" | "paused" | "abandoned";

export interface Goal {
  id: string;
  type: GoalType;
  title: string;
  deadline: string;
  daily_hours: number;
  current_level: string;
  status: GoalStatus;
  meta: Record<string, unknown>;
  created_at: string;
  work_schedule: string;
  kb_id: string | null;
  description?: string | null;
  contract?: {
    baseline?: string | null;
    success_criteria?: string[];
    must_cover?: string[];
    may_skip?: string[];
    constraints?: Record<string, unknown>;
  };
  intent_version?: number;
}

export interface TodayTask {
  id: string;
  title: string;
  estimated_mins: number;
  status: "pending" | "completed" | "partial" | "skipped";
  type: "study" | "review" | "practice" | "rest";
  kb_refs: string[];
  mastery_level: string;
  description?: string | null;
  execution_guide?: {
    why_now?: string;
    steps?: string[];
    deliverable?: string;
    done_criteria?: string[];
    source_refs?: Array<{ item_id: string; item_title: string; locator: string }>;
  };
}

interface GoalStore {
  goals: Goal[];
  currentGoalId: string | null;
  todayTasks: TodayTask[];
  isLoading: boolean;
  error: string | null;
  fetchGoals: () => Promise<void>;
  fetchGoal: (id: string) => Promise<Goal>;
  setCurrentGoal: (id: string | null) => void;
  createGoal: (data: Omit<Goal, "id" | "status" | "created_at"> & {
    pending_kb?: { name: string; description: string };
    baseline?: string | null;
    success_criteria?: string[];
    must_cover?: string[];
    may_skip?: string[];
    constraints?: Record<string, unknown>;
  }) => Promise<Goal>;
  updateGoal: (id: string, data: Partial<Omit<Goal, "id" | "created_at">> & {
    baseline?: string | null;
    success_criteria?: string[];
    must_cover?: string[];
    may_skip?: string[];
    constraints?: Record<string, unknown>;
  }) => Promise<Goal>;
  deleteGoal: (id: string, deleteKb?: boolean) => Promise<void>;
  fetchTodayTasks: (goalId: string) => Promise<void>;
}

export const useGoalStore = create<GoalStore>((set) => ({
  goals: [],
  currentGoalId: null,
  todayTasks: [],
  isLoading: false,
  error: null,

  fetchGoals: async () => {
    set({ isLoading: true, error: null });
    try {
      const goals = await api.get<Goal[]>("/api/v1/goals");
      set({ goals, error: null });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "目标加载失败，请重试。";
      set({ goals: [], error: message });
      throw reason;
    } finally {
      set({ isLoading: false });
    }
  },

  fetchGoal: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const goal = await api.get<Goal>(`/api/v1/goals/${id}`);
      set((state) => ({
        goals: state.goals.some((item) => item.id === id)
          ? state.goals.map((item) => item.id === id ? goal : item)
          : [goal, ...state.goals],
        error: null,
      }));
      return goal;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "目标加载失败，请重试。";
      set({ error: message });
      throw reason;
    } finally {
      set({ isLoading: false });
    }
  },

  setCurrentGoal: (id) => set({ currentGoalId: id }),

  createGoal: async (data) => {
    const goal = await api.post<Goal>("/api/v1/goals", data);
    set((s) => ({ goals: [goal, ...s.goals] }));
    return goal;
  },

  updateGoal: async (id, data) => {
    const goal = await api.patch<Goal>(`/api/v1/goals/${id}`, data);
    set((s) => ({ goals: s.goals.map((g) => (g.id === id ? goal : g)) }));
    return goal;
  },

  deleteGoal: async (id, deleteKb) => {
    const qs = deleteKb ? "?delete_kb=true" : "";
    await api.del(`/api/v1/goals/${id}${qs}`);
    set((s) => ({
      goals: s.goals.filter((g) => g.id !== id),
      currentGoalId: s.currentGoalId === id ? null : s.currentGoalId,
    }));
  },

  fetchTodayTasks: async (goalId) => {
    try {
      const tasks = await api.get<TodayTask[]>(`/api/v1/plans/${goalId}/today`);
      set({ todayTasks: tasks });
    } catch {
      set({ todayTasks: [] });
    }
  },
}));
