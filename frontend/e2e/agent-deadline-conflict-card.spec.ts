import { expect, test, type Page } from "@playwright/test";

const user = {
  id: "deadline-card-user",
  email: "deadline-card@example.com",
  username: "期限卡片测试",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00Z",
};

const run = {
  id: "deadline-conflict-run",
  goal_id: "deadline-goal",
  request: "把逾期任务排到目标期限之后",
  status: "failed",
  current_step: 1,
  error: "计划超过目标截止日期",
  result: {
    outcome: "safe_policy_rejection",
    action_fulfilled: false,
    reason_code: "deadline_conflict",
    summary: "当前任务量无法在目标期限内完成",
    alternatives: [
      { id: "preview_goal_deadline_extension", label: "先延长目标期限", description: "另行提出新的目标截止日期，经独立预览和确认后再重排任务。" },
      { id: "analyze_deadline_risk_only", label: "只分析期限风险", description: "不生成任务变更，仅说明当前期限、积压量和延期影响。" },
      { id: "rebuild_within_deadline", label: "在原期限内重建计划", description: "保留当前截止日期，减少或拆分任务后重新生成可执行方案。" },
    ],
  },
  created_at: "2026-08-24T08:00:00Z",
  updated_at: "2026-08-24T08:01:00Z",
  plan: [],
  steps: [],
  approvals: [],
  events: [],
  budgets: { steps: { used: 1, limit: 12 }, tokens: { used: 0, limit: 12000 } },
};

async function openCoachWithDeadlineConflict(page: Page) {
  await page.addInitScript((cachedUser) => {
    localStorage.setItem("access_token", "deadline-card-token");
    localStorage.setItem("user_info", JSON.stringify(cachedUser));
  }, user);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ status: 200, json: user }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ status: 200, json: [{ id: "deadline-goal", title: "数据分析进阶", status: "active", type: "skill", deadline: "2026-09-01", daily_hours: 1 }] }));
  await page.route("**/api/v1/knowledge/files", (route) => route.fulfill({ status: 200, json: { items: [] } }));
  await page.route("**/api/v1/learner/decision-context**", (route) => route.fulfill({ status: 200, json: { profile: null, cognitive_profile: null, memories: { short_term: [], episodic: [], semantic: [] }, knowledge_gaps: [], recent_events: [], goal_context: null, data_quality: { profile_event_count: 0, profile_scope: "goal", pattern_count: 0, memory_count: 0, cognitive_confidence: 0, knowledge_gap_count: 0, low_confidence_fields: [], level: "low" }, active_patterns: [] } }));
  await page.route("**/api/v1/learner/proposals**", (route) => route.fulfill({ status: 200, json: [] }));
  await page.route("**/api/v1/coach/archive", (route) => route.fulfill({ status: 200, json: { version: 1, conversations: [], preferences: null } }));
  await page.route("**/api/v2/agent/runs?limit=20", (route) => route.fulfill({ status: 200, json: [run] }));
  await page.route("**/api/v2/agent/runs/deadline-conflict-run", (route) => route.fulfill({ status: 200, json: run }));
  await page.goto("/studio/coach");
  await expect(page.getByRole("region", { name: "Pilo 行动任务" })).toBeVisible();
}

test("期限冲突展示未写入边界和三条真实恢复路径", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openCoachWithDeadlineConflict(page);
  const card = page.getByRole("region", { name: "Pilo 行动任务" });
  await expect(card.getByText("需要调整期限", { exact: true })).toBeVisible();
  await expect(card.getByText("没有修改任何目标或任务", { exact: false })).toBeVisible();
  await expect(card.getByText("计划超过目标截止日期", { exact: true })).toHaveCount(0);
  await expect(card.getByRole("link", { name: "调整目标期限" })).toHaveAttribute("href", "/studio/work/goals/deadline-goal/edit");
  await expect(card.getByRole("link", { name: "保持期限重新规划" })).toHaveAttribute("href", /intent=rebuild-within-deadline/);
  await expect(card.getByRole("link", { name: "只分析风险" })).toHaveAttribute("href", /intent=analyze-deadline-risk/);
  await expect(card.getByRole("button", { name: "重试" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("deadline-conflict-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "拉灯切换到深色模式" }).click();
  await expect(page.locator(".companion-workspace")).toHaveClass(/is-dark/);
  await expect(card.locator(".companion-deadline-boundary")).toHaveCSS("color", "rgb(117, 205, 180)");
  await page.screenshot({ path: testInfo.outputPath("deadline-conflict-dark.png"), fullPage: true });
  await page.getByRole("button", { name: "拉灯切换到明亮模式" }).click();

  await page.setViewportSize({ width: 375, height: 812 });
  await card.scrollIntoViewIfNeeded();
  const metrics = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width);
  const actionHeights = await card.locator(".companion-deadline-actions > a").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(actionHeights).toHaveLength(3);
  expect(actionHeights.every((height) => height >= 44)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("deadline-conflict-mobile.png"), fullPage: true });
});
