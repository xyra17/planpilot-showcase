import { expect, test, type Page } from "@playwright/test";

const user = { id: "memory-review-user", email: "memory@example.com", username: "学习测试", avatar_url: null, created_at: "2026-01-01T00:00:00Z" };
const patterns = [
  { id: "evening-pattern", goal_id: null, scope: "user", pattern_type: "preferred_learning_time", pattern_value: {}, confidence: 0.82, evidence_count: 18, last_confirmed_at: "2026-08-05T12:00:00Z", user_review_status: null, evidence: [{ event_id: "event-1", event_type: "TaskCompleted", occurred_at: "2026-08-05T12:00:00Z", contribution: 0.08, direction: "supporting" }], evidence_summary: { supporting_count: 16, opposing_count: 2, neutral_count: 0, first_observed_at: "2026-07-08T12:00:00Z", last_observed_at: "2026-08-05T12:00:00Z", observation_window_days: 30 }, explanation: "工作日晚间更容易完成高认知任务" },
  { id: "recovery-pattern", goal_id: null, scope: "user", pattern_type: "plan_adherence", pattern_value: {}, confidence: 0.66, evidence_count: 8, last_confirmed_at: "2026-08-01T12:00:00Z", user_review_status: "confirmed", evidence: [], evidence_summary: { supporting_count: 8, opposing_count: 0, neutral_count: 0, first_observed_at: "2026-07-18T12:00:00Z", last_observed_at: "2026-08-01T12:00:00Z" }, explanation: "延期后先恢复连续性更容易坚持" },
];
const delayPattern = { id: "delay-pattern", goal_id: null, scope: "user", pattern_type: "delay_pattern", pattern_value: { sample_count: 5, effective_sample_count: 5, evidence_strength: 0.625 }, confidence: 0.625, evidence_count: 5, last_confirmed_at: "2026-08-05T12:00:00Z", user_review_status: null, evidence: [{ evidence_id: "delay-evidence", event_id: "delay-event", event_type: "TaskCompleted", occurred_at: "2026-08-04T12:00:00Z", contribution: 0.9, direction: "supporting", task_title: "数据叙事练习", days_overdue: 4, correctable: true }], evidence_summary: { supporting_count: 5, opposing_count: 0, neutral_count: 0, excluded_count: 0, first_observed_at: "2026-07-08T12:00:00Z", last_observed_at: "2026-08-05T12:00:00Z" }, explanation: "任务逾期记录显示了延期倾向" };
const context = { profile: null, cognitive_profile: { procrastination_score: 0.9, persistence_score: 0.2, challenge_tolerance: 0.1, feedback_acceptance: 0.3 }, memories: { short_term: [], episodic: [], semantic: [] }, knowledge_gaps: [], recent_events: [], goal_context: null, data_quality: { profile_event_count: 18, profile_scope: "user", pattern_count: 3, memory_count: 0, cognitive_confidence: 0.62, knowledge_gap_count: 0, low_confidence_fields: [], level: "medium" }, active_patterns: [...patterns, delayPattern] };

async function authenticate(page: Page) {
  await page.addInitScript((cachedUser) => { localStorage.setItem("access_token", "memory-review-token"); localStorage.setItem("user_info", JSON.stringify(cachedUser)); }, user);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ status: 200, json: user }));
  await page.route("**/api/v1/goals**", (route) => route.fulfill({ status: 200, json: [] }));
}

