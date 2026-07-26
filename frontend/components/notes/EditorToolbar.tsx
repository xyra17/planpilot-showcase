"use client";

import type { Editor } from "@tiptap/react";
import {
  Bold, Code2, Highlighter, Image as ImageIcon, Italic, List,
  ListChecks, ListOrdered, Quote, Redo2, Strikethrough, Underline,
  Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

interface EditorToolbarProps {
  editor: Editor;
  noteId?: string;
}

export default function EditorToolbar({ editor, noteId }: EditorToolbarProps) {
  const { showToast } = useToast();
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

  const btn = (
    active: boolean,
    onClick: () => void,
    icon: React.ReactNode,
    label: string
  ) => (
    <button
      key={label}
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
        active
          ? "bg-gray-200 text-gray-900"
          : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
      }`}
    >
      {icon}
    </button>
  );

  const divider = (key: string) => (
    <span key={key} className="w-px h-5 bg-gray-200 mx-1 self-center" />
  );

  return (
    <div className="editor-toolbar sticky top-0 z-10 flex items-center gap-0.5 overflow-x-auto overflow-y-hidden border-b border-gray-100 bg-white/95 px-3 py-2 backdrop-blur">
      {btn(false, () => editor.chain().focus().undo().run(), <Undo2 size={15} />, "撤销")}
      {btn(false, () => editor.chain().focus().redo().run(), <Redo2 size={15} />, "重做")}
      {divider("d1")}
      <select
        aria-label="文本样式"
        title="文本样式"
        value={
          editor.isActive("heading", { level: 1 }) ? "h1" :
          editor.isActive("heading", { level: 2 }) ? "h2" :
          editor.isActive("heading", { level: 3 }) ? "h3" : "paragraph"
        }
        onChange={(event) => {
          const value = event.target.value;
          if (value === "paragraph") editor.chain().focus().setParagraph().run();
          if (value === "h1") editor.chain().focus().toggleHeading({ level: 1 }).run();
          if (value === "h2") editor.chain().focus().toggleHeading({ level: 2 }).run();
          if (value === "h3") editor.chain().focus().toggleHeading({ level: 3 }).run();
        }}
        className="h-8 rounded-md border-0 bg-gray-50 px-2 text-xs font-medium text-gray-600 outline-none hover:bg-gray-100"
      >
        <option value="paragraph">正文</option>
        <option value="h1">标题 1</option>
        <option value="h2">标题 2</option>
        <option value="h3">标题 3</option>
      </select>
      {divider("d2")}
      {btn(editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), <Bold size={15} />, "粗体")}
      {btn(editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), <Italic size={15} />, "斜体")}
      {btn(editor.isActive("underline"), () => editor.chain().focus().toggleUnderline().run(), <Underline size={15} />, "下划线")}
      {btn(editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), <Strikethrough size={15} />, "删除线")}
      {btn(editor.isActive("highlight"), () => editor.chain().focus().toggleHighlight().run(), <Highlighter size={15} />, "高亮")}
      {btn(editor.isActive("code"), () => editor.chain().focus().toggleCode().run(), <Code2 size={15} />, "行内代码")}
      {divider("d3")}
      {btn(editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), <List size={15} />, "项目列表")}
      {btn(editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), <ListOrdered size={15} />, "编号列表")}
      {btn(editor.isActive("taskList"), () => editor.chain().focus().toggleTaskList().run(), <ListChecks size={15} />, "待办列表")}
      {btn(editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run(), <Quote size={15} />, "引用")}
      {divider("d4")}
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
              showToast("图片已插入", "success");
            } catch {
              showToast("图片上传失败，请重试", "error");
            }
          };
          input.click();
        }}
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
        title="插入图片"
      >
        <ImageIcon size={14} />
      </button>
      {imageSelected && (
        <>
          {divider("d5")}
          <span className="whitespace-nowrap px-1 text-[11px] text-gray-400">图片尺寸</span>
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
                  ? ""
                  : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
              }`}
              style={imageWidth === width ? { backgroundColor: "var(--accent-light)", color: "var(--accent)" } : undefined}
            >
              {label}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
