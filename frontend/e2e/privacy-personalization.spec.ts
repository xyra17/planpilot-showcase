import { expect, test, type Page } from "@playwright/test";

const user = {
  id: "privacy-user", email: "privacy@example.com", username: "隐私测试", avatar_url: null,
  timezone: "Asia/Shanghai", weekly_availability: null, availability_windows: ["evening"], study_days: ["mon", "tue", "wed", "thu", "fri"],
  account_preferences: { study_preferences: { reminder_enabled: false, reminder_time: "21:30", reminder_channel: "email", reminder_email: null, focus_target: "90" } },
  email_verified: true, created_at: "2026-01-01T00:00:00Z",
};

type ConsentState = {
  personalization_enabled: boolean;
  experiments_enabled: boolean;
  product_analytics_enabled: boolean;
  sensitive_inference_enabled: boolean;
  policy_version: string;
  updated_at: string;
};

type PrivacyMock = {
  state: ConsentState;
  patches: Array<Record<string, unknown>>;
  getAttempts: number;
  patchAttempts: number;
};

async function openSettings(page: Page, options: { failInitialGet?: boolean; failInitialPatch?: boolean } = {}) {
  const mock: PrivacyMock = {
    state: { personalization_enabled: true, experiments_enabled: true, product_analytics_enabled: true, sensitive_inference_enabled: false, policy_version: "2026-08", updated_at: "2026-08-22T00:00:00Z" },
    patches: [], getAttempts: 0, patchAttempts: 0,
  };
  await page.addInitScript((cachedUser) => { localStorage.setItem("access_token", "privacy-token"); localStorage.setItem("user_info", JSON.stringify(cachedUser)); }, user);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ status: 200, json: user }));
  await page.route("**/api/v1/notifications/email-reminder-status", (route) => route.fulfill({ status: 200, json: { configured: true, recipient: user.email, email_verified: true, timezone: "Asia/Shanghai" } }));
  await page.route("**/api/v1/privacy/consent", async (route) => {
    if (route.request().method() === "PATCH") {
      mock.patchAttempts += 1;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      mock.patches.push(body);
      if (options.failInitialPatch && mock.patchAttempts === 1) {
        await route.fulfill({ status: 503, json: { detail: "隐私选择暂时无法保存" } });
        return;
      }
      for (const key of ["personalization_enabled", "experiments_enabled", "product_analytics_enabled", "sensitive_inference_enabled"] as const) {
        if (typeof body[key] === "boolean") mock.state[key] = body[key] as boolean;
      }
      mock.state.updated_at = "2026-08-22T01:00:00Z";
      await route.fulfill({ status: 200, json: { ...mock.state, derived_data_erased: body.erase_derived_data === true } });
      return;
    }
    mock.getAttempts += 1;
    if (options.failInitialGet && mock.getAttempts === 1) {
      await route.fulfill({ status: 503, json: { detail: "隐私选择暂时无法加载" } });
      return;
    }
    await route.fulfill({ status: 200, json: mock.state });
  });
  await page.route("**/api/v1/privacy/export", (route) => route.fulfill({ status: 200, headers: { "content-type": "application/json", "content-disposition": "attachment; filename=planpilot-data-export.json" }, body: JSON.stringify({ schema_version: "planpilot-user-export-v1", scope: { excluded: {} }, data: { goals: [], tasks: [] } }) }));
  await page.goto("/studio/settings#settings-privacy");
  await expect(page.locator("#settings-privacy:visible").last()).toBeVisible();
  return mock;
}

test("GET 初次加载失败后可执行重试", async ({ page }) => {
  const mock = await openSettings(page, { failInitialGet: true });
  const privacy = page.locator("#settings-privacy:visible").last();
  await expect(privacy.getByText("加载失败", { exact: true })).toBeVisible();
  await expect(privacy.getByText("隐私选择暂时无法加载", { exact: false })).toBeVisible();
  await privacy.getByRole("button", { name: "重试" }).click();
  await expect(privacy.getByRole("button", { name: "敏感推断：已关闭" })).toBeEnabled();
  expect(mock.getAttempts).toBe(2);
});

test("PATCH 保存失败后保留状态并可重试", async ({ page }) => {
  const mock = await openSettings(page, { failInitialPatch: true });
  const privacy = page.locator("#settings-privacy:visible").last();
  await privacy.getByRole("button", { name: "产品实验参与：已开启" }).click();
  await expect(privacy.getByText("保存失败", { exact: true })).toBeVisible();
  await expect(privacy.getByRole("button", { name: "产品实验参与：已开启" })).toBeVisible();
  await privacy.getByRole("button", { name: "重试" }).click();
  await expect(privacy.getByText("已保存", { exact: true })).toBeVisible();
  await expect(privacy.getByRole("button", { name: "产品实验参与：已关闭" })).toBeVisible();
  expect(mock.patchAttempts).toBe(2);
  expect(mock.state.product_analytics_enabled).toBe(true);
  expect(mock.state.sensitive_inference_enabled).toBe(false);
});

