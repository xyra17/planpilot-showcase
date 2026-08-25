"use client";

import {
  AlertCircle,
  ArrowUpRight,
  Bookmark,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  CloudUpload,
  Download,
  FileImage,
  FileCheck2,
  FilePenLine,
  FileText,
  Filter,
  FolderInput,
  FolderOpen,
  Globe2,
  Heading1,
  Link2,
  LoaderCircle,
  MessageCircle,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Tags,
  Target,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useAuth } from "@/components/technology/AuthProvider";
import { WorkspaceSkeleton } from "@/components/technology/WorkspaceSkeleton";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataSyncNotice } from "@/components/ui/DataSyncNotice";
import { signalPiloContext } from "@/lib/technology/piloContext";
import { signalPiloState } from "@/lib/technology/piloState";
import {
  productApi,
  type ApiGoal,
  type ApiKnowledgeFile,
  type ApiKnowledgeFileVersion,
} from "@/lib/technology/productApi";
import { readScopedJson, writeScopedJson } from "@/lib/technology/scopedStorage";
import { GUEST_RESOURCES, guestApiGoals } from "@/lib/technology/guestData";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
} from "react";

const NotionResourceEditor = dynamic(
  () => import("@/components/technology/NotionResourceEditor"),
  {
    ssr: false,
    loading: () => <WorkspaceSkeleton variant="editor" label="正在准备资料编辑器" />,
  },
);

type Resource = {
  id: number | string;
  name: string;
  type: string;
  library: string;
  libraries: string[];
  status: "可用于 AI" | "处理中";
  updated: string;
  summary: string;
  size?: string;
  mime?: string;
  url?: string;
  content?: string;
  contentFormat?: "plain" | "markdown" | "html";
  source: "sample" | "upload" | "url";
  isDemo?: boolean;
  kbId?: string;
  kbIds: string[];
  goalIds: string[];
  goalTitles: string[];
  processingStatus?: string;
  processingError?: string | null;
};

type UploadQueueItem = {
  id: string;
  file: File;
  status: "ready" | "uploading" | "error";
  error?: string;
  errorKind?: "validation" | "upload";
};

const INITIAL_FILES: Resource[] = GUEST_RESOURCES.map((resource) => ({
  ...resource,
  libraries: [...resource.libraries],
  goalIds: [...resource.goalIds],
  goalTitles: [...resource.goalTitles],
  kbIds: [],
  contentFormat: "contentFormat" in resource ? resource.contentFormat as Resource["contentFormat"] : undefined,
}));

const INITIAL_GOAL_OPTIONS: ApiGoal[] = guestApiGoals();
const GUEST_LIBRARIES: string[] = Array.from(new Set(GUEST_RESOURCES.flatMap((resource) => [...resource.libraries])));

function isUnlinkedResource(resource: Resource) {
  return resource.goalIds.length === 0
    && resource.kbIds.length === 0
    && resource.libraries.length === 0;
}

function getFileType(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (file.type === "application/pdf" || extension === "pdf") return "PDF";
  if (file.type.startsWith("image/")) return "图片";
  if (extension === "md" || extension === "markdown") return "Markdown";
  if (file.type.startsWith("text/") || ["txt", "csv", "json", "js", "ts", "tsx", "html", "css"].includes(extension ?? "")) {
    return "文本";
  }
  if (["doc", "docx"].includes(extension ?? "")) return "Word";
  if (["xls", "xlsx"].includes(extension ?? "")) return "表格";
  if (["ppt", "pptx"].includes(extension ?? "")) return "演示文稿";
  return extension?.toUpperCase() || "文件";
}

function apiFileType(type: string) {
  const normalized = type.toLowerCase();
  if (normalized === "pdf") return "PDF";
  if (normalized === "md") return "Markdown";
  if (normalized === "txt") return "文本";
  if (normalized === "url") return "网页";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(normalized)) return "图片";
  if (normalized === "docx" || normalized === "doc") return "Word";
  if (normalized === "excel" || normalized === "xlsx" || normalized === "csv") return "表格";
  if (normalized === "pptx" || normalized === "ppt") return "演示文稿";
  return type.toUpperCase();
}

function resourceFromApi(
  file: ApiKnowledgeFile,
  librariesById: Map<string, string>,
  goalsById: Map<string, string>,
  goalIdsByLibraryId: Map<string, string>,
): Resource {
  const source = file.type.toLowerCase() === "url" ? "url" : "upload";
  const rawKbIds = Array.from(new Set(file.kbIds?.length ? file.kbIds : file.kbId ? [file.kbId] : []));
  const goalIds = Array.from(new Set([
    ...file.goalIds,
    ...rawKbIds.map((id) => goalIdsByLibraryId.get(id)).filter((id): id is string => Boolean(id)),
  ]));
  const kbIds = rawKbIds.filter((id) => librariesById.has(id));
  const linkedLibraries = kbIds.map((id) => librariesById.get(id)).filter((name): name is string => Boolean(name));
  return {
    id: file.id,
    name: file.name,
    type: apiFileType(file.type),
    library: linkedLibraries[0] ?? "未归档",
    libraries: linkedLibraries,
    kbId: kbIds[0],
    kbIds,
    goalIds,
    goalTitles: goalIds.map((id) => goalsById.get(id) ?? "已删除目标"),
    status: file.status === "ready" ? "可用于 AI" : "处理中",
    updated: file.uploadDate || "刚刚",
    size: file.size,
    source,
    url: file.sourceUrl ?? undefined,
    summary: file.summary || (file.status === "ready"
      ? "这份资料已完成索引，可由学习伙伴检索和引用。"
      : "资料正在解析与建立索引，完成后即可用于学习伙伴。"),
    processingStatus: file.status,
    processingError: file.error,
    content: file.content,
    contentFormat: file.contentFormat ?? (file.type.toLowerCase() === "md" ? "markdown" : "plain"),
  };
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  "pdf", "png", "jpg", "jpeg", "webp", "gif", "md", "markdown", "txt", "csv", "json", "docx", "xlsx", "pptx",
]);

function uploadFileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function validateUploadFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension) && !file.type.startsWith("text/") && !file.type.startsWith("image/") && file.type !== "application/pdf") {
    return "暂不支持这种文件格式";
  }
  if (file.size === 0) return "文件内容为空";
  return "";
}

function isTextResource(resource: Resource) {
  return resource.type === "文本" || resource.type === "Markdown" || resource.type === "笔记";
}

function isMarkdownResource(resource: Resource) {
  return resource.type === "Markdown" || resource.contentFormat === "markdown";
}

function resourceToEditingDraft(resource: Resource): Resource {
  if (isMarkdownResource(resource)) {
    return { ...resource, content: resource.content || "", contentFormat: "markdown" };
  }
  if (isTextResource(resource)) {
    return {
      ...resource,
      content: resource.content || (resource.contentFormat === "html" ? "<p></p>" : ""),
      contentFormat: resource.contentFormat === "html" ? "html" : "plain",
    };
  }
  return { ...resource };
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <article className="markdown-document-preview github-markdown-preview">
      {content.trim() ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            a: ({ node, ...props }) => {
              void node;
              return <a {...props} target="_blank" rel="noreferrer" />;
            },
            input: ({ node, ...props }) => {
              void node;
              return <input {...props} disabled />;
            },
          }}
        >
          {content}
        </ReactMarkdown>
      ) : <p>这份 Markdown 暂无内容。</p>}
    </article>
  );
}

function ResourceGlyph({ type }: { type: string }) {
  if (type === "图片") return <FileImage size={17} />;
  if (type === "Markdown" || type === "文本" || type === "笔记") return <FilePenLine size={17} />;
  if (type === "网页") return <Globe2 size={17} />;
  return <FileText size={17} />;
}

