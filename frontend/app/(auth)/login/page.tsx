"use client";

import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AppBrand } from "@/components/app/AppBrand";
import { ApiError } from "@/lib/api";
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
        window.location.href = "/studio/work";
      }, 500);
    } catch (error) {
      const result = messageForError(error);
      setLoginState(result.state);
      setStatusMessage(result.message);
    }
  }

  const submitting = isLoading || loginState === "success";

  return (
    <div className="pp-auth-page">
      <div className="pp-auth-card">
        <div className="mb-8 text-center">
          <div className="pp-auth-mobile-brand">
            <AppBrand href="/login" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">欢迎回来</h1>
          <p className="mt-1 text-sm text-gray-500">继续今天的学习旅程</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="login-identifier" className="mb-1 block text-sm font-medium text-gray-700">
              用户名或邮箱
            </label>
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
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none transition focus:border-transparent focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
            />
            {fieldErrors.identifier && (
              <p id="login-identifier-error" className="pp-auth-field-error">
                {fieldErrors.identifier}
              </p>
            )}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="login-password" className="block text-sm font-medium text-gray-700">
                密码
              </label>
              <Link href="/auth/recover" className="text-xs text-accent hover:underline">
                忘记密码？
              </Link>
            </div>
            <div className="pp-auth-password-field">
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
                className="w-full rounded-lg border border-gray-200 px-3 py-2 pr-11 text-sm outline-none transition focus:border-transparent focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
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

          <label className="pp-auth-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              disabled={submitting}
            />
            <span>记住登录状态（30 天）</span>
          </label>

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
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isLoading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            {isLoading ? "登录中…" : loginState === "success" ? "登录成功" : "登录"}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-gray-500">
          没有账号？{" "}
          <Link href="/register" className="text-accent hover:underline">
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
