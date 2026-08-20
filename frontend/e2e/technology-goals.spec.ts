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
  await expect(page).toHaveURL(/\/studio\/work\/goals$/);
  const editGoalDialog = page.getByRole("dialog", { name: "编辑目标" });
  await expect(editGoalDialog).toBeVisible();
  await expect(editGoalDialog.getByRole("textbox", { name: "目标名称" })).toHaveValue("算法基础体系化");
  await editGoalDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editGoalDialog).toHaveCount(0);
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

  await titlebar.getByRole("button", { name: "执行任务搜索" }).click();
  await page.getByRole("button", { name: /动态规划历史复盘/ }).click();
  await expect(page).toHaveURL(/\/studio\/work\/goals\/1\?taskId=task-history-1/);
  await expect(page.getByText("算法基础体系化", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("数据指标", { exact: true })).toBeVisible();
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
    window.localStorage.setItem("planpilot-v2-goals", JSON.stringify([
      {
        id: 1, name: "临期复习计划", type: "考试备考", progress: 32, deadline: "两天后", deadlineDate: deadline,
        daily: "45 分钟", status: "有风险", next: "重新安排复习范围", taskSummary: "4 / 12 个任务", rhythmSummary: "3 项知识待复习",
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
  await expect(page.getByRole("menuitem", { name: "编辑目标 临期复习计划" })).toBeVisible();
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
    return {
      zIndex: Number.parseInt(getComputedStyle(menu).zIndex, 10),
      pagebarOverflow: pagebar ? getComputedStyle(pagebar).overflow : "",
      insideViewport: menuRect.right <= window.innerWidth && menuRect.bottom <= window.innerHeight,
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
    };
  });
  expect(milestoneTypography.triggerSize).toBeGreaterThanOrEqual(13);
  expect(milestoneTypography.titleSize).toBeGreaterThan(milestoneTypography.descriptionSize);
  expect(milestoneTypography.titleColor).not.toBe(milestoneTypography.descriptionColor);
  expect(milestoneTypography.descriptionTransform).not.toBe("none");
  expect(milestoneTypography.panelOverflow).toBe("visible");
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

  await expect(page).toHaveURL(/\/studio\/work\/goals$/);
  await expect(page.getByRole("dialog", { name: "创建新目标" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "创建新目标", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "目标类型", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "如何完成目标", exact: true })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "如何完成目标", exact: true })).toBeVisible();
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
  expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight);
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
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: [goal] }));
  await page.goto("/studio/work/goals/goal-tech-1/edit");

  const editor = page.locator(".tech-goal-form-page.is-editing");
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("heading", { name: "编辑目标", exact: true })).toBeVisible();
  await expect(editor.getByRole("heading", { name: "目标类型", exact: true })).toBeVisible();
  await expect(editor.getByRole("heading", { name: "如何完成目标", exact: true })).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "目标名称" })).toHaveValue("agent 开发");
  await expect(editor.getByRole("button", { name: "技能", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByText("目标状态", { exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "进行中", exact: true })).toHaveAttribute("aria-pressed", "true");
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
    window.localStorage.setItem("planpilot-v2-goals", JSON.stringify(items));
  }, storedGoals);

  await page.goto("/studio/work/goals");
  await expect(page.getByRole("button", { name: /切换目标动态范围/ })).toHaveCount(0);
  const activeMilestones = page.locator(".goal-milestones-list").filter({ hasText: "唯一进行中目标" }).first();
  await expect(activeMilestones).toContainText("唯一进行中目标");
  await expect(activeMilestones).not.toContainText("已归档目标");
});

