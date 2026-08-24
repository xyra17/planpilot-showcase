import { expect, test } from "@playwright/test";

const betaOverview = {
  control: {
    id: "action-beta",
    beta_enabled: true,
    new_action_runs_enabled: true,
    cohort_mode: "percentage",
    traffic_percent: 20,
    allowlisted_user_ids: [],
    metric_version: "action-beta-funnel-v2",
    measurement_started_at: "2026-08-20T00:00:00Z",
    paused_reason: null,
    safety_snapshot: {},
    updated_at: "2026-08-24T10:00:00Z",
  },
  metrics: {
    metric_version: "action-beta-funnel-v2",
    measurement_start: "2026-08-24T08:00:00Z",
    measurement_end: "2026-08-24T10:00:00Z",
    cohort: "beta",
    source: "conversation",
    sample_size: 42,
    insufficient_data: true,
    counts: {
      conversation_turn_received: 42,
      need_frame_resolved: 39,
      clarification_requested: 9,
      intent_resolved: 33,
      action_run_created: 26,
      preview_ready: 25,
      approved: 18,
      completed: 16,
      failed: 2,
      rolled_back: 1,
    },
    rates: { routing_rate: 0.62, execution_success_rate: 0.38 },
    rate_details: {},
    source_funnel: {},
    latency: { preview_p50_ms: 620, preview_p95_ms: 1400 },
    safety: { status: "observed_clear", counts: {}, observed_at: "2026-08-24T09:00:00Z", expires_at: "2026-08-25T09:00:00Z", source: "安全扫描", blockers: [] },
    expansion_blocked: true,
  },
  review_queue_has_pending: false,
  runtime_gate: { status: "valid", valid: true, blockers: [], decided_at: "2026-08-24T09:00:00Z" },
  safety: { status: "observed_clear", counts: { unconfirmed_write_count: 0, cross_user_access_count: 0, duplicate_write_count: 0, review_binding_failure_count: 0 }, observed_at: "2026-08-24T09:00:00Z", expires_at: "2026-08-25T09:00:00Z", source: "安全扫描", blockers: [] },
  evidence_state: "infrastructure_ready_no_beta_conclusion",
};

test("行动验证页在桌面和手机上保持高密度且文字可读", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "action-admin", email: "action@example.com", username: "行动运营", is_admin: true, timezone: "Asia/Shanghai", onboarding_completed: true },
  }));
  await page.route("**/api/v1/agent-control/admin/beta/overview", (route) => route.fulfill({ json: betaOverview }));
  await page.route("**/api/v1/agent-control/admin/beta/review-samples?status=pending", (route) => route.fulfill({ json: [] }));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin/beta");
  await expect(page.getByRole("heading", { name: "行动功能验证" })).toBeVisible();
  await expect(page.getByText("试用范围与安全开关")).toBeVisible();
  await expect(page.getByText("安全底线")).toBeVisible();
  await expect(page.getByText("功能已经可以试用，但真实效果样本还不够，暂时不能下结论。")).toBeVisible();
  const topShell = page.locator(".pp-action-shell");
  await expect(topShell).toHaveCSS("box-shadow", "none");
  const bodyTextSizes = await page.locator(".pp-action-shell p, .pp-action-evidence-panel p").evaluateAll((elements) => elements.map((element) => parseFloat(getComputedStyle(element).fontSize)));
  expect(Math.min(...bodyTextSizes)).toBeGreaterThanOrEqual(13);
  await page.screenshot({ path: "e2e/artifacts/action-validation-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.getByText("试用范围与安全开关")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "e2e/artifacts/action-validation-mobile-375.png", fullPage: true });
});
