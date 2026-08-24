"use client";

import { Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";

export function GuestModeDialog({ onClose }: { onClose: () => void }) {
  const continueRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    continueRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="dialog-backdrop knowledge-demo-intro-backdrop knowledge-reference-page" onMouseDown={onClose}>
      <section
        className="app-dialog knowledge-demo-intro"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-mode-title"
        aria-describedby="guest-mode-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="knowledge-demo-intro-close" aria-label="关闭" onClick={onClose}><X size={19} /></button>
        <div className="knowledge-demo-intro-heading">
          <span className="knowledge-demo-intro-icon"><Sparkles size={21} /></span>
          <div>
            <h2 id="guest-mode-title">访客体验</h2>
            <p>先看看一个完整的学习工作区</p>
          </div>
        </div>
        <div className="knowledge-guest-gate-message" id="guest-mode-description">
          <strong>页面展示的是一组体验数据</strong>
          <span>目标、任务、笔记、资料与 Pilo 对话互相关联；登录后将使用你自己的真实数据。</span>
        </div>
        <footer>
          <button ref={continueRef} type="button" className="knowledge-guest-gate-dismiss" onClick={onClose}>继续体验</button>
          <div>
            <Link href="/register" className="knowledge-guest-gate-register">注册</Link>
            <Link href="/login" className="knowledge-guest-gate-login">登录</Link>
          </div>
        </footer>
      </section>
    </div>
  );
}
