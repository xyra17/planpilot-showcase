"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/components/technology/AuthProvider";
import { signalPiloState } from "@/lib/technology/piloState";
import { PRODUCT_STORAGE_KEYS, readProductArray, writeProductArray } from "@/lib/technology/productData";
import { ensureGuestDatasetSeeded, guestTasks } from "@/lib/technology/guestData";

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
  executionGuide?: {
    why_now?: string;
    steps?: string[];
    deliverable?: string;
    done_criteria?: string[];
    source_refs?: Array<{ item_id: string; item_title: string; locator: string; snippet?: string }>;
  };
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

function guestTaskRecords() {
  return guestTasks().map((task) => ({ ...task }) as Record<string, unknown>);
}

export function TasksProvider({ children }: { children: React.ReactNode }) {
  const { status: authStatus } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = useCallback(() => {
    if (authStatus === "loading") return;
    setIsLoading(true);
    setError(null);
    if (authStatus === "unauthenticated") {
      ensureGuestDatasetSeeded();
      const localTasks = readProductArray<Record<string, unknown>>(PRODUCT_STORAGE_KEYS.tasks, guestTaskRecords()).map((task) => ({
        id: String(task.id),
        title: String(task.title ?? "未命名任务"),
        description: typeof task.description === "string" ? task.description : undefined,
        goalId: String(task.goalId ?? ""),
        goalTitle: String(task.goalTitle ?? task.goal ?? "未关联目标"),
        done: Boolean(task.done),
        estimatedMinutes: Number(task.estimatedMinutes ?? String(task.duration ?? "").match(/\d+/)?.[0] ?? 0),
        date: String(task.date ?? ""),
        priority: task.priority === "核心" || task.priority === "high" ? "high" as const : task.priority === "低优先级" || task.priority === "low" ? "low" as const : "medium" as const,
        masteryLevel: String(task.masteryLevel ?? "学习中"),
      }));
      setTasks(localTasks);
      setIsLoading(false);
      return;
    }
    api.get<Task[]>("/api/v1/tasks")
      .then((data) => {
        setTasks(Array.isArray(data) ? data : []);
        setIsLoading(false);
      })
      .catch((e) => {
        setError((e as Error).message ?? "加载任务失败");
        setIsLoading(false);
      });
  }, [authStatus]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const addTask = useCallback(async (t: Omit<Task, "id">) => {
    if (authStatus === "unauthenticated") {
      const created = { ...t, id: `guest-task-${crypto.randomUUID()}` };
      setTasks((prev) => [...prev, created]);
      const stored = readProductArray<Record<string, unknown>>(PRODUCT_STORAGE_KEYS.tasks, guestTaskRecords());
      writeProductArray(PRODUCT_STORAGE_KEYS.tasks, [...stored, {
        ...created,
        goal: created.goalTitle,
        duration: `${created.estimatedMinutes} 分钟`,
        time: "待安排",
        priority: created.priority === "high" ? "核心" : created.priority === "low" ? "低优先级" : "普通优先级",
      }], { notifyPilo: true });
      return;
    }
    signalPiloState("working", { source: "tasks:add" });
    try {
      const created = await api.post<Task>("/api/v1/tasks", t);
      setTasks((prev) => [...prev, created]);
      signalPiloState("success", { source: "tasks:add", duration: 3_200 });
    } catch (error) {
      signalPiloState("failure", { source: "tasks:add", duration: 4_200 });
      throw error;
    }
  }, [authStatus]);

  const updateTask = useCallback(async (id: string, patch: Partial<Omit<Task, "id">>) => {
    if (authStatus === "unauthenticated") {
      setTasks((prev) => prev.map((task) => task.id === id ? { ...task, ...patch } : task));
      const stored = readProductArray<Record<string, unknown>>(PRODUCT_STORAGE_KEYS.tasks, guestTaskRecords());
      writeProductArray(PRODUCT_STORAGE_KEYS.tasks, stored.map((task) => String(task.id) === id ? { ...task, ...patch } : task), { notifyPilo: true });
      return;
    }
    signalPiloState("checking", { source: "tasks:update" });
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    try {
      const updated = await api.patch<Task>(`/api/v1/tasks/${id}`, patch);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch {
      loadTasks(); // 失败时重新拉取
      signalPiloState("failure", { source: "tasks:update", duration: 4_200 });
      return;
    }
    signalPiloState("success", { source: "tasks:update", duration: 3_000 });
  }, [authStatus, loadTasks]);

  const deleteTask = useCallback(async (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (authStatus === "unauthenticated") {
      const stored = readProductArray<Record<string, unknown>>(PRODUCT_STORAGE_KEYS.tasks, guestTaskRecords());
      writeProductArray(PRODUCT_STORAGE_KEYS.tasks, stored.filter((task) => String(task.id) !== id), { notifyPilo: true });
      return;
    }
    try {
      await api.del(`/api/v1/tasks/${id}`);
    } catch {
      loadTasks();
    }
  }, [authStatus, loadTasks]);

  const toggleTask = useCallback(async (id: string) => {
    let originalDone: boolean | undefined;
    setTasks((prev) => {
      const task = prev.find((t) => t.id === id);
      if (!task) return prev;
      originalDone = task.done;
      return prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
    });
    if (authStatus === "unauthenticated") {
      const stored = readProductArray<Record<string, unknown>>(PRODUCT_STORAGE_KEYS.tasks, guestTaskRecords());
      writeProductArray(PRODUCT_STORAGE_KEYS.tasks, stored.map((task) => String(task.id) === id ? { ...task, done: !originalDone } : task), { notifyPilo: true });
      signalPiloState(originalDone ? "checking" : "success", { source: "tasks:toggle", duration: originalDone ? 2_800 : 3_200 });
      return;
    }
    try {
      await api.patch<Task>(`/api/v1/tasks/${id}`, { done: !originalDone });
      signalPiloState(originalDone ? "checking" : "success", { source: "tasks:toggle", duration: originalDone ? 2_800 : 3_200 });
    } catch {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, done: originalDone ?? t.done } : t))
      );
      signalPiloState("failure", { source: "tasks:toggle", duration: 4_200 });
    }
  }, [authStatus]);

  return (
    <Ctx.Provider value={{ tasks, isLoading, error, addTask, updateTask, deleteTask, toggleTask, refresh: loadTasks }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTasks() {
  return useContext(Ctx);
}
