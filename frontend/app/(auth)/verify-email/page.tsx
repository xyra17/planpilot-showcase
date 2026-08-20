"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";

type VerifyState = "verifying" | "success" | "error";

export default function VerifyEmailPage() {
  const [state, setState] = useState<VerifyState>("verifying");
  const [message, setMessage] = useState("正在验证邮箱…");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setState("error");
      setMessage("验证链接缺少必要信息");
      return;
    }
    void api.post<{ message: string }>("/api/v1/auth/verify-email", { token })
      .then((result) => {
        setState("success");
        setMessage(result.message);
        try {
          const cached = localStorage.getItem("user_info");
          if (cached) localStorage.setItem("user_info", JSON.stringify({ ...JSON.parse(cached), email_verified: true }));
        } catch {
          // Ignore corrupt local profile data; the server remains authoritative.
        }
      })
      .catch((error: unknown) => {
        setState("error");
        setMessage(error instanceof Error ? error.message : "邮箱验证失败，请重新申请");
      });
  }, []);

  return (
    <div className="pp-auth-page">
      <div className="pp-auth-card pp-email-verify-card">
        <span className={`pp-register-complete-icon is-${state}`}>
          {state === "verifying" && <Loader2 size={25} className="animate-spin" />}
          {state === "success" && <CheckCircle2 size={25} />}
          {state === "error" && <XCircle size={25} />}
        </span>
        <h1>{state === "success" ? "邮箱验证成功" : state === "error" ? "无法完成验证" : "验证邮箱"}</h1>
        <p>{message}</p>
        <Link href={state === "success" ? "/onboarding" : "/login"} className="pp-register-continue">
          {state === "success" ? "继续完成设置" : "返回登录"}
        </Link>
      </div>
    </div>
  );
}
