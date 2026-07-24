"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import TiptapEditor from "./TiptapEditor";
import type { KnowledgeNote } from "@/lib/knowledge-context";

interface GoalNotesPanelProps {
  goalId: string;
}

function NoteItem({ note, onDelete, onUpdate }: {
  note: KnowledgeNote;
  onDelete: (id: string) => void;
  onUpdate: (id: string, content: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(note.content);

  return (
    <div className="group bg-white border border-gray-100 rounded-xl overflow-hidden mb-3 hover:shadow-sm transition">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-xs text-gray-400">{note.date}</span>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
          <button onClick={() => setEditing((v) => !v)} className="text-xs px-2 py-0.5 rounded hover:bg-gray-100 text-gray-400">
            {editing ? "收起" : "编辑"}
          </button>
          <button onClick={() => onDelete(note.id)} className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500">
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      {editing ? (
        <TiptapEditor
          content={content}
          onChange={setContent}
          onSave={(html) => onUpdate(note.id, html)}
          showToolbar
          className="border-0 border-t border-gray-100 rounded-none"
        />
      ) : (
        <div
          className="px-4 pb-3 prose prose-sm max-w-none text-gray-700 cursor-pointer"
          dangerouslySetInnerHTML={{ __html: note.content }}
          onClick={() => setEditing(true)}
        />
      )}
    </div>
  );
}

export default function GoalNotesPanel({ goalId }: GoalNotesPanelProps) {
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const data = await api.get<KnowledgeNote[]>(
      `/api/v1/knowledge/notes?goal_id=${goalId}&note_type=flash_card`
    ).catch(() => []);
    setNotes(data);
  }, [goalId]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newContent || newContent === "<p></p>") return;
    setSaving(true);
    const note = await api.post<KnowledgeNote>("/api/v1/knowledge/notes", {
      goalId,
      content: newContent,
      noteType: "flash_card",
    }).catch(() => null);
    if (note) {
      setNotes((prev) => [note, ...prev]);
      setNewContent("");
      setShowNew(false);
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    await api.del(`/api/v1/knowledge/${id}`).catch(() => {});
  };

  const handleUpdate = async (id: string, content: string) => {
    setNotes((prev) => prev.map((n) => n.id === id ? { ...n, content } : n));
    await api.patch(`/api/v1/knowledge/notes/${id}`, { content }).catch(() => {});
  };

  return (
    <div className="px-4 py-4">
      {/* 新建区 */}
      {showNew ? (
        <div className="mb-4 border border-blue-100 rounded-xl overflow-hidden bg-blue-50/30">
          <TiptapEditor
            content={newContent}
            onChange={setNewContent}
            placeholder="记录学习心得、疑问、关键点…"
            showToolbar
          />
          <div className="flex justify-end gap-2 px-4 pb-3 pt-1">
            <button onClick={() => setShowNew(false)} className="text-xs px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100">
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={saving || !newContent || newContent === "<p></p>"}
              className="text-xs px-3 py-1.5 rounded-lg text-white disabled:opacity-40 transition"
              style={{ background: "var(--accent)" }}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowNew(true)}
          className="w-full mb-4 flex items-center justify-center gap-2 py-2.5 border border-dashed border-gray-200 rounded-xl text-sm text-gray-400 hover:border-blue-300 hover:text-blue-500 transition"
        >
          <Plus size={14} />新建笔记
        </button>
      )}

      {/* 笔记列表 */}
      {notes.length === 0 && !showNew ? (
        <p className="text-xs text-gray-400 text-center py-8">还没有笔记，点上方按钮开始记录</p>
      ) : (
        notes.map((note) => (
          <NoteItem key={note.id} note={note} onDelete={handleDelete} onUpdate={handleUpdate} />
        ))
      )}
    </div>
  );
}
