"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarDays, ExternalLink, Plus } from "lucide-react";
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
  const notesHref = "/studio/work/notes";
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api.get<KnowledgeNote[]>(
      `/api/v1/knowledge/notes?goal_id=${goalId}`
    ).catch(() => []);
    setNotes(data.filter((note) => note.noteType === "daily_log"));
    setLoading(false);
  }, [goalId]);

  useEffect(() => { void load(); }, [load]);

  const byRecordDateDesc = (a: KnowledgeNote, b: KnowledgeNote) => {
    const aDate = Date.parse(`${a.date || "1970-01-01"}T00:00:00`) || Date.parse(a.updatedAt || a.createdAt);
    const bDate = Date.parse(`${b.date || "1970-01-01"}T00:00:00`) || Date.parse(b.updatedAt || b.createdAt);
    if (aDate !== bDate) return bDate - aDate;
    return Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt);
  };
  const studyNotes = [...notes].sort(byRecordDateDesc);

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-3 text-xs text-gray-500">
          <span className="inline-flex items-center gap-1">
            <CalendarDays size={12} style={{ color: "var(--accent)" }} />
            笔记 {studyNotes.length}
          </span>
        </div>
        <Link
          href={`${notesHref}?goalId=${goalId}&create=1`}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
          style={{ backgroundColor: "var(--accent)" }}
        >
          <Plus size={12} />新建笔记
        </Link>
      </div>

      {loading ? (
        <p className="py-8 text-center text-xs text-gray-400">正在加载相关笔记…</p>
      ) : notes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 py-8 text-center">
          <p className="text-xs text-gray-400">这个目标还没有相关笔记</p>
        </div>
      ) : (
        <section>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-gray-500">
            <CalendarDays size={13} style={{ color: "var(--accent)" }} />
            学习笔记
            <span className="text-gray-300">{studyNotes.length}</span>
          </div>
          <div className="space-y-2" aria-label="学习笔记，按记录日期从新到旧排列">
                  {studyNotes.map((note) => (
                    <Link
                      key={note.id}
                      href={`${notesHref}?goalId=${goalId}`}
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
        </section>
      )}
    </div>
  );
}
