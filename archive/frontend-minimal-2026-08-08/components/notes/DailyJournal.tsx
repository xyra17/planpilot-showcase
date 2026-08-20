"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronLeft, ChevronRight, Trash2, Pencil, Paperclip, X,
  Target, ListChecks, Clock3, Check, LoaderCircle, AlertTriangle,
  CalendarRange, FileText, Activity,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { api } from "@/lib/api";
import TiptapEditor from "./TiptapEditor";
import type { KnowledgeNote } from "@/lib/knowledge-context";
import { useGoalStore } from "@/lib/stores/goalStore";
import { useToast } from "@/components/ui/Toast";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";

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

function relativeTime(iso: string, now: number) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
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
    <div className="study-month-calendar">
      <div className="study-calendar-header flex items-center justify-between mb-2">
        <button type="button" aria-label="上个月" onClick={() => shiftMonth(-1)} className="study-calendar-nav p-0.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-500"><ChevronLeft size={13} /></button>
        <span className="study-calendar-label text-sm font-medium text-gray-500">{monthLabel}</span>
        <button type="button" aria-label="下个月" onClick={() => shiftMonth(1)} className="study-calendar-nav p-0.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-500"><ChevronRight size={13} /></button>
      </div>
      <div className="grid grid-cols-7 mb-1">
        {WEEK_LABELS.map((w) => (
          <div key={w} className="study-calendar-weekday text-center text-[10px] text-gray-300 font-medium py-0.5">{w}</div>
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
              type="button"
              data-selected={isSelected || undefined}
              data-today={isToday || undefined}
              aria-current={isToday ? "date" : undefined}
              aria-pressed={isSelected}
              onClick={() => onSelect(ds)}
              className={`study-calendar-day w-full aspect-square flex items-center justify-center text-[12px] rounded-full transition
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

function FileAttachmentZone({ attachmentIds, pendingFiles, onAddFiles, onRemovePending, onRemoveSaved }: {
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
            className="hover:text-accent"
          >
            附件
          </button>
          <button onClick={() => onRemoveSaved(id)} className="ml-1 text-gray-400 hover:text-red-500"><X size={10} /></button>
        </div>
      ))}
      {pendingFiles.map((f, idx) => (
        <div key={idx} className="pending-attachment flex items-center gap-1 px-2 py-1 rounded-lg bg-accent-light border border-accent-muted text-xs text-accent-dark">
          <Paperclip size={11} />
          <span className="max-w-[120px] truncate">{f.name}</span>
          <button onClick={() => onRemovePending(idx)} className="ml-1 text-accent-muted hover:text-red-500"><X size={10} /></button>
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

export default function DailyJournal({
  createSignal = 0,
  onCreateHandled,
  onEditingChange,
  initialGoalId,
}: {
  createSignal?: number;
  onCreateHandled?: () => void;
  onEditingChange?: (editing: boolean) => void;
  initialGoalId?: string;
}) {
  const { showToast } = useToast();
  const { confirmAction } = useConfirmDialog();
  const reduceMotion = useReducedMotion();
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
  const [discardOpen, setDiscardOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const pendingExitRef = useRef<null | (() => void | Promise<void>)>(null);

  const { goals, fetchGoals } = useGoalStore();

  useEffect(() => {
    if (window.matchMedia("(max-width: 768px)").matches) setSidebarOpen(false);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchGoals(); }, []);

  const activeGoals = goals.filter((g) => g.status === "active");
  const hasUnsavedChanges = saveStatus === "dirty" || saveStatus === "error";

  useEffect(() => {
    onEditingChange?.(editing !== null);
  }, [editing, onEditingChange]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedChanges]);

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
      setNotes(
        data
          .filter((note) => !initialGoalId || note.goalId === initialGoalId)
          .map((n) => ({ ...n, attachmentIds: n.attachmentIds ?? [] }))
      );
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [initialGoalId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadNotes(selectedDate); }, [selectedDate]);

  const runOrConfirmDiscard = (action: () => void | Promise<void>) => {
    if (!hasUnsavedChanges) {
      void action();
      return;
    }
    pendingExitRef.current = action;
    setDiscardOpen(true);
  };

  const performSelectDate = async (date: string) => {
    if (isNewDraft && editing) {
      await api.del(`/api/v1/knowledge/${editing.id}`).catch(() => {});
    }
    setSelectedDate(date);
    setEditing(null);
    setIsNewDraft(false);
  };

  const handleSelectDate = (date: string) => {
    if (date === selectedDate) return;
    runOrConfirmDiscard(() => performSelectDate(date));
  };

  const startNew = async () => {
    setDraftTitle("");
    setDraftContent("");
    setDraftGoalId(initialGoalId ?? null);
    setDraftTaskId(null);
    setPendingFiles([]);
    const draft = await api.post<StudyNote>("/api/v1/knowledge/notes", {
      content: "",
      noteType: "daily_log",
      noteDate: selectedDate,
      goalId: initialGoalId ?? null,
    });
    setSaveStatus("saved");
    setIsNewDraft(true);
    setEditing({ ...draft, attachmentIds: [] });
  };

  useEffect(() => {
    if (createSignal <= 0) return;
    if (!editing) void startNew().finally(onCreateHandled);
    else onCreateHandled?.();
    // createSignal is an explicit command from the notes center.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal]);

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

  const performCancel = async () => {
    if (isNewDraft && editing) {
      await api.del(`/api/v1/knowledge/${editing.id}`).catch(() => {});
    }
    setEditing(null);
    setIsNewDraft(false);
  };

  const handleCancel = () => runOrConfirmDiscard(performCancel);

  const confirmDiscard = async () => {
    const action = pendingExitRef.current;
    pendingExitRef.current = null;
    setDiscardOpen(false);
    setSaveStatus("saved");
    if (action) await action();
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
      showToast("学习笔记保存失败，请重试", "error");
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await confirmAction({
      title: "删除学习笔记",
      description: "删除后无法恢复，确定继续吗？",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await api.del(`/api/v1/knowledge/${id}`);
      setNotes((prev) => prev.filter((n) => n.id !== id));
      showToast("学习笔记已删除", "success");
    } catch {
      showToast("删除失败，请稍后重试", "error");
    }
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
    <motion.div layout className="notes-workspace" transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}>
      {/* 左侧侧栏 */}
      <motion.aside
        layout
        className={`notes-date-rail ${sidebarOpen ? "is-open" : "is-closed"}`}
        transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <AnimatePresence initial={false} mode="wait">
        {sidebarOpen ? (
          <motion.div
            key="date-navigation"
            className="notes-date-stack"
            initial={reduceMotion ? false : { opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, x: -8 }}
            transition={{ duration: reduceMotion ? 0 : 0.16 }}
          >
            <div className="journal-date-panel relative select-none">
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                title="收起日期导航"
                aria-label="收起日期导航"
                className="notes-icon-button absolute right-2 top-2"
              >
                <ChevronLeft size={14} />
              </button>
              <div className="notes-panel-label"><CalendarRange size={12} /> SELECTED DATE</div>
              <p className="notes-date-weekday">
                {new Date(selectedDate + "T00:00:00").toLocaleDateString("zh-CN", { weekday: "long" })}
              </p>
              <p className="notes-date-value">
                {new Date(selectedDate + "T00:00:00").toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}
              </p>
              <p className="notes-date-year">
                {new Date(selectedDate + "T00:00:00").getFullYear()}
              </p>
            </div>
            <div className="journal-nav-panel">
              <div className="notes-calendar-tabs">
                {(["week", "month"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setNavTab(t)}
                    className={navTab === t ? "is-active" : undefined}
                    aria-pressed={navTab === t}
                  >
                    {t === "week" ? "周历" : "月历"}
                  </button>
                ))}
              </div>
              {navTab === "week" && (
                <>
                  <div className="notes-week-heading">
                    <button type="button" aria-label="上一周" onClick={() => shiftWeek(-1)} className="notes-icon-button"><ChevronLeft size={13} /></button>
                    <span>
                      {weekDays[0].toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}–{weekDays[6].toLocaleDateString("zh-CN", { day: "numeric" })}
                    </span>
                    <button type="button" aria-label="下一周" onClick={() => shiftWeek(1)} className="notes-icon-button"><ChevronRight size={13} /></button>
                  </div>
                  <div className="notes-week-list">
                    {weekDays.map((d) => {
                      const ds = toDateStr(d);
                      const isToday = ds === today;
                      const isSelected = ds === selectedDate;
                      return (
                        <button
                          key={ds}
                          type="button"
                          onClick={() => handleSelectDate(ds)}
                          aria-pressed={isSelected}
                          data-today={isToday || undefined}
                          data-selected={isSelected || undefined}
                          className="notes-week-day"
                        >
                          <span className="notes-weekday-name">
                            {d.toLocaleDateString("zh-CN", { weekday: "short" })}
                          </span>
                          <span className="notes-weekday-date">
                            {d.getMonth() + 1}月{d.getDate()}日
                          </span>
                          {isToday ? (
                            <span
                              className="notes-today-badge"
                            >
                              今天
                            </span>
                          ) : (
                            <span className="notes-selection-dot" />
                          )}
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
          </motion.div>
        ) : (
          <motion.button
            key="date-navigation-toggle"
            type="button"
            onClick={() => setSidebarOpen(true)}
            title="展开日期导航"
            aria-label="展开日期导航"
            className="notes-date-toggle"
            initial={reduceMotion ? false : { opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, x: -6 }}
          >
            <ChevronRight size={14} />
          </motion.button>
        )}
        </AnimatePresence>
      </motion.aside>

      {/* 主区域 */}
      <motion.section layout className="notes-content-panel" transition={{ duration: reduceMotion ? 0 : 0.22 }}>
        <AnimatePresence initial={false} mode="wait">
        {editing === null ? (
          <motion.div
            key="notes-list"
            className="notes-list-view"
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
          >
            <div className="notes-list-toolbar">
              <div>
                <span className="notes-panel-label"><Activity size={12} /> DAILY TRACE</span>
                <h2>{new Date(selectedDate + "T00:00:00").toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}的学习记录</h2>
              </div>
              <span className="notes-count-badge">{notes.length} 篇</span>
            </div>
            {loading ? (
              <div className="notes-loading-grid" aria-label="正在加载学习笔记"><span /><span /><span /></div>
            ) : notes.length === 0 ? (
              <div className="notes-empty-state">
                <span><FileText size={20} /></span>
                <h3>这一天还没有学习记录</h3>
                <p>点击页面右上角的“新建笔记”，把思考连接到正在推进的目标。</p>
              </div>
            ) : (
              <motion.div layout className="notes-card-list">
                <AnimatePresence initial={false}>
                {notes.map((note, index) => (
                  <motion.article
                    layout
                    key={note.id}
                    className="notes-tech-card"
                    initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, scale: 0.98 }}
                    transition={{ duration: reduceMotion ? 0 : 0.2, delay: reduceMotion ? 0 : Math.min(index * 0.035, 0.14) }}
                  >
                    <div className="notes-card-topline">
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
                      <div className="notes-card-actions">
                        <button type="button" aria-label={`编辑 ${noteDisplayTitle(note)}`} onClick={() => startEdit(note)}>
                          <Pencil size={13} />
                        </button>
                        <button type="button" aria-label={`删除 ${noteDisplayTitle(note)}`} data-tone="danger" onClick={() => handleDelete(note.id)}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    <button type="button" className="notes-card-body" onClick={() => startEdit(note)}>
                    <h3>
                      {noteDisplayTitle(note)}
                    </h3>
                    <p>
                      {stripHtml(note.content).slice(0, 160) || "开始记录你的学习过程…"}
                    </p>
                    </button>
                    <div className="notes-card-meta">
                      {note.attachmentIds.length > 0 ? (
                        <span className="flex items-center gap-1"><Paperclip size={11} />{note.attachmentIds.length} 个附件</span>
                      ) : <span />}
                      <span
                        className="flex items-center gap-1"
                        title={new Date(note.updatedAt || note.savedAt).toLocaleString("zh-CN")}
                      >
                        <Clock3 size={11} />编辑于 {relativeTime(note.updatedAt || note.savedAt, clock)}
                      </span>
                    </div>
                  </motion.article>
                ))}
                </AnimatePresence>
              </motion.div>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="notes-editor"
            className="notes-editor-view"
            initial={reduceMotion ? false : { opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, x: 10 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
          >
            <div className="notes-editor-context">
              <div className="flex items-center gap-2 min-w-0">
                <button type="button" aria-label="返回笔记列表" onClick={handleCancel} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-700 transition">
                  <ChevronLeft size={14} />返回
                </button>
                <span className="text-sm text-gray-300">/</span>
                <span className="text-sm text-gray-500 whitespace-nowrap">{isNewDraft ? "新建学习笔记" : "编辑"}</span>
              </div>
              <div className="flex items-center justify-end gap-2 min-w-0">
                <Target size={13} className="text-gray-400 flex-shrink-0" />
                <span className="text-xs text-gray-400 shrink-0">目标</span>
                {activeGoals.length > 0 ? (
                  <select
                    value={draftGoalId ?? ""}
                    onChange={(e) => {
                      setDraftGoalId(e.target.value || null);
                      setDraftTaskId(null);
                      setSaveStatus("dirty");
                    }}
                    className="max-w-[220px] text-xs text-gray-700 border border-gray-100 rounded-lg px-2 py-1.5 focus:outline-none bg-white"
                  >
                    <option value="">不关联目标</option>
                    {activeGoals.map((g) => (
                      <option key={g.id} value={g.id}>{g.title}</option>
                    ))}
                  </select>
                ) : <span className="text-xs text-gray-400 whitespace-nowrap">暂无进行中的目标</span>}
                {draftGoalId && (
                  <>
                    <span className="mx-1 h-4 w-px bg-gray-200 flex-shrink-0" />
                    <ListChecks size={13} className="text-gray-400 flex-shrink-0" />
                    <span className="text-xs text-gray-400 shrink-0">任务</span>
                    <select
                      value={draftTaskId ?? ""}
                      onChange={(e) => {
                        setDraftTaskId(e.target.value || null);
                        setSaveStatus("dirty");
                      }}
                      className="max-w-[280px] text-xs text-gray-700 border border-gray-100 rounded-lg px-2 py-1.5 focus:outline-none bg-white"
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
            </div>
            <input
              aria-label="笔记标题"
              value={draftTitle}
              onChange={(e) => { setDraftTitle(e.target.value); setSaveStatus("dirty"); }}
              placeholder="无标题"
              className="note-title-input"
            />
            <TiptapEditor
              key={editing?.id ?? "new"}
              content={draftContent}
              onChange={(html) => { setDraftContent(html); setSaveStatus("dirty"); }}
              placeholder="记录今天的学习心得…"
              className="notes-editor-shell"
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
            <div className="notes-editor-footer">
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
                <button type="button" aria-label="取消修改" onClick={handleCancel} className="px-4 py-1.5 rounded-lg text-sm text-gray-500 border border-gray-200 hover:bg-gray-50 transition">
                  取消
                </button>
                <button
                  type="button"
                  aria-label="保存笔记"
                  onClick={handleSave}
                  disabled={saveStatus === "saving"}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium text-white transition disabled:opacity-50"
                  style={{ background: "var(--accent)" }}
                >
                  保存
                </button>
              </div>
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </motion.section>

      <AnimatePresence>
      {discardOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/40 px-4 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="discard-note-title"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.16 }}
        >
          <motion.div
            className="w-full max-w-sm rounded-2xl border border-gray-100 bg-white p-5 shadow-2xl"
            initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-500">
                <AlertTriangle size={17} />
              </div>
              <div>
                <h2 id="discard-note-title" className="text-base font-semibold text-gray-900">
                  当前内容尚未保存
                </h2>
                <p className="mt-1 text-sm leading-6 text-gray-500">
                  返回后，本次修改将不会保留。你可以继续编辑，或者确认放弃修改。
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  pendingExitRef.current = null;
                  setDiscardOpen(false);
                }}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
              >
                继续编辑
              </button>
              <button
                type="button"
                onClick={confirmDiscard}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600"
              >
                放弃修改
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>
    </motion.div>
  );
}
