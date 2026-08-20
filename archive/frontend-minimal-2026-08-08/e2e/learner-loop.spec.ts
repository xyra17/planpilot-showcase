import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

test.skip(
  process.env.PLANPILOT_E2E !== "1",
  "Set PLANPILOT_E2E=1 when the real Docker backend and frontend are running"
);

const API_URL = process.env.PLANPILOT_API_URL ?? "http://127.0.0.1:8000";

function runLearningTask(task: "process_learning_events" | "rebuild_learner_profiles") {
  const moduleName =
    task === "process_learning_events" ? "pattern_tasks" : "profile_tasks";
  const source = `from src.tasks.${moduleName} import ${task}; print(${task}())`;
  execFileSync("docker", ["exec", "planpilot-worker-1", "python", "-c", source], {
    stdio: "pipe",
    timeout: 120_000,
  });
}

async function learnerGet<T>(page: import("@playwright/test").Page, path: string) {
  return page.evaluate(
    async ({ apiUrl, requestPath }) => {
      const token = localStorage.getItem("access_token");
      const response = await fetch(`${apiUrl}${requestPath}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { apiUrl: API_URL, requestPath: path }
  ) as Promise<T>;
}

test("real learner loop: behavior to proposal feedback", async ({ page }) => {
  const unique = Date.now().toString();
  const goalTitle = `E2E 学习闭环 ${unique}`;
  const reusableEmail = process.env.PLANPILOT_E2E_EMAIL;

  // The Dashboard opens a once-per-day AI planning modal. Keep this scenario
  // focused on the learner loop, including for reused accounts where daily
  // plan generation can otherwise cover the task controls for a long time.
  await page.addInitScript(() => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    localStorage.setItem("lastPlanDate", today);
  });

  if (reusableEmail) {
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(reusableEmail);
    await page.getByPlaceholder("••••••••").fill(
      process.env.PLANPILOT_E2E_PASSWORD ?? "PlanPilot-e2e-2026"
    );
    await page.getByRole("button", { name: "登录", exact: true }).click();
  } else {
    await page.goto("/register");
    await page.getByPlaceholder("2~32 个字符").fill(`e2e${unique}`.slice(0, 28));
    await page.getByPlaceholder("you@example.com").fill(`e2e-${unique}@example.com`);
    await page.getByPlaceholder("至少 6 位").fill("PlanPilot-e2e-2026");
    await page.getByRole("button", { name: "注册", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/work/);

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/work/);
  await expect(page.getByText("内部管理后台", { exact: true })).toHaveCount(0);

  await page.goto("/settings");
  await page.getByLabel("学习时区").selectOption("Asia/Tokyo");
  await expect(page.getByLabel("学习时区")).toHaveValue("Asia/Tokyo");

  await page.reload();
  await expect(page.getByLabel("学习时区")).toHaveValue("Asia/Tokyo");

  await page.goto("/work");

  await page.goto("/work/goals/new");
  await page.getByPlaceholder("例如：2026 年 CPA 会计科目").fill(goalTitle);
  const deadline = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
  await page.locator('input[type="date"]').fill(deadline);
  await page.getByRole("button", { name: "创建目标", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "目标创建结果" })).toBeVisible();
  await page.getByRole("button", { name: "稍后再说" }).click();

  await page.goto("/work");
  for (let index = 1; index <= 8; index += 1) {
    const title = `行为证据任务 ${unique}-${index}`;
    await page.getByRole("button", { name: /添加/ }).click();
    const taskName = page.getByPlaceholder("任务名称…");
    await taskName.fill(title);
    await taskName.locator("..").getByRole("combobox").selectOption({ label: goalTitle });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const taskRow = page.locator(".today-task-item").filter({ hasText: title });
    const taskTitle = taskRow.getByText(title, { exact: true });
    await expect(taskTitle).toBeVisible();
    await taskRow.getByRole("button").first().click();
    await expect(taskTitle).toHaveClass(/line-through/);
  }

  await page.goto("/work/checkin");
  await expect(page.getByRole("heading", { name: "每日打卡" })).toBeVisible();
  const mastered = page.getByRole("button", { name: "完全掌握" });
  await expect(mastered).toHaveCount(8);
  for (let index = 0; index < 8; index += 1) await mastered.nth(index).click();
  await page.getByRole("button", { name: "提交今日打卡" }).click();
  await expect(page.getByText("任务执行率", { exact: true })).toBeVisible();

  runLearningTask("process_learning_events");
  runLearningTask("rebuild_learner_profiles");

  await page.goto("/work");
  await expect(page.getByTestId("today-ai-insight")).toBeVisible();
  await page.goto("/coach");
  await expect(page.getByTestId("coach-conversation")).toBeVisible();
  await expect(page.getByText(/个活跃规律/)).not.toContainText("0 个");

  const before = await learnerGet<{ active_patterns: Array<{ id: string; confidence: number }> }>(
    page,
    "/api/v1/learner/decision-context"
  );
  expect(before.active_patterns.length).toBeGreaterThan(0);
  expect((before as { cognitive_profile?: unknown }).cognitive_profile).toBeTruthy();
  expect((before as { memories?: unknown }).memories).toBeTruthy();
  const observedPattern = before.active_patterns[0];

  const generate = page.getByRole("button", { name: "生成建议" });
  await expect(generate).toBeEnabled();
  await generate.click();
  const proposal = page.getByTestId("proposal-card").first();
  await expect(proposal).toBeVisible({ timeout: 60_000 });
  await proposal.getByRole("button", { name: "接受建议" }).click();
  await proposal.getByRole("button", { name: "应用变更" }).click();
  await proposal.getByTitle("有效").click();
  await expect(page.getByText(/1 条效果反馈/)).toBeVisible();

  const after = await learnerGet<{ active_patterns: Array<{ id: string; confidence: number }> }>(
    page,
    "/api/v1/learner/decision-context"
  );
  const updated = after.active_patterns.find((pattern) => pattern.id === observedPattern.id);
  expect(updated?.confidence).toBeGreaterThan(observedPattern.confidence);

  await generate.click();
  const pending = page.getByTestId("proposal-card").filter({ hasText: "待确认" }).first();
  await expect(pending).toBeVisible({ timeout: 60_000 });
  await pending.getByRole("button", { name: "拒绝" }).click();
  await expect(page.getByTestId("proposal-card").filter({ hasText: "已拒绝" }).first()).toBeVisible();

  await expect(page.getByRole("navigation", { name: "学习伙伴导航" })).toBeVisible();
  await page.getByRole("link", { name: /学习空间/ }).first().click();
  await expect(page).toHaveURL(/\/work/);
  await expect(page.getByRole("navigation", { name: "学习空间导航" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开导航" }).click();
  const mobileNavigation = page.getByTestId("mobile-product-navigation");
  await expect(mobileNavigation).toBeVisible();
  await mobileNavigation.getByRole("link", { name: /学习伙伴/ }).click();
  await expect(page).toHaveURL(/\/coach/);
  if (process.env.PLANPILOT_E2E_EXPECT_ADMIN === "1") {
    await expect(page.getByText("进入管理后台", { exact: true })).toBeVisible();
  }
});