test("目标状态摘要区分轻微风险并采用最早未完成任务", async ({ page }) => {
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
  }];
  const storedTasks = [
    { id: "done-first", goalId: "minor-risk", goalTitle: "轻微偏差目标", title: "已经完成的任务", date: "2026-08-18", done: true },
    { id: "next-first", goalId: "minor-risk", goalTitle: "轻微偏差目标", title: "先复习状态转移", date: "2026-08-19", done: false },
    { id: "next-later", goalId: "minor-risk", goalTitle: "轻微偏差目标", title: "再整理复杂度", date: "2026-08-20", done: false },
  ];
  await page.addInitScript(({ goals, tasks }) => {
    window.localStorage.setItem("planpilot-v2-goals", JSON.stringify(goals));
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify(tasks));
  }, { goals: storedGoals, tasks: storedTasks });

  await page.goto("/studio/work/goals");
  const summary = page.getByRole("region", { name: "目标状态摘要" });
  await expect(summary).toContainText("轻微偏差目标有 1 项待复习知识需要安排");
  await expect(summary).toContainText("需要关注");
  await expect(summary).not.toContainText("优先处理");
  await expect(summary).toContainText("轻微偏差目标下一步：先复习状态转移");
  await expect(summary).toContainText("下一项任务");
  await expect(summary).not.toContainText("已经完成的任务");
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
  await page.route("**/api/v1/goals/goal-tech-1/progress", (route) => route.fulfill({
    json: { goal_id: goal.id, total_tasks: 89, completed_tasks: 0, avg_completion_rate: 0, streak_days: 0, debt_count: 0, days_ahead_or_behind: 0 },
  }));
  await page.route("**/api/v1/goals/goal-tech-1/plan", (route) => route.fulfill({ json: { plan: null } }));
  await page.route("**/api/v1/goals/goal-tech-1", (route) => route.fulfill({ json: goal }));
  await page.route("**/api/v1/debts/goal-tech-1", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/tasks", (route) => route.fulfill({ json: [] }));

  await page.goto("/studio/work/goals/goal-tech-1");

  await expect(page.getByText("数据指标", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "任务", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "相关笔记", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "执行节奏", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "学习计划", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "搜索今日任务" })).toHaveCount(0);

  const createTaskButton = page.getByRole("button", { name: "新建任务", exact: true });
  await expect(page.getByText("目标资源", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "写目标复盘", exact: true })).toHaveCount(0);
  await expect(createTaskButton).toBeVisible();
  await expect(createTaskButton).toHaveCSS("height", "24px");

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
    const rightPanel = element.querySelector(".goal-detail-right")?.getBoundingClientRect();
    return {
      leftGap: scope.left - (content?.left ?? scope.left),
      widthReduction: (content?.width ?? scope.width) - scope.width,
      rightPanelWidth: rightPanel?.width ?? 0,
    };
  });
  expect(workspaceGeometry.leftGap).toBeCloseTo(22, 0);
  expect(workspaceGeometry.widthReduction).toBeCloseTo(workspaceGeometry.leftGap, 0);
  expect(workspaceGeometry.rightPanelWidth).toBeGreaterThan(300);
  await expect(page.locator(".goal-detail-body")).toHaveCSS("gap", "4px");
  await expect(page.locator(".goal-detail-left")).toHaveCSS("border-radius", "14px");
  await expect(page.locator(".goal-detail-right")).toHaveCSS("border-radius", "14px");
  const panelResizer = page.getByRole("separator", { name: "调整左右面板宽度" });
  await expect(panelResizer).toHaveCSS("width", "4px");
  await expect(panelResizer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const leftWidthBeforeKeyboardResize = (await page.locator(".goal-detail-left").boundingBox())?.width ?? 0;
  await panelResizer.press("ArrowRight");
  await page.waitForTimeout(400);
  const leftWidthAfterKeyboardResize = (await page.locator(".goal-detail-left").boundingBox())?.width ?? 0;
  expect(leftWidthAfterKeyboardResize).toBeCloseTo(leftWidthBeforeKeyboardResize + 20, 0);

  const statsToggle = page.locator(".goal-stats-heading");
  await expect(statsToggle).toHaveAttribute("aria-expanded", "true");
  await statsToggle.click();
  await expect(statsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".goal-stats-content")).toHaveAttribute("aria-hidden", "true");
  await statsToggle.click();
  await expect(statsToggle).toHaveAttribute("aria-expanded", "true");

  await expect(page.getByRole("button", { name: /(收起|展开)数据与任务面板/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /(收起|展开)AI与学习计划面板/ })).toHaveCount(0);
  await expect(page.getByText("今天还没有任务", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建第一个任务", exact: true })).toBeVisible();
  const emptyExecution = page.getByRole("region", { name: "当前目标执行节奏" });
  await expect(emptyExecution).toContainText("今天尚未安排任务");
  await expect(emptyExecution).toContainText("投入匹配");
  await expect(emptyExecution.getByText("总进度", { exact: true })).toHaveCount(0);
  await expect(emptyExecution).toHaveClass(/is-next-task-empty/);
  await expect(emptyExecution.getByText("下一项任务", { exact: true })).toHaveCount(0);
  await expect(emptyExecution.getByText("还没有任务", { exact: true })).toHaveCount(0);
  await expect(emptyExecution.getByText("建立第一项任务后，看板会自动计算节奏", { exact: true })).toHaveCount(0);
  await expect(emptyExecution.getByRole("button", { name: "创建第一项任务" })).toHaveCount(0);
  await expect(emptyExecution.getByRole("link", { name: "让 Pilo 帮我拆分" })).toHaveCount(0);
  await expect(emptyExecution.locator(".goal-execution-actions")).toHaveCount(0);
  expect((await emptyExecution.locator(".goal-execution-week-chart").boundingBox())?.height ?? 0).toBeGreaterThan(150);

  for (const height of [720, 600, 520]) {
    await page.setViewportSize({ width: 1280, height });
    const emptyGeometry = await emptyExecution.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(emptyGeometry.scrollHeight - emptyGeometry.clientHeight).toBeLessThanOrEqual(1);
    expect(emptyGeometry.overflowY).toBe("hidden");
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "新建第一个任务", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "任务名称" })).toBeFocused();

  await page.getByRole("button", { name: "学习计划", exact: true }).click();
  await expect(page.getByText("还没有学习计划", { exact: true })).toBeVisible();
  await expect(page.getByText("先选择参考资料如何参与，再生成阶段安排", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "设置资料并生成计划", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "选择计划生成方式" })).toBeVisible();
});

