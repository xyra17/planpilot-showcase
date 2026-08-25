import { expect, test } from "@playwright/test";

const goal = {
  id: "goal-tech-1",
  type: "skill",
  title: "agent 开发",
  deadline: "2026-08-31",
  daily_hours: 5,
  current_level: "beginner",
  status: "active",
  meta: {},
  created_at: "2026-08-01T00:00:00Z",
  work_schedule: "all",
  kb_id: null,
};

test("科技目标列表保留完整入口并进入目标工作台", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const historicalTask = {
    id: "task-history-1",
    title: "动态规划历史复盘",
    description: "已归档的历史任务",
    goalId: "1",
    goalTitle: "算法基础体系化",
    done: true,
    estimatedMinutes: 40,
    date: "2026-08-02",
    priority: "medium",
  };
  await page.addInitScript((task) => {
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify([task]));
  }, historicalTask);
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: [historicalTask] }));
  await page.goto("/studio/work/goals");

  const titlebar = page.locator(".goals-redesign-heading");
  const goalsPanel = page.locator(".goals-list-panel");
  await expect(page.getByRole("heading", { name: "我的目标", exact: true })).toBeVisible();
  await expect(titlebar.getByRole("textbox", { name: "搜索全部任务，包括历史任务" })).toBeVisible();
  await expect(titlebar.getByRole("button", { name: "执行任务搜索" })).toBeVisible();
  await expect(titlebar.getByRole("button", { name: "高级筛选目标" })).toHaveAttribute("data-tooltip", "高级筛选：按目标状态查看");
  await expect(titlebar.getByRole("button", { name: "新建目标", exact: true })).toHaveCount(0);
  await expect(goalsPanel.getByRole("button", { name: "新建目标", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "目标回顾" })).toHaveCount(0);
  const goalDensity = await page.locator(".goals-redesign-grid").evaluate((grid) => {
    const titlebar = document.querySelector(".goals-redesign-heading")?.getBoundingClientRect();
    const row = grid.querySelector(".goal-list-row")?.getBoundingClientRect();
    const panel = grid.querySelector(".goals-list-panel")?.getBoundingClientRect();
    const side = grid.querySelector(".goals-side-stack")?.getBoundingClientRect();
    return {
      titleHeight: titlebar?.height ?? 0,
      rowHeight: row?.height ?? Number.POSITIVE_INFINITY,
      bottomDelta: panel && side ? Math.abs(panel.bottom - side.bottom) : Number.POSITIVE_INFINITY,
    };
  });
  expect(goalDensity.rowHeight).toBeLessThanOrEqual(76);
  expect(goalDensity.rowHeight).toBeLessThan(goalDensity.titleHeight * 0.85);
  expect(goalDensity.bottomDelta).toBeLessThanOrEqual(1);
  const goalMotion = await goalsPanel.locator(".goal-list-row").first().evaluate((row) => {
    const progress = row.querySelector<HTMLElement>(".goal-list-detail-line > i span");
    return {
      rowAnimation: getComputedStyle(row).animationName,
      progressAnimation: progress ? getComputedStyle(progress).animationName : "",
      progressOrigin: progress ? getComputedStyle(progress).transformOrigin : "",
    };
  });
  expect(goalMotion.rowAnimation).toContain("goal-list-row-enter");
  expect(goalMotion.progressAnimation).toContain("goal-list-progress-grow");
  expect(goalMotion.progressOrigin).toMatch(/^0px /);
  await titlebar.getByRole("textbox", { name: "搜索全部任务，包括历史任务" }).fill("动态规划历史复盘");
  await titlebar.getByRole("button", { name: "执行任务搜索" }).click();
  await expect(page.getByRole("button", { name: /动态规划历史复盘/ })).toContainText("已完成");
  await expect(page.locator(".goal-milestones-list")).toHaveCSS("overflow-y", "auto");
  await expect(page.locator(".goal-milestone-status").first()).toBeVisible();
  const milestoneSwitcher = page.getByRole("button", { name: "切换目标动态范围：全部目标" });
  await expect(milestoneSwitcher).toBeVisible();
  await milestoneSwitcher.click();
  const milestoneScopeMenu = page.getByRole("listbox", { name: "目标动态范围" });
  await expect(milestoneScopeMenu.getByRole("option")).toHaveCount(3);
  await expect(milestoneScopeMenu.getByRole("option", { name: /英文技术阅读/ })).toHaveCount(0);
  await milestoneScopeMenu.getByRole("option", { name: /前端面试准备/ }).click();
  await expect(page.getByRole("button", { name: "切换目标动态范围：前端面试准备" })).toBeVisible();
  const scopedMilestones = page.locator(".goal-milestone-title");
  await expect(scopedMilestones.first()).toContainText("前端面试准备");
  expect((await scopedMilestones.allTextContents()).every((text) => text.includes("前端面试准备"))).toBe(true);
  await expect(page.getByRole("link", { name: "查看目标 算法基础体系化" })).toBeVisible();
  const goalMenuTrigger = page.getByLabel("管理目标 算法基础体系化");
  await expect(goalMenuTrigger).not.toHaveAttribute("data-tooltip", /.+/);
  await goalMenuTrigger.click();
  const editGoalAction = page.getByRole("menuitem", { name: "编辑目标 算法基础体系化" });
  await expect(editGoalAction).toBeVisible();
  await editGoalAction.click();
  await expect(page).toHaveURL(/\/studio\/work\/goals\/1\/edit$/);
  const editGoalDialog = page.getByRole("dialog", { name: "编辑目标" });
  await expect(editGoalDialog).toBeVisible();
  await expect(editGoalDialog.getByRole("textbox", { name: "目标名称" })).toHaveValue("算法基础体系化");
  await editGoalDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editGoalDialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/studio\/work\/goals\/1$/);
  await page.goto("/studio/work/goals");
  await goalMenuTrigger.click();
  const deleteGoalAction = page.getByRole("menuitem", { name: "删除目标 算法基础体系化" });
  await expect(deleteGoalAction).toBeVisible();
  await deleteGoalAction.click();
  const deleteGoalDialog = page.getByRole("alertdialog", { name: "删除目标“算法基础体系化”？" });
  await expect(deleteGoalDialog).toBeVisible();
  await expect(deleteGoalDialog).toHaveClass(/pp-confirm-dialog/);
  await expect(deleteGoalDialog).toContainText("目标关联的计划与任务将一并删除");
  await expect(deleteGoalDialog.getByRole("button", { name: "确认删除" })).toHaveClass(/pp-danger-button/);
  await deleteGoalDialog.getByRole("button", { name: "保留目标" }).click();
  await expect(deleteGoalDialog).toHaveCount(0);

  await titlebar.getByRole("textbox", { name: "搜索全部任务，包括历史任务" }).fill("动态规划历史复盘");
  await titlebar.getByRole("button", { name: "执行任务搜索" }).click();
  await page.getByRole("button", { name: /动态规划历史复盘/ }).click();
  await expect(page).toHaveURL(/\/studio\/work\/goals\/1\?taskId=task-history-1/);
  await expect(page.getByText("算法基础体系化", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("group", { name: "目标与执行指标" })).toBeVisible();
  await expect(page.getByText("我的目标", { exact: true })).toHaveCount(0);
  await expect(page.getByText("目标进度", { exact: true })).toHaveCount(0);
  await expect(page.getByText("根据当前任务与学习记录计算", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/剩余 \d+ 天/)).toHaveCount(0);
  await expect(page.getByText("每日计划投入 1 小时", { exact: true })).toBeVisible();
  await expect(page.locator('[data-search-target="true"]')).toContainText("动态规划历史复盘");
});

test("目标列表在减少动态效果时保持静态", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/studio/work/goals");
  const motion = await page.locator(".goal-list-row").first().evaluate((row) => {
    const progress = row.querySelector<HTMLElement>(".goal-list-detail-line > i span");
    return {
      rowAnimation: getComputedStyle(row).animationName,
      rowTransition: getComputedStyle(row).transitionDuration,
      progressAnimation: progress ? getComputedStyle(progress).animationName : "",
    };
  });
  expect(["", "none"]).toContain(motion.rowAnimation);
  expect(["", "none"]).toContain(motion.progressAnimation);
  expect(motion.rowTransition === "" || motion.rowTransition.split(", ").every((duration) => duration === "0s")).toBe(true);
});

test("目标卡片状态标签保持紧凑", async ({ page }) => {
  await page.goto("/studio/work/goals");
  const status = page.locator(".goal-list-status").first();
  await expect(status).toBeVisible();
  const metrics = await status.evaluate((element) => {
    const styles = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      fontSize: Number.parseFloat(styles.fontSize),
      height: rect.height,
      width: rect.width,
      paddingLeft: Number.parseFloat(styles.paddingLeft),
    };
  });
  expect(metrics.fontSize).toBe(10);
  expect(metrics.height).toBeLessThanOrEqual(19);
  expect(metrics.width).toBeLessThanOrEqual(43);
  expect(metrics.paddingLeft).toBe(5);
});

test("目标页普通二级菜单点击外部关闭并说明入口用途", async ({ page }) => {
  const nearDeadline = new Date();
  nearDeadline.setDate(nearDeadline.getDate() + 2);
  const nearDeadlineIso = [
    nearDeadline.getFullYear(),
    String(nearDeadline.getMonth() + 1).padStart(2, "0"),
    String(nearDeadline.getDate()).padStart(2, "0"),
  ].join("-");
  await page.addInitScript(({ deadline }) => {
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
    window.localStorage.setItem("planpilot-v2-goals", JSON.stringify([
      {
        id: 1, name: "临期复习计划", type: "考试备考", progress: 32, deadline: "两天后", deadlineDate: deadline,
        daily: "45 分钟", status: "有风险", next: "重新安排复习范围", taskSummary: "4 / 12 个任务", rhythmSummary: "3 项知识待复习", debtCount: 3,
      },
      {
        id: 2, name: "长期阅读计划", type: "阅读计划", progress: 48, deadline: "长期",
        daily: "20 分钟", status: "进行中", next: "继续阅读下一章", taskSummary: "6 / 15 个任务", rhythmSummary: "连续学习 4 天",
      },
    ]));
  }, { deadline: nearDeadlineIso });
  await page.goto("/studio/work/goals");

  const goalMenuTrigger = page.getByLabel("管理目标 临期复习计划");
  await expect(goalMenuTrigger).not.toHaveAttribute("data-tooltip", /.+/);
  await goalMenuTrigger.click();
  const editMenuItem = page.getByRole("menuitem", { name: "编辑目标 临期复习计划" });
  await expect(editMenuItem).toBeVisible();
  const actionMenuAppearance = await editMenuItem.evaluate((item) => {
    const menu = item.parentElement!;
    const style = getComputedStyle(menu);
    return { borderRadius: style.borderRadius, padding: style.padding, animationName: style.animationName };
  });
  await page.getByRole("heading", { name: "目标管理" }).click();
  await expect(page.getByRole("menuitem", { name: "编辑目标 临期复习计划" })).not.toBeVisible();

  const filterTrigger = page.getByRole("button", { name: "高级筛选目标" });
  await filterTrigger.click();
  const advancedFilterMenu = page.getByRole("menu");
  await expect(advancedFilterMenu.getByRole("menuitem", { name: "只看有风险" })).toBeVisible();
  await expect(filterTrigger).not.toHaveAttribute("data-tooltip");
  const advancedFilterLayer = await advancedFilterMenu.evaluate((menu) => {
    const menuRect = menu.getBoundingClientRect();
    const pagebar = menu.closest(".goals-redesign-heading");
    const style = getComputedStyle(menu);
    return {
      zIndex: Number.parseInt(getComputedStyle(menu).zIndex, 10),
      pagebarOverflow: pagebar ? getComputedStyle(pagebar).overflow : "",
      insideViewport: menuRect.right <= window.innerWidth && menuRect.bottom <= window.innerHeight,
      borderRadius: style.borderRadius,
      padding: style.padding,
      animationName: style.animationName,
    };
  });
  expect(advancedFilterLayer.zIndex).toBeGreaterThanOrEqual(40);
  expect(advancedFilterLayer.pagebarOverflow).toBe("visible");
  expect(advancedFilterLayer.insideViewport).toBe(true);
  await page.getByRole("heading", { name: "目标管理" }).click();
  await expect(page.getByRole("menuitem", { name: "只看有风险" })).toHaveCount(0);

  const milestoneTrigger = page.getByRole("button", { name: "切换目标动态范围：全部目标" });
  await expect(milestoneTrigger).toHaveAttribute("data-tooltip", "切换目标动态范围");
  await milestoneTrigger.click();
  const milestoneScopeMenu = page.getByRole("listbox", { name: "目标动态范围" });
  await expect(milestoneScopeMenu).toBeVisible();
  const milestoneTypography = await milestoneScopeMenu.evaluate((menu) => {
    const title = menu.querySelector("strong");
    const description = menu.querySelector("small");
    const panel = menu.closest(".goal-milestones-panel");
    return {
      triggerSize: Number.parseFloat(getComputedStyle(document.querySelector(".goal-milestone-switcher-trigger")!).fontSize),
      titleSize: title ? Number.parseFloat(getComputedStyle(title).fontSize) : 0,
      descriptionSize: description ? Number.parseFloat(getComputedStyle(description).fontSize) : Number.POSITIVE_INFINITY,
      titleColor: title ? getComputedStyle(title).color : "",
      descriptionColor: description ? getComputedStyle(description).color : "",
      descriptionTransform: description ? getComputedStyle(description).transform : "none",
      panelOverflow: panel ? getComputedStyle(panel).overflow : "",
      borderRadius: getComputedStyle(menu).borderRadius,
      padding: getComputedStyle(menu).padding,
      animationName: getComputedStyle(menu).animationName,
    };
  });
  expect(milestoneTypography.triggerSize).toBeGreaterThanOrEqual(13);
  expect(milestoneTypography.titleSize).toBeGreaterThan(milestoneTypography.descriptionSize);
  expect(milestoneTypography.titleColor).not.toBe(milestoneTypography.descriptionColor);
  expect(milestoneTypography.descriptionTransform).toBe("none");
  expect(milestoneTypography.panelOverflow).toBe("visible");
  expect([actionMenuAppearance.borderRadius, advancedFilterLayer.borderRadius, milestoneTypography.borderRadius]).toEqual(["12px", "12px", "12px"]);
  expect([actionMenuAppearance.padding, advancedFilterLayer.padding, milestoneTypography.padding]).toEqual(["6px", "6px", "6px"]);
  expect([actionMenuAppearance.animationName, advancedFilterLayer.animationName, milestoneTypography.animationName]).toEqual(["goal-popover-in", "goal-popover-in", "goal-popover-in"]);
  await page.getByRole("heading", { name: "目标管理" }).click();
  await expect(page.getByRole("listbox", { name: "目标动态范围" })).toHaveCount(0);

  const priorityColor = await page.getByText("优先处理", { exact: true }).first().evaluate((element) => getComputedStyle(element).color);
  const deadlineColor = await page.getByText("临近截止", { exact: true }).first().evaluate((element) => getComputedStyle(element).color);
  expect(priorityColor).not.toBe(deadlineColor);
});

