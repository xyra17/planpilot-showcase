import { expect, test } from "@playwright/test";

test("browser explains that local storage controls belong to Desktop", async ({ page }) => {
  await page.goto("/studio/settings#settings-desktop");
  const section = page.locator("#settings-desktop:visible").last();
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: "桌面端与本机能力" })).toBeVisible();
  await expect(section).toContainText("当前正在浏览器中使用");
  await expect(section.getByRole("button", { name: "选择目录" })).toHaveCount(0);
});

test("desktop settings section remains readable at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/studio/settings#settings-desktop");
  const section = page.locator("#settings-desktop:visible").last();
  await expect(section).toBeVisible();
  const box = await section.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
});
