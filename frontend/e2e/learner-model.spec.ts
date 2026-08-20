import { expect, test, type Page } from "@playwright/test";

const user = {
  id: "memory-review-user",
  email: "memory@example.com",
  username: "学习测试",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00Z",
};

const decisionContext = {
  profile: {
    id: "profile-1", goal_id: null, consistency_score: 0.72, weekly_active_days: 4,
    avg_session_duration_mins: 42, avg_daily_investment_mins: 34, completion_rate_30d: 0.68,
    mastery_rate_30d: 0.61, mastery_velocity: 0.57, preferred_hour_start: 19,
    preferred_hour_end: 21, preferred_weekdays: [1, 2, 3, 4], estimation_accuracy: 0.74,
    debt_tendency: 0.28, reschedule_rate: 0.24, observation_window_days: 30,
    event_count: 18, last_computed_at: "2026-08-18T08:00:00Z",
  },
  cognitive_profile: {
    id: "cognitive-1", goal_id: null, learning_speed: 0.58, retention_rate: 0.76,
    forgetting_rate: 0.04, transfer_score: 0.52, persistence_score: 0.7,
    procrastination_score: 0.28, recovery_score: 0.64, difficulty_preference: 0.6,
    challenge_tolerance: 0.55, feedback_acceptance: 0.8, observation_window_days: 90,
    sample_count: 18, confidence: 0.62,
    retention_curve: [{ day: 0, retention: 0.76 }, { day: 1, retention: 0.73 }, { day: 3, retention: 0.67 }, { day: 7, retention: 0.58 }, { day: 14, retention: 0.44 }, { day: 30, retention: 0.23 }],
    last_computed_at: "2026-08-18T08:00:00Z",
  },
  knowledge_gaps: [],
  recent_events: [],
  goal_context: null,
  data_quality: {
    profile_event_count: 18,
    profile_scope: "user",
    pattern_count: 2,
    memory_count: 3,
    cognitive_confidence: 0.62,
    knowledge_gap_count: 0,
    low_confidence_fields: [],
    level: "medium",
  },
  active_patterns: [
    {
      id: "evening-pattern",
      goal_id: null,
      scope: "user",
      pattern_type: "preferred_learning_time",
      pattern_value: { start: "19:00", end: "21:00" },
      confidence: 0.82,
      evidence_count: 18,
      last_confirmed_at: "2026-08-05T12:00:00Z",
      evidence: [{ event_id: "event-1", event_type: "TaskCompleted", occurred_at: "2026-08-05T12:00:00Z", contribution: 0.08 }],
      evidence_summary: { supporting_count: 16, opposing_count: 2, neutral_count: 0, first_observed_at: "2026-07-08T12:00:00Z", last_observed_at: "2026-08-05T12:00:00Z" },
      explanation: "工作日晚间更容易完成高认知任务",
    },
    {
      id: "recovery-pattern",
      goal_id: null,
      scope: "user",
      pattern_type: "plan_adherence",
      pattern_value: {},
      confidence: 0.66,
      evidence_count: 8,
      last_confirmed_at: "2026-08-01T12:00:00Z",
      evidence: [],
      evidence_summary: { supporting_count: 8, opposing_count: 0, neutral_count: 0, first_observed_at: "2026-07-18T12:00:00Z", last_observed_at: "2026-08-01T12:00:00Z" },
      explanation: "延期后先恢复连续性更容易坚持",
    },
  ],
  memories: {
    short_term: [{ id: "short-1", kind: "risk", summary: "链表知识即将进入复习窗口", occurred_at: "2026-08-07T12:00:00Z" }],
    episodic: [{ id: "episode-1", memory_type: "recovery", summary: "缩短学习时长后连续完成了三天任务", importance: 0.8, relevance: 0.9, source_event_id: null, occurred_at: "2026-08-03T12:00:00Z" }],
    semantic: [{ id: "semantic-1", memory_type: "semantic_pattern", summary: "preferred_learning_time", value: {}, confidence: 0.82, scope: "user" }],
  },
};