async function openMemory(page: Page, options: { actionBodies?: Array<Record<string, unknown>>; attributionBodies?: Array<Record<string, unknown>>; failFirstCorrection?: boolean; undoCalls?: string[] } = {}) {
  await authenticate(page);
  let correctionAttempts = 0;
  await page.route("**/api/v1/learner/decision-context**", (route) => route.fulfill({ status: 200, json: context }));
  await page.route("**/api/v1/learner/patterns/manage**", (route) => route.fulfill({ status: 200, json: [{ id: "paused-pattern", goal_id: null, scope: "user", pattern_type: "delay_pattern", status: "paused", confidence: 0.7, evidence_count: 7, explanation: "高负荷周更容易延期", user_review_status: "paused", user_reviewed_at: null, paused_at: "2026-08-18T08:00:00Z", first_observed_at: "2026-07-01T08:00:00Z", last_confirmed_at: null }] }));
  await page.route("**/api/v1/learner/patterns/*/actions", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    options.actionBodies?.push(body);
    if (body.action === "correct") correctionAttempts += 1;
    if (options.failFirstCorrection && body.action === "correct" && correctionAttempts === 1) {
      await route.fulfill({ status: 503, json: { detail: "修正暂时保存失败" } });
      return;
    }
    await route.fulfill({ status: 200, json: patterns[0] });
  });
  await page.route("**/api/v1/learner/patterns/*/evidence/*/attribution", async (route) => {
    options.attributionBodies?.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, json: { pattern: delayPattern, evidence_id: "delay-evidence", attribution: "external_interruption", audit_id: "audit-delay" } });
  });
  await page.route("**/api/v1/learner/pattern-audits**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname.endsWith("/undo")) {
      options.undoCalls?.push(request.url());
      await route.fulfill({ status: 200, json: { id: "audit-undo", action: "undo" } });
      return;
    }
    await route.fulfill({ status: 200, json: [{ id: "audit-1", pattern_id: "paused-pattern", action: "pause", actor_type: "user", reason: null, before_state: {}, after_state: {}, reversible: true, undone_at: null, created_at: "2026-08-18T08:00:00Z" }] });
  });
  await page.goto("/studio/coach/memory?pattern=evening-pattern");
}

test("主导航隐藏学习记忆并保留情境深链", async ({ page }) => {
  await openMemory(page);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation.getByRole("link", { name: "学习记忆" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "个性化与学习偏好" })).toBeVisible();
  const target = page.locator("#pattern-evening-pattern");
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/is-targeted/);
  await expect(target.getByText("证据是否足够稳定", { exact: false })).toBeVisible();
});

test("普通用户只看到两组可纠正观察且不暴露技术画像", async ({ page }, testInfo) => {
  await openMemory(page);
  const feedback = page.getByRole("region", { name: "让 Pilo 的理解保持准确，也保持可控" });
  await expect(feedback).toContainText("只有你在这里确认或修正具体观察后");
  await expect(feedback.getByRole("button", { name: "查看 2 条待确认观察" })).toBeVisible();
  await expect(feedback.getByRole("link", { name: "和 Pilo 逐条校正" })).toHaveAttribute("href", /intent=correct-learning-profile/);
  await page.screenshot({ path: testInfo.outputPath("profile-feedback-desktop.png"), fullPage: true });
  await expect(page.getByRole("heading", { name: "需要你确认的观察" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "已应用的学习偏好 / 观察" })).toBeVisible();
  const first = page.locator("#pattern-evening-pattern");
  for (const copy of ["暂定表述", "来源类型", "观察窗口", "证据摘要", "具体会影响什么", "调整范围", "确认准确", "修正", "暂停", "查看依据", "永久遗忘"]) await expect(first.getByText(copy, { exact: false }).first()).toBeVisible();
  await expect(first.getByRole("link", { name: "为什么这样建议我" })).toHaveAttribute("href", /pattern=evening-pattern/);
  await expect(page.getByText(/Brier Score|ECE|A\/B Test|保持曲线|认知状态快照|procrastination_score|persistence_score|challenge_tolerance|feedback_acceptance/)).toHaveCount(0);
});

test("具体延期证据可以标记外部中断并经过确认边界", async ({ page }) => {
  const attributionBodies: Array<Record<string, unknown>> = [];
  await openMemory(page, { attributionBodies });
  const card = page.locator("#pattern-delay-pattern");
  await card.getByRole("button", { name: "查看依据" }).click();
  await card.getByRole("button", { name: "标记外部中断" }).click();
  await card.getByRole("textbox", { name: "归因补充说明" }).fill("当周在出差");
  await card.getByRole("button", { name: "保存归因" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "标记外部中断" }).click();
  await expect.poll(() => attributionBodies.length).toBe(1);
  expect(attributionBodies[0]).toMatchObject({ reason_code: "business_trip", note: "当周在出差" });
});

