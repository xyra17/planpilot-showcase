import { expect, test, type Page } from "@playwright/test";

const modelRoles = {
  interactive: { purpose: "普通聊天、打卡回应、短解释和笔记辅助", primary: "local", primary_model: "/models/Qwen3.5-9B-MLX-4bit", fallback: "cloud", fallback_model: "glm-5.3", fallback_policy: "本地模型不可用、报错或队列超时后回退", result: "自然语言", max_concurrency: 2 },
  structured: { purpose: "宏观计划、每日任务、验收出题、Agent 规划和建议 JSON", primary: "cloud", primary_model: "glm-5.3", fallback: "local", fallback_model: "/models/Qwen3.5-9B-MLX-4bit", fallback_policy: "主模型不可用或契约失败时换路重试", result: "结构化结果", max_concurrency: 6 },
  critical: { purpose: "学习答案评分和需要高质量终审的复杂决策", primary: "cloud-pro", primary_model: "glm-5.3-pro", fallback: null, fallback_model: null, fallback_policy: "不静默降级；失败时显式报错", result: "高质量判断", max_concurrency: 2 },
  embedding: { purpose: "知识库向量化和语义检索", primary: "embedding-local", primary_model: "/models/Qwen3-Embedding-0.6B.gguf", fallback: "keyword-search", fallback_model: null, fallback_policy: "向量无有效结果时使用数据库原文包含匹配", result: "1024 维向量", max_concurrency: 3 },
};

async function mockAdminOverview(page: Page) {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { id: "admin", email: "admin@example.com", username: "管理员", is_admin: true, onboarding_completed: true, timezone: "Asia/Shanghai" } }));
  await page.route("**/api/v1/agent-control/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/overview")) return route.fulfill({ json: {
      strategy: { prompt: "prompt-v1", model: "glm-5.3", policy: "policy-v1", deployment_revision: 1 },
      metrics: { invocation_count: 12, success_rate: 0.98, proposal_count: 8, helpful_rate: 0.75 },
      safety: { requires_user_confirmation: true, direct_mutation_allowed: false },
      model_roles: modelRoles,
      monitoring: { current: null, history: [], drift: { status: "insufficient_data", success_rate_delta: null }, open_incidents: [] },
      feedback_learning: { event_count: 0, delayed_outcome_count: 0, metric_version: "v1" },
      latest_evaluation: null,
      canary: null,
      calibration: { prediction_type: "acceptance", algorithm_version: "v1", sample_count: 0, outcome_count: 0, outcome_coverage: null, brier_score: null, expected_calibration_error: null, status: "insufficient_data", calculated_at: null },
    } });
    if (pathname.endsWith("/versions")) return route.fulfill({ json: { prompts: [], models: [], policies: [], deployments: [] } });
    if (pathname.endsWith("/admin/product-validation/latest")) return route.fulfill({ json: null });
    return route.fulfill({ json: [] });
  });
}

test("模型路由卡片具有清晰层级并显示运行时模型与并发", async ({ page }) => {
  await mockAdminOverview(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin");

  const section = page.getByTestId("runtime-model-roles");
  await expect(section).toBeVisible();
  const structuredCard = page.getByTestId("model-role-structured");
  await expect(structuredCard.getByText("云端日常模型 · glm-5.3", { exact: true })).toBeVisible();
  await expect(structuredCard.getByText("并发上限 6", { exact: true })).toBeVisible();

  const title = section.getByRole("heading", { name: "对话模型" });
  const description = section.getByText("日常问答与交流", { exact: true });
  const [titleSize, descriptionSize] = await Promise.all([
    title.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    description.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  expect(titleSize).toBeGreaterThan(descriptionSize);
  expect(descriptionSize).toBeGreaterThanOrEqual(14);

  const card = page.getByTestId("model-role-interactive");
  const verticalGap = await card.evaluate((element) => {
    const purpose = element.querySelector(":scope > p");
    const routes = element.querySelector("dl");
    if (!purpose || !routes) return 999;
    return routes.getBoundingClientRect().top - purpose.getBoundingClientRect().bottom;
  });
  expect(verticalGap).toBeLessThanOrEqual(24);

  await page.screenshot({ path: "test-results/admin-model-roles.png", fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.getByTestId("runtime-model-roles")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
