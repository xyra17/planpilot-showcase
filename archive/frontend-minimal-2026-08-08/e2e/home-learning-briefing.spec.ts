import { expect, test } from "@playwright/test";

test.skip(
  process.env.PLANPILOT_E2E !== "1" || !process.env.PLANPILOT_E2E_EMAIL,
  "Requires a reusable real learner account",
);

test("首页高效学习时段显示在问候语下方", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(process.env.PLANPILOT_E2E_EMAIL ?? "");
  await page.getByPlaceholder("••••••••").fill(process.env.PLANPILOT_E2E_PASSWORD ?? "PlanPilot-e2e-2026");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/work/);

  await expect(page.locator(".home-date-chip")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/好，/);
  await expect(page.getByTestId("home-greeting-insight")).toBeVisible();
  await expect(page.getByText("你的高效学习时段在 21:00 左右", { exact: true })).toBeVisible();
  await expect(page.getByText("建议把今天最重要、认知负荷最高的任务优先放在这个时段。", { exact: true })).toBeVisible();
  await expect(page.getByText("本周时长", { exact: true })).toBeVisible();
  await expect(page.getByText("进行目标", { exact: true })).toBeVisible();
  await expect(page.getByText("今日完成", { exact: true })).toBeVisible();
  await expect(page.getByText("今日复习提示", { exact: true })).toBeVisible();
  await expect(page.getByTestId("home-learning-insight")).toHaveCount(0);
});
