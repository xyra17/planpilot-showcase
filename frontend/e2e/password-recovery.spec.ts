import { expect, test } from "@playwright/test";

test("找回密码页包含邮箱阶段并兼容旧地址", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto("/forgot-password");

  await expect(page).toHaveURL(/\/auth\/recover$/);
  await expect(page.getByRole("heading", { name: "找回密码" })).toBeVisible();
  await expect(page.getByLabel("邮箱")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送重置邮件" })).toBeVisible();
  await expect(page.getByRole("link", { name: /返回登录/ })).toBeVisible();

  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.height);
});

test("找回密码页展示发送中和邮件已发送", async ({ page }) => {
  await page.route("**/api/v1/auth/forgot-password", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: "如果该邮箱已注册且可用，重置链接已发送至邮箱",
        delivery_available: true,
      }),
    });
  });
  await page.goto("/auth/recover");
  await page.getByLabel("邮箱").fill("learner@example.com");
  await page.getByRole("button", { name: "发送重置邮件" }).click();
  await expect(page.getByRole("button", { name: "发送中…" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "邮件已发送" })).toBeVisible();
  await expect(page.getByText("请检查你的邮箱", { exact: true })).toBeVisible();
});

test("找回密码页区分邮箱不可用和发送过于频繁", async ({ page }) => {
  await page.route("**/api/v1/auth/forgot-password", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "无法发送", delivery_available: false }),
    });
  });
  await page.goto("/auth/recover");
  await page.getByLabel("邮箱").fill("unavailable@example.com");
  await page.getByRole("button", { name: "发送重置邮件" }).click();
  await expect(page.locator(".pp-auth-status")).toContainText("邮箱不存在或当前邮件服务不可用");

  await page.unroute("**/api/v1/auth/forgot-password");
  await page.route("**/api/v1/auth/forgot-password", async (route) => {
    await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ detail: "Rate limit exceeded" }) });
  });
  await page.getByLabel("邮箱").fill("retry@example.com");
  await page.getByRole("button", { name: "发送重置邮件" }).click();
  await expect(page.locator(".pp-auth-status")).toContainText("发送过于频繁");
});

test("找回密码页区分无效链接和失效链接", async ({ page }) => {
  await page.route("**/api/v1/auth/reset-password/validate?**", async (route) => {
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ detail: "链接无效，请重新申请" }) });
  });
  await page.goto("/auth/recover?token=invalid-token");
  await expect(page.getByText("链接无效", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新申请" })).toBeVisible();

  await page.unroute("**/api/v1/auth/reset-password/validate?**");
  await page.route("**/api/v1/auth/reset-password/validate?**", async (route) => {
    await route.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({ detail: "链接已失效，请重新申请" }) });
  });
  await page.goto("/auth/recover?token=expired-token");
  await expect(page.getByText("链接已失效", { exact: true })).toBeVisible();
});

test("找回密码页校验密码一致并展示重置成功", async ({ page }) => {
  await page.route("**/api/v1/auth/reset-password/validate?**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "valid" }) });
  });
  await page.route("**/api/v1/auth/reset-password", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "密码已重置，请重新登录" }) });
  });
  await page.goto("/auth/recover?token=valid-reset-token");
  await expect(page.getByRole("heading", { name: "设置新密码" })).toBeVisible();
  await page.getByLabel("新密码", { exact: true }).fill("NewPassword123!");
  await page.getByLabel("确认新密码", { exact: true }).fill("DifferentPassword123!");
  await page.getByRole("button", { name: "确认重置" }).click();
  await expect(page.locator(".pp-auth-status")).toContainText("两次输入的密码不一致");

  await page.getByLabel("确认新密码", { exact: true }).fill("NewPassword123!");
  await page.getByRole("button", { name: "确认重置" }).click();
  await expect(page.getByRole("button", { name: "重置中…" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "重置成功" })).toBeVisible();
  await expect(page.getByText("密码重置成功", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "使用新密码登录" })).toBeVisible();
});
