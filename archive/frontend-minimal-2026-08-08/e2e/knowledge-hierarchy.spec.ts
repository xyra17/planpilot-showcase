import { expect, test } from "@playwright/test";

test.skip(
  process.env.PLANPILOT_E2E !== "1" || !process.env.PLANPILOT_E2E_EMAIL,
  "Requires a reusable real learner account",
);

test("资料空间与知识库使用一级、二级页面层级", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(process.env.PLANPILOT_E2E_EMAIL ?? "");
  await page.getByPlaceholder("••••••••").fill(process.env.PLANPILOT_E2E_PASSWORD ?? "PlanPilot-e2e-2026");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/work/);

  await page.goto("/work/knowledge");
  await expect(page.getByRole("heading", { name: "资料空间", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "我的知识库", level: 2 })).toBeVisible();

  const libraryName = `层级验证-${Date.now()}`;
  await page.getByRole("button", { name: "新建知识库", exact: true }).first().click();
  await page.getByPlaceholder("例如：Python 进阶").fill(libraryName);
  await page.getByPlaceholder("这个知识库用于整理什么内容？").fill("自动化验证一级和二级页面");
  await page.getByRole("button", { name: "创建知识库", exact: true }).click();

  const libraryLink = page.getByRole("link", { name: new RegExp(libraryName) });
  await expect(libraryLink).toBeVisible();
  await libraryLink.click();
  await expect(page).toHaveURL(/\/work\/knowledge\/[^/]+$/);
  await expect(page.getByRole("heading", { name: libraryName, level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "资料空间", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "资料内容", level: 2 })).toBeVisible();

  await page.getByRole("button", { name: "删除知识库", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "删除知识库" });
  await dialog.getByRole("button", { name: "删除知识库", exact: true }).click();
  await expect(page).toHaveURL(/\/work\/knowledge$/);
  await expect(page.getByRole("heading", { name: "资料空间", level: 1 })).toBeVisible();
});
