"use client";

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") ?? "";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 6) { setError("密码不能少于 6 位"); return; }
    if (newPassword !== confirmPassword) { setError("两次输入的密码不一致"); return; }
    setLoading(true);
    try {
      await api.post("/api/v1/auth/reset-password", { token, new_password: newPassword });
      setSuccess(true);
      setTimeout(() => router.replace("/login"), 2500);
    } catch (err) {
      setError((err as Error).message ?? "重置失败，请重试");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="text-center space-y-3">
        <p className="text-sm text-red-500">链接无效，请重新申请密码重置。</p>
        <Link href="/forgot-password" className="text-sm text-accent hover:underline">重新申请</Link>
      </div>
    );
  }

  return (
    <>
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">设置新密码</h1>
        <p className="text-sm text-gray-500 mt-1">请输入你的新密码</p>
      </div>

      {success ? (
        <div className="text-center space-y-3">
          <div className="w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mx-auto">
            <svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-sm text-gray-700">密码已重置，正在跳转登录页…</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">新密码</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              placeholder="至少 6 位"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">确认新密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              placeholder="再次输入密码"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition"
            />
          </div>
          {error && (
            <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-accent text-white py-2 rounded-lg text-sm font-medium hover:bg-accent-dark disabled:opacity-60 transition mt-2"
          >
            {loading ? "重置中..." : "确认重置"}
          </button>
        </form>
      )}

      <p className="text-sm text-center text-gray-500 mt-6">
        <Link href="/login" className="text-accent hover:underline">返回登录</Link>
      </p>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="pp-auth-page">
      <div className="pp-auth-card">
        <Suspense fallback={<p className="text-sm text-center text-gray-400">加载中…</p>}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
