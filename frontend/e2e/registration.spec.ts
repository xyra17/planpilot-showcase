import { expect, test } from "@playwright/test";

test("注册页包含全部核心组件并支持 /auth/register", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto("/auth/register");

  await expect(page).toHaveURL(/\/auth\/register$/);
  await expect(page.getByRole("heading", { name: "创建账户" })).toBeVisible();
  await expect(page.getByLabel("用户名")).toBeVisible();
  await expect(page.getByLabel("邮箱")).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "密码强度" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /我已阅读并同意/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "注册", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();

  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.height);
});

test("注册页校验密码强度和协议确认", async ({ page }) => {
  await page.goto("/auth/register");
  await page.getByLabel("用户名").fill("learner");
  await page.getByLabel("邮箱").fill("learner@example.com");
  await page.getByLabel("密码", { exact: true }).fill("weak");
  await expect(page.getByText("密码强度：较弱")).toBeVisible();
  await page.getByRole("button", { name: "注册", exact: true }).click();

  await expect(page.getByText("密码至少 8 位，并同时包含字母和数字", { exact: true })).toBeVisible();
  await expect(page.getByText("请先阅读并同意用户协议和隐私政策", { exact: true })).toBeVisible();

  await page.getByLabel("密码", { exact: true }).fill("StrongPass123!");
  await expect(page.getByText("密码强度：较强")).toBeVisible();
  await page.getByRole("checkbox", { name: /我已阅读并同意/ }).check();
});

test("注册页区分邮箱已存在和网络失败", async ({ page }) => {
  const fillForm = async (password: string) => {
    await page.getByLabel("用户名").fill("learner");
    await page.getByLabel("邮箱").fill("learner@example.com");
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("checkbox", { name: /我已阅读并同意/ }).check();
  };

  await page.route("**/api/v1/auth/register", async (route) => {
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ detail: "该邮箱已被注册" }) });
  });
  await page.goto("/auth/register");
  await fillForm("StrongPass123!");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.locator(".pp-auth-status")).toContainText("该邮箱已存在");

  await page.unroute("**/api/v1/auth/register");
  await page.route("**/api/v1/auth/register", async (route) => route.abort("failed"));
  await page.getByLabel("邮箱").fill("another@example.com");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.locator(".pp-auth-status")).toContainText("网络连接失败");
});

test("注册页展示注册中、验证邮件已发送和注册成功", async ({ page }) => {
  await page.route("**/api/v1/auth/register", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "new-user", username: "learner", email: "learner@example.com", email_verified: false },
        email_verification_required: true,
        verification_email_sent: true,
      }),
    });
  });
  await page.goto("/auth/register");
  await page.getByLabel("用户名").fill("learner");
  await page.getByLabel("邮箱").fill("learner@example.com");
  await page.getByLabel("密码", { exact: true }).fill("StrongPass123!");
  await page.getByRole("checkbox", { name: /我已阅读并同意/ }).check();
  await page.getByRole("button", { name: "注册", exact: true }).click();

  await expect(page.getByRole("button", { name: "注册中…" })).toBeDisabled();
  await expect(page.getByText("验证邮件已发送", { exact: true })).toBeVisible();
  await expect(page.getByText(/注册成功，验证邮件已发送至/)).toBeVisible();
  await expect(page.getByRole("link", { name: "继续完成设置" })).toBeVisible();
});

test("邮箱验证页反馈验证成功", async ({ page }) => {
  await page.route("**/api/v1/auth/verify-email", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "邮箱验证成功" }) });
  });
  await page.goto("/verify-email?token=test-verification-token-1234567890");
  await expect(page.getByRole("heading", { name: "邮箱验证成功" })).toBeVisible();
  await expect(page.getByRole("link", { name: "继续完成设置" })).toBeVisible();
});
