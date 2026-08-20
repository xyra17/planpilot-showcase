"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Clock3,
  Database,
  FileSpreadsheet,
  FileText,
  LayoutGrid,
  Link2,
  List,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  item_count: number;
  created_at: string;
};

type KnowledgeFile = {
  id: string;
  name: string;
  size: string;
  uploadDate: string;
  type: string;
  goalIds: string[];
  kbId: string;
  taskId: string;
  status: "uploaded" | "queued" | "parsing" | "embedding" | "ready" | "failed";
  error: string | null;
  retryCount: number;
  contentLength: number;
};

const STATUS_META: Record<KnowledgeFile["status"], { label: string; tone: StatusTone; icon: typeof Clock3; busy?: boolean }> = {
  uploaded: { label: "等待处理", tone: "neutral", icon: Clock3 },
  queued: { label: "排队中", tone: "progress", icon: Clock3 },
  parsing: { label: "解析中", tone: "warning", icon: Loader2, busy: true },
  embedding: { label: "建立索引", tone: "info", icon: Database },
  ready: { label: "可用于 AI", tone: "success", icon: CheckCircle2 },
  failed: { label: "处理失败", tone: "danger", icon: AlertCircle },
};

function ProcessingStatus({ file, onRetry }: { file: KnowledgeFile; onRetry: () => void }) {
  const meta = STATUS_META[file.status];
  const Icon = meta.icon;
  return (
    <div className="flex flex-wrap items-center gap-1" title={file.error ?? undefined}>
      <StatusBadge tone={meta.tone} compact icon={<Icon className={meta.busy ? "animate-spin" : undefined} />}>
        {meta.label}
      </StatusBadge>
      {file.status === "failed" && (
        <button onClick={onRetry} className="pp-inline-action" aria-label={`重新处理 ${file.name}`}>
          <RefreshCw size={11} /> 重试
        </button>
      )}
    </div>
  );
}

function FileIcon({ type }: { type: string }) {
  if (type === "excel") return <FileSpreadsheet size={15} className="text-green-600" />;
  return <FileText size={15} className={type === "pdf" ? "text-red-500" : "text-gray-400"} />;
}

