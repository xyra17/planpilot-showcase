"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import type { Editor } from "@tiptap/react";
import {
  AlignLeft, CircleHelp, Expand, Heading1, Heading2, List,
  ListChecks, LoaderCircle, Minus, Quote, Sparkles,
} from "lucide-react";

const COMMANDS = [
  { id: "heading1", kind: "block", icon: Heading1, label: "一级标题", desc: "大标题" },
  { id: "heading2", kind: "block", icon: Heading2, label: "二级标题", desc: "章节标题" },
  { id: "bullet", kind: "block", icon: List, label: "项目列表", desc: "创建无序列表" },
  { id: "todo", kind: "block", icon: ListChecks, label: "待办列表", desc: "创建可勾选事项" },
  { id: "quote", kind: "block", icon: Quote, label: "引用", desc: "突出引用内容" },
  { id: "divider", kind: "block", icon: Minus, label: "分割线", desc: "分隔内容区块" },
  { id: "summarize", kind: "ai", icon: AlignLeft, label: "AI 总结要点", desc: "生成核心要点列表" },
  { id: "quiz", kind: "ai", icon: CircleHelp, label: "AI 生成考题", desc: "生成思考题和参考答案" },
  { id: "expand", kind: "ai", icon: Expand, label: "AI 展开说明", desc: "补充选中内容的细节" },
  { id: "checklist", kind: "ai", icon: Sparkles, label: "AI 整理清单", desc: "转换成可操作任务清单" },
] as const;

interface SlashMenuProps {
  editor: Editor;
  goalId?: string;
  position: { top: number; left: number };
  onClose: () => void;
}

export default function SlashMenu({ editor, goalId, position, onClose }: SlashMenuProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => (i + 1) % COMMANDS.length); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIdx((i) => (i - 1 + COMMANDS.length) % COMMANDS.length); return; }
      if (e.key === "Enter")     { e.preventDefault(); execute(COMMANDS[activeIdx].id); return; }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeIdx]);

  const execute = async (command: string) => {
    if (loading) return;
    // 删掉触发的 "/" 字符
    editor.chain().focus().deleteRange({
      from: editor.state.selection.from - 1,
      to: editor.state.selection.from,
    }).run();

    if (command === "heading1") {
      editor.chain().focus().toggleHeading({ level: 1 }).run();
      onClose();
      return;
    }
    if (command === "heading2") {
      editor.chain().focus().toggleHeading({ level: 2 }).run();
      onClose();
      return;
    }
    if (command === "bullet") {
      editor.chain().focus().toggleBulletList().run();
      onClose();
      return;
    }
    if (command === "todo") {
      editor.chain().focus().toggleTaskList().run();
      onClose();
      return;
    }
    if (command === "quote") {
      editor.chain().focus().toggleBlockquote().run();
      onClose();
      return;
    }
    if (command === "divider") {
      editor.chain().focus().setHorizontalRule().run();
      onClose();
      return;
    }

    // 插入占位符
    const placeholder = `\n生成中…\n`;
    editor.chain().focus().insertContent(placeholder).run();
    const insertedFrom = editor.state.selection.from - placeholder.length;

    setLoading(command);
    onClose();

    try {
      const { content } = await api.post<{ content: string }>("/api/v1/agent/note-assist", {
        command,
        context: editor.state.selection.empty ? "" : editor.state.doc.textBetween(
          editor.state.selection.from, editor.state.selection.to
        ),
        goal_id: goalId ?? null,
      });

      // 替换占位符为实际内容
      const tr = editor.state.tr;
      tr.replaceWith(
        insertedFrom,
        insertedFrom + placeholder.length,
        editor.schema.text("\n" + content + "\n"),
      );
      editor.view.dispatch(tr);
    } catch {
      const tr = editor.state.tr;
      tr.replaceWith(insertedFrom, insertedFrom + placeholder.length, editor.schema.text(""));
      editor.view.dispatch(tr);
    }
  };

  return (
    <div
      ref={ref}
      className="slash-menu fixed z-50 w-64 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden"
      style={{ top: position.top, left: position.left }}
    >
      <div className="px-3 py-2 border-b border-gray-100">
        <p className="text-xs text-gray-400 font-medium">插入区块或使用 AI</p>
      </div>
      {COMMANDS.map((cmd, i) => {
        const CommandIcon = cmd.icon;
        return (
        <button
          key={cmd.id}
          disabled={!!loading}
          onMouseDown={(e) => { e.preventDefault(); execute(cmd.id); }}
          onMouseEnter={() => setActiveIdx(i)}
          className={`slash-menu-item w-full flex items-center gap-3 px-3 py-2.5 text-left transition ${
            i === activeIdx ? "bg-blue-50" : "hover:bg-gray-50"
          } disabled:opacity-40`}
        >
          <span className="slash-menu-icon flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-gray-500">
            {loading === cmd.id ? <LoaderCircle size={14} className="animate-spin" /> : <CommandIcon size={14} />}
          </span>
          <div>
            <p className="text-sm font-medium text-gray-700">{cmd.label}</p>
            <p className="text-xs text-gray-400">{cmd.desc}</p>
          </div>
        </button>
        );
      })}
    </div>
  );
}
