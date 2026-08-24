"use client";

import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Heading1,
  Maximize2,
  Minimize2,
  Plus,
  Search,
  Target,
  Trash2,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useAuth } from "@/components/technology/AuthProvider";
import { WorkspaceSkeleton } from "@/components/technology/WorkspaceSkeleton";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataSyncNotice } from "@/components/ui/DataSyncNotice";
import { useToast } from "@/components/ui/Toast";
import { productApi, type ApiGoal, type ApiNote } from "@/lib/technology/productApi";
import {
  PRODUCT_STORAGE_KEYS,
  readProductArray,
  writeProductArray,
} from "@/lib/technology/productData";
import { signalPiloState } from "@/lib/technology/piloState";
import { signalPiloContext } from "@/lib/technology/piloContext";
import { readScopedJson, writeScopedJson } from "@/lib/technology/scopedStorage";
import { GUEST_NOTES, ensureGuestDatasetSeeded, guestApiGoals } from "@/lib/technology/guestData";

const NotionResourceEditor = dynamic(
  () => import("@/components/technology/NotionResourceEditor"),
  {
    ssr: false,
    loading: () => <WorkspaceSkeleton variant="editor" label="正在准备笔记编辑器" />,
  },
);

type Note = {
  id: string | number;
  goalId?: string | null;
  title: string;
  date: string;
  goal: string;
  content: string;
  contentFormat?: "plain" | "html";
  createdAt?: string;
  updatedAt?: string;
};

type MarkdownWritable = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
};

type MarkdownFileHandle = {
  createWritable(): Promise<MarkdownWritable>;
};

