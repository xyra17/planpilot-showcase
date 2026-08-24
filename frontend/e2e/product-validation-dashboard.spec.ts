import { expect, test, type Page } from "@playwright/test";

const report = {
  snapshot_id: "snapshot-1",
  schema_version: "product-validation-v2",
  status: "insufficient_data",
  generated_at: "2026-08-24T10:00:00Z",
  consented_user_count: 86,
  metrics: {
    survey_count: 18,
    very_disappointed_rate: 0.44,
    goal_creation_10m_cohort: 58,
    goal_created_10m_rate: 0.62,
    activation_cohort: 51,
    first_task_started_24h_rate: 0.71,
    activation_24h_rate: 0.49,
    first_action_evidence_rate: 0.43,
    first_action_evidence_cohort: 23,
    week4_wvlu_cohort: 31,
    week4_wvlu_retention_rate: 0.32,
    week8_wvlu_cohort: 14,
    week8_wvlu_retention_rate: 0.21,
    recovery_72h_cohort: 27,
    recovery_selected_rate: 0.56,
    recovery_72h_rate: 0.41,
    task_outcome_28d_count: 210,
    overload_event_28d_count: 38,
    overload_rate_28d: 0.181,
    quality_ready_rate: 0.84,
  },
  rate_details: {
    very_disappointed_rate: { numerator: 8, denominator: 18, value: 0.44 },
    goal_created_10m_rate: { numerator: 36, denominator: 58, value: 0.62 },
    first_task_started_24h_rate: { numerator: 36, denominator: 51, value: 0.71 },
    activation_24h_rate: { numerator: 25, denominator: 51, value: 0.49 },
    first_action_evidence_rate: { numerator: 10, denominator: 23, value: 0.43 },
    week4_wvlu_retention_rate: { numerator: 10, denominator: 31, value: 0.32 },
    week8_wvlu_retention_rate: { numerator: 3, denominator: 14, value: 0.21 },
    recovery_selected_rate: { numerator: 15, denominator: 27, value: 0.56 },
    recovery_72h_rate: { numerator: 11, denominator: 27, value: 0.41 },
    overload_rate_28d: { numerator: 38, denominator: 210, value: 0.181 },
  },
  thresholds: {
    very_disappointed_rate: 0.4,
    goal_created_10m_rate: 0.6,
    activation_24h_rate: 0.6,
    week4_wvlu_retention_rate: 0.35,
    recovery_72h_rate: 0.4,
    max_overload_rate: 0.25,
    minimum_surveys: 40,
    minimum_behavioral_cohort: 40,
  },
  metric_definitions: {},
  measurement_policy: {
    consent: "仅纳入已授权用户",
    interval: "所有时间窗左闭右开",
    deduplication: "用户级指标每用户一次",
    threshold_status: "当前阈值为工程预设，尚未经过真实用户样本校准",
  },
};

async function mockDashboard(page: Page) {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: {
      id: "product-admin",
      email: "product-admin@example.com",
      username: "产品运营",
      is_admin: true,
      timezone: "Asia/Shanghai",
      onboarding_completed: true,
    },
  }));
  await page.route("**/api/v1/agent-control/admin/product-validation/latest", (route) => route.fulfill({ json: report }));
  await page.route("**/api/v1/agent-control/admin/product-validation/history?limit=12", (route) => route.fulfill({ json: [
    report,
    { ...report, snapshot_id: "snapshot-0", generated_at: "2026-08-17T10:00:00Z", rate_details: {
      ...report.rate_details,
      goal_created_10m_rate: { numerator: 30, denominator: 54, value: 0.56 },
      activation_24h_rate: { numerator: 22, denominator: 50, value: 0.44 },
      week4_wvlu_retention_rate: { numerator: 8, denominator: 30, value: 0.27 },
      recovery_72h_rate: { numerator: 9, denominator: 26, value: 0.35 },
    } },
  ] }));
}

test("产品验证看板在桌面和手机上保持紧凑、清楚且没有横向溢出", async ({ page }) => {
  await mockDashboard(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin/product");

  const dashboard = page.getByTestId("product-validation-dashboard");
  await expect(page.getByRole("heading", { name: "用户价值验证" })).toBeVisible();
  await expect(dashboard).toBeVisible();
  await expect(page.getByText("证据还在积累", { exact: true })).toBeVisible();
  await expect(page.getByText("10 分钟建好目标", { exact: true })).toBeVisible();
  await expect(page.getByText("24 小时完成首次行动", { exact: true })).toBeVisible();
  await expect(page.getByText("第 4 周仍有学习闭环", { exact: true })).toBeVisible();
  await expect(page.getByText("中断后 72 小时内恢复", { exact: true })).toBeVisible();
  await expect(page.locator(".pp-product-metric")).toHaveCount(4);
  await expect(page.locator(".pp-product-sparkline")).toHaveCount(4);
  await page.waitForTimeout(350);
  await page.screenshot({ path: "e2e/artifacts/product-validation-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(dashboard).toBeVisible();
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((element) => ({ selector: element.className || element.tagName, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width }))
      .filter((item) => item.right > document.documentElement.clientWidth + 1 || item.width > document.documentElement.clientWidth + 1)
      .slice(0, 12),
  }));
  expect(layout.overflow, JSON.stringify(layout.offenders)).toBeLessThanOrEqual(1);
  await expect(page.locator(".pp-product-metric-grid")).toHaveCSS("grid-template-columns", /.+ .+/);
  const metricValueSize = await page.locator(".pp-product-metric-value-row > strong").first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(metricValueSize).toBeGreaterThanOrEqual(26);
  const cardHeight = await page.locator(".pp-product-metric").first().evaluate((element) => element.getBoundingClientRect().height);
  expect(cardHeight).toBeLessThan(260);
  const tinyText = await page.locator(".pp-product-validation *").evaluateAll((elements) => elements
    .filter((element) => element.children.length === 0 && (element.textContent ?? "").trim() && (element as HTMLElement).offsetParent !== null)
    .map((element) => ({ text: (element.textContent ?? "").trim(), size: parseFloat(getComputedStyle(element).fontSize) }))
    .filter((item) => item.size < 12));
  expect(tinyText).toEqual([]);
  await page.waitForTimeout(350);
  await page.screenshot({ path: "e2e/artifacts/product-validation-mobile-375.png", fullPage: true });
});
