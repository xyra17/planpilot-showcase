import path from "node:path";
import { expect, test } from "@playwright/test";

const user = {
  id: "avatar-user",
  email: "avatar@example.com",
  username: "头像测试",
  avatar_url: null,
  timezone: "Asia/Shanghai",
  language: "zh-CN",
  week_start: "monday",
  study_days: ["mon", "tue", "wed", "thu", "fri"],
  availability_windows: ["evening"],
  account_preferences: { study_preferences: { reminder_enabled: true, focus_target: "90", weekend_intensity: "light" } },
  created_at: "2026-01-01T00:00:00Z",
};

test("lets the user crop, zoom and confirm an avatar before upload", async ({ page }, testInfo) => {
  let uploadCount = 0;
  let uploadedBody = "";

  await page.addInitScript((cachedUser) => {
    window.localStorage.setItem("access_token", "avatar-e2e-token");
    window.localStorage.setItem("user_info", JSON.stringify(cachedUser));
  }, user);
  await page.route("**/api/v1/auth/me/avatar", async (route) => {
    uploadCount += 1;
    uploadedBody = route.request().postDataBuffer()?.toString("latin1") ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...user, avatar_url: "/media/avatars/avatar-e2e.webp" }),
    });
  });
  await page.route("**/api/v1/auth/me", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) });
  });

  await page.goto("/studio/settings");
  const uploadInput = page.locator(".settings-avatar-input");
  await uploadInput.setInputFiles(path.resolve("public/designs/planpilot-settings-page.png"));

  const cropDialog = page.getByRole("dialog", { name: "调整头像" });
  await expect(cropDialog).toBeVisible();
  await expect(cropDialog).toContainText("圆形区域就是最终显示范围");
  await expect.poll(() => uploadCount).toBe(0);

  const cropStage = cropDialog.getByRole("application", { name: /头像裁剪区域/ });
  await expect(cropStage).toBeVisible();
  await expect(cropDialog.getByRole("button", { name: "保存头像" })).toBeEnabled();
  const initialTransform = await cropStage.locator("img").evaluate((image) => getComputedStyle(image).transform);
  const bounds = await cropStage.boundingBox();
  if (!bounds) throw new Error("crop stage is not visible");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 34, bounds.y + bounds.height / 2 + 12, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => cropStage.locator("img").evaluate((image) => getComputedStyle(image).transform)).not.toBe(initialTransform);

  const zoom = cropDialog.getByRole("slider", { name: "头像缩放" });
  await zoom.fill("1.5");
  await expect(cropDialog.getByText("150%", { exact: true })).toBeVisible();
  await cropStage.focus();
  await cropStage.press("ArrowLeft");
  await testInfo.attach("avatar-crop-desktop", { body: await cropDialog.screenshot({ animations: "disabled" }), contentType: "image/png" });

  await cropDialog.getByRole("button", { name: "保存头像" }).click();
  await expect.poll(() => uploadCount).toBe(1);
  expect(uploadedBody).toContain("image/webp");
  expect(uploadedBody).toContain("-cropped.webp");
  await expect(cropDialog).toBeHidden();
  await expect(page.locator(".settings-toast")).toContainText("头像已更新，并同步到账号");
});

test("keeps the avatar cropper usable at 375px", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript((cachedUser) => {
    window.localStorage.setItem("access_token", "avatar-mobile-token");
    window.localStorage.setItem("user_info", JSON.stringify(cachedUser));
  }, user);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) }));
  await page.goto("/studio/settings");
  await page.locator(".settings-avatar-input").setInputFiles(path.resolve("public/designs/planpilot-settings-page.png"));
  const cropDialog = page.getByRole("dialog", { name: "调整头像" });
  await expect(cropDialog).toBeVisible();
  const bounds = await cropDialog.boundingBox();
  expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
  expect(bounds?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(667);
  await expect(cropDialog.getByRole("button", { name: "保存头像" })).toBeVisible();
  await expect(cropDialog.getByRole("button", { name: "重选照片" })).toBeVisible();
  await testInfo.attach("avatar-crop-mobile", { body: await cropDialog.screenshot({ animations: "disabled" }), contentType: "image/png" });
});

test("falls back to the account initial when a stored avatar file is unavailable", async ({ page }) => {
  const userWithMissingAvatar = {
    ...user,
    avatar_url: "/media/avatars/avatar-missing.webp",
  };
  await page.addInitScript((cachedUser) => {
    window.localStorage.setItem("access_token", "avatar-missing-token");
    window.localStorage.setItem("user_info", JSON.stringify(cachedUser));
  }, userWithMissingAvatar);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(userWithMissingAvatar),
  }));
  await page.route("**/media/avatars/avatar-missing.webp", (route) => route.fulfill({ status: 404 }));

  await page.goto("/studio/settings");
  const avatar = page.locator("#settings-account .settings-avatar-preview .user-avatar");
  await expect(avatar).toHaveAttribute("data-avatar-state", "unavailable");
  await expect(avatar.locator("img")).toHaveCount(0);
  await expect(avatar).toContainText("头");
});