test("观察确认、暂停、恢复、遗忘与审计撤销均经过确认边界", async ({ page }) => {
  const actions: Array<Record<string, unknown>> = [];
  const undoCalls: string[] = [];
  await openMemory(page, { actionBodies: actions, undoCalls });
  const card = page.locator("#pattern-evening-pattern");

  await card.getByRole("button", { name: "确认准确" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认准确" }).click();
  await expect.poll(() => actions.some((body) => body.action === "confirm")).toBe(true);

  await card.getByRole("button", { name: "暂停" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "暂停" }).click();
  await expect.poll(() => actions.some((body) => body.action === "pause")).toBe(true);

  await page.getByText("高级管理与修改记录", { exact: true }).click();
  await page.getByRole("button", { name: "恢复" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "恢复" }).click();
  await expect.poll(() => actions.some((body) => body.action === "restore")).toBe(true);

  await card.getByRole("button", { name: "永久遗忘" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("无法恢复");
  await page.getByRole("alertdialog").getByRole("button", { name: "永久遗忘" }).click();
  await expect.poll(() => actions.some((body) => body.action === "forget")).toBe(true);

  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("永久遗忘不可撤销");
  await page.getByRole("alertdialog").getByRole("button", { name: "确认撤销" }).click();
  await expect.poll(() => undoCalls.length).toBe(1);
});

test("修正取消或请求失败时保留编辑器与草稿，成功后才关闭", async ({ page }) => {
  const actions: Array<Record<string, unknown>> = [];
  await openMemory(page, { actionBodies: actions, failFirstCorrection: true });
  const card = page.locator("#pattern-evening-pattern");
  await card.getByRole("button", { name: "修正" }).click();
  const editor = card.getByRole("textbox", { name: "修正暂定表述" });
  await editor.fill("我在周末上午更容易完成高认知任务");

  await card.getByRole("button", { name: "保存修正" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
  await expect(editor).toHaveValue("我在周末上午更容易完成高认知任务");
  expect(actions).toHaveLength(0);

  await card.getByRole("button", { name: "保存修正" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "保存修正" }).click();
  await expect(page.getByText("修正暂时保存失败", { exact: false })).toBeVisible();
  await expect(editor).toHaveValue("我在周末上午更容易完成高认知任务");

  await card.getByRole("button", { name: "保存修正" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "保存修正" }).click();
  await expect(editor).toHaveCount(0);
  expect(actions.filter((body) => body.action === "correct")).toHaveLength(2);
});

test("关闭个性化的 403 提供设置入口", async ({ page }) => {
  await authenticate(page);
  await page.route("**/api/v1/learner/decision-context**", (route) => route.fulfill({ status: 403, json: { detail: "个性化学习已关闭；可在隐私设置中重新启用" } }));
  await page.route("**/api/v1/learner/patterns/manage**", (route) => route.fulfill({ status: 403, json: { detail: "个性化学习已关闭；可在隐私设置中重新启用" } }));
  await page.route("**/api/v1/learner/pattern-audits**", (route) => route.fulfill({ status: 403, json: { detail: "个性化学习已关闭；可在隐私设置中重新启用" } }));
  await page.goto("/studio/coach/memory");
  await expect(page.getByRole("heading", { name: "个性化建议已关闭" })).toBeVisible();
  await expect(page.getByRole("link", { name: /前往 AI 与隐私设置/ })).toHaveAttribute("href", "/studio/settings#settings-privacy");
});

test("访客直达使用紧凑登录说明", async ({ page }) => {
  await page.goto("/studio/coach/memory");
  await expect(page.getByRole("heading", { name: "登录后管理你的个性化选择" })).toBeVisible();
  await expect(page.getByRole("link", { name: "登录继续" })).toHaveAttribute("href", "/login?next=%2Fstudio%2Fcoach%2Fmemory");
  await expect(page.getByText(/来源可追溯|真实画像|认知状态快照/)).toHaveCount(0);
});

test("375px 窄屏无横向滚动且操作达到 44px", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openMemory(page);
  const observation = page.locator("#pattern-evening-pattern");
  await expect(observation).toBeVisible();
  await expect(observation.getByRole("button", { name: "确认准确" })).toBeVisible();
  const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
  const heights = await observation.locator(".personalization-observation-actions :is(button, a)").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  expect(heights.every((height) => height >= 44)).toBe(true);
  const feedbackHeights = await page.locator(".personalization-feedback-actions :is(button, a)").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(feedbackHeights.every((height) => height >= 44)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("profile-feedback-mobile.png"), fullPage: true });
});