test("目标动态滚动条右移并仅在滚动时显示", async ({ page }) => {
  await page.goto("/studio/work/goals");
  const milestoneList = page.locator(".goal-milestones-list:visible");
  await expect(milestoneList).toBeVisible();
  await expect(milestoneList).toHaveCSS("overflow-y", "auto");
  await expect(milestoneList).toHaveCSS("scrollbar-color", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");

  const milestoneScrollbarOffset = await milestoneList.evaluate((element) => {
    const list = element.getBoundingClientRect();
    const panel = element.closest(".goal-milestones-panel")?.getBoundingClientRect();
    return (panel?.right ?? list.right) - list.right;
  });
  expect(milestoneScrollbarOffset).toBeCloseTo(11, 0);

  await milestoneList.evaluate((element) => element.dispatchEvent(new Event("scroll", { bubbles: true })));
  await expect(milestoneList).toHaveClass(/is-scrolling/);
  await expect(milestoneList).not.toHaveClass(/is-scrolling/, { timeout: 1_500 });
});

test("新建目标页使用统一分步表单并完成创建", async ({ page }) => {
  let linkedGoalIds: string[] = [];
  const referenceFile = {
    id: "reference-1", name: "日语 N2 语法整理.pdf", size: "2 MB", uploadDate: "今天", type: "PDF",
    goalIds: [], kbId: "", kbIds: [], taskId: "", status: "completed", error: null, retryCount: 0,
    contentLength: 18000, summary: "N2 语法重点", sourceUrl: null, content: "", contentFormat: "plain",
  };
  const referenceFiles = [referenceFile, ...Array.from({ length: 5 }, (_, index) => ({ ...referenceFile, id: `reference-${index + 2}`, name: `日语学习资料 ${index + 2}.pdf` }))];
  await page.route("**/api/v1/knowledge/files**", async (route) => {
    if (route.request().method() === "PATCH") {
      linkedGoalIds = (route.request().postDataJSON() as { goal_ids?: string[] }).goal_ids ?? [];
      await route.fulfill({ json: { ...referenceFile, goalIds: linkedGoalIds } });
      return;
    }
    await route.fulfill({ json: { items: referenceFiles } });
  });
  await page.route("**/api/v1/agent/plan-context/**", (route) => route.fulfill({ json: { kb_overview: [], initial_understanding: "" } }));
  await page.route("**/api/v1/agent/intent-placeholder/**", (route) => route.fulfill({ json: { placeholder: "" } }));
  await page.goto("/studio/work/goals");
  await page.locator(".goals-list-panel").getByRole("button", { name: "新建目标", exact: true }).click();

  await expect(page).toHaveURL(/\/studio\/work\/goals\/new$/);
  await expect(page.getByRole("dialog", { name: "创建新目标" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "创建新目标", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "目标类型", exact: true })).toBeVisible();
  await expect(page.getByText("如何完成目标", { exact: true })).toHaveCount(0);
  await expect(page.getByText("设置时间与计划，帮助你持续推进", { exact: true })).toHaveCount(0);
  const createSurfaceGeometry = await page.locator(".tech-goal-form-page.is-dialog .tech-goal-create-main").evaluate((surface) => {
    const bounds = surface.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, minHeight: getComputedStyle(surface).minHeight };
  });
  expect(createSurfaceGeometry.width).toBeLessThanOrEqual(722);
  expect(createSurfaceGeometry.height).toBeLessThanOrEqual(760);
  await expect(page.getByRole("heading", { name: "目标类型", exact: true })).toBeVisible();
  await expect(page.locator(".tech-goal-form-step-heading p").first()).toHaveText("考试、考研、公务员");
  await expect(page.getByRole("button", { name: /备考/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /语言学习/ })).toBeVisible();
  await expect(page.getByText("学习安排", { exact: true })).toBeVisible();
  await expect(page.getByText("当前水平", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "备考", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "仅工作日", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "入门", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "目标名称" })).not.toBeFocused();
  const fieldAlignment = await page.locator(".tech-goal-form-step").first().evaluate((step) => {
    const left = (selector: string) => step.querySelector<HTMLElement>(selector)?.getBoundingClientRect().left ?? 0;
    return {
      heading: left("h2"),
      typeControl: left(".tech-goal-type-option"),
      nameLabel: left(".tech-goal-field > span"),
      nameControl: left(".tech-goal-field > input"),
    };
  });
  for (const left of Object.values(fieldAlignment)) expect(Math.abs(left - fieldAlignment.heading)).toBeLessThanOrEqual(1);
  await expect(page.getByRole("heading", { name: "参考资料", exact: true })).toHaveCount(0);
  await expect(page.locator(".tech-goal-create-aside:visible")).toHaveCount(0);
  await expect(page.getByText("进入学习空间", { exact: true })).toHaveCount(0);
  await expect(page.getByText("关联知识空间", { exact: true })).toHaveCount(0);
  await expect(page.getByText("新建知识空间", { exact: true })).toHaveCount(0);
  await expect(page.getByText("选择截止日期", { exact: true })).toBeVisible();
  await expect(page.getByLabel("每日投入小时数")).toHaveValue("2");
  await page.getByRole("button", { name: "增加每日投入" }).click();
  await expect(page.getByLabel("每日投入小时数")).toHaveValue("2.5");
  await page.getByRole("button", { name: "减少每日投入" }).click();
  await expect(page.getByLabel("每日投入小时数")).toHaveValue("2");

  await page.getByRole("button", { name: /语言学习/ }).click();
  await expect(page.locator(".tech-goal-form-step-heading p").first()).toHaveText("英语、日语等");
  await page.getByRole("textbox", { name: "目标名称" }).fill("完成日语 N2 备考");
  await page.getByRole("button", { name: "截止日期", exact: true }).click();
  const selectedDeadline = await page.locator(".tech-goal-calendar-days .is-today").getAttribute("aria-label");
  await page.locator(".tech-goal-calendar-days .is-today").click();
  await page.getByRole("button", { name: "仅工作日", exact: true }).click();
  await page.getByRole("button", { name: "进阶", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "目标名称" })).toHaveValue("完成日语 N2 备考");

  await page.getByRole("button", { name: "创建目标", exact: true }).click();
  const resultDialog = page.getByRole("dialog", { name: "目标创建结果" });
  await expect(resultDialog).toBeVisible();
  await expect(resultDialog.getByRole("heading", { name: "目标已创建" })).toBeVisible();
  await expect(resultDialog.getByText(/关联参考资料/)).toBeVisible();
  await expect(resultDialog.getByRole("button", { name: "稍后规划" })).toBeVisible();
  await resultDialog.getByRole("button", { name: "设置资料并生成" }).click();
  const planModeDialog = page.getByRole("dialog", { name: "选择计划生成方式" });
  await expect(planModeDialog).toBeVisible();
  await expect(planModeDialog.getByText("生成学习计划", { exact: true })).toBeVisible();
  await expect(planModeDialog.locator(".plan-mode-dialog-title-icon")).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  const narrowPlanModeBounds = await planModeDialog.evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(narrowPlanModeBounds.left).toBeGreaterThanOrEqual(0);
  expect(narrowPlanModeBounds.right).toBeLessThanOrEqual(narrowPlanModeBounds.viewportWidth);
  expect(narrowPlanModeBounds.top).toBeGreaterThanOrEqual(0);
  expect(narrowPlanModeBounds.bottom).toBeLessThanOrEqual(narrowPlanModeBounds.viewportHeight);
  expect(narrowPlanModeBounds.documentOverflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(planModeDialog.getByText("关联参考资料", { exact: true })).toBeVisible();
  await expect(planModeDialog.getByText("选择生成方式", { exact: true })).toBeVisible();
  const referenceSearch = planModeDialog.getByPlaceholder("搜索 6 份资料");
  await expect(referenceSearch).toBeVisible();
  await referenceSearch.fill("语法");
  const referenceOption = planModeDialog.getByRole("button", { name: /日语 N2 语法整理/ });
  await expect(referenceOption).toBeVisible();
  const modeTitle = planModeDialog.locator(".plan-mode-option-title").filter({ hasText: "仅从参考资料生成" });
  await expect(planModeDialog.locator(".plan-mode-option-index")).toHaveText(["01", "02", "03"]);
  await expect(planModeDialog.locator(".plan-mode-option-icon")).toHaveCount(3);
  const fontSizeBeforeReference = await modeTitle.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  const planModeAlignment = await planModeDialog.evaluate((dialog) => {
    const optionIndex = dialog.querySelector(".plan-mode-option-index")!.getBoundingClientRect();
    const optionIcon = dialog.querySelector(".plan-mode-option-icon")!.getBoundingClientRect();
    const title = dialog.querySelector(".plan-mode-dialog-title-copy")!.getBoundingClientRect();
    const sectionTitle = dialog.querySelector(".plan-mode-section-heading strong")!.getBoundingClientRect();
    const optionTitle = dialog.querySelector(".plan-mode-option-title")!.getBoundingClientRect();
    const description = dialog.querySelector(".plan-mode-option-description")!;
    return {
      markerLeftDelta: 0,
      copyLeftDelta: Math.abs(title.left - sectionTitle.left),
      indexIconGap: optionIcon.left - optionIndex.right,
      iconTitleGap: optionTitle.left - optionIcon.right,
      optionTopDelta: Math.abs(optionIndex.top - optionTitle.top),
      titleFont: Number.parseFloat(getComputedStyle(dialog.querySelector(".plan-mode-dialog-title-copy")!).fontSize),
      sectionFont: Number.parseFloat(getComputedStyle(dialog.querySelector(".plan-mode-section-heading strong")!).fontSize),
      optionFont: Number.parseFloat(getComputedStyle(dialog.querySelector(".plan-mode-option-title")!).fontSize),
      descriptionFont: Number.parseFloat(getComputedStyle(description).fontSize),
    };
  });
  expect(planModeAlignment.markerLeftDelta).toBeLessThanOrEqual(1);
  expect(planModeAlignment.copyLeftDelta).toBeGreaterThanOrEqual(30);
  expect(planModeAlignment.copyLeftDelta).toBeLessThanOrEqual(36);
  expect(planModeAlignment.indexIconGap).toBeGreaterThanOrEqual(5);
  expect(planModeAlignment.indexIconGap).toBeLessThanOrEqual(7);
  expect(planModeAlignment.iconTitleGap).toBeGreaterThanOrEqual(6);
  expect(planModeAlignment.iconTitleGap).toBeLessThanOrEqual(8);
  expect(planModeAlignment.optionTopDelta).toBeLessThanOrEqual(1);
  expect(planModeAlignment.titleFont).toBeGreaterThan(planModeAlignment.sectionFont);
  expect(planModeAlignment.sectionFont).toBeGreaterThan(planModeAlignment.optionFont);
  expect(planModeAlignment.optionFont).toBeGreaterThan(planModeAlignment.descriptionFont);
  const fileIconAlignment = await planModeDialog.evaluate((dialog) => {
    const helper = dialog.querySelector(".plan-mode-reference-section .plan-mode-section-heading small")?.getBoundingClientRect();
    const fileIcon = dialog.querySelector(".plan-mode-reference-list > button svg")?.getBoundingClientRect();
    return helper && fileIcon ? Math.abs(helper.left - fileIcon.left) : Number.POSITIVE_INFINITY;
  });
  expect(fileIconAlignment).toBeLessThanOrEqual(1);
  await referenceOption.click();
  const fontSizeAfterReference = await modeTitle.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSizeBeforeReference).toBe(12.5);
  expect(fontSizeAfterReference).toBe(fontSizeBeforeReference);
  await expect(planModeDialog.getByRole("button", { name: /仅从参考资料生成/ })).toBeEnabled();

  const storedGoal = await page.evaluate(() => {
    const goals = JSON.parse(window.localStorage.getItem("planpilot-v2-goals") ?? "[]") as Array<Record<string, unknown>>;
    return goals.find((item) => item.name === "完成日语 N2 备考");
  });
  expect(storedGoal).toMatchObject({
    name: "完成日语 N2 备考",
    type: "语言学习",
    status: "进行中",
  });
  expect(storedGoal?.deadlineDate).toBeTruthy();
  expect(selectedDeadline).toBeTruthy();
  await planModeDialog.getByRole("button", { name: /仅从参考资料生成/ }).click();
  await expect(planModeDialog.getByText("参考资料", { exact: true })).toBeVisible();
  await planModeDialog.getByRole("button", { name: "开始生成", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/work\/goals\/local-goal-/);
  expect(linkedGoalIds).toContain(String(storedGoal?.id));
});

