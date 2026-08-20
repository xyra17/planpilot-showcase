import { expect, test } from "@playwright/test";

const liveAuthEnabled = process.env.PLANPILOT_LIVE_AUTH === "1";

test("真实浏览器会话使用 HttpOnly Cookie、CSRF 且不暴露 JWT", async ({ page, context }) => {
  test.skip(!liveAuthEnabled, "仅在连接当前 PlanPilot API 时运行");
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const username = `e2e_${suffix}`;
  const email = `${username}@example.com`;

  await page.goto("/register");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码", { exact: true }).fill("LiveSession123!");
  await page.getByRole("checkbox", { name: /我已阅读并同意/ }).check();
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByText(/注册成功/).first()).toBeVisible();

  const cookies = await context.cookies();
  const access = cookies.find((cookie) => cookie.name === "pp_access");
  const refresh = cookies.find((cookie) => cookie.name === "pp_refresh");
  const csrf = cookies.find((cookie) => cookie.name === "pp_csrf");
  expect(access).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  expect(refresh).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/api/v1/auth" });
  expect(csrf).toMatchObject({ httpOnly: false, sameSite: "Lax" });
  expect(await page.evaluate(() => localStorage.getItem("access_token"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("access_token"))).toBeNull();

  let csrfValue = csrf?.value;
  expect(csrfValue).toBeTruthy();
  const rejected = await page.evaluate(async () => {
    const response = await fetch("http://localhost:8000/api/v1/auth/me", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "zh-CN" }),
    });
    return response.status;
  });
  expect(rejected).toBe(403);

  const accepted = await page.evaluate(async (token) => {
    const response = await fetch("http://localhost:8000/api/v1/auth/me", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ language: "zh-CN" }),
    });
    return response.status;
  }, csrfValue as string);
  expect(accepted).toBe(200);

  await context.clearCookies({ name: "pp_access" });
  const refreshResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/auth/refresh"),
  );
  await page.goto("/studio/work");
  expect((await refreshResponse).status()).toBe(200);
  await expect(page).toHaveURL(/\/studio\/work/);
  const refreshedCookies = await context.cookies();
  expect(refreshedCookies.find((cookie) => cookie.name === "pp_access")?.httpOnly).toBe(true);
  csrfValue = refreshedCookies.find((cookie) => cookie.name === "pp_csrf")?.value;
  expect(csrfValue).toBeTruthy();

  const deleted = await page.evaluate(async (token) => {
    const response = await fetch("http://localhost:8000/api/v1/auth/me", {
      method: "DELETE",
      credentials: "include",
      headers: { "X-CSRF-Token": token },
    });
    return response.status;
  }, csrfValue as string);
  expect(deleted).toBe(204);
  expect((await context.cookies()).some((cookie) => cookie.name === "pp_access")).toBe(false);
});