export default function KnowledgeBaseDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { showToast } = useToast();
  const { confirmAction } = useConfirmDialog();
  const kbId = params.id;

  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "grid">("list");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [urlImporting, setUrlImporting] = useState(false);
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get<KnowledgeBase>(`/api/v1/knowledge/kbs/${kbId}`),
      api.get<{ items: KnowledgeFile[] }>("/api/v1/knowledge/files"),
    ])
      .then(([kb, response]) => {
        if (cancelled) return;
        setKnowledgeBase(kb);
        setEditName(kb.name);
        setEditDescription(kb.description ?? "");
        setFiles((response.items ?? []).filter((file) => file.kbId === kbId));
      })
      .catch((error) => {
        if (!cancelled) showToast(error instanceof Error ? error.message : "知识库加载失败", "error");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kbId, showToast]);

  useEffect(() => {
    if (!files.some((file) => ["uploaded", "queued", "parsing", "embedding"].includes(file.status))) return;
    const timer = window.setInterval(() => {
      api.get<{ items: KnowledgeFile[] }>("/api/v1/knowledge/files")
        .then((response) => setFiles((response.items ?? []).filter((file) => file.kbId === kbId)))
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [files, kbId]);

  const filteredFiles = useMemo(
    () => files.filter((file) => file.name.toLowerCase().includes(query.toLowerCase())),
    [files, query],
  );
  const readyCount = files.filter((file) => file.status === "ready").length;
  const failedCount = files.filter((file) => file.status === "failed").length;
  const processingCount = files.filter((file) => ["uploaded", "queued", "parsing", "embedding"].includes(file.status)).length;

  async function saveDetails() {
    if (!editName.trim() || saving) return;
    setSaving(true);
    try {
      const updated = await api.patch<KnowledgeBase>(`/api/v1/knowledge/kbs/${kbId}`, {
        name: editName.trim(),
        description: editDescription.trim(),
      });
      setKnowledgeBase(updated);
      setEditing(false);
      showToast("知识库信息已更新", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setSaving(false);
    }
  }

  async function deleteKnowledgeBase() {
    const confirmed = await confirmAction({
      title: "删除知识库",
      description: "知识库中的资料会保留在资料空间，但将解除知识库归属。",
      confirmLabel: "删除知识库",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await api.del(`/api/v1/knowledge/kbs/${kbId}`);
      showToast("知识库已删除，资料已移至未归档", "success");
      router.push("/work/knowledge");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "删除失败", "error");
    }
  }

  async function retryFile(file: KnowledgeFile) {
    try {
      const updated = await api.post<KnowledgeFile>(`/api/v1/knowledge/${file.id}/retry`, {});
      setFiles((current) => current.map((item) => item.id === file.id ? updated : item));
      showToast("已重新加入处理队列", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "重试失败", "error");
    }
  }

  async function deleteFile(file: KnowledgeFile) {
    const confirmed = await confirmAction({
      title: "删除资料",
      description: `将永久删除“${file.name}”及其索引内容。`,
      confirmLabel: "删除资料",
      tone: "danger",
    });
    if (!confirmed) return;
    setDeletingFileId(file.id);
    try {
      await api.del(`/api/v1/knowledge/${file.id}`);
      setFiles((current) => current.filter((item) => item.id !== file.id));
      showToast("资料已删除", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "删除失败", "error");
    } finally {
      setDeletingFileId(null);
    }
  }

  async function uploadToKnowledgeBase() {
    if (!uploadFile || uploading) return;
    setUploading(true);
    const body = new FormData();
    body.append("file", uploadFile);
    body.append("kb_id", kbId);
    try {
      const saved = await api.upload<KnowledgeFile>("/api/v1/knowledge/upload", body);
      setFiles((current) => [saved, ...current]);
      setUploadOpen(false);
      setUploadFile(null);
      showToast("资料已上传，正在建立索引", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "上传失败", "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function importUrl() {
    if (!url.trim() || urlImporting) return;
    setUrlImporting(true);
    try {
      const saved = await api.post<KnowledgeFile>("/api/v1/knowledge/url", { url: url.trim(), kb_id: kbId, goal_id: null });
      setFiles((current) => [saved, ...current]);
      setUrlOpen(false);
      setUrl("");
      showToast("网址已导入，正在建立索引", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "网址导入失败", "error");
    } finally {
      setUrlImporting(false);
    }
  }

  if (loading) return <div className="flex h-full items-center justify-center text-sm text-gray-400">正在加载知识库…</div>;
  if (!knowledgeBase) return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-gray-400">
      <BookOpen size={28} />
      <p>知识库不存在或已被删除</p>
      <Link href="/work/knowledge" className="font-medium" style={{ color: "var(--accent)" }}>返回资料空间</Link>
    </div>
  );

  return (
    <div className="knowledge-page knowledge-detail-page flex h-full flex-col overflow-hidden">
      <header className="knowledge-detail-header">
        <Link href="/work/knowledge" className="knowledge-back-link"><ArrowLeft size={15} />资料空间</Link>
        <div className="knowledge-detail-title-row">
          <div className="knowledge-hero-icon"><BookOpen size={18} /></div>
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="max-w-xl space-y-2">
                <input value={editName} onChange={(event) => setEditName(event.target.value)} className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-semibold outline-none focus:border-accent" />
                <input value={editDescription} onChange={(event) => setEditDescription(event.target.value)} placeholder="知识库说明" className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-xs outline-none focus:border-accent" />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-lg font-semibold text-gray-900">{knowledgeBase.name}</h1>
                  <StatusBadge tone="neutral" compact>知识库</StatusBadge>
                </div>
                <p className="mt-0.5 truncate text-xs text-gray-400">{knowledgeBase.description || "尚未添加知识库说明"}</p>
              </>
            )}
          </div>
          <div className="knowledge-hero-actions">
            {editing ? (
              <>
                <button onClick={() => setEditing(false)} className="knowledge-secondary-button">取消</button>
                <button onClick={saveDetails} disabled={saving || !editName.trim()} className="knowledge-primary-button disabled:opacity-40">{saving ? "保存中" : "保存"}</button>
              </>
            ) : (
              <>
                <button onClick={() => setEditing(true)} className="knowledge-secondary-button"><Pencil size={14} />编辑</button>
                <button onClick={() => setUrlOpen(true)} className="knowledge-secondary-button"><Link2 size={14} />导入网址</button>
                <button onClick={() => setUploadOpen(true)} className="knowledge-primary-button"><Upload size={14} />上传资料</button>
              </>
            )}
          </div>
        </div>
        <div className="knowledge-metrics" aria-label="知识库处理概览">
          <div className="knowledge-metric"><span className="knowledge-metric-label">全部资料</span><strong>{files.length}</strong></div>
          <div className="knowledge-metric is-success"><span className="knowledge-metric-dot" /><span className="knowledge-metric-label">可用于 AI</span><strong>{readyCount}</strong></div>
          <div className="knowledge-metric is-progress"><span className="knowledge-metric-dot" /><span className="knowledge-metric-label">处理中</span><strong>{processingCount}</strong></div>
          <div className="knowledge-metric is-danger"><span className="knowledge-metric-dot" /><span className="knowledge-metric-label">需处理</span><strong>{failedCount}</strong></div>
          <button onClick={deleteKnowledgeBase} className="knowledge-delete-library"><Trash2 size={12} />删除知识库</button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-white">
        <div className="knowledge-resource-toolbar">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><h2 className="text-base font-semibold text-gray-800">资料内容</h2><span className="pp-count-badge">{filteredFiles.length}</span></div>
            <p className="mt-0.5 text-xs text-gray-400">仅显示当前知识库中的资料</p>
          </div>
          <div className="knowledge-toolbar-actions">
            <div className="knowledge-search relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前知识库…" className="w-full rounded-xl border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none focus:border-accent" />
            </div>
            <div className="knowledge-view-switch flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5">
              <button onClick={() => setView("list")} aria-label="列表视图" className={cn("flex h-8 w-8 items-center justify-center rounded-md", view === "list" ? "bg-white shadow-sm text-gray-700" : "text-gray-400")}><List size={14} /></button>
              <button onClick={() => setView("grid")} aria-label="卡片视图" className={cn("flex h-8 w-8 items-center justify-center rounded-md", view === "grid" ? "bg-white shadow-sm text-gray-700" : "text-gray-400")}><LayoutGrid size={14} /></button>
            </div>
          </div>
        </div>

        {filteredFiles.length === 0 ? (
          <div className="knowledge-empty-state">
            <div className="knowledge-empty-icon"><FileText size={17} /></div>
            <div className="min-w-0"><p className="text-sm font-semibold text-gray-700">当前知识库还没有资料</p><p className="mt-0.5 text-xs text-gray-400">上传文件或导入网页后，AI 助教就能检索这里的内容。</p></div>
            <button onClick={() => setUploadOpen(true)} className="knowledge-empty-action"><Upload size={12} />添加资料</button>
          </div>
        ) : view === "grid" ? (
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {filteredFiles.map((file) => (
              <article key={file.id} className="knowledge-file-card group rounded-2xl border p-4">
                <div className="mb-3 flex items-start gap-3"><div className="knowledge-file-icon flex h-9 w-9 items-center justify-center rounded-xl"><FileIcon type={file.type} /></div><p className="min-w-0 flex-1 line-clamp-2 text-sm font-medium text-gray-800">{file.name}</p><button onClick={() => deleteFile(file)} aria-label={`删除 ${file.name}`} className="pp-icon-action rounded-lg p-1"><Trash2 size={13} /></button></div>
                <div className="mb-2 flex items-center justify-between text-xs text-gray-400"><span>{file.size}</span><span>{file.uploadDate}</span></div>
                <ProcessingStatus file={file} onRetry={() => retryFile(file)} />
              </article>
            ))}
          </div>
        ) : (
          <div className="knowledge-list">
            <div className="knowledge-list-head grid grid-cols-12 px-4 py-2.5 text-[11px] font-medium text-gray-400"><div className="col-span-6">资料</div><div className="col-span-3">处理状态</div><div className="col-span-2">更新</div><div className="col-span-1" /></div>
            {filteredFiles.map((file) => (
              <div key={file.id} className="knowledge-file-row group grid grid-cols-12 items-center px-4 py-3">
                <div className="col-span-6 flex min-w-0 items-center gap-3"><div className="knowledge-file-icon flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"><FileIcon type={file.type} /></div><div className="min-w-0"><p className="truncate text-sm font-medium text-gray-800">{file.name}</p><p className="mt-0.5 text-[11px] text-gray-400">{file.size}</p></div></div>
                <div className="col-span-3"><ProcessingStatus file={file} onRetry={() => retryFile(file)} /></div>
                <div className="col-span-2 text-xs text-gray-400">{file.uploadDate}</div>
                <div className="col-span-1 flex justify-end"><button onClick={() => deleteFile(file)} disabled={deletingFileId === file.id} aria-label={`删除 ${file.name}`} className="pp-icon-action knowledge-row-action flex h-8 w-8 items-center justify-center rounded-lg"><Trash2 size={13} /></button></div>
              </div>
            ))}
          </div>
        )}
      </main>

      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm" onClick={() => setUploadOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="上传知识库资料" className="journal-dialog w-full max-w-md rounded-2xl border border-gray-100 bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-5 flex items-center justify-between"><div><h2 className="text-base font-semibold text-gray-800">上传到 {knowledgeBase.name}</h2><p className="mt-1 text-xs text-gray-400">文件会自动归入当前知识库</p></div><button onClick={() => setUploadOpen(false)} aria-label="关闭" className="pp-icon-action rounded-lg p-1"><X size={17} /></button></div>
            <button onClick={() => fileInputRef.current?.click()} className="w-full rounded-xl border-2 border-dashed border-gray-200 px-4 py-8 text-center"><Upload size={21} className="mx-auto mb-2 text-gray-300" /><p className="text-sm text-gray-600">{uploadFile?.name || "点击选择文件"}</p><p className="mt-1 text-xs text-gray-400">支持 PDF、Word、Excel、文本和图片</p></button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} />
            <div className="mt-5 flex justify-end gap-2"><button onClick={() => setUploadOpen(false)} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-500">取消</button><button onClick={uploadToKnowledgeBase} disabled={!uploadFile || uploading} className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40" style={{ backgroundColor: "var(--accent)" }}>{uploading ? "上传中" : "开始上传"}</button></div>
          </div>
        </div>
      )}

      {urlOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm" onClick={() => setUrlOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="导入网址到知识库" className="journal-dialog w-full max-w-md rounded-2xl border border-gray-100 bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-5 flex items-center justify-between"><div><h2 className="text-base font-semibold text-gray-800">导入网页</h2><p className="mt-1 text-xs text-gray-400">网页内容会归入 {knowledgeBase.name}</p></div><button onClick={() => setUrlOpen(false)} aria-label="关闭" className="pp-icon-action rounded-lg p-1"><X size={17} /></button></div>
            <label className="mb-1.5 block text-xs font-semibold text-gray-500">网页地址</label>
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/article" className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-accent" />
            <div className="mt-5 flex justify-end gap-2"><button onClick={() => setUrlOpen(false)} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-500">取消</button><button onClick={importUrl} disabled={!url.trim() || urlImporting} className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-40" style={{ backgroundColor: "var(--accent)" }}>{urlImporting ? "导入中" : "开始导入"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
