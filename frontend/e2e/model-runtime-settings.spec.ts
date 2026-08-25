import { expect, test, type Page } from "@playwright/test";

const settings = {
  local_enabled: true,
  local_base_url: "http://host.docker.internal:8080/v1",
  local_model_name: "/models/Qwen3.5-9B-MLX-4bit",
  local_api_key_configured: true,
  local_max_concurrency: 1,
  cloud_enabled: false,
  cloud_provider: "deepseek",
  cloud_base_url: "https://api.deepseek.com",
  cloud_model_name: "deepseek-v4-flash",
  cloud_pro_model_name: "deepseek-v4-pro",
  cloud_api_key_configured: false,
  cloud_routine_max_concurrency: 4,
  cloud_pro_max_concurrency: 1,
  embedding_enabled: true,
  embedding_base_url: "http://host.docker.internal:1234/v1",
  embedding_model_name: "/models/Qwen3-Embedding-0.6B.gguf",
  embedding_dimensions: 1024,
  embedding_api_key_configured: true,
  embedding_max_concurrency: 1,
  coach_agent_enabled: true,
  updated_at: null,
  updated_by: null,
};

async function mockModelSettings(page: Page) {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { id: "admin", email: "admin@example.com", username: "管理员", is_admin: true, onboarding_completed: true, timezone: "Asia/Shanghai" } }));
  await page.route("**/api/v1/agent-control/gateway/circuits", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/admin/model-settings/probe", (route) => route.fulfill({ json: [
    { target: "local", configured: true, reachable: true, model_match: true, advertised_models: [settings.local_model_name], detail: "连接成功" },
    { target: "cloud", configured: true, reachable: true, model_match: true, advertised_models: ["glm-5"], detail: "连接成功" },
    { target: "embedding", configured: true, reachable: true, model_match: true, advertised_models: [settings.embedding_model_name], detail: "连接成功" },
  ] }));
  await page.route("**/api/v1/admin/model-settings", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      return route.fulfill({ json: { ...settings, ...body, cloud_api_key_configured: Boolean(body.cloud_api_key) } });
    }
    return route.fulfill({ json: settings });
  });
}

test("管理员可以选择供应商、保存密钥并检查模型连接", async ({ page }) => {
  await mockModelSettings(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin/gateway");

  await expect(page.getByRole("heading", { name: "模型运行配置" })).toBeVisible();
  await page.getByRole("button", { name: "智谱 GLM" }).click();
  await expect(page.getByRole("textbox", { name: "Base URL", exact: true })).toHaveValue("https://open.bigmodel.cn/api/paas/v4");
  await page.getByRole("switch", { name: "启用云端模型" }).click();
  await page.getByRole("spinbutton", { name: "任务模型并发上限" }).fill("6");
  await page.getByRole("textbox", { name: "API Key 密钥只写入后端加密文件，不会回显。" }).fill("test-secret");
  await page.getByRole("button", { name: "保存并切换" }).click();
  await expect(page.getByText("模型配置已加密保存，新的 API 与 Worker 调用会立即使用。")).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "任务模型并发上限" })).toHaveValue("6");
  await expect(page.getByRole("textbox", { name: "API Key 密钥只写入后端加密文件，不会回显。" })).toHaveValue("");

  await page.getByRole("button", { name: "检查已保存连接" }).click();
  await expect(page.getByText("连接检查完成。")).toBeVisible();
  await expect(page.getByText("本机模型", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "模型运行配置" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
