"use client";

import { ArrowRight, CheckCircle2, History, MessageCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { buildPiloCoachHref } from "@/lib/technology/piloCoachRoute";

export function ProfileFeedbackCard({ pendingCount }: { pendingCount: number }) {
  const coachHref = buildPiloCoachHref({
    intent: "correct-learning-profile",
    surface: "review",
    prompt: "我想校正你对我的学习画像。请先逐条询问和解释，不要自行改写，也不要直接保存为跨会话记录。",
    returnTo: "/studio/coach/memory",
  });

  const focusPending = () => {
    document.getElementById("pending-observations-title")?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  };

  return (
    <section className="personalization-feedback-card" aria-labelledby="profile-feedback-title">
      <div className="personalization-feedback-copy">
        <small><ShieldCheck size={13} aria-hidden="true" />由你决定哪些理解可以长期使用</small>
        <h2 id="profile-feedback-title">让 Pilo 的理解保持准确，也保持可控</h2>
        <p>对话中的纠正会帮助 Pilo 理解当前语境；只有你在这里确认或修正具体观察后，它才会作为跨会话偏好影响后续建议。</p>
      </div>

      <ol className="personalization-feedback-steps">
        <li><MessageCircle size={16} aria-hidden="true" /><span><strong>先在对话中说清楚</strong><small>Pilo 逐条询问，不擅自替你定性</small></span></li>
        <li><CheckCircle2 size={16} aria-hidden="true" /><span><strong>再确认具体观察</strong><small>确认或修正后，才跨会话生效</small></span></li>
        <li><History size={16} aria-hidden="true" /><span><strong>之后仍可管理</strong><small>调整范围、暂停、遗忘或撤销修改</small></span></li>
      </ol>

      <div className="personalization-feedback-actions">
        {pendingCount > 0 && (
          <button type="button" onClick={focusPending}>
            查看 {pendingCount} 条待确认观察<ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
        <Link className={pendingCount > 0 ? "is-secondary" : ""} href={coachHref}>
          和 Pilo 逐条校正
        </Link>
      </div>
    </section>
  );
}
