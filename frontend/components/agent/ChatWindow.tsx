"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Send, Square, Loader2, Zap, BookOpen, X, Bookmark,
  ListTodo, CheckCircle2, BarChart3, Target, RefreshCw, Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore, type ReplanOptions } from "@/lib/stores/chatStore";
import { PlanCard } from "./PlanCard";
import { ReplanOptionsCard } from "./ReplanOptionsCard";
import { api } from "@/lib/api";
import type { KnowledgeNote } from "@/lib/knowledge-context";
import TiptapEditor from "@/components/notes/TiptapEditor";

const TOOL_LABELS: Record<string, string> = {
  web_search:    "正在搜索资料...",
  kb_search:     "正在检索知识库...",
  plan_generate: "正在生成计划...",
};

const QUICK_ACTIONS = [
  { label: "今天学什么",   text: "今天我应该学什么？",                    icon: ListTodo },
  { label: "今日打卡",     text: "我要今日打卡",                          icon: CheckCircle2 },
  { label: "分析进度",     text: "帮我分析一下我的学习进度",              icon: BarChart3 },
  { label: "出题考我",     text: "验收一下我的掌握情况，出题考我",        icon: Target },
  { label: "帮我重规划",   text: "我跟不上了，帮我重规划一下",            icon: RefreshCw },
  { label: "搜索学习资料", text: "帮我搜索相关学习资料",                  icon: Search },
] as const;

