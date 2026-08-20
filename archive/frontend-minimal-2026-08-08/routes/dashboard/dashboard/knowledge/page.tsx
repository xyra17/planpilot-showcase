"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import {
  Search, Upload, FileText, FileSpreadsheet, Trash2,
  BookOpen, MessageSquare, Target, LayoutGrid, List,
  Plus, X, FolderOpen, Check, Link2,
  ChevronDown, Pencil,
  AlertCircle, CheckCircle2, Clock3, Database, Loader2, RefreshCw,
  Sparkles, ArrowUpRight, MoreHorizontal,
} from "lucide-react";
import { useGoalStore } from "@/lib/stores/goalStore";
import { useKnowledge } from "@/lib/knowledge-context";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/Toast";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";

// ── 类型 ─────────────────────────────────────────────────────
type KnowledgeBase = {
  id: string;
  name: string;
  description?: string;
  item_count?: number;
  created_at?: string;
};
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
  status: "uploaded" | "queued" | "parsing" | "embedding" | "ready" | "failed";
  error: string | null;
  retryCount: number;
  contentLength: number;
};

type FilterState = { type: "all" | "kb" | "goal" | "unlinked"; id: string };
type ResourceType = "all" | "document" | "web" | "pdf" | "video";

// ── 初始数据 ──────────────────────────────────────────────────
const INITIAL_KBS: KnowledgeBase[] = [];
const INITIAL_FILES: KnowledgeFile[] = [];

const STATUS_META: Record<KnowledgeFile["status"], { label: string; tone: StatusTone; icon: typeof Clock3; busy?: boolean }> = {
  uploaded: { label: "等待处理", tone: "neutral", icon: Clock3 },
  queued: { label: "排队中", tone: "progress", icon: Clock3 },
  parsing: { label: "解析中", tone: "warning", icon: Loader2, busy: true },
  embedding: { label: "建立索引", tone: "info", icon: Database },
  ready: { label: "可用于 AI", tone: "success", icon: CheckCircle2 },
  failed: { label: "处理失败", tone: "danger", icon: AlertCircle },
};

function ProcessingBadge({ file, onRetry }: { file: KnowledgeFile; onRetry: () => void }) {
  const meta = STATUS_META[file.status] ?? STATUS_META.uploaded;
  const Icon = meta.icon;
  return (
    <div className="flex flex-wrap items-center gap-1" title={file.error ?? undefined}>
      <StatusBadge
        tone={meta.tone}
        compact
        icon={<Icon className={meta.busy ? "animate-spin" : undefined} />}
        data-testid={`knowledge-processing-${file.status}`}
      >
        {meta.label}
      </StatusBadge>
      {file.status === "failed" && (
        <button onClick={onRetry} className="pp-inline-action" aria-label={`重新处理 ${file.name}`}>
          <RefreshCw size={11} />重试
        </button>
      )}
    </div>
  );
}

const iconMap: Record<string, React.ReactNode> = {
  pdf:   <FileText        size={16} className="text-red-500"   />,
  excel: <FileSpreadsheet size={16} className="text-green-600" />,
};

