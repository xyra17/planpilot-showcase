import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

test.skip(
  process.env.PLANPILOT_E2E !== "1",
  "Set PLANPILOT_E2E=1 when the real Docker backend and frontend are running"
);

test("管理员查看运营总览并完成灰度发布与受控回滚", async ({ page }) => {
  const unique = Date.now().toString();
  const username = `canary${unique}`.slice(0, 28);
  const email = `canary-${unique}@example.com`;
  const password = "PlanPilot-canary-2026";
  const reusableEmail = process.env.PLANPILOT_E2E_ADMIN_EMAIL;

  if (reusableEmail) {
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(reusableEmail);
    await page.getByPlaceholder("••••••••").fill(
      process.env.PLANPILOT_E2E_ADMIN_PASSWORD ?? password
    );
    await page.getByRole("button", { name: "登录", exact: true }).click();
  } else {
    await page.goto("/register");
    await page.getByPlaceholder("2~32 个字符").fill(username);
    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByPlaceholder("至少 6 位").fill(password);
    await page.getByRole("button", { name: "注册", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/studio\/work/);

  if (!reusableEmail) {
    execFileSync(
      "docker",
      [
        "exec",
        "planpilot-postgres-1",
        "psql",
        "-U",
        "planpilot",
        "-d",
        "planpilot",
        "-c",
        `UPDATE users SET is_admin = true WHERE username = '${username}'`,
      ],
      { stdio: "pipe", timeout: 30_000 }
    );

    await page.evaluate(() => localStorage.removeItem("access_token"));
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByPlaceholder("••••••••").fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/work/);
  }

  await page.goto("/admin");
  await expect(page.getByText("内部管理后台", { exact: true })).toBeVisible();
  const adminCanvas = await page.locator(".pp-admin-main").evaluate(
    (element) => window.getComputedStyle(element).backgroundColor
  );
  expect(adminCanvas).toBe("rgb(243, 245, 248)");
  await expect(page.getByRole("heading", { name: "运营决策总览" })).toBeVisible();
  await expect(page.getByTestId("runtime-model-roles")).toBeVisible();
  await expect(page.getByTestId("runtime-model-roles").getByText("对话模型", { exact: true })).toBeVisible();
  await expect(page.getByTestId("runtime-model-roles").getByText("任务模型", { exact: true })).toBeVisible();
  await expect(page.getByTestId("runtime-model-roles").getByText("安全判断模型", { exact: true })).toBeVisible();
  await expect(page.getByTestId("runtime-model-roles").getByText("知识检索模型", { exact: true })).toBeVisible();
  await expect(page.getByTestId("production-canary-dashboard")).toHaveCount(0);

  await page.getByRole("link", { name: "灰度发布" }).click();
  await expect(page).toHaveURL(/\/admin\/canary$/);
  await expect(page.getByRole("heading", { name: "灰度发布管理" })).toBeVisible();
  await expect(page.getByTestId("production-canary-dashboard")).toBeVisible();
  await page.getByTestId("run-production-gate").click();
  await expect(page.getByText(/104\/104 个基准案例通过/)).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("create-canary").click();
  await expect(page.getByText(/发布状态：运行中 · 当前阶段：内部流量/)).toBeVisible({
    timeout: 30_000,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("rollback-canary").click();
  await expect(page.getByText(/发布状态：已回滚/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "实验与评估" }).click();
  await expect(page).toHaveURL(/\/admin\/experiments$/);
  await expect(page.getByRole("heading", { name: "实验与离线评估" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近离线评估" })).toBeVisible();

  await page.getByRole("link", { name: "模型网关" }).click();
  await expect(page).toHaveURL(/\/admin\/gateway$/);
  await expect(page.getByRole("heading", { name: "模型网关状态" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "分布式 Model Gateway" })).toBeVisible();
  await expect(page.getByText("Redis 分布式", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "调用审计" }).click();
  await expect(page).toHaveURL(/\/admin\/traces$/);
  await expect(page.getByRole("heading", { name: "Agent 调用审计" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近系统调用" })).toBeVisible();
});
