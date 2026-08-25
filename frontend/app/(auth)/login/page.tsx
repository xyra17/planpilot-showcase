"use client";

import { ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, UserRound } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

import { AppBrand } from "@/components/app/AppBrand";
import { ApiError } from "@/lib/api";
import { safeProductReturnPath } from "@/lib/technology/noticeActions";
import { useAuthStore } from "@/lib/stores/authStore";

type LoginState =
  | "default"
  | "credentials-error"
  | "network-error"
  | "server-error"
  | "locked"
  | "success";

type FieldErrors = {
  identifier?: string;
  password?: string;
};

function messageForError(error: unknown): { state: LoginState; message: string } {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return { state: "network-error", message: "服务器暂时无法连接，请稍后重试" };
    }
    if (error.status === 401) {
      return { state: "credentials-error", message: "账号或密码错误，请重新输入" };
    }
    if (error.status === 423) {
      return { state: "locked", message: "账户已锁定，请联系管理员" };
    }
    if (error.status === 403) {
      return { state: "server-error", message: "当前请求未通过安全校验，请刷新页面后重试" };
    }
    if (error.status === 429) {
      return { state: "locked", message: "登录尝试过于频繁，请稍后再试" };
    }
    if (error.status >= 500) {
      return { state: "server-error", message: "服务暂时不可用，请稍后重试" };
    }
    return { state: "credentials-error", message: error.message || "登录失败，请重试" };
  }
  return { state: "network-error", message: "服务器暂时无法连接，请稍后重试" };
}

export default function LoginPage() {
  const { login, isLoading } = useAuthStore();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [loginState, setLoginState] = useState<LoginState>("default");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  function validate(): boolean {
    const nextErrors: FieldErrors = {};
    if (!identifier.trim()) nextErrors.identifier = "请输入用户名或邮箱";
    if (!password) nextErrors.password = "请输入密码";
    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function resetStatus() {
    if (loginState !== "default") setLoginState("default");
    if (statusMessage) setStatusMessage(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    resetStatus();
    if (!validate()) return;

    try {
      await login(identifier.trim(), password, remember);
      setLoginState("success");
      setStatusMessage("登录成功，正在进入 PlanPilot…");
      window.setTimeout(() => {
        const searchParams = new URLSearchParams(window.location.search);
        const returnPath = searchParams.get("next") ?? searchParams.get("returnTo");
        window.location.href = safeProductReturnPath(returnPath);
      }, 500);
    } catch (error) {
      const result = messageForError(error);
      setLoginState(result.state);
      setStatusMessage(result.message);
    }
  }

  const submitting = isLoading || loginState === "success";

  return (
    <div className="pp-auth-page pp-login-page">
      <Link href="/studio/work" className="pp-auth-guest-return">
        <ArrowLeft size={15} aria-hidden="true" />
        返回访客工作台
      </Link>
      <div className="pp-auth-card pp-login-card">
        <div className="pp-login-intro">
          <div className="pp-login-heading">
            <div className="pp-auth-mobile-brand">
              <AppBrand href="/studio/work" />
            </div>
            <span className="pp-login-kicker">CONTINUE YOUR JOURNEY</span>
            <h1>欢迎回来</h1>
            <p>继续今天的学习旅程，Pilo 已经在等你了。</p>
          </div>
          <div className="pp-login-pilo">
            <span>我在这里</span>
            <Image
              src="/pilo/pilo-idle.webp"
              width={210}
              height={249}
              alt="在欢迎页等你的 Pilo"
              priority
            />
          </div>
        </div>

        <form onSubmit={handleSubmit} className="pp-login-form" noValidate>
          <div className="pp-login-field">
            <label htmlFor="login-identifier">
              用户名或邮箱
            </label>
            <div className="pp-login-input-shell">
              <UserRound size={17} aria-hidden="true" />
              <input
                id="login-identifier"
                name="identifier"
                type="text"
                value={identifier}
                onChange={(event) => {
                  setIdentifier(event.target.value);
                  if (fieldErrors.identifier) setFieldErrors((current) => ({ ...current, identifier: undefined }));
                  resetStatus();
                }}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                disabled={submitting}
                placeholder="请输入用户名或邮箱"
                aria-invalid={Boolean(fieldErrors.identifier)}
                aria-describedby={fieldErrors.identifier ? "login-identifier-error" : undefined}
              />
            </div>
            {fieldErrors.identifier && (
              <p id="login-identifier-error" className="pp-auth-field-error">
                {fieldErrors.identifier}
              </p>
            )}
          </div>

          <div className="pp-login-field">
            <label htmlFor="login-password">密码</label>
            <div className="pp-login-input-shell pp-auth-password-field">
              <KeyRound size={17} aria-hidden="true" />
              <input
                id="login-password"
                name="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
                  resetStatus();
                }}
                autoComplete="current-password"
                disabled={submitting}
                placeholder="请输入密码"
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={fieldErrors.password ? "login-password-error" : undefined}
              />
              <button
                type="button"
                className="pp-auth-password-toggle"
                onClick={() => setShowPassword((current) => !current)}
                disabled={submitting}
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            {fieldErrors.password && (
              <p id="login-password-error" className="pp-auth-field-error">
                {fieldErrors.password}
              </p>
            )}
          </div>

          <div className="pp-login-meta">
            <label className="pp-auth-remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                disabled={submitting}
              />
              <span>记住登录状态（30 天）</span>
            </label>
            <Link href="/auth/recover">忘记密码？</Link>
          </div>

          {statusMessage && (
            <div
              role={loginState === "success" ? "status" : "alert"}
              className={`pp-auth-status pp-auth-status-${loginState}`}
            >
              {loginState === "success" && <CheckCircle2 size={16} aria-hidden="true" />}
              <span>{statusMessage}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            aria-busy={isLoading}
            className="pp-login-submit"
          >
            {isLoading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            {isLoading ? "登录中…" : loginState === "success" ? "登录成功" : "登录"}
            {!isLoading && loginState !== "success" && <ArrowRight size={16} aria-hidden="true" />}
          </button>
        </form>

        <p className="pp-login-switch">
          没有账号？{" "}
          <Link href="/register">
            注册
          </Link>
        </p>

        <p className="pp-auth-legal-links">
          登录即表示你同意
          <Link href="/terms">《用户协议》</Link>
          和
          <Link href="/privacy">《隐私政策》</Link>
        </p>
      </div>
    </div>
  );
}