test("新建目标页在窄屏保持完整统一表单", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/studio/work/goals/new");
  await expect(page.getByRole("heading", { name: "创建新目标", exact: true })).toBeVisible();
  await expect(page.getByText("如何完成目标", { exact: true })).toHaveCount(0);
  await expect(page.locator(".tech-goal-create-main").getByRole("group", { name: "每日投入时长" }).first()).toBeVisible();
  const geometry = await page.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    pageWidth: document.querySelector<HTMLElement>(".tech-goal-create-page")?.getBoundingClientRect().width ?? 0,
    headingLeft: document.querySelector<HTMLElement>(".tech-goal-form-step h2")?.getBoundingClientRect().left ?? 0,
    fieldLeft: document.querySelector<HTMLElement>(".tech-goal-form-step .tech-goal-field > input")?.getBoundingClientRect().left ?? 0,
  }));
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.pageWidth).toBeLessThanOrEqual(375);
  expect(Math.abs(geometry.headingLeft - geometry.fieldLeft)).toBeLessThanOrEqual(1);
});

test("新建目标页在短桌面视口首屏完整显示", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto("/studio/work/goals/new");
  const surface = page.locator(".tech-goal-form-page.is-dialog .tech-goal-create-main:visible").last();
  await expect(surface.getByRole("heading", { name: "创建新目标", exact: true })).toBeVisible();
  await expect(surface.getByRole("button", { name: "创建目标", exact: true })).toBeVisible();
  const geometry = await surface.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const typeOption = element.querySelector<HTMLElement>(".tech-goal-type-option");
    const typeOptionLabel = element.querySelector<HTMLElement>(".tech-goal-type-option strong");
    const nameInput = element.querySelector<HTMLElement>(".tech-goal-field > input");
    const segmentButton = element.querySelector<HTMLElement>(".tech-goal-segmented-control button");
    const actionButton = element.querySelector<HTMLElement>(".tech-goal-primary-action");
    return {
      width: bounds.width,
      height: bounds.height,
      bottom: bounds.bottom,
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      typeOptionHeight: typeOption?.getBoundingClientRect().height ?? Number.POSITIVE_INFINITY,
      typeOptionFontSize: typeOptionLabel ? Number.parseFloat(getComputedStyle(typeOptionLabel).fontSize) : 0,
      nameInputHeight: nameInput?.getBoundingClientRect().height ?? Number.POSITIVE_INFINITY,
      nameInputFontSize: nameInput ? Number.parseFloat(getComputedStyle(nameInput).fontSize) : 0,
      segmentHeight: segmentButton?.getBoundingClientRect().height ?? Number.POSITIVE_INFINITY,
      segmentFontSize: segmentButton ? Number.parseFloat(getComputedStyle(segmentButton).fontSize) : 0,
      actionHeight: actionButton?.getBoundingClientRect().height ?? Number.POSITIVE_INFINITY,
      actionFontSize: actionButton ? Number.parseFloat(getComputedStyle(actionButton).fontSize) : 0,
    };
  });
  expect(geometry.width).toBeLessThanOrEqual(762);
  expect(geometry.height).toBeLessThanOrEqual(572);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight - 12);
  // Preserve the current polished visual baseline: the document includes a 4px shell allowance.
  expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight + 4);
  expect(geometry.typeOptionHeight).toBeLessThanOrEqual(40.1);
  expect(geometry.typeOptionFontSize).toBe(13);
  expect(geometry.nameInputHeight).toBeLessThanOrEqual(40.1);
  expect(geometry.nameInputFontSize).toBe(13);
  expect(geometry.segmentHeight).toBeLessThanOrEqual(40.1);
  expect(geometry.segmentFontSize).toBe(13);
  expect(geometry.actionHeight).toBeLessThanOrEqual(40.1);
  expect(geometry.actionFontSize).toBe(14);
});

test("编辑目标复用统一目标表单", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "edit-form-user", email: "form@example.com", username: "表单用户", email_verified: true, onboarding_completed: true },
  }));
  await page.route("**/api/v1/goals/goal-tech-1/plan", (route) => route.fulfill({ json: { plan: null } }));
  await page.route("**/api/v1/goals/goal-tech-1", (route) => route.fulfill({ json: goal }));
  await page.goto("/studio/work/goals/goal-tech-1/edit");

  const editor = page.locator(".tech-goal-form-page.is-editing");
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("heading", { name: "编辑目标", exact: true })).toBeVisible();
  await expect(editor.getByRole("heading", { name: "目标类型", exact: true })).toBeVisible();
  await expect(editor.getByText("如何完成目标", { exact: true })).toHaveCount(0);
  await expect(editor.getByRole("textbox", { name: "目标名称" })).toHaveValue("agent 开发");
  await expect(editor.getByRole("button", { name: "技能", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByText("目标状态", { exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "进行中", exact: true })).toHaveAttribute("aria-pressed", "true");
  const sectionOrderIsCorrect = await editor.evaluate((surface) => {
    const status = surface.querySelector(".tech-goal-status-section");
    const preferences = surface.querySelector(".tech-goal-preference-grid");
    const deadline = surface.querySelector(".tech-goal-date-field");
    return Boolean(
      status
      && preferences
      && deadline
      && (status.compareDocumentPosition(preferences) & Node.DOCUMENT_POSITION_FOLLOWING)
      && (preferences.compareDocumentPosition(deadline) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  expect(sectionOrderIsCorrect).toBe(true);
  const statusAlignment = await editor.evaluate((surface) => {
    const status = surface.querySelector<HTMLElement>(".tech-goal-status-section")?.getBoundingClientRect();
    const schedule = surface.querySelector<HTMLElement>(".tech-goal-create-two-column")?.getBoundingClientRect();
    return {
      leftDelta: Math.abs((status?.left ?? 0) - (schedule?.left ?? 999)),
      rightDelta: Math.abs((status?.right ?? 0) - (schedule?.right ?? 999)),
    };
  });
  expect(statusAlignment.leftDelta).toBeLessThanOrEqual(1);
  expect(statusAlignment.rightDelta).toBeLessThanOrEqual(1);
  await expect(editor.getByRole("button", { name: "保存修改", exact: true })).toBeVisible();
});

test("目标动态只有一个进行中目标时隐藏切换入口", async ({ page }) => {
  const storedGoals = [
    {
      id: "active-only",
      name: "唯一进行中目标",
      type: "技能提升",
      progress: 30,
      deadline: "8 月 30 日",
      deadlineDate: "2026-08-30",
      daily: "30 分钟",
      status: "进行中",
      next: "完成下一节练习",
      taskSummary: "3 / 10 个任务",
      rhythmSummary: "连续学习 3 天",
    },
    {
      id: "archived-goal",
      name: "已归档目标",
      type: "技能提升",
      progress: 20,
      deadline: "长期",
      daily: "20 分钟",
      status: "已暂停",
      next: "等待恢复",
      taskSummary: "2 / 10 个任务",
      rhythmSummary: "暂停中",
    },
  ];
  await page.addInitScript((items) => {
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
    window.localStorage.setItem("planpilot-v2-goals", JSON.stringify(items));
  }, storedGoals);

  await page.goto("/studio/work/goals");
  await expect(page.getByRole("button", { name: /切换目标动态范围/ })).toHaveCount(0);
  const activeMilestones = page.locator(".goal-milestones-list").filter({ hasText: "唯一进行中目标" }).first();
  await expect(activeMilestones).toContainText("唯一进行中目标");
  await expect(activeMilestones.locator(".goal-milestone-status")).toContainText("持续推进");
  await expect(activeMilestones.locator(".goal-milestone-status")).not.toContainText("目标下一步");
  await expect(activeMilestones).not.toContainText("已归档目标");
});

test("目标状态区分轻微风险并采用最早未完成任务", async ({ page }) => {
  const storedGoals = [{
    id: "minor-risk",
    name: "轻微偏差目标",
    type: "技能提升",
    progress: 20,
    deadline: "9 月 30 日",
    deadlineDate: "2026-09-30",
    daily: "30 分钟",
    status: "有风险",
    next: "继续执行当前计划",
    taskSummary: "2 / 10 个任务",
    rhythmSummary: "1 项知识待复习",
    debtCount: 1,
  }];
  const storedTasks = [
    { id: "done-first", goalId: "minor-risk", goalTitle: "轻微偏差目标", title: "已经完成的任务", date: "2026-08-18", done: true },
    { id: "next-first", goalId: "minor-risk", goalTitle: "轻微偏差目标", title: "先复习状态转移", date: "2026-08-19", done: false },
    { id: "next-later", goalId: "minor-risk", goalTitle: "轻微偏差目标", title: "再整理复杂度", date: "2026-08-20", done: false },
  ];
  await page.addInitScript(({ goals, tasks }) => {
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
    window.localStorage.setItem("planpilot-v2-goals", JSON.stringify(goals));
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify(tasks));
  }, { goals: storedGoals, tasks: storedTasks });

  await page.goto("/studio/work/goals");
  const summary = page.getByRole("region", { name: "目标状态" });
  await expect(summary).toContainText("轻微偏差目标有 1 项待复习知识需要安排");
  await expect(summary).toContainText("需要关注");
  await expect(summary).not.toContainText("优先处理");
  await expect(summary).toContainText("轻微偏差目标下一步：先复习状态转移");
  await expect(summary).toContainText("下一项任务");
  await expect(summary).not.toContainText("已经完成的任务");
});

test("目标状态列表在窄列中不重叠并使用紧凑标识", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/studio/work/goals");
  const list = page.locator(".goal-milestones-list:visible");
  const rows = list.locator(".goal-milestone");
  await expect(rows.first()).toBeVisible();

  const layout = await list.evaluate((element) => {
    const items = Array.from(element.querySelectorAll<HTMLElement>(".goal-milestone"));
    return {
      statusFontSizes: items.map((item) => Number.parseFloat(getComputedStyle(item.querySelector(".goal-milestone-status")!).fontSize)),
      detailWhiteSpaces: items.map((item) => getComputedStyle(item.querySelector<HTMLElement>(".goal-milestone-title > span")!).whiteSpace),
      contentOverflow: items.map((item) => {
        const row = item.getBoundingClientRect();
        const content = item.querySelector<HTMLElement>(":scope > div")!.getBoundingClientRect();
        return content.bottom - row.bottom;
      }),
      rowOverlap: items.slice(0, -1).map((item, index) => item.getBoundingClientRect().bottom - items[index + 1].getBoundingClientRect().top),
    };
  });

  expect(Math.max(...layout.statusFontSizes)).toBeLessThanOrEqual(9);
  expect(new Set(layout.detailWhiteSpaces)).toEqual(new Set(["nowrap"]));
  expect(Math.max(...layout.contentOverflow)).toBeLessThanOrEqual(0.5);
  expect(Math.max(...layout.rowOverlap)).toBeLessThanOrEqual(0);
});

test("目标管理、知识空间和学习笔记保持同一固定底部基线", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const surfaces = [
    { path: "/studio/work/goals", selector: ".goals-list-panel" },
    { path: "/studio/work/knowledge", selector: ".knowledge-resource-panel" },
    { path: "/studio/work/notes", selector: ".notes-workspace" },
  ];
  const bottoms: number[] = [];

  for (const surface of surfaces) {
    await page.goto(surface.path);
    const panel = page.locator(surface.selector).first();
    await expect(panel).toBeVisible();
    const geometry = await panel.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        bottomGap: window.innerHeight - bounds.bottom,
        documentOverflow: document.documentElement.scrollHeight - window.innerHeight,
      };
    });
    bottoms.push(geometry.bottom);
    expect(geometry.bottomGap).toBeCloseTo(18, 0);
    expect(geometry.documentOverflow).toBeLessThanOrEqual(4);
  }

  expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);
});