const validationSnapshot = {
  schema_version: "core-learning-experiment-v1",
  generated_at: "2026-08-18T08:00:00Z",
  viewer_evidence: { cohort: "real_user", environment: "production", experiments_enabled: true, product_analytics_enabled: true, quality_score: 0.88, quality_schema_version: "learning-data-quality-v1", quality_sampled_at: "2026-08-18T08:00:00Z", eligible_for_real_evidence: true },
  reports: [
    { experiment_key: "pattern_validity", status: "supported", generated_at: "2026-08-18T08:00:00Z", provenance: { schema_version: "core-learning-experiment-v1", environment: "production", data_origin: "consented_learning_data", window_days: 90, synthetic_data_allowed: false, stale: false }, result: { evening_minus_afternoon: 0.41, difference_95_ci: [0.2, 0.62], minimum_samples_per_bucket: 30, buckets: { afternoon: { sample_count: 30, completion_rate: 0.41 }, evening: { sample_count: 30, completion_rate: 0.82 } } } },
    { experiment_key: "prediction_calibration", status: "not_supported", generated_at: "2026-08-18T08:00:00Z", result: { outcome_count: 100, brier_score: 0.473, expected_calibration_error: 0.683, thresholds: { minimum_outcomes: 100, max_brier: 0.22, max_ece: 0.05 } } },
    { experiment_key: "proposal_utility", status: "insufficient_data", generated_at: "2026-08-18T08:00:00Z", result: { seven_day: { sample_count: 22, completion_rate: 0.7, mean_delta: 0.08 }, minimum_seven_day_outcomes: 50 } },
    { experiment_key: "personalization_lift", status: "not_configured", generated_at: "2026-08-18T08:00:00Z", result: { minimum_users_per_variant: 40, variants: [], treatment_minus_control: { completion: null, recovery: null, mastery: null, retention: null, overload: null } } },
  ],
};

