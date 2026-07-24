"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import Underline from "@tiptap/extension-underline";
import Image from "@tiptap/extension-image";
import { Extension, InputRule } from "@tiptap/core";
import { useEffect, useRef, useState, useCallback } from "react";
import EditorToolbar from "./EditorToolbar";
import SlashMenu from "./SlashMenu";

// ==text== → 高亮
const HighlightInputRule = new InputRule({
  find: /==([^=]+)==\s$/,
  handler: ({ state, range, match }) => {
    const { from, to } = range;
    const text = match[1];
    state.tr
      .replaceWith(from, to, state.schema.text(text, [
        ...(state.schema.marks.highlight ? [state.schema.marks.highlight.create()] : []),
      ]))
      .removeStoredMark(state.schema.marks.highlight);
  },
});

// ~text~ → 下划线
const UnderlineInputRule = new InputRule({
  find: /~([^~]+)~\s$/,
  handler: ({ state, range, match }) => {
    const { from, to } = range;
    const text = match[1];
    state.tr
      .replaceWith(from, to, state.schema.text(text, [
        ...(state.schema.marks.underline ? [state.schema.marks.underline.create()] : []),
      ]))
      .removeStoredMark(state.schema.marks.underline);
  },
});

const MarkdownShortcuts = Extension.create({
  name: "markdownShortcuts",
  addInputRules() {
    return [HighlightInputRule, UnderlineInputRule];
  },
});

interface TiptapEditorProps {
  content: string;
  onChange: (html: string) => void;
  onSave?: (html: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  style?: React.CSSProperties;
  showToolbar?: boolean;
  goalId?: string;
  noteId?: string;
}

export default function TiptapEditor({
  content,
  onChange,
  onSave,
  placeholder = "写点什么… 输入 / 呼出 AI 写作指令",
  readOnly = false,
  className = "",
  style,
  showToolbar = true,
  goalId,
  noteId,
}: TiptapEditorProps) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [slashMenu, setSlashMenu] = useState<{ top: number; left: number } | null>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight,
      Underline,
      Image.configure({ inline: false }),
      MarkdownShortcuts,
    ],
    content,
    editable: !readOnly,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      onChange(html);
      if (onSave) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => onSave(html), 800);
      }
    },
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none min-h-[120px] px-4 py-3",
      },
      handleKeyDown(view, event) {
        if (event.key === "/" && !event.ctrlKey && !event.metaKey) {
          const { selection } = view.state;
          const $pos = selection.$from;
          const isStartOfBlock = $pos.parentOffset === 0;
          if (isStartOfBlock) {
            requestAnimationFrame(() => {
              const domPos = view.coordsAtPos(selection.from);
              const wrapRect = editorWrapRef.current?.getBoundingClientRect();
              if (!wrapRect) return;
              setSlashMenu({
                top: domPos.bottom + 4,
                left: Math.max(wrapRect.left, Math.min(domPos.left, window.innerWidth - 280)),
              });
            });
          }
        }
        return false;
      },
    },
  });

  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content);
    }
  }, [content]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const closeSlash = useCallback(() => setSlashMenu(null), []);

  return (
    <div
      ref={editorWrapRef}
      style={style}
      className={`flex flex-col border border-gray-200 rounded-lg overflow-hidden bg-white ${className}`}
    >
      {showToolbar && editor && <EditorToolbar editor={editor} noteId={noteId} />}
      <EditorContent editor={editor} className="flex-1" />
      {slashMenu && editor && (
        <SlashMenu
          editor={editor}
          goalId={goalId}
          position={slashMenu}
          onClose={closeSlash}
        />
      )}
    </div>
  );
}