test("先仅关闭个性化，保持关闭状态后仍可清除已保留派生数据", async ({ page }) => {
  const mock = await openSettings(page);
  const privacy = page.locator("#settings-privacy:visible").last();
  await privacy.getByRole("button", { name: "个性化建议：已开启" }).click();
  await privacy.getByRole("button", { name: "仅关闭" }).click();
  await expect(privacy.getByRole("button", { name: "个性化建议：已关闭" })).toBeVisible();
  expect(mock.state.experiments_enabled).toBe(true);
  expect(mock.state.product_analytics_enabled).toBe(true);
  await privacy.getByText("数据导出与清除", { exact: true }).click();
  await privacy.getByRole("button", { name: "清除已保留的派生数据" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("目标、任务、笔记和知识内容不会删除");
  await dialog.getByRole("button", { name: "清除已保留数据" }).click();
  await expect.poll(() => mock.patches.some((body) => body.personalization_enabled === false && body.erase_derived_data === true)).toBe(true);
  await expect(privacy.getByRole("button", { name: "个性化建议：已关闭" })).toBeVisible();
});

test("服务器可携带数据导出与本机缓存范围文案准确", async ({ page }) => {
  await openSettings(page);
  const privacy = page.locator("#settings-privacy:visible").last();
  await privacy.getByText("数据导出与清除", { exact: true }).click();
  await expect(privacy.getByText("不代表服务器端完整学习数据", { exact: false })).toBeVisible();
  await expect(privacy.getByText("不包含密码或令牌", { exact: false })).toBeVisible();
  const download = page.waitForEvent("download");
  await privacy.getByRole("button", { name: "导出服务器数据" }).click();
  await expect((await download).suggestedFilename()).toBe("planpilot-data-export.json");
});

test("隐私设置使用紧凑层级与完整开关视觉", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);
  const privacy = page.locator("#settings-privacy:visible").last();
  const header = await privacy.locator(".privacy-section-header").boundingBox();
  const icon = await privacy.locator(".privacy-section-icon").boundingBox();
  const status = await privacy.locator(".privacy-save-state").boundingBox();
  expect(header?.height).toBeLessThan(90);
  expect(icon?.width).toBeLessThanOrEqual(40);
  expect(status?.height).toBeLessThanOrEqual(30);
  const toggles = await privacy.locator(".privacy-toggle").evaluateAll((elements) => elements.map((element) => {
    const button = element as HTMLElement;
    const rect = button.getBoundingClientRect();
    const track = getComputedStyle(button, "::before");
    const thumb = button.querySelector("i")?.getBoundingClientRect();
    return { width: rect.width, height: rect.height, trackWidth: track.width, trackRadius: track.borderRadius, thumbWidth: thumb?.width ?? 0 };
  }));
  expect(toggles).toHaveLength(4);
  expect(toggles.every(({ width, height, trackWidth, trackRadius, thumbWidth }) => width === 52 && height >= 44 && trackWidth === "36px" && trackRadius === "999px" && thumbWidth === 14)).toBe(true);
});

test("账户区移除重复隐私入口并垂直对齐操作按钮", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSettings(page);
  const account = page.locator("#settings-account:visible").last();
  await expect(account.getByText("学习数据与隐私", { exact: true })).toHaveCount(0);
  await expect(account.getByRole("link", { name: "前往管理" })).toHaveCount(0);
  const actions = account.locator(".account-action-button");
  const visuals = account.locator(".account-action-visual");
  await expect(actions).toHaveCount(4);
  const desktopGeometry = await actions.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    const row = element.closest(".settings-avatar-row, .setting-row-grid")?.getBoundingClientRect();
    return { width: rect.width, height: rect.height, right: rect.right, centerOffset: row ? Math.abs((rect.top + rect.height / 2) - (row.top + row.height / 2)) : 999 };
  }));
  expect(desktopGeometry.every(({ width, height, centerOffset }) => width === 112 && height >= 44 && centerOffset <= 1)).toBe(true);
  expect(Math.max(...desktopGeometry.map(({ right }) => right)) - Math.min(...desktopGeometry.map(({ right }) => right))).toBeLessThanOrEqual(1);
  const desktopVisualGeometry = await visuals.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  expect(desktopVisualGeometry.every(({ width, height }) => width === 104 && height === 36)).toBe(true);
  const editColor = await account.getByRole("button", { name: "编辑", exact: true }).evaluate((element) => getComputedStyle(element).color);
  const exitColor = await account.getByRole("button", { name: "退出", exact: true }).evaluate((element) => getComputedStyle(element).color);
  expect(exitColor).not.toBe(editColor);

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileMetrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.innerWidth);
  const mobileRightEdges = await actions.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, right: rect.right };
  }));
  expect(mobileRightEdges.every(({ width }) => width === 104)).toBe(true);
  expect(Math.max(...mobileRightEdges.map(({ right }) => right)) - Math.min(...mobileRightEdges.map(({ right }) => right))).toBeLessThanOrEqual(1);
  const mobileVisualWidths = await visuals.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
  expect(mobileVisualWidths.every((width) => width === 96)).toBe(true);
});

test("隐私设置在 375px 无横向滚动且触控目标达标", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openSettings(page);
  const privacy = page.locator("#settings-privacy:visible").last();
  const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
  const heights = await privacy.locator(".privacy-purpose-row .privacy-toggle").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(heights.every((height) => height >= 44)).toBe(true);
});