async function openAuthenticatedMemory(page: Page) {
  await page.addInitScript((cachedUser) => {
    localStorage.setItem("access_token", "memory-review-token");
    localStorage.setItem("user_info", JSON.stringify(cachedUser));
  }, user);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) }));
  await page.route("**/api/v1/goals**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/v1/learner/decision-context**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(decisionContext) }));
  await page.route("**/api/v1/learner/validation-status**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(validationSnapshot) }));
  await page.route("**/api/v1/learner/patterns/manage**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "paused-pattern", goal_id: null, scope: "user", pattern_type: "delay_pattern", status: "paused", confidence: 0.7, evidence_count: 7, explanation: "高负荷周更容易延期", user_review_status: "paused", user_reviewed_at: "2026-08-18T08:00:00Z", paused_at: "2026-08-18T08:00:00Z", first_observed_at: "2026-07-01T08:00:00Z", last_confirmed_at: "2026-08-10T08:00:00Z" }]) }));
  await page.route("**/api/v1/learner/pattern-audits**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "audit-1", pattern_id: "paused-pattern", action: "pause", actor_type: "user", reason: null, before_state: {}, after_state: {}, reversible: true, undone_at: null, created_at: "2026-08-18T08:00:00Z" }]) }));
  await page.goto("/studio/coach/memory");
}

test("访客不会看到伪造的个人画像", async ({ page }) => {
  await page.goto("/studio/coach/memory");

  await expect(page.getByRole("heading", { name: "学习记忆", exact: true })).toBeVisible();
  const guestPagebar = await page.locator(".memory-review-pagebar").evaluate((header) => {
    const title = header.querySelector<HTMLElement>("h1")!;
    const description = header.querySelector<HTMLElement>(".workspace-page-title > span")!;
    const headerStyle = getComputedStyle(header);
    const titleStyle = getComputedStyle(title);
    return {
      height: header.getBoundingClientRect().height,
      paddingTop: Number.parseFloat(headerStyle.paddingTop),
      paddingLeft: Number.parseFloat(headerStyle.paddingLeft),
      borderStyle: headerStyle.borderTopStyle,
      radius: Number.parseFloat(headerStyle.borderTopLeftRadius),
      titleSize: Number.parseFloat(titleStyle.fontSize),
      titleFill: titleStyle.getPropertyValue("-webkit-text-fill-color"),
      descriptionSize: Number.parseFloat(getComputedStyle(description).fontSize),
    };
  });
  expect(guestPagebar.height).toBeGreaterThanOrEqual(100);
  expect(guestPagebar.height).toBeLessThanOrEqual(101);
  expect(guestPagebar.paddingTop).toBe(14);
  expect(guestPagebar.paddingLeft).toBe(16);
  expect(guestPagebar.borderStyle).toBe("solid");
  expect(guestPagebar.radius).toBe(12);
  expect(guestPagebar.titleSize).toBe(25.6);
  expect(guestPagebar.titleFill).not.toBe("rgba(0, 0, 0, 0)");
  expect(guestPagebar.descriptionSize).toBe(11);
  await expect(page.getByRole("heading", { name: "查看真实的记忆与学习观察" })).toHaveCount(0);
  await expect(page.getByText("登录后，你可以查看每条观察的来源、适用范围和影响方式，并发起校正。这里不会用示例数据冒充你的画像。", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /登录查看真实画像/ })).toBeVisible();
  await expect(page.getByText("记录与观察分开", { exact: true })).toBeVisible();
  await expect(page.getByText("推断不是事实", { exact: true })).toHaveCount(0);
  const loginLink = page.getByRole("link", { name: /登录查看真实画像/ });
  const loginCopy = page.getByText("登录后，你可以查看每条观察的来源、适用范围和影响方式，并发起校正。这里不会用示例数据冒充你的画像。", { exact: true });
  const [loginBox, copyBox] = await Promise.all([
    loginLink.evaluate((element) => element.getBoundingClientRect()),
    loginCopy.evaluate((element) => element.getBoundingClientRect()),
  ]);
  expect(copyBox.top).toBeGreaterThanOrEqual(loginBox.bottom);
  const [workspaceBox, pagebarBox, guestBox] = await Promise.all([
    page.locator(".memory-review-page").evaluate((element) => element.getBoundingClientRect()),
    page.locator(".memory-review-pagebar").evaluate((element) => element.getBoundingClientRect()),
    page.locator(".memory-guest-state").evaluate((element) => element.getBoundingClientRect()),
  ]);
  expect(Math.abs(guestBox.top - pagebarBox.bottom - 16)).toBeLessThanOrEqual(1);
  expect(Math.abs(workspaceBox.bottom - guestBox.bottom)).toBeLessThanOrEqual(2);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  expect(Math.abs(viewportHeight - guestBox.bottom - 18)).toBeLessThanOrEqual(2);
  const guestCards = page.locator(".memory-guest-state article");
  await expect(guestCards).toHaveCount(3);
  for (const card of await guestCards.all()) {
    const sizes = await card.evaluate((element) => {
      const title = element.querySelector("strong")!;
      const copy = element.querySelector("span")!;
      const icon = element.querySelector("svg")!;
      const titleBox = title.getBoundingClientRect();
      const copyBox = copy.getBoundingClientRect();
      const iconBox = icon.getBoundingClientRect();
      const cardBox = element.getBoundingClientRect();
      return {
        titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
        copySize: Number.parseFloat(getComputedStyle(copy).fontSize),
        iconCenterOffset: Math.abs((iconBox.left + iconBox.width / 2) - (cardBox.left + cardBox.width / 2)),
        titleCenterOffset: Math.abs((titleBox.left + titleBox.width / 2) - (cardBox.left + cardBox.width / 2)),
        copyCenterOffset: Math.abs((copyBox.left + copyBox.width / 2) - (cardBox.left + cardBox.width / 2)),
      };
    });
    expect(sizes.titleSize).toBeGreaterThan(sizes.copySize);
    expect(sizes.iconCenterOffset).toBeLessThanOrEqual(1);
    expect(sizes.titleCenterOffset).toBeLessThanOrEqual(1);
    expect(sizes.copyCenterOffset).toBeLessThanOrEqual(1);
  }
  await expect(page.getByText("38", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/画像已稳定|模型较稳定|最高阶段/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /登录查看真实画像/ })).toHaveAttribute("href", "/login?next=%2Fstudio%2Fcoach%2Fmemory");
});

test("学习观察明确展示推断、影响、证据和校正入口", async ({ page }) => {
  await openAuthenticatedMemory(page);

  await expect(page.getByRole("heading", { name: "学习记忆", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回学习伙伴" })).toHaveCount(0);
  await expect(page.getByLabel("选择学习记忆范围")).toBeVisible();
  await expect(page.getByText("18 条行为记录 · 3 条记忆内容", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "学习画像摘要" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /逐条核对/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "学习记忆形成路径" })).toContainText("行为记录");
  await expect(page.getByRole("region", { name: "学习记忆形成路径" })).toContainText("最近形成的观察");
  await expect(page.getByRole("heading", { name: "正在使用的学习观察" })).toBeVisible();
  await expect(page.getByText("学习观察", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/画像已稳定|模型较稳定|成熟度|最高阶段/)).toHaveCount(0);
  await expect(page.getByRole("group", { name: "筛选学习规律" })).toHaveCount(0);
  await expect(page.getByLabel("搜索学习观察")).toHaveCount(0);

  const pagebar = await page.locator(".memory-review-pagebar").evaluate((header) => {
    const eyebrow = header.querySelector<HTMLElement>(".workspace-page-title small")!;
    const title = header.querySelector<HTMLElement>(".workspace-page-title h1")!;
    const subtitle = header.querySelector<HTMLElement>(".workspace-page-title > span")!;
    const scope = header.querySelector<HTMLElement>(".memory-scope-select")!;
    const styles = getComputedStyle(header);
    return {
      height: header.getBoundingClientRect().height,
      paddingTop: Number.parseFloat(styles.paddingTop),
      paddingLeft: Number.parseFloat(styles.paddingLeft),
      radius: Number.parseFloat(styles.borderTopLeftRadius),
      eyebrowSize: Number.parseFloat(getComputedStyle(eyebrow).fontSize),
      titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
      subtitleSize: Number.parseFloat(getComputedStyle(subtitle).fontSize),
      scopeHeight: scope.getBoundingClientRect().height,
    };
  });
  expect(pagebar.height).toBeGreaterThanOrEqual(92);
  expect(pagebar.paddingTop).toBe(18);
  expect(pagebar.paddingLeft).toBe(22);
  expect(pagebar.radius).toBe(0);
  expect(pagebar.eyebrowSize).toBe(12);
  expect(pagebar.titleSize).toBeCloseTo(28, 1);
  expect(pagebar.subtitleSize).toBe(12);
  expect(pagebar.scopeHeight).toBeGreaterThanOrEqual(44);

  const workspace = await page.locator(".memory-review-layout").evaluate((layout) => {
    const main = layout.querySelector<HTMLElement>("main")!;
    const layoutRect = layout.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return {
      mainOverflow: getComputedStyle(main).overflowY,
      mainWidth: mainRect.width,
      layoutWidth: layoutRect.width,
    };
  });
  expect(workspace.mainOverflow).toBe("auto");
  expect(workspace.layoutWidth - workspace.mainWidth).toBeLessThanOrEqual(50);

  const navigation = await page.locator(".memory-view-tabs").evaluate((nav) => {
    const tabs = Array.from(nav.querySelectorAll<HTMLElement>('[role="tab"]'));
    const tab = tabs[0]!;
    const count = tab.querySelector<HTMLElement>("b")!;
    const navStyle = getComputedStyle(nav);
    const tabStyle = getComputedStyle(tab);
    return {
      width: nav.getBoundingClientRect().width,
      paddingTop: Number.parseFloat(navStyle.paddingTop),
      paddingLeft: Number.parseFloat(navStyle.paddingLeft),
      radius: Number.parseFloat(navStyle.borderTopLeftRadius),
      tabHeight: tab.getBoundingClientRect().height,
      tabSize: Number.parseFloat(tabStyle.fontSize),
      tabRadius: Number.parseFloat(tabStyle.borderTopLeftRadius),
      countSize: Number.parseFloat(getComputedStyle(count).fontSize),
      horizontal: tabs.length > 1 && Math.abs(tabs[1].getBoundingClientRect().top - tab.getBoundingClientRect().top) < 2,
    };
  });
  expect(navigation.width).toBeGreaterThan(700);
  expect(navigation.paddingTop).toBe(4);
  expect(navigation.paddingLeft).toBe(10);
  expect(navigation.radius).toBe(0);
  expect(navigation.tabHeight).toBeGreaterThanOrEqual(40);
  expect(navigation.tabSize).toBe(12);
  expect(navigation.tabRadius).toBe(9);
  expect(navigation.countSize).toBe(10);
  expect(navigation.horizontal).toBe(true);

  const piloSize = await page.locator(".pilo-companion__pet").evaluate((pet) => {
    const avatar = pet.querySelector<HTMLElement>(".pilo-avatar");
    return {
      width: pet.getBoundingClientRect().width,
      height: pet.getBoundingClientRect().height,
      avatar: avatar?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(piloSize.width).toBe(112);
  expect(piloSize.height).toBe(122);
  expect(piloSize.avatar).toBe(104);

  await expect(page.getByRole("button", { name: "这页如何使用" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "记忆画像使用说明" })).toHaveCount(0);

  const firstPattern = page.locator(".memory-pattern-summary").first();
  await expect(firstPattern).toContainText("影响");
  await expect(firstPattern).toContainText("相对稳定信号");
  await expect(firstPattern).toHaveAttribute("aria-expanded", "false");
  await firstPattern.click();
  await expect(firstPattern).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".memory-evidence-summary")).toContainText("支持记录16");
  await expect(page.locator(".memory-evidence-summary")).toContainText("反向记录2");
  await expect(page.getByRole("button", { name: "确认准确" })).toBeVisible();
  await expect(page.getByRole("button", { name: "修改表述" })).toBeVisible();
  await page.getByText("更多管理", { exact: true }).click();
  await expect(page.getByRole("button", { name: "暂停使用" })).toBeVisible();
  await expect(page.getByRole("button", { name: "永久遗忘" })).toBeVisible();
  await page.getByRole("button", { name: "暂停使用" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("暂停使用这条观察");
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("link", { name: "解释依据" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "与 Pilo 核对" }).first()).toHaveAttribute("href", /prompt=/);
  await expect(page.getByRole("heading", { name: "暂不影响建议的观察" })).toBeVisible();
  await page.getByRole("tab", { name: /记忆内容/ }).click();
  await expect(page.getByRole("heading", { name: "记忆内容" })).toBeVisible();
  await expect(page.getByRole("img", { name: "学习内容保持率随时间变化的曲线" })).toBeVisible();
  await page.getByRole("tab", { name: /可信度与验证/ }).click();
  await expect(page.getByRole("heading", { name: "系统如何验证这些观察" })).toBeVisible();
  await page.getByText("展示规则与我的数据资格", { exact: true }).click();
  await expect(page.getByText("测试或合成数据只用于验证管线", { exact: false })).toBeVisible();
  await expect(page.locator(".memory-validation-results")).toBeHidden();
  await page.getByText("查看技术指标", { exact: true }).click();
  const validation = page.locator(".memory-validation-results");
  await expect(validation).toContainText("已支持");
  await expect(validation).toContainText("不支持");
  await expect(validation).toContainText("数据不足");
  await expect(validation).toContainText("未配置");
  await expect(validation).toContainText("Brier Score");
  await expect(validation).toContainText("0.473");
  await expect(validation).toContainText("ECE");
  await expect(validation).toContainText("+41.0pp");
  await expect(validation).toContainText("90 天窗口");
  await expect(page.getByText("可进入真实证据队列", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: /操作记录/ }).click();
  await expect(page.getByRole("heading", { name: "画像审计与撤销" })).toBeVisible();
  await expect(page.getByRole("button", { name: "撤销" })).toBeVisible();
});

test("学习记忆在窄屏保持可读和可操作", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openAuthenticatedMemory(page);
  await expect(page.getByRole("heading", { name: "学习记忆", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "筛选学习规律" })).toHaveCount(0);

  const layout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth,
    viewRailWidth: document.querySelector(".memory-view-tabs")?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY,
    tabHeights: Array.from(document.querySelectorAll(".memory-view-tabs button"), (element) => element.getBoundingClientRect().height),
    piloWidth: document.querySelector(".pilo-companion__pet")?.getBoundingClientRect().width ?? 0,
    piloAvatar: document.querySelector(".pilo-companion__pet .pilo-avatar")?.getBoundingClientRect().width ?? 0,
  }));

  expect(layout.contentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.viewRailWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.tabHeights.every((height) => height >= 44)).toBe(true);
  expect(layout.piloWidth).toBe(90);
  expect(layout.piloAvatar).toBe(84);
  await expect(page.locator(".pilo-scene")).toBeHidden();
});
