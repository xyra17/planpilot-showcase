"use client";

/**
 * Browser persistence is deliberately namespaced by ownership. Guest data is
 * kept in one device-local bucket; authenticated data gets its own bucket per
 * account. The optional legacy key is only consulted for the guest bucket so
 * an old browser cache can be migrated without ever importing it into an
 * account.
 */
export function scopedStorageKey(key: string, userId?: string | null) {
  const scope = userId ? `user:${encodeURIComponent(userId)}` : "guest";
  return `planpilot:storage:v1:${scope}:${key}`;
}

export function readScopedJson<T>(
  key: string,
  userId: string | null | undefined,
  fallback: T,
  legacyKey?: string,
): T {
  if (typeof window === "undefined") return fallback;
  const namespacedKey = scopedStorageKey(key, userId);
  try {
    const namespaced = window.localStorage.getItem(namespacedKey);
    if (namespaced) return JSON.parse(namespaced) as T;

    // Legacy unscoped data is a guest migration source only. Never read it
    // while an account is active.
    if (!userId && legacyKey) {
      const legacy = window.localStorage.getItem(legacyKey);
      if (legacy) {
        window.localStorage.setItem(namespacedKey, legacy);
        return JSON.parse(legacy) as T;
      }
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function writeScopedJson<T>(
  key: string,
  userId: string | null | undefined,
  value: T,
  legacyKey?: string,
) {
  if (typeof window === "undefined") return;
  const serialized = JSON.stringify(value);
  window.localStorage.setItem(scopedStorageKey(key, userId), serialized);
  // Keep the old unscoped guest key in sync only when a caller explicitly
  // names it. Authenticated writes never create or update legacy keys.
  if (!userId && legacyKey) window.localStorage.setItem(legacyKey, serialized);
}

export function removeScopedKey(key: string, userId?: string | null) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(scopedStorageKey(key, userId));
}