export default function KnowledgePage() {
  const { status: authStatus, user, updateProfile } = useAuth();
  const { confirmAction } = useConfirmDialog();
  const [files, setFiles] = useState<Resource[]>([]);
  const [query, setQuery] = useState("");
  const [goalFilter, setGoalFilter] = useState("all");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "processing">("all");
  const [importMode, setImportMode] = useState<"url" | "upload" | null>(null);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [authPromptOpen, setAuthPromptOpen] = useState(false);
  const [authPromptIntent, setAuthPromptIntent] = useState("保存学习资料");
  const [resourceName, setResourceName] = useState("");
  const [resourceUrl, setResourceUrl] = useState("");
  const [libraries, setLibraries] = useState(GUEST_LIBRARIES);
  const [libraryIds, setLibraryIds] = useState<Record<string, string>>({});
  const [goalIdsByKbId, setGoalIdsByKbId] = useState<Record<string, string>>({});
  const [goalOptions, setGoalOptions] = useState<ApiGoal[]>(INITIAL_GOAL_OPTIONS);
  const [library, setLibrary] = useState("");
  const [importLibraryIds, setImportLibraryIds] = useState<string[]>([]);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadAnnouncement, setUploadAnnouncement] = useState("");
  const [importGoalsExpanded, setImportGoalsExpanded] = useState(true);
  const [importLibrariesExpanded, setImportLibrariesExpanded] = useState(false);

  useEffect(() => {
    const linkedQuery = new URLSearchParams(window.location.search).get("query")?.trim();
    if (linkedQuery) setQuery(linkedQuery);
  }, []);
  const [importGoalIds, setImportGoalIds] = useState<string[]>([]);
  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const [newLibraryName, setNewLibraryName] = useState("");
  const [newLibraryDescription, setNewLibraryDescription] = useState("");
  const [editingLibraryName, setEditingLibraryName] = useState<string | null>(null);
  const [libraryNameDraft, setLibraryNameDraft] = useState("");
  const [selectedId, setSelectedId] = useState<number | string | null>(null);
  const [editing, setEditing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [infoPaneWidth, setInfoPaneWidth] = useState(330);
  const [infoPaneCollapsed, setInfoPaneCollapsed] = useState(false);
  const [draft, setDraft] = useState<Resource | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [resourceSaving, setResourceSaving] = useState(false);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [archiveExpanded, setArchiveExpanded] = useState(true);
  const [archiveGoalsExpanded, setArchiveGoalsExpanded] = useState(true);
  const [archiveLibrariesExpanded, setArchiveLibrariesExpanded] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [localEditOpen, setLocalEditOpen] = useState(false);
  const [fileVersions, setFileVersions] = useState<ApiKnowledgeFileVersion[]>([]);
  const [versionLoading, setVersionLoading] = useState(false);
  const [replacementSaving, setReplacementSaving] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [toast, setToast] = useState("");
  const [selectedRows, setSelectedRows] = useState<Set<Resource["id"]>>(new Set());
  const [batchMenuOpen, setBatchMenuOpen] = useState(false);
  const [favorites, setFavorites] = useState<Set<Resource["id"]>>(new Set());
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [recentResourceIds, setRecentResourceIds] = useState<Resource["id"][]>([]);
  const [sortMode, setSortMode] = useState<"newest" | "recent">("newest");
  const [insightMode, setInsightMode] = useState<"summary" | "citations">("summary");
  const [aiAssistExpanded, setAiAssistExpanded] = useState(false);
  const [libraryValidation, setLibraryValidation] = useState("");
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState("");
  const [classificationSplit, setClassificationSplit] = useState(50);
  const [railWidth, setRailWidth] = useState(208);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replacementInputRef = useRef<HTMLInputElement>(null);
  const objectUrls = useRef<string[]>([]);
  const resourceSavingRef = useRef(false);
  const scrollbarHideTimersRef = useRef<Map<HTMLElement, number>>(new Map());
  const infoPaneResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const classificationSplitRef = useRef<HTMLDivElement>(null);
  const classificationResizeRef = useRef(false);
  const railResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const clampInfoPaneWidth = useCallback((width: number) => Math.min(460, Math.max(280, width)), []);
  const goalIdsByKbIdMap = useMemo(() => new Map(Object.entries(goalIdsByKbId)), [goalIdsByKbId]);

  const startInfoPaneResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (infoPaneCollapsed || event.button !== 0) return;
    infoPaneResizeRef.current = { startX: event.clientX, startWidth: infoPaneWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [infoPaneCollapsed, infoPaneWidth]);

  const resizeInfoPaneByKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setInfoPaneCollapsed(false);
    setInfoPaneWidth((current) => clampInfoPaneWidth(current + (event.key === "ArrowLeft" ? 20 : -20)));
  }, [clampInfoPaneWidth]);

  useEffect(() => {
    const resizeInfoPane = (event: PointerEvent) => {
      const resize = infoPaneResizeRef.current;
      if (!resize) return;
      setInfoPaneWidth(clampInfoPaneWidth(resize.startWidth - (event.clientX - resize.startX)));
    };
    const finishInfoPaneResize = () => {
      if (!infoPaneResizeRef.current) return;
      infoPaneResizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const keepMobileInfoPaneOpen = () => {
      if (window.innerWidth <= 960) setInfoPaneCollapsed(false);
    };
    window.addEventListener("pointermove", resizeInfoPane);
    window.addEventListener("pointerup", finishInfoPaneResize);
    window.addEventListener("pointercancel", finishInfoPaneResize);
    window.addEventListener("resize", keepMobileInfoPaneOpen);
    return () => {
      window.removeEventListener("pointermove", resizeInfoPane);
      window.removeEventListener("pointerup", finishInfoPaneResize);
      window.removeEventListener("pointercancel", finishInfoPaneResize);
      window.removeEventListener("resize", keepMobileInfoPaneOpen);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [clampInfoPaneWidth]);

  const startClassificationResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    classificationResizeRef.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resizeClassificationByKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setClassificationSplit((current) => Math.min(75, Math.max(25, current + (event.key === "ArrowDown" ? 5 : -5))));
  }, []);

  const startRailResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    railResizeRef.current = { startX: event.clientX, startWidth: railWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [railWidth]);

  const resizeRailByKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setRailWidth((current) => Math.min(340, Math.max(180, current + (event.key === "ArrowRight" ? 20 : -20))));
  }, []);

  useEffect(() => {
    const resizeClassification = (event: PointerEvent) => {
      if (!classificationResizeRef.current || !classificationSplitRef.current) return;
      const bounds = classificationSplitRef.current.getBoundingClientRect();
      if (!bounds.height) return;
      const next = ((event.clientY - bounds.top) / bounds.height) * 100;
      setClassificationSplit(Math.min(75, Math.max(25, next)));
    };
    const finishClassificationResize = () => {
      if (!classificationResizeRef.current) return;
      classificationResizeRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", resizeClassification);
    window.addEventListener("pointerup", finishClassificationResize);
    window.addEventListener("pointercancel", finishClassificationResize);
    return () => {
      window.removeEventListener("pointermove", resizeClassification);
      window.removeEventListener("pointerup", finishClassificationResize);
      window.removeEventListener("pointercancel", finishClassificationResize);
      if (classificationResizeRef.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, []);

  useEffect(() => {
    const moveRail = (event: PointerEvent) => {
      const resize = railResizeRef.current;
      if (!resize) return;
      setRailWidth(Math.min(340, Math.max(180, resize.startWidth + event.clientX - resize.startX)));
    };
    const finishRailResize = () => {
      if (!railResizeRef.current) return;
      railResizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", moveRail);
    window.addEventListener("pointerup", finishRailResize);
    window.addEventListener("pointercancel", finishRailResize);
    return () => {
      window.removeEventListener("pointermove", moveRail);
      window.removeEventListener("pointerup", finishRailResize);
      window.removeEventListener("pointercancel", finishRailResize);
    };
  }, []);

  function revealScrollbarWhileScrolling(event: UIEvent<HTMLElement>) {
    const container = event.currentTarget;
    const previousTimer = scrollbarHideTimersRef.current.get(container);
    if (previousTimer) window.clearTimeout(previousTimer);
    container.classList.add("is-scrolling");
    const nextTimer = window.setTimeout(() => {
      container.classList.remove("is-scrolling");
      scrollbarHideTimersRef.current.delete(container);
    }, 720);
    scrollbarHideTimersRef.current.set(container, nextTimer);
  }

  function updateNavTooltip(event: ReactMouseEvent<HTMLButtonElement>, label: string, count: number) {
    const labelElement = event.currentTarget.querySelector<HTMLElement>(".knowledge-nav-label");
    const labelIsTruncated = Boolean(labelElement && labelElement.scrollWidth > labelElement.clientWidth + 1);
    event.currentTarget.title = labelIsTruncated ? `${label} · ${count} 项资料` : `${count} 项资料`;
  }

  const selected = files.find((file) => file.id === selectedId) ?? null;
  const selectedGoal = useMemo(
    () => goalOptions.find((goal) => goal.id === goalFilter) ?? null,
    [goalFilter, goalOptions],
  );
  const visibleFiles = useMemo(
    () => {
      const matched = files.filter((file) => {
        const matchesGoal = goalFilter === "all"
          || (goalFilter === "unlinked" ? isUnlinkedResource(file) : file.goalIds.includes(goalFilter));
        const matchesLibrary = libraryFilter === "all" || file.libraries.includes(libraryFilter);
        const matchesType = typeFilter === "all" || file.type === typeFilter;
        const matchesStatus = statusFilter === "all"
          || (statusFilter === "ready" ? file.status === "可用于 AI" : file.status === "处理中");
        const matchesQuery = `${file.name}${file.type}${file.library}${file.goalTitles.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase());
        const matchesFavorite = !favoritesOnly || favorites.has(file.id);
        return matchesGoal && matchesLibrary && matchesType && matchesStatus && matchesQuery && matchesFavorite;
      });
      const ordered = [...matched].sort((a, b) => Number(isUnlinkedResource(a)) - Number(isUnlinkedResource(b)));
      if (sortMode === "recent") {
        const position = new Map(recentResourceIds.map((id, index) => [id, index]));
        return ordered.sort((a, b) => {
          const unlinkedOrder = Number(isUnlinkedResource(a)) - Number(isUnlinkedResource(b));
          return unlinkedOrder || (position.get(a.id) ?? 9999) - (position.get(b.id) ?? 9999);
        });
      }
      return ordered;
    },
    [favorites, favoritesOnly, files, goalFilter, libraryFilter, query, recentResourceIds, sortMode, statusFilter, typeFilter],
  );

  const scopeFiles = useMemo(() => files.filter((file) => {
    const matchesGoal = goalFilter === "all"
      || (goalFilter === "unlinked" ? isUnlinkedResource(file) : file.goalIds.includes(goalFilter));
    const matchesLibrary = libraryFilter === "all" || file.libraries.includes(libraryFilter);
    return matchesGoal && matchesLibrary;
  }), [files, goalFilter, libraryFilter]);
  const scopeLabel = selectedGoal?.title
    ?? (libraryFilter !== "all" ? libraryFilter : goalFilter === "unlinked" ? "未关联资料" : "全部资料");
  const scopeDescription = selectedGoal
    ? "这里的资料已关联到当前学习目标。"
    : libraryFilter !== "all"
      ? "文件夹只负责归档，不会改变资料关联的目标。"
      : goalFilter === "unlinked"
      ? "这些资料既未关联学习目标，也未放入个人文件夹。"
        : "学习目标与个人文件夹是两套独立分类方式，可单独使用，也可同时关联。";
  const scopeControlValue = goalFilter === "unlinked"
    ? "unlinked"
    : goalFilter !== "all"
      ? `goal:${goalFilter}`
      : libraryFilter !== "all"
        ? `folder:${libraryFilter}`
        : "all";
  const readyCount = scopeFiles.filter((file) => file.status === "可用于 AI").length;
  const resourceTypes = useMemo(() => Array.from(new Set(files.map((file) => file.type))), [files]);
  const hasActiveFilters = goalFilter !== "all"
    || libraryFilter !== "all"
    || typeFilter !== "all"
    || statusFilter !== "all"
    || favoritesOnly
    || sortMode !== "newest"
    || Boolean(query.trim());

  useEffect(() => {
    signalPiloContext({ kind: "scope", surface: "knowledge", itemCount: files.length });
  }, [files.length]);

  useEffect(() => {
    if (authStatus === "unauthenticated") {
      setFiles(INITIAL_FILES);
      setGoalOptions(INITIAL_GOAL_OPTIONS);
      setLibraries(GUEST_LIBRARIES);
      setGoalIdsByKbId({});
      return;
    }
    if (authStatus === "authenticated") setFiles([]);
  }, [authStatus]);

  useEffect(() => {
    if (authStatus !== "authenticated") return;
    let cancelled = false;
    setFiles([]);
    setDataLoading(true);
    setDataError("");
    void Promise.all([
      productApi.listKnowledgeBases(),
      productApi.listKnowledgeFiles(),
      productApi.listGoals(),
    ]).then(([apiLibraries, apiFiles, apiGoals]) => {
      if (cancelled) return;
      const goalIdsByLibraryId = new Map<string, string>();
      apiLibraries.forEach((item) => {
        if (item.goal_id) goalIdsByLibraryId.set(item.id, item.goal_id);
      });
      apiGoals.forEach((goal) => {
        if (goal.kb_id) goalIdsByLibraryId.set(goal.kb_id, goal.id);
      });
      const personalLibraries = apiLibraries.filter((item) => !goalIdsByLibraryId.has(item.id));
      const namesById = new Map(personalLibraries.map((item) => [item.id, item.name]));
      const idsByName = Object.fromEntries(personalLibraries.map((item) => [item.name, item.id]));
      const goalsById = new Map(apiGoals.map((item) => [item.id, item.title]));
      const nextLibraries = personalLibraries.map((item) => item.name);
      setLibraries(nextLibraries);
      setLibraryIds(idsByName);
      setGoalIdsByKbId(Object.fromEntries(goalIdsByLibraryId));
      setGoalOptions(apiGoals);
      setFiles(apiFiles.map((item) => resourceFromApi(item, namesById, goalsById, goalIdsByLibraryId)));
      setLibraryFilter((current) =>
        current !== "all" && !nextLibraries.includes(current) ? "all" : current,
      );
      setGoalFilter((current) =>
        current !== "all" && current !== "unlinked" && !apiGoals.some((goal) => goal.id === current)
          ? "all"
          : current,
      );
      setLibrary((current) => nextLibraries.includes(current) ? current : "");
    }).catch((reason) => {
      if (!cancelled) setDataError(reason instanceof Error ? reason.message : "知识空间同步失败");
    }).finally(() => {
      if (!cancelled) setDataLoading(false);
    });
    return () => { cancelled = true; };
  }, [authStatus]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !selected || typeof selected.id !== "string" || selected.source !== "upload" || selected.url) return;
    let cancelled = false;
    setPreviewLoading(true);
    void productApi.fetchKnowledgeFile(selected.id).then((blob) => {
      if (cancelled) return;
      const url = URL.createObjectURL(blob);
      objectUrls.current.push(url);
      setFiles((current) => current.map((file) => file.id === selected.id ? { ...file, url } : file));
      setDraft((current) => current?.id === selected.id ? { ...current, url } : current);
    }).catch((reason) => {
      if (!cancelled) setDataError(reason instanceof Error ? reason.message : "文件预览加载失败");
    }).finally(() => {
      if (!cancelled) setPreviewLoading(false);
    });
    return () => { cancelled = true; };
  }, [authStatus, selected]);

  useEffect(() => {
    try {
      const accountFavorites = user?.account_preferences?.knowledge_favorites;
      const savedFavorites = Array.isArray(accountFavorites)
        ? accountFavorites
        : readScopedJson<Resource["id"][]>("knowledge-favorites", user?.id, [], user ? undefined : "planpilot-knowledge-favorites");
      const savedRecent = readScopedJson<Resource["id"][]>("knowledge-recent", user?.id, [], user ? undefined : "planpilot-knowledge-recent");
      if (Array.isArray(savedFavorites)) {
        setFavorites((current) => {
          const currentIds = Array.from(current);
          return JSON.stringify(currentIds) === JSON.stringify(savedFavorites)
            ? current
            : new Set(savedFavorites);
        });
      }
      if (Array.isArray(savedRecent)) setRecentResourceIds(savedRecent);
    } catch {
      // Ignore stale local preference data.
    }
  }, [user, user?.account_preferences?.knowledge_favorites, user?.id]);

  useEffect(() => {
    const nextFavorites = Array.from(favorites);
    writeScopedJson("knowledge-favorites", user?.id, nextFavorites, user ? undefined : "planpilot-knowledge-favorites");
    if (authStatus !== "authenticated") return;
    const accountFavorites = user?.account_preferences?.knowledge_favorites;
    if (Array.isArray(accountFavorites) && JSON.stringify(accountFavorites) === JSON.stringify(nextFavorites)) return;
    const timer = window.setTimeout(() => {
      void updateProfile({ account_preferences: { knowledge_favorites: nextFavorites } });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [authStatus, favorites, updateProfile, user, user?.account_preferences?.knowledge_favorites, user?.id]);

  useEffect(() => {
    writeScopedJson("knowledge-recent", user?.id, recentResourceIds, user ? undefined : "planpilot-knowledge-recent");
  }, [authStatus, recentResourceIds, user, user?.id]);

  useEffect(() => {
    const urls = objectUrls.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    const timers = scrollbarHideTimersRef.current;
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (fullscreen) {
          setFullscreen(false);
        } else {
          void closeResource();
        }
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [draftDirty, editing, fullscreen, selected, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps -- handlers intentionally capture the current editor transaction

  useEffect(() => {
    if (!importMode && !libraryDialogOpen && !editingLibraryName && !authPromptOpen) return;

    function closeDialog(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (uploadingFiles) return;
      setImportMode(null);
      setUploadQueue([]);
      setUploadAnnouncement("");
      setLibraryDialogOpen(false);
      setEditingLibraryName(null);
      setAuthPromptOpen(false);
      setDragActive(false);
    }

    window.addEventListener("keydown", closeDialog);
    return () => window.removeEventListener("keydown", closeDialog);
  }, [authPromptOpen, editingLibraryName, importMode, libraryDialogOpen, uploadingFiles]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function goalTitlesForIds(goalIds: string[]) {
    return goalIds.map((goalId) => goalOptions.find((goal) => goal.id === goalId)?.title ?? "已删除目标");
  }

  function requirePersistentAccount(intent: string) {
    if (authStatus === "authenticated") return true;
    if (authStatus === "loading") {
      setToast("正在确认登录状态，请稍候");
      return false;
    }
    setImportMenuOpen(false);
    setAuthPromptIntent(intent);
    setAuthPromptOpen(true);
    return false;
  }

  function openImport(mode: "upload" | "url") {
    if (!requirePersistentAccount(mode === "upload" ? "上传文件并建立索引" : "导入网页并建立索引")) return;
    const destination = libraryFilter !== "all" && libraries.includes(libraryFilter)
      ? libraryFilter
      : "";
    setLibrary(destination);
    setImportLibraryIds(destination && libraryIds[destination] ? [libraryIds[destination]] : []);
    const scopedGoalIds = goalFilter !== "all" && goalFilter !== "unlinked" ? [goalFilter] : [];
    setImportGoalIds(scopedGoalIds);
    setUploadQueue([]);
    setUploadAnnouncement("");
    setImportGoalsExpanded(false);
    setImportLibrariesExpanded(false);
    setImportMenuOpen(false);
    setImportMode(mode);
  }

  function closeImport() {
    if (uploadingFiles) return;
    setImportMode(null);
    setUploadQueue([]);
    setUploadAnnouncement("");
    setImportLibraryIds([]);
    setImportGoalIds([]);
    setDragActive(false);
  }

  function renderImportDestination() {
    const selectedGoalTitles = goalTitlesForIds(importGoalIds);
    const selectedLibraryNames = libraries.filter((name) => importLibraryIds.includes(libraryIds[name] ?? name));
    const selectedDestinations = [...selectedGoalTitles, ...selectedLibraryNames];
    return (
      <div className="resource-import-destination">
        <div className="resource-destination-heading">
          <span className="knowledge-import-step-badge" aria-hidden="true">2</span>
          <div><strong>设置归档位置</strong><p>可关联学习目标和个人文件夹</p></div>
          <span>{selectedDestinations.length ? `已选 ${selectedDestinations.length} 项` : "未关联资料"}</span>
        </div>
        <div className="resource-import-destination-choices">
          <section className="resource-import-destination-section">
            <button type="button" aria-expanded={importGoalsExpanded} aria-controls="resource-import-goals" onClick={() => setImportGoalsExpanded((current) => !current)}>
              <span><Target size={16} /><strong>关联学习目标</strong><small>可选</small></span>
              <em>{importGoalIds.length ? `已选 ${importGoalIds.length} 项` : "选择学习目标"}</em>
              <ChevronRight size={16} className={importGoalsExpanded ? "is-expanded" : ""} />
            </button>
            {importGoalsExpanded && (
              <fieldset id="resource-import-goals" className="resource-destination-group" aria-label="目标分类">
                {goalOptions.map((goal) => <label key={goal.id}><input type="checkbox" checked={importGoalIds.includes(goal.id)} onChange={() => setImportGoalIds((current) => current.includes(goal.id) ? current.filter((id) => id !== goal.id) : [...current, goal.id])} /><span>{goal.title}</span></label>)}
                {!goalOptions.length && <small className="resource-import-empty">还没有目标</small>}
              </fieldset>
            )}
          </section>
          <section className="resource-import-destination-section">
            <button type="button" aria-expanded={importLibrariesExpanded} aria-controls="resource-import-libraries" onClick={() => setImportLibrariesExpanded((current) => !current)}>
              <span><FolderOpen size={16} /><strong>保存到个人文件夹</strong><small>可选</small></span>
              <em>{importLibraryIds.length ? `已选 ${importLibraryIds.length} 项` : "选择文件夹"}</em>
              <ChevronRight size={16} className={importLibrariesExpanded ? "is-expanded" : ""} />
            </button>
            {importLibrariesExpanded && (
              <fieldset id="resource-import-libraries" className="resource-destination-group" aria-label="个人文件夹">
                {libraries.map((name) => {
                  const id = libraryIds[name] ?? name;
                  return <label key={name}><input type="checkbox" checked={importLibraryIds.includes(id)} onChange={() => setImportLibraryIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])} /><span>{name}</span></label>;
                })}
                {!libraries.length && <small className="resource-import-empty">还没有个人文件夹</small>}
              </fieldset>
            )}
          </section>
        </div>
        <small className="resource-import-destination-hint">
          {selectedDestinations.length ? "这些位置只建立索引，之后仍可随时调整。" : "不选择归档位置时，资料会保存到“未关联资料”。"}
        </small>
      </div>
    );
  }

  function clearFilters() {
    setQuery("");
    setGoalFilter("all");
    setLibraryFilter("all");
    setTypeFilter("all");
    setStatusFilter("all");
    setFavoritesOnly(false);
    setSortMode("newest");
  }

  function selectScope(value: string) {
    clearFilters();
    if (value === "unlinked") {
      setGoalFilter("unlinked");
      return;
    }
    if (value.startsWith("goal:")) {
      setGoalFilter(value.slice("goal:".length));
      return;
    }
    if (value.startsWith("folder:")) {
      setLibraryFilter(value.slice("folder:".length));
    }
  }

  function openResource(resource: Resource, startEditing = false) {
    if (startEditing && !requirePersistentAccount("编辑并保存学习资料")) return;
    signalPiloContext({
      kind: startEditing ? "editing" : "object-opened",
      surface: "knowledge",
      objectId: String(resource.id),
      objectTitle: resource.name,
      goalIds: resource.goalIds,
    });
    setRecentResourceIds((current) => [resource.id, ...current.filter((id) => id !== resource.id)].slice(0, 30));
    setSelectedId(resource.id);
    setDraft(startEditing ? resourceToEditingDraft(resource) : { ...resource });
    setEditing(startEditing);
    setDraftDirty(false);
    setFullscreen(false);
    setInfoPaneCollapsed(false);
    setArchiveExpanded(true);
    setArchiveGoalsExpanded(true);
    setArchiveLibrariesExpanded(false);
  }

  function startEditingResource() {
    if (!selected) return;
    if (!requirePersistentAccount("编辑并保存学习资料")) return;
    signalPiloContext({
      kind: "editing",
      surface: "knowledge",
      objectId: String(selected.id),
      objectTitle: selected.name,
      goalIds: selected.goalIds,
    });
    setDraft(resourceToEditingDraft(selected));
    setEditing(true);
    setDraftDirty(false);
  }

  async function closeResource() {
    if (resourceSavingRef.current) return;
    if (draftDirty) {
      const saved = await saveResource();
      if (!saved) return;
    }
    setLocalEditOpen(false);
    setFullscreen(false);
    setEditing(false);
    setDraftDirty(false);
    setSelectedId(null);
  }

  async function persistResourceMetadata(nextResource: Resource, successMessage: string) {
    signalPiloState("working", { source: "knowledge:metadata" });
    setMetadataSaving(true);
    let saved: Resource = { ...nextResource, updated: "刚刚" };
    try {
      if (authStatus === "authenticated" && typeof nextResource.id === "string") {
        const updated = await productApi.updateKnowledgeFile(nextResource.id, {
          kb_ids: nextResource.kbIds,
          goal_ids: nextResource.goalIds,
        });
        saved = {
          ...nextResource,
          ...resourceFromApi(
            updated,
            new Map(Object.entries(libraryIds).map(([name, id]) => [id, name])),
            new Map(goalOptions.map((goal) => [goal.id, goal.title])),
            goalIdsByKbIdMap,
          ),
          content: nextResource.content,
          contentFormat: nextResource.contentFormat,
        };
      }
      setFiles((current) => current.map((file) => file.id === saved.id ? saved : file));
      setDraft(saved);
      setToast(successMessage);
      signalPiloState("success", { source: "knowledge:metadata", duration: 3_400 });
    } catch (reason) {
      signalPiloState("failure", { source: "knowledge:metadata", duration: 4_200 });
      setDataError(reason instanceof Error ? reason.message : "资料信息保存失败");
    } finally {
      setMetadataSaving(false);
    }
  }

  function togglePreviewDestination(kind: "goal" | "library", id: string) {
    if (!draft || metadataSaving) return;
    if (!requirePersistentAccount("保存资料的归档与目标关联")) return;
    const nextGoalIds = kind === "goal"
      ? (draft.goalIds.includes(id) ? draft.goalIds.filter((value) => value !== id) : [...draft.goalIds, id])
      : draft.goalIds;
    const nextKbIds = kind === "library"
      ? (draft.kbIds.includes(id) ? draft.kbIds.filter((value) => value !== id) : [...draft.kbIds, id])
      : draft.kbIds;
    const namesById = new Map(Object.entries(libraryIds).map(([name, value]) => [value, name]));
    const nextLibraries = nextKbIds.map((value) => namesById.get(value)).filter((name): name is string => Boolean(name));
    void persistResourceMetadata({
      ...draft,
      goalIds: nextGoalIds,
      goalTitles: goalTitlesForIds(nextGoalIds),
      kbIds: nextKbIds,
      kbId: nextKbIds[0],
      libraries: nextLibraries,
      library: nextLibraries[0] ?? "未归档",
    }, "归档索引已更新");
  }

  function downloadResource(resource: Resource) {
    let url = resource.url;
    let generatedUrl = "";
    let filename = resource.name;

    if (isTextResource(resource)) {
      const content = resource.content || resource.summary || "";
      const mime = resource.contentFormat === "html"
        ? "text/html;charset=utf-8"
        : resource.type === "Markdown"
          ? "text/markdown;charset=utf-8"
          : "text/plain;charset=utf-8";
      const hasExtension = /\.[a-z0-9]+$/i.test(filename);
      if (resource.contentFormat === "html") {
        filename = hasExtension ? filename.replace(/\.[a-z0-9]+$/i, ".html") : `${filename}.html`;
      } else if (!hasExtension) {
        filename += resource.type === "Markdown" ? ".md" : ".txt";
      }
      generatedUrl = URL.createObjectURL(new Blob([content], { type: mime }));
      url = generatedUrl;
    }

    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (generatedUrl) {
      window.setTimeout(() => URL.revokeObjectURL(generatedUrl), 0);
    }
    setToast(`正在下载“${filename}”`);
  }

  async function loadFileVersions(resourceId: string) {
    setVersionLoading(true);
    try {
      setFileVersions(await productApi.listKnowledgeFileVersions(resourceId));
    } catch (reason) {
      setDataError(reason instanceof Error ? reason.message : "历史版本加载失败");
    } finally {
      setVersionLoading(false);
    }
  }

  function applyUpdatedApiResource(updated: ApiKnowledgeFile) {
    const next = resourceFromApi(
      updated,
      new Map(Object.entries(libraryIds).map(([name, id]) => [id, name])),
      new Map(goalOptions.map((goal) => [goal.id, goal.title])),
      goalIdsByKbIdMap,
    );
    setFiles((current) => current.map((file) => file.id === next.id ? next : file));
    setDraft(next);
    return next;
  }

  function openLocalEditFlow() {
    if (!selected || typeof selected.id !== "string" || selected.source !== "upload") return;
    if (!selected.url) {
      setToast("原文件仍在加载，请稍后再试");
      return;
    }
    downloadResource(selected);
    setLocalEditOpen(true);
    void loadFileVersions(selected.id);
  }

  async function replaceWithLocalFile(event: React.ChangeEvent<HTMLInputElement>) {
    const replacement = event.target.files?.[0];
    if (!replacement || !selected || typeof selected.id !== "string") return;
    setReplacementSaving(true);
    try {
      const updated = await productApi.replaceKnowledgeFile(selected.id, replacement);
      applyUpdatedApiResource(updated);
      await loadFileVersions(selected.id);
      setLocalEditOpen(false);
      setToast("修改版已上传，正在重新解析和建立索引");
    } catch (reason) {
      setDataError(reason instanceof Error ? reason.message : "修改版上传失败");
    } finally {
      event.target.value = "";
      setReplacementSaving(false);
    }
  }

  async function restoreFileVersion(versionId: string) {
    if (!selected || typeof selected.id !== "string" || replacementSaving) return;
    setReplacementSaving(true);
    try {
      const restored = await productApi.restoreKnowledgeFileVersion(selected.id, versionId);
      applyUpdatedApiResource(restored);
      await loadFileVersions(selected.id);
      setLocalEditOpen(false);
      setToast("历史版本已恢复，正在重新建立索引");
    } catch (reason) {
      setDataError(reason instanceof Error ? reason.message : "历史版本恢复失败");
    } finally {
      setReplacementSaving(false);
    }
  }

  function queueFiles(incoming: FileList | File[]) {
    const incomingFiles = Array.from(incoming);
    setUploadQueue((current) => {
      const existing = new Set(current.map((item) => item.id));
      const additions = incomingFiles
        .filter((file) => !existing.has(uploadFileKey(file)))
        .map((file): UploadQueueItem => {
          const error = validateUploadFile(file);
          return {
            id: uploadFileKey(file),
            file,
            status: error ? "error" : "ready",
            error: error || undefined,
            errorKind: error ? "validation" : undefined,
          };
        });
      const duplicateCount = incomingFiles.length - additions.length;
      const invalidCount = additions.filter((item) => item.status === "error").length;
      setUploadAnnouncement([
        additions.length ? `已加入 ${additions.length} 份文件` : "",
        duplicateCount ? `忽略 ${duplicateCount} 份重复文件` : "",
        invalidCount ? `${invalidCount} 份文件需要处理` : "",
      ].filter(Boolean).join("，"));
      return [...current, ...additions];
    });
    setDragActive(false);
  }

  async function uploadQueuedFiles() {
    if (!requirePersistentAccount("上传文件并建立索引")) return;
    const readyItems = uploadQueue.filter((item) => item.status === "ready");
    if (!readyItems.length || uploadQueue.some((item) => item.status === "error")) return;
    setUploadingFiles(true);
    setUploadAnnouncement(`开始上传 ${readyItems.length} 份资料`);
    const goalIds = importGoalIds;
    const namesById = new Map(Object.entries(libraryIds).map(([name, id]) => [id, name]));
    const goalsById = new Map(goalOptions.map((goal) => [goal.id, goal.title]));
    const uploadedResources: Resource[] = [];
    const failedIds = new Set<string>();

    for (const [index, item] of readyItems.entries()) {
      setUploadQueue((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "uploading", error: undefined } : entry));
      setUploadAnnouncement(`正在上传 ${index + 1} / ${readyItems.length}：${item.file.name}`);
      try {
        const uploaded = await productApi.uploadKnowledgeFile(item.file, {
          kbIds: importLibraryIds.filter((id) => Object.values(libraryIds).includes(id)),
          goalIds,
        });
        const resource = resourceFromApi(uploaded, namesById, goalsById, goalIdsByKbIdMap);
        uploadedResources.push(resource);
      } catch (reason) {
        failedIds.add(item.id);
        const message = reason instanceof Error ? reason.message : "上传失败，请重试";
        setUploadQueue((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "error", error: message, errorKind: "upload" } : entry));
      }
    }

    if (uploadedResources.length) setFiles((current) => [...uploadedResources, ...current]);
    setUploadingFiles(false);
    setDragActive(false);
    if (failedIds.size) {
      setUploadQueue((current) => current
        .filter((item) => failedIds.has(item.id))
        .map((item) => ({ ...item, status: "error" })));
      setUploadAnnouncement(`${uploadedResources.length} 份上传成功，${failedIds.size} 份失败；请检查后重试`);
      if (uploadedResources.length) setToast(`已上传 ${uploadedResources.length} 份资料`);
      return;
    }

    setImportMode(null);
    setUploadQueue([]);
    setUploadAnnouncement(`已上传 ${uploadedResources.length} 份资料`);
    setImportLibraryIds([]);
    setImportGoalIds([]);
    setToast(`已上传 ${uploadedResources.length} 份资料`);
    if (uploadedResources[0]) openResource(uploadedResources[0]);
  }

  async function addUrl(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requirePersistentAccount("导入网页并建立索引")) return;
    if (!resourceUrl.trim()) return;
    const normalizedUrl = /^https?:\/\//i.test(resourceUrl.trim())
      ? resourceUrl.trim()
      : `https://${resourceUrl.trim()}`;
    const fallbackName = (() => {
      try {
        return new URL(normalizedUrl).hostname;
      } catch {
        return "网页资料";
      }
    })();
    const goalIds = importGoalIds;
    let resource: Resource;
    try {
      const imported = await productApi.importKnowledgeUrl({
        url: normalizedUrl,
        title: resourceName.trim() || fallbackName,
        kb_ids: importLibraryIds.filter((id) => Object.values(libraryIds).includes(id)),
        goal_ids: goalIds,
      });
      resource = resourceFromApi(
        imported,
        new Map(Object.entries(libraryIds).map(([name, id]) => [id, name])),
        new Map(goalOptions.map((goal) => [goal.id, goal.title])),
        goalIdsByKbIdMap,
      );
    } catch (reason) {
      setDataError(reason instanceof Error ? reason.message : "网页导入失败");
      return;
    }
    setFiles((current) => [resource, ...current]);
    setResourceName("");
    setResourceUrl("");
    setImportMode(null);
    setImportLibraryIds([]);
    setImportGoalIds([]);
    setToast("网页资料已保存");
    openResource(resource);
  }

  async function createLibrary(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requirePersistentAccount("创建并保存个人文件夹")) {
      setLibraryDialogOpen(false);
      return;
    }
    const name = newLibraryName.trim();
    setLibraryValidation("");
    if (!name) {
      setLibraryValidation("请输入文件夹名称");
      return;
    }
    if (libraries.includes(name)) {
      setLibraryValidation("这个文件夹已经存在，请换一个名称");
      return;
    }
    let createdId = "";
    if (authStatus === "authenticated") {
      try {
        const created = await productApi.createKnowledgeBase({
          name,
          description: newLibraryDescription.trim(),
        });
        createdId = created.id;
      } catch (reason) {
        setDataError(reason instanceof Error ? reason.message : "文件夹创建失败");
        return;
      }
    }
    setLibraries((current) => [...current, name]);
    if (createdId) setLibraryIds((current) => ({ ...current, [name]: createdId }));
    setLibrary(name);
    setLibraryFilter(name);
    setNewLibraryName("");
    setNewLibraryDescription("");
    setLibraryDialogOpen(false);
    setToast(`已创建文件夹“${name}”`);
  }

  async function deleteCurrentLibrary(name: string) {
    const id = libraryIds[name];
    try {
      if (authStatus === "authenticated" && id) await productApi.deleteKnowledgeBase(id);
      setLibraries((current) => current.filter((item) => item !== name));
      setFiles((current) => current.map((file) => file.library === name
        ? (() => {
            const nextLibraries = file.libraries.filter((value) => value !== name);
            const nextKbIds = file.kbIds.filter((value) => value !== id);
            return { ...file, library: nextLibraries[0] ?? "未归档", libraries: nextLibraries, kbId: nextKbIds[0], kbIds: nextKbIds };
          })()
        : file));
      setLibraryIds((current) => { const next = { ...current }; delete next[name]; return next; });
      setLibraryFilter("all");
      setLibrary((current) => current === name ? "" : current);
      setEditingLibraryName(null);
      setToast(`已删除文件夹“${name}”，资料已保留为未归档`);
    } catch (reason) {
      setDataError(reason instanceof Error ? reason.message : "删除文件夹失败");
    }
  }

  async function confirmDeleteLibrary(name: string) {
    if (!requirePersistentAccount("删除个人文件夹")) return;
    setEditingLibraryName(null);
    const confirmed = await confirmAction({
      title: `删除文件夹“${name}”？`,
      description: "文件夹会被删除，其中的资料会保留为未归档，已有的目标关联不受影响。",
      confirmLabel: "确认删除",
      cancelLabel: "保留文件夹",
      tone: "danger",
    });
    if (confirmed) await deleteCurrentLibrary(name);
  }

  async function moveSelectedResources(destination: string | null) {
    if (!requirePersistentAccount("保存资料的归档位置")) return;
    const selectedFiles = files.filter((file) => selectedRows.has(file.id));
    try {
      if (authStatus === "authenticated") {
        await Promise.all(selectedFiles.map((file) => typeof file.id === "string"
          ? productApi.updateKnowledgeFile(file.id, { kb_ids: destination ? [libraryIds[destination]] : [] })
          : Promise.resolve()));
      }
      setFiles((current) => current.map((file) => selectedRows.has(file.id)
        ? { ...file, library: destination ?? "未归档", libraries: destination ? [destination] : [], kbId: destination ? libraryIds[destination] : undefined, kbIds: destination ? [libraryIds[destination]] : [] }
        : file));
      setSelectedRows(new Set());
      setBatchMenuOpen(false);
      setToast(destination ? `已将 ${selectedFiles.length} 份资料移动到“${destination}”` : `已将 ${selectedFiles.length} 份资料设为未归档`);
    } catch (reason) {
      setDataError(reason instanceof Error ? reason.message : "批量移动失败");
    }
  }

  async function deleteSelectedResources() {
    const selectedFiles = files.filter((file) => selectedRows.has(file.id));
    try {
      if (authStatus === "authenticated") {
        await Promise.all(selectedFiles.map((file) => typeof file.id === "string"
          ? productApi.deleteKnowledgeFile(file.id)
          : Promise.resolve()));
      }
      setFiles((current) => current.filter((file) => !selectedRows.has(file.id)));
      setSelectedRows(new Set());
      setBatchMenuOpen(false);
      setToast(`已删除 ${selectedFiles.length} 份资料`);
    } catch (reason) {
      setDataError(reason instanceof Error ? reason.message : "批量删除失败");
    }
  }

  async function confirmDeleteSelectedResources() {
    if (!requirePersistentAccount("删除学习资料")) return;
    const count = selectedRows.size;
    if (!count) return;
    const confirmed = await confirmAction({
      title: `删除选中的 ${count} 份资料？`,
      description: "这些资料将从知识空间中移除，已有索引与关联信息也会一并删除。此操作无法撤销。",
      confirmLabel: "确认删除",
      cancelLabel: "保留资料",
      tone: "danger",
    });
    if (confirmed) await deleteSelectedResources();
  }

  function openLibrarySettings(name: string) {
    if (!requirePersistentAccount("修改个人文件夹设置")) return;
    setEditingLibraryName(name);
    setLibraryNameDraft(name);
  }

  async function saveLibrarySettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requirePersistentAccount("保存个人文件夹设置")) return;
    if (!editingLibraryName) return;
    const nextName = libraryNameDraft.trim();
    if (!nextName) return;
    if (nextName !== editingLibraryName && libraries.includes(nextName)) {
      setToast("这个文件夹名称已经存在");
      return;
    }

    const currentLibraryId = libraryIds[editingLibraryName];
    if (authStatus === "authenticated" && currentLibraryId) {
      try {
        await productApi.updateKnowledgeBase(currentLibraryId, {
          name: nextName,
        });
      } catch (reason) {
        setDataError(reason instanceof Error ? reason.message : "文件夹设置保存失败");
        return;
      }
    }
    setLibraries((current) => current.map((name) => name === editingLibraryName ? nextName : name));
    if (currentLibraryId) {
      setLibraryIds((current) => {
        const next = { ...current };
        delete next[editingLibraryName];
        next[nextName] = currentLibraryId;
        return next;
      });
    }
    setFiles((current) => current.map((file) => file.libraries.includes(editingLibraryName)
      ? { ...file, library: file.library === editingLibraryName ? nextName : file.library, libraries: file.libraries.map((name) => name === editingLibraryName ? nextName : name) }
      : file));
    if (libraryFilter === editingLibraryName) setLibraryFilter(nextName);
    if (library === editingLibraryName) setLibrary(nextName);
    setEditingLibraryName(null);
    setToast("文件夹设置已保存");
  }

  async function saveResource(): Promise<boolean> {
    if (!requirePersistentAccount("编辑并保存学习资料")) return false;
    if (!draft || !draft.name.trim()) {
      setDataError("请先填写资料标题，再退出编辑");
      return false;
    }
    if (resourceSavingRef.current) return false;
    resourceSavingRef.current = true;
    setResourceSaving(true);
    signalPiloState("working", { source: "knowledge:save" });
    let saved: Resource = {
      ...draft,
      name: draft.name.trim(),
      updated: "刚刚",
      contentFormat: isMarkdownResource(draft)
        ? "markdown" as const
        : isTextResource(draft)
          ? draft.contentFormat === "html" ? "html" as const : "plain" as const
          : draft.contentFormat,
    };
    if (authStatus === "authenticated" && typeof draft.id === "string") {
      try {
        const updated = await productApi.updateKnowledgeFile(draft.id, {
          title: saved.name,
          summary: saved.summary,
          kb_ids: saved.kbIds,
          goal_ids: saved.goalIds,
          content: saved.content ?? "",
          content_format: saved.contentFormat ?? "plain",
        });
        saved = {
          ...saved,
          ...resourceFromApi(
            updated,
            new Map(Object.entries(libraryIds).map(([name, id]) => [id, name])),
            new Map(goalOptions.map((goal) => [goal.id, goal.title])),
            goalIdsByKbIdMap,
          ),
          content: saved.content,
          contentFormat: saved.contentFormat,
        };
      } catch (reason) {
        signalPiloState("failure", { source: "knowledge:save", duration: 4_200 });
        setDataError(reason instanceof Error ? reason.message : "资料修改保存失败");
        resourceSavingRef.current = false;
        setResourceSaving(false);
        return false;
      }
    }
    setFiles((current) => current.map((file) => file.id === saved.id ? saved : file));
    setDraft(saved);
    setDraftDirty(false);
    setToast("修改已自动保存");
    signalPiloContext({ kind: "saved", surface: "knowledge", objectId: String(saved.id), objectTitle: saved.name, goalIds: saved.goalIds });
    signalPiloState("success", { source: "knowledge:save", duration: 3_400 });
    resourceSavingRef.current = false;
    setResourceSaving(false);
    return true;
  }

  function renderPreview(resource: Resource) {
    if (previewLoading && resource.source === "upload" && !resource.url) {
      return <div className="document-preview-loading"><RefreshCw size={20} /> 正在加载原文件…</div>;
    }
    if (resource.contentFormat === "html") {
      return (
        <article
          className="markdown-document-preview notion-saved-document"
          dangerouslySetInnerHTML={{ __html: resource.content || "<p>这份资料暂无内容。</p>" }}
        />
      );
    }
    if (resource.type === "Markdown") {
      return <MarkdownPreview content={resource.content || resource.summary || ""} />;
    }
    if (isTextResource(resource)) {
      return (
        <pre className="text-document-preview">
          {resource.content || "这份资料还没有正文内容。点击“编辑”开始补充。"}
        </pre>
      );
    }
    if (resource.type === "图片" && resource.url) {
      // Object URLs and authenticated attachments cannot be optimized by next/image.
      // eslint-disable-next-line @next/next/no-img-element
      return <img className="image-document-preview" src={resource.url} alt={resource.name} />;
    }
    if (resource.type === "PDF" && resource.url) {
      return <iframe className="pdf-document-preview" src={resource.url} title={`${resource.name} 预览`} />;
    }
    if (["Word", "表格", "演示文稿"].includes(resource.type)) {
      const lines = (resource.content || "").split(/\r?\n/).filter(Boolean);
      return (
        <article className={`office-document-preview is-${resource.type}`}>
          <header><small>{resource.type} · 只读预览</small><h1>{resource.name.replace(/\.[^.]+$/, "")}</h1></header>
          {resource.type === "表格" && lines.length ? (
            <div className="office-sheet-preview"><table><tbody>{lines.map((line, rowIndex) => <tr key={`${rowIndex}-${line}`}>{line.split(/\t|,/).map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}>{cell}</td>)}</tr>)}</tbody></table></div>
          ) : lines.length ? lines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>) : <div className="office-empty-preview">暂未提取到可展示的正文，索引完成后会自动显示。</div>}
        </article>
      );
    }
    if (resource.type === "网页" && resource.url) {
      return (
        <div className="link-document-preview">
          <Globe2 size={28} />
          <small>网页资料</small>
          <strong>{resource.name}</strong>
          <span>{resource.url}</span>
          <a href={resource.url} target="_blank" rel="noreferrer">
            在新标签页打开 <ArrowUpRight size={14} />
          </a>
        </div>
      );
    }
    if (resource.isDemo) {
      return (
        <div className="knowledge-demo-document-preview">
          <h2>{resource.name.replace(/\.[^.]+$/, "")}</h2>
          <p>{resource.summary}</p>
          <small>资料摘要会帮助你快速判断内容，并在需要时回到原文继续阅读。</small>
        </div>
      );
    }
    return (
      <div className="empty-document-preview">
        <ResourceGlyph type={resource.type} />
        <strong>{resource.source === "sample" ? "示例资料未附带原文件" : "暂时无法生成预览"}</strong>
        <span>
          {resource.source === "sample"
            ? "上传你自己的 PDF 后，即可在这里逐页查看。"
            : "可以下载原文件查看；此格式暂不支持在线编辑。"}
        </span>
      </div>
    );
  }

  return (
    <div className="resource-page knowledge-reference-page">
      <header className="workspace-pagebar goals-redesign-heading">
        <div className="workspace-page-title">
          <small>KNOWLEDGE</small>
          <h1>知识空间</h1>
          <span>学习目标与个人文件夹独立分类，可任选一种或同时关联</span>
        </div>
        <div className="knowledge-reference-actions">
          <label className="knowledge-global-query">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="全文搜索知识空间" aria-label="全文搜索知识空间" />
          </label>
          <div className="knowledge-import-wrap">
          <button type="button" className="knowledge-quiet-action knowledge-import-primary" onClick={() => setImportMenuOpen((current) => !current)} aria-expanded={importMenuOpen}>
              导入资料 <ChevronDown size={15} />
            </button>
            {importMenuOpen && (
              <div className="knowledge-import-menu">
                <button type="button" onClick={() => openImport("upload")}><Upload size={16} /><span><strong>上传文件</strong><small>PDF、图片与办公文档</small></span></button>
                <button type="button" onClick={() => openImport("url")}><Link2 size={16} /><span><strong>导入网址</strong><small>保存并索引网页内容</small></span></button>
              </div>
            )}
          </div>
        </div>
      </header>

      {(dataLoading || dataError) && (
        <DataSyncNotice
          loading={dataLoading && !dataError}
          title={dataError ? "资料库同步失败" : "正在同步资料库"}
          message={dataError || undefined}
          retryLabel="重新加载"
          onRetry={() => window.location.reload()}
        />
      )}

      <div className="knowledge-reference-grid" style={{ "--knowledge-rail-width": `${railWidth}px` } as React.CSSProperties}>
        <aside className="knowledge-rail-column">
          <nav className="knowledge-library-rail" aria-label="资料分类" onScroll={revealScrollbarWhileScrolling}>
            <section className="knowledge-scope-shortcuts">
              <button type="button" className={!hasActiveFilters ? "is-active" : ""} aria-label={`全部资料，${files.length} 项资料`} onMouseEnter={(event) => updateNavTooltip(event, "全部资料", files.length)} onClick={clearFilters}><FileText size={15} /><span className="knowledge-nav-label">全部资料</span></button>
              <button type="button" className={goalFilter === "unlinked" ? "is-active" : ""} aria-label={`未关联资料，${files.filter(isUnlinkedResource).length} 项资料`} onMouseEnter={(event) => updateNavTooltip(event, "未关联资料", files.filter(isUnlinkedResource).length)} onClick={() => { clearFilters(); setGoalFilter("unlinked"); }}><Link2 size={15} /><span className="knowledge-nav-label">未关联资料</span></button>
            </section>
            <div
              className="knowledge-classification-split"
              ref={classificationSplitRef}
              style={{
                "--knowledge-goal-share": `${classificationSplit}fr`,
                "--knowledge-library-share": `${100 - classificationSplit}fr`,
              } as CSSProperties}
            >
              <section className="knowledge-goal-list">
                <h2><span>按目标分类</span></h2>
                <div className="knowledge-goal-scroll" onScroll={revealScrollbarWhileScrolling}>
                {goalOptions.map((goal) => (
                  <button type="button" key={goal.id} className={goalFilter === goal.id ? "is-active" : ""} aria-label={`${goal.title}，${files.filter((file) => file.goalIds.includes(goal.id)).length} 项资料`} onMouseEnter={(event) => updateNavTooltip(event, goal.title, files.filter((file) => file.goalIds.includes(goal.id)).length)} onClick={() => { clearFilters(); setGoalFilter(goal.id); }}>
                    <Target size={15} /><span className="knowledge-nav-label">{goal.title}</span>
                  </button>
                ))}
                {!goalOptions.length && <p className="knowledge-rail-empty">创建学习目标后，可将一份资料关联到多个目标。</p>}
                </div>
              </section>
              <div
                className="knowledge-classification-resizer"
                role="separator"
                aria-label="调整目标与个人文件夹区域高度"
                aria-orientation="horizontal"
                aria-valuemin={25}
                aria-valuemax={75}
                aria-valuenow={Math.round(classificationSplit)}
                tabIndex={0}
                onPointerDown={startClassificationResize}
                onKeyDown={resizeClassificationByKeyboard}
                onDoubleClick={() => setClassificationSplit(50)}
              />
              <section className="knowledge-library-list-section">
                <h2><span>个人文件夹</span><button type="button" onClick={() => { if (requirePersistentAccount("创建并保存个人文件夹")) setLibraryDialogOpen(true); }} aria-label="新建文件夹"><Plus size={15} /></button></h2>
                <div className="knowledge-library-list" onScroll={revealScrollbarWhileScrolling}>
                  {libraries.map((name) => {
                    const count = files.filter((file) => file.libraries.includes(name)).length;
                    return (
                      <div key={name} className="knowledge-library-row">
                        <button type="button" className={libraryFilter === name ? "is-active" : ""} aria-label={`${name}，${count} 项资料`} onMouseEnter={(event) => updateNavTooltip(event, name, count)} onClick={() => { clearFilters(); setLibraryFilter(name); setLibrary(name); }}><FolderOpen size={15} /><span className="knowledge-nav-label">{name}</span></button>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          </nav>

          <section className={`knowledge-ai-assist-card ${aiAssistExpanded ? "is-expanded" : ""}`}>
            <h2>
              <button
                type="button"
                className="knowledge-ai-assist-trigger"
                aria-expanded={aiAssistExpanded}
                aria-controls="knowledge-ai-assist-content"
                onClick={() => setAiAssistExpanded((current) => !current)}
              >
                <span><Bot size={16} /><span><strong>资料助手</strong><small>{readyCount} 项资料可引用</small></span></span>
                <ChevronDown size={16} />
              </button>
            </h2>
            <div id="knowledge-ai-assist-content" className="knowledge-ai-assist-content">
              <div className="knowledge-ai-assist-inner">
                <p className="knowledge-ai-card-intro">{scopeLabel}中的资料会在完成索引后用于学习伙伴问答。</p>
                <ul>
                  <li><Bot size={14} /><span>自动摘要</span><strong>{readyCount} 项就绪</strong></li>
                  <li><Tags size={14} /><span>资料类型</span><strong>{new Set(scopeFiles.map((file) => file.type)).size} 类</strong></li>
                  <li><Link2 size={14} /><span>AI 可引用资料</span><strong>{readyCount} 项</strong></li>
                </ul>
                <div className="knowledge-ai-assist-actions">
                  {authStatus === "authenticated"
                    ? <Link href={selectedGoal ? `/studio/coach?goal=${encodeURIComponent(selectedGoal.id)}` : "/studio/coach"}><Sparkles size={14} /> 资料问答</Link>
                    : <button type="button" onClick={() => requirePersistentAccount("使用真实资料向学习伙伴提问")}><Sparkles size={14} /> 资料问答</button>}
                  <button type="button" onClick={() => setInsightMode(insightMode === "citations" ? "summary" : "citations")}>{insightMode === "citations" ? "收起引用" : "查看引用"}</button>
                </div>
                {insightMode === "citations" && <div className="knowledge-citation-list">{scopeFiles.filter((file) => file.status === "可用于 AI").slice(0, 4).map((file) => <button type="button" key={file.id} onClick={() => openResource(file)}><FileText size={13} /><span>{file.name}</span></button>)}{!readyCount && <p>当前没有已完成索引的资料。</p>}</div>}
              </div>
            </div>
          </section>
        </aside>

        <div
          className="knowledge-rail-resizer"
          onPointerDown={startRailResize}
          onKeyDown={resizeRailByKeyboard}
          role="separator"
          aria-label="调整资料分类栏宽度"
          aria-orientation="vertical"
          aria-valuemin={180}
          aria-valuemax={360}
          aria-valuenow={railWidth}
          tabIndex={0}
        />

        <main className="knowledge-resource-panel">
          <header className="knowledge-resource-heading knowledge-resource-filter-row">
            <label className="knowledge-mobile-scope-select">
              <span>查看范围</span>
              <select value={scopeControlValue} onChange={(event) => selectScope(event.target.value)} aria-label="移动端资料范围">
                <option value="all">全部资料</option>
                {goalOptions.map((goal) => <option key={goal.id} value={`goal:${goal.id}`}>目标：{goal.title}</option>)}
                <option value="unlinked">未关联资料</option>
                {libraries.map((name) => <option key={name} value={`folder:${name}`}>文件夹：{name}</option>)}
              </select>
            </label>
            <div className="knowledge-resource-context">
              <small>{selectedGoal ? "TARGET RESOURCES" : libraryFilter !== "all" ? "PERSONAL FOLDER" : "ALL RESOURCES"}</small>
              <div className="knowledge-resource-context-title">
                <h2>{scopeLabel}</h2>
                {libraryFilter !== "all" && (
                  <button type="button" onClick={() => openLibrarySettings(libraryFilter)} aria-label={`文件夹设置 ${libraryFilter}`}>
                    <Settings2 size={13} />
                    文件夹设置
                  </button>
                )}
              </div>
              <p>{scopeDescription}</p>
            </div>
            <div className="knowledge-resource-heading-side">
            <div className="knowledge-resource-filters" aria-label="资料筛选">
              <label className="knowledge-filter-select">
                <Tags size={14} />
                <select aria-label="按资料类型筛选" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                  <option value="all">全部类型</option>
                  {resourceTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="knowledge-filter-select">
                <Filter size={14} />
                <select aria-label="按索引状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | "ready" | "processing")}>
                  <option value="all">全部状态</option>
                  <option value="ready">可供 AI 使用</option>
                  <option value="processing">处理中</option>
                </select>
              </label>
              <button type="button" className={`knowledge-filter-icon ${favoritesOnly ? "is-active" : ""}`} aria-label="只看收藏资料" title="只看收藏" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((current) => !current)}><Bookmark size={14} /></button>
              <button type="button" className={`knowledge-filter-icon ${sortMode === "recent" ? "is-active" : ""}`} aria-label="按最近访问排序" title="按最近访问排序" aria-pressed={sortMode === "recent"} onClick={() => setSortMode((current) => current === "recent" ? "newest" : "recent")}><Clock3 size={14} /></button>
              {hasActiveFilters && <button type="button" className="knowledge-clear-filters" onClick={clearFilters}><X size={14} /><span>清除</span></button>}
            </div>
            <div className="knowledge-resource-summary" aria-label="当前资料统计" aria-live="polite">
              <span><i className="is-purple" />{visibleFiles.length} 项资料</span>
              <button type="button" className="knowledge-status-help" aria-describedby="knowledge-status-explanation">
                <i className="is-green" />{visibleFiles.filter((file) => file.status === "可用于 AI").length} 项可使用
                <span id="knowledge-status-explanation" className="knowledge-status-tooltip" role="tooltip">
                  <span className="knowledge-status-tooltip-head">
                    <strong>资料状态说明</strong>
                    <small>状态会随解析进度自动更新</small>
                  </span>
                  <span className="knowledge-status-tooltip-row is-ready">
                    <span className="knowledge-status-tooltip-icon"><Check size={13} /></span>
                    <span><strong>可使用</strong><small>已完成解析与索引，学习伙伴回答时可以检索并引用。</small></span>
                  </span>
                  <span className="knowledge-status-tooltip-row is-pending">
                    <span className="knowledge-status-tooltip-icon"><RefreshCw size={13} /></span>
                    <span><strong>待处理</strong><small>系统仍在提取正文、建立检索索引，暂时不能稳定引用。</small></span>
                  </span>
                </span>
              </button>
            </div>
            </div>
          </header>
          <div className="knowledge-resource-table" role="table" aria-label="知识空间资料" onScroll={revealScrollbarWhileScrolling}>
            <div className="knowledge-resource-table-head" role="row">
              <span><input type="checkbox" aria-label="选择全部资料" checked={Boolean(visibleFiles.length) && selectedRows.size === visibleFiles.length} onChange={(event) => setSelectedRows(event.target.checked ? new Set(visibleFiles.map((file) => file.id)) : new Set())} /></span>
              <span className="knowledge-resource-name-head"><span>资料名称</span>
                {selectedRows.size > 0 && (
                  <span className="knowledge-batch-cell" aria-label="资料操作">
                    <button type="button" className="knowledge-batch-trigger" aria-expanded={batchMenuOpen} onClick={() => setBatchMenuOpen((current) => !current)}>
                      批量操作 <ChevronDown size={13} />
                    </button>
                    {batchMenuOpen && (
                      <div className="knowledge-batch-menu" role="menu">
                        <strong>已选择 {selectedRows.size} 项</strong>
                        <button type="button" role="menuitem" onClick={() => void moveSelectedResources(null)}><FolderInput size={14} />移至未归档</button>
                        {libraries.map((name) => <button type="button" role="menuitem" key={name} onClick={() => void moveSelectedResources(name)}><FolderOpen size={14} />移动到 {name}</button>)}
                        <button type="button" role="menuitem" className="is-danger" onClick={() => { setBatchMenuOpen(false); void confirmDeleteSelectedResources(); }}><Trash2 size={14} />批量删除</button>
                      </div>
                    )}
                  </span>
                )}
              </span><span>关联目标</span><span>更新时间</span><span>收藏</span><span>编辑</span>
            </div>
            {visibleFiles.map((file) => {
              const isSelected = selectedRows.has(file.id);
              const isFavorite = favorites.has(file.id);
              return (
                <article key={file.id} role="row" className={isSelected ? "is-selected" : ""}>
                  <span><input type="checkbox" aria-label={`选择 ${file.name}`} checked={isSelected} onChange={() => setSelectedRows((current) => { const next = new Set(current); if (next.has(file.id)) next.delete(file.id); else next.add(file.id); return next; })} /></span>
                  <button type="button" className="knowledge-resource-identity" onClick={() => openResource(file)}>
                    <span className={`knowledge-file-glyph is-${file.type.toLowerCase()}`}><ResourceGlyph type={file.type} /></span>
                    <span className="knowledge-resource-copy"><strong>{file.name}</strong><small>{file.type} · {file.libraries.length ? file.libraries.join("、") : "未归档"}{file.size ? ` · ${file.size}` : ""}</small></span>
                  </button>
                  <span className="knowledge-resource-goals">
                    {file.goalTitles.length
                      ? file.goalTitles.map((goalTitle) => <em key={goalTitle}>{goalTitle}</em>)
                      : <em className="is-unlinked">未关联</em>}
                  </span>
                  <time>{file.updated}</time>
                  <span className="knowledge-row-action-cell"><button type="button" className={isFavorite ? "is-favorite" : ""} aria-label={isFavorite ? `取消收藏 ${file.name}` : `收藏 ${file.name}`} data-tooltip={isFavorite ? "取消收藏" : "收藏资料"} onClick={() => setFavorites((current) => { const next = new Set(current); if (next.has(file.id)) next.delete(file.id); else next.add(file.id); return next; })}><Bookmark size={14} fill={isFavorite ? "currentColor" : "none"} /></button></span>
                  <span className="knowledge-row-action-cell"><button type="button" aria-label={`编辑 ${file.name}`} data-tooltip="编辑资料" onClick={() => openResource(file, isTextResource(file))}><Pencil size={15} /></button></span>
                </article>
              );
            })}
            {!visibleFiles.length && <div className="knowledge-table-empty"><Search size={20} /><strong>没有找到相关资料</strong><span>调整上方筛选条件，或导入一份新的资料。</span></div>}
          </div>
        </main>

      </div>

      {authPromptOpen && (
        <div className="dialog-backdrop knowledge-auth-gate-backdrop" onMouseDown={() => setAuthPromptOpen(false)}>
          <section
            className="app-dialog knowledge-auth-gate"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-auth-gate-title"
            aria-describedby="knowledge-auth-gate-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button type="button" className="knowledge-auth-gate-close" aria-label="关闭" onClick={() => setAuthPromptOpen(false)}><X size={19} /></button>
            <div className="knowledge-auth-gate-heading">
              <span className="knowledge-auth-gate-icon"><Sparkles size={21} /></span>
              <div>
                <h2 id="knowledge-auth-gate-title">继续使用完整知识空间</h2>
                <p>登录后，资料与学习进度会持续保存</p>
              </div>
            </div>
            <div className="knowledge-guest-gate-message" id="knowledge-auth-gate-description">
              <strong>你正在尝试{authPromptIntent}</strong>
              <span>登录后即可继续这项操作，并在其他设备访问这些资料。</span>
            </div>
            <footer>
              <button type="button" className="knowledge-guest-gate-dismiss" onClick={() => setAuthPromptOpen(false)}>继续浏览</button>
              <div>
                <Link href="/register" className="knowledge-guest-gate-register">注册</Link>
                <Link href="/login" className="knowledge-guest-gate-login">登录</Link>
              </div>
            </footer>
          </section>
        </div>
      )}

      {importMode === "upload" && (
        <div className="dialog-backdrop" onMouseDown={closeImport}>
          <section className="app-dialog upload-dialog knowledge-import-dialog knowledge-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-upload-title" aria-describedby="knowledge-upload-description" aria-busy={uploadingFiles} onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <span className="knowledge-import-header-icon"><Upload size={20} /></span>
              <div><small>资料导入</small><h2 id="knowledge-upload-title">上传学习资料</h2><p id="knowledge-upload-description">检查文件与归档位置后，再一次完成上传。</p></div>
              <button type="button" aria-label="关闭" onClick={closeImport} disabled={uploadingFiles}><X size={18} /></button>
            </header>
            <section className="knowledge-import-source-card" aria-label="选择导入文件">
              <div className="knowledge-import-overview">
                <span className="knowledge-import-step-badge" aria-hidden="true">1</span>
                <div><strong>{uploadQueue.length ? `已选择 ${uploadQueue.length} 份文件` : "选择要上传的文件"}</strong></div>
                <button type="button" className="knowledge-import-step-action" onClick={() => fileInputRef.current?.click()} disabled={uploadingFiles}>{uploadQueue.length ? "重新选择" : "选择文件"}</button>
              </div>
              <button
                type="button"
                className={`file-dropzone knowledge-upload-dropzone ${dragActive ? "is-dragging" : ""} ${uploadQueue.length ? "is-compact" : ""}`}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingFiles}
                onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!uploadingFiles) queueFiles(event.dataTransfer.files);
                }}
              >
                <span><CloudUpload size={28} /></span>
                <strong>{uploadQueue.length ? "继续添加文件" : "拖入文件，或从设备选择"}</strong>
                <small>PDF、图片、Markdown、文本及常用办公文件 · 支持多选</small>
              </button>
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.md,.markdown,.txt,.csv,.json,.docx,.xlsx,.pptx,text/*,image/*,application/pdf"
                onChange={(event) => {
                  if (event.target.files?.length) queueFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              {uploadQueue.length > 0 && (
                <section className="knowledge-upload-queue" aria-labelledby="knowledge-upload-queue-title">
                  <div className="knowledge-upload-queue-heading">
                    <strong id="knowledge-upload-queue-title">待上传文件</strong>
                    <span>{uploadQueue.length} 份 · {formatSize(uploadQueue.reduce((total, item) => total + item.file.size, 0))}</span>
                  </div>
                  <div className="knowledge-upload-file-list">
                    {uploadQueue.map((item) => (
                      <article className={`knowledge-upload-file is-${item.status}`} key={item.id}>
                        <span className="knowledge-upload-file-icon">{item.status === "uploading" ? <LoaderCircle size={17} /> : item.status === "error" ? <AlertCircle size={17} /> : <FileCheck2 size={17} />}</span>
                        <span className="knowledge-upload-file-copy">
                          <strong title={item.file.name}>{item.file.name}</strong>
                          <small>{getFileType(item.file)} · {formatSize(item.file.size)}</small>
                          {item.error && <em role="alert">{item.error}</em>}
                        </span>
                        {item.status === "error" && item.errorKind === "upload" ? (
                          <button type="button" onClick={() => setUploadQueue((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "ready", error: undefined, errorKind: undefined } : entry))} disabled={uploadingFiles}>重试</button>
                        ) : item.status === "error" ? (
                          <button type="button" onClick={() => setUploadQueue((current) => current.filter((entry) => entry.id !== item.id))} disabled={uploadingFiles}>移除</button>
                        ) : (
                          <button type="button" aria-label={`移除 ${item.file.name}`} onClick={() => setUploadQueue((current) => current.filter((entry) => entry.id !== item.id))} disabled={uploadingFiles}><X size={15} /></button>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </section>
            <div className="resource-import-options knowledge-upload-destinations">
              {renderImportDestination()}
            </div>
            <div className="knowledge-upload-announcement" role="status" aria-live="polite">{uploadAnnouncement}</div>
            <footer className="knowledge-import-footer knowledge-upload-footer">
              <span>{uploadQueue.length ? "确认文件和归档位置后再上传" : "先添加至少一份文件"}</span>
              <div>
                <button type="button" onClick={closeImport} disabled={uploadingFiles}>取消</button>
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => void uploadQueuedFiles()}
                  disabled={uploadingFiles || !uploadQueue.length || uploadQueue.some((item) => item.status === "error")}
                >
                  {uploadingFiles
                    ? <><LoaderCircle size={16} /> 正在上传</>
                    : uploadQueue.some((item) => item.status === "error")
                      ? "处理问题后上传"
                      : uploadQueue.length ? `上传 ${uploadQueue.length} 份资料` : "请选择文件"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}

      {importMode === "url" && (
        <div className="dialog-backdrop" onMouseDown={closeImport}>
          <form
            className="app-dialog knowledge-import-dialog knowledge-url-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-url-title"
            aria-describedby="knowledge-url-description"
            onSubmit={addUrl}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <span className="knowledge-import-header-icon"><Link2 size={20} /></span>
              <div><small>资料导入</small><h2 id="knowledge-url-title">导入网页资料</h2><p id="knowledge-url-description">确认网页信息与归档位置后，再保存为学习资料。</p></div>
              <button type="button" aria-label="关闭" onClick={closeImport}><X size={18} /></button>
            </header>
            <section className="knowledge-import-source-card" aria-label="填写网页信息">
              <div className="knowledge-import-overview">
                <span className="knowledge-import-step-badge" aria-hidden="true">1</span>
                <div><strong>填写要导入的网页</strong></div>
                <em>{resourceUrl.trim() ? "已填写" : "等待填写"}</em>
              </div>
              <div className="knowledge-url-fields">
                <label>
                  网页地址
                  <input autoFocus required value={resourceUrl} onChange={(event) => setResourceUrl(event.target.value)} placeholder="https://example.com/article" />
                </label>
                <label>
                  资料名称 <span>选填</span>
                  <input value={resourceName} onChange={(event) => setResourceName(event.target.value)} placeholder="留空时使用网站名称" />
                </label>
              </div>
            </section>
            <div className="resource-import-options knowledge-import-destinations">
              {renderImportDestination()}
            </div>
            <footer className="knowledge-import-footer">
              <span>确认网页信息和归档位置后再保存</span>
              <div>
              <button type="button" onClick={closeImport}>取消</button>
              <button type="submit">保存网页</button>
              </div>
            </footer>
          </form>
        </div>
      )}

      {libraryDialogOpen && (
        <div className="dialog-backdrop" onMouseDown={() => setLibraryDialogOpen(false)}>
          <form
            className="app-dialog compact-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="新建文件夹"
            noValidate
            onSubmit={createLibrary}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div><small>NEW FOLDER</small><h2>新建文件夹</h2></div>
              <button type="button" aria-label="关闭" onClick={() => setLibraryDialogOpen(false)}><X size={17} /></button>
            </header>
            <label>
              文件夹名称
              <input autoFocus value={newLibraryName} onChange={(event) => { setNewLibraryName(event.target.value); setLibraryValidation(""); }} placeholder="例如：项目资料" aria-invalid={Boolean(libraryValidation)} />
            </label>
            <label>用途说明<textarea value={newLibraryDescription} onChange={(event) => setNewLibraryDescription(event.target.value)} placeholder="例如：收纳暂未关联目标的参考资料" /></label>
            {libraryValidation && <p className="knowledge-dialog-error" role="alert">{libraryValidation}</p>}
            <footer>
              <button type="button" onClick={() => setLibraryDialogOpen(false)}>取消</button>
              <button type="submit">创建文件夹</button>
            </footer>
          </form>
        </div>
      )}

      {editingLibraryName && (
        <div className="dialog-backdrop" onMouseDown={() => setEditingLibraryName(null)}>
          <form
            className="app-dialog compact-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`文件夹设置 ${editingLibraryName}`}
            onSubmit={saveLibrarySettings}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div><small>FOLDER SETTINGS</small><h2>文件夹设置</h2></div>
              <button type="button" aria-label="关闭" onClick={() => setEditingLibraryName(null)}><X size={17} /></button>
            </header>
            <label>文件夹名称<input autoFocus required value={libraryNameDraft} onChange={(event) => setLibraryNameDraft(event.target.value)} /></label>
            <p className="library-settings-note"><FolderOpen size={14} /> 文件夹只用于归档，不会改变资料已关联的学习目标。</p>
            <footer>
              <button type="button" className="knowledge-delete-library" onClick={() => void confirmDeleteLibrary(editingLibraryName)}>删除文件夹</button>
              <button type="button" onClick={() => setEditingLibraryName(null)}>取消</button>
              <button type="submit">保存设置</button>
            </footer>
          </form>
        </div>
      )}

      {selected && draft && (
        <div className="document-drawer-backdrop" onMouseDown={() => void closeResource()}>
          <section
            className={`document-drawer ${fullscreen ? "is-fullscreen" : ""}`}
            role="dialog"
            aria-modal="true"
            data-pilo-allow-companion="true"
            aria-label={`${selected.name} 预览`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="document-drawer-head">
              <div className="document-identity">
                <span className="file-icon"><ResourceGlyph type={selected.type} /></span>
                <div>
                  <small>{`${selected.type} · ${selected.libraries.length ? selected.libraries.join("、") : "未归档"}${selected.size ? ` · ${selected.size}` : ""}`}</small>
                  <div className="document-identity-title-row">
                    <strong>{selected.name}</strong>
                    {!editing && selected.isDemo && <span className="document-preview-chip">资料预览</span>}
                  </div>
                </div>
              </div>
              <div className="document-actions">
                {(isTextResource(selected) || (selected.url && selected.source === "upload")) && (
                  <button
                    type="button"
                    className="document-download-action"
                    onClick={() => downloadResource(selected)}
                    aria-label={`下载 ${selected.name}`}
                    title="下载文件"
                  >
                    <Download size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className="document-fullscreen-action"
                  onClick={() => setFullscreen((current) => !current)}
                  aria-label={fullscreen ? "退出全屏" : "全屏预览"}
                  title={fullscreen ? "退出全屏" : "全屏预览"}
                >
                  {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
                {!editing && isTextResource(selected) && <button type="button" className="drawer-edit-action" onClick={startEditingResource}><Pencil size={15} /> 编辑</button>}
                {!editing && !isTextResource(selected) && authStatus === "authenticated" && selected.source === "upload" && (
                  <button type="button" className="document-local-edit-action" onClick={openLocalEditFlow} disabled={!selected.url || previewLoading}><FolderInput size={15} /> 本地编辑</button>
                )}
                {!editing && !isTextResource(selected) && !(authStatus === "authenticated" && selected.source === "upload") && <span className="document-edit-unavailable">此格式暂不支持在线编辑</span>}
                <button
                  type="button"
                  className="document-close-action"
                  aria-label={resourceSaving ? "正在自动保存" : "关闭预览"}
                  onClick={() => void closeResource()}
                  disabled={resourceSaving}
                >
                  {resourceSaving ? <LoaderCircle className="is-spinning" size={17} /> : <X size={18} />}
                </button>
              </div>
            </header>

            <div
              className={`document-workspace ${editing ? "is-editing" : ""} ${infoPaneCollapsed ? "is-info-collapsed" : ""}`}
              style={!editing ? { "--document-info-width": `${infoPaneCollapsed ? 0 : infoPaneWidth}px` } as CSSProperties : undefined}
            >
              <main className="document-preview-pane">
                {editing && isTextResource(draft) ? (
                  <section className="notion-document-canvas notes-page-redesign tech-notes-migrated knowledge-editor-reuse-host" aria-label="资料编辑器" data-resource-id={String(draft.id)}>
                    <div className="notes-notion-canvas knowledge-notion-canvas">
                      <NotionResourceEditor
                        content={draft.content || (draft.contentFormat === "html" ? "<p></p>" : "")}
                        documentFormat={isMarkdownResource(draft) ? "markdown" : draft.contentFormat === "html" ? "html" : "plain"}
                        showQuickStart={false}
                        onChange={(content) => {
                          setDraft((current) => current ? {
                            ...current,
                            content,
                            contentFormat: isMarkdownResource(current) ? "markdown" : current.contentFormat === "html" ? "html" : "plain",
                          } : current);
                          setDraftDirty(true);
                          signalPiloContext({ kind: "editing", surface: "knowledge", objectId: String(draft.id), objectTitle: draft.name, goalIds: draft.goalIds });
                        }}
                        placeholder="开始整理这份资料…"
                        documentHeader={(
                          <div className="note-document-heading knowledge-document-heading">
                            <div className="note-document-main">
                              <label className="note-title-editor" title="资料标题">
                                <span className="note-title-editor-icon" aria-hidden="true"><Heading1 size={16} /></span>
                                <input
                                  className="note-title-input"
                                  value={draft.name}
                                  onChange={(event) => {
                                    setDraft({ ...draft, name: event.target.value });
                                    setDraftDirty(true);
                                    signalPiloContext({ kind: "editing", surface: "knowledge", objectId: String(draft.id), objectTitle: event.target.value, goalIds: draft.goalIds });
                                  }}
                                  placeholder="为这份资料命名"
                                  aria-label="资料标题"
                                />
                              </label>
                            </div>
                          </div>
                        )}
                      />
                    </div>
                  </section>
                ) : renderPreview(selected)}
              </main>

              {!editing && <div
                className="document-info-resizer"
                role="separator"
                aria-label="调整资料信息栏宽度"
                aria-orientation="vertical"
                aria-valuemin={0}
                aria-valuemax={460}
                aria-valuenow={infoPaneCollapsed ? 0 : infoPaneWidth}
                tabIndex={0}
                onPointerDown={startInfoPaneResize}
                onKeyDown={resizeInfoPaneByKeyboard}
              >
                <button
                  type="button"
                  className="document-info-collapse-button"
                  aria-expanded={!infoPaneCollapsed}
                  aria-label={infoPaneCollapsed ? "展开资料信息" : "收起资料信息"}
                  title={infoPaneCollapsed ? "展开资料信息" : "收起资料信息"}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setInfoPaneCollapsed((current) => !current)}
                >
                  <ChevronRight size={14} />
                </button>
              </div>}

              {!editing && <aside className="document-info-pane">
                <div className="document-info-content">
                  <div className="document-info-heading">
                    <div>
                      <small>RESOURCE INFO</small>
                      <h2>资料信息</h2>
                    </div>
                    <div className="document-ai-status">
                      <span tabIndex={0} className={selected.status === "可用于 AI" ? "is-ready" : "is-pending"}>{selected.status === "可用于 AI" ? <><Check size={12} /> 可用于 AI</> : <><RefreshCw size={12} /> 处理中</>}</span>
                      <div className="document-ai-tooltip" role="tooltip">
                        {selected.status === "可用于 AI" ? "这份资料已完成索引，可由学习伙伴检索和引用。" : "资料正在解析并建立索引，完成后即可检索和引用。"}
                      </div>
                    </div>
                  </div>

                  <section className="document-destination-picker" aria-label="归档到">
                    <button type="button" className="document-destination-title" onClick={() => setArchiveExpanded((current) => !current)} aria-expanded={archiveExpanded} aria-controls="document-destination-body">
                      <span><strong>归档到</strong><span className="document-destination-hint">{metadataSaving ? "正在保存…" : `已选 ${draft.goalIds.length + draft.kbIds.length} 项 · 可多选`}</span></span>
                      <ChevronDown size={15} className={archiveExpanded ? "is-expanded" : ""} />
                    </button>
                    {archiveExpanded && <div id="document-destination-body" className="document-destination-body">
                      <section className="document-destination-section" aria-label="目标分类">
                        <button
                          type="button"
                          className="document-destination-section-toggle"
                          aria-expanded={archiveGoalsExpanded}
                          aria-controls="document-goal-destinations"
                          onClick={() => setArchiveGoalsExpanded((current) => !current)}
                        >
                          <span><strong>目标分类</strong><span className="document-destination-hint">{draft.goalIds.length ? `已选 ${draft.goalIds.length} 项` : "可多选"}</span></span>
                          <ChevronDown size={14} className={archiveGoalsExpanded ? "is-expanded" : ""} />
                        </button>
                        {archiveGoalsExpanded && <div id="document-goal-destinations" className="document-destination-options" role="group" aria-label="可选目标分类">
                          {goalOptions.map((goal) => <label key={goal.id}><input type="checkbox" checked={draft.goalIds.includes(goal.id)} onChange={() => togglePreviewDestination("goal", goal.id)} disabled={metadataSaving} /><span>{goal.title}</span></label>)}
                          {!goalOptions.length && <small className="document-destination-empty">还没有可选择的目标。</small>}
                        </div>}
                      </section>
                      <section className="document-destination-section" aria-label="个人文件夹">
                        <button
                          type="button"
                          className="document-destination-section-toggle"
                          aria-expanded={archiveLibrariesExpanded}
                          aria-controls="document-library-destinations"
                          onClick={() => setArchiveLibrariesExpanded((current) => !current)}
                        >
                          <span><strong>个人文件夹</strong><span className="document-destination-hint">{draft.kbIds.length ? `已选 ${draft.kbIds.length} 项` : "可多选"}</span></span>
                          <ChevronDown size={14} className={archiveLibrariesExpanded ? "is-expanded" : ""} />
                        </button>
                        {archiveLibrariesExpanded && <div id="document-library-destinations" className="document-destination-options" role="group" aria-label="可选个人文件夹">
                          {libraries.map((name) => {
                            const id = libraryIds[name] ?? name;
                            return <label key={name}><input type="checkbox" checked={draft.kbIds.includes(id)} onChange={() => togglePreviewDestination("library", id)} disabled={metadataSaving} /><span>{name}</span></label>;
                          })}
                          {!libraries.length && <small className="document-destination-empty">还没有个人文件夹。</small>}
                        </div>}
                      </section>
                      <p>未勾选任何分类时，这份资料会显示在“未关联资料”中；文件本体始终只保存一份。</p>
                    </div>}
                  </section>
                  <dl className="document-meta">
                    <div><dt>文件类型</dt><dd>{selected.type}</dd></div>
                    <div><dt>最近更新</dt><dd>{selected.updated}</dd></div>
                    <div><dt>AI 引用状态</dt><dd className={selected.status === "可用于 AI" ? "is-ready" : "is-pending"}>{selected.status === "可用于 AI" ? "已就绪" : "处理中"}</dd></div>
                  </dl>
                  <div className="document-ai-card">
                    <span><Sparkles size={12} /> {selected.status === "可用于 AI" ? "AI 已完成索引" : "AI 正在建立索引"}</span>
                    <strong>{selected.status === "可用于 AI" ? "学习伙伴可以在回答中引用这份资料" : "完成索引后，学习伙伴就能引用这份资料"}</strong>
                    <p>{selected.status === "可用于 AI" ? "正文和摘要已经进入当前学习上下文。" : "系统正在提取正文并建立检索索引。"}</p>
                    <Link href={`/studio/coach?resource=${selected.id}`}>与学习伙伴讨论 <MessageCircle size={14} /></Link>
                  </div>
                </div>
              </aside>}
            </div>
          </section>
        </div>
      )}

      {localEditOpen && selected && (
        <div className="local-edit-backdrop" onMouseDown={() => !replacementSaving && setLocalEditOpen(false)}>
          <section className="local-edit-dialog" role="dialog" aria-modal="true" aria-label="本地编辑并同步" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><small>EDIT LOCALLY</small><h2>本地编辑并同步</h2><p>{selected.name}</p></div>
              <button type="button" aria-label="关闭本地编辑" onClick={() => setLocalEditOpen(false)} disabled={replacementSaving}><X size={17} /></button>
            </header>
            <ol className="local-edit-steps">
              <li className="is-done"><span>1</span><div><strong>原文件已下载</strong><small>使用 Word、WPS、Acrobat、图片编辑器等本地软件打开。</small></div></li>
              <li><span>2</span><div><strong>在本地完成修改并保存</strong><small>请保持原文件格式，不要改变扩展名。</small></div></li>
              <li><span>3</span><div><strong>上传保存后的文件</strong><small>目标、文件夹和收藏不会变化，系统会自动重新建立索引。</small></div></li>
            </ol>
            <div className="local-edit-actions">
              <button type="button" onClick={() => downloadResource(selected)}><Download size={15} />重新下载原文件</button>
              <button type="button" className="is-primary" onClick={() => replacementInputRef.current?.click()} disabled={replacementSaving}><Upload size={15} />{replacementSaving ? "正在同步…" : "上传修改版"}</button>
              <input
                ref={replacementInputRef}
                type="file"
                hidden
                accept={selected.name.includes(".") ? `.${selected.name.split(".").pop()?.toLowerCase()}` : undefined}
                onChange={(event) => void replaceWithLocalFile(event)}
              />
            </div>
            <section className="local-version-history">
              <div><strong><Clock3 size={14} />历史版本</strong><small>最多保留最近 10 个版本</small></div>
              {versionLoading ? <p>正在读取历史版本…</p> : fileVersions.length ? (
                <ul>{fileVersions.map((version) => <li key={version.id}><div><strong>{version.filename}</strong><small>{version.createdAt} · {version.size}</small></div><button type="button" onClick={() => void restoreFileVersion(version.id)} disabled={replacementSaving}>恢复</button></li>)}</ul>
              ) : <p>还没有历史版本。首次上传修改版后，当前文件会自动保存在这里。</p>}
            </section>
            <footer><Check size={13} /><span>替换失败不会影响当前文件；恢复历史版本前也会自动备份当前版本。</span></footer>
          </section>
        </div>
      )}

      {toast && <div className="resource-toast"><Check size={15} /> {toast}</div>}
    </div>
  );
}
