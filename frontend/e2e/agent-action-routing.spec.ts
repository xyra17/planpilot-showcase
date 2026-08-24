import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";

test.skip(
  process.env.PLANPILOT_E2E !== "1",
  "Set PLANPILOT_E2E=1 when the real backend, worker and frontend are running"
);

type ActionApproval = {
  id: string;
  change_hash: string;
  change_set_version: number;
  run_state_version: number;
  change_set: {
    operations: Array<{ entity_id: string; field: string; before: unknown; after: unknown }>;
  };
  policy_decision: {
    outcome: string;
    risk: string;
    review_finding_codes: string[];
  };
};

type ActionRun = {
  id: string;
  status: string;
  approvals: ActionApproval[];
};

async function createActionFixture(
  request: APIRequestContext,
  context: BrowserContext,
  label: string,
  options: { deadlineDays?: number; estimatedMinutes?: number } = {},
) {
  const unique = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const username = `action${unique}`.slice(0, 28);
  const registered = await request.post("/api/backend/api/v1/auth/register", {
    data: {
      email: `${username}@example.com`,
      username,
      password: "PlanPilot-action-2026",
    },
  });
  expect(registered.status()).toBe(201);
  const csrf = (await context.cookies()).find((cookie) => cookie.name === "pp_csrf")?.value;
  expect(csrf).toBeTruthy();
  const headers = { "X-CSRF-Token": csrf! };
  const deadline = new Date(
    Date.now() + (options.deadlineDays ?? 30) * 86_400_000,
  ).toISOString().slice(0, 10);
  const goalResponse = await request.post("/api/backend/api/v1/goals", {
    headers,
    data: {
      type: "skill",
      title: `行动验收目标 ${label}`,
      deadline,
      daily_hours: 1,
      current_level: "beginner",
      work_schedule: "all",
    },
  });
  expect(goalResponse.ok()).toBeTruthy();
  const goal = (await goalResponse.json()) as { id: string };
  const sourceDate = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const taskResponse = await request.post("/api/backend/api/v1/tasks", {
    headers,
    data: {
      title: label,
      goalId: goal.id,
      date: sourceDate,
      estimatedMinutes: options.estimatedMinutes ?? 30,
    },
  });
  expect(taskResponse.ok()).toBeTruthy();
  const task = (await taskResponse.json()) as { id: string };
  return { headers, goalId: goal.id, taskId: task.id, sourceDate, deadline };
}

async function waitForRun(
  request: APIRequestContext,
  headers: Record<string, string>,
  runId: string,
  status: string,
): Promise<ActionRun> {
  let detail: ActionRun | undefined;
  await expect.poll(async () => {
    const response = await request.get(`/api/backend/api/v2/agent/runs/${runId}`, { headers });
    expect(response.ok()).toBeTruthy();
    detail = (await response.json()) as ActionRun;
    return detail.status;
  }, { timeout: 90_000 }).toBe(status);
  return detail!;
}

async function createSafePreview(
  request: APIRequestContext,
  headers: Record<string, string>,
  goalId: string,
  taskTitle: string,
) {
  const created = await request.post("/api/backend/api/v2/agent/runs", {
    headers,
    data: { request: `把任务“${taskTitle}”改到明天，执行前确认`, goal_id: goalId },
  });
  expect(created.status()).toBe(201);
  const run = (await created.json()) as ActionRun;
  return waitForRun(request, headers, run.id, "waiting_approval");
}

