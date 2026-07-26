"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MoreHorizontal,
  Pencil, Plus, Search, Trash2, X,
} from "lucide-react";
import { api } from "@/lib/api";
import type { KnowledgeNote } from "@/lib/knowledge-context";
import { useGoalStore } from "@/lib/stores/goalStore";
import TiptapEditor from "./TiptapEditor";

type EditableNoteType = "daily_log" | "flash_card";
type NoteWithAttachments = KnowledgeNote & { attachmentIds?: string[] };

function stripHtml(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function displayTitle(note: KnowledgeNote) {
  const title = stripHtml(note.title || "");
  return title || stripHtml(note.content).slice(0, 48) || "无标题";
}

function relativeTime(iso: string) {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export default function NotesLibrary({
  createSignal = 0,
  onCreateHandled,
}: {
  createSignal?: number;
  onCreateHandled?: () => void;
}) {
  const [notes, setNotes] = useState<NoteWithAttachments[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<NoteWithAttachments | null>(null);
  const [isNewDraft, setIsNewDraft] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [goalId, setGoalId] = useState("");
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [saving, setSaving] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const { goals, fetchGoals } = useGoalStore();
  const currentSnapshot = JSON.stringify({ title, content, goalId });
  const hasUnsavedChanges = Boolean(editing) && currentSnapshot !== savedSnapshot;

  useEffect(() => { fetchGoals(); }, [fetchGoals]);

  const load = useCallback(async () => {
    const data = await api.get<NoteWithAttachments[]>("/api/v1/knowledge/notes").catch(() => []);
    setNotes(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  const visibleNotes = useMemo(() => {
    // 用户笔记独立于知识库；AI 对话摘录只在知识库中展示。
    const allowed = new Set(["flash_card", "quick_note", "task_note"]);
    const normalized = query.trim().toLowerCase();
    return notes.filter((note) => {
      if (!allowed.has(note.noteType)) return false;
      if (!normalized) return true;
      return `${note.title} ${stripHtml(note.content)} ${note.goalTitle}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [notes, query]);

  const openNew = useCallback(async () => {
    const draft = await api.post<NoteWithAttachments>("/api/v1/knowledge/notes", {
      title: "",
      content: "",
      noteType: "flash_card",
    }).catch(() => null);
    if (!draft) return;
    setTitle("");
    setContent("");
    setGoalId("");
    setSavedSnapshot(JSON.stringify({ title: "", content: "", goalId: "" }));
    setIsNewDraft(true);
    setEditing(draft);
  }, []);

  useEffect(() => {
    if (createSignal <= 0) return;
    void openNew().finally(onCreateHandled);
  }, [createSignal, onCreateHandled, openNew]);

  const openEdit = (note: NoteWithAttachments) => {
    setEditing(note);
    setTitle(note.title || "");
    setContent(note.content);
    setGoalId(note.goalId || "");
    setSavedSnapshot(JSON.stringify({
      title: note.title || "",
      content: note.content,
      goalId: note.goalId || "",
    }));
    setIsNewDraft(false);
  };

  const closeEditor = async () => {
    if (hasUnsavedChanges && !window.confirm("当前有未保存的内容，确定要离开吗？")) {
      return;
    }
    if (isNewDraft && editing) {
      await api.del(`/api/v1/knowledge/${editing.id}`).catch(() => {});
    }
    setEditing(null);
    setIsNewDraft(false);
  };

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedChanges]);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const updated = await api.patch<NoteWithAttachments>(
        `/api/v1/knowledge/notes/${editing.id}`,
        { title, content, goalId }
      );
      setNotes((current) => {
        const exists = current.some((note) => note.id === updated.id);
        return exists
          ? current.map((note) => note.id === updated.id ? updated : note)
          : [updated, ...current];
      });
      setEditing(null);
      setIsNewDraft(false);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setNotes((current) => current.filter((note) => note.id !== id));
    await api.del(`/api/v1/knowledge/${id}`).catch(load);
  };

  const convert = async (note: NoteWithAttachments, noteType: EditableNoteType) => {
    const today = new Date();
    const noteDate = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-");
    const updated = await api.patch<NoteWithAttachments>(
      `/api/v1/knowledge/notes/${note.id}`,
      { noteType, ...(noteType === "daily_log" ? { noteDate } : {}) }
    ).catch(() => null);
    if (updated) {
      setNotes((current) => current.map((item) => item.id === note.id ? updated : item));
    }
    setMenuId(null);
  };

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            学习日志
          </h2>
          <p className="mt-0.5 text-xs text-gray-400">
            沉淀可以长期复用的概念、方法与经验
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索日志…"
              className="w-60 rounded-xl border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-gray-300"
            />
          </div>
          <button
            onClick={openNew}
            className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
            style={{ background: "var(--accent)" }}
          >
            <Plus size={14} />新建日志
          </button>
        </div>
      </div>

      {visibleNotes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 text-gray-400">
          <p className="text-sm">{query ? "没有匹配的笔记" : "这里还没有内容"}</p>
          {!query && (
            <button
              onClick={openNew}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"
              style={{ background: "var(--accent-light)", color: "var(--accent)" }}
            >
              <Plus size={12} />创建第一篇
            </button>
          )}
        </div>
      ) : (
        <div className="grid flex-1 min-h-0 grid-cols-1 content-start gap-3 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
          {visibleNotes.map((note) => {
            const canConvert = !["chat_note", "task_note"].includes(note.noteType);
            return (
              <article
                key={note.id}
                className="group relative rounded-2xl border border-gray-100 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-md"
              >
                <div className="mb-3 flex items-center justify-end">
                  <div className="relative flex items-center gap-1">
                    <button
                      onClick={() => openEdit(note)}
                      className="rounded-lg p-1.5 text-gray-300 transition hover:bg-gray-100 hover:text-gray-600"
                      aria-label="编辑笔记"
                    >
                      <Pencil size={13} />
                    </button>
                    {canConvert && (
                      <button
                        onClick={() => setMenuId(menuId === note.id ? null : note.id)}
                        className="rounded-lg p-1.5 text-gray-300 transition hover:bg-gray-100 hover:text-gray-600"
                        aria-label="更多操作"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => remove(note.id)}
                      className="rounded-lg p-1.5 text-gray-300 transition hover:bg-red-50 hover:text-red-500"
                      aria-label="删除笔记"
                    >
                      <Trash2 size={13} />
                    </button>
                    {menuId === note.id && (
                      <div className="absolute right-0 top-8 z-20 w-36 overflow-hidden rounded-xl border border-gray-100 bg-white p-1 shadow-xl">
                        <p className="px-2 py-1 text-[10px] font-medium text-gray-400">转换为</p>
                        {([
                          ["daily_log", "学习笔记"],
                          ["flash_card", "学习日志"],
                        ] as Array<[EditableNoteType, string]>).map(([type, label]) => (
                          <button
                            key={type}
                            onClick={() => convert(note, type)}
                            disabled={note.noteType === type}
                            className="block w-full rounded-lg px-2 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 disabled:text-gray-300"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <button onClick={() => openEdit(note)} className="block w-full text-left">
                  <h3 className="truncate text-[15px] font-semibold text-gray-800">{displayTitle(note)}</h3>
                  <p className="mt-2 line-clamp-4 min-h-[72px] text-sm leading-6 text-gray-500">
                    {stripHtml(note.content) || "暂无正文"}
                  </p>
                </button>
                <div className="mt-4 flex items-center justify-between gap-2 border-t border-gray-50 pt-3 text-[11px] text-gray-400">
                  <span className="truncate">{note.goalTitle || "未关联目标"}</span>
                  <span className="flex-shrink-0">{relativeTime(note.updatedAt || note.savedAt)}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/25 p-4 backdrop-blur-[1px]">
          <div role="dialog" aria-modal="true" aria-label={isNewDraft ? "新建学习日志" : "编辑学习日志"} className="flex h-[min(760px,90vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
              <span className="text-sm font-medium text-gray-600">
                {isNewDraft ? "新建学习日志" : "编辑学习日志"}
              </span>
              <button onClick={closeEditor} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
                <X size={15} />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="无标题"
                className="mb-3 border-0 bg-transparent text-xl font-semibold text-gray-900 outline-none placeholder:text-gray-300"
              />
              <div className="mb-3 flex items-center gap-2 text-xs text-gray-400">
                <span>目标</span>
                <select
                  value={goalId}
                  onChange={(event) => setGoalId(event.target.value)}
                  className="rounded-lg border border-gray-100 bg-white px-2 py-1.5 text-xs text-gray-600 outline-none"
                >
                  <option value="">不关联目标</option>
                  {goals.filter((goal) => goal.status === "active").map((goal) => (
                    <option key={goal.id} value={goal.id}>{goal.title}</option>
                  ))}
                </select>
              </div>
              <TiptapEditor
                content={content}
                onChange={setContent}
                noteId={editing.id}
                goalId={goalId || undefined}
                className="min-h-0 flex-1"
                placeholder="开始记录… 输入 / 插入区块或使用 AI"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
              <button onClick={closeEditor} className="rounded-lg px-4 py-2 text-sm text-gray-500 hover:bg-gray-50">取消</button>
              <button
                onClick={save}
                disabled={saving}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--accent)" }}
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
