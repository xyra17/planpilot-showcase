const AUTH_REQUIRED_PATTERN = /请先登录|尚未登录|未登录|登录(?:状态|会话)?(?:已)?(?:失效|过期)|重新登录|认证(?:已)?失效|身份验证失败|unauthorized/i;

export function noticeRequiresLogin(message?: string | null) {
  return Boolean(message && AUTH_REQUIRED_PATTERN.test(message));
}

export function safeProductReturnPath(value?: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.startsWith("/login")) {
    return "/studio/work";
  }
  return value;
}

export function currentLoginHref() {
  if (typeof window === "undefined") return "/login";
  const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `/login?next=${encodeURIComponent(safeProductReturnPath(returnPath))}`;
}

export function navigateToLogin(href?: string) {
  if (typeof window === "undefined") return;
  window.location.assign(href ?? currentLoginHref());
}