test("科技目标详情复用完整能力且强调色局部隔离", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: {
      id: "user-goal-detail",
      email: "learner@example.com",
      username: "学习者",
      email_verified: true,
      onboarding_completed: true,
    },
  }));
  let emptyProgressRequests = 0;
  await page.route("**/api/v1/goals/goal-tech-1/progress", (route) => {
    emptyProgressRequests += 1;
    return route.fulfill({ status: 503, json: { detail: "进度读取失败" } });
  });
  await page.route("**/api/v1/goals/goal-tech-1/plan", (route) => route.fulfill({ json: { plan: null } }));
  await page.route("**/api/v1/goals/goal-tech-1", (route) => route.fulfill({ json: goal }));
  await page.route("**/api/v1/debts/goal-tech-1", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: [] }));

  await page.goto("/studio/work/goals/goal-tech-1");

  const executionMetrics = page.getByRole("group", { name: "目标与执行指标" });
  await expect(executionMetrics).toHaveCount(0);
  await expect(page.locator(".goal-detail-header")).toHaveCSS("border-radius", "14px");
  await expect(page.locator(".goal-detail-progress")).toHaveCount(0);
  await expect(page.getByText("我的目标", { exact: true })).toHaveCount(0);
  await expect(page.getByText("目标进度", { exact: true })).toHaveCount(0);
  await expect(page.getByText("根据当前任务与学习记录计算", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/剩余 \d+ 天/)).toHaveCount(0);
  await expect(page.getByText("每日计划投入 5 小时", { exact: true })).toBeVisible();
  expect(emptyProgressRequests).toBe(0);
  await expect(page.getByRole("button", { name: "任务", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "相关笔记", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "执行节奏", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "学习计划", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "搜索今日任务" })).toHaveCount(0);

  const createTaskButton = page.getByRole("button", { name: "新建任务", exact: true });
  await expect(page.getByText("目标资源", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "写目标复盘", exact: true })).toHaveCount(0);
  await expect(createTaskButton).toBeVisible();
  await expect(createTaskButton).toHaveCSS("height", "40px");

  const colors = await page.locator(".tech-goal-workspace-scope").evaluate((element) => {
    const localStyle = window.getComputedStyle(element);
    return {
      localAccent: localStyle.getPropertyValue("--accent").trim(),
      workspaceAccent: localStyle.getPropertyValue("--workspace-accent").trim(),
      documentInlineAccent: document.documentElement.style.getPropertyValue("--accent").trim(),
    };
  });
  expect(colors.localAccent).toBe(colors.workspaceAccent);
  expect(colors.localAccent).not.toBe("");
  expect(colors.documentInlineAccent).toBe("");

  const workspaceGeometry = await page.locator(".tech-goal-workspace-scope").evaluate((element) => {
    const scope = element.getBoundingClientRect();
    const content = element.parentElement?.getBoundingClientRect();
    const leftPanel = element.querySelector(".goal-detail-left")?.getBoundingClientRect();
    const rightPanel = element.querySelector(".goal-detail-right")?.getBoundingClientRect();
    return {
      leftGap: scope.left - (content?.left ?? scope.left),
      widthReduction: (content?.width ?? scope.width) - scope.width,
      leftPanelWidth: leftPanel?.width ?? 0,
      rightPanelWidth: rightPanel?.width ?? 0,
    };
  });
  expect(workspaceGeometry.leftGap).toBeCloseTo(22, 0);
  expect(workspaceGeometry.widthReduction).toBeCloseTo(workspaceGeometry.leftGap, 0);
  expect(workspaceGeometry.rightPanelWidth).toBeGreaterThan(300);
  expect(Math.abs(workspaceGeometry.leftPanelWidth - workspaceGeometry.rightPanelWidth)).toBeLessThanOrEqual(24);
  await expect(page.locator(".goal-detail-body")).toHaveCSS("gap", "12px");
  await expect(page.locator(".goal-detail-left")).toHaveCSS("border-radius", "12px");
  await expect(page.locator(".goal-detail-right")).toHaveCSS("border-radius", "12px");
  const tabGeometry = await page.locator(".goal-detail-body").evaluate((element) => {
    const leftBar = element.querySelector(".goal-primary-tabs")!.getBoundingClientRect();
    const rightBar = element.querySelector(".goal-right-tabs")!.getBoundingClientRect();
    const leftTabs = [...element.querySelectorAll<HTMLElement>(".goal-primary-tab")];
    const rightTabs = [...element.querySelectorAll<HTMLElement>(".goal-right-tab")];
    const activeTab = element.querySelector<HTMLElement>('.goal-right-tab[aria-pressed="true"]')!;
    const activeIndicator = getComputedStyle(activeTab, "::after");
    return {
      barHeightDifference: Math.abs(leftBar.height - rightBar.height),
      barTopDifference: Math.abs(leftBar.top - rightBar.top),
      leftTabWidthDifference: Math.abs(leftTabs[0].getBoundingClientRect().width - leftTabs[1].getBoundingClientRect().width),
      rightTabWidthDifference: Math.abs(rightTabs[0].getBoundingClientRect().width - rightTabs[1].getBoundingClientRect().width),
      fontSizes: [...leftTabs, ...rightTabs].map((tab) => getComputedStyle(tab).fontSize),
      indicatorBottom: activeIndicator.bottom,
      indicatorLeft: activeIndicator.left,
      indicatorRight: activeIndicator.right,
      indicatorColor: activeIndicator.backgroundColor,
      colors: [...leftTabs, ...rightTabs].map((tab) => getComputedStyle(tab).color),
    };
  });
  expect(tabGeometry.barHeightDifference).toBeLessThanOrEqual(1);
  expect(tabGeometry.barTopDifference).toBeLessThanOrEqual(1);
  expect(tabGeometry.leftTabWidthDifference).toBeLessThanOrEqual(1);
  expect(tabGeometry.rightTabWidthDifference).toBeLessThanOrEqual(1);
  expect(new Set(tabGeometry.fontSizes)).toEqual(new Set(["15px"]));
  expect(tabGeometry.colors[0]).not.toBe(tabGeometry.colors[1]);
  expect(tabGeometry.colors[2]).not.toBe(tabGeometry.colors[3]);
  expect(tabGeometry.indicatorBottom).toBe("4px");
  expect(tabGeometry.indicatorLeft).toBe("18px");
  expect(tabGeometry.indicatorRight).toBe("18px");
  expect(tabGeometry.indicatorColor).not.toBe("rgba(0, 0, 0, 0)");
  const panelResizer = page.getByRole("separator", { name: "调整左右面板宽度" });
  await expect(panelResizer).toHaveCSS("width", "12px");
  await expect(panelResizer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const leftWidthBeforeKeyboardResize = (await page.locator(".goal-detail-left").boundingBox())?.width ?? 0;
  await panelResizer.press("ArrowRight");
  await page.waitForTimeout(400);
  const leftWidthAfterKeyboardResize = (await page.locator(".goal-detail-left").boundingBox())?.width ?? 0;
  expect(leftWidthAfterKeyboardResize).toBeCloseTo(leftWidthBeforeKeyboardResize + 20, 0);

  await expect(page.getByRole("button", { name: /(收起|展开)数据与任务面板/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /(收起|展开)AI与学习计划面板/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: goal.title, exact: true })).toBeVisible();
  await expect(page.getByText("今天还没有学习任务", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建任务", exact: true })).toBeVisible();
  const emptyExecution = page.getByRole("region", { name: "当前目标执行节奏" });
  await expect(page.locator(".goal-task-empty").getByRole("button", { name: "新建任务", exact: true })).toHaveCount(0);
  await expect(emptyExecution.getByRole("button", { name: "新建任务", exact: true })).toBeVisible();
  await expect(emptyExecution).toContainText("暂无可分析的执行数据");
  await expect(emptyExecution).not.toContainText("目标进度暂未显示");
  await expect(emptyExecution).not.toContainText("目标和任务仍可正常使用");
  await expect(emptyExecution.getByText("今日完成", { exact: true })).toHaveCount(0);
  await expect(emptyExecution.getByText("未来一周", { exact: true })).toHaveCount(0);
  await expect(emptyExecution.getByText("剩余投入", { exact: true })).toHaveCount(0);
  await expect(emptyExecution).not.toContainText("投入匹配");
  await expect(emptyExecution.getByText("总进度", { exact: true })).toHaveCount(0);
  await expect(emptyExecution).toHaveClass(/is-empty/);
  await expect(emptyExecution.getByText("下一项任务", { exact: true })).toHaveCount(0);
  await expect(emptyExecution).toContainText("安排至少一个学习任务后");
  await expect(emptyExecution.getByRole("button", { name: "创建第一项任务" })).toHaveCount(0);
  await expect(emptyExecution.getByRole("link", { name: "让 Pilo 帮我拆分" })).toHaveCount(0);
  await expect(emptyExecution.locator(".goal-execution-actions")).toHaveCount(0);
  await expect(emptyExecution.locator(".goal-execution-week-chart")).toHaveCount(0);
  const emptyAlignment = await page.locator(".goal-detail-body").evaluate((element) => {
    const leftTitle = element.querySelector(".goal-task-empty > strong")!.getBoundingClientRect();
    const rightTitle = element.querySelector(".goal-execution-empty-content > strong")!.getBoundingClientRect();
    const leftCopy = element.querySelector(".goal-task-empty > p")!;
    const rightCopy = element.querySelector(".goal-execution-empty-content > p")!;
    const leftCopyRect = leftCopy.getBoundingClientRect();
    const rightCopyRect = rightCopy.getBoundingClientRect();
    return {
      titleCenterDifference: Math.abs((leftTitle.top + leftTitle.bottom) / 2 - (rightTitle.top + rightTitle.bottom) / 2),
      leftCopyHeight: leftCopyRect.height,
      leftCopyWhiteSpace: getComputedStyle(leftCopy).whiteSpace,
      rightCopyHeight: rightCopyRect.height,
      rightCopyWhiteSpace: getComputedStyle(rightCopy).whiteSpace,
    };
  });
  expect(emptyAlignment.titleCenterDifference).toBeLessThanOrEqual(6);
  expect(emptyAlignment.leftCopyHeight).toBeLessThanOrEqual(22);
  expect(emptyAlignment.leftCopyWhiteSpace).toBe("nowrap");
  expect(emptyAlignment.rightCopyHeight).toBeLessThanOrEqual(22);
  expect(emptyAlignment.rightCopyWhiteSpace).toBe("nowrap");

  for (const height of [720, 600, 520]) {
    await page.setViewportSize({ width: 1280, height });
    const emptyGeometry = await emptyExecution.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(emptyGeometry.scrollHeight - emptyGeometry.clientHeight).toBeLessThanOrEqual(1);
    expect(emptyGeometry.overflowY).toBe("auto");
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(300);
  const mobileHeaderGeometry = await page.locator(".goal-detail-heading-row").evaluate((element) => {
    const header = element.parentElement?.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      headerLeft: header?.left ?? 0,
      headerRight: header?.right ?? 0,
    };
  });
  expect(mobileHeaderGeometry.overflow).toBeLessThanOrEqual(1);
  expect(mobileHeaderGeometry.headerLeft).toBeGreaterThanOrEqual(0);
  expect(mobileHeaderGeometry.headerRight).toBeLessThanOrEqual(375);
  await expect(executionMetrics).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(400);

  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "任务名称" })).toBeFocused();

  await page.getByRole("button", { name: "学习计划", exact: true }).click();
  await expect(page.getByText("还没有学习计划", { exact: true })).toBeVisible();
  await expect(page.getByText("先选择参考资料如何参与，再生成阶段安排", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "设置资料并生成计划", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "选择计划生成方式" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("执行节奏与左侧指标互补并在不同高度内保持单屏", async ({ page }) => {
  const executionGoal = { ...goal, daily_hours: 1 / 6 };
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: {
      id: "user-goal-execution",
      email: "learner@example.com",
      username: "学习者",
      email_verified: true,
      onboarding_completed: true,
    },
  }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: [executionGoal] }));
  await page.route("**/api/v1/goals/goal-tech-1/progress", (route) => route.fulfill({
    json: { goal_id: goal.id, total_tasks: 89, completed_tasks: 0, avg_completion_rate: 0, streak_days: 0, debt_count: 8, days_ahead_or_behind: -2 },
  }));
  await page.route("**/api/v1/goals/goal-tech-1/plan", (route) => route.fulfill({ json: { plan: null } }));
  await page.route("**/api/v1/goals/goal-tech-1", (route) => route.fulfill({ json: executionGoal }));
  await page.route("**/api/v1/debts/goal-tech-1", (route) => route.fulfill({ json: [] }));
  const now = new Date();
  const asDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const nextDate = new Date(now);
  nextDate.setDate(nextDate.getDate() + 2);
  const dashboardTasks = [
    { id: "dashboard-done", goalId: goal.id, goalTitle: goal.title, title: "完成环境配置", date: asDate(now), done: true, estimatedMinutes: 30, priority: "medium" },
    { id: "dashboard-next", goalId: goal.id, goalTitle: goal.title, title: "实现 Agent 工具调用", date: asDate(now), done: false, estimatedMinutes: 60, priority: "high" },
    { id: "dashboard-later", goalId: goal.id, goalTitle: goal.title, title: "补充可靠性测试", date: asDate(nextDate), done: false, estimatedMinutes: 90, priority: "medium" },
  ];
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: dashboardTasks }));
  await page.route("**/api/v1/learner/decision-context**", (route) => route.fulfill({
    json: {
      profile: null,
      cognitive_profile: null,
      memories: { short_term: [], episodic: [], semantic: [] },
      knowledge_gaps: [],
      active_patterns: [],
      recent_events: [],
      goal_context: null,
      data_quality: {
        profile_event_count: 0,
        profile_scope: "goal",
        pattern_count: 0,
        memory_count: 0,
        cognitive_confidence: 0,
        knowledge_gap_count: 0,
        low_confidence_fields: [],
        level: "low",
      },
    },
  }));
  await page.route("**/api/v1/learner/proposals**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/knowledge/files", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/coach/archive", (route) => route.fulfill({
    json: { version: 2, conversations: [], preferences: null },
  }));

  await page.goto("/studio/work/goals/goal-tech-1");
  await expect(page.locator(".goal-progress-summary .goal-metric-badge")).toHaveCount(0);

  const execution = page.getByRole("region", { name: "当前目标执行节奏" });
  await expect(execution).not.toContainText("今日安排");
  await expect(execution).not.toContainText("今天还剩 1 项");
  await expect(execution).not.toContainText("项进入今起 7 天");
  await expect(execution).toContainText("今日完成");
  await expect(execution).toContainText("1/2");
  await expect(execution).toContainText("2.5 小时");
  await expect(execution).not.toContainText("近 7 日");
  await expect(execution).not.toContainText("七日安排");
  await expect(execution).not.toContainText("今起 7 天");
  await expect(execution).toContainText("未来一周");
  await expect(execution).toContainText("3 项已安排");
  const sixMetrics = execution.getByRole("group", { name: "目标与执行指标" });
  await expect(sixMetrics.locator(".goal-metric-card")).toHaveCount(3);
  await expect(sixMetrics.locator(".goal-execution-kpis > div")).toHaveCount(3);
  await expect(sixMetrics.locator(".goal-metric-card").first()).toHaveCSS("border-top-width", "0px");
  await expect(sixMetrics.locator(".goal-metric-card").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const metricGeometry = await sixMetrics.locator(":scope :is(.goal-metric-card, .goal-execution-kpis > div)").evaluateAll((cells) => cells.map((cell) => ({
    top: (cell as HTMLElement).offsetTop,
    left: (cell as HTMLElement).offsetLeft,
  })));
  expect(new Set(metricGeometry.slice(0, 3).map((cell) => cell.top)).size).toBe(1);
  expect(new Set(metricGeometry.slice(3).map((cell) => cell.top)).size).toBe(1);
  expect(metricGeometry[3].top).toBeGreaterThan(metricGeometry[0].top);
  const compactRhythm = await execution.evaluate((region) => {
    const metrics = region.querySelector<HTMLElement>(".goal-execution-metrics")!;
    const capacity = region.querySelector<HTMLElement>(".goal-execution-capacity")!;
    const capacityStyle = getComputedStyle(capacity);
    return {
      metricsHeight: metrics.getBoundingClientRect().height,
      capacityPaddingTop: Number.parseFloat(capacityStyle.paddingTop),
      capacityPaddingBottom: Number.parseFloat(capacityStyle.paddingBottom),
    };
  });
  expect(compactRhythm.metricsHeight).toBeLessThanOrEqual(150);
  expect(compactRhythm.capacityPaddingTop).toBeGreaterThanOrEqual(5);
  expect(compactRhythm.capacityPaddingBottom).toBeGreaterThanOrEqual(7);
  const metricTypography = await sixMetrics.locator(".goal-progress-metric-heading").evaluateAll((headings) => headings.map((heading) => {
    const title = heading.querySelector<HTMLElement>(":scope > span:not(.goal-metric-badge)")!;
    const titleStyle = getComputedStyle(title);
    return {
      text: title.textContent,
      whiteSpace: titleStyle.whiteSpace,
      fontSize: Number.parseFloat(titleStyle.fontSize),
      lineHeight: Number.parseFloat(titleStyle.lineHeight),
      height: title.getBoundingClientRect().height,
      overflow: heading.scrollWidth - heading.clientWidth,
      justifyContent: getComputedStyle(heading).justifyContent,
      detailFontSize: Number.parseFloat(getComputedStyle(heading.closest(".goal-metric-card")!.querySelector(".goal-metric-hover-detail")!).fontSize),
      valueFontSize: Number.parseFloat(getComputedStyle(heading.closest(".goal-metric-card")!.querySelector(".goal-metric-primary-value")!).fontSize),
    };
  }));
  for (const title of metricTypography) {
    expect(title.whiteSpace).toBe("nowrap");
    expect(title.fontSize).toBe(13);
    expect(title.detailFontSize).toBe(12);
    expect(title.detailFontSize).toBeLessThan(title.valueFontSize);
    expect(title.height).toBeLessThanOrEqual(title.lineHeight + 1);
    expect(title.overflow).toBeLessThanOrEqual(1);
    expect(title.justifyContent).toBe("center");
  }
  const topMetricValues = await sixMetrics.locator(".goal-metric-primary-value").evaluateAll((values) => values.map((value) => ({
    fontSize: Number.parseFloat(getComputedStyle(value).fontSize),
    top: (value as HTMLElement).offsetTop,
  })));
  expect(topMetricValues.map((value) => value.fontSize)).toEqual([14, 14, 14]);
  expect(Math.max(...topMetricValues.map((value) => value.top)) - Math.min(...topMetricValues.map((value) => value.top))).toBeLessThanOrEqual(1);
  const lowerMetricValues = await sixMetrics.locator(".goal-execution-kpis dd").evaluateAll((values) => values.map((value) => ({
    fontSize: Number.parseFloat(getComputedStyle(value).fontSize),
    unitSize: Number.parseFloat(getComputedStyle(value.querySelector("small") ?? value).fontSize),
  })));
  expect(lowerMetricValues.map((value) => value.fontSize)).toEqual([12, 12, 12]);
  expect(lowerMetricValues.map((value) => value.unitSize)).toEqual([12, 12, 12]);
  const lowerMetricAlignment = await sixMetrics.locator(".goal-execution-kpis > div").evaluateAll((cells) => cells.map((cell) => {
    const cellBox = cell.getBoundingClientRect();
    const titleBox = cell.querySelector("dt > span")!.getBoundingClientRect();
    const valueBox = cell.querySelector("dd")!.getBoundingClientRect();
    const cellCenter = cellBox.left + cellBox.width / 2;
    return {
      titleOffset: titleBox.left + titleBox.width / 2 - cellCenter,
      valueOffset: valueBox.left + valueBox.width / 2 - cellCenter,
    };
  }));
  for (const metric of lowerMetricAlignment) {
    expect(Math.abs(metric.titleOffset)).toBeLessThanOrEqual(1);
    expect(Math.abs(metric.valueOffset)).toBeLessThanOrEqual(1);
  }
  const progressCard = sixMetrics.locator(".goal-metric-card-progress");
  await expect(progressCard).toHaveAttribute("data-detail", "0/89 项完成 · 待加速");
  const progressValue = progressCard.locator(".goal-metric-primary-value");
  const progressDetail = progressCard.locator(".goal-metric-hover-detail");
  const detailOpacityBeforeHover = await progressDetail.evaluate((detail) => getComputedStyle(detail).opacity);
  const detailColors = await progressCard.evaluate((card) => ({
    detail: getComputedStyle(card.querySelector(".goal-metric-hover-detail > em")!).color,
    value: getComputedStyle(card.querySelector(":scope > strong")!).color,
  }));
  expect(detailOpacityBeforeHover).toBe("0");
  expect(detailColors.detail).not.toBe(detailColors.value);
  await progressCard.hover();
  await expect(progressValue).toHaveCSS("opacity", "0");
  await expect(progressDetail).toHaveCSS("opacity", "1");
  await expect(progressDetail).toContainText("0/89 项完成");
  await expect(progressDetail.locator("em")).toContainText("待加速");
  const sectionHeaders = execution.locator(".goal-execution-section-header");
  await expect(sectionHeaders).toHaveCount(3);
  await expect(sectionHeaders.nth(0)).toContainText("目标概览");
  await expect(sectionHeaders.nth(1)).toContainText("每日投入");
  await expect(sectionHeaders.nth(2)).toContainText("未来一周安排");
  const sectionHeaderStyles = await sectionHeaders.locator(":scope > span").evaluateAll((titles) => titles.map((title) => ({
    fontSize: getComputedStyle(title).fontSize,
    fontWeight: getComputedStyle(title).fontWeight,
  })));
  expect(new Set(sectionHeaderStyles.map((style) => style.fontSize)).size).toBe(1);
  expect(new Set(sectionHeaderStyles.map((style) => style.fontWeight)).size).toBe(1);
  const sectionAlignment = await sectionHeaders.evaluateAll((headers) => ({
    titleLefts: headers.map((header) => header.querySelector(":scope > span")!.getBoundingClientRect().left),
    statusRights: headers.flatMap((header) => {
      const status = header.querySelector(".goal-execution-section-status");
      return status ? [status.getBoundingClientRect().right] : [];
    }),
  }));
  expect(Math.max(...sectionAlignment.titleLefts) - Math.min(...sectionAlignment.titleLefts)).toBeLessThanOrEqual(1);
  expect(Math.max(...sectionAlignment.statusRights) - Math.min(...sectionAlignment.statusRights)).toBeLessThanOrEqual(1);
  const taskViewTabs = page.locator(".goal-task-view-tab");
  await expect(taskViewTabs).toHaveCount(2);
  const taskViewTypography = await taskViewTabs.evaluateAll((tabs) => tabs.map((tab) => {
    const icon = tab.querySelector("svg")!;
    const tabStyle = getComputedStyle(tab);
    const iconStyle = getComputedStyle(icon);
    return {
      fontSize: tabStyle.fontSize,
      fontWeight: tabStyle.fontWeight,
      iconWidth: iconStyle.width,
      iconHeight: iconStyle.height,
      underlineHeight: getComputedStyle(tab, "::after").height,
      underlineColor: getComputedStyle(tab, "::after").backgroundColor,
    };
  }));
  expect(taskViewTypography.map((style) => style.fontSize)).toEqual(["14px", "14px"]);
  expect(taskViewTypography.map((style) => style.fontWeight)).toEqual([sectionHeaderStyles[0].fontWeight, sectionHeaderStyles[0].fontWeight]);
  expect(taskViewTypography.map((style) => style.iconWidth)).toEqual(["14px", "14px"]);
  expect(taskViewTypography.map((style) => style.iconHeight)).toEqual(["14px", "14px"]);
  expect(taskViewTypography.map((style) => style.underlineHeight)).toEqual(["2px", "2px"]);
  expect(taskViewTypography.every((style) => style.underlineColor !== "rgba(0, 0, 0, 0)")).toBe(true);
  const topSpacing = await page.evaluate(() => ({
    taskWorkspace: Number.parseFloat(getComputedStyle(document.querySelector(".goal-tasks-workspace")!).paddingTop),
    execution: Number.parseFloat(getComputedStyle(document.querySelector(".goal-execution")!).paddingTop),
  }));
  expect(topSpacing.taskWorkspace).toBe(4);
  expect(topSpacing.execution).toBe(8);
  await expect(page.locator(".goal-primary-tabs")).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".goal-right-tabs")).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".goal-task-toolbar")).toHaveCSS("border-bottom-width", "0px");
  await expect(page.locator(".goal-execution-metrics")).toHaveCSS("border-top-width", "0px");
  await expect(execution).not.toContainText("下一项任务");
  await expect(execution.locator(".goal-execution-next")).toHaveCount(0);
  await expect(execution.getByText("总进度", { exact: true })).toHaveCount(0);
  await expect(execution.getByText("距离截止", { exact: true })).toHaveCount(0);
  await expect(execution.getByRole("button", { name: "创建第一项任务" })).toHaveCount(0);
  await expect(execution.getByText("还没有任务", { exact: true })).toHaveCount(0);
  await expect(execution.getByText("建立第一项任务后，看板会自动计算节奏", { exact: true })).toHaveCount(0);
  await expect(execution.getByRole("link", { name: "让 Pilo 校准节奏" })).toHaveCount(0);
  await expect(execution.locator(".goal-execution-actions")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "AI 助教", exact: true })).toHaveCount(0);
  await expect(page.locator(".goal-execution-capacity-track > i")).toHaveCSS("animation-name", "goal-execution-load-reveal");
  const capacityTrack = page.locator(".goal-execution-capacity-track");
  const capacity = page.getByRole("region", { name: "每日投入" });
  await expect(capacity).toContainText("计划所需");
  await expect(capacity.locator(".goal-execution-capacity-summary")).not.toContainText("每日可投入");
  await expect(capacity.locator(".goal-execution-capacity-summary")).toContainText("分钟/日");
  const capacityTypography = await capacity.evaluate((element) => ({
    title: Number.parseFloat(getComputedStyle(element.querySelector(":scope > header > span")!).fontSize),
    status: Number.parseFloat(getComputedStyle(element.querySelector(":scope > header > em")!).fontSize),
    labels: Array.from(element.querySelectorAll(".goal-execution-capacity-summary span"), (label) => Number.parseFloat(getComputedStyle(label).fontSize)),
    values: Array.from(element.querySelectorAll(".goal-execution-capacity-summary strong"), (value) => Number.parseFloat(getComputedStyle(value).fontSize)),
  }));
  expect(capacityTypography.title).toBeGreaterThanOrEqual(14);
  expect(capacityTypography.status).toBeGreaterThanOrEqual(12);
  expect(capacityTypography.labels).toEqual([12]);
  expect(capacityTypography.values).toEqual([12]);
  const capacityContentAlignment = await capacity.evaluate((element) => {
    const summary = element.querySelector(".goal-execution-capacity-summary")!.getBoundingClientRect();
    const track = element.querySelector(".goal-execution-capacity-track")!.getBoundingClientRect();
    const footer = element.querySelector(":scope > footer")!.getBoundingClientRect();
    return {
      summaryToTrack: summary.left - track.left,
      footerToTrack: footer.left - track.left,
    };
  });
  expect(Math.abs(capacityContentAlignment.summaryToTrack)).toBeLessThanOrEqual(1);
  expect(Math.abs(capacityContentAlignment.footerToTrack)).toBeLessThanOrEqual(1);
  await expect(capacity.locator(".goal-capacity-status")).toHaveClass(/is-overloaded/);
  const sectionStatusStyles = await execution.locator(".goal-execution-section-status").evaluateAll((statuses) => statuses.map((status) => {
    const style = getComputedStyle(status);
    return {
      fontSize: style.fontSize,
      minHeight: style.minHeight,
      paddingInline: style.paddingInline,
      borderRadius: style.borderRadius,
    };
  }));
  expect(sectionStatusStyles[0]).toEqual(sectionStatusStyles[1]);
  await expect(capacityTrack).toHaveClass(/is-overloaded/);
  await expect(capacityTrack.locator(":scope > em")).toBeVisible();
  const capacityTrackGeometry = await capacityTrack.evaluate((track) => {
    const trackBox = track.getBoundingClientRect();
    const sectionBox = track.closest(".goal-execution-capacity")!.getBoundingClientRect();
    return {
      leftInset: trackBox.left - sectionBox.left,
      rightInset: sectionBox.right - trackBox.right,
    };
  });
  expect(capacityTrackGeometry.leftInset).toBeGreaterThanOrEqual(20);
  expect(Math.abs(capacityTrackGeometry.leftInset - capacityTrackGeometry.rightInset)).toBeLessThanOrEqual(1);
  await expect(execution).toContainText(/超出 \d+%/);
  await expect(execution).toContainText(/超出每日可投入 \d+ 分钟/);
  await expect(page.locator(".goal-execution-week-chart > button").first()).toHaveCSS("animation-name", "goal-execution-bar-reveal");
  const weekChartGeometry = await page.locator(".goal-execution-week-chart").evaluate((element) => {
    const columnBox = element.querySelector("button")!.getBoundingClientRect();
    const trackBox = element.querySelector(".goal-execution-week-track")!.getBoundingClientRect();
    return {
      height: element.getBoundingClientRect().height,
      width: element.getBoundingClientRect().width,
      parentWidth: element.parentElement!.getBoundingClientRect().width,
      centerOffset: element.getBoundingClientRect().left + element.getBoundingClientRect().width / 2
        - (element.parentElement!.getBoundingClientRect().left + element.parentElement!.getBoundingClientRect().width / 2),
      columnWidth: columnBox.width,
      trackWidth: trackBox.width,
      trackCenterOffset: trackBox.left + trackBox.width / 2 - (columnBox.left + columnBox.width / 2),
      planBackground: getComputedStyle(element.querySelector(".goal-execution-week-track > i")!).backgroundImage,
      completedBackground: getComputedStyle(element.querySelector(".goal-execution-week-track > em")!).backgroundImage,
      trackBackground: getComputedStyle(element.querySelector(".goal-execution-week-track")!).backgroundColor,
    };
  });
  expect(weekChartGeometry.height).toBeGreaterThanOrEqual(120);
  expect(weekChartGeometry.width).toBeLessThanOrEqual(weekChartGeometry.parentWidth * 0.9);
  expect(Math.abs(weekChartGeometry.centerOffset)).toBeLessThanOrEqual(1);
  expect(weekChartGeometry.trackWidth).toBeGreaterThan(weekChartGeometry.columnWidth * 0.65);
  expect(weekChartGeometry.trackWidth).toBeLessThan(weekChartGeometry.columnWidth * 0.8);
  expect(Math.abs(weekChartGeometry.trackCenterOffset)).toBeLessThanOrEqual(1);
  expect(weekChartGeometry.planBackground).toContain("linear-gradient");
  expect(weekChartGeometry.completedBackground).toContain("linear-gradient");
  expect(weekChartGeometry.trackBackground).not.toBe("rgba(0, 0, 0, 0)");
  const firstWeekDay = page.locator(".goal-execution-week-chart > button").first();
  const firstWeekTooltip = firstWeekDay.locator(".goal-execution-week-tooltip");
  await expect(firstWeekTooltip).toHaveCSS("opacity", "0");
  await firstWeekDay.hover();
  await expect(firstWeekTooltip).toHaveCSS("opacity", "1");
  await expect(firstWeekTooltip).toContainText("项任务，计划");
  const capacityLineGaps = await page.locator(".goal-execution-week-track > u").evaluateAll((lines) => lines.slice(0, -1).map((line, index) => {
    const current = line.getBoundingClientRect();
    const next = lines[index + 1].getBoundingClientRect();
    return next.left - current.right;
  }));
  expect(Math.max(...capacityLineGaps)).toBeLessThanOrEqual(0);
  const weekSectionGeometry = await page.locator(".goal-execution-week").evaluate((element) => {
    const header = element.querySelector(":scope > header")!.getBoundingClientRect();
    const chart = element.querySelector(".goal-execution-week-chart")!.getBoundingClientRect();
    const footerElement = element.querySelector(":scope > footer")!;
    const footer = footerElement.getBoundingClientRect();
    return {
      headerToChart: chart.top - header.bottom,
      chartToFooter: footer.top - chart.bottom,
      footerFontSize: Number.parseFloat(getComputedStyle(footerElement).fontSize),
      rightPadding: Number.parseFloat(getComputedStyle(element).paddingRight),
    };
  });
  expect(weekSectionGeometry.headerToChart).toBeGreaterThanOrEqual(8);
  expect(weekSectionGeometry.chartToFooter).toBeGreaterThanOrEqual(6);
  expect(weekSectionGeometry.chartToFooter).toBeLessThanOrEqual(10);
  expect(weekSectionGeometry.footerFontSize).toBe(10);
  expect(weekSectionGeometry.rightPadding).toBe(0);
  const legendAlignment = await page.locator(".goal-execution-week").evaluate((element) => {
    const firstLegend = element.querySelector(":scope > footer span")!;
    const firstDate = element.querySelector(".goal-execution-week-chart > button > small")!;
    const firstCharacterLeft = (node: Element) => {
      const textNode = Array.from(node.childNodes).find((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim());
      if (!textNode?.textContent) return Number.POSITIVE_INFINITY;
      const start = textNode.textContent.indexOf(textNode.textContent.trim());
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + 1);
      return range.getBoundingClientRect().left;
    };
    return firstCharacterLeft(firstLegend) - firstCharacterLeft(firstDate);
  });
  expect(Math.abs(legendAlignment)).toBeLessThanOrEqual(1.5);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(300);
  const mobileWeekGeometry = await page.locator(".goal-execution-week").evaluate((element) => {
    const firstLegend = element.querySelector(":scope > footer span")!;
    const firstDate = element.querySelector(".goal-execution-week-chart > button > small")!;
    const firstCharacterLeft = (node: Element) => {
      const textNode = Array.from(node.childNodes).find((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim());
      if (!textNode?.textContent) return Number.POSITIVE_INFINITY;
      const start = textNode.textContent.indexOf(textNode.textContent.trim());
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + 1);
      return range.getBoundingClientRect().left;
    };
    return {
      overflow: element.scrollWidth - element.clientWidth,
      rightPadding: Number.parseFloat(getComputedStyle(element).paddingRight),
      footerDisplay: getComputedStyle(element.querySelector(":scope > footer")!).display,
      footerFontSize: Number.parseFloat(getComputedStyle(element.querySelector(":scope > footer")!).fontSize),
      legendAlignment: firstCharacterLeft(firstLegend) - firstCharacterLeft(firstDate),
    };
  });
  expect(mobileWeekGeometry.overflow).toBeLessThanOrEqual(1);
  expect(mobileWeekGeometry.rightPadding).toBe(0);
  expect(mobileWeekGeometry.footerDisplay).toBe("flex");
  expect(mobileWeekGeometry.footerFontSize).toBe(9);
  expect(Math.abs(mobileWeekGeometry.legendAlignment)).toBeLessThanOrEqual(1.5);
  await page.setViewportSize({ width: 1280, height: 720 });

  for (const height of [720, 600, 520]) {
    await page.setViewportSize({ width: 1280, height });
    const geometry = await page.locator(".goal-execution").evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(geometry.scrollHeight - geometry.clientHeight).toBeLessThanOrEqual(1);
    expect(geometry.overflowY).toBe("hidden");
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.locator(".goal-execution-week-chart > button").nth(1).click();
  await expect(page.getByRole("tab", { name: "任务日历" })).toHaveAttribute("aria-selected", "true");
  const futureDayButton = page.getByRole("button", { name: /打开.*计划 90 分钟，完成 0 分钟/ });
  await expect(futureDayButton).toBeVisible();
  await futureDayButton.click();
  await expect(page.getByRole("tab", { name: "任务日历" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(asDate(nextDate), { exact: true })).toBeVisible();
  const compactCalendar = page.locator(".goal-mini-calendar");
  const calendarLayout = await compactCalendar.evaluate((calendar) => {
    const heading = calendar.querySelector(".goal-mini-calendar-heading")!;
    const title = calendar.querySelector(".goal-mini-calendar-title")!;
    const legend = calendar.querySelector(".goal-mini-calendar-legend")!;
    const body = calendar.querySelector(".goal-mini-calendar-body")!;
    const weekday = calendar.querySelector(".goal-mini-calendar-weekdays > div")!;
    const day = calendar.querySelector(".goal-mini-calendar-days > button")!;
    return {
      bodyWidth: body.getBoundingClientRect().width,
      calendarWidth: calendar.getBoundingClientRect().width,
      titleFontSize: Number.parseFloat(getComputedStyle(title).fontSize),
      legendFontSize: Number.parseFloat(getComputedStyle(legend).fontSize),
      weekdayFontSize: Number.parseFloat(getComputedStyle(weekday).fontSize),
      dayFontSize: Number.parseFloat(getComputedStyle(day).fontSize),
      headingDisplay: getComputedStyle(heading).display,
      legendParent: legend.parentElement?.className ?? "",
    };
  });
  expect(calendarLayout.bodyWidth).toBeLessThan(calendarLayout.calendarWidth * 0.9);
  expect(calendarLayout.titleFontSize).toBe(14);
  expect(calendarLayout.legendFontSize).toBe(11);
  expect(calendarLayout.weekdayFontSize).toBe(12);
  expect(calendarLayout.dayFontSize).toBe(12);
  expect(calendarLayout.headingDisplay).toBe("flex");
  expect(calendarLayout.legendParent).toContain("goal-mini-calendar-heading");
  const compactCalendarCell = page.locator(".goal-mini-calendar button").filter({ hasText: String(nextDate.getDate()) }).last();
  const calendarCellBox = await compactCalendarCell.boundingBox();
  expect(calendarCellBox?.height ?? 100).toBeLessThanOrEqual(28);
  const compactCalendarGeometry = await page.locator(".goal-mini-calendar").evaluate((calendar) => ({
    height: calendar.getBoundingClientRect().height,
    dayGridHeight: calendar.querySelector(".goal-mini-calendar-days")!.getBoundingClientRect().height,
  }));
  expect(compactCalendarGeometry.height).toBeLessThanOrEqual(225);
  expect(compactCalendarGeometry.dayGridHeight).toBeLessThanOrEqual(165);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".goal-execution-capacity-track > i")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".goal-execution-capacity-track > em")).toHaveCSS("animation-name", "none");

});

