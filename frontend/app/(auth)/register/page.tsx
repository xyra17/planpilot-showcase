"use client";

import { CheckCircle2, Eye, EyeOff, Loader2, MailCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AppBrand } from "@/components/app/AppBrand";
import { ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/authStore";

type RegisterState =
  | "default"
  | "email-exists"
  | "password-invalid"
  | "agreement-error"
  | "network-error"
  | "email-sent"
  | "success";

type FieldErrors = {
  username?: string;
  email?: string;
  password?: string;
  agreement?: string;
};

function getPasswordStrength(password: string) {
  if (!password) return { score: 0, label: "尚未输入", tone: "empty" };
  let score = 0;
  if (password.length >= 8) score += 1;
  if (/[A-Za-z]/.test(password) && /\d/.test(password)) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (password.length >= 12 || /[^A-Za-z0-9]/.test(password)) score += 1;
  if (score <= 1) return { score, label: "较弱", tone: "weak" };
  if (score <= 2) return { score, label: "中等", tone: "medium" };
  return { score, label: "较强", tone: "strong" };
}

export default function RegisterPage() {
  const { register, isLoading } = useAuthStore();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [registerState, setRegisterState] = useState<RegisterState>("default");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const strength = getPasswordStrength(password);

  function resetStatus() {
    if (registerState !== "default") setRegisterState("default");
    if (statusMessage) setStatusMessage(null);
  }

  function validate(): boolean {
    const errors: FieldErrors = {};
    const trimmedUsername = username.trim();
    const trimmedEmail = email.trim();
    if (trimmedUsername.length < 2 || trimmedUsername.length > 32) {
      errors.username = "用户名长度需在 2～32 个字符之间";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errors.email = "请输入有效的邮箱地址";
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      errors.password = "密码至少 8 位，并同时包含字母和数字";
    }
    if (!agreementAccepted) errors.agreement = "请先阅读并同意用户协议和隐私政策";
    setFieldErrors(errors);
    if (errors.password) setRegisterState("password-invalid");
    else if (errors.agreement) setRegisterState("agreement-error");
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    resetStatus();
    if (!validate()) return;

    try {
      const result = await register(email.trim().toLowerCase(), username.trim(), password);
      if (result.verificationEmailSent) {
        setRegisterState("email-sent");
        setStatusMessage(`注册成功，验证邮件已发送至 ${result.user.email}`);
      } else {
        setRegisterState("success");
        setStatusMessage("注册成功。邮件服务暂不可用，你可以先进入 PlanPilot。");
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) {
        setRegisterState("network-error");
        setStatusMessage("网络连接失败，请检查网络后重试");
      } else if (error instanceof ApiError && error.message.includes("邮箱")) {
        setRegisterState("email-exists");
        setFieldErrors((current) => ({ ...current, email: "该邮箱已存在，请直接登录" }));
        setStatusMessage("该邮箱已存在，请直接登录或找回密码");
      } else if (error instanceof ApiError && error.message.includes("密码")) {
        const message = error.message;
        setRegisterState("password-invalid");
        setFieldErrors((current) => ({ ...current, password: message }));
        setStatusMessage(message);
      } else {
        setRegisterState("default");
        setStatusMessage(error instanceof Error ? error.message : "注册失败，请重试");
      }
    }
  }

  const completed = registerState === "email-sent" || registerState === "success";

  return (
    <div className="pp-auth-page">
      <div className="pp-auth-card pp-register-card">
        <div className="mb-6 text-center">
          <div className="pp-auth-mobile-brand"><AppBrand href="/auth/register" /></div>
          <h1 className="text-2xl font-bold text-gray-900">创建账户</h1>
          <p className="mt-1 text-sm text-gray-500">开始建立长期学习节奏</p>
        </div>

        {completed ? (
          <div className="pp-register-complete" role="status">
            <span className="pp-register-complete-icon">
              {registerState === "email-sent" ? <MailCheck size={25} /> : <CheckCircle2 size={25} />}
            </span>
            <strong>{registerState === "email-sent" ? "验证邮件已发送" : "注册成功"}</strong>
            <p>{statusMessage}</p>
            {registerState === "email-sent" && <small>请在 24 小时内打开邮件中的链接完成验证。</small>}
            <Link href="/onboarding" className="pp-register-continue">
              继续完成设置
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
            <div>
              <label htmlFor="register-username" className="mb-1 block text-sm font-medium text-gray-700">用户名</label>
              <input
                id="register-username"
                name="username"
                type="text"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  if (fieldErrors.username) setFieldErrors((current) => ({ ...current, username: undefined }));
                  resetStatus();
                }}
                autoComplete="username"
                disabled={isLoading}
                placeholder="2～32 个字符"
                aria-invalid={Boolean(fieldErrors.username)}
                aria-describedby={fieldErrors.username ? "register-username-error" : undefined}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none transition focus:border-transparent focus:ring-2 focus:ring-accent disabled:opacity-60"
              />
              {fieldErrors.username && <p id="register-username-error" className="pp-auth-field-error">{fieldErrors.username}</p>}
            </div>

            <div>
              <label htmlFor="register-email" className="mb-1 block text-sm font-medium text-gray-700">邮箱</label>
              <input
                id="register-email"
                name="email"
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: undefined }));
                  resetStatus();
                }}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                disabled={isLoading}
                placeholder="you@example.com"
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={fieldErrors.email ? "register-email-error" : undefined}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none transition focus:border-transparent focus:ring-2 focus:ring-accent disabled:opacity-60"
              />
              {fieldErrors.email && <p id="register-email-error" className="pp-auth-field-error">{fieldErrors.email}</p>}
            </div>

            <div>
              <label htmlFor="register-password" className="mb-1 block text-sm font-medium text-gray-700">密码</label>
              <div className="pp-auth-password-field">
                <input
                  id="register-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: undefined }));
                    resetStatus();
                  }}
                  autoComplete="new-password"
                  disabled={isLoading}
                  placeholder="至少 8 位，包含字母和数字"
                  aria-invalid={Boolean(fieldErrors.password)}
                  aria-describedby="register-password-strength"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 pr-11 text-sm outline-none transition focus:border-transparent focus:ring-2 focus:ring-accent disabled:opacity-60"
                />
                <button
                  type="button"
                  className="pp-auth-password-toggle"
                  onClick={() => setShowPassword((current) => !current)}
                  disabled={isLoading}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              <div id="register-password-strength" className="pp-password-strength" data-tone={strength.tone}>
                <span className="pp-password-strength-bars" role="progressbar" aria-label="密码强度" aria-valuemin={0} aria-valuemax={4} aria-valuenow={strength.score}>
                  {[1, 2, 3, 4].map((level) => <i key={level} className={level <= strength.score ? "is-active" : ""} />)}
                </span>
                <small>密码强度：{strength.label}</small>
              </div>
              {fieldErrors.password && <p className="pp-auth-field-error">{fieldErrors.password}</p>}
            </div>

            <div>
              <label className="pp-auth-agreement">
                <input
                  type="checkbox"
                  checked={agreementAccepted}
                  onChange={(event) => {
                    setAgreementAccepted(event.target.checked);
                    if (fieldErrors.agreement) setFieldErrors((current) => ({ ...current, agreement: undefined }));
                    resetStatus();
                  }}
                  disabled={isLoading}
                />
                <span>我已阅读并同意 <Link href="/terms">《用户协议》</Link> 和 <Link href="/privacy">《隐私政策》</Link></span>
              </label>
              {fieldErrors.agreement && <p className="pp-auth-field-error">{fieldErrors.agreement}</p>}
            </div>

            {statusMessage && (
              <div role="alert" className={`pp-auth-status pp-auth-status-${registerState}`}>
                <span>{statusMessage}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              aria-busy={isLoading}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-sm font-medium text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isLoading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              {isLoading ? "注册中…" : "注册"}
            </button>
          </form>
        )}

        <p className="mt-5 text-center text-sm text-gray-500">
          已有账户？ <Link href="/login" className="text-accent hover:underline">登录</Link>
        </p>
      </div>
    </div>
  );
}
