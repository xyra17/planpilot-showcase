"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import TiptapEditor from "./TiptapEditor";
import type { KnowledgeNote } from "@/lib/knowledge-context";

const CARD_STEPS = [
  {
    bg: "color-mix(in srgb, var(--accent) 6%, white)",
    border: "color-mix(in srgb, var(--accent) 9%, white)",
  },
  {
    bg: "color-mix(in srgb, var(--accent) 9%, white)",
    border: "color-mix(in srgb, var(--accent) 15%, white)",
  },
  {
    bg: "color-mix(in srgb, var(--accent) 12%, white)",
    border: "color-mix(in srgb, var(--accent) 18%, white)",
  },
];

function getCardStep(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return CARD_STEPS[Math.abs(h) % CARD_STEPS.length];
}

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function CardItem({ note, onDelete, onUpdate }: {
  note: KnowledgeNote;
  onDelete: (id: string) => void;
  onUpdate: (id: string, content: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(note.content);
  const step = getCardStep(note.id);

  const save = (html: string) => onUpdate(note.id, html);

  return (
    <div
      className="break-inside-avoid mb-3 rounded-2xl overflow-hidden transition-all duration-200 group"
      style={{
        backgroundColor: step.bg,
        border: `1px solid ${step.border}`,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04)",
      }}
    >
      {(note.title || true) && (
        <div className="flex items-center justify-between px-4 pt-3 pb-1 min-h-[36px]">
          {note.title ? (
            <p className="text-sm font-semibold text-gray-800 flex-1 truncate leading-tight">
              {note.title}
            </p>
          ) : (
            <div className="flex-1" />
          )}
          <div className="flex gap-1 ml-2 flex-shrink-0">
            <button
              onClick={() => setEditing((v) => !v)}
              className="px-2 py-0.5 rounded-lg text-xs font-medium transition"
              style={{ color: "var(--accent-dark)", background: "var(--accent-light)" }}
            >
              {editing ? "收起" : "编辑"}
            </button>
            <button
              onClick={() => onDelete(note.id)}
              className="px-2 py-0.5 rounded-lg text-xs font-medium transition text-gray-400 hover:text-red-500 bg-gray-100 hover:bg-red-50"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      )}

      {editing ? (
        <TiptapEditor
          content={content}
          onChange={setContent}
          onSave={save}
          showToolbar
          className="border-0 rounded-none"
          style={{ background: "transparent" }}
        />
      ) : (
        <div
          className="px-4 pb-3 prose prose-sm max-w-none cursor-pointer text-[12px] leading-relaxed text-gray-500"
          dangerouslySetInnerHTML={{ __html: note.content }}
          onClick={() => setEditing(true)}
        />
      )}

      <div className="px-4 pb-3 pt-1 flex items-center justify-between">
        <span className="text-[11px]" style={{ color: "var(--accent)", opacity: 0.6 }}>{note.date}</span>
        {note.goalTitle && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full"
            style={{ background: "var(--accent-light)", color: "var(--accent-dark)" }}
          >
            {note.goalTitle}
          </span>
        )}
      </div>
    </div>
  );
}

function QuickNewCard({ onAdd, onClose }: { onAdd: (content: string, title: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 mb-6 sm:mb-0 overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <span className="text-sm font-medium text-gray-700">新建备忘录</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400"><X size={14} /></button>
        </div>
        <div className="px-4 pt-3 pb-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="标题（可选）"
            className="w-full text-base font-semibold text-gray-800 placeholder-gray-300 bg-transparent border-0 focus:outline-none focus:ring-0 border-b border-gray-100 pb-1.5"
          />
        </div>
        <TiptapEditor
          content=""
          onChange={setContent}
          placeholder="记录一个想法…"
          showToolbar={false}
          className="border-0 border-t border-gray-100"
        />
        <div className="flex justify-end gap-2 px-4 pb-4 pt-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-50 rounded-lg">取消</button>
          <button
            disabled={!content || content === "<p></p>"}
            onClick={() => { onAdd(content, title.trim()); onClose(); }}
            className="px-4 py-1.5 text-sm text-white rounded-lg transition disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FlashCardsWall() {
  const [cards, setCards] = useState<KnowledgeNote[]>([]);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    const notes = await api.get<KnowledgeNote[]>("/api/v1/knowledge/notes?note_type=flash_card").catch(() => []);
    setCards(notes);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (content: string, title: string) => {
    const note = await api.post<KnowledgeNote>("/api/v1/knowledge/notes", {
      content,
      noteType: "flash_card",
      title: title || undefined,
    }).catch(() => null);
    if (note) setCards((prev) => [note, ...prev]);
  };

  const handleDelete = async (id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
    await api.del(`/api/v1/knowledge/${id}`).catch(() => {});
  };

  const handleUpdate = async (id: string, content: string) => {
    setCards((prev) => prev.map((c) => c.id === id ? { ...c, content } : c));
    await api.patch(`/api/v1/knowledge/notes/${id}`, { content }).catch(() => {});
  };

  return (
    <div className="relative">
      {cards.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <p className="text-sm">还没有备忘录，点右下角按钮开始记录</p>
        </div>
      ) : (
        <div className="columns-1 sm:columns-2 lg:columns-3 gap-4">
          {cards.map((card) => (
            <CardItem key={card.id} note={card} onDelete={handleDelete} onUpdate={handleUpdate} />
          ))}
        </div>
      )}

      <button
        onClick={() => setShowNew(true)}
        className="fixed bottom-8 right-8 w-12 h-12 rounded-full shadow-lg text-white flex items-center justify-center transition hover:opacity-90"
        style={{ background: "var(--accent)" }}
      >
        <Plus size={22} />
      </button>

      {showNew && <QuickNewCard onAdd={handleAdd} onClose={() => setShowNew(false)} />}
    </div>
  );
}