test("学习伙伴将明确任务变更分流为可确认行动", async ({ page, context }, testInfo) => {
  const unique = Date.now().toString();
  const username = `action${unique}`.slice(0, 28);
  const register = await page.request.post("/api/backend/api/v1/auth/register", {
    data: {
      email: `${username}@example.com`,
      username,
      password: "PlanPilot-action-2026",
    },
  });
  expect(register.status()).toBe(201);

  const csrf = (await context.cookies()).find((cookie) => cookie.name === "pp_csrf")?.value;
  expect(csrf).toBeTruthy();
  const headers = { "X-CSRF-Token": csrf! };
  const deadline = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const goalResponse = await page.request.post("/api/backend/api/v1/goals", {
    headers,
    data: {
      type: "skill",
      title: "行动验收目标",
      deadline,
      daily_hours: 1,
      current_level: "beginner",
      work_schedule: "all",
    },
  });
  expect(goalResponse.ok()).toBeTruthy();
  const goal = await goalResponse.json() as { id: string };
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const taskResponse = await page.request.post("/api/backend/api/v1/tasks", {
    headers,
    data: {
      title: "逾期练习",
      goalId: goal.id,
      date: yesterday,
      estimatedMinutes: 30,
    },
  });
  expect(taskResponse.ok()).toBeTruthy();

  await page.goto(`/studio/coach?goal=${encodeURIComponent(goal.id)}`);
  await expect(page.getByText("Pilo 的观察", { exact: true })).toBeVisible();
  const composer = page.getByPlaceholder("把现在的情况告诉 Pilo…");
  await composer.fill("把所有逾期任务重新安排到未来一周");
  const send = page.getByRole("button", { name: "发送给 Pilo" });
  await expect(send).toBeEnabled();
  await send.click();

  await expect(page.getByText("这是一个会影响学习数据的行动请求。")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Pilo 行动任务" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("确认前不会修改你的学习数据。")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: "确认执行" })).toBeVisible();
  await expect(page.getByRole("button", { name: "暂不执行" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("action-run-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "拉灯切换到深色模式" }).click();
  await expect(page.locator(".companion-workspace")).toHaveClass(/is-dark/);
  const darkActionColors = await page.getByRole("region", { name: "Pilo 行动任务" }).evaluate((region) => {
    const title = region.querySelector("h3");
    const operation = region.querySelector(".companion-action-operations > li > span");
    const operationDetail = region.querySelector(".companion-action-operations > li > p");
    const divider = region.querySelector(".companion-action-operations > li");
    return {
      title: title ? getComputedStyle(title).color : "",
      operation: operation ? getComputedStyle(operation).color : "",
      operationDetail: operationDetail ? getComputedStyle(operationDetail).color : "",
      divider: divider ? getComputedStyle(divider).borderTopColor : "",
    };
  });
  expect(darkActionColors).toEqual({
    title: "rgb(242, 245, 250)",
    operation: "rgb(242, 245, 250)",
    operationDetail: "rgb(189, 199, 215)",
    divider: "rgba(190, 201, 222, 0.2)",
  });
  await page.screenshot({ path: testInfo.outputPath("action-run-dark.png"), fullPage: true });
  await page.getByRole("button", { name: "拉灯切换到明亮模式" }).click();
  await expect(page.locator(".companion-workspace")).toHaveClass(/is-light/);

  await page.setViewportSize({ width: 1000, height: 800 });
  const compactActionRegion = page.getByRole("region", { name: "Pilo 行动任务" });
  await compactActionRegion.scrollIntoViewIfNeeded();
  const compactGeometry = await Promise.all([
    compactActionRegion.boundingBox(),
    page.locator(".companion-feed").boundingBox(),
  ]);
  expect((compactGeometry[0]?.x ?? 0) + (compactGeometry[0]?.width ?? 0))
    .toBeLessThanOrEqual((compactGeometry[1]?.x ?? 0) + (compactGeometry[1]?.width ?? 0));
  await expect(compactActionRegion.getByRole("button", { name: "确认执行" })).toBeVisible();
  await expect(compactActionRegion.getByText("等你确认", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("region", { name: "Pilo 行动任务" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "确认执行" })).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(hasHorizontalOverflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("action-run-mobile.png"), fullPage: true });

  const actionRegion = page.getByRole("region", { name: "Pilo 行动任务" });
  await actionRegion.getByRole("button", { name: "确认执行" }).click();
  await expect(actionRegion.getByText("已完成", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await expect(actionRegion.getByRole("button", { name: "撤销这次修改" })).toBeVisible();
  await actionRegion.getByRole("button", { name: "撤销这次修改" }).click();
  await expect(actionRegion.getByText("已撤销", { exact: true }).first()).toBeVisible({ timeout: 90_000 });
});

test("编辑安全预览到截止日期后会被结构化 Review 阻断", async ({ page, context }) => {
  const fixture = await createActionFixture(page.request, context, "E2E 截止日期审查");
  const run = await createSafePreview(
    page.request,
    fixture.headers,
    fixture.goalId,
    "E2E 截止日期审查",
  );
  const approval = run.approvals[0];
  const blockedDate = new Date(`${fixture.deadline}T00:00:00Z`);
  blockedDate.setUTCDate(blockedDate.getUTCDate() + 1);
  approval.change_set.operations[0].after = blockedDate.toISOString().slice(0, 10);
  const edited = await page.request.patch(
    `/api/backend/api/v2/agent/runs/${run.id}/approvals/${approval.id}`,
    { headers: fixture.headers, data: { change_set: approval.change_set } },
  );
  expect(edited.ok()).toBeTruthy();
  const rebound = ((await edited.json()) as ActionRun).approvals[0];
  expect(rebound.policy_decision.outcome).toBe("deny");
  expect(rebound.policy_decision.review_finding_codes).toContain("deadline_exceeded");

  const blocked = await page.request.post(`/api/backend/api/v2/agent/runs/${run.id}/approve`, {
    headers: fixture.headers,
    data: {
      approval_id: rebound.id,
      change_hash: rebound.change_hash,
      change_set_version: rebound.change_set_version,
      run_state_version: rebound.run_state_version,
    },
  });
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).detail.code).toBe("review_blocked");
  const tasks = (await (
    await page.request.get("/api/backend/api/v1/tasks", { headers: fixture.headers })
  ).json()) as Array<{ id: string; date: string }>;
  expect(tasks.find((task) => task.id === fixture.taskId)?.date).toBe(fixture.sourceDate);
});

test("风险升级后必须二次确认且执行结果可以撤销", async ({ page, context }) => {
  const fixture = await createActionFixture(page.request, context, "E2E 高风险移动");
  const run = await createSafePreview(
    page.request,
    fixture.headers,
    fixture.goalId,
    "E2E 高风险移动",
  );
  const overloadedDate = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const capacity = await page.request.post("/api/backend/api/v1/tasks", {
    headers: fixture.headers,
    data: {
      title: "E2E 容量占用",
      goalId: fixture.goalId,
      date: overloadedDate,
      estimatedMinutes: 180,
    },
  });
  expect(capacity.ok()).toBeTruthy();
  const approval = run.approvals[0];
  approval.change_set.operations[0].after = overloadedDate;
  const edited = await page.request.patch(
    `/api/backend/api/v2/agent/runs/${run.id}/approvals/${approval.id}`,
    { headers: fixture.headers, data: { change_set: approval.change_set } },
  );
  expect(edited.ok()).toBeTruthy();
  const rebound = ((await edited.json()) as ActionRun).approvals[0];
  expect(rebound.policy_decision.risk).toBe("high");

  const unconfirmed = await page.request.post(
    `/api/backend/api/v2/agent/runs/${run.id}/approve`,
    {
      headers: fixture.headers,
      data: { approval_id: rebound.id, change_hash: rebound.change_hash },
    },
  );
  expect(unconfirmed.status()).toBe(409);
  const confirmed = await page.request.post(`/api/backend/api/v2/agent/runs/${run.id}/approve`, {
    headers: fixture.headers,
    data: {
      approval_id: rebound.id,
      change_hash: rebound.change_hash,
      change_set_version: rebound.change_set_version,
      run_state_version: rebound.run_state_version,
      high_risk_confirmed: true,
    },
  });
  expect(confirmed.ok()).toBeTruthy();
  await waitForRun(page.request, fixture.headers, run.id, "completed");

  const changed = (await (
    await page.request.get("/api/backend/api/v1/tasks", { headers: fixture.headers })
  ).json()) as Array<{ id: string; date: string }>;
  expect(changed.find((task) => task.id === fixture.taskId)?.date).toBe(overloadedDate);
  const undone = await page.request.post(`/api/backend/api/v2/agent/runs/${run.id}/undo`, {
    headers: fixture.headers,
  });
  expect(undone.ok()).toBeTruthy();
  const restored = (await (
    await page.request.get("/api/backend/api/v1/tasks", { headers: fixture.headers })
  ).json()) as Array<{ id: string; date: string }>;
  expect(restored.find((task) => task.id === fixture.taskId)?.date).toBe(fixture.sourceDate);
});
