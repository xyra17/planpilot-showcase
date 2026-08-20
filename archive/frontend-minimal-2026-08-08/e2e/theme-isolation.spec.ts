import { expect, test } from "@playwright/test";

test.skip(
  process.env.PLANPILOT_E2E !== "1" || !process.env.PLANPILOT_E2E_EMAIL,
  "Requires a reusable real learner account"
);

test("四种界面风格使用独立配色和完整视觉变量", async ({ page }, testInfo) => {
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(process.env.PLANPILOT_E2E_EMAIL ?? "");
  await page.getByPlaceholder("••••••••").fill(
    process.env.PLANPILOT_E2E_PASSWORD ?? "PlanPilot-e2e-2026"
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/work/);
  await page.goto("/settings");

  const canvases = new Set<string>();
  const dangerTones = new Set<string>();
  const successTones = new Set<string>();
  const scenarios = [
    { mode: "default", palette: "blue", incompatible: "morandi-terracotta" },
    { mode: "dark", palette: "violet", incompatible: "blue" },
    { mode: "eye-care", palette: "morandi-terracotta", incompatible: "blue" },
    { mode: "journal", palette: "wood", incompatible: "morandi-terracotta" },
  ] as const;

  for (const scenario of scenarios) {
    await page.getByTestId(`theme-mode-${scenario.mode}`).click();
    await expect(page.getByTestId(`theme-palette-${scenario.palette}`)).toBeVisible();
    await expect(page.getByTestId(`theme-palette-${scenario.incompatible}`)).toHaveCount(0);
    await page.getByTestId(`theme-palette-${scenario.palette}`).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", scenario.mode);

    const canvas = await page.locator("html").evaluate((element) =>
      window.getComputedStyle(element).getPropertyValue("--theme-canvas").trim()
    );
    const semanticTones = await page.locator("html").evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        danger: style.getPropertyValue("--tone-danger-bg").trim(),
        success: style.getPropertyValue("--tone-success-bg").trim(),
      };
    });
    expect(canvas).not.toBe("");
    expect(semanticTones.danger).not.toBe("");
    expect(semanticTones.success).not.toBe("");
    canvases.add(canvas);
    dangerTones.add(semanticTones.danger);
    successTones.add(semanticTones.success);
    await page.screenshot({
      path: testInfo.outputPath(`theme-${scenario.mode}.png`),
      fullPage: true,
    });
  }

  expect(canvases.size).toBe(4);
  expect(dangerTones.size).toBe(4);
  expect(successTones.size).toBe(4);

  // Returning to Default restores its previous blue selection instead of the
  // violet selected for Dark.
  await page.getByTestId("theme-mode-default").click();
  await expect(page.locator("html")).toHaveAttribute("data-color", "blue");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  await expect(page.locator("html")).toHaveAttribute("data-color", "blue");

  await page.goto("/work/knowledge");
  await expect(page.getByRole("heading", { name: "资料空间", level: 1 })).toBeVisible();
  await expect(page.getByLabel("资料处理概览")).toBeVisible();
  await expect(page.locator("header").getByRole("button", { name: "新建知识库" })).toBeVisible();
  await page.getByRole("button", { name: /^全部资料/ }).click();
  await expect(page.getByRole("button", { name: "列表视图" })).toBeVisible();
  await expect(page.getByTestId("knowledge-filter-badge")).toBeVisible();
});
