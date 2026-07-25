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
import { useEffect, useRef, useCallback } from "react";
import EditorToolbar from "./EditorToolbar";
import SlashMenu from "./SlashMenu";
import { useState } from "react";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const SERVE_RE = /\/api\/v1\/knowledge\/files\/([^"' >]+)\/serve/g;

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("access_token");
}

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

  // blob URL → original API path
  const blobToApi = useRef<Map<string, string>>(new Map());
  // API path → blob URL (cache per mount)
  const apiToBlob = useRef<Map<string, string>>(new Map());
  // prevent onChange loop when programmatically setting content
  const suppressUpdate = useRef(false);

  const resolveImages = useCallback(async (html: string): Promise<string> => {
    const token = getToken();
    if (!token || !SERVE_RE.test(html)) return html;
    SERVE_RE.lastIndex = 0;

    const matches = Array.from(html.matchAll(new RegExp(SERVE_RE.source, "g")));
    const unique = Array.from(new Set(matches.map((m) => m[0])));

    await Promise.all(
      unique.map(async (apiPath) => {
        if (apiToBlob.current.has(apiPath)) return;
        try {
          const res = await fetch(`${BASE_URL}${apiPath}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) return;
          const blob = await res.blob();
          const blobUrl = URL.createObjectURL(blob);
          blobToApi.current.set(blobUrl, apiPath);
          apiToBlob.current.set(apiPath, blobUrl);
        } catch {}
      })
    );

    return html.replace(new RegExp(SERVE_RE.source, "g"), (apiPath) =>
      apiToBlob.current.get(apiPath) ?? apiPath
    );
  }, []);

  const dehydrate = useCallback((html: string): string => {
    let out = html;
    blobToApi.current.forEach((apiPath, blobUrl) => {
      out = out.split(blobUrl).join(apiPath);
    });
    return out;
  }, []);

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
      if (suppressUpdate.current) return;
      const rawHtml = editor.getHTML();
      const html = dehydrate(rawHtml);
      onChange(html);
      if (onSave) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => onSave(html), 800);
      }
      // Resolve freshly-inserted API image paths to blob URLs immediately
      SERVE_RE.lastIndex = 0;
      if (SERVE_RE.test(rawHtml)) {
        SERVE_RE.lastIndex = 0;
        resolveImages(rawHtml).then((resolved) => {
          if (resolved === rawHtml) return;
          suppressUpdate.current = true;
          editor.commands.setContent(resolved);
          suppressUpdate.current = false;
        });
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
    if (!editor) return;
    const currentDehydrated = dehydrate(editor.getHTML());
    if (content === currentDehydrated) return;
    resolveImages(content).then((resolved) => {
      suppressUpdate.current = true;
      editor.commands.setContent(resolved);
      suppressUpdate.current = false;
    });
  }, [content, editor]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      blobToApi.current.forEach((_, blobUrl) => {
        URL.revokeObjectURL(blobUrl);
      });
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