test("管理员目标接口失败时不回退到演示目标", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: {
      id: "admin-goal-error",
      email: "admin@example.com",
      username: "管理员",
      is_admin: true,
      email_verified: true,
      onboarding_completed: true,
    },
  }));
  await page.route("**/api/v1/goals/1", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ detail: "目标服务暂不可用" }),
  }));

  await page.goto("/studio/work/goals/1");
  await expect(page.locator(".pp-data-sync-notice[role='alert']")).toContainText("目标数据同步失败");
  await expect(page.getByText("目标数据同步失败，请重试。", { exact: true })).toBeVisible();
  await expect(page.getByText("算法基础体系化", { exact: true })).toHaveCount(0);
  await expect(page.getByText("目标内容暂未显示", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
});

test("访客目标详情使用本地进度，不请求受保护接口", async ({ page }) => {
  let guestProgressRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/goals/guest-exam/progress")) guestProgressRequests += 1;
  });

  await page.goto("/studio/work/goals/guest-exam");
  const execution = page.getByRole("region", { name: "当前目标执行节奏" });
  await expect(execution.locator(".goal-metric-card-progress")).toContainText("42%");
  await expect(execution.locator(".goal-metric-card-progress")).toHaveAttribute("data-detail", "8/19 项完成");
  await expect(execution.locator(".goal-metric-card-streak")).toContainText("4天");
  await expect(execution).not.toContainText("目标进度暂未显示");
  await expect(page.locator(".pp-data-sync-notice")).toHaveCount(0);
  expect(guestProgressRequests).toBe(0);
});

