"use client";

import type { Editor } from "@tiptap/react";
import { Image as ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface EditorToolbarProps {
  editor: Editor;
  noteId?: string;
}

export default function EditorToolbar({ editor, noteId }: EditorToolbarProps) {
  const [imageSelected, setImageSelected] = useState(editor.isActive("image"));
  const [imageWidth, setImageWidth] = useState(
    Number(editor.getAttributes("image").width) || 100
  );

  useEffect(() => {
    const syncImageState = () => {
      setImageSelected(editor.isActive("image"));
      setImageWidth(Number(editor.getAttributes("image").width) || 100);
    };
    editor.on("selectionUpdate", syncImageState);
    editor.on("transaction", syncImageState);
    return () => {
      editor.off("selectionUpdate", syncImageState);
      editor.off("transaction", syncImageState);
    };
  }, [editor]);

  const btn = (active: boolean, onClick: () => void, label: string) => (
    <button
      key={label}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className={`px-2 py-1 rounded text-sm font-medium transition-colors ${
        active
          ? "bg-gray-200 text-gray-900"
          : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
      }`}
    >
      {label}
    </button>
  );

  const divider = (key: string) => (
    <span key={key} className="w-px h-5 bg-gray-200 mx-1 self-center" />
  );

  return (
    <div className="flex items-center gap-0.5 px-3 py-2 border-b border-gray-100 flex-wrap">
      {btn(!editor.isActive("heading"), () => editor.chain().focus().setParagraph().run(), "正文")}
      {btn(editor.isActive("heading", { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), "H1")}
      {btn(editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), "H2")}
      {btn(editor.isActive("heading", { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), "H3")}
      {divider("d1")}
      {btn(editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "B")}
      {btn(editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "I")}
      {btn(editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), "S")}
      {btn(editor.isActive("highlight"), () => editor.chain().focus().toggleHighlight().run(), "高亮")}
      {btn(editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), "U")}
      {divider("d2")}
      {btn(editor.isActive("code"), () => editor.chain().focus().toggleCode().run(), "<>")}
      {divider("d3")}
      {btn(editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), "•")}
      {btn(editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), "1.")}
      {btn(editor.isActive("taskList"), () => editor.chain().focus().toggleTaskList().run(), "☑")}
      {divider("d4")}
      {btn(editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run(), "引用")}
      {btn(false, () => editor.chain().focus().setHorizontalRule().run(), "—")}
      {divider("d5")}
      <button
        key="image"
        onMouseDown={(e) => {
          e.preventDefault();
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.onchange = async (evt) => {
            const file = (evt.target as HTMLInputElement).files?.[0];
            if (!file) return;
            const fd = new FormData();
            fd.append("file", file);
            if (noteId) fd.append("note_id", noteId);
            try {
              const res = await api.upload<{ id: string }>("/api/v1/knowledge/upload", fd);
              editor.chain().focus().setImage({ src: `/api/v1/knowledge/files/${res.id}/serve` }).run();
            } catch {}
          };
          input.click();
        }}
        className="px-2 py-1 rounded text-sm font-medium transition-colors text-gray-500 hover:bg-gray-100 hover:text-gray-900"
        title="插入图片"
      >
        <ImageIcon size={14} />
      </button>
      {imageSelected && (
        <>
          {divider("image-size")}
          <span className="px-1 text-[11px] text-gray-400">图片</span>
          {[
            ["小", 35],
            ["中", 60],
            ["大", 85],
            ["原宽", 100],
          ].map(([label, width]) => (
            <button
              key={label}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                editor.chain().focus().updateAttributes("image", { width }).run();
              }}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                imageWidth === width
                  ? "bg-blue-50 text-blue-600"
                  : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              {label}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
