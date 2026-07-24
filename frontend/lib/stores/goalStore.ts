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
}

export interface TodayTask {
  id: string;
  title: string;
  estimated_mins: number;
  status: "pending" | "completed" | "partial" | "skipped";
  type: "study" | "review" | "practice" | "rest";
  kb_refs: string[];
  mastery_level: string;
}

interface GoalStore {
  goals: Goal[];
  currentGoalId: string | null;
  todayTasks: TodayTask[];
  isLoading: boolean;
  fetchGoals: () => Promise<void>;
  setCurrentGoal: (id: string | null) => void;
  createGoal: (data: Omit<Goal, "id" | "status" | "created_at"> & { pending_kb?: { name: string; description: string } }) => Promise<Goal>;
  updateGoal: (id: string, data: Partial<Omit<Goal, "id" | "created_at">>) => Promise<Goal>;
  deleteGoal: (id: string, deleteKb?: boolean) => Promise<void>;
  fetchTodayTasks: (goalId: string) => Promise<void>;
}

export const useGoalStore = create<GoalStore>((set) => ({
  goals: [],
  currentGoalId: null,
  todayTasks: [],
  isLoading: false,

  fetchGoals: async () => {
    set({ isLoading: true });
    try {
      const goals = await api.get<Goal[]>("/api/v1/goals");
      set({ goals });
    } catch {
      // keep existing goals on error
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
