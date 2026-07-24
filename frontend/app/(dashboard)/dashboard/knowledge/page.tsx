"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import {
  Search, Upload, FileText, FileSpreadsheet, Trash2,
  BookOpen, MessageSquare, Target, LayoutGrid, List,
  Plus, X, FolderOpen, Check, ChevronDown, Pencil, Link2,
} from "lucide-react";
import { useGoalStore } from "@/lib/stores/goalStore";
import { useKnowledge } from "@/lib/knowledge-context";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── 类型 ─────────────────────────────────────────────────────
type KnowledgeBase = { id: string; name: string };
type TaskBrief = { id: string; title: string };

type KnowledgeFile = {
  id: string;
  name: string;
  size: string;
  uploadDate: string;
  type: string;
  goalIds: string[];
  kbId: string;
  taskId: string;   // "" = 未关联任务
};

type FilterState = { type: "all" | "kb" | "goal"; id: string };

// ── 初始数据 ──────────────────────────────────────────────────
const INITIAL_KBS: KnowledgeBase[] = [];
const INITIAL_FILES: KnowledgeFile[] = [];

const iconMap: Record<string, React.ReactNode> = {
  pdf:   <FileText        size={16} className="text-red-500"   />,
  excel: <FileSpreadsheet size={16} className="text-green-600" />,
};

function fileExt(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "file";
}

