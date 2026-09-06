import { expect, test, type Page } from "@playwright/test";

const user = {
  id: "workspace-user",
  email: "workspace@example.com",
  username: "空间测试",
  email_verified: true,
  onboarding_completed: true,
  timezone: "Asia/Shanghai",
  weekly_availability: null,
  availability_windows: ["evening"],
  study_days: ["mon", "tue", "wed", "thu", "fri"],
  account_preferences: { study_preferences: { reminder_enabled: false, reminder_time: "21:30", reminder_channel: "email", reminder_email: null, focus_target: "90" } },
};

async function mockSettingsShell(page: Page) {
  await page.addInitScript((cachedUser) => {
    localStorage.setItem("user_info", JSON.stringify(cachedUser));
    Object.defineProperty(window, "planpilotDesktop", { value: {
      getEnvironment: async () => ({ isDesktop: true, appVersion: "0.1.0-beta.2", installationId: "desktop-current-123", deviceName: "当前 Mac", platform: "darwin" }),
      getModelPreferences: async () => ({ modelDirectory: "", selectedModel: "", models: [] }),
      chooseModelDirectory: async () => null,
      selectModel: async () => ({ modelDirectory: "", selectedModel: "", models: [] }),
      downloadModel: async () => ({ modelDirectory: "", selectedModel: "", models: [] }),
      onModelDownloadProgress: () => () => undefined,
      getPrivateSpacePreferences: async () => ({ privateSpaceDirectory: "", privateSpaceId: "", recoveredFrom: null }),
      preparePrivateSpace: async () => null,
      createPrivateSpaceBackup: async () => null,
      restorePrivateSpaceBackup: async () => null,
    }, configurable: true });
  }, user);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: user }));
  await page.route("**/api/v1/privacy/consent", (route) => route.fulfill({ json: {
    personalization_enabled: true,
    experiments_enabled: false,
    product_analytics_enabled: true,
    sensitive_inference_enabled: false,
    policy_version: "2026-08",
    updated_at: "2026-09-06T00:00:00Z",
  } }));
  await page.route("**/api/v1/notifications/email-reminder-status", (route) => route.fulfill({ json: { configured: false, recipient: user.email, email_verified: true, timezone: user.timezone } }));
}

test("空间与设备逐条展示冲突，并在确认后保留双方", async ({ page }) => {
  await mockSettingsShell(page);
  const devices = [
    { id: "device-current", installation_id: "desktop-current-123", name: "当前 Mac", platform: "darwin", app_version: "0.1.0-beta.2", last_seen_at: "2026-09-06T08:00:00Z", revoked_at: null },
    { id: "device-old", installation_id: "desktop-old-456", name: "旧 MacBook", platform: "darwin", app_version: "0.1.0-beta.1", last_seen_at: "2026-08-30T08:00:00Z", revoked_at: null },
  ];
  const conflict = {
    id: "conflict-1",
    operation_id: "operation-conflict-123",
    operation_type: "update",
    entity_type: "goal",
    entity_id: "goal-1",
    base_version: 2,
    server_version: 3,
    local_snapshot: { title: "本机标题", version: 2 },
    server_snapshot: { title: "服务器标题", version: 3 },
    status: "conflict",
    created_at: "2026-09-06T08:00:00Z",
  };
  let revoked = false;
  let resolution = "";
  await page.route("**/api/v1/devices/current", (route) => route.fulfill({ json: devices[0] }));
  await page.route("**/api/v1/workspaces", (route) => route.fulfill({ json: [{ id: "workspace-1", name: "我的学习空间", kind: "cloud", is_default: true, version: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-09-06T00:00:00Z" }] }));
  await page.route("**/api/v1/devices", (route) => route.fulfill({ json: devices }));
  await page.route("**/api/v1/devices/device-old", (route) => {
    revoked = true;
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/v1/sync/operations?status=conflict", (route) => route.fulfill({ json: { items: [conflict] } }));
  await page.route("**/api/v1/sync/operations/operation-conflict-123/resolve", (route) => {
    resolution = (route.request().postDataJSON() as { action: string }).action;
    return route.fulfill({ json: { ...conflict, status: "ready_copy", resolution } });
  });

  await page.goto("/studio/settings#settings-spaces");
  const card = page.locator("#settings-spaces:visible").last();
  await expect(card.getByRole("heading", { name: "空间与设备" })).toBeVisible();
  await expect(card).toContainText("我的学习空间");
  await expect(card).toContainText("多空间与团队空间尚未开放");
  await expect(card.getByText("当前设备", { exact: true })).toBeVisible();
  await expect(card.getByText("本机标题", { exact: false })).toBeVisible();
  await expect(card.getByText("服务器标题", { exact: false })).toBeVisible();

  await card.getByRole("button", { name: "撤销", exact: true }).click();
  const revokeDialog = page.getByRole("alertdialog", { name: "撤销“旧 MacBook”的同步权限？" });
  await expect(revokeDialog).toContainText("不会远程删除设备上的本地文件");
  await revokeDialog.getByRole("button", { name: "确认撤销" }).click();
  await expect.poll(() => revoked).toBe(true);
  await expect(card.getByText("已撤销", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "保留两份", exact: true }).click();
  const conflictDialog = page.getByRole("alertdialog", { name: "保留服务器版本和本机副本？" });
  await expect(conflictDialog).toContainText("不会覆盖服务器版本");
  await conflictDialog.getByRole("button", { name: "确认保留两份" }).click();
  await expect.poll(() => resolution).toBe("keep_both");
  await expect(card.getByText("没有待确认冲突", { exact: true })).toBeVisible();
  await expect(card).toContainText("本机版本进入待创建副本队列");
});

test("空间与设备在 375px 保持单列且不产生横向滚动", async ({ page }) => {
  await mockSettingsShell(page);
  await page.route("**/api/v1/devices/current", (route) => route.fulfill({ json: { id: "device-current", installation_id: "desktop-current-123", name: "当前 Mac", platform: "darwin", app_version: "0.1.0-beta.2", last_seen_at: "2026-09-06T08:00:00Z", revoked_at: null } }));
  await page.route("**/api/v1/workspaces", (route) => route.fulfill({ json: [{ id: "workspace-1", name: "我的学习空间", kind: "cloud", is_default: true, version: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-09-06T00:00:00Z" }] }));
  await page.route("**/api/v1/devices", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/sync/operations?status=conflict", (route) => route.fulfill({ json: { items: [] } }));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/studio/settings#settings-spaces");
  const card = page.locator("#settings-spaces:visible").last();
  await expect(card).toBeVisible();
  const [box, metrics] = await Promise.all([
    card.boundingBox(),
    page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })),
  ]);
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
});
