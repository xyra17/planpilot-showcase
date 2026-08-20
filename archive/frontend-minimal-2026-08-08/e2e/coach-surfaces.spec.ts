import { expect, test } from "@playwright/test";

test.skip(
  process.env.PLANPILOT_E2E !== "1" || !process.env.PLANPILOT_E2E_EMAIL,
  "Requires a reusable real learner account",
);

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(process.env.PLANPILOT_E2E_EMAIL ?? "");
  await page.getByPlaceholder("••••••••").fill(process.env.PLANPILOT_E2E_PASSWORD ?? "PlanPilot-e2e-2026");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/work/);
});

test("学习对话以建议主线和决策上下文呈现", async ({ page }) => {
  await page.goto("/coach");

  await expect(page.getByRole("heading", { name: "学习对话", level: 1 })).toBeVisible();
  await expect(page.getByTestId("coach-conversation")).toBeVisible();
  await expect(page.getByText("今天，我们先处理最重要的一件事", { exact: true })).toBeVisible();
  await expect(page.getByLabel("学习伙伴决策上下文")).toBeVisible();
  await expect(page.getByText("为什么这样建议", { exact: true })).toBeVisible();
  await expect(page.getByText("所有计划变更都需要你确认", { exact: true })).toBeVisible();
});

test("任务协作使用描述、规划、确认的协作流程", async ({ page }) => {
  await page.goto("/coach/workbench");

  await expect(page.getByRole("heading", { name: "任务协作", level: 1 })).toBeVisible();
  await expect(page.getByText("告诉学习伙伴要协作什么", { exact: true })).toBeVisible();
  await expect(page.getByLabel("告诉学习伙伴要协作完成什么")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始协作", exact: true })).toBeVisible();
  await expect(page.getByText("所有变更需确认", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近协作", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "执行边界", level: 2 })).toBeVisible();
});
