import { expect, test } from "@playwright/test";

async function chooseTheme(page: import("@playwright/test").Page, name: RegExp) {
  await page.goto("/studio/settings");
  await page.getByRole("button", { name }).click();
}

test("暗黑计划页复用原生概览结构且本周入口不溢出", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 660 });
  await chooseTheme(page, /暗黑模式/);
  await page.goto("/studio/work");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".theme-lead-tech")).toBeVisible();
  await expect(page.locator(".theme-lead-dark")).toHaveCount(0);
  await expect(page.locator(".rhythm-week-entry")).toHaveCSS("display", "flex");
  await expect(page.locator(".rhythm-week-entry")).toHaveCSS("white-space", "nowrap");

  const entryFits = await page.locator(".rhythm-week-entry").evaluate((entry) => {
    const button = entry.getBoundingClientRect();
    const panel = entry.closest(".rhythm-panel")!.getBoundingClientRect();
    return button.left >= panel.left && button.right <= panel.right;
  });
  expect(entryFits).toBe(true);
});

test("资料表在原生、暗黑和手帐主题中共享居中列布局", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 660 });

  for (const theme of [
    { name: /原生外观/, value: "default" },
    { name: /暗黑模式/, value: "dark" },
    { name: /手帐纸张/, value: "notebook" },
  ]) {
    await chooseTheme(page, theme.name);
    await page.goto("/studio/work/knowledge");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.value);

    const geometry = await page.locator(".knowledge-resource-table article").first().evaluate((row) => {
      const name = row.children[1] as HTMLElement;
      const goal = row.children[2] as HTMLElement;
      const goalTag = goal.querySelector("em")!;
      return {
        nameWidth: name.getBoundingClientRect().width,
        goalWidth: goal.getBoundingClientRect().width,
        nameAlignment: getComputedStyle(name).justifyContent,
        goalAlignment: getComputedStyle(goal).justifyContent,
        goalTagAlignment: getComputedStyle(goalTag).textAlign,
        goalTagBackground: getComputedStyle(goalTag).backgroundColor,
        goalTagShadow: getComputedStyle(goalTag).boxShadow,
      };
    });

    expect(geometry.nameWidth).toBeGreaterThan(geometry.goalWidth * 2);
    expect(geometry.nameAlignment).toBe("center");
    expect(geometry.goalAlignment).toBe("center");
    expect(geometry.goalTagAlignment).toBe("center");
    expect(geometry.goalTagBackground).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.goalTagShadow).toBe("none");
  }
});

test("暗黑笔记输入保持透明且登录页统一回到原生主题", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 660 });
  await chooseTheme(page, /暗黑模式/);
  await page.goto("/studio/work/notes");

  await expect(page.locator(".notes-search-input")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator(".note-title-input")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await page.goto("/studio/settings");
  await page.locator('a[href="/login"]').last().click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  await expect(page.locator("html")).toHaveAttribute("data-surface-theme", "base");
  await expect(page.locator(".pp-login-input-shell").first()).toHaveCSS("background-color", "rgba(255, 255, 255, 0.7)");
});
