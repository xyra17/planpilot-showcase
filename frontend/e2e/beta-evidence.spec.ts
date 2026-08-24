import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

test.skip(
  process.env.PLANPILOT_E2E !== "1",
  "Set PLANPILOT_E2E=1 when the real Docker backend and frontend are running"
);

test("管理员查看行动功能的试用控制、漏斗、安全底线与脱敏复核队列", async ({ page }) => {
  const unique = Date.now().toString();
  const username = `beta${unique}`.slice(0, 28);
  const email = `beta-${unique}@example.com`;
  const defaultPassword = "PlanPilot-beta-2026";
  const reusableEmail = process.env.PLANPILOT_E2E_ADMIN_EMAIL;
  const password = process.env.PLANPILOT_E2E_ADMIN_PASSWORD ?? defaultPassword;

  if (!reusableEmail) {
    await page.goto("/register");
    await page.getByPlaceholder("2～32 个字符").fill(username);
    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByPlaceholder("至少 8 位，包含字母和数字").fill(password);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await expect(page.getByText("验证邮件已发送", { exact: true })).toBeVisible();

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
  }

  await page.context().clearCookies();
  await page.goto("/login");
  await page.evaluate(() => localStorage.removeItem("access_token"));
  await page.getByPlaceholder("请输入用户名或邮箱").fill(reusableEmail ?? email);
  await page.getByPlaceholder("请输入密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/(studio\/work|onboarding)/);

  await page.goto("/admin/beta");
  await expect(page.getByRole("heading", { name: "行动功能验证" })).toBeVisible();
  await expect(page.getByTestId("action-beta-evidence")).toBeVisible();
  await expect(page.getByText("试用范围与安全开关")).toBeVisible();
  await expect(page.getByText("统一行动漏斗")).toBeVisible();
  await expect(page.getByText("安全底线")).toBeVisible();
  await expect(page.getByText("真实样本复核队列")).toBeVisible();
  await expect(page.getByText("功能已经可以试用，但真实效果样本还不够，暂时不能下结论。")).toBeVisible();
  await expect(page.getByRole("button", { name: "试用组（默认）" })).toBeVisible();
  await expect(page.getByText("4650%", { exact: true })).toHaveCount(0);
  await expect(page.getByText("暂无数据", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("已观测清零", { exact: true })).toBeVisible();
  await expect(page.getByText(/运行门禁：已通过且有效/)).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/action-beta-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "行动功能验证" })).toBeVisible();
  await expect(page.getByText("试用范围与安全开关")).toBeVisible();
  await expect(page.getByTestId("action-beta-evidence")).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/action-beta-mobile-375.png", fullPage: true });
});
