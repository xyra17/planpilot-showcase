"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Send, Square, Loader2, Zap, Bot, BookOpen, X, Bookmark, ExternalLink,
  ListTodo, CheckCircle2, BarChart3, Target, RefreshCw, Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/lib/stores/chatStore";
import { PlanCard } from "./PlanCard";
import { api, authFetch } from "@/lib/api";
import type { KnowledgeNote } from "@/lib/knowledge-context";
import TiptapEditor from "@/components/notes/TiptapEditor";
import { InlineNotice } from "@/components/ui/InlineNotice";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { clearPiloState, signalPiloAgentPhase } from "@/lib/technology/piloState";

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
  const notesHref = "/studio/work/notes";
  const [input, setInput] = useState("");
  const [checkinSaved, setCheckinSaved] = useState<{ goalId: string; rate: number } | null>(null);
  const [showNotePrompt, setShowNotePrompt] = useState(false);
  const [noteContent, setNoteContent] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaveResult, setNoteSaveResult] = useState<"saved" | "error" | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    messages, isStreaming, toolStatus, sessionId,
    addUserMessage, appendToken, setToolStatus,
    setStructuredOutput, setConfirmationRequired,
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
    const piloSource = "agent:chat-window";
    signalPiloAgentPhase("thinking", { source: piloSource });
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    abortRef.current = new AbortController();
    let hasStartedGenerating = false;
    let agentFinished = false;
    try {
      const res = await authFetch("/api/v1/agent/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: text, goal_id: goalId, session_id: sessionId }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        appendToken("\n[连接失败，请确认后端服务已启动]");
        signalPiloAgentPhase("failed", { source: piloSource, reason: "无法连接到 Agent 服务" });
        agentFinished = true;
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
              if (currentEvent === "token") {
                appendToken((payload.text as string) ?? "");
                if (!hasStartedGenerating) {
                  hasStartedGenerating = true;
                  signalPiloAgentPhase("generating", { source: piloSource });
                }
              }
              else if (currentEvent === "tool_start") {
                const tool = (payload.tool as string) ?? "工具";
                setToolStatus(TOOL_LABELS[tool] ?? "处理中...");
                signalPiloAgentPhase(tool === "web_search" || tool === "kb_search" ? "retrieving" : "tool", {
                  source: piloSource,
                  tool: TOOL_LABELS[tool]?.replace(/\.{3}$/, "") ?? tool,
                });
              }
              else if (currentEvent === "tool_end") {
                setToolStatus("");
                signalPiloAgentPhase("verifying", { source: piloSource });
              }
              else if (currentEvent === "structured") {
                setStructuredOutput(payload);
                signalPiloAgentPhase("verifying", { source: piloSource, reason: "正在检查结构化结果" });
              }
              else if (currentEvent === "confirmation_required") {
                setConfirmationRequired(payload);
                signalPiloAgentPhase("waiting", { source: piloSource });
              }
              else if (currentEvent === "checkin_saved") {
                const gid = (payload.goal_id as string) ?? goalId ?? "";
                const rate = (payload.completion_rate as number) ?? 1;
                setCheckinSaved({ goalId: gid, rate });
              }
              else if (currentEvent === "done") {
                setToolStatus("");
                signalPiloAgentPhase("done", { source: piloSource });
                agentFinished = true;
              }
              else if (currentEvent === "error") {
                const message = (payload.message as string) ?? "未知错误";
                appendToken(`\n[错误：${message}]`);
                signalPiloAgentPhase("failed", { source: piloSource, reason: message });
                agentFinished = true;
              }
            } catch { /* ignore malformed lines */ }
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        appendToken("\n[请求中断]");
        signalPiloAgentPhase("failed", { source: piloSource, reason: "Agent 请求意外中断" });
        agentFinished = true;
      } else {
        clearPiloState(piloSource, "agent");
      }
    } finally {
      if (!agentFinished) clearPiloState(piloSource, "agent");
      setStreaming(false);
      setToolStatus("");
    }
  }, [isStreaming, goalId, sessionId, addUserMessage, appendToken, setToolStatus, setStructuredOutput, setConfirmationRequired, setStreaming]);

  const persistNote = useCallback(async ({ content, title }: { content: string; title: string }) => {
    try {
      await api.post<KnowledgeNote>("/api/v1/knowledge/notes", {
        goalId: goalId ?? null,
        content,
        noteType: "flash_card",
        title,
      });
      return true;
    } catch {
      return false;
    }
  }, [goalId]);

  const saveAiNote = useCallback(async (text: string) => {
    setNoteSaveResult(null);
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const saved = await persistNote({
      content: `<p>${escaped.replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
      title: text.slice(0, 60) || "AI 助教笔记",
    });
    setNoteSaveResult(saved ? "saved" : "error");
  }, [persistNote]);

  const handleConfirm = async (confirmed: boolean) => {
    setConfirmationRequired(null);
    await api.post("/api/v1/agent/confirm", {
      confirmed,
      session_id: sessionId,
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
      <div className="goal-detail-scroll flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="ai-chat-empty flex h-full select-none flex-col items-center justify-center px-4 py-12 text-center">
            <div className="ai-chat-empty-icon mb-3 flex h-12 w-12 items-center justify-center rounded-2xl"
              style={{ backgroundColor: "var(--accent-light)" }}>
              <Zap size={22} style={{ color: "var(--accent)" }} />
            </div>
            <p className="text-sm font-semibold text-gray-700 mb-1">AI 助教</p>
            <p className="text-xs text-gray-400 mb-5">你的学习规划助手，随时可以开始</p>
            <div className="ai-chat-empty-divider mb-4 flex w-full max-w-xs items-center gap-2">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-[10px] text-gray-400 whitespace-nowrap">我能帮你做这些</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>
            <div className="ai-quick-grid grid w-full max-w-xs grid-cols-3 gap-2">
              {QUICK_ACTIONS.map((action) => {
                const ActionIcon = action.icon;
                return (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => sendMessage(action.text)}
                  disabled={isStreaming}
                  className="ai-quick-action flex flex-col items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-2 py-2.5 shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--accent-muted)] hover:bg-[var(--accent-light)] hover:shadow-md disabled:opacity-40"
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
              "ai-chat-message max-w-[85%] rounded-2xl px-4 py-3 text-sm group/msg",
              msg.role === "user"
                ? "is-user text-white rounded-br-sm"
                : "is-assistant text-gray-900 rounded-bl-sm"
            )} style={msg.role === "user" ? { backgroundColor: "var(--accent)" } : {}}>
              {msg.role === "assistant" && (
                <span className="ai-message-source"><Bot size={11} /> PlanPilot 助教</span>
              )}
              {msg.content && (
                <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              )}
              {msg.role === "assistant" && msg.content && (
                <div className="opacity-0 group-hover/msg:opacity-100 transition flex justify-end mt-1.5 -mb-0.5">
                  <button
                    onClick={() => saveAiNote(msg.content)}
                    className="ai-save-note text-[10px] text-gray-400 flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white/60 transition"
                  >
                    <Bookmark size={10} />
                    记笔记
                  </button>
                </div>
              )}
              {msg.structuredOutput && <PlanCard plan={msg.structuredOutput} />}
              {msg.confirmationRequired && (
                <InlineNotice
                  tone="warning"
                  className="ai-confirm-card mt-3"
                  title={(msg.confirmationRequired as { message?: string }).message ?? "需要您确认"}
                >
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
                </InlineNotice>
              )}
            </div>
          </div>
        ))}

        {toolStatus && (
          <div className="flex justify-start">
            <StatusBadge tone="progress" icon={<Loader2 size={11} className="animate-spin" />}>
              {toolStatus}
            </StatusBadge>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 打卡后笔记提示 */}
      {checkinSaved && !showNotePrompt && (
        <InlineNotice
          tone="info"
          icon={<BookOpen size={16} />}
          className="ai-success-card mx-4 mb-2 shrink-0"
          action={(
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowNotePrompt(true)}
                className="rounded-lg px-3 py-1.5 text-xs text-white transition"
                style={{ background: "var(--accent)" }}
              >写笔记</button>
              <button onClick={() => setCheckinSaved(null)} className="pp-icon-action rounded-lg p-1" aria-label="关闭打卡提示">
                <X size={13} />
              </button>
            </div>
          )}
        >
          打卡成功！要记录一下今天的学习收获吗？
        </InlineNotice>
      )}

      {/* 笔记编辑弹层 */}
      {showNotePrompt && (
        <div className="ai-note-prompt shrink-0 mx-4 mb-2 border border-accent-muted bg-accent-light/30 rounded-xl overflow-hidden">
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
            className="ai-note-editor border-0 border-t border-accent-muted rounded-none"
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
                const saved = await persistNote({
                  content: noteContent,
                  title: `打卡收获 ${new Date().toLocaleDateString("zh-CN")}`,
                });
                setNoteSaving(false);
                setNoteSaveResult(saved ? "saved" : "error");
                if (!saved) return;
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

      {noteSaveResult && (
        <div className={`ai-note-save-result ${noteSaveResult === "error" ? "is-error" : "is-saved"}`} role={noteSaveResult === "error" ? "alert" : "status"}>
          <span className="ai-note-save-result-icon"><BookOpen size={15} /></span>
          <div>
            <strong>{noteSaveResult === "saved" ? "已保存至笔记页面" : "笔记保存失败"}</strong>
            <small>{noteSaveResult === "saved" ? "可以继续编辑、下载或关联目标。" : "请检查网络连接后重试。"}</small>
          </div>
          {noteSaveResult === "saved" && (
            <Link href={notesHref}>打开笔记页面 <ExternalLink size={12} /></Link>
          )}
          <button type="button" aria-label="关闭笔记保存提示" onClick={() => setNoteSaveResult(null)}><X size={13} /></button>
        </div>
      )}

      <div className="shrink-0 border-t border-gray-100">
        {messages.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-2 justify-center">
            {QUICK_ACTIONS.slice(0, 3).map((action) => (
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
        )}
        <div className="ai-chat-composer flex gap-2 items-end px-4 pb-4 pt-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={1}
            disabled={isStreaming}
            className="ai-chat-input flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 disabled:opacity-50 transition"
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
              className="ai-chat-send-button shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-white disabled:opacity-40 transition"
              style={{ backgroundColor: "var(--accent)" }}>
              <Send size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
