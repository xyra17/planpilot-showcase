"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ChevronLeft, ChevronRight, Plus, Trash2, Pencil, Paperclip, X,
  Target, ListChecks, Clock3, Check, LoaderCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import TiptapEditor from "./TiptapEditor";
import type { KnowledgeNote } from "@/lib/knowledge-context";
import { useGoalStore } from "@/lib/stores/goalStore";

const WEEK_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function getWeekDays(anchor: Date): Date[] {
  const days: Date[] = [];
  for (let i = -3; i <= 3; i++) {
    const d = new Date(anchor);
    d.setDate(anchor.getDate() + i);
    days.push(d);
  }
  return days;
}

function getMonthGrid(year: number, month: number): (Date | null)[] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const cells: (Date | null)[] = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(null);
  for (let d = 1; d <= last.getDate(); d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function toDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function stripHtml(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

type StudyNote = KnowledgeNote & { attachmentIds: string[] };
type TaskBrief = { id: string; title: string; date: string; status: string };

function noteDisplayTitle(note: StudyNote) {
  const explicitTitle = stripHtml(note.title || "");
  if (explicitTitle && explicitTitle !== "草稿") return explicitTitle;
  return stripHtml(note.content).slice(0, 52) || "无标题";
}

function relativeTime(iso: string) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", {
    year: "numeric", month: "short", day: "numeric",
  });
}

