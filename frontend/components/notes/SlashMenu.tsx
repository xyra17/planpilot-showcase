"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import type { Editor } from "@tiptap/react";

const COMMANDS = [
  { id: "summarize", icon: "📝", label: "总结要点",   desc: "AI 生成核心要点列表" },
  { id: "quiz",      icon: "🎯", label: "生成考题",   desc: "出 3 道思考题+参考答案" },
  { id: "expand",    icon: "✨", label: "展开说明",   desc: "对选中内容补充细节" },
  { id: "checklist", icon: "☑️", label: "整理清单",   desc: "转换成可操作任务清单" },
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
      className="fixed z-50 w-64 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden"
      style={{ top: position.top, left: position.left }}
    >
      <div className="px-3 py-2 border-b border-gray-100">
        <p className="text-xs text-gray-400 font-medium">AI 写作指令</p>
      </div>
      {COMMANDS.map((cmd, i) => (
        <button
          key={cmd.id}
          disabled={!!loading}
          onMouseDown={(e) => { e.preventDefault(); execute(cmd.id); }}
          onMouseEnter={() => setActiveIdx(i)}
          className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition ${
            i === activeIdx ? "bg-blue-50" : "hover:bg-gray-50"
          } disabled:opacity-40`}
        >
          <span className="text-lg w-6 flex-shrink-0">{loading === cmd.id ? "⏳" : cmd.icon}</span>
          <div>
            <p className="text-sm font-medium text-gray-700">{cmd.label}</p>
            <p className="text-xs text-gray-400">{cmd.desc}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
