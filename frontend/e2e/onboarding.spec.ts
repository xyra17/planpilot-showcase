import { expect, test } from "@playwright/test";

const user = {
  id: "user-onboarding",
  email: "learner@example.com",
  username: "学习者",
  email_verified: true,
  timezone: "Asia/Shanghai",
  language: "zh-CN",
  week_start: "monday",
  study_days: ["mon", "tue", "wed", "thu", "fri"],
  availability_windows: ["evening"],
  ui_experience: "technology",
  ui_theme: "base",
  ui_accent: "violet",
  font_density: "comfortable",
  preferred_start_method: "create_goal",
  onboarding_completed: false,
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript((cachedUser) => {
    window.localStorage.setItem("user_info", JSON.stringify(cachedUser));
  }, user);
  await page.route("**/api/v1/auth/me", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      await route.fulfill({ json: { ...user, ...body } });
      return;
    }
    await route.fulfill({ json: user });
  });
});

test("呈现四步三栏设置与实时预览", async ({ page }) => {
  await page.goto("/onboarding");

  await expect(page.getByRole("navigation")).toContainText("基础偏好");
  await expect(page.getByRole("navigation")).toContainText("学习节奏");
  await expect(page.getByRole("navigation")).toContainText("外观细节");
  await expect(page.getByRole("navigation")).toContainText("开始方式");
  await expect(page.getByLabel("实时工作台预览")).toContainText("科技工作台");

  await page.getByRole("button", { name: "外观细节" }).click();
  await page.getByRole("button", { name: /深色/ }).click();
  await page.getByRole("button", { name: "生长绿" }).click();
  await page.getByRole("button", { name: "宽松" }).click();
  await expect(page.getByText("让工作台更像你的空间")).toBeVisible();
});

test("其他开始方式不会取代创建目标主行动", async ({ page }) => {
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "开始方式" }).click();
  await page.getByRole("button", { name: /导入课程或学习计划/ }).click();

  await expect(page.getByRole("button", { name: "创建第一个目标", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "导入课程或学习计划", exact: true })).toBeVisible();

  const patchRequest = page.waitForRequest((request) =>
    request.url().includes("/api/v1/auth/me") && request.method() === "PATCH",
  );
  await page.getByRole("button", { name: "创建第一个目标", exact: true }).click();
  const savedPayload = (await patchRequest).postDataJSON();
  await expect(page).toHaveURL(/\/studio\/work\/goals\?create=1/);
  expect(savedPayload).toMatchObject({
    preferred_start_method: "import_plan",
    onboarding_completed: true,
    study_days: ["mon", "tue", "wed", "thu", "fri"],
  });
});
