"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { api } from "@/lib/api";

export type Priority = "high" | "medium" | "low";

export type Task = {
  id: string;
  title: string;
  description?: string | null;
  goalId: string;
  goalTitle: string;
  done: boolean;
  estimatedMinutes: number;
  date: string; // YYYY-MM-DD
  priority: Priority;
  masteryLevel?: string;
};

interface TasksCtx {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;
  addTask: (t: Omit<Task, "id">) => Promise<void>;
  updateTask: (id: string, patch: Partial<Omit<Task, "id">>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  toggleTask: (id: string) => Promise<void>;
  refresh: () => void;
}

const Ctx = createContext<TasksCtx>({
  tasks: [],
  isLoading: false,
  error: null,
  addTask: async () => {},
  updateTask: async () => {},
  deleteTask: async () => {},
  toggleTask: async () => {},
  refresh: () => {},
});

export function TasksProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = useCallback(() => {
    setIsLoading(true);
    setError(null);
    api.get<Task[]>("/api/v1/tasks")
      .then((data) => {
        setTasks(Array.isArray(data) ? data : []);
        setIsLoading(false);
      })
      .catch((e) => {
        setError((e as Error).message ?? "加载任务失败");
        setIsLoading(false);
      });
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const addTask = useCallback(async (t: Omit<Task, "id">) => {
    const created = await api.post<Task>("/api/v1/tasks", t);
    setTasks((prev) => [...prev, created]);
  }, []);

  const updateTask = useCallback(async (id: string, patch: Partial<Omit<Task, "id">>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    try {
      const updated = await api.patch<Task>(`/api/v1/tasks/${id}`, patch);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch {
      loadTasks(); // 失败时重新拉取
    }
  }, [loadTasks]);

  const deleteTask = useCallback(async (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    try {
      await api.del(`/api/v1/tasks/${id}`);
    } catch {
      loadTasks();
    }
  }, [loadTasks]);

  const toggleTask = useCallback(async (id: string) => {
    let originalDone: boolean | undefined;
    setTasks((prev) => {
      const task = prev.find((t) => t.id === id);
      if (!task) return prev;
      originalDone = task.done;
      return prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
    });
    try {
      await api.patch<Task>(`/api/v1/tasks/${id}`, { done: !originalDone });
    } catch {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, done: originalDone ?? t.done } : t))
      );
    }
  }, []);

  return (
    <Ctx.Provider value={{ tasks, isLoading, error, addTask, updateTask, deleteTask, toggleTask, refresh: loadTasks }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTasks() {
  return useContext(Ctx);
}