test("管理员学习计划接口失败时显示错误而不是空计划", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: {
      id: "admin-plan-error",
      email: "admin@example.com",
      username: "管理员",
      is_admin: true,
      email_verified: true,
      onboarding_completed: true,
    },
  }));
  await page.route("**/api/v1/goals/goal-tech-1/progress", (route) => route.fulfill({
    json: { goal_id: goal.id, total_tasks: 0, completed_tasks: 0, avg_completion_rate: 0, streak_days: 0, debt_count: 0, days_ahead_or_behind: 0 },
  }));
  await page.route("**/api/v1/goals/goal-tech-1/plan", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ detail: "计划服务暂不可用" }),
  }));
  await page.route("**/api/v1/goals/goal-tech-1", (route) => route.fulfill({ json: goal }));
  await page.route("**/api/v1/debts/goal-tech-1", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: [] }));

  await page.goto("/studio/work/goals/goal-tech-1");
  await page.getByRole("button", { name: "学习计划", exact: true }).click();
  await expect(page.locator(".pp-data-sync-notice[role='alert']")).toContainText("学习计划同步失败");
  await expect(page.getByText("学习计划同步失败，请重试。", { exact: true })).toBeVisible();
  await expect(page.getByText("还没有学习计划", { exact: true })).toHaveCount(0);
  const planErrorState = page.locator(".goal-plan-error");
  await expect(planErrorState).toContainText("学习计划暂未显示");
  await expect(planErrorState).toContainText("目标和任务仍可正常使用");
  await expect(planErrorState.locator(".goal-execution-empty-icon")).toHaveCSS("border-radius", "50%");
  await expect(planErrorState.locator("strong")).toHaveCSS("font-size", "17px");
  await expect(planErrorState.locator("p")).toHaveCSS("font-size", "13px");
  const planSyncNotice = page.locator(".pp-data-sync-notice[role='alert']");
  await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
  await page.waitForTimeout(250);
  const planNoticeGeometry = await planSyncNotice.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      parent: element.parentElement?.tagName,
      position: getComputedStyle(element).position,
      top: rect.top,
      rightGap: window.innerWidth - rect.right,
    };
  });
  expect(planNoticeGeometry.parent).toBe("BODY");
  expect(planNoticeGeometry.position).toBe("fixed");
  expect(planNoticeGeometry.top).toBeCloseTo(18, 0);
  expect(planNoticeGeometry.rightGap).toBeCloseTo(24, 0);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(250);
  const mobilePlanNoticeGeometry = await planSyncNotice.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      rightGap: window.innerWidth - rect.right,
    };
  });
  expect(mobilePlanNoticeGeometry.top).toBeCloseTo(10, 0);
  expect(mobilePlanNoticeGeometry.left).toBeCloseTo(64, 0);
  expect(mobilePlanNoticeGeometry.rightGap).toBeCloseTo(12, 0);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("authenticated 目标列表 503 时不显示演示目标并可重试", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "list-error-user", email: "list@example.com", username: "列表用户", email_verified: true, onboarding_completed: true },
  }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ status: 503, json: { detail: "目标服务暂不可用" } }));
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: [] }));

  await page.goto("/studio/work/goals");
  await expect(page.locator(".pp-data-sync-notice[role='alert']")).toContainText("目标同步失败");
  await expect(page.locator(".pp-data-sync-notice[role='alert']")).toContainText(/目标服务暂不可用|503/);
  await expect(page.getByRole("button", { name: "重新加载", exact: true })).toBeVisible();
  await expect(page.getByText("目标列表暂未显示", { exact: true })).toBeVisible();
  await expect(page.getByText("你的目标数据没有被清空。连接恢复后，点击右上角“重新加载”即可继续。", { exact: true })).toBeVisible();
  await expect(page.getByText("算法基础体系化", { exact: true })).toHaveCount(0);
  await expect(page.locator(".goal-list-row")).toHaveCount(0);
});

