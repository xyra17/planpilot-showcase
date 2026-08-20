import { expect, test } from "@playwright/test";

test("登录页在常见笔记本高度下一屏完整显示", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expect(page.getByLabel("用户名或邮箱")).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "显示密码" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "记住登录状态（30 天）" })).toBeVisible();
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "忘记密码？" })).toBeVisible();
  await expect(page.getByRole("link", { name: "注册", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "《用户协议》" })).toBeVisible();
  await expect(page.getByRole("link", { name: "《隐私政策》" })).toBeVisible();

  const viewport = await page.evaluate(() => ({
    height: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.height);
});

test("登录表单提供字段错误与密码显隐状态", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "登录", exact: true }).click();

  await expect(page.getByText("请输入用户名或邮箱", { exact: true })).toBeVisible();
  await expect(page.getByText("请输入密码", { exact: true })).toBeVisible();

  const password = page.getByLabel("密码", { exact: true });
  await password.fill("secret123");
  await page.getByRole("button", { name: "显示密码" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "隐藏密码" })).toBeVisible();
});

test("登录页区分凭据错误、网络失败与账户锁定", async ({ page }) => {
  const submit = async () => {
    await page.getByLabel("用户名或邮箱").fill("learner");
    await page.getByLabel("密码", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
  };

  await page.route("**/api/v1/auth/login", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "账号或密码错误" }) });
  });
  await page.goto("/login");
  await submit();
  await expect(page.locator(".pp-auth-status")).toContainText("账号或密码错误");

  await page.unroute("**/api/v1/auth/login");
  await page.route("**/api/v1/auth/login", async (route) => route.abort("failed"));
  await page.getByLabel("密码", { exact: true }).fill("retry-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".pp-auth-status")).toContainText("服务器暂时无法连接");

  await page.unroute("**/api/v1/auth/login");
  await page.route("**/api/v1/auth/login", async (route) => {
    await route.fulfill({ status: 423, contentType: "application/json", body: JSON.stringify({ detail: "账户已锁定，请联系管理员" }) });
  });
  await page.getByLabel("密码", { exact: true }).fill("locked-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".pp-auth-status")).toContainText("账户已锁定");

  await page.unroute("**/api/v1/auth/login");
  await page.route("**/api/v1/auth/login", async (route) => {
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ detail: "请求来源不受信任" }) });
  });
  await page.getByLabel("密码", { exact: true }).fill("security-retry-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".pp-auth-status")).toContainText("安全校验");
  await expect(page.locator(".pp-auth-status")).not.toContainText("账户已锁定");

  await page.unroute("**/api/v1/auth/login");
  await page.route("**/api/v1/auth/login", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "服务暂时不可用，请稍后重试" }) });
  });
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".pp-auth-status")).toContainText("服务暂时不可用");
});

test("登录页展示登录中和登录成功，且不向 Web Storage 暴露令牌", async ({ page }) => {
  const user = { id: "e2e-user", email: "learner@example.com", username: "learner", ui_experience: "minimal" };
  await page.route("**/api/v1/auth/login", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user,
      }),
    });
  });
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: user }));
  await page.goto("/login");
  await page.getByLabel("用户名或邮箱").fill("learner");
  await page.getByLabel("密码", { exact: true }).fill("correct-password");
  await page.getByRole("checkbox", { name: "记住登录状态（30 天）" }).check();
  await page.getByRole("button", { name: "登录", exact: true }).click();

  await expect(page.getByRole("button", { name: "登录中…" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("登录成功");
  await expect(page).toHaveURL(/\/studio\/work/);
  expect(await page.evaluate(() => localStorage.getItem("access_token"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("user_info"))).toContain("learner");
  expect(await page.evaluate(() => sessionStorage.getItem("access_token"))).toBeNull();
});

test("未勾选记住登录状态时仍不向 JavaScript 暴露令牌", async ({ page }) => {
  const user = { id: "session-user", email: "session@example.com", username: "session-user", ui_experience: "minimal" };
  await page.route("**/api/v1/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user,
      }),
    });
  });
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: user }));
  await page.goto("/login");
  await page.getByLabel("用户名或邮箱").fill("session-user");
  await page.getByLabel("密码", { exact: true }).fill("correct-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("登录成功");
  await expect(page).toHaveURL(/\/studio\/work/);
  expect(await page.evaluate(() => localStorage.getItem("access_token"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("user_info"))).toContain("session-user");
  expect(await page.evaluate(() => sessionStorage.getItem("access_token"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("user_info"))).toBeNull();
});
