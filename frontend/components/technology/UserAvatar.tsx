"use client";

import Image from "next/image";
import { useState } from "react";
import { resolveApiAssetUrl } from "@/lib/api";

type UserAvatarProps = {
  avatarUrl?: string | null;
  username?: string | null;
  size?: number;
  className?: string;
  alt?: string;
};

export function UserAvatar({
  avatarUrl,
  username,
  size = 40,
  className = "",
  alt,
}: UserAvatarProps) {
  const source = resolveApiAssetUrl(avatarUrl);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const visibleSource = source && source !== failedSource ? source : null;
  const label = username?.trim() || "用户";
  return (
    <span
      className={`user-avatar ${visibleSource ? "has-image" : "has-fallback"} ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-label={alt ?? `${label}的头像`}
      data-avatar-state={visibleSource ? "image" : source ? "unavailable" : "fallback"}
      role="img"
    >
      {visibleSource ? (
        <Image
          src={visibleSource}
          alt=""
          width={size}
          height={size}
          sizes={`${size}px`}
          unoptimized
          onError={() => setFailedSource(visibleSource)}
        />
      ) : (
        <span aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