export function ChatWindow({ goalId, className }: { goalId?: string; className?: string }) {
  const [input, setInput] = useState("");
  const [checkinSaved, setCheckinSaved] = useState<{ goalId: string; rate: number } | null>(null);
  const [showNotePrompt, setShowNotePrompt] = useState(false);
  const [noteContent, setNoteContent] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    messages, isStreaming, toolStatus, sessionId,
    addUserMessage, appendToken, setToolStatus,
    setStructuredOutput, setConfirmationRequired, setReplanOptions,
    setStreaming, clearMessages, resetSession,
  } = useChatStore();

  useEffect(() => {
    clearMessages();
    resetSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, toolStatus]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isStreaming) return;
    addUserMessage(text);
    setInput("");
    setStreaming(true);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    abortRef.current = new AbortController();
    try {
      const token = localStorage.getItem("access_token");
      const res = await fetch("/api/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message: text, goal_id: goalId, session_id: sessionId }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        appendToken("\n[连接失败，请确认后端服务已启动]");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            const raw = line.slice(5).trim();
            if (!raw || raw === "{}") continue;
            try {
              const payload = JSON.parse(raw) as Record<string, unknown>;
              if (currentEvent === "token") appendToken((payload.text as string) ?? "");
              else if (currentEvent === "tool_start") setToolStatus(TOOL_LABELS[(payload.tool as string)] ?? "处理中...");
              else if (currentEvent === "tool_end") setToolStatus("");
              else if (currentEvent === "structured") setStructuredOutput(payload);
              else if (currentEvent === "confirmation_required") setConfirmationRequired(payload);
              else if (currentEvent === "replan_options") setReplanOptions(payload as unknown as ReplanOptions);
              else if (currentEvent === "checkin_saved") {
                const gid = (payload.goal_id as string) ?? goalId ?? "";
                const rate = (payload.completion_rate as number) ?? 1;
                setCheckinSaved({ goalId: gid, rate });
              }
              else if (currentEvent === "done") setToolStatus("");
              else if (currentEvent === "error") appendToken(`\n[错误：${(payload.message as string) ?? "未知错误"}]`);
            } catch { /* ignore malformed lines */ }
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        appendToken("\n[请求中断]");
      }
    } finally {
      setStreaming(false);
      setToolStatus("");
    }
  }, [isStreaming, goalId, sessionId, addUserMessage, appendToken, setToolStatus, setStructuredOutput, setConfirmationRequired, setReplanOptions, setStreaming]);

  const saveAiNote = useCallback(async (text: string) => {
    await api.post("/api/v1/knowledge/notes", {
      goalId: goalId ?? null,
      content: `<p>${text.replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
      noteType: "flash_card",
      title: text.slice(0, 60),
    }).catch(() => null);
  }, [goalId]);

  const handleConfirm = async (confirmed: boolean) => {
    setConfirmationRequired(null);
    await fetch("/api/agent/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed, session_id: sessionId }),
    }).catch(() => null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
  };

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center py-12 select-none px-4">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3"
              style={{ backgroundColor: "var(--accent-light)" }}>
              <Zap size={22} style={{ color: "var(--accent)" }} />
            </div>
            <p className="text-sm font-semibold text-gray-700 mb-1">AI 助教</p>
            <p className="text-xs text-gray-400 mb-5">你的学习规划助手，随时可以开始</p>
            <div className="flex items-center gap-2 w-full max-w-xs mb-4">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-[10px] text-gray-400 whitespace-nowrap">我能帮你做这些</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>
            <div className="grid grid-cols-3 gap-2 w-full max-w-xs">
              {QUICK_ACTIONS.map((action) => {
                const ActionIcon = action.icon;
                return (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => sendMessage(action.text)}
                  disabled={isStreaming}
                  className="ai-quick-action flex flex-col items-center gap-1.5 rounded-xl border border-gray-100 bg-gray-50 px-2 py-2.5 transition hover:-translate-y-0.5 hover:border-gray-200 disabled:opacity-40"
                >
                  <span className="ai-quick-icon flex h-6 w-6 items-center justify-center rounded-lg" style={{ backgroundColor: "var(--accent-light)", color: "var(--accent)" }}>
                    <ActionIcon size={15} strokeWidth={1.8} />
                  </span>
                  <span className="text-[10px] text-gray-500 leading-tight text-center">{action.label}</span>
                </button>
                );
              })}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn(
              "max-w-[85%] rounded-2xl px-4 py-3 text-sm group/msg",
              msg.role === "user"
                ? "text-white rounded-br-sm"
                : "bg-gray-100 text-gray-900 rounded-bl-sm"
            )} style={msg.role === "user" ? { backgroundColor: "var(--accent)" } : {}}>
              {msg.content && (
                <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              )}
              {msg.role === "assistant" && msg.content && (
                <div className="opacity-0 group-hover/msg:opacity-100 transition flex justify-end mt-1.5 -mb-0.5">
                  <button
                    onClick={() => saveAiNote(msg.content)}
                    className="text-[10px] text-gray-400 hover:text-blue-500 flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white/60 transition"
                  >
                    <Bookmark size={10} />
                    记笔记
                  </button>
                </div>
              )}
              {msg.structuredOutput && <PlanCard plan={msg.structuredOutput} />}
              {msg.confirmationRequired && (
                <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                  <p className="text-xs font-medium text-amber-800 mb-2">
                    {(msg.confirmationRequired as { message?: string }).message ?? "需要您确认"}
                  </p>
                  <div className="flex gap-2">
                    <button onClick={() => handleConfirm(true)}
                      className="px-3 py-1.5 text-white text-xs rounded-lg transition"
                      style={{ backgroundColor: "var(--accent)" }}>
                      确认执行
                    </button>
                    <button onClick={() => handleConfirm(false)}
                      className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 text-xs rounded-lg hover:bg-gray-50 transition">
                      暂不调整
                    </button>
                  </div>
                </div>
              )}
              {msg.replanOptions && (
                <ReplanOptionsCard options={msg.replanOptions} />
              )}
            </div>
          </div>
        ))}

        {toolStatus && (
          <div className="flex justify-start">
            <div className="bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 text-xs text-gray-500 flex items-center gap-2">
              <Loader2 size={11} className="animate-spin" style={{ color: "var(--accent)" }} />
              {toolStatus}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 打卡后笔记提示 */}
      {checkinSaved && !showNotePrompt && (
        <div className="shrink-0 mx-4 mb-2 flex items-center gap-3 bg-green-50 border border-green-100 rounded-xl px-4 py-3">
          <BookOpen size={16} className="text-green-500 flex-shrink-0" />
          <p className="text-sm text-green-700 flex-1">
            打卡成功！要记录一下今天的学习收获吗？
          </p>
          <button
            onClick={() => setShowNotePrompt(true)}
            className="text-xs px-3 py-1.5 rounded-lg text-white transition flex-shrink-0"
            style={{ background: "var(--accent)" }}
          >
            写笔记
          </button>
          <button onClick={() => setCheckinSaved(null)} className="p-1 rounded text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X size={13} />
          </button>
        </div>
      )}

      {/* 笔记编辑弹层 */}
      {showNotePrompt && (
        <div className="shrink-0 mx-4 mb-2 border border-blue-100 bg-blue-50/30 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 pt-3 pb-1">
            <span className="text-xs font-medium text-gray-500">记录今日收获</span>
            <button onClick={() => { setShowNotePrompt(false); setCheckinSaved(null); }}
              className="p-1 rounded hover:bg-gray-100 text-gray-400"><X size={13} /></button>
          </div>
          <TiptapEditor
            content={noteContent}
            onChange={setNoteContent}
            placeholder="今天学了什么？有什么收获或疑问？"
            showToolbar={false}
            className="border-0 border-t border-blue-100 rounded-none"
          />
          <div className="flex justify-end gap-2 px-4 pb-3 pt-1">
            <button onClick={() => { setShowNotePrompt(false); setCheckinSaved(null); }}
              className="text-xs px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100">
              跳过
            </button>
            <button
              disabled={noteSaving || !noteContent || noteContent === "<p></p>"}
              onClick={async () => {
                if (!noteContent || noteContent === "<p></p>") return;
                setNoteSaving(true);
                await api.post<KnowledgeNote>("/api/v1/knowledge/notes", {
                  goalId: checkinSaved?.goalId ?? goalId ?? null,
                  content: noteContent,
                  noteType: "flash_card",
                  title: `打卡收获 ${new Date().toLocaleDateString("zh-CN")}`,
                }).catch(() => null);
                setNoteSaving(false);
                setShowNotePrompt(false);
                setCheckinSaved(null);
                setNoteContent("");
              }}
              className="text-xs px-3 py-1.5 rounded-lg text-white disabled:opacity-40 transition"
              style={{ background: "var(--accent)" }}
            >
              {noteSaving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-gray-100">
        <div className="flex flex-wrap gap-1.5 px-4 pt-2 justify-center">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              onClick={() => sendMessage(action.text)}
              disabled={isStreaming}
              className="shrink-0 px-3 py-1 text-xs rounded-full border border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700 hover:bg-gray-50 transition disabled:opacity-40 whitespace-nowrap"
            >
              {action.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-end px-4 pb-4 pt-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={1}
            disabled={isStreaming}
            className="flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:opacity-50 transition"
            style={{ maxHeight: 128, overflowY: "auto" }}
          />
          {isStreaming ? (
            <button onClick={() => abortRef.current?.abort()}
              className="shrink-0 w-9 h-9 rounded-xl border border-gray-200 flex items-center justify-center text-gray-400 hover:bg-gray-50 transition">
              <Square size={13} />
            </button>
          ) : (
            <button onClick={() => sendMessage(input)}
              disabled={!input.trim()}
              className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-white disabled:opacity-40 transition"
              style={{ backgroundColor: "var(--accent)" }}>
              <Send size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
