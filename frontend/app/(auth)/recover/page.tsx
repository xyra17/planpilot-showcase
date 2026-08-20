"use client";

import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, MailCheck, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { AppBrand } from "@/components/app/AppBrand";
import { ApiError, api } from "@/lib/api";

type RecoverStage =
  | "validating"
  | "email"
  | "email-sent"
  | "new-password"
  | "invalid-link"
  | "expired-link"
  | "success";

type ForgotPasswordResponse = {
  message: string;
  delivery_available: boolean;
};

function passwordIsValid(password: string) {
  return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

export default function RecoverPage() {
  const [stage, setStage] = useState<RecoverStage>("validating");
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    const queryToken = new URLSearchParams(window.location.search).get("token") ?? "";
    if (!queryToken) {
      setStage("email");
      return;
    }
    setToken(queryToken);
    void api.get<{ status: string }>(
      `/api/v1/auth/reset-password/validate?token=${encodeURIComponent(queryToken)}`,
    ).then(() => {
      setStage("new-password");
    }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 410) {
        setStage("expired-link");
        setStatusMessage("链接已失效，请重新申请密码重置邮件");
      } else {
        setStage("invalid-link");
        setStatusMessage("链接无效，请重新申请密码重置邮件");
      }
    });
  }, []);

  function startOver() {
    window.history.replaceState({}, "", "/auth/recover");
    setToken("");
    setEmail("");
    setNewPassword("");
    setConfirmPassword("");
    setFieldError(null);
    setStatusMessage(null);
    setStage("email");
  }

  async function handleEmailSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFieldError(null);
    setStatusMessage(null);
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setFieldError("请输入有效的邮箱地址");
      return;
    }

    setLoading(true);
    try {
      const result = await api.post<ForgotPasswordResponse>("/api/v1/auth/forgot-password", {
        email: normalizedEmail,
      });
      if (!result.delivery_available) {
        setStatusMessage("该邮箱不存在或当前邮件服务不可用，请稍后再试");
        return;
      }
      setStatusMessage(result.message);
      setStage("email-sent");
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        setStatusMessage("发送过于频繁，请稍后再试");
      } else if (error instanceof ApiError && error.status === 0) {
        setStatusMessage("网络连接失败，请检查网络后重试");
      } else {
        setStatusMessage(error instanceof Error ? error.message : "请求失败，请重试");
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleResetSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFieldError(null);
    setStatusMessage(null);
    if (!passwordIsValid(newPassword)) {
      setFieldError("新密码至少 8 位，并同时包含字母和数字");
      return;
    }
    if (newPassword !== confirmPassword) {
      setFieldError("两次输入的密码不一致");
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/v1/auth/reset-password", { token, new_password: newPassword });
      setStage("success");
      setStatusMessage("密码已重置，请使用新密码登录");
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        setStage("expired-link");
        setStatusMessage("链接已失效，请重新申请密码重置邮件");
      } else if (error instanceof ApiError && error.status === 400) {
        setStage("invalid-link");
        setStatusMessage("链接无效，请重新申请密码重置邮件");
      } else if (error instanceof ApiError && error.status === 0) {
        setStatusMessage("网络连接失败，请检查网络后重试");
      } else {
        setStatusMessage(error instanceof Error ? error.message : "重置失败，请重试");
      }
    } finally {
      setLoading(false);
    }
  }

  const heading = stage === "new-password"
    ? "设置新密码"
    : stage === "email-sent"
      ? "邮件已发送"
      : stage === "success"
        ? "重置成功"
        : stage === "invalid-link" || stage === "expired-link"
          ? "无法使用此链接"
          : "找回密码";

  return (
    <div className="pp-auth-page">
      <div className="pp-auth-card pp-recover-card">
        <div className="mb-6 text-center">
          <div className="pp-auth-mobile-brand"><AppBrand href="/auth/recover" /></div>
          <h1 className="text-2xl font-bold text-gray-900">{heading}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {stage === "new-password" ? "输入并确认你的新密码" : "通过注册邮箱安全恢复账户"}
          </p>
        </div>

        {stage === "validating" && (
          <div className="pp-recover-result" role="status">
            <span className="pp-register-complete-icon is-verifying"><Loader2 size={24} className="animate-spin" /></span>
            <strong>正在检查链接…</strong>
          </div>
        )}

        {stage === "email" && (
          <form onSubmit={handleEmailSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="recover-email" className="mb-1 block text-sm font-medium text-gray-700">邮箱</label>
              <input
                id="recover-email"
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setFieldError(null);
                  setStatusMessage(null);
                }}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                disabled={loading}
                placeholder="you@example.com"
                aria-invalid={Boolean(fieldError)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none transition focus:border-transparent focus:ring-2 focus:ring-accent disabled:opacity-60"
              />
              {fieldError && <p className="pp-auth-field-error">{fieldError}</p>}
            </div>
            {statusMessage && <div role="alert" className="pp-auth-status pp-auth-status-network-error">{statusMessage}</div>}
            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="flex w-full items-center justify-center gap-2 bg-accent py-2 text-sm font-medium text-white disabled:opacity-70"
            >
              {loading && <Loader2 size={16} className="animate-spin" />}
              {loading ? "发送中…" : "发送重置邮件"}
            </button>
          </form>
        )}

        {stage === "email-sent" && (
          <div className="pp-recover-result" role="status">
            <span className="pp-register-complete-icon"><MailCheck size={25} /></span>
            <strong>请检查你的邮箱</strong>
            <p>如果 <b>{email}</b> 已注册且可用，重置链接将在几分钟内送达。</p>
            <small>链接有效期为 1 小时；没收到时请检查垃圾邮件。</small>
            <button type="button" onClick={startOver} className="pp-recover-secondary">重新输入邮箱</button>
          </div>
        )}

        {stage === "new-password" && (
          <form onSubmit={handleResetSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="recover-new-password" className="mb-1 block text-sm font-medium text-gray-700">新密码</label>
              <div className="pp-auth-password-field">
                <input
                  id="recover-new-password"
                  type={showNewPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={(event) => { setNewPassword(event.target.value); setFieldError(null); }}
                  autoComplete="new-password"
                  disabled={loading}
                  placeholder="至少 8 位，包含字母和数字"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 pr-11 text-sm outline-none transition focus:border-transparent focus:ring-2 focus:ring-accent disabled:opacity-60"
                />
                <button type="button" className="pp-auth-password-toggle" onClick={() => setShowNewPassword((value) => !value)} aria-label={showNewPassword ? "隐藏新密码" : "显示新密码"}>
                  {showNewPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="recover-confirm-password" className="mb-1 block text-sm font-medium text-gray-700">确认新密码</label>
              <div className="pp-auth-password-field">
                <input
                  id="recover-confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(event) => { setConfirmPassword(event.target.value); setFieldError(null); }}
                  autoComplete="new-password"
                  disabled={loading}
                  placeholder="再次输入新密码"
                  aria-invalid={fieldError?.includes("不一致") || undefined}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 pr-11 text-sm outline-none transition focus:border-transparent focus:ring-2 focus:ring-accent disabled:opacity-60"
                />
                <button type="button" className="pp-auth-password-toggle" onClick={() => setShowConfirmPassword((value) => !value)} aria-label={showConfirmPassword ? "隐藏确认密码" : "显示确认密码"}>
                  {showConfirmPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            {fieldError && <div role="alert" className="pp-auth-status">{fieldError}</div>}
            {statusMessage && <div role="alert" className="pp-auth-status pp-auth-status-network-error">{statusMessage}</div>}
            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="flex w-full items-center justify-center gap-2 bg-accent py-2 text-sm font-medium text-white disabled:opacity-70"
            >
              {loading && <Loader2 size={16} className="animate-spin" />}
              {loading ? "重置中…" : "确认重置"}
            </button>
          </form>
        )}

        {(stage === "invalid-link" || stage === "expired-link") && (
          <div className="pp-recover-result" role="alert">
            <span className="pp-register-complete-icon is-error"><XCircle size={25} /></span>
            <strong>{stage === "expired-link" ? "链接已失效" : "链接无效"}</strong>
            <p>{statusMessage}</p>
            <button type="button" onClick={startOver} className="pp-register-continue">重新申请</button>
          </div>
        )}

        {stage === "success" && (
          <div className="pp-recover-result" role="status">
            <span className="pp-register-complete-icon"><CheckCircle2 size={25} /></span>
            <strong>密码重置成功</strong>
            <p>{statusMessage}</p>
            <Link href="/login" className="pp-register-continue">使用新密码登录</Link>
          </div>
        )}

        <p className="mt-5 text-center text-sm text-gray-500">
          <Link href="/login" className="inline-flex items-center gap-1 text-accent hover:underline">
            <KeyRound size={13} /> 返回登录
          </Link>
        </p>
      </div>
    </div>
  );
}
