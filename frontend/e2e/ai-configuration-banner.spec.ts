import { expect, test } from "@playwright/test";

const user = {
  id: "download-preview-user",
  email: "preview@example.com",
  username: "体验用户",
  is_admin: false,
  onboarding_completed: true,
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((cachedUser) => localStorage.setItem("user_info", JSON.stringify(cachedUser)), user);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: user }));
  await page.route("**/api/v1/tasks**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/goals**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/notes**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/knowledge/**", (route) => route.fulfill({ json: [] }));
});

test("未配置 AI 时说明基础功能仍可使用并提供配置入口", async ({ page }, testInfo) => {
  await page.route("**/health/ai", (route) => route.fulfill({
    json: { cloud_routine_configured: false, local_reachable: false, embedding_configured: false, embedding_reachable: false },
  }));
  await page.goto("/studio/settings");
  const notice = page.getByRole("complementary", { name: "AI 配置提示" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("目标、任务、打卡和笔记仍可正常使用");
  await expect(notice.getByRole("link", { name: "查看配置方式" })).toHaveAttribute("target", "_blank");
  await page.screenshot({ path: testInfo.outputPath("ai-setup-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(notice).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ai-setup-mobile.png"), fullPage: true });
  await notice.getByRole("button", { name: "暂时关闭 AI 配置提示" }).click();
  await expect(notice).toBeHidden();
});

test("生成与向量模型均可用时不显示配置提示", async ({ page }) => {
  await page.route("**/health/ai", (route) => route.fulfill({
    json: { cloud_routine_configured: true, local_reachable: false, embedding_configured: true, embedding_reachable: true },
  }));
  await page.goto("/studio/settings");
  await expect(page.getByRole("complementary", { name: "AI 配置提示" })).toHaveCount(0);
});
