"use client";
import { useEffect, useRef, useState } from "react";
import { X, CheckCircle2, Loader2, Eye, EyeOff, BookOpen, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useKnowledge } from "@/lib/knowledge-context";

interface VerificationDialogProps {
  goalId: string;
  taskId: string;
  taskTitle: string;
  onClose: () => void;
  onPassed?: () => void;
}

interface Message {
  role: "ai" | "user";
  content: string;
  score?: number;
  suggestion?: string;
}

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 90 ? "bg-green-100 text-green-700" :
    score >= 70 ? "bg-blue-100 text-blue-700" :
    score >= 60 ? "bg-yellow-100 text-yellow-700" :
    "bg-red-100 text-red-700";
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ml-2", color)}>
      {score}分
    </span>
  );
}

export function VerificationDialog({ goalId, taskId, taskTitle, onClose, onPassed }: VerificationDialogProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [answerHint, setAnswerHint] = useState("");
  const [showHint, setShowHint] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [passed, setPassed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [includeAnswer, setIncludeAnswer] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { addNote } = useKnowledge();

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      try {
        const res = await api.post<{ question: string; answer_hint: string }>(`/api/v1/agent/verify`, {
          goal_id: goalId,
          task_id: taskId,
        });
        setMessages([{ role: "ai", content: res.question }]);
        setAnswerHint(res.answer_hint ?? "");
      } catch {
        setMessages([{ role: "ai", content: `你刚完成了「${taskTitle}」，用自己的话说说，这个任务的核心要点是什么？` }]);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [goalId, taskId, taskTitle]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendAnswer = async () => {
    if (!input.trim() || isLoading) return;
    const answer = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", content: answer }]);
    setIsLoading(true);

    try {
      const res = await api.post<{
        feedback: string;
        passed: boolean;
        score: number;
        suggestion?: string;
        follow_up?: string;
      }>(`/api/v1/agent/verify/answer`, { goal_id: goalId, task_id: taskId, answer });

      setMessages((m) => [...m, {
        role: "ai",
        content: res.feedback,
        score: res.score,
        suggestion: res.suggestion,
      }]);

      if (res.passed) {
        setPassed(true);
        onPassed?.();
      } else if (res.follow_up) {
        setMessages((m) => [...m, { role: "ai", content: res.follow_up! }]);
      }
    } catch {
      setMessages((m) => [...m, { role: "ai", content: "评估暂时不可用，请稍后重试。" }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveNote = async () => {
    const question = messages[0]?.content ?? taskTitle;
    const userAnswers = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    const evalMsg = messages.find((m) => m.role === "ai" && m.score !== undefined);
    const score = evalMsg?.score;
    const lines = [
      `【验收任务】${taskTitle}`,
      score !== undefined ? `【得分】${score}` : null,
      `【考查问题】${question}`,
      includeAnswer && userAnswers ? `【我的回答】${userAnswers}` : null,
      answerHint ? `【参考答案要点】\n${answerHint}` : null,
    ].filter(Boolean).join("\n");
    await addNote({ goalId, content: lines, noteType: "chat_note" });
    setSaved(true);
  };

  const hasAnswer = messages.some((m) => m.role === "user");

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-label="学习验收" className="journal-dialog w-full max-w-md bg-white rounded-2xl shadow-2xl flex flex-col max-h-[85vh]">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <p className="text-sm font-semibold text-gray-800">学习验收</p>
            <p className="text-xs text-gray-400 truncate max-w-64">{taskTitle}</p>
          </div>
          <button onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-gray-400 hover:bg-gray-100 transition">
            <X size={16} />
          </button>
        </div>

        {/* 对话区 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
          {messages.map((msg, i) => (
            <div key={i} className="space-y-1.5">
              <div className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn(
                  "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                  msg.role === "user"
                    ? "text-white rounded-br-sm"
                    : "bg-gray-100 text-gray-800 rounded-bl-sm"
                )} style={msg.role === "user" ? { backgroundColor: "var(--accent)" } : {}}>
                  <span>{msg.content}</span>
                  {msg.score !== undefined && <ScoreBadge score={msg.score} />}
                </div>
              </div>

              {/* 答案提示 — 仅第一条AI消息后显示 */}
              {msg.role === "ai" && i === 0 && answerHint && (
                <div className="ml-1">
                  <button
                    onClick={() => setShowHint((v) => !v)}
                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition"
                  >
                    {showHint ? <EyeOff size={11} /> : <Eye size={11} />}
                    {showHint ? "隐藏参考答案" : "查看参考答案"}
                  </button>
                  {showHint && (
                    <div className="mt-1.5 px-3 py-2.5 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-800 leading-relaxed whitespace-pre-line">
                      {answerHint}
                    </div>
                  )}
                </div>
              )}

              {/* 复习建议 — 低分时显示 */}
              {msg.role === "ai" && msg.suggestion && (
                <div className="ml-1 px-3 py-2.5 bg-orange-50 border border-orange-100 rounded-xl flex gap-2">
                  <AlertCircle size={13} className="text-orange-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-orange-700 mb-1">建议重新学习</p>
                    <p className="text-xs text-orange-700 leading-relaxed whitespace-pre-line">{msg.suggestion}</p>
                  </div>
                </div>
              )}
            </div>
          ))}

          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-2.5 flex items-center gap-2 text-sm text-gray-500">
                <Loader2 size={13} className="animate-spin" style={{ color: "var(--accent)" }} />
                思考中...
              </div>
            </div>
          )}

          {passed && (
            <div className="flex justify-center py-2">
              <div className="flex items-center gap-2 px-4 py-2 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700">
                <CheckCircle2 size={16} />
                验收通过！继续加油
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        {!passed && (
          <div className="px-4 pb-4 pt-2 border-t border-gray-100 flex gap-2">
            <input value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendAnswer()}
              placeholder="用自己的话回答..."
              disabled={isLoading}
              className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:opacity-50" />
            <button onClick={sendAnswer} disabled={!input.trim() || isLoading}
              className="px-4 py-2 text-white text-sm rounded-xl disabled:opacity-40 transition"
              style={{ backgroundColor: "var(--accent)" }}>
              回答
            </button>
          </div>
        )}

        {/* 底部操作 */}
        <div className="px-4 pb-4 pt-2 border-t border-gray-100 space-y-2">
          {hasAnswer && !saved && (
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeAnswer}
                  onChange={(e) => setIncludeAnswer(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-blue-500"
                />
                包含我的回答
              </label>
              <button
                onClick={handleSaveNote}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50 transition"
              >
                <BookOpen size={12} />
                保存到摘录
              </button>
            </div>
          )}
          {saved && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <CheckCircle2 size={12} /> 已保存到摘录
            </span>
          )}
          {passed && (
            <button onClick={onClose}
              className="w-full py-2 text-white text-sm font-medium rounded-xl transition"
              style={{ backgroundColor: "var(--accent)" }}>
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
