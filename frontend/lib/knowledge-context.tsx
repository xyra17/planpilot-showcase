"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { api } from "@/lib/api";

export type KnowledgeNote = {
  id: string;
  goalId: string;
  goalTitle: string;
  taskId: string | null;
  title: string;
  content: string;
  noteType: string;
  date: string;
  savedAt: string;
};

export type CreateNotePayload = {
  goalId?: string | null;
  taskId?: string | null;
  title?: string | null;
  content: string;
  noteType?: string;
};

interface KnowledgeCtx {
  notes: KnowledgeNote[];
  addNote: (n: CreateNotePayload) => Promise<KnowledgeNote | null>;
  deleteNote: (id: string) => Promise<void>;
  updateNote: (id: string, patch: { title?: string; content?: string }) => Promise<void>;
}

const Ctx = createContext<KnowledgeCtx>({
  notes: [],
  addNote: async () => null,
  deleteNote: async () => {},
  updateNote: async () => {},
});

export function KnowledgeProvider({ children }: { children: React.ReactNode }) {
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);

  useEffect(() => {
    api.get<KnowledgeNote[]>("/api/v1/knowledge/notes")
      .then(setNotes)
      .catch(() => {});
  }, []);

  const addNote = useCallback(async (n: CreateNotePayload): Promise<KnowledgeNote | null> => {
    try {
      const created = await api.post<KnowledgeNote>("/api/v1/knowledge/notes", {
        goalId: n.goalId ?? null,
        taskId: n.taskId ?? null,
        title: n.title ?? null,
        content: n.content,
        noteType: n.noteType ?? "flash_card",
      });
      setNotes((prev) => [created, ...prev]);
      return created;
    } catch {
      return null;
    }
  }, []);

  const deleteNote = useCallback(async (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    try {
      await api.del(`/api/v1/knowledge/${id}`);
    } catch {
      // rollback: re-fetch to restore state
      api.get<KnowledgeNote[]>("/api/v1/knowledge/notes")
        .then(setNotes)
        .catch(() => {});
    }
  }, []);

  const updateNote = useCallback(async (id: string, patch: { title?: string; content?: string }) => {
    setNotes((prev) => prev.map((n) => n.id === id ? { ...n, ...patch } : n));
    try {
      await api.patch(`/api/v1/knowledge/notes/${id}`, patch);
    } catch {
      api.get<KnowledgeNote[]>("/api/v1/knowledge/notes").then(setNotes).catch(() => {});
    }
  }, []);

  return (
    <Ctx.Provider value={{ notes, addNote, deleteNote, updateNote }}>
      {children}
    </Ctx.Provider>
  );
}

export function useKnowledge() {
  return useContext(Ctx);
}