type MarkdownSavePicker = (options: {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<MarkdownFileHandle>;

const INITIAL_NOTES: Note[] = GUEST_NOTES.map((note) => ({ ...note }));
const GUEST_NOTE_GOALS = guestApiGoals();

function createDraftId() {
  return `draft-${crypto.randomUUID()}`;
}

function deduplicateNotes(notes: Note[]) {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = String(note.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function noteToEditorHtml(note: Note) {
  if (note.contentFormat === "html") return note.content || "<p></p>";
  const paragraphs = note.content.split(/\n{2,}/).filter(Boolean);
  return paragraphs.length
    ? paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("")
    : "<p></p>";
}

function htmlToPlainText(value: string) {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function notePreview(note: Note) {
  return note.contentFormat === "html" ? htmlToPlainText(note.content) : note.content;
}

function isPlaceholderTitle(title: string) {
  return !title.trim() || title.trim() === "无标题笔记";
}

function deriveNoteTitle(note: Pick<Note, "title" | "content" | "contentFormat">) {
  if (!isPlaceholderTitle(note.title)) return note.title.trim();
  const body = notePreview(note as Note).replace(/\s+/g, " ").trim();
  if (!body) return "";
  const firstThought = body.split(/[。！？!?\n]/, 1)[0]?.trim() || body;
  return firstThought.length > 22 ? `${firstThought.slice(0, 22)}…` : firstThought;
}

function displayNoteTitle(note: Note) {
  const resolved = deriveNoteTitle(note);
  if (resolved) return resolved;
  const moment = displayUpdatedTime(note).replace(/^编辑于\s*/, "");
  return moment === "刚刚" ? "刚刚记录的想法" : `${moment}的想法`;
}

function displayUpdatedTime(note: Note) {
  if (!note.updatedAt) return note.date;
  const updatedAt = new Date(note.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) return note.date;
  const today = new Date();
  const sameDay = updatedAt.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(updatedAt);
}

function displayCreatedDate(note: Note) {
  if (!note.createdAt) return note.date.replace(/\s+\d{1,2}:\d{2}$/, "");
  const createdAt = new Date(note.createdAt);
  if (Number.isNaN(createdAt.getTime())) return note.date.replace(/\s+\d{1,2}:\d{2}$/, "");
  const currentYear = new Date().getFullYear();
  return new Intl.DateTimeFormat("zh-CN", createdAt.getFullYear() === currentYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" })
    .format(createdAt);
}

function displayCreatedClock(note: Note) {
  if (!note.createdAt) return note.date.match(/(\d{1,2}:\d{2})$/)?.[1] ?? "";
  const createdAt = new Date(note.createdAt);
  if (Number.isNaN(createdAt.getTime())) return note.date.match(/(\d{1,2}:\d{2})$/)?.[1] ?? "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(createdAt);
}

function displayCreatedExactTime(note: Note) {
  if (!note.createdAt) return note.date;
  const createdAt = new Date(note.createdAt);
  if (Number.isNaN(createdAt.getTime())) return note.date;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(createdAt);
}

function editableNote(note: Note): Note {
  return { ...note, content: noteToEditorHtml(note), contentFormat: "html" };
}

function safeMarkdownName(title: string) {
  const cleaned = title.trim().replace(/[\\/:*?"<>|]/g, "-");
  return `${cleaned || "无标题笔记"}.md`;
}

function markdownExport(note: Note) {
  const content = note.contentFormat === "html" ? htmlToPlainText(note.content) : note.content;
  const resolvedTitle = displayNoteTitle(note);
  const body = `# ${resolvedTitle}\n\n${content}`;
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  return { blob, filename: safeMarkdownName(resolvedTitle) };
}

function downloadMarkdown(note: Note) {
  const { blob, filename } = markdownExport(note);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function saveMarkdownAs(note: Note): Promise<"saved" | "unsupported" | "cancelled"> {
  const picker = (window as Window & { showSaveFilePicker?: MarkdownSavePicker }).showSaveFilePicker;
  if (!picker) return "unsupported";

  const { blob, filename } = markdownExport(note);
  try {
    const handle = await picker({
      suggestedName: filename,
      types: [{
        description: "Markdown 文档",
        accept: { "text/markdown": [".md"] },
      }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return "saved";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    throw error;
  }
}

export default function NotesPage() {
  const { status: authStatus, user } = useAuth();
  const { confirmAction } = useConfirmDialog();
  const { showToast } = useToast();
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [notes, setNotes] = useState<Note[]>(INITIAL_NOTES);
  const [storageReady, setStorageReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | number>(INITIAL_NOTES[0].id);
  const [draft, setDraft] = useState<Note>(() => editableNote(INITIAL_NOTES[0]));
  const [draftDirty, setDraftDirty] = useState(false);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [query, setQuery] = useState("");
  const [savingMarkdown, setSavingMarkdown] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenToolbarHost, setFullscreenToolbarHost] = useState<HTMLDivElement | null>(null);
  const [indexCollapsed, setIndexCollapsed] = useState(false);
  const [goalFilter, setGoalFilter] = useState("all");
  const [filterPickerOpen, setFilterPickerOpen] = useState(false);
  const [goalOptions, setGoalOptions] = useState<ApiGoal[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorScrolling, setEditorScrolling] = useState(false);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const editorScrollTimerRef = useRef<number | null>(null);
  const draftRef = useRef<Note>(draft);
  const draftDirtyRef = useRef(draftDirty);
  const draftIsNewRef = useRef(draftIsNew);
  const filterPickerRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    draftRef.current = draft;
    draftDirtyRef.current = draftDirty;
    draftIsNewRef.current = draftIsNew;
  }, [draft, draftDirty, draftIsNew]);

  useEffect(() => () => {
    if (editorScrollTimerRef.current !== null) window.clearTimeout(editorScrollTimerRef.current);
  }, []);

  function handleEditorScroll() {
    setEditorScrolling(true);
    if (editorScrollTimerRef.current !== null) window.clearTimeout(editorScrollTimerRef.current);
    editorScrollTimerRef.current = window.setTimeout(() => {
      setEditorScrolling(false);
      editorScrollTimerRef.current = null;
    }, 700);
  }

  useEffect(() => {
    if (!draftIsNew) return;
    window.requestAnimationFrame(() => titleInputRef.current?.focus());
  }, [draftIsNew, selectedId]);

  useEffect(() => {
    setIndexCollapsed(readScopedJson(
      "notes-index-collapsed",
      user?.id,
      false,
      "planpilot-notes-index-collapsed",
    ));
  }, [user?.id]);

  function toggleIndex() {
    setIndexCollapsed((current) => {
      const next = !current;
      writeScopedJson("notes-index-collapsed", user?.id, next, "planpilot-notes-index-collapsed");
      return next;
    });
  }

  useEffect(() => {
    if (!filterPickerOpen) return;
    function closeGoalPicker(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      if (!filterPickerRef.current?.contains(event.target)) setFilterPickerOpen(false);
    }
    function closeGoalPickerOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setFilterPickerOpen(false);
    }
    document.addEventListener("mousedown", closeGoalPicker);
    window.addEventListener("keydown", closeGoalPickerOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeGoalPicker);
      window.removeEventListener("keydown", closeGoalPickerOnEscape);
    };
  }, [filterPickerOpen]);

  const noteGoalId = useCallback((note: Note) => {
    if (note.goalId) return note.goalId;
    if (authStatus === "authenticated") return null;
    return GUEST_NOTE_GOALS.find((goal) => goal.title === note.goal)?.id ?? null;
  }, [authStatus]);

  const noteMatchesGoal = useCallback((note: Note, filter: string) => {
    if (filter === "all") return true;
    const linkedGoalId = noteGoalId(note);
    if (filter === "unlinked") return !linkedGoalId;
    return linkedGoalId === filter;
  }, [noteGoalId]);

  const visibleNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const displayNotes = notes.map((note) => note.id === selectedId && !draftIsNew ? draft : note);
    const filtered = displayNotes.filter((note) => {
      const searchable = `${note.title} ${note.goal} ${notePreview(note)}`.toLowerCase();
      return noteMatchesGoal(note, goalFilter) && searchable.includes(normalizedQuery);
    });
    return draftIsNew ? [draft, ...filtered] : filtered;
  }, [draft, draftIsNew, goalFilter, noteMatchesGoal, notes, query, selectedId]);

  const selectableGoals = useMemo(
    () => authStatus === "authenticated"
      ? [...goalOptions.map((goal) => ({ id: goal.id, title: goal.title })), { id: "", title: "未关联" }]
      : [...GUEST_NOTE_GOALS.map((goal) => ({ id: goal.id, title: goal.title })), { id: "", title: "未关联" }],
    [authStatus, goalOptions],
  );

  const filterGoals = useMemo(
    () => [
      { id: "all", title: "全部目标" },
      ...selectableGoals.filter((goal) => goal.id && goal.title !== "未关联"),
      { id: "unlinked", title: "未关联目标" },
    ],
    [selectableGoals],
  );

  const noteCountByGoal = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const displayNotes = notes.map((note) => note.id === selectedId && !draftIsNew ? draft : note);
    const countByGoal: Record<string, number> = { all: 0, unlinked: 0 };
    displayNotes.forEach((note) => {
      const searchable = `${note.title} ${note.goal} ${notePreview(note)}`.toLowerCase();
      if (normalizedQuery && !searchable.includes(normalizedQuery)) return;
      countByGoal.all += 1;
      const key = noteGoalId(note) || "unlinked";
      countByGoal[key] = (countByGoal[key] ?? 0) + 1;
    });
    if (draftIsNew) {
      const searchable = `${draft.title} ${draft.goal} ${notePreview(draft)}`.toLowerCase();
      if (!normalizedQuery || searchable.includes(normalizedQuery)) {
        countByGoal.all += 1;
        const key = noteGoalId(draft) || "unlinked";
        countByGoal[key] = (countByGoal[key] ?? 0) + 1;
      }
    }
    return countByGoal;
  }, [draft, draftIsNew, noteGoalId, notes, query, selectedId]);

  const selectedFilterTitle = filterGoals.find((goal) => goal.id === goalFilter)?.title ?? "全部目标";

  useEffect(() => {
    if (authStatus === "loading") return;
    if (authStatus === "unauthenticated") {
      ensureGuestDatasetSeeded();
      const storedNotes = deduplicateNotes(readProductArray<Note>(PRODUCT_STORAGE_KEYS.notes, INITIAL_NOTES));
      const nextNotes = storedNotes.length ? storedNotes : INITIAL_NOTES;
      const params = new URLSearchParams(window.location.search);
      const requestedGoal = params.get("goalId");
      const validFilter = requestedGoal === "unlinked" || (requestedGoal && GUEST_NOTE_GOALS.some((goal) => goal.id === requestedGoal)) ? requestedGoal : "all";
      const initialNote = nextNotes.find((note) => noteMatchesGoal(note, validFilter)) ?? nextNotes[0];
      setGoalFilter(validFilter);
      setNotes(nextNotes); setSelectedId(initialNote.id); setDraft(editableNote(initialNote)); setStorageReady(true);
      signalPiloContext({
        kind: "object-opened",
        surface: "notes",
        itemCount: nextNotes.length,
        objectId: String(initialNote.id),
        objectTitle: displayNoteTitle(initialNote),
        goalIds: initialNote.goalId ? [initialNote.goalId] : [],
      });
      return;
    }
    let active = true;
    setDataLoading(true); setDataError("");
    void Promise.all([productApi.listNotes(), productApi.listGoals()]).then(([nextNotes, nextGoals]) => {
      if (!active) return;
      const mapped = nextNotes.map(noteFromApi);
      const params = new URLSearchParams(window.location.search);
      const requestedGoalId = params.get("goalId");
      const requestedGoal = nextGoals.find((goal) => goal.id === requestedGoalId);
      const initialFilter = requestedGoalId === "unlinked" ? "unlinked" : requestedGoal?.id ?? "all";
      const requestedCreate = params.get("create") === "1";
      setGoalFilter(initialFilter); setGoalOptions(nextGoals); setNotes(mapped);
      if (requestedCreate) {
        const empty: Note = {
          id: createDraftId(),
          goalId: requestedGoal?.id ?? null,
          title: "",
          date: "刚刚",
          goal: requestedGoal?.title ?? "未关联",
          content: "<p></p>",
          contentFormat: "html",
        };
        setSelectedId(empty.id); setDraft(empty); setDraftIsNew(true); setDraftDirty(true);
        signalPiloContext({ kind: "editing", surface: "notes", itemCount: mapped.length, objectId: String(empty.id), objectTitle: "新笔记", goalIds: empty.goalId ? [empty.goalId] : [] });
      } else if (mapped[0]) {
        const initialNote = mapped.find((note) => noteMatchesGoal(note, initialFilter)) ?? mapped[0];
        setSelectedId(initialNote.id); setDraft(editableNote(initialNote)); setDraftIsNew(false);
        signalPiloContext({
          kind: "object-opened",
          surface: "notes",
          itemCount: mapped.length,
          objectId: String(initialNote.id),
          objectTitle: displayNoteTitle(initialNote),
          goalIds: initialNote.goalId ? [initialNote.goalId] : [],
        });
      }
      else {
        const empty: Note = { id: createDraftId(), goalId: requestedGoal?.id ?? null, title: "", date: "刚刚", goal: requestedGoal?.title ?? "未关联", content: "<p></p>", contentFormat: "html" };
        setSelectedId(empty.id); setDraft(empty); setDraftIsNew(true);
        signalPiloContext({ kind: "scope", surface: "notes", itemCount: 0 });
      }
    }).catch((reason) => { if (active) setDataError(reason instanceof Error ? reason.message : "笔记加载失败"); })
      .finally(() => { if (active) setDataLoading(false); });
    return () => { active = false; };
  }, [authStatus, noteMatchesGoal]);

  useEffect(() => {
    if (!storageReady || authStatus === "authenticated") return;
    writeProductArray(PRODUCT_STORAGE_KEYS.notes, notes);
  }, [authStatus, notes, storageReady]);

  function noteFromApi(note: ApiNote): Note {
    const contentFormat = /^\s*</.test(note.content) ? "html" : "plain";
    return { id: note.id, goalId: note.goalId || null, title: note.title || "", date: note.date || new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(note.createdAt)), createdAt: note.createdAt, updatedAt: note.updatedAt, goal: note.goalTitle || "未关联", content: note.content, contentFormat };
  }

  useEffect(() => {
    if (!fullscreen) return;
    function exitFullscreen(event: KeyboardEvent) {
      if (event.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", exitFullscreen);
    return () => window.removeEventListener("keydown", exitFullscreen);
  }, [fullscreen]);

  useEffect(() => {
    function guardInternalNavigation(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement) || target.target === "_blank" || target.hasAttribute("download")) return;
      const nextUrl = new URL(target.href, window.location.href);
      if (nextUrl.origin !== window.location.origin || nextUrl.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      requestAfterDiscard(() => router.push(`${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`));
    }
    document.addEventListener("click", guardInternalNavigation, true);
    return () => document.removeEventListener("click", guardInternalNavigation, true);
  }, [router]); // eslint-disable-line react-hooks/exhaustive-deps -- refs keep the navigation guard on the latest editor state

  function requestAfterDiscard(action: () => void) {
    if (!draftDirtyRef.current) {
      action();
      return;
    }
    void saveDraft().then((saved) => {
      if (saved) action();
    });
  }

  function selectNote(note: Note) {
    if (note.id === selectedId && !draftIsNew) return;
    requestAfterDiscard(() => {
      setSelectedId(note.id);
      setDraft(editableNote(note));
      setDraftIsNew(false);
      setDraftDirty(false);
      signalPiloContext({
        kind: "object-opened",
        surface: "notes",
        objectId: String(note.id),
        objectTitle: displayNoteTitle(note),
        goalIds: note.goalId ? [note.goalId] : [],
      });
    });
  }

  function selectGoalFilter(nextFilter: string) {
    setFilterPickerOpen(false);
    if (nextFilter === goalFilter) return;
    requestAfterDiscard(() => {
      const nextNote = notes.find((note) => noteMatchesGoal(note, nextFilter));
      setGoalFilter(nextFilter);
      if (nextNote) {
        setSelectedId(nextNote.id);
        setDraft(editableNote(nextNote));
        setDraftIsNew(false);
        setDraftDirty(false);
      }
      const nextUrl = nextFilter === "all"
        ? "/studio/work/notes"
        : `/studio/work/notes?goalId=${encodeURIComponent(nextFilter)}`;
      window.history.replaceState(null, "", nextUrl);
    });
  }

  function goalDefaultsForFilter() {
    if (goalFilter === "all" || goalFilter === "unlinked") return { goalId: null, goal: "未关联" };
    if (authStatus === "authenticated") {
      const goal = goalOptions.find((item) => item.id === goalFilter);
      return { goalId: goal?.id ?? null, goal: goal?.title ?? "未关联" };
    }
    const goal = GUEST_NOTE_GOALS.find((item) => item.id === goalFilter);
    return { goalId: goal?.id ?? null, goal: goal?.title ?? "未关联" };
  }

  function createNote() {
    requestAfterDiscard(() => {
      const goalDefaults = goalDefaultsForFilter();
      const newNote: Note = {
        id: createDraftId(),
        goalId: goalDefaults.goalId,
        title: "",
        date: "刚刚",
        goal: goalDefaults.goal,
        content: "<p></p>",
        contentFormat: "html",
        createdAt: new Date().toISOString(),
      };
      // Update the synchronous guards before the previous editor unmounts.
      // Tiptap may emit one final update during that transition; without these
      // refs it can write the old note back over the freshly created draft.
      draftRef.current = newNote;
      draftIsNewRef.current = true;
      draftDirtyRef.current = true;
      setSelectedId(newNote.id);
      setDraft(newNote);
      setDraftIsNew(true);
      setDraftDirty(true);
      signalPiloState("working", {
        source: "notes:capture-idea",
        reason: "你开始记录一条新笔记，Pilo 会先陪你把想法留下来",
        duration: 18_000,
        accessory: "glasses",
        lifeAction: "capture-idea",
      });
    });
  }

  function updateDraft(patch: Partial<Note>) {
    const nextDraft = { ...draftRef.current, ...patch };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    draftDirtyRef.current = true;
    setDraftDirty(true);
    const nextGoalId = Object.prototype.hasOwnProperty.call(patch, "goalId") ? patch.goalId : nextDraft.goalId;
    signalPiloContext({
      kind: "editing",
      surface: "notes",
      objectId: String(selectedId),
      objectTitle: patch.title ?? nextDraft.title,
      goalIds: nextGoalId ? [String(nextGoalId)] : [],
    });
  }

  async function persistDraft(): Promise<boolean> {
    const currentDraft = draftRef.current;
    const currentIsNew = draftIsNewRef.current;
    const hasContent = Boolean(currentDraft.title.trim() || notePreview(currentDraft).trim());
    if (!hasContent) {
      draftDirtyRef.current = false;
      setDraftDirty(false);
      return true;
    }
    const resolvedTitle = deriveNoteTitle(currentDraft) || "新笔记";
    const committed: Note = {
      ...currentDraft,
      title: resolvedTitle,
      date: currentIsNew ? "刚刚" : currentDraft.date,
      createdAt: currentDraft.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contentFormat: "html",
    };
    setSaving(true);
    setDataError("");
    if (authStatus === "authenticated") {
      try {
        const saved = currentIsNew
          ? await productApi.createNote({ goalId: committed.goalId ?? null, title: committed.title, content: committed.content, noteType: "quick_note" })
          : await productApi.updateNote(String(committed.id), { goalId: committed.goalId ?? null, title: committed.title, content: committed.content });
        const nextNote = noteFromApi(saved as ApiNote);
        setNotes((current) => currentIsNew ? [nextNote, ...current] : current.map((note) => note.id === committed.id ? nextNote : note));
        draftRef.current = editableNote(nextNote);
        setDraft(draftRef.current); setSelectedId(nextNote.id);
      } catch (reason) {
        signalPiloState("failure", { source: "notes:save", duration: 4_200 });
        setDataError(reason instanceof Error ? reason.message : "笔记自动保存失败，请稍后重试");
        setSaving(false);
        return false;
      }
    } else {
      setNotes((current) => {
        const nextNotes = currentIsNew
          ? [committed, ...current]
          : current.map((note) => note.id === committed.id ? committed : note);
        writeProductArray(PRODUCT_STORAGE_KEYS.notes, nextNotes);
        return nextNotes;
      });
      draftRef.current = committed;
      setDraft(committed); setSelectedId(committed.id);
    }
    draftIsNewRef.current = false;
    draftDirtyRef.current = false;
    setDraftIsNew(false); setDraftDirty(false);
    setSaving(false);
    signalPiloContext({ kind: "saved", surface: "notes", objectId: String(committed.id), objectTitle: committed.title, goalIds: committed.goalId ? [committed.goalId] : [] });
    return true;
  }

  function saveDraft() {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const save = persistDraft();
    saveInFlightRef.current = save;
    void save.finally(() => {
      if (saveInFlightRef.current === save) saveInFlightRef.current = null;
    });
    return save;
  }

  const handleSaveMarkdown = useCallback(async () => {
    if (savingMarkdown) return;
    setSavingMarkdown(true);
    try {
      const result = await saveMarkdownAs(draft);
      if (result === "saved") showToast("已保存为 Markdown", "success");
      if (result === "unsupported") {
        const confirmed = await confirmAction({
          title: "当前浏览器无法选择保存位置",
          description: "这个浏览器没有开放系统文件保存选择器。你可以改用支持该能力的 Chrome 或 Edge，或者将 Markdown 下载到浏览器的默认下载位置。",
          confirmLabel: "下载到默认位置",
          cancelLabel: "取消",
          tone: "primary",
        });
        if (confirmed) {
          downloadMarkdown(draft);
          showToast("已下载 Markdown", "success");
        }
      }
    } catch {
      showToast("无法写入所选位置，请检查文件权限后重试", "error");
    } finally {
      setSavingMarkdown(false);
    }
  }, [confirmAction, draft, savingMarkdown, showToast]);

  async function deleteNote(note: Note) {
    const deletingCurrent = note.id === selectedId;
    if (deletingCurrent && draftIsNew) {
      if (notes[0]) { setSelectedId(notes[0].id); setDraft(editableNote(notes[0])); setDraftIsNew(false); setDraftDirty(false); }
      return;
    }
    const confirmed = await confirmAction({
      title: `删除笔记“${displayNoteTitle(note)}”？`,
      description: "这篇笔记将从笔记列表中移除，此操作无法撤销。",
      confirmLabel: "确认删除",
      cancelLabel: "保留笔记",
      tone: "danger",
    });
    if (!confirmed) return;
    if (authStatus === "authenticated" && typeof note.id === "string") {
      try { await productApi.deleteNote(note.id); }
      catch (reason) { setDataError(reason instanceof Error ? reason.message : "笔记删除失败"); return; }
    }
    const remaining = notes.filter((item) => item.id !== note.id);
    setNotes(remaining);
    if (!deletingCurrent) return;
    if (remaining[0]) { setSelectedId(remaining[0].id); setDraft(editableNote(remaining[0])); }
    else {
      const empty: Note = { id: createDraftId(), goalId: null, title: "", date: "刚刚", goal: "未关联", content: "<p></p>", contentFormat: "html" };
      setSelectedId(empty.id); setDraft(empty); setDraftIsNew(true);
    }
    setDraftDirty(false);
  }

  useEffect(() => {
    if (!draftDirty || saving || (!draft.title.trim() && !notePreview(draft).trim())) return;
    const timer = window.setTimeout(() => {
      void saveDraft();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [authStatus, draft, draftDirty, draftIsNew, saving]); // eslint-disable-line react-hooks/exhaustive-deps -- saveDraft must persist the current render snapshot

  return (
    <div className="resource-page notes-page-redesign tech-notes-migrated">
      <header className="workspace-pagebar goals-redesign-heading notes-reference-header">
        <div className="workspace-page-title">
          <small>NOTES</small>
          <h1>学习笔记</h1>
          <span>沉淀学习过程，把零散思考整理成可复用的知识</span>
        </div>
        <div className="notes-reference-actions" aria-label="笔记工具栏">
          <label className="notes-command-search">
            <Search size={16} />
            <input className="notes-search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文或关联目标" aria-label="搜索笔记" />
            {query && <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={14} /></button>}
          </label>
          <button type="button" className="primary-action notes-create-action" onClick={createNote}>
            <Plus size={16} /> 新建笔记
          </button>
        </div>
      </header>

      {(dataLoading || dataError) && (
        <DataSyncNotice
          loading={dataLoading && !dataError}
          title={dataError ? "笔记同步失败" : "正在同步笔记"}
          message={dataError || undefined}
          retryLabel="重新加载"
          onRetry={() => window.location.reload()}
        />
      )}

      <section className={`notes-workspace ${indexCollapsed ? "is-index-collapsed" : ""}`}>
        <aside className="notes-list" aria-label="笔记列表">
          <button
            type="button"
            className="notes-index-collapse"
            onClick={toggleIndex}
            aria-label={indexCollapsed ? "展开笔记列表" : "收起笔记列表"}
            aria-expanded={!indexCollapsed}
          >
            {indexCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>
          <header>
            <div className="notes-goal-control notes-filter-control" ref={filterPickerRef}>
              <button
                type="button"
                className="notes-goal-trigger"
                aria-label="筛选笔记目标"
                aria-haspopup="listbox"
                aria-expanded={filterPickerOpen}
                onClick={() => setFilterPickerOpen((current) => !current)}
              >
                <Target size={16} aria-hidden="true" />
                <span className="notes-filter-copy">
                  <strong>{selectedFilterTitle}</strong>
                  <span className="notes-filter-meta">
                    <small className="notes-filter-count" aria-label={`${visibleNotes.length} 篇笔记`}>
                      <b aria-hidden="true">{visibleNotes.length}</b>
                      <span aria-hidden="true">篇笔记</span>
                    </small>
                    <ChevronDown size={15} className={filterPickerOpen ? "is-open" : ""} aria-hidden="true" />
                  </span>
                </span>
              </button>
              <AnimatePresence>
                {filterPickerOpen && (
                  <motion.div
                    className="notes-goal-popover"
                    role="listbox"
                    aria-label="可筛选目标"
                    initial={reduceMotion ? false : { opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                  >
                    <div>
                      {filterGoals.map((goal) => {
                        const selected = goal.id === goalFilter;
                        return (
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={selected ? "is-selected" : ""}
                            key={goal.id}
                            onClick={() => selectGoalFilter(goal.id)}
                          >
                            <Target size={14} aria-hidden="true" />
                            <span>{goal.title}</span>
                            <small className="notes-goal-option-count">{noteCountByGoal[goal.id] ?? 0} 篇</small>
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </header>
          <div className="notes-list-scroll">
            <AnimatePresence initial={false} mode="popLayout">
              {visibleNotes.map((note, index) => {
                const active = selectedId === note.id;
                const visibleNote = active ? draft : note;
                const preview = notePreview(visibleNote);
                const resolvedTitle = displayNoteTitle(visibleNote);
                const linkedGoal = visibleNote.goal || "未关联";
                return (
                  <motion.article
                    layout={!reduceMotion}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
                    transition={{ duration: 0.18, delay: reduceMotion ? 0 : Math.min(index * 0.025, 0.12) }}
                    key={note.id}
                    className={`notes-list-row ${active ? "is-active" : ""}`}
                  >
                    <div className="note-list-topline">
                      <span className="note-list-meta">
                        <small
                          aria-label={`创建于 ${displayCreatedExactTime(visibleNote)}`}
                          title={`创建于 ${displayCreatedExactTime(visibleNote)}`}
                        >
                          <span>{displayCreatedDate(visibleNote)}</span>
                          {displayCreatedClock(visibleNote) && <time>{displayCreatedClock(visibleNote)}</time>}
                        </small>
                      </span>
                    </div>
                    <button type="button" className="note-list-select" onClick={() => selectNote(note)}>
                      <strong className={!deriveNoteTitle(visibleNote) ? "is-placeholder" : ""}>{resolvedTitle}</strong>
                      <span className={`note-list-preview ${preview ? "" : "is-empty"}`}>{preview || "还没有正文，写下第一句话吧"}</span>
                    </button>
                    <div className="note-list-footer">
                      <span className="note-list-goal-label"><Target size={12} aria-hidden="true" />{linkedGoal}</span>
                      <button type="button" className="note-card-action note-card-delete" aria-label={`删除笔记“${resolvedTitle}”`} title="删除笔记" onClick={() => void deleteNote(note)}><Trash2 size={14} /></button>
                    </div>
                  </motion.article>
                );
              })}
            </AnimatePresence>
            {!visibleNotes.length && (
              <div className="notes-empty-state">
                {query ? <Search size={18} /> : <Target size={18} />}
                <strong>{query ? "没有匹配的笔记" : "这个目标下还没有笔记"}</strong>
                <span>{query ? "试试其他关键词" : "新建笔记时会自动关联当前目标"}</span>
              </div>
            )}
          </div>
        </aside>

        <article className={`note-editor ${fullscreen ? "is-fullscreen" : ""}`}>
          {fullscreen && (
            <header className="note-fullscreen-topbar">
              <button type="button" className="note-fullscreen-back" onClick={() => setFullscreen(false)}>
                <span className="note-fullscreen-back-icon" aria-hidden="true"><ArrowLeft size={17} /></span>
                <strong>返回笔记</strong>
              </button>
              <div ref={setFullscreenToolbarHost} className="note-fullscreen-actions" aria-label="全屏编辑操作" />
            </header>
          )}
          <motion.section
            key={selectedId}
            className={`notes-notion-canvas ${editorScrolling ? "is-scrolling" : ""}`}
            aria-label="笔记编辑器"
            onScroll={handleEditorScroll}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <NotionResourceEditor
              content={draft.content}
              onChange={(content) => updateDraft({ content, contentFormat: "html" })}
              onEditorModeChange={(mode) => {
                if (mode === "split") setFullscreen(true);
              }}
              onTemplateApply={(title) => {
                if (isPlaceholderTitle(draftRef.current.title)) updateDraft({ title });
              }}
              placeholder={isPlaceholderTitle(draft.title) ? "先写下第一句话，保存时可自动生成标题" : ""}
              toolbarMount={fullscreen ? fullscreenToolbarHost : null}
              toolbarEnd={(
                <>
                  <button
                    type="button"
                    className="note-toolbar-save-as"
                    aria-label={savingMarkdown ? "正在另存为 Markdown" : `将“${displayNoteTitle(draft)}”另存为 Markdown`}
                    aria-busy={savingMarkdown}
                    title={savingMarkdown ? "正在写入文件" : "选择位置并另存为 Markdown"}
                    disabled={savingMarkdown}
                    onClick={() => void handleSaveMarkdown()}
                  >
                    <span>{savingMarkdown ? "保存中" : "另存为"}</span>
                  </button>
                  <button type="button" className="note-toolbar-fullscreen" aria-label={fullscreen ? "退出全屏" : "全屏编辑"} title={fullscreen ? "退出全屏" : "全屏编辑"} onClick={() => setFullscreen((current) => !current)}>
                    {fullscreen ? <Minimize2 size={17} aria-hidden="true" /> : <Maximize2 size={17} aria-hidden="true" />}
                  </button>
                </>
              )}
              documentHeader={(
                <div className="note-document-heading">
                  <div className="note-document-main">
                    <label className="note-title-editor" title="笔记标题">
                      <span className="note-title-editor-icon" aria-hidden="true"><Heading1 size={16} /></span>
                      <input
                        ref={titleInputRef}
                        className="note-title-input"
                        value={draft.title}
                        onChange={(event) => updateDraft({ title: event.target.value })}
                        placeholder="为这篇笔记命名"
                        aria-label="笔记标题"
                      />
                    </label>
                  </div>
                </div>
              )}
            />
          </motion.section>
        </article>
      </section>

    </div>
  );
}