// ── 主页面 ────────────────────────────────────────────────────
export default function KnowledgePage() {
  const { showToast } = useToast();
  const { goals, fetchGoals } = useGoalStore();
  const [query,      setQuery]      = useState("");
  const [filter, setFilter] = useState<FilterState>({ type: "all", id: "" });
  const [files,      setFiles]      = useState<KnowledgeFile[]>(INITIAL_FILES);
  const [kbs,        setKbs]        = useState<KnowledgeBase[]>(INITIAL_KBS);
  const [filesView,  setFilesView]  = useState<"grid" | "list">("grid");
  const [spaceSection, setSpaceSection] = useState<"libraries" | "files" | "recent" | "notes">("files");
  const [resourceType, setResourceType] = useState<ResourceType>("all");
  const [sortMode, setSortMode] = useState<"latest" | "name">("latest");
  const [newResourceOpen, setNewResourceOpen] = useState(false);
  const [fileMenuId, setFileMenuId] = useState<string | null>(null);

  // 新建知识库
  const [newKbOpen,  setNewKbOpen]  = useState(false);
  const [newKbName,  setNewKbName]  = useState("");
  const [newKbDescription, setNewKbDescription] = useState("");

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

  // AI 对话摘录属于知识库内容，与用户独立创建的笔记分开管理。
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
    if (!files.some((file) => ["uploaded", "queued", "parsing", "embedding"].includes(file.status))) {
      return;
    }
    const timer = window.setInterval(() => {
      api.get<{ items: KnowledgeFile[] }>("/api/v1/knowledge/files")
        .then((response) => setFiles(response.items ?? []))
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [files]);

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
  const filteredFiles = files.filter((f) => {
    const matchQ = f.name.toLowerCase().includes(query.toLowerCase());
    if (!matchQ) return false;
    const normalizedType = f.type.toLowerCase();
    const matchType = resourceType === "all"
      || (resourceType === "pdf" && normalizedType === "pdf")
      || (resourceType === "web" && ["url", "web", "html"].includes(normalizedType))
      || (resourceType === "video" && ["video", "mp4", "mov", "webm"].includes(normalizedType))
      || (resourceType === "document" && ["doc", "docx", "txt", "md", "markdown", "excel", "xlsx", "csv"].includes(normalizedType));
    if (!matchType) return false;
    if (filter.type === "all")  return true;
    if (filter.type === "kb")   return f.kbId === filter.id && f.goalIds.length === 0;
    if (filter.type === "goal") return f.goalIds.includes(filter.id);
    if (filter.type === "unlinked") return f.goalIds.length === 0;
    return true;
  });

  const filteredNotes = notes.filter((n) => {
    if (n.noteType !== "chat_note") return false;
    const matchQ = n.content.toLowerCase().includes(query.toLowerCase());
    if (!matchQ) return false;
    if (filter.type === "all")  return true;
    if (filter.type === "kb")   return false;
    if (filter.type === "goal") return n.goalId === filter.id;
    if (filter.type === "unlinked") return !n.goalId;
    return true;
  });

  const sortedFiles = [...filteredFiles].sort((a, b) => {
    if (sortMode === "name") return a.name.localeCompare(b.name, "zh-CN");
    return b.uploadDate.localeCompare(a.uploadDate);
  });
  const visibleFiles = spaceSection === "recent" ? sortedFiles.slice(0, 6) : sortedFiles;

  // ── 新建知识库 ───────────────────────────────────────────────
  async function createKb() {
    const name = newKbName.trim();
    if (!name) return;
    try {
      const created = await api.post<KnowledgeBase>("/api/v1/knowledge/kbs", {
        name,
        description: newKbDescription.trim(),
      });
      setKbs((prev) => [created, ...prev]);
      showToast("知识库已创建", "success");
    } catch {
      // 后端不可用时忽略
    }
    setNewKbName("");
    setNewKbDescription("");
    setNewKbOpen(false);
  }

  // ── 上传 ─────────────────────────────────────────────────────
  function toggleGoal(id: string) {
    setUploadGoalIds((prev) => prev.includes(id) ? [] : [id]);
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
      showToast("文件已上传，正在建立索引", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "上传失败", "error");
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

  async function retryFile(id: string) {
    try {
      const updated = await api.post<KnowledgeFile>(`/api/v1/knowledge/${id}/retry`, {});
      setFiles((prev) => prev.map((file) => file.id === id ? updated : file));
      showToast("已重新加入处理队列", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "重试失败", "error");
    }
  }

  async function deleteFile(id: string) {
    setDeletingId(id);
    try {
      await api.del(`/api/v1/knowledge/${id}`);
      setFiles((prev) => prev.filter((file) => file.id !== id));
      showToast("资料已删除", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "删除失败", "error");
    } finally {
      setDeletingId(null);
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
      showToast("网址已导入，正在建立索引", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "网址导入失败", "error");
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
    if (filter.type === "unlinked") return "未关联资料";
    return "";
  }

  const scopeDescription = filter.type === "goal"
    ? "查看这个目标关联的资料与 AI 对话摘录"
    : filter.type === "kb"
      ? "整理尚未归入学习目标的资料"
      : filter.type === "unlinked"
        ? "查看尚未关联学习目标的资料"
      : "集中管理所有可供 AI 助教检索的学习内容";

  return (
    <div className="knowledge-page flex h-full overflow-hidden">
      {/* ── 主内容 ── */}
      <main className="knowledge-main min-w-0 flex-1 overflow-y-auto">
        <div className="knowledge-content mx-auto w-full max-w-[1500px] px-4 py-5 md:px-7 md:py-7 xl:px-9">
        <div className="knowledge-workbench">
        <header className="knowledge-hero">
          <div className="knowledge-hero-main">
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold tracking-tight text-gray-900">知识库</h1>
              <p className="mt-0.5 text-xs text-gray-400">沉淀资料，构建你的长期学习系统</p>
            </div>
            <div className="knowledge-hero-actions">
              <div className="knowledge-create-menu-wrap">
                <button
                  onClick={() => setNewResourceOpen((open) => !open)}
                  className="knowledge-primary-button"
                  aria-haspopup="menu"
                  aria-expanded={newResourceOpen}
                >
                  <Plus size={15} /> 新建资料
                </button>
                {newResourceOpen && (
                  <div className="knowledge-create-menu" role="menu">
                    <button
                      role="menuitem"
                      onClick={() => { setNewResourceOpen(false); setUrlImportOpen(true); }}
                    >
                      <span><Link2 size={15} /></span>
                      <span><strong>导入网页</strong><small>将文章或网页加入检索</small></span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => { setNewResourceOpen(false); setNewKbOpen(true); }}
                    >
                      <span><FolderOpen size={15} /></span>
                      <span><strong>新建知识库</strong><small>创建专题资料集合</small></span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => { setNewResourceOpen(false); setSpaceSection("libraries"); }}
                    >
                      <span><BookOpen size={15} /></span>
                      <span><strong>管理知识库</strong><small>查看现有专题资料集合</small></span>
                    </button>
                  </div>
                )}
              </div>
              <button onClick={() => setUploadOpen(true)} className="knowledge-secondary-button">
                <Upload size={15} /> 上传文件
              </button>
            </div>
          </div>
        </header>

        <div className="knowledge-discovery-bar">
          <div className="knowledge-global-search relative">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索知识库中的资料、标签或内容…"
              aria-label="搜索知识库中的资料、标签或内容"
            />
          </div>
          <div className="knowledge-type-filter" role="tablist" aria-label="资料类型">
            {([
              ["all", "全部"],
              ["document", "文档"],
              ["web", "网页"],
              ["pdf", "PDF"],
              ["video", "视频"],
            ] as [ResourceType, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={resourceType === value}
                onClick={() => setResourceType(value)}
                className={cn("knowledge-type-filter-button", resourceType === value && "is-active")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <section className="knowledge-goal-section" aria-labelledby="knowledge-goal-heading">
          <div className="knowledge-goal-heading">
            <div>
              <h2 id="knowledge-goal-heading">按目标查看</h2>
              <p>把资料放回正在推进的学习方向。</p>
            </div>
            <Link href="/work/goals" className="knowledge-goal-manage">
              管理目标 <ArrowUpRight size={13} />
            </Link>
          </div>
          <div className="knowledge-goal-grid">
            <button
              type="button"
              aria-pressed={filter.type === "all"}
              onClick={() => setFilter({ type: "all", id: "" })}
              className={cn("knowledge-goal-card", filter.type === "all" && "is-active")}
            >
              <span className="knowledge-goal-card-icon"><Target size={18} /></span>
              <span><strong>全部资料</strong><small>{files.length}</small></span>
            </button>
            {goals.slice(0, 3).map((goal) => {
              const count = files.filter((file) => file.goalIds.includes(goal.id)).length;
              return (
                <button
                  key={goal.id}
                  type="button"
                  aria-pressed={filter.type === "goal" && filter.id === goal.id}
                  onClick={() => setFilter({ type: "goal", id: goal.id })}
                  className={cn("knowledge-goal-card", filter.type === "goal" && filter.id === goal.id && "is-active")}
                >
                  <span className="knowledge-goal-card-icon is-goal"><Target size={17} /></span>
                  <span><strong className="truncate">{goal.title}</strong><small>{count}</small></span>
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={filter.type === "unlinked"}
              onClick={() => setFilter({ type: "unlinked", id: "" })}
              className={cn("knowledge-goal-card", filter.type === "unlinked" && "is-active")}
            >
              <span className="knowledge-goal-card-icon is-unlinked"><Link2 size={17} /></span>
              <span><strong>未关联资料</strong><small>{files.filter((file) => file.goalIds.length === 0).length}</small></span>
            </button>
          </div>
        </section>

        <nav className="knowledge-space-tabs" aria-label="资料空间内容">
          <div className="knowledge-space-tab-group">
            <button
              onClick={() => setSpaceSection("files")}
              className={cn("knowledge-space-tab", spaceSection === "files" && "is-active")}
              aria-current={spaceSection === "files" ? "page" : undefined}
            >
              全部资料 <span>{files.length}</span>
            </button>
            <button
              onClick={() => setSpaceSection("recent")}
              className={cn("knowledge-space-tab", spaceSection === "recent" && "is-active")}
              aria-current={spaceSection === "recent" ? "page" : undefined}
            >
              最近浏览
            </button>
          </div>
          {(spaceSection === "files" || spaceSection === "recent") && (
            <div className="knowledge-nav-actions" aria-label="资料视图">
              <button onClick={() => setFilesView("grid")} className={cn(filesView === "grid" && "is-active")} aria-label="卡片视图">
                <LayoutGrid size={14} />卡片视图
              </button>
              <button onClick={() => setFilesView("list")} className={cn(filesView === "list" && "is-active")} aria-label="列表视图">
                <List size={14} />列表视图
              </button>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as "latest" | "name")} aria-label="资料排序">
                <option value="latest">最新修改</option>
                <option value="name">名称排序</option>
              </select>
            </div>
          )}
        </nav>

        {spaceSection === "libraries" && <section className="knowledge-library-section knowledge-space-section">
          <div className="knowledge-resource-toolbar">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-gray-800">我的知识库</h2>
                <span className="pp-count-badge" aria-label={`${kbs.length} 个知识库`}>{kbs.length}</span>
              </div>
              <p className="mt-0.5 text-xs text-gray-400">像管理学习目标一样，进入单个知识库整理专属资料</p>
            </div>
          </div>
          {kbs.length === 0 ? (
            <div className="knowledge-empty-state">
              <div className="knowledge-empty-icon"><FolderOpen size={17} /></div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-700">还没有知识库</p>
                <p className="mt-0.5 text-xs text-gray-400">为一个主题或课程建立独立资料集合。</p>
              </div>
              <button onClick={() => setNewKbOpen(true)} className="knowledge-empty-action">
                <Plus size={12} /> 新建知识库
              </button>
            </div>
          ) : (
            <div className="knowledge-library-grid">
              {kbs.map((kb) => {
                const kbFiles = files.filter((file) => file.kbId === kb.id);
                const available = kbFiles.filter((file) => file.status === "ready").length;
                const failed = kbFiles.filter((file) => file.status === "failed").length;
                return (
                  <Link key={kb.id} href={`/work/knowledge/${kb.id}`} className="knowledge-library-card group">
                    <div className="knowledge-library-icon"><FolderOpen size={17} /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-gray-800">{kb.name}</h3>
                        {failed > 0 && <StatusBadge tone="danger" compact>{failed} 个失败</StatusBadge>}
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs text-gray-400">{kb.description || "尚未添加说明"}</p>
                      <div className="mt-3 flex items-center gap-3 text-[11px] text-gray-400">
                        <span>{kb.item_count ?? kbFiles.length} 份资料</span>
                        <span>{available} 份可用于 AI</span>
                      </div>
                    </div>
                    <ArrowUpRight size={14} className="knowledge-library-arrow" />
                  </Link>
                );
              })}
            </div>
          )}
        </section>}

        {/* 学习资料 */}
        {(spaceSection === "files" || spaceSection === "recent") && <section className="knowledge-resource-panel knowledge-space-section">
          <div className="knowledge-resource-toolbar">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-gray-800">{filterLabel()}</h2>
                <span className="pp-count-badge" aria-label={`${visibleFiles.length} 个学习资料`}>{visibleFiles.length}</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-gray-400">{scopeDescription}</p>
            </div>
            <div className="knowledge-toolbar-actions">
              <span className="knowledge-result-label">{resourceType === "all" ? "全部类型" : "已筛选"}</span>
            </div>
          </div>

          <div className="knowledge-resource-body max-h-[48vh] overflow-y-auto">
          {visibleFiles.length === 0 ? (
            <div className="knowledge-empty-state">
              <div className="knowledge-empty-icon"><FileText size={18} /></div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-700">这里还没有学习资料</p>
                <p className="mt-0.5 text-xs text-gray-400">上传本地文件，或导入一篇网页作为 AI 的学习上下文。</p>
              </div>
              <button onClick={() => setUploadOpen(true)} className="knowledge-empty-action">
                <Upload size={12} /> 添加第一份资料
              </button>
            </div>
          ) : filter.type === "goal" ? (() => {
            const taskGroupMap = new Map<string, KnowledgeFile[]>();
            for (const f of visibleFiles) {
              const key = f.taskId || "";
              if (!taskGroupMap.has(key)) taskGroupMap.set(key, []);
              taskGroupMap.get(key)!.push(f);
            }
            const getTaskTitle = (tid: string) => goalTasks.find((t) => t.id === tid)?.title ?? "未关联任务";
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
                      <span className="pp-count-badge" aria-label={`${groupFiles.length} 个文件`}>{groupFiles.length}</span>
                    </div>
                    {filesView === "grid" ? (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {groupFiles.map((file) => (
                          <div key={file.id} className="knowledge-file-card group relative bg-white rounded-2xl border border-gray-100 p-4 hover:shadow-md transition-all duration-200">
                            <div className="flex items-start gap-2.5 mb-3">
                              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
                                {iconMap[file.type] ?? <FileText size={16} className="text-gray-400" />}
                              </div>
                              <p className="flex-1 text-sm font-medium text-gray-800 leading-snug line-clamp-2 min-w-0">{file.name}</p>
                              <button onClick={() => setFileMenuId(fileMenuId === file.id ? null : file.id)}
                                className="knowledge-card-menu-trigger flex-shrink-0" aria-label={`管理 ${file.name}`}>
                                <MoreHorizontal size={16} />
                              </button>
                              {fileMenuId === file.id && (
                                <div className="knowledge-card-menu">
                                  <button onClick={() => { setFileMenuId(null); deleteFile(file.id); }} disabled={deletingId === file.id}>
                                    <Trash2 size={12} />删除资料
                                  </button>
                                </div>
                              )}
                            </div>
                            <p className="knowledge-file-summary">已收录到学习资料，可在 AI 对话和计划生成时作为检索上下文。</p>
                            <div className="flex items-center justify-between text-xs text-gray-400">
                              <span>{file.type.toUpperCase()} · {file.size}</span>
                              <span>{file.uploadDate}</span>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              <ProcessingBadge file={file} onRetry={() => retryFile(file.id)} />
                            </div>
                            <div className="knowledge-card-association">
                              <span>关联目标：</span><strong>{filterLabel()}</strong>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden divide-y divide-gray-50">
                        {groupFiles.map((file) => (
                          <div key={file.id} className="knowledge-file-row group flex items-center gap-3 px-4 py-3 transition">
                            <div className="knowledge-file-icon w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0">
                              {iconMap[file.type] ?? <FileText size={14} className="text-gray-400" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-gray-800">{file.name}</p>
                              <p className="mt-0.5 text-[11px] text-gray-400">{file.size} · {file.uploadDate}</p>
                            </div>
                            <ProcessingBadge file={file} onRetry={() => retryFile(file.id)} />
                            <button onClick={() => deleteFile(file.id)} disabled={deletingId === file.id}
                              title="删除资料" aria-label={`删除 ${file.name}`}
                              className="pp-icon-action knowledge-row-action flex h-8 w-8 items-center justify-center rounded-lg transition disabled:opacity-50">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visibleFiles.map((file) => {
                const fileGoals = goals.filter((g) => file.goalIds.includes(g.id));
                const fileKb = kbs.find((k) => k.id === file.kbId);
                return (
                  <div key={file.id} className="knowledge-file-card group relative bg-white rounded-2xl border border-gray-100 p-4 hover:shadow-md transition-all duration-200">
                    <div className="flex items-start gap-2.5 mb-3">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "var(--accent-light)" }}>
                        {iconMap[file.type] ?? <FileText size={16} className="text-gray-400" />}
                      </div>
                      <p className="flex-1 text-sm font-medium text-gray-800 leading-snug line-clamp-2 min-w-0">{file.name}</p>
                      <button
                        onClick={() => setFileMenuId(fileMenuId === file.id ? null : file.id)}
                        className="knowledge-card-menu-trigger flex-shrink-0"
                        aria-label={`管理 ${file.name}`}>
                        <MoreHorizontal size={16} />
                      </button>
                      {fileMenuId === file.id && (
                        <div className="knowledge-card-menu">
                          <button onClick={() => { setFileMenuId(null); deleteFile(file.id); }} disabled={deletingId === file.id}>
                            <Trash2 size={12} />删除资料
                          </button>
                        </div>
                      )}
                    </div>
                    <p className="knowledge-file-summary">
                      已收录到学习资料，可在 AI 对话和计划生成时作为检索上下文。
                    </p>
                    <div className="flex items-center justify-between text-xs text-gray-400 mb-2">
                      <span>{file.type.toUpperCase()} · {file.size}</span>
                      <span>{file.uploadDate}</span>
                    </div>
                    <div className="mb-2">
                      <ProcessingBadge file={file} onRetry={() => retryFile(file.id)} />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {fileKb && (
                        <StatusBadge tone="neutral" compact icon={<FolderOpen size={10} />}>{fileKb.name}</StatusBadge>
                      )}
                      {fileGoals.map((g) => (
                        <StatusBadge key={g.id} tone="info" compact>{g.title}</StatusBadge>
                      ))}
                    </div>
                    <div className="knowledge-card-association">
                      <span>关联目标：</span>
                      <strong>{fileGoals.length > 0 ? fileGoals.map((goal) => goal.title).join("、") : "未关联目标"}</strong>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="knowledge-list overflow-hidden">
              <div className="knowledge-list-head grid grid-cols-12 px-4 py-2.5 text-[11px] font-medium text-gray-400">
                <div className="col-span-4">资料</div>
                <div className="col-span-2">处理状态</div>
                <div className="col-span-2">知识库</div>
                <div className="col-span-2">关联目标</div>
                <div className="col-span-1">更新</div>
                <div className="col-span-1" />
              </div>
              {visibleFiles.map((file) => {
                const fileGoals = goals.filter((g) => file.goalIds.includes(g.id));
                const fileKb = kbs.find((k) => k.id === file.kbId);
                return (
                  <div key={file.id} className="knowledge-file-row group grid grid-cols-12 items-center px-4 py-3 transition">
                    <div className="col-span-4 flex min-w-0 items-center gap-3 pr-3">
                      <div className="knowledge-file-icon flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl">
                        {iconMap[file.type] ?? <FileText size={15} className="text-gray-400" />}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-800">{file.name}</p>
                        <p className="mt-0.5 text-[11px] text-gray-400">{file.size}</p>
                      </div>
                    </div>
                    <div className="col-span-2">
                      <ProcessingBadge file={file} onRetry={() => retryFile(file.id)} />
                    </div>
                    <div className="col-span-2">
                      {fileKb ? (
                        <StatusBadge tone="neutral" compact>{fileKb.name}</StatusBadge>
                      ) : <span className="text-xs text-gray-300">—</span>}
                    </div>
                    <div className="col-span-2 flex flex-wrap gap-1">
                      {fileGoals.length === 0
                        ? <span className="text-xs text-gray-300">—</span>
                        : fileGoals.map((g) => (
                            <StatusBadge key={g.id} tone="info" compact>{g.title}</StatusBadge>
                          ))}
                    </div>
                    <div className="col-span-1 text-xs text-gray-400">{file.uploadDate}</div>
                    <div className="col-span-1 flex justify-end">
                      <button
                        onClick={() => deleteFile(file.id)}
                        disabled={deletingId === file.id}
                        title="删除资料"
                        aria-label={`删除 ${file.name}`}
                        className="pp-icon-action knowledge-row-action flex h-8 w-8 items-center justify-center rounded-lg transition disabled:opacity-50">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </section>}

        {/* AI 对话摘录（按目标筛选时显示，按知识库筛选时隐藏） */}
        {spaceSection === "notes" && filter.type !== "kb" && (
          <section className="knowledge-excerpts-panel knowledge-space-section">
            <div className="knowledge-excerpts-heading">
              <div className="knowledge-section-icon"><Sparkles size={15} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-700">AI 对话摘录</h2>
                  <span className="pp-count-badge" aria-label={`${filteredNotes.length} 条 AI 对话摘录`}>{filteredNotes.length}</span>
                </div>
                <p className="mt-0.5 text-xs text-gray-400">保留值得复习的回答、解释与任务验收记录</p>
              </div>
              <Link href="/coach" className="knowledge-coach-link">前往学习伙伴 <ArrowUpRight size={12} /></Link>
            </div>
            <div className="max-h-[50vh] overflow-y-auto">
            {filteredNotes.length === 0 ? (
              <div className="knowledge-excerpts-empty">
                <MessageSquare size={17} />
                <div>
                  <p className="text-sm font-medium text-gray-600">还没有保存的对话摘录</p>
                  <p className="mt-0.5 text-xs text-gray-400">在学习对话中点击「保存」，重要内容会沉淀到这里。</p>
                </div>
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

              const scoreTone = (score: number): StatusTone =>
                score >= 90 ? "success" : score >= 70 ? "info" : score >= 60 ? "warning" : "danger";

              return (
                <div className="space-y-6">
                  {/* 验收记录按模块分组 */}
                  {Array.from(taskGroupMap.entries()).map(([taskTitle, notes]) => (
                    <div key={taskTitle}>
                      <div className="flex items-center gap-2 mb-3">
                        <p className="text-xs font-semibold text-gray-500 truncate">{taskTitle}</p>
                        <span className="pp-count-badge">{notes.length}</span>
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
                            if (next.has(note.id)) { next.delete(note.id); } else { next.add(note.id); }
                            return next;
                          });

                          return (
                            <div key={note.id} className="knowledge-excerpt-card bg-white rounded-xl border border-gray-100 overflow-hidden group shadow-sm">
                              <div className="flex items-center">
                                <button onClick={toggle} className="flex-1 flex items-center gap-3 px-4 py-3 hover:bg-gray-50/80 transition text-left">
                                  <span className="pp-count-badge">Q{idx + 1}</span>
                                  <span className="flex-1 text-sm text-gray-800 leading-snug">{question || taskTitle}</span>
                                  <div className="flex items-center gap-2 flex-shrink-0">
                                    {score !== null && (
                                      <StatusBadge tone={scoreTone(score)} compact>{score}分</StatusBadge>
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
                            if (next.has(note.id)) { next.delete(note.id); } else { next.add(note.id); }
                            return next;
                          });
                          return (
                            <div key={note.id} className="knowledge-excerpt-row bg-white overflow-hidden group">
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
        </div>
      </main>

      {/* ── 新建知识库弹窗 ── */}
      {newKbOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm" onClick={() => setNewKbOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="新建知识库" className="journal-dialog w-full max-w-md rounded-2xl border border-gray-100 bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-gray-800">新建知识库</h2>
                <p className="mt-1 text-xs text-gray-400">为一个课程、技能或专题建立独立资料集合</p>
              </div>
              <button onClick={() => setNewKbOpen(false)} className="pp-icon-action flex h-8 w-8 items-center justify-center rounded-lg" aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <label className="mb-1.5 block text-xs font-semibold text-gray-500">名称</label>
            <input
              autoFocus
              value={newKbName}
              onChange={(event) => setNewKbName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") createKb();
                if (event.key === "Escape") setNewKbOpen(false);
              }}
              placeholder="例如：Python 进阶"
              className="mb-4 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-accent"
            />
            <label className="mb-1.5 block text-xs font-semibold text-gray-500">说明 <span className="font-normal text-gray-400">（可选）</span></label>
            <textarea
              value={newKbDescription}
              onChange={(event) => setNewKbDescription(event.target.value)}
              placeholder="这个知识库用于整理什么内容？"
              rows={3}
              className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-accent"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setNewKbOpen(false)} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-500">取消</button>
              <button onClick={createKb} disabled={!newKbName.trim()} className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40" style={{ backgroundColor: "var(--accent)" }}>创建知识库</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 上传弹窗 ── */}
      {uploadOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setUploadOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="上传学习资料" className="journal-dialog bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-md mx-4 p-6 max-h-[90vh] overflow-y-auto"
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
                accept=".pdf,.txt,.md,.docx,.csv,.xlsx,.png,.jpg,.jpeg,.gif,.webp"
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
          <div role="dialog" aria-modal="true" aria-label="导入网址资料" className="journal-dialog bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-md p-6 space-y-5"
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
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-700 outline-none focus:border-accent transition"
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