test("执行节奏与左侧指标互补并在不同高度内保持单屏", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: {
      id: "user-goal-execution",
      email: "learner@example.com",
      username: "学习者",
      email_verified: true,
      onboarding_completed: true,
    },
  }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: [goal] }));
  await page.route("**/api/v1/goals/goal-tech-1/progress", (route) => route.fulfill({
    json: { goal_id: goal.id, total_tasks: 89, completed_tasks: 0, avg_completion_rate: 0, streak_days: 0, debt_count: 8, days_ahead_or_behind: -2 },
  }));
  await page.route("**/api/v1/goals/goal-tech-1/plan", (route) => route.fulfill({ json: { plan: null } }));
  await page.route("**/api/v1/goals/goal-tech-1", (route) => route.fulfill({ json: goal }));
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
  const progressBadge = page.locator(".goal-metric-card-progress .goal-metric-badge");
  const debtBadge = page.locator(".goal-metric-card-debt .goal-metric-badge");
  await expect(progressBadge).toContainText("待加速");
  await expect(debtBadge).toContainText("需关注");
  const [progressBadgeColor, debtBadgeColor] = await Promise.all([
    progressBadge.evaluate((element) => getComputedStyle(element).color),
    debtBadge.evaluate((element) => getComputedStyle(element).color),
  ]);
  expect(progressBadgeColor).not.toBe(debtBadgeColor);

  const execution = page.getByRole("region", { name: "当前目标执行节奏" });
  await expect(execution).toContainText("今天还剩 1 项");
  await expect(execution).toContainText("今日完成");
  await expect(execution).toContainText("1/2");
  await expect(execution).toContainText("2.5 小时");
  await expect(execution).toContainText("未来 7 天");
  await expect(execution).toContainText("3 项已安排");
  await expect(execution).toContainText("实现 Agent 工具调用");
  await expect(execution.getByText("总进度", { exact: true })).toHaveCount(0);
  await expect(execution.getByText("距离截止", { exact: true })).toHaveCount(0);
  await expect(execution.getByRole("button", { name: "创建第一项任务" })).toHaveCount(0);
  await expect(execution.getByText("还没有任务", { exact: true })).toHaveCount(0);
  await expect(execution.getByText("建立第一项任务后，看板会自动计算节奏", { exact: true })).toHaveCount(0);
  await expect(execution.getByRole("link", { name: "让 Pilo 校准节奏" })).toHaveCount(0);
  await expect(execution.locator(".goal-execution-actions")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "AI 助教", exact: true })).toHaveCount(0);
  await expect(page.locator(".goal-execution-capacity-track > i")).toHaveCSS("animation-name", "goal-execution-load-reveal");
  await expect(page.locator(".goal-execution-day-track > i.has-tasks").first()).toHaveCSS("animation-name", "goal-execution-bar-reveal");

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

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".goal-execution-capacity-track > i")).toHaveCSS("animation-name", "none");

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
  await expect(page.getByText("目标数据同步失败，请重试。", { exact: true })).toBeVisible();
  await expect(page.getByText("算法基础体系化", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重试读取目标" })).toBeVisible();
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
  await expect(page.getByText("学习计划同步失败，请重试。", { exact: true })).toBeVisible();
  await expect(page.getByText("还没有学习计划", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重试读取计划" })).toBeVisible();
});