test("批量进度失败与真实 0% 明确区分", async ({ page }) => {
  const zeroGoal = { ...goal, id: "zero-goal", title: "真实零进度目标" };
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "progress-error-user", email: "progress@example.com", username: "进度用户", email_verified: true, onboarding_completed: true },
  }));
  await page.route("**/api/v1/goals/progress", (route) => route.fulfill({ status: 503, json: { detail: "进度服务暂不可用" } }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: [zeroGoal] }));
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: [] }));

  await page.goto("/studio/work/goals");
  const overviewPanel = page.locator(".goal-insight-panel").filter({ hasText: "总体进度" });
  await expect(page.locator(".pp-data-sync-notice[role='alert']")).toContainText("目标进度同步失败");
  await expect(overviewPanel.getByRole("status")).toContainText("进度数据暂未显示");
  await expect(overviewPanel).toContainText("目标本身仍然存在");
  await expect(overviewPanel.locator(".goal-donut strong")).toHaveText("—");
  await expect(page.locator(".product-data-state[role='alert']")).toHaveCount(0);
  const row = page.locator(".goal-list-row").filter({ hasText: "真实零进度目标" });
  await expect(row.locator(".goal-list-progress strong")).toHaveText("--");
  await expect(row).toContainText("进度暂不可同步");
  await expect(row).not.toContainText("0%");
  await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
  await expect(overviewPanel).not.toContainText("有风险目标0 个");
});

test("active completed paused abandoned 四种基础状态过滤准确且风险独立", async ({ page }) => {
  const statusGoals = [
    { ...goal, id: "active-goal", title: "进行目标", status: "active" },
    { ...goal, id: "completed-goal", title: "完成目标", status: "completed" },
    { ...goal, id: "paused-goal", title: "暂停目标", status: "paused" },
    { ...goal, id: "archived-goal", title: "归档目标", status: "abandoned" },
  ];
  const progressRows = [
    { goal_id: "active-goal", total_tasks: 10, completed_tasks: 3, avg_completion_rate: .3, streak_days: 1, debt_count: 2, days_ahead_or_behind: -1 },
    { goal_id: "completed-goal", total_tasks: 10, completed_tasks: 10, avg_completion_rate: 1, streak_days: 2, debt_count: 0, days_ahead_or_behind: 0 },
    { goal_id: "paused-goal", total_tasks: 10, completed_tasks: 4, avg_completion_rate: .4, streak_days: 0, debt_count: 0, days_ahead_or_behind: 0 },
    { goal_id: "archived-goal", total_tasks: 10, completed_tasks: 5, avg_completion_rate: .5, streak_days: 0, debt_count: 0, days_ahead_or_behind: 0 },
  ];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "status-user", email: "status@example.com", username: "状态用户", email_verified: true, onboarding_completed: true },
  }));
  await page.route("**/api/v1/goals/progress", (route) => route.fulfill({ json: progressRows }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: statusGoals }));
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: [] }));

  await page.goto("/studio/work/goals");
  await page.getByRole("tab", { name: "进行中", exact: true }).click();
  await expect(page.locator(".goal-list-row")).toHaveCount(1);
  await expect(page.locator(".goal-list-row")).toContainText("进行目标");
  await expect(page.locator(".goal-list-row")).toContainText("有风险");
  await page.getByRole("tab", { name: "已完成", exact: true }).click();
  await expect(page.locator(".goal-list-row")).toHaveText(/完成目标/);
  await page.getByRole("tab", { name: "已暂停", exact: true }).click();
  await expect(page.locator(".goal-list-row")).toHaveText(/暂停目标/);
  await expect(page.locator(".goal-list-row")).not.toContainText("已归档");
  await page.getByRole("tab", { name: "已归档", exact: true }).click();
  await expect(page.locator(".goal-list-row")).toHaveText(/归档目标/);
});

test("canonical 新建编辑深链刷新与浏览器返回保持一致", async ({ page }) => {
  await page.goto("/studio/work/goals");
  await page.locator(".goals-list-panel").getByRole("button", { name: "新建目标", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/work\/goals\/new$/);
  await expect(page.getByRole("dialog", { name: "创建新目标" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/studio\/work\/goals$/);

  const menu = page.getByLabel("管理目标 算法基础体系化");
  await menu.click();
  await page.getByRole("menuitem", { name: "编辑目标 算法基础体系化" }).click();
  await expect(page).toHaveURL(/\/studio\/work\/goals\/1\/edit$/);
  await page.reload();
  await expect(page.getByRole("dialog", { name: "编辑目标" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/studio\/work\/goals$/);
});

test("编辑目标加载失败后可重试且类型按 API 数据恢复", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "edit-retry-user", email: "edit@example.com", username: "编辑用户", email_verified: true, onboarding_completed: true },
  }));
  await page.route("**/api/v1/goals/edit-retry/plan", (route) => route.fulfill({ json: { plan: null } }));
  await page.route("**/api/v1/goals/edit-retry", (route) => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 503, json: { detail: "读取失败" } });
    return route.fulfill({ json: { ...goal, id: "edit-retry", type: "language", title: "语言目标", work_schedule: "weekend", version: 2 } });
  });

  await page.goto("/studio/work/goals/edit-retry/edit");
  await expect(page.locator(".tech-goal-form-state[role='alert']")).toContainText("目标加载失败");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑目标" });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "目标名称" })).toHaveValue("语言目标");
  await expect(editor.getByRole("button", { name: "语言学习", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByRole("button", { name: "仅周末", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("总体进度按未归档目标任务加权并单列尚未规划", async ({ page }) => {
  const weightedGoals = [
    { ...goal, id: "weighted-a", title: "两项任务目标", status: "active" },
    { ...goal, id: "weighted-b", title: "十项任务目标", status: "completed" },
    { ...goal, id: "weighted-archived", title: "归档满进度", status: "abandoned" },
    { ...goal, id: "weighted-empty", title: "尚未规划目标", status: "active" },
  ];
  const weightedProgress = [
    { goal_id: "weighted-a", total_tasks: 2, completed_tasks: 1, avg_completion_rate: .5, streak_days: 0, debt_count: 0, days_ahead_or_behind: 0 },
    { goal_id: "weighted-b", total_tasks: 10, completed_tasks: 9, avg_completion_rate: .9, streak_days: 0, debt_count: 0, days_ahead_or_behind: 0 },
    { goal_id: "weighted-archived", total_tasks: 10, completed_tasks: 10, avg_completion_rate: 1, streak_days: 0, debt_count: 0, days_ahead_or_behind: 0 },
    { goal_id: "weighted-empty", total_tasks: 0, completed_tasks: 0, avg_completion_rate: 0, streak_days: 0, debt_count: 0, days_ahead_or_behind: 0 },
  ];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "weighted-user", email: "weighted@example.com", username: "统计用户", email_verified: true, onboarding_completed: true },
  }));
  await page.route("**/api/v1/goals/progress", (route) => route.fulfill({ json: weightedProgress }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: weightedGoals }));
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: [] }));

  await page.goto("/studio/work/goals");
  await expect(page.locator(".goal-donut:visible strong")).toHaveText("83%");
  const completionLegend = page.locator(".goal-legend > span").filter({ hasText: "任务完成" });
  await expect(completionLegend).toContainText("10/12");
  await expect(completionLegend).toHaveAttribute("role", "button");
  const unplannedLegend = page.locator(".goal-legend > span").filter({ hasText: "尚未规划" });
  await expect(unplannedLegend).toBeVisible();
  await unplannedLegend.click();
  await expect(page.locator(".goal-list-row")).toHaveCount(1);
  await expect(page.locator(".goal-list-row")).toContainText("尚未规划目标");
});