// ── 主页面 ────────────────────────────────────────────────────
export default function KnowledgePage() {
  const { goals, fetchGoals } = useGoalStore();
  const [query,      setQuery]      = useState("");
  const [filter,     setFilter]     = useState<FilterState>({ type: "all", id: "" });
  const [files,      setFiles]      = useState<KnowledgeFile[]>(INITIAL_FILES);
  const [kbs,        setKbs]        = useState<KnowledgeBase[]>(INITIAL_KBS);
  const [filesView,  setFilesView]  = useState<"grid" | "list">("list");

  // 新建知识库
  const [newKbOpen,  setNewKbOpen]  = useState(false);
  const [newKbName,  setNewKbName]  = useState("");

  // 上传弹窗
  const [uploadOpen,     setUploadOpen]     = useState(false);
  const [uploadFile,     setUploadFile]     = useState<File | null>(null);
  const [uploadKbId,     setUploadKbId]     = useState<string>("");
  const [uploadGoalIds,  setUploadGoalIds]  = useState<string[]>([]);
  const [uploadTaskId,   setUploadTaskId]   = useState<string>("");
  const [uploading,      setUploading]      = useState(false);
  const [deletingId,     setDeletingId]     = useState<string | null>(null);
  const [goalTasks,      setGoalTasks]      = useState<TaskBrief[]>([]);
  const [dialogTasks,    setDialogTasks]    = useState<TaskBrief[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // URL 导入状态
  const [urlImportOpen,  setUrlImportOpen]  = useState(false);
  const [urlInput,       setUrlInput]       = useState("");
  const [urlGoalId,      setUrlGoalId]      = useState("");
  const [urlKbId,        setUrlKbId]        = useState("");
  const [urlImporting,   setUrlImporting]   = useState(false);

  const { notes, deleteNote, updateNote } = useKnowledge();
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [refTabNotes, setRefTabNotes] = useState<Set<string>>(new Set());
  const [editingAnswers, setEditingAnswers] = useState<Map<string, string>>(new Map());
  const [savingNotes, setSavingNotes] = useState<Set<string>>(new Set());
  useEffect(() => { fetchGoals(); }, [fetchGoals]);

  useEffect(() => {
    api.get<{ items: KnowledgeFile[] }>("/api/v1/knowledge/files")
      .then((r) => setFiles(r.items ?? []))
      .catch(() => {});
    api.get<{ items: KnowledgeBase[] }>("/api/v1/knowledge/kbs")
      .then((r) => setKbs(r.items ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (filter.type === "goal" && filter.id) {
      api.get<TaskBrief[]>(`/api/v1/goals/${filter.id}/tasks`)
        .then(setGoalTasks)
        .catch(() => setGoalTasks([]));
    } else {
      setGoalTasks([]);
    }
  }, [filter]);

  useEffect(() => {
    if (uploadGoalIds.length === 1) {
      api.get<TaskBrief[]>(`/api/v1/goals/${uploadGoalIds[0]}/tasks`)
        .then(setDialogTasks)
        .catch(() => setDialogTasks([]));
    } else {
      setDialogTasks([]);
      setUploadTaskId("");
    }
  }, [uploadGoalIds]);

  // ── 筛选逻辑 ────────────────────────────────────────────────
  // 被某个目标引用为配套知识库的 KB，不属于"待分类"（仅作目标配置项），需排除
  const goalLinkedKbIds = new Set(goals.map((g) => g.kb_id).filter(Boolean) as string[]);
  const unclassifiedKbs = kbs.filter((kb) => !goalLinkedKbIds.has(kb.id));

  const filteredFiles = files.filter((f) => {
    const matchQ = f.name.toLowerCase().includes(query.toLowerCase());
    if (!matchQ) return false;
    if (filter.type === "all")  return true;
    if (filter.type === "kb")   return f.kbId === filter.id && f.goalIds.length === 0;
    if (filter.type === "goal") return f.goalIds.includes(filter.id);
    return true;
  });

  const filteredNotes = notes.filter((n) => {
    if (n.noteType !== "chat_note") return false;
    const matchQ = n.content.toLowerCase().includes(query.toLowerCase());
    if (!matchQ) return false;
    if (filter.type === "all")  return true;
    if (filter.type === "kb")   return false;
    if (filter.type === "goal") return n.goalId === filter.id;
    return true;
  });

  // ── 新建知识库 ───────────────────────────────────────────────
  async function createKb() {
    const name = newKbName.trim();
    if (!name) return;
    try {
      const created = await api.post<{ id: string; name: string }>("/api/v1/knowledge/kbs", { name });
      setKbs((prev) => [...prev, { id: created.id, name: created.name }]);
    } catch {
      // 后端不可用时忽略
    }
    setNewKbName("");
    setNewKbOpen(false);
  }

  // ── 上传 ─────────────────────────────────────────────────────
  function toggleGoal(id: string) {
    setUploadGoalIds((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id],
    );
  }

  async function submitUpload() {
    if (!uploadFile || uploading) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", uploadFile);
    if (uploadKbId) formData.append("kb_id", uploadKbId);
    uploadGoalIds.forEach((id) => formData.append("goal_ids", id));
    if (uploadTaskId) formData.append("task_id", uploadTaskId);
    try {
      const saved = await api.upload<KnowledgeFile>("/api/v1/knowledge/upload", formData);
      setFiles((prev) => [saved, ...prev]);
    } catch {
      // 上传失败，不插入假数据
    } finally {
      setUploading(false);
      setUploadOpen(false);
      setUploadFile(null);
      setUploadKbId("");
      setUploadGoalIds([]);
      setUploadTaskId("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function submitUrlImport() {
    if (!urlInput.trim() || urlImporting) return;
    setUrlImporting(true);
    try {
      const saved = await api.post<KnowledgeFile>("/api/v1/knowledge/url", {
        url: urlInput.trim(),
        goal_id: urlGoalId || null,
        kb_id: urlKbId || null,
      });
      setFiles((prev) => [saved, ...prev]);
    } catch {
      // ignore
    } finally {
      setUrlImporting(false);
      setUrlImportOpen(false);
      setUrlInput("");
      setUrlGoalId("");
      setUrlKbId("");
    }
  }

  // ── 辅助 ─────────────────────────────────────────────────────
  function filterLabel() {
    if (filter.type === "all")  return "全部资料";
    if (filter.type === "kb")   return kbs.find((k) => k.id === filter.id)?.name ?? "";
    if (filter.type === "goal") return goals.find((g) => g.id === filter.id)?.title ?? "";
    return "";
  }

  function setF(type: FilterState["type"], id: string) {
    setFilter({ type, id });
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── 左侧导航 ── */}
      <aside className="w-56 flex-shrink-0 bg-gray-50 border-r border-gray-100 flex flex-col pt-5 pb-4 px-3 overflow-y-auto">
        {/* 全部 */}
        <button
          onClick={() => setF("all", "")}
          className={cn(
            "flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium transition w-full mb-3",
            filter.type === "all" ? "text-white" : "text-gray-500 hover:bg-gray-50",
          )}
          style={filter.type === "all" ? { backgroundColor: "var(--accent)" } : {}}
        >
          <BookOpen size={14} className="flex-shrink-0" />
          全部资料
        </button>

        {/* 待分类 */}
        <div className="px-3 mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">待分类</span>
          <button
            onClick={() => setNewKbOpen((v) => !v)}
            title="新建待分类"
            className="p-0.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition"
          >
            <Plus size={13} />
          </button>
        </div>

        {/* 新建待分类内联输入 */}
        {newKbOpen && (
          <div className="mx-1 mb-2 flex items-center gap-1">
            <input
              autoFocus
              value={newKbName}
              onChange={(e) => setNewKbName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createKb();
                if (e.key === "Escape") { setNewKbOpen(false); setNewKbName(""); }
              }}
              placeholder="名称…"
              className="flex-1 px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:border-gray-300"
            />
            <button onClick={createKb} className="p-1.5 rounded-lg text-white transition" style={{ backgroundColor: "var(--accent)" }}>
              <Check size={11} />
            </button>
            <button onClick={() => { setNewKbOpen(false); setNewKbName(""); }} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition">
              <X size={11} />
            </button>
          </div>
        )}

        <div className="flex flex-col gap-0.5 mb-4">
          {unclassifiedKbs.map((kb) => {
            const active = filter.type === "kb" && filter.id === kb.id;
            return (
              <button
                key={kb.id}
                onClick={() => setF("kb", kb.id)}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-left transition w-full",
                  active ? "font-semibold" : "text-gray-500 hover:bg-gray-50",
                )}
                style={active ? { backgroundColor: "var(--accent-light)", color: "var(--accent)" } : {}}
              >
                <FolderOpen size={14} className="flex-shrink-0" />
                <span className="truncate">{kb.name}</span>
              </button>
            );
          })}
          {unclassifiedKbs.length === 0 && (
            <p className="px-3 text-xs text-gray-400 py-1">暂无待分类内容</p>
          )}
        </div>

        {/* 按目标筛选 */}
        <div className="px-3 mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">按目标</span>
          <Link href="/dashboard/goals" className="text-xs hover:underline transition" style={{ color: "var(--accent)" }}>
            管理
          </Link>
        </div>
        <div className="flex flex-col gap-0.5">
          {goals.map((g) => {
            const active = filter.type === "goal" && filter.id === g.id;
            return (
              <button
                key={g.id}
                onClick={() => setF("goal", g.id)}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-left transition w-full",
                  active ? "font-semibold" : "text-gray-500 hover:bg-gray-50",
                )}
                style={active ? { backgroundColor: "var(--accent-light)", color: "var(--accent)" } : {}}
              >
                <Target size={14} className="flex-shrink-0" />
                <span className="truncate">{g.title}</span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── 主内容 ── */}
      <div className="flex-1 overflow-y-auto p-7">
        {/* 顶栏 */}
        <div className="flex items-center justify-between mb-7">
          <div>
            <h1 className="text-xl font-bold text-gray-900">知识库</h1>
            <p className="text-xs text-gray-400 mt-0.5">{filterLabel()}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索资料或笔记…"
                className="pl-9 pr-4 py-2 border border-gray-200 rounded-xl text-sm outline-none w-56 focus:border-gray-300 transition" />
            </div>
            <button onClick={() => setUrlImportOpen(true)}
              className="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 transition">
              <Link2 size={14} /> 导入 URL
            </button>
            <button onClick={() => setUploadOpen(true)}
              className="inline-flex items-center gap-2 text-white text-sm font-medium px-4 py-2 rounded-xl hover:opacity-90 transition"
              style={{ backgroundColor: "var(--accent)" }}>
              <Upload size={14} /> 上传文件
            </button>
          </div>
        </div>

        {/* 学习资料 */}
        <section className="mb-9">
          <div className="flex items-center gap-2 mb-4">
            <BookOpen size={15} style={{ color: "var(--accent)" }} />
            <h2 className="text-sm font-semibold text-gray-700">学习资料</h2>
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{filteredFiles.length}</span>
            <div className="ml-auto flex items-center gap-0.5 p-0.5 bg-gray-100 rounded-lg">
              <button onClick={() => setFilesView("list")}
                className={cn("flex items-center gap-1 px-2 py-1.5 rounded-md text-xs transition", filesView === "list" ? "bg-white shadow-sm text-gray-700 font-medium" : "text-gray-400 hover:text-gray-600")}>
                <List size={13} /> 列表
              </button>
              <button onClick={() => setFilesView("grid")}
                className={cn("flex items-center gap-1 px-2 py-1.5 rounded-md text-xs transition", filesView === "grid" ? "bg-white shadow-sm text-gray-700 font-medium" : "text-gray-400 hover:text-gray-600")}>
                <LayoutGrid size={13} /> 卡片
              </button>
            </div>
          </div>

          <div className="max-h-[45vh] overflow-y-auto pr-1">
          {filteredFiles.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-gray-200 py-12 text-center">
              <p className="text-sm text-gray-400 mb-3">暂无文件</p>
              <button onClick={() => setUploadOpen(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition"
                style={{ backgroundColor: "var(--accent-light)", color: "var(--accent)" }}>
                <Upload size={12} /> 上传第一个文件
              </button>
            </div>
          ) : filter.type === "goal" ? (() => {
            const taskGroupMap = new Map<string, KnowledgeFile[]>();
            for (const f of filteredFiles) {
              const key = f.taskId || "";
              if (!taskGroupMap.has(key)) taskGroupMap.set(key, []);
              taskGroupMap.get(key)!.push(f);
            }
            const getTaskTitle = (tid: string) => goalTasks.find((t) => t.id === tid)?.title ?? "未关联任务";
            const deleteFile = async (id: string) => {
              setDeletingId(id);
              try { await api.del(`/api/v1/knowledge/${id}`); } catch { /* ignore */ }
              setFiles((prev) => prev.filter((f) => f.id !== id));
              setDeletingId(null);
            };
            const sortedGroups = [
              ...Array.from(taskGroupMap.entries()).filter(([k]) => k !== ""),
              ...Array.from(taskGroupMap.entries()).filter(([k]) => k === ""),
            ];
            return (
              <div className="space-y-4">
                {sortedGroups.map(([tid, groupFiles]) => (
                  <div key={tid}>
                    <div className="flex items-center gap-2 mb-2">
                      <p className="text-xs font-semibold text-gray-600 truncate">{getTaskTitle(tid)}</p>
                      <span className="flex-shrink-0 text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">{groupFiles.length}</span>
                    </div>
                    {filesView === "grid" ? (
                      <div className="grid grid-cols-3 gap-3">
                        {groupFiles.map((file) => (
                          <div key={file.id} className="bg-white rounded-2xl border border-gray-100 p-4 hover:border-gray-200 hover:shadow-sm transition">
                            <div className="flex items-start gap-2.5 mb-3">
                              <div className="w-9 h-9 rounded-xl bg-gray-50 flex items-center justify-center flex-shrink-0">
                                {iconMap[file.type] ?? <FileText size={16} className="text-gray-400" />}
                              </div>
                              <p className="flex-1 text-sm font-medium text-gray-800 leading-snug line-clamp-2 min-w-0">{file.name}</p>
                              <button onClick={() => deleteFile(file.id)} disabled={deletingId === file.id}
                                className="text-gray-300 hover:text-red-500 transition p-0.5 rounded flex-shrink-0 disabled:opacity-50">
                                <Trash2 size={13} />
                              </button>
                            </div>
                            <div className="flex items-center justify-between text-xs text-gray-400">
                              <span>{file.size}</span>
                              <span>{file.uploadDate}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden divide-y divide-gray-50">
                        {groupFiles.map((file) => (
                          <div key={file.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition">
                            <div className="w-7 h-7 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
                              {iconMap[file.type] ?? <FileText size={14} className="text-gray-400" />}
                            </div>
                            <span className="flex-1 text-sm text-gray-800 font-medium truncate">{file.name}</span>
                            <span className="text-xs text-gray-400 flex-shrink-0">{file.size} · {file.uploadDate}</span>
                            <button onClick={() => deleteFile(file.id)} disabled={deletingId === file.id}
                              className="text-gray-300 hover:text-red-500 transition p-1 rounded disabled:opacity-50 flex-shrink-0">
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })() : filesView === "grid" ? (
            <div className="grid grid-cols-3 gap-3">
              {filteredFiles.map((file) => {
                const fileGoals = goals.filter((g) => file.goalIds.includes(g.id));
                const fileKb = kbs.find((k) => k.id === file.kbId);
                return (
                  <div key={file.id} className="bg-white rounded-2xl border border-gray-100 p-4 hover:border-gray-200 hover:shadow-sm transition">
                    <div className="flex items-start gap-2.5 mb-3">
                      <div className="w-9 h-9 rounded-xl bg-gray-50 flex items-center justify-center flex-shrink-0">
                        {iconMap[file.type] ?? <FileText size={16} className="text-gray-400" />}
                      </div>
                      <p className="flex-1 text-sm font-medium text-gray-800 leading-snug line-clamp-2 min-w-0">{file.name}</p>
                      <button
                        onClick={async () => {
                          setDeletingId(file.id);
                          try { await api.del(`/api/v1/knowledge/${file.id}`); } catch { /* ignore */ }
                          setFiles((prev) => prev.filter((f) => f.id !== file.id));
                          setDeletingId(null);
                        }}
                        disabled={deletingId === file.id}
                        className="text-gray-300 hover:text-red-500 transition p-0.5 rounded flex-shrink-0 disabled:opacity-50">
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-xs text-gray-400 mb-2">
                      <span>{file.size}</span>
                      <span>{file.uploadDate}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {fileKb && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 flex items-center gap-1">
                          <FolderOpen size={10} /> {fileKb.name}
                        </span>
                      )}
                      {fileGoals.map((g) => (
                        <span key={g.id} className="text-xs px-2 py-0.5 rounded-full font-medium"
                          style={{ backgroundColor: "var(--accent-light)", color: "var(--accent)" }}>
                          {g.title}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="grid grid-cols-12 px-4 py-2.5 border-b border-gray-100 text-xs font-medium text-gray-400 uppercase tracking-wide">
                <div className="col-span-4">文件名</div>
                <div className="col-span-2">知识库</div>
                <div className="col-span-3">关联目标</div>
                <div className="col-span-1">大小</div>
                <div className="col-span-1">日期</div>
                <div className="col-span-1" />
              </div>
              {filteredFiles.map((file) => {
                const fileGoals = goals.filter((g) => file.goalIds.includes(g.id));
                const fileKb = kbs.find((k) => k.id === file.kbId);
                return (
                  <div key={file.id} className="grid grid-cols-12 px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition items-center group">
                    <div className="col-span-4 flex items-center gap-2.5">
                      {iconMap[file.type] ?? <FileText size={15} className="text-gray-400" />}
                      <span className="text-sm text-gray-800 truncate font-medium">{file.name}</span>
                    </div>
                    <div className="col-span-2">
                      {fileKb ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{fileKb.name}</span>
                      ) : <span className="text-xs text-gray-300">—</span>}
                    </div>
                    <div className="col-span-3 flex flex-wrap gap-1">
                      {fileGoals.length === 0
                        ? <span className="text-xs text-gray-300">—</span>
                        : fileGoals.map((g) => (
                            <span key={g.id} className="text-xs px-2 py-0.5 rounded-full font-medium"
                              style={{ backgroundColor: "var(--accent-light)", color: "var(--accent)" }}>
                              {g.title}
                            </span>
                          ))}
                    </div>
                    <div className="col-span-1 text-xs text-gray-500">{file.size}</div>
                    <div className="col-span-1 text-xs text-gray-400">{file.uploadDate}</div>
                    <div className="col-span-1 flex justify-end">
                      <button
                        onClick={async () => {
                          setDeletingId(file.id);
                          try { await api.del(`/api/v1/knowledge/${file.id}`); } catch { /* ignore */ }
                          setFiles((prev) => prev.filter((f) => f.id !== file.id));
                          setDeletingId(null);
                        }}
                        disabled={deletingId === file.id}
                        className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition p-1 rounded disabled:opacity-50">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </section>

        {/* AI 对话摘录（按目标筛选时显示，按知识库筛选时隐藏） */}
        {filter.type !== "kb" && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <MessageSquare size={15} style={{ color: "var(--accent)" }} />
              <h2 className="text-sm font-semibold text-gray-700">AI 对话摘录</h2>
              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{filteredNotes.length}</span>
            </div>
            <div className="max-h-[50vh] overflow-y-auto pr-1">
            {filteredNotes.length === 0 ? (
              <div className="bg-white rounded-2xl border border-dashed border-gray-200 py-10 text-center text-sm text-gray-400">
                暂无摘录 — 在 AI 助教对话中点击「保存」后会出现在这里
              </div>
            ) : ((() => {
              function getField(content: string, key: string) {
                const marker = `【${key}】`;
                const idx = content.indexOf(marker);
                if (idx === -1) return "";
                const start = idx + marker.length;
                const nextIdx = content.indexOf("【", start);
                return content.slice(start, nextIdx === -1 ? undefined : nextIdx).trim();
              }

              function setField(content: string, key: string, value: string) {
                const marker = `【${key}】`;
                const idx = content.indexOf(marker);
                if (idx === -1) return content + `\n${marker}${value}`;
                const start = idx + marker.length;
                const nextIdx = content.indexOf("【", start);
                const after = nextIdx === -1 ? "" : "\n" + content.slice(nextIdx);
                return content.slice(0, idx) + marker + value + after;
              }

              const verifyNotes = filteredNotes.filter((n) => n.content.startsWith("【验收任务】"));
              const otherNotes  = filteredNotes.filter((n) => !n.content.startsWith("【验收任务】"));

              // 按 taskTitle 分组，保持首次出现顺序
              const taskGroupMap = new Map<string, typeof filteredNotes>();
              for (const note of verifyNotes) {
                const key = getField(note.content, "验收任务") || "未知任务";
                if (!taskGroupMap.has(key)) taskGroupMap.set(key, []);
                taskGroupMap.get(key)!.push(note);
              }

              const scoreColor = (score: number | null) =>
                score === null ? "" :
                score >= 90 ? "bg-green-100 text-green-700" :
                score >= 70 ? "bg-blue-100 text-blue-700" :
                score >= 60 ? "bg-yellow-100 text-yellow-700" :
                "bg-red-100 text-red-700";

              return (
                <div className="space-y-6">
                  {/* 验收记录按模块分组 */}
                  {Array.from(taskGroupMap.entries()).map(([taskTitle, notes]) => (
                    <div key={taskTitle}>
                      <div className="flex items-center gap-2 mb-3">
                        <p className="text-xs font-semibold text-gray-500 truncate">{taskTitle}</p>
                        <span className="flex-shrink-0 text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">{notes.length}</span>
                      </div>
                      <div className="space-y-2">
                        {notes.map((note, idx) => {
                          const score    = (() => { const s = getField(note.content, "得分"); return s ? parseInt(s) : null; })();
                          const question = getField(note.content, "考查问题");
                          const userAnswer  = getField(note.content, "我的回答");
                          const answerHint  = getField(note.content, "参考答案要点");
                          const expanded = expandedNotes.has(note.id);
                          const toggle   = () => setExpandedNotes((prev) => {
                            const next = new Set(prev);
                            next.has(note.id) ? next.delete(note.id) : next.add(note.id);
                            return next;
                          });

                          return (
                            <div key={note.id} className="bg-white rounded-xl border border-gray-100 overflow-hidden group shadow-sm">
                              <div className="flex items-center">
                                <button onClick={toggle} className="flex-1 flex items-center gap-3 px-4 py-3 hover:bg-gray-50/80 transition text-left">
                                  <span className="flex-shrink-0 text-[10px] font-bold text-gray-400 bg-gray-100 rounded-md px-1.5 py-0.5">Q{idx + 1}</span>
                                  <span className="flex-1 text-sm text-gray-800 leading-snug">{question || taskTitle}</span>
                                  <div className="flex items-center gap-2 flex-shrink-0">
                                    {score !== null && (
                                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${scoreColor(score)}`}>{score}分</span>
                                    )}
                                    <ChevronDown size={13} className={cn("text-gray-300 transition-transform duration-200", expanded && "rotate-180")} />
                                  </div>
                                </button>
                                <button onClick={() => deleteNote(note.id)}
                                  className="text-gray-300 hover:text-red-400 transition pr-4 pl-1 py-3 flex-shrink-0">
                                  <Trash2 size={12} />
                                </button>
                              </div>
                              {expanded && (
                                <div className="border-t border-gray-50">
                                  <div className="flex border-b border-gray-100 px-4">
                                    <button
                                      onClick={() => setRefTabNotes((prev) => { const next = new Set(prev); next.delete(note.id); return next; })}
                                      className={cn("py-2.5 mr-5 text-xs font-medium border-b-2 -mb-px transition", !refTabNotes.has(note.id)
                                        ? "text-gray-800"
                                        : "border-transparent text-gray-400 hover:text-gray-600")}
                                      style={!refTabNotes.has(note.id) ? { borderBottomColor: "var(--accent)" } : {}}
                                    >我的回答</button>
                                    <button
                                      onClick={() => setRefTabNotes((prev) => { const next = new Set(prev); next.add(note.id); return next; })}
                                      className={cn("py-2.5 text-xs font-medium border-b-2 -mb-px transition", refTabNotes.has(note.id)
                                        ? "text-gray-800"
                                        : "border-transparent text-gray-400 hover:text-gray-600")}
                                      style={refTabNotes.has(note.id) ? { borderBottomColor: "var(--accent)" } : {}}
                                    >参考答案要点</button>
                                  </div>
                                  <div className="px-4 py-3">
                                    {!refTabNotes.has(note.id) ? (
                                      <div>
                                        {editingAnswers.has(note.id) ? (
                                          <div>
                                            <textarea
                                              autoFocus
                                              value={editingAnswers.get(note.id) ?? ""}
                                              onChange={(e) => setEditingAnswers((prev) => new Map(prev).set(note.id, e.target.value))}
                                              className="w-full text-xs text-gray-700 leading-relaxed resize-none outline-none bg-gray-50 rounded-lg px-3 py-2.5 border border-gray-200 focus:border-gray-300 transition"
                                              rows={4}
                                              placeholder="输入你的回答…"
                                            />
                                            <div className="flex gap-2 mt-2">
                                              <button
                                                onClick={async () => {
                                                  const draft = editingAnswers.get(note.id) ?? "";
                                                  if (!draft.trim()) return;
                                                  setSavingNotes((prev) => new Set(prev).add(note.id));
                                                  await updateNote(note.id, { content: setField(note.content, "我的回答", draft) });
                                                  setEditingAnswers((prev) => { const next = new Map(prev); next.delete(note.id); return next; });
                                                  setSavingNotes((prev) => { const next = new Set(prev); next.delete(note.id); return next; });
                                                }}
                                                disabled={!editingAnswers.get(note.id)?.trim() || savingNotes.has(note.id)}
                                                className="px-3 py-1.5 text-xs rounded-lg text-white font-medium disabled:opacity-50 transition"
                                                style={{ backgroundColor: "var(--accent)" }}
                                              >{savingNotes.has(note.id) ? "保存中…" : "保存"}</button>
                                              <button
                                                onClick={() => setEditingAnswers((prev) => { const next = new Map(prev); next.delete(note.id); return next; })}
                                                className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:text-gray-700 transition"
                                              >取消</button>
                                            </div>
                                          </div>
                                        ) : (
                                          <div>
                                            {userAnswer
                                              ? <p className="text-xs text-gray-600 leading-relaxed whitespace-pre-line">{userAnswer}</p>
                                              : <p className="text-xs text-gray-400 italic">未保存回答</p>}
                                            <button
                                              onClick={() => setEditingAnswers((prev) => new Map(prev).set(note.id, userAnswer))}
                                              className="mt-2.5 flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition"
                                            ><Pencil size={10} />重新回答</button>
                                          </div>
                                        )}
                                      </div>
                                    ) : (
                                      <div>
                                        {answerHint
                                          ? <p className="text-xs leading-relaxed whitespace-pre-line" style={{ color: "var(--accent)" }}>{answerHint}</p>
                                          : <p className="text-xs italic text-gray-400">暂无参考答案</p>}
                                      </div>
                                    )}
                                    <p className="text-[10px] text-gray-300 mt-3">{note.date}</p>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  {/* 普通摘录（非验收）*/}
                  {otherNotes.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-400 mb-2">其他摘录</p>
                      <div className="space-y-2">
                        {otherNotes.map((note) => {
                          const expanded = expandedNotes.has(note.id);
                          const toggle   = () => setExpandedNotes((prev) => {
                            const next = new Set(prev);
                            next.has(note.id) ? next.delete(note.id) : next.add(note.id);
                            return next;
                          });
                          return (
                            <div key={note.id} className="bg-white rounded-2xl border border-gray-100 overflow-hidden group">
                              <div className="flex items-center">
                                <button onClick={toggle}
                                  className="flex-1 flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition text-left">
                                  <p className="text-sm text-gray-700 truncate flex-1">{note.content.split("\n")[0]}</p>
                                  <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                    <span className="text-xs text-gray-400">{note.date}</span>
                                    <ChevronDown size={13} className={`text-gray-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
                                  </div>
                                </button>
                                <button onClick={() => deleteNote(note.id)}
                                  className="text-gray-300 hover:text-red-500 transition pr-3 pl-1 py-3 flex-shrink-0">
                                  <Trash2 size={13} />
                                </button>
                              </div>
                              {expanded && (
                                <div className="px-4 pb-4 border-t border-gray-50">
                                  <p className="text-sm text-gray-700 leading-relaxed pt-3 whitespace-pre-line">{note.content}</p>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })())}</div>
          </section>
        )}
      </div>

      {/* ── 上传弹窗 ── */}
      {uploadOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setUploadOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-gray-900">上传学习资料</h2>
              <button onClick={() => setUploadOpen(false)}
                className="text-gray-400 hover:text-gray-600 transition p-1 rounded-lg hover:bg-gray-100">
                <X size={16} />
              </button>
            </div>

            {/* 文件选择区 */}
            <div onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-gray-200 rounded-xl py-8 text-center cursor-pointer hover:border-gray-300 transition mb-5">
              <Upload size={22} className="mx-auto text-gray-300 mb-2" />
              {uploadFile ? (
                <p className="text-sm font-medium text-gray-700">{uploadFile.name}</p>
              ) : (
                <>
                  <p className="text-sm text-gray-500">点击选择文件</p>
                  <p className="text-xs text-gray-400 mt-1">支持 PDF、Word、Excel、图片等</p>
                </>
              )}
              <input ref={fileInputRef} type="file" className="hidden"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
            </div>

            {/* 归属知识库（可选） */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-gray-500">归属知识库 <span className="font-normal text-gray-400">（可选）</span></label>
                {uploadKbId && (
                  <button onClick={() => setUploadKbId("")} className="text-xs text-gray-400 hover:text-gray-600">清除</button>
                )}
              </div>
              {kbs.length === 0 ? (
                <p className="text-xs text-gray-400">暂无知识库，可在侧边栏新建</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {kbs.map((kb) => (
                    <button key={kb.id} onClick={() => setUploadKbId((v) => v === kb.id ? "" : kb.id)}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition",
                        uploadKbId === kb.id ? "text-white border-transparent" : "border-gray-200 text-gray-600 hover:border-gray-300",
                      )}
                      style={uploadKbId === kb.id ? { backgroundColor: "var(--accent)" } : {}}>
                      <FolderOpen size={12} /> {kb.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 关联目标（可选，多选） */}
            <div className="mb-5">
              <label className="text-xs font-semibold text-gray-500 block mb-2">
                关联目标 <span className="font-normal text-gray-400">（可选，可多选）</span>
              </label>
              <div className="flex flex-col gap-1.5">
                {goals.map((g) => {
                  const checked = uploadGoalIds.includes(g.id);
                  return (
                    <label key={g.id} className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition",
                      checked ? "font-medium" : "border-gray-100 hover:border-gray-200",
                    )} style={checked ? { backgroundColor: "var(--accent-light)", borderColor: "var(--accent)" } : {}}>
                      <div className={cn(
                        "w-4 h-4 rounded flex items-center justify-center border flex-shrink-0 transition",
                        checked ? "text-white" : "border-gray-300",
                      )} style={checked ? { backgroundColor: "var(--accent)", borderColor: "var(--accent)" } : {}}>
                        {checked && <Check size={10} />}
                      </div>
                      <input type="checkbox" className="hidden" checked={checked} onChange={() => toggleGoal(g.id)} />
                      <span className="text-sm text-gray-700">{g.title}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* 关联任务模块（仅选择单个目标时显示） */}
            {uploadGoalIds.length === 1 && dialogTasks.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-gray-500">关联任务模块 <span className="font-normal text-gray-400">（可选）</span></label>
                  {uploadTaskId && (
                    <button onClick={() => setUploadTaskId("")} className="text-xs text-gray-400 hover:text-gray-600">清除</button>
                  )}
                </div>
                <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                  {dialogTasks.map((t) => {
                    const active = uploadTaskId === t.id;
                    return (
                      <button key={t.id} onClick={() => setUploadTaskId(active ? "" : t.id)}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-left border transition",
                          active ? "font-medium border-transparent" : "border-gray-100 text-gray-600 hover:border-gray-200",
                        )}
                        style={active ? { backgroundColor: "var(--accent-light)", color: "var(--accent)", borderColor: "var(--accent)" } : {}}>
                        <span className="truncate">{t.title}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={() => { setUploadOpen(false); setUploadFile(null); setUploadKbId(""); setUploadGoalIds([]); }}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500 hover:bg-gray-50 transition">
                取消
              </button>
              <button onClick={submitUpload} disabled={!uploadFile}
                className="flex-1 py-2.5 rounded-xl text-white text-sm font-medium transition disabled:opacity-40"
                style={{ backgroundColor: "var(--accent)" }}>
                {uploading ? "上传中..." : "确认上传"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* URL 导入弹窗 */}
      {urlImportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm px-4"
          onClick={() => setUrlImportOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-5"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800">导入网页 / URL</h2>
              <button onClick={() => setUrlImportOpen(false)} className="text-gray-400 hover:text-gray-600 transition">
                <X size={18} />
              </button>
            </div>

            {/* URL 输入 */}
            <div>
              <label className="text-xs font-semibold text-gray-500 mb-1.5 block">网页地址 <span className="text-red-400">*</span></label>
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com/article"
                className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-200"
              />
            </div>

            {/* 关联知识库（可选） */}
            {kbs.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-gray-500">关联知识库 <span className="font-normal text-gray-400">（可选）</span></label>
                  {urlKbId && <button onClick={() => setUrlKbId("")} className="text-xs text-gray-400 hover:text-gray-600">清除</button>}
                </div>
                <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                  {kbs.map((kb) => {
                    const active = urlKbId === kb.id;
                    return (
                      <button key={kb.id} onClick={() => setUrlKbId(active ? "" : kb.id)}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-left border transition",
                          active ? "font-medium border-transparent" : "border-gray-100 text-gray-600 hover:border-gray-200",
                        )}
                        style={active ? { backgroundColor: "var(--accent-light)", color: "var(--accent)", borderColor: "var(--accent)" } : {}}>
                        <BookOpen size={12} className="flex-shrink-0" />
                        <span className="truncate">{kb.name}</span>
                        {active && <Check size={12} className="ml-auto flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 关联目标（可选） */}
            {goals.filter((g) => g.status === "active").length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-gray-500">关联目标 <span className="font-normal text-gray-400">（可选）</span></label>
                  {urlGoalId && <button onClick={() => setUrlGoalId("")} className="text-xs text-gray-400 hover:text-gray-600">清除</button>}
                </div>
                <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                  {goals.filter((g) => g.status === "active").map((g) => {
                    const active = urlGoalId === g.id;
                    return (
                      <button key={g.id} onClick={() => setUrlGoalId(active ? "" : g.id)}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-left border transition",
                          active ? "font-medium border-transparent" : "border-gray-100 text-gray-600 hover:border-gray-200",
                        )}
                        style={active ? { backgroundColor: "var(--accent-light)", color: "var(--accent)", borderColor: "var(--accent)" } : {}}>
                        <Target size={12} className="flex-shrink-0" />
                        <span className="truncate">{g.title}</span>
                        {active && <Check size={12} className="ml-auto flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button onClick={() => { setUrlImportOpen(false); setUrlInput(""); setUrlGoalId(""); setUrlKbId(""); }}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500 hover:bg-gray-50 transition">
                取消
              </button>
              <button onClick={submitUrlImport} disabled={!urlInput.trim() || urlImporting}
                className="flex-1 py-2.5 rounded-xl text-white text-sm font-medium transition disabled:opacity-40"
                style={{ backgroundColor: "var(--accent)" }}>
                {urlImporting ? "导入中..." : "导入"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