function MonthCalendar({ today, selectedDate, onSelect }: {
  today: string;
  selectedDate: string;
  onSelect: (d: string) => void;
}) {
  const sel = new Date(selectedDate + "T00:00:00");
  const [anchor, setAnchor] = useState({ year: sel.getFullYear(), month: sel.getMonth() });
  const shiftMonth = (delta: number) =>
    setAnchor(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  const grid = getMonthGrid(anchor.year, anchor.month);
  const monthLabel = new Date(anchor.year, anchor.month, 1)
    .toLocaleDateString("zh-CN", { year: "numeric", month: "long" });

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => shiftMonth(-1)} className="p-0.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-500"><ChevronLeft size={13} /></button>
        <span className="text-sm font-medium text-gray-500">{monthLabel}</span>
        <button onClick={() => shiftMonth(1)} className="p-0.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-500"><ChevronRight size={13} /></button>
      </div>
      <div className="grid grid-cols-7 mb-1">
        {WEEK_LABELS.map((w) => (
          <div key={w} className="text-center text-[10px] text-gray-300 font-medium py-0.5">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {grid.map((d, i) => {
          if (!d) return <div key={i} />;
          const ds = toDateStr(d);
          const isToday = ds === today;
          const isSelected = ds === selectedDate;
          return (
            <button
              key={ds}
              onClick={() => onSelect(ds)}
              className={`w-full aspect-square flex items-center justify-center text-[12px] rounded-full transition
                ${isSelected ? "text-white font-bold" : isToday ? "font-semibold" : "text-gray-500 hover:bg-gray-50"}`}
              style={isSelected ? { background: "var(--accent)" } : isToday ? { color: "var(--accent)" } : undefined}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FileAttachmentZone({ noteId, attachmentIds, pendingFiles, onAddFiles, onRemovePending, onRemoveSaved }: {
  noteId: string | null;
  attachmentIds: string[];
  pendingFiles: File[];
  onAddFiles: (files: File[]) => void;
  onRemovePending: (idx: number) => void;
  onRemoveSaved: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {attachmentIds.map((id) => (
        <div key={id} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-600">
          <Paperclip size={11} className="text-gray-400" />
          <button
            type="button"
            onClick={() => api.openFile(`/api/v1/knowledge/files/${id}/serve`).catch(() => {})}
            className="hover:text-blue-600"
          >
            附件
          </button>
          <button onClick={() => onRemoveSaved(id)} className="ml-1 text-gray-400 hover:text-red-500"><X size={10} /></button>
        </div>
      ))}
      {pendingFiles.map((f, idx) => (
        <div key={idx} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-700">
          <Paperclip size={11} />
          <span className="max-w-[120px] truncate">{f.name}</span>
          <button onClick={() => onRemovePending(idx)} className="ml-1 text-blue-400 hover:text-red-500"><X size={10} /></button>
        </div>
      ))}
      <label className="flex items-center gap-1 px-2 py-1 rounded-lg border border-dashed border-gray-300 text-xs text-gray-400 hover:border-gray-400 hover:text-gray-600 cursor-pointer transition">
        <Paperclip size={11} />
        添加附件
        <input
          type="file"
          className="hidden"
          accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.gif,.webp"
          multiple
          onChange={(e) => { if (e.target.files) onAddFiles(Array.from(e.target.files)); }}
        />
      </label>
    </div>
  );
}

export default function DailyJournal() {
  const todayDate = new Date();
  const today = toDateStr(todayDate);
  const [selectedDate, setSelectedDate] = useState(today);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navTab, setNavTab] = useState<"week" | "month">("week");
  const [weekAnchor, setWeekAnchor] = useState(new Date(today + "T00:00:00"));
  const [notes, setNotes] = useState<StudyNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<StudyNote | null>(null);
  const [isNewDraft, setIsNewDraft] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftGoalId, setDraftGoalId] = useState<string | null>(null);
  const [draftTaskId, setDraftTaskId] = useState<string | null>(null);
  const [goalTasks, setGoalTasks] = useState<TaskBrief[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [saveStatus, setSaveStatus] = useState<"saved" | "dirty" | "saving" | "error">("saved");

  const { goals, fetchGoals } = useGoalStore();

  useEffect(() => { fetchGoals(); }, []);

  const activeGoals = goals.filter((g) => g.status === "active");

  useEffect(() => {
    if (!draftGoalId) {
      setGoalTasks([]);
      setDraftTaskId(null);
      return;
    }
    api.get<TaskBrief[]>(`/api/v1/goals/${draftGoalId}/tasks`)
      .then((tasks) => {
        setGoalTasks(tasks);
        setDraftTaskId((current) =>
          current && tasks.some((task) => task.id === current) ? current : null
        );
      })
      .catch(() => {
        setGoalTasks([]);
        setDraftTaskId(null);
      });
  }, [draftGoalId]);

  const shiftWeek = (delta: number) =>
    setWeekAnchor((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() + delta * 7);
      return d;
    });

  const loadNotes = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const data = await api.get<StudyNote[]>(
        `/api/v1/knowledge/notes?note_type=daily_log&date=${date}`
      );
      setNotes(data.map((n) => ({ ...n, attachmentIds: n.attachmentIds ?? [] })));
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadNotes(selectedDate); }, [selectedDate]);

  const handleSelectDate = (date: string) => {
    setSelectedDate(date);
    setEditing(null);
    setIsNewDraft(false);
  };

  const startNew = async () => {
    setDraftTitle("");
    setDraftContent("");
    setDraftGoalId(null);
    setDraftTaskId(null);
    setPendingFiles([]);
    const draft = await api.post<StudyNote>("/api/v1/knowledge/notes", {
      content: "",
      noteType: "daily_log",
      noteDate: selectedDate,
    });
    setSaveStatus("saved");
    setIsNewDraft(true);
    setEditing({ ...draft, attachmentIds: [] });
  };

  const startEdit = (note: StudyNote) => {
    setDraftTitle(note.title ?? "");
    setDraftContent(note.content);
    setDraftGoalId(note.goalId ?? null);
    setDraftTaskId(note.taskId ?? null);
    setPendingFiles([]);
    setIsNewDraft(false);
    setEditing(note);
    setSaveStatus("saved");
  };

  const handleCancel = async () => {
    if (isNewDraft && editing) {
      await api.del(`/api/v1/knowledge/${editing.id}`).catch(() => {});
    }
    setEditing(null);
    setIsNewDraft(false);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaveStatus("saving");
    try {
      const updated = await api.patch<StudyNote>(
        `/api/v1/knowledge/notes/${editing.id}`,
        {
          content: draftContent,
          title: draftTitle,
          goalId: draftGoalId ?? "",
          taskId: draftTaskId ?? "",
        }
      );
      const note: StudyNote = { ...updated, attachmentIds: editing.attachmentIds };
      for (const file of pendingFiles) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("note_id", note.id);
        if (draftGoalId) fd.append("goal_ids", draftGoalId);
        await api.upload("/api/v1/knowledge/upload", fd).catch(() => {});
      }
      await loadNotes(selectedDate);
      setEditing(null);
      setIsNewDraft(false);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  };

  const handleDelete = async (id: string) => {
    await api.del(`/api/v1/knowledge/${id}`).catch(() => {});
    setNotes((prev) => prev.filter((n) => n.id !== id));
  };

  const handleRemoveSaved = async (noteId: string, attId: string) => {
    await api.del(`/api/v1/knowledge/${attId}`).catch(() => {});
    setNotes((prev) =>
      prev.map((n) =>
        n.id === noteId ? { ...n, attachmentIds: n.attachmentIds.filter((id) => id !== attId) } : n
      )
    );
  };

  const weekDays = getWeekDays(weekAnchor);
  const currentNoteId = editing?.id;

  return (
    <div className="flex gap-3 h-full">
      {/* 左侧侧栏 */}
      <div className={`flex-shrink-0 transition-all duration-200 ${sidebarOpen ? "w-[216px]" : "w-8"}`}>
        {sidebarOpen ? (
          <div className="flex flex-col gap-3">
            <div className="select-none bg-white border border-gray-100 rounded-xl p-3 relative">
              <button onClick={() => setSidebarOpen(false)} className="absolute top-2 right-2 p-0.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-500">
                <ChevronLeft size={14} />
              </button>
              <p className="text-xs font-medium text-gray-400 tracking-widest uppercase mb-1">
                {new Date(selectedDate + "T00:00:00").toLocaleDateString("zh-CN", { weekday: "long" })}
              </p>
              <p className="text-4xl font-bold text-gray-800 leading-none tracking-tight">
                {new Date(selectedDate + "T00:00:00").toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}
              </p>
              <p className="text-sm text-gray-400 mt-1.5">
                {new Date(selectedDate + "T00:00:00").getFullYear()}
              </p>
            </div>
            <div className="bg-white border border-gray-100 rounded-xl p-3 h-fit">
              <div className="flex gap-1 mb-3 border-b border-gray-100 pb-2">
                {(["week", "month"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setNavTab(t)}
                    className="px-2.5 py-0.5 rounded-md text-sm font-medium transition"
                    style={navTab === t ? { background: "var(--accent-light)", color: "var(--accent)" } : { color: "#9ca3af" }}
                  >
                    {t === "week" ? "周期" : "月历"}
                  </button>
                ))}
              </div>
              {navTab === "week" && (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <button onClick={() => shiftWeek(-1)} className="p-1 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-gray-500"><ChevronLeft size={13} /></button>
                    <span className="text-sm font-semibold text-gray-600">
                      {weekDays[0].toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}–{weekDays[6].toLocaleDateString("zh-CN", { day: "numeric" })}
                    </span>
                    <button onClick={() => shiftWeek(1)} className="p-1 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-gray-500"><ChevronRight size={13} /></button>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {weekDays.map((d) => {
                      const ds = toDateStr(d);
                      const isToday = ds === today;
                      const isSelected = ds === selectedDate;
                      return (
                        <button
                          key={ds}
                          onClick={() => handleSelectDate(ds)}
                          className="w-full flex items-center justify-between px-2 py-1 rounded-xl transition hover:bg-gray-50"
                        >
                          <span className="text-[13px] font-medium" style={{ color: isSelected || isToday ? "var(--accent)" : "#9ca3af" }}>
                            {d.toLocaleDateString("zh-CN", { weekday: "short" })}
                          </span>
                          <span className="text-[13px] tabular-nums" style={{ color: isSelected || isToday ? "var(--accent)" : "#4b5563" }}>
                            {d.getMonth() + 1}月{d.getDate()}日
                          </span>
                          <span className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ background: isSelected ? "var(--accent)" : isToday ? "var(--accent-light)" : "transparent" }} />
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              {navTab === "month" && (
                <MonthCalendar today={today} selectedDate={selectedDate} onSelect={handleSelectDate} />
              )}
            </div>
          </div>
        ) : (
          <button onClick={() => setSidebarOpen(true)} className="w-8 h-full flex items-start pt-3 justify-center text-gray-300 hover:text-gray-500 transition">
            <ChevronRight size={14} />
          </button>
        )}
      </div>

      {/* 主区域 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {editing === null ? (
          <>
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <span className="text-sm font-medium text-gray-500">
                {new Date(selectedDate + "T00:00:00").toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })}
                {notes.length > 0 && <span className="ml-2 text-gray-400">共 {notes.length} 篇</span>}
              </span>
              <button
                onClick={startNew}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white transition"
                style={{ background: "var(--accent)" }}
              >
                <Plus size={14} />新建学习记录
              </button>
            </div>
            {loading ? (
              <div className="flex items-center justify-center h-32 text-gray-400 text-sm">加载中…</div>
            ) : notes.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-gray-300 text-sm gap-1">
                <p>还没有学习记录</p>
                <p>点击右上角「新建学习记录」开始写</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3 overflow-y-auto flex-1">
                {notes.map((note) => (
                  <div key={note.id} className="bg-white border border-gray-100 rounded-xl p-4 hover:border-gray-200 transition">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        {note.goalTitle && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium shrink-0"
                            style={{ background: "var(--accent-light)", color: "var(--accent)" }}>
                            {note.goalTitle}
                          </span>
                        )}
                        {note.taskTitle && (
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${
                            note.taskAvailable ? "bg-gray-100 text-gray-500" : "bg-amber-50 text-amber-600"
                          }`}>
                            <ListChecks size={10} />
                            {note.taskAvailable ? note.taskTitle : `原任务：${note.taskTitle}`}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button onClick={() => startEdit(note)} className="p-1.5 rounded-lg text-gray-300 hover:text-blue-500 hover:bg-blue-50 transition">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => handleDelete(note.id)} className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    <h3 className="text-[15px] font-semibold text-gray-800 truncate mb-1">
                      {noteDisplayTitle(note)}
                    </h3>
                    <p className="text-sm text-gray-500 line-clamp-2 mb-2">
                      {stripHtml(note.content).slice(0, 160) || "开始记录你的学习过程…"}
                    </p>
                    <div className="flex items-center justify-between text-xs text-gray-400">
                      {note.attachmentIds.length > 0 ? (
                        <span className="flex items-center gap-1"><Paperclip size={11} />{note.attachmentIds.length} 个附件</span>
                      ) : <span />}
                      <span
                        className="flex items-center gap-1"
                        title={new Date(note.updatedAt || note.savedAt).toLocaleString("zh-CN")}
                      >
                        <Clock3 size={11} />编辑于 {relativeTime(note.updatedAt || note.savedAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center gap-2 mb-3 flex-shrink-0">
              <button onClick={handleCancel} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-700 transition">
                <ChevronLeft size={14} />返回
              </button>
              <span className="text-sm text-gray-300">/</span>
              <span className="text-sm text-gray-500">{isNewDraft ? "新建学习记录" : "编辑"}</span>
            </div>
            <input
              value={draftTitle}
              onChange={(e) => { setDraftTitle(e.target.value); setSaveStatus("dirty"); }}
              placeholder="无标题"
              className="w-full text-2xl font-bold text-gray-900 border-0 px-1 py-1 mb-2 focus:outline-none placeholder:text-gray-300 flex-shrink-0 bg-transparent"
            />
            <div className="flex items-center gap-2 mb-3 flex-wrap flex-shrink-0 rounded-xl border border-gray-100 bg-gray-50/70 px-3 py-2">
              <Target size={13} className="text-gray-400" />
              <span className="text-xs text-gray-400 shrink-0">目标</span>
              {activeGoals.length > 0 ? (
                <select
                  value={draftGoalId ?? ""}
                  onChange={(e) => {
                    setDraftGoalId(e.target.value || null);
                    setDraftTaskId(null);
                    setSaveStatus("dirty");
                  }}
                  className="max-w-[220px] text-xs text-gray-700 border-0 rounded-lg px-2 py-1 focus:outline-none bg-white shadow-sm"
                >
                  <option value="">不关联目标</option>
                  {activeGoals.map((g) => (
                    <option key={g.id} value={g.id}>{g.title}</option>
                  ))}
                </select>
              ) : <span className="text-xs text-gray-400">暂无进行中的目标</span>}
              {draftGoalId && (
                <>
                  <span className="mx-1 h-4 w-px bg-gray-200" />
                  <ListChecks size={13} className="text-gray-400" />
                  <span className="text-xs text-gray-400 shrink-0">任务</span>
                  <select
                    value={draftTaskId ?? ""}
                    onChange={(e) => {
                      setDraftTaskId(e.target.value || null);
                      setSaveStatus("dirty");
                    }}
                    className="max-w-[280px] text-xs text-gray-700 border-0 rounded-lg px-2 py-1 focus:outline-none bg-white shadow-sm"
                  >
                    <option value="">不关联具体任务</option>
                    {goalTasks.map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}{task.date ? ` · ${task.date}` : ""}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <TiptapEditor
              key={editing?.id ?? "new"}
              content={draftContent}
              onChange={(html) => { setDraftContent(html); setSaveStatus("dirty"); }}
              placeholder="记录今天的学习心得…"
              className="flex-1 border border-gray-100 rounded-xl mb-3 min-h-0"
              noteId={currentNoteId}
              goalId={draftGoalId ?? undefined}
            />
            <FileAttachmentZone
              noteId={currentNoteId ?? null}
              attachmentIds={editing?.attachmentIds ?? []}
              pendingFiles={pendingFiles}
              onAddFiles={(files) => setPendingFiles((prev) => [...prev, ...files])}
              onRemovePending={(idx) => setPendingFiles((prev) => prev.filter((_, i) => i !== idx))}
              onRemoveSaved={(attId) => { if (editing) handleRemoveSaved(editing.id, attId); }}
            />
            <div className="flex items-center justify-between gap-2 mt-3 flex-shrink-0">
              <span className={`inline-flex items-center gap-1.5 text-xs ${
                saveStatus === "error" ? "text-red-500" : "text-gray-400"
              }`}>
                {saveStatus === "saving" && <LoaderCircle size={12} className="animate-spin" />}
                {saveStatus === "saved" && <Check size={12} />}
                {saveStatus === "dirty" && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
                {saveStatus === "saving" ? "保存中…" :
                  saveStatus === "dirty" ? "有未保存的更改" :
                  saveStatus === "error" ? "保存失败，请重试" : "已保存"}
              </span>
              <div className="flex gap-2">
                <button onClick={handleCancel} className="px-4 py-1.5 rounded-lg text-sm text-gray-500 border border-gray-200 hover:bg-gray-50 transition">
                  取消
                </button>
                <button
                  onClick={handleSave}
                  disabled={saveStatus === "saving"}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium text-white transition disabled:opacity-50"
                  style={{ background: "var(--accent)" }}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
