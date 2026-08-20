"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import TiptapEditor from "./TiptapEditor";
import type { KnowledgeNote } from "@/lib/knowledge-context";
import type { Task } from "@/lib/tasks-context";

interface TaskNoteDrawerProps {
  task: Task | null;
  onClose: () => void;
}

export default function TaskNoteDrawer({ task, onClose }: TaskNoteDrawerProps) {
  const notesHref = "/studio/work/notes";
  const [content, setContent] = useState("");
  const [noteId, setNoteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!task) return;
    setLoading(true);
    api.get<KnowledgeNote[]>(`/api/v1/knowledge/notes?task_id=${task.id}&note_type=task_note`)
      .then((notes) => {
        if (notes.length > 0) {
          setContent(notes[0].content);
          setNoteId(notes[0].id);
        } else {
          setContent("");
          setNoteId(null);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  const handleSave = async (html: string) => {
    if (!task) return;
    if (noteId) {
      await api.patch(`/api/v1/knowledge/notes/${noteId}`, { content: html }).catch(() => {});
    } else {
      const note = await api.post<KnowledgeNote>("/api/v1/knowledge/notes", {
        taskId: task.id,
        goalId: task.goalId ?? null,
        content: html,
        noteType: "task_note",
        title: `${task.title} — 笔记`,
      }).catch(() => null);
      if (note) setNoteId(note.id);
    }
  };

  if (!task) return null;

  return (
    <>
      {/* 遮罩 */}
      <div className="fixed inset-0 z-40 bg-black/10" onClick={onClose} />

      {/* 抽屉 */}
      <div role="dialog" aria-modal="true" aria-label="任务笔记" className="journal-dialog fixed right-0 top-0 bottom-0 z-50 w-[420px] bg-white shadow-2xl flex flex-col">
        {/* 头部 */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-400 mb-0.5">任务笔记</p>
            <p className="text-sm font-medium text-gray-800 truncate">{task.title}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
            <X size={16} />
          </button>
        </div>

        {/* 编辑区 */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-gray-400 text-sm">加载中…</div>
          ) : (
            <TiptapEditor
              key={task.id}
              content={content}
              onChange={setContent}
              onSave={handleSave}
              placeholder="记录任务相关的笔记、疑问、心得…"
              className="min-h-[200px]"
            />
          )}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-gray-100">
          <p className="text-xs text-gray-400">自动保存至笔记页面</p>
          <Link href={notesHref} className="text-xs font-medium" style={{ color: "var(--accent)" }}>打开笔记页面</Link>
        </div>
      </div>
    </>
  );
}