test("结构化摘要跳转到真实目标任务且当前标记只用于今日任务", async ({ page }) => {
  const today = new Date();
  const todayIso = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");
  const deadline = new Date(today);
  deadline.setDate(deadline.getDate() + 20);
  const deadlineIso = [deadline.getFullYear(), String(deadline.getMonth() + 1).padStart(2, "0"), String(deadline.getDate()).padStart(2, "0")].join("-");
  await page.addInitScript(({ currentDate, endDate }) => {
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
    window.localStorage.setItem("planpilot-v2-goals", JSON.stringify([{
      id: "summary-goal", name: "摘要跳转目标", type: "技能提升", progress: 20, deadline: "稍后", deadlineDate: endDate,
      daily: "30 分钟", status: "进行中", next: "备用下一步", taskSummary: "1 / 5 个任务", rhythmSummary: "连续学习 1 天",
    }]));
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify([{
      id: "today-summary-task", goalId: "summary-goal", goalTitle: "摘要跳转目标", title: "今天完成结构化摘要", date: currentDate, done: false,
    }]));
  }, { currentDate: todayIso, endDate: deadlineIso });

  await page.goto("/studio/work/goals");
  const summaryLink = page.getByRole("link", { name: /摘要跳转目标\s+下一步：今天完成结构化摘要/ });
  await expect(summaryLink).toHaveAttribute("href", "/studio/work/goals/summary-goal?taskId=today-summary-task");
  await expect(summaryLink.locator(".goal-milestone-dot")).toHaveClass(/is-current/);
  await summaryLink.click();
  await expect(page).toHaveURL(/\/studio\/work\/goals\/summary-goal\?taskId=today-summary-task$/);
});

test("390 与 375 宽度保持无横向溢出且关键入口可键盘操作", async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/studio/work/goals");
    await expect(page.getByRole("heading", { name: "目标管理" })).toBeVisible();
    const geometry = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    const goalLink = page.getByRole("link", { name: "查看目标 算法基础体系化" });
    await goalLink.focus();
    await expect(goalLink).toBeFocused();
    const menu = page.getByLabel("管理目标 算法基础体系化");
    await menu.focus();
    await menu.press("Enter");
    await expect(page.getByRole("menuitem", { name: "编辑目标 算法基础体系化" })).toBeVisible();
  }
});

test("新建表单关闭与返回不会静默丢失未保存输入", async ({ page }) => {
  await page.goto("/studio/work/goals/new");
  const dialog = page.getByRole("dialog", { name: "创建新目标" });
  const title = dialog.getByRole("textbox", { name: "目标名称" });
  await title.fill("尚未保存的目标");

  await dialog.getByRole("button", { name: "关闭目标设置" }).click();
  const discardDialog = page.getByRole("alertdialog", { name: "放弃当前目标设置？" });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole("button", { name: "继续编辑" }).click();
  await expect(dialog).toBeVisible();
  await expect(title).toHaveValue("尚未保存的目标");

  await dialog.getByRole("button", { name: "关闭目标设置" }).click();
  await page.getByRole("alertdialog", { name: "放弃当前目标设置？" }).getByRole("button", { name: "放弃修改" }).click();
  await expect(page).toHaveURL(/\/studio\/work\/goals$/);
});

test("编辑计划依据后提示检查计划并持久化新类型", async ({ page }) => {
  let currentGoal = { ...goal, work_schedule: "all", version: 1 };
  let patchPayload: Record<string, unknown> | null = null;
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "basis-user", email: "basis@example.com", username: "计划用户", email_verified: true, onboarding_completed: true },
  }));
  await page.route("**/api/v1/goals/goal-tech-1/plan", (route) => route.fulfill({ json: { plan: { phases: [] } } }));
  await page.route("**/api/v1/goals/goal-tech-1", async (route) => {
    if (route.request().method() === "PATCH") {
      patchPayload = route.request().postDataJSON() as Record<string, unknown>;
      currentGoal = { ...currentGoal, ...patchPayload, version: currentGoal.version + 1 } as typeof currentGoal;
    }
    await route.fulfill({ json: currentGoal });
  });
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/debts/goal-tech-1", (route) => route.fulfill({ json: [] }));

  await page.goto("/studio/work/goals/goal-tech-1/edit");
  const editor = page.getByRole("dialog", { name: "编辑目标" });
  await editor.getByRole("button", { name: "语言学习", exact: true }).click();
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByText("计划依据已变化，建议检查并按需调整现有计划。", { exact: true })).toBeVisible();
  expect(patchPayload).toMatchObject({ type: "language" });
  await page.getByRole("button", { name: "稍后检查" }).click();
  await page.goto("/studio/work/goals/goal-tech-1/edit");
  await expect(page.getByRole("dialog", { name: "编辑目标" }).getByRole("button", { name: "语言学习", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("单目标进度加载失败显示错误并可重试", async ({ page }) => {
  let progressAttempts = 0;
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "single-progress-user", email: "single@example.com", username: "单目标用户", email_verified: true, onboarding_completed: true },
  }));
  await page.route("**/api/v1/goals/goal-tech-1/progress", (route) => {
    progressAttempts += 1;
    if (progressAttempts === 1) return route.fulfill({ status: 503, json: { detail: "进度读取失败" } });
    return route.fulfill({ json: { goal_id: goal.id, total_tasks: 4, completed_tasks: 1, avg_completion_rate: .25, streak_days: 1, debt_count: 0, days_ahead_or_behind: 0 } });
  });
  await page.route("**/api/v1/goals/goal-tech-1/plan", (route) => route.fulfill({ json: { plan: null } }));
  await page.route("**/api/v1/goals/goal-tech-1", (route) => route.fulfill({ json: goal }));
  await page.route("**/api/v1/tasks", (route) => route.fulfill({
    json: [{
      id: "progress-error-task",
      goalId: goal.id,
      goalTitle: goal.title,
      title: "验证进度同步",
      date: "2026-08-21",
      done: false,
      estimatedMinutes: 30,
      priority: "medium",
    }],
  }));
  await page.route("**/api/v1/debts/goal-tech-1", (route) => route.fulfill({ json: [] }));

  await page.goto("/studio/work/goals/goal-tech-1");
  const syncNotice = page.locator(".pp-data-sync-notice[role='alert']");
  await expect(syncNotice).toContainText("目标进度同步失败");
  const noticeGeometry = await syncNotice.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      parent: element.parentElement?.tagName,
      top: rect.top,
      rightGap: window.innerWidth - rect.right,
    };
  });
  expect(noticeGeometry.parent).toBe("BODY");
  expect(noticeGeometry.top).toBeLessThanOrEqual(24);
  expect(noticeGeometry.rightGap).toBeCloseTo(24, 0);
  await page.setViewportSize({ width: 375, height: 812 });
  const mobileNoticeGeometry = await syncNotice.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, rightGap: window.innerWidth - rect.right };
  });
  expect(mobileNoticeGeometry.top).toBeLessThanOrEqual(16);
  expect(mobileNoticeGeometry.rightGap).toBeCloseTo(12, 0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByText("目标进度暂未显示", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.locator(".goal-metric-card-progress")).toContainText("25%");
});

test("目标任务编辑器保持清晰层级", async ({ page }) => {
  const today = new Date();
  const todayIso = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  const task = {
    id: "task-inline-editor",
    goalId: goal.id,
    goalTitle: goal.title,
    title: "知识图谱链",
    description: "agent 开发",
    date: todayIso,
    done: true,
    estimatedMinutes: 40,
    priority: "medium",
  };

  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "task-editor-user", email: "editor@example.com", username: "任务用户", email_verified: true, onboarding_completed: true },
  }));
  await page.route("**/api/v1/goals/goal-tech-1/progress", (route) => route.fulfill({
    json: { goal_id: goal.id, total_tasks: 1, completed_tasks: 1, avg_completion_rate: 1, streak_days: 1, debt_count: 0, days_ahead_or_behind: 0 },
  }));
  await page.route("**/api/v1/goals/goal-tech-1/plan", (route) => route.fulfill({ json: { plan: null } }));
  await page.route("**/api/v1/goals/goal-tech-1", (route) => route.fulfill({ json: goal }));
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: [task] }));
  await page.route("**/api/v1/debts/goal-tech-1", (route) => route.fulfill({ json: [] }));

  await page.goto("/studio/work/goals/goal-tech-1");
  const row = page.locator(".goal-task-item").first();
  await row.getByRole("button", { name: `编辑任务“${task.title}”` }).click();
  const editor = row.locator(".goal-task-inline-editor");
  await expect(editor.getByText("预计时长", { exact: true })).toBeVisible();
  await expect(editor.getByText("优先级", { exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "中", exact: true })).toHaveAttribute("aria-pressed", "true");
  const editorGeometry = await editor.evaluate((element) => {
    const rowRect = element.closest(".goal-task-item")!.getBoundingClientRect();
    const editorRect = element.getBoundingClientRect();
    const title = element.querySelector<HTMLElement>(".goal-task-editor-title")!;
    const minutes = element.querySelector<HTMLElement>(".goal-task-minutes")!;
    const priorities = [...element.querySelectorAll<HTMLElement>(".goal-task-priority-option")];
    const actions = [...element.querySelectorAll<HTMLElement>(".goal-task-editor-actions button")];
    return {
      rightOverflow: editorRect.right - rowRect.right,
      titleFont: getComputedStyle(title).fontSize,
      minutesFont: getComputedStyle(minutes).fontSize,
      priorityFonts: priorities.map((button) => getComputedStyle(button).fontSize),
      priorityHeights: priorities.map((button) => button.getBoundingClientRect().height),
      actionSizes: actions.map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
    };
  });
  expect(editorGeometry.rightOverflow).toBeLessThanOrEqual(0);
  expect(editorGeometry.titleFont).toBe("14px");
  expect(editorGeometry.minutesFont).toBe("13px");
  expect(new Set(editorGeometry.priorityFonts)).toEqual(new Set(["12px"]));
  expect(Math.min(...editorGeometry.priorityHeights)).toBeGreaterThanOrEqual(28);
  expect(editorGeometry.actionSizes).toEqual([{ width: 34, height: 34 }, { width: 34, height: 34 }]);

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileGeometry = await editor.evaluate((element) => {
    const rowRect = element.closest(".goal-task-item")!.getBoundingClientRect();
    const editorRect = element.getBoundingClientRect();
    const controls = element.querySelector<HTMLElement>(".goal-task-editor-controls")!.getBoundingClientRect();
    return {
      leftOverflow: rowRect.left - editorRect.left,
      rightOverflow: editorRect.right - rowRect.right,
      controlsHeight: controls.height,
    };
  });
  expect(mobileGeometry.leftOverflow).toBeLessThanOrEqual(0);
  expect(mobileGeometry.rightOverflow).toBeLessThanOrEqual(0);
  expect(mobileGeometry.controlsHeight).toBeGreaterThanOrEqual(38);
});
