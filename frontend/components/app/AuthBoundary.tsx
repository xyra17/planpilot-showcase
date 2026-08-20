"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuthStore } from "@/lib/stores/authStore";

export function AuthBoundary({
  children,
  requireAdmin = false,
}: {
  children: React.ReactNode;
  requireAdmin?: boolean;
}) {
  const router = useRouter();
  const { user, initFromStorage, refreshUser } = useAuthStore();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    initFromStorage();
    void refreshUser()
      .then((currentUser) => {
        if (!active) return;
        if (requireAdmin && !currentUser.is_admin) {
          router.replace("/studio/work");
          return;
        }
        setReady(true);
      })
      .catch(() => {
        if (!active) return;
        router.replace("/login");
      });
    return () => {
      active = false;
    };
  }, [initFromStorage, refreshUser, requireAdmin, router]);

  if (!ready || !user || (requireAdmin && !user.is_admin)) {
    return (
      <div className="pp-auth-loading">
        <div className="pp-auth-loading-mark"><Loader2 size={20} className="animate-spin" /></div>
        <p>{requireAdmin ? "正在验证管理权限…" : "正在进入 PlanPilot…"}</p>
      </div>
    );
  }

  return <>{children}</>;
}
