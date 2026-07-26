"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, CalendarDays, ChevronDown, ExternalLink, Plus } from "lucide-react";
import { api } from "@/lib/api";
import type { KnowledgeNote } from "@/lib/knowledge-context";

interface GoalNotesPanelProps {
  goalId: string;
}

function stripHtml(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default function GoalNotesPanel({ goalId }: GoalNotesPanelProps) {
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api.get<KnowledgeNote[]>(
      `/api/v1/knowledge/notes?goal_id=${goalId}`
    ).catch(() => []);
    setNotes(data.filter((note) => ["daily_log", "flash_card"].includes(note.noteType)));
    setLoading(false);
  }, [goalId]);

  useEffect(() => { void load(); }, [load]);

  const studyNotes = notes.filter((note) => note.noteType === "daily_log");
  const studyLogs = notes.filter((note) => note.noteType === "flash_card");

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-3 text-xs text-gray-500">
          <span className="inline-flex items-center gap-1">
            <CalendarDays size={12} style={{ color: "var(--accent)" }} />
            笔记 {studyNotes.length}
          </span>
          <span className="inline-flex items-center gap-1">
            <BookOpen size={12} style={{ color: "var(--accent)" }} />
            日志 {studyLogs.length}
          </span>
        </div>
        <div className="relative">
          <button
            onClick={() => setNewMenuOpen((open) => !open)}
            aria-expanded={newMenuOpen}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
            style={{ backgroundColor: "var(--accent)" }}
          >
            <Plus size={12} />新建<ChevronDown size={11} />
          </button>
          {newMenuOpen && (
            <div className="absolute right-0 top-9 z-20 w-40 overflow-hidden rounded-xl border border-gray-100 bg-white p-1.5 shadow-xl">
              <Link
                href={`/dashboard/notes?tab=log&goalId=${goalId}&create=1`}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-gray-600 transition hover:bg-gray-50"
              >
                <CalendarDays size={13} />学习笔记
              </Link>
              <Link
                href={`/dashboard/notes?tab=card&goalId=${goalId}&create=1`}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-gray-600 transition hover:bg-gray-50"
              >
                <BookOpen size={13} />学习日志
              </Link>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <p className="py-8 text-center text-xs text-gray-400">正在加载相关笔记…</p>
      ) : notes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 py-8 text-center">
          <p className="text-xs text-gray-400">这个目标还没有相关笔记</p>
        </div>
      ) : (
        <div className="space-y-5">
          {([
            { label: "学习笔记", icon: CalendarDays, tab: "log", items: studyNotes },
            { label: "学习日志", icon: BookOpen, tab: "card", items: studyLogs },
          ] as const).map((group) => (
            <section key={group.tab}>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-gray-500">
                <group.icon size={13} style={{ color: "var(--accent)" }} />
                {group.label}
                <span className="text-gray-300">{group.items.length}</span>
              </div>
              {group.items.length === 0 ? (
                <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-400">暂无内容</p>
              ) : (
                <div className="space-y-2">
                  {group.items.slice(0, 5).map((note) => (
                    <Link
                      key={note.id}
                      href={`/dashboard/notes?tab=${group.tab}&goalId=${goalId}`}
                      className="block rounded-xl border border-gray-100 bg-white px-3 py-2.5 transition hover:border-gray-200 hover:shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="line-clamp-2 text-xs leading-5 text-gray-700">
                          {note.title || stripHtml(note.content) || "无标题"}
                        </p>
                        <ExternalLink size={11} className="mt-1 flex-shrink-0 text-gray-300" />
                      </div>
                      <p className="mt-1 text-[10px] text-gray-400">{note.date}</p>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
