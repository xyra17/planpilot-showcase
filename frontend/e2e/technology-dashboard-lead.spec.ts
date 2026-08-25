import { expect, test, type Page } from "@playwright/test";

async function dismissGuestHomeIntro(page: Page) {
  const dialog = page.getByRole("dialog", { name: "访客体验" });
  await dialog.waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined);
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "继续体验" }).click();
  }
}

function localIso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function currentWeekDate(index: number) {
  const today = new Date();
  const mondayIndex = (today.getDay() + 6) % 7;
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayIndex + index);
  return date;
}

test("首页深色洞察区不向下投射浅灰色带", async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("planpilot:guest-home-intro-seen:v1", "1");
  });
  await page.goto("/studio/work");

  const lead = page.locator(".theme-lead-tech:visible");
  await expect(lead).toBeVisible();
  await expect(lead).toHaveCSS("box-shadow", "none");
});

test("科技首页保留指标单位并把问候语放入深色洞察区", async ({ page }) => {
  const today = new Date();
  await page.clock.setFixedTime(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 8));
  const todayIndex = (today.getDay() + 6) % 7;
  const peakIndex = todayIndex === 4 ? 5 : 4;
  const peakDate = currentWeekDate(peakIndex);
  const weekDayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const weekdayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const peakWeekday = weekdayKeys[peakDate.getDay()];
  const seededAvailability = Object.fromEntries(
    weekdayKeys.slice(1).concat("sun").map((day) => [
      day,
      day === peakWeekday
        ? [{ start: "18:00", end: "19:15" }]
        : [{ start: "09:00", end: "11:00" }, { start: "14:00", end: "16:00" }, { start: "20:00", end: "22:00" }],
    ]),
  );
  const seededTasks = [
    { id: 1, goalId: "1", date: localIso(today), title: "完成动态规划练习", goal: "算法基础", duration: "45 分钟", time: "21:00", done: true, priority: "核心" },
    { id: 2, goalId: "1", date: localIso(today), title: "复习链表双指针", goal: "算法基础", duration: "20 分钟", time: "22:00", done: false, priority: "低优先级" },
    { id: 3, goalId: "2", date: localIso(today), title: "整理今日错题", goal: "面试准备", duration: "15 分钟", time: "22:30", done: false, priority: "普通优先级" },
    { id: 4, goalId: "1", date: localIso(peakDate), title: "系统设计笔记复盘", goal: "算法基础", duration: "60 分钟", time: "20:00", done: false, priority: "低优先级" },
    { id: 5, goalId: "2", date: localIso(peakDate), title: "模拟面试", goal: "面试准备", duration: "35 分钟", time: "21:10", done: false, priority: "核心" },
  ];
  await page.addInitScript(({ items, goals, weeklyAvailability }) => {
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify(items));
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
    window.localStorage.setItem("planpilot-v2-goals", JSON.stringify(goals));
    window.localStorage.setItem("planpilot-v2-weekly-availability", JSON.stringify(weeklyAvailability));
  }, {
    items: seededTasks,
    weeklyAvailability: seededAvailability,
    goals: [
      {
        id: "1",
        type: "skill",
        title: "算法基础",
        deadline: "2026-09-01",
        daily_hours: 80 / 60,
        current_level: "入门",
        status: "active",
        created_at: "2026-08-01",
      },
      {
        id: "2",
        type: "exam",
        title: "面试准备",
        deadline: "2026-09-15",
        daily_hours: 1,
        current_level: "入门",
        status: "active",
        created_at: "2026-08-01",
      },
    ],
  });
  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);

  const lead = page.locator(".theme-lead-tech:visible");
  await expect(lead).toBeVisible();
  await expect(lead.locator(".tech-lead-greeting")).toHaveCount(0);
  await expect(page.locator(".sidebar-rotating-status")).toHaveAttribute(
    "aria-label",
    /\d+月\d+日星期.；.+，/,
  );
  await expect(page.locator(".dashboard-commandbar")).toHaveCount(0);
  await expect(page.locator(".dashboard-view-tabs")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /打开 Pilo 学习伙伴/ })).toBeVisible();

  await page.mouse.move(820, 520);
  await expect(page.locator(".app-shell")).toHaveAttribute("data-pointer-glow", "active");
  await expect(page.locator(".page-pointer-glow")).toHaveCSS("pointer-events", "none");
  await page.mouse.move(90, 280);
  await expect(page.locator(".app-shell")).toHaveCSS("--page-glow-x", "90px");

  const expectedMetrics = [
    ["—", "", "活跃目标"],
    ["—", "", "连续学习"],
    ["0.8", "小时", "本周投入"],
    ["—", "", "待复习知识"],
  ] as const;

  const cards = lead.locator(".tech-telemetry article");
  await expect(cards).toHaveCount(expectedMetrics.length);
  const searchButton = lead.getByRole("button", { name: "搜索任务" });
  await expect(searchButton).toBeVisible();
  await expect(searchButton).toHaveCSS("border-top-width", "0px");
  await expect(searchButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(lead.getByRole("heading", { name: "登录后启用个性化学习建议" })).toBeVisible();
  await expect(lead).toContainText("当前是访客模式");
  await expect(lead).not.toContainText("完成动态规划练习");
  await expect(cards.nth(1)).toContainText("登录后统计真实连续记录");
  await expect(cards.nth(2)).toContainText("距离本周计划还有 2.2 小时");
  await expect(cards.nth(3)).toContainText("登录后读取真实知识缺口");
  const profileLink = lead.getByRole("link", { name: "登录并查看选择" });
  await expect(profileLink).toHaveCSS("border-top-width", "0px");

  for (let index = 0; index < expectedMetrics.length; index += 1) {
    const [value, unit, label] = expectedMetrics[index];
    const heading = cards.nth(index).locator(".tech-metric-heading");
    await expect(heading.locator("strong")).toHaveText(value);
    await expect(heading.locator(".tech-metric-unit")).toHaveText(unit);
    await expect(heading.locator("span")).toHaveText(label);
    await expect(heading).toBeVisible();
  }

  const todayPanel = page.locator(".today-panel");
  const rhythmPanel = page.locator(".rhythm-panel");
  const [todayBox, rhythmBox, taskOverflow] = await Promise.all([
    todayPanel.boundingBox(),
    rhythmPanel.boundingBox(),
    todayPanel.locator(".task-list").evaluate((element) => getComputedStyle(element).overflowY),
  ]);
  expect(Math.abs((todayBox?.height ?? 0) - (rhythmBox?.height ?? 0))).toBeLessThanOrEqual(1);
  expect(taskOverflow).toBe("auto");

  const verticalSpacing = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const todayEyebrow = bounds(".today-panel .panel-header small");
    const todayTitle = bounds(".today-panel .panel-header h2");
    const progress = bounds(".today-panel .plan-progress");
    const taskList = bounds(".today-panel .task-list");
    const rhythmEyebrow = bounds(".rhythm-panel .panel-header small");
    const rhythmTitle = bounds(".rhythm-panel .panel-header h2");
    const rhythmHeader = bounds(".rhythm-panel .panel-header");
    const heatmap = bounds(".rhythm-panel .rhythm-heatmap");
    const peakNote = bounds(".rhythm-panel .rhythm-peak-note");
    const summary = bounds(".rhythm-panel .rhythm-summary");
    return {
      todayTitleGap: todayTitle.top - todayEyebrow.bottom,
      rhythmTitleGap: rhythmTitle.top - rhythmEyebrow.bottom,
      progressToTasks: taskList.top - progress.bottom,
      rhythmHeaderToHeatmap: heatmap.top - rhythmHeader.bottom,
      peakToSummary: summary.top - peakNote.bottom,
    };
  });
  expect(verticalSpacing.todayTitleGap).toBeLessThanOrEqual(2);
  expect(verticalSpacing.rhythmTitleGap).toBeLessThanOrEqual(2);
  expect(verticalSpacing.progressToTasks).toBeLessThanOrEqual(11);
  expect(verticalSpacing.rhythmHeaderToHeatmap).toBeLessThanOrEqual(19);
  expect(verticalSpacing.peakToSummary).toBeLessThanOrEqual(12);

  const priorityPicker = todayPanel.getByRole("button", { name: "复习链表双指针优先级" });
  await expect(priorityPicker).toContainText("低");
  const completedTask = todayPanel.locator(".task-item", { hasText: "完成动态规划练习" });
  await expect(completedTask.getByRole("button", { name: "记录实际投入" })).toBeVisible();
  await expect(completedTask.locator(".task-meta > small")).toHaveCount(0);
  await expect(completedTask.getByRole("button", { name: "完成动态规划练习优先级" })).toHaveCount(0);
  const completionControl = completedTask.getByRole("button", { name: "标记为未完成：完成动态规划练习" });
  await completionControl.focus();
  const completionControlGeometry = await completionControl.evaluate((button) => {
    const control = button as HTMLElement;
    const list = control.closest(".task-list")!.getBoundingClientRect();
    const rect = control.getBoundingClientRect();
    const style = getComputedStyle(control);
    const outlineExtent = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
    return {
      visibleLeftInset: rect.left - outlineExtent - list.left,
      transform: style.transform,
    };
  });
  expect(completionControlGeometry.visibleLeftInset).toBeGreaterThanOrEqual(3);
  expect(completionControlGeometry.transform).toBe("none");
  const priorityColors = await Promise.all([
    todayPanel.getByRole("button", { name: "整理今日错题优先级" }),
    priorityPicker,
  ].map((picker) => picker.evaluate((element) => ({
    text: getComputedStyle(element.querySelector<HTMLElement>(".task-priority-label")!).color,
    dot: getComputedStyle(element.querySelector<HTMLElement>(".task-priority-dot")!).backgroundColor,
  }))));
  expect(priorityColors).toEqual([
    { text: "rgb(102, 87, 217)", dot: "rgb(102, 87, 217)" },
    { text: "rgb(117, 128, 151)", dot: "rgb(117, 128, 151)" },
  ]);

  const alignedTask = todayPanel.locator(".task-item", { hasText: "复习链表双指针" });
  const alignment = await alignedTask.evaluate((element) => {
    const title = element.querySelector<HTMLElement>(":scope > div > strong")!.getBoundingClientRect();
    const goal = element.querySelector<HTMLElement>(":scope > div > span")!.getBoundingClientRect();
    const time = element.querySelector<HTMLElement>(".task-meta > small")!.getBoundingClientRect();
    const priority = element.querySelector<HTMLElement>(".task-priority-label")!.getBoundingClientRect();
    const titleStyle = getComputedStyle(element.querySelector<HTMLElement>(":scope > div > strong")!);
    const goalStyle = getComputedStyle(element.querySelector<HTMLElement>(":scope > div > span")!);
    const timeStyle = getComputedStyle(element.querySelector<HTMLElement>(".task-meta > small")!);
    return {
      titleTop: title.top,
      goalTop: goal.top,
      timeTop: time.top,
      priorityTop: priority.top,
      titleColor: titleStyle.color,
      goalSize: goalStyle.fontSize,
      goalMarginTop: goalStyle.marginTop,
      timeSize: timeStyle.fontSize,
      timeOffset: timeStyle.top,
    };
  });
  expect(Math.abs(alignment.titleTop - alignment.timeTop)).toBeLessThanOrEqual(6);
  expect(Math.abs(alignment.goalTop - alignment.priorityTop)).toBeLessThanOrEqual(6);
  expect(alignment.titleColor).not.toBe("rgb(25, 31, 52)");
  expect(alignment.goalSize).toBe("11px");
  expect(alignment.goalMarginTop).toBe("3px");
  expect(alignment.timeSize).toBe("11px");
  expect(alignment.timeOffset).toBe("-1px");

  await priorityPicker.click();
  const priorityMenu = page.getByRole("listbox", { name: "选择复习链表双指针的优先级" });
  await expect(priorityMenu).toBeVisible();
  await expect(priorityMenu.getByText("任务优先级", { exact: true })).toBeVisible();
  const menuTypography = await priorityMenu.getByRole("option", { name: /核心/ }).evaluate((element) => ({
    label: Number.parseFloat(getComputedStyle(element.querySelector("strong")!).fontSize),
    description: Number.parseFloat(getComputedStyle(element.querySelector(".task-priority-option-description")!).fontSize),
  }));
  expect(menuTypography.label).toBeGreaterThan(menuTypography.description);
  await priorityMenu.getByRole("option", { name: /核心/ }).click();
  await expect(priorityPicker).toContainText("核心");
  await expect(priorityPicker).toHaveAttribute("aria-expanded", "false");

  const modeSwitch = todayPanel.getByRole("button", { name: "打开时间规划" });
  await expect(modeSwitch).toBeVisible();
  await expect(todayPanel.locator(".plan-progress")).toBeVisible();
  await modeSwitch.click();
  const planner = todayPanel.getByRole("dialog", { name: "自动规划今天的任务" });
  await expect(planner.getByRole("group", { name: "选择规划节奏" })).toBeVisible();
  await planner.getByRole("button", { name: "应用", exact: true }).click();
  await expect(todayPanel.locator(".task-elapsed-progress")).toHaveCount(2);
  await expect(todayPanel.locator(".task-elapsed-progress").first()).toBeVisible();
  await expect(todayPanel.getByRole("button", { name: "重新规划" })).toBeVisible();
  const scheduledTask = todayPanel.locator(".task-item", { hasText: "复习链表双指针" });
  await expect(scheduledTask.locator(".task-meta small")).toHaveText("09:00–09:20");

  const rhythmDays = page.locator(".rhythm-heatmap-grid > article");
  await expect(rhythmDays.nth(todayIndex)).toHaveAttribute("aria-current", "date");
  await expect(page.locator('.rhythm-heatmap-grid > article[aria-current="date"]')).toHaveCount(1);
  await expect(page.locator(".rhythm-heatmap-grid > article.is-future")).toHaveCount(6 - todayIndex);
  await expect(rhythmPanel).toContainText("截至今天，今天投入最高");
  await expect(rhythmPanel).not.toContainText("周四是本周专注高峰");

  const rhythmTypography = await rhythmPanel.evaluate((panel) => {
    const heading = panel.querySelector<HTMLElement>(".rhythm-heatmap > header > span");
    const dayCard = panel.querySelector<HTMLElement>(".rhythm-heatmap-grid > article");
    const summaryAsides = Array.from(panel.querySelectorAll<HTMLElement>(".rhythm-summary-aside"));
    return {
      headingSize: heading ? getComputedStyle(heading).fontSize : "",
      dayLabelSize: dayCard ? getComputedStyle(dayCard.querySelector<HTMLElement>(":scope > span")!).fontSize : "",
      dayUnitSize: dayCard ? getComputedStyle(dayCard.querySelector<HTMLElement>(":scope > small")!).fontSize : "",
      dayStateSize: dayCard ? getComputedStyle(dayCard.querySelector<HTMLElement>(":scope > em")!).fontSize : "",
      asideLabelSizes: summaryAsides.map((item) => getComputedStyle(item.querySelector("span")!).fontSize),
      asideValueSizes: summaryAsides.map((item) => getComputedStyle(item.querySelector("strong")!).fontSize),
      asideWidths: summaryAsides.map((item) => Math.round(item.getBoundingClientRect().width)),
      asideColors: summaryAsides.map((item) => getComputedStyle(item.querySelector("strong")!).color),
    };
  });
  expect(rhythmTypography.headingSize).toBe("13px");
  expect(rhythmTypography.dayLabelSize).toBe("12px");
  expect(rhythmTypography.dayUnitSize).toBe("12px");
  expect(rhythmTypography.dayStateSize).toBe("10px");
  expect(new Set(rhythmTypography.asideLabelSizes).size).toBe(1);
  expect(new Set(rhythmTypography.asideValueSizes).size).toBe(1);
  expect(new Set(rhythmTypography.asideWidths).size).toBe(1);
  expect(new Set(rhythmTypography.asideColors).size).toBe(1);

  const leadBox = await lead.boundingBox();
  const advice = page.getByRole("region", { name: "学习伙伴提醒" });
  const adviceBox = await advice.boundingBox();
  const gridBox = await page.locator(".workspace-grid").boundingBox();
  // Daily load is compared with that day's configured availability, not the
  // goal's daily_hours preference.
  await expect(advice).toContainText(`${weekDayNames[peakIndex]}计划 95 分钟，超过当天可用容量 20 分钟`);
  await expect(page.locator(".workspace-focus")).toHaveCount(0);
  expect(leadBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(gridBox?.y ?? 0);
  expect(gridBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(adviceBox?.y ?? 0);

  await page.locator(".rhythm-panel").getByRole("button", { name: "本周" }).click();
  await expect(page.getByRole("region", { name: "本周计划" })).toBeVisible();
  await expect(page.locator(".week-plan-range")).not.toContainText("7.27—8.2");
  await expect(page.locator(".week-plan-overview > article")).toHaveCount(3);
  const returnToday = page.getByRole("button", { name: "返回今日" });
  await expect(returnToday).toHaveCSS("border-top-width", "0px");
  await expect(returnToday).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const weekHeadingLayout = await page.locator(".week-plan-heading").evaluate((heading) => {
    const back = heading.querySelector<HTMLElement>(".week-return-today")!.getBoundingClientRect();
    const range = heading.querySelector<HTMLElement>(".week-plan-range")!.getBoundingClientRect();
    const context = heading.querySelector<HTMLElement>(".week-plan-context-track")!.getBoundingClientRect();
    const title = heading.querySelector<HTMLElement>("h2")!.getBoundingClientRect();
    const summary = heading.querySelector<HTMLElement>(".week-plan-summary-track")!.getBoundingClientRect();
    const contextStyle = getComputedStyle(heading.querySelector<HTMLElement>(".week-plan-context-track")!);
    const summaryStyle = getComputedStyle(heading.querySelector<HTMLElement>(".week-plan-summary-track")!);
    const valueSizes = Array.from(heading.querySelectorAll<HTMLElement>(".week-overview-value b")).map((item) => getComputedStyle(item).fontSize);
    const detailSizes = Array.from(heading.querySelectorAll<HTMLElement>(".week-overview-detail")).map((item) => getComputedStyle(item).fontSize);
    return {
      height: heading.getBoundingClientRect().height,
      backSize: Number.parseFloat(getComputedStyle(heading.querySelector(".week-return-today")!).fontSize),
      rangeSize: Number.parseFloat(getComputedStyle(heading.querySelector(".week-plan-range")!).fontSize),
      centers: [back, range].map((box) => Math.round(box.top + box.height / 2)),
      titleGaps: [Math.round(title.top - context.bottom), Math.round(summary.top - title.bottom)],
      contextAnimation: `${contextStyle.animationName} ${contextStyle.animationDuration}`,
      summaryAnimation: `${summaryStyle.animationName} ${summaryStyle.animationDuration}`,
      valueSizes,
      detailSizes,
    };
  });
  expect(weekHeadingLayout.height).toBeLessThanOrEqual(145);
  expect(weekHeadingLayout.backSize).toBeGreaterThan(weekHeadingLayout.rangeSize);
  expect(
    Math.max(...weekHeadingLayout.centers) - Math.min(...weekHeadingLayout.centers),
    JSON.stringify(weekHeadingLayout),
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(weekHeadingLayout.titleGaps[0] - weekHeadingLayout.titleGaps[1])).toBeLessThanOrEqual(1);
  expect(weekHeadingLayout.contextAnimation).toContain("week-context-drift 12s");
  expect(weekHeadingLayout.summaryAnimation).toContain("week-summary-drift 14s");
  expect(new Set(weekHeadingLayout.valueSizes).size).toBe(1);
  expect(new Set(weekHeadingLayout.detailSizes).size).toBe(1);
  await returnToday.hover();
  await expect(returnToday.locator(".week-return-arrow")).not.toHaveCSS("transform", "none");
  await expect(page.locator(".week-risk-card")).toContainText("本周关键判断");
  const riskCardBackground = await page.locator(".week-risk-card").evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(riskCardBackground).not.toContain("rgb(13, 20, 41)");

  const todayBar = page.locator(".week-load-chart > button").nth(todayIndex);
  const todayDateLabel = `${today.getMonth() + 1}月${today.getDate()}日`;
  await expect(todayBar).toHaveAttribute("aria-label", new RegExp(`${todayDateLabel}今天计划`));
  await expect(todayBar).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".week-card-source")).toContainText("计划量");
  await expect(page.locator(".week-card-source")).toContainText("已完成量");
  const todayAgendaTab = page.getByRole("tab", { name: new RegExp(`/ 今天.*${todayDateLabel}`) });
  await expect(todayAgendaTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".week-day-focus-summary > div")).toHaveCount(0);
  await expect(page.locator(".week-day-focus-status")).toHaveCount(0);
  await expect(page.locator(".week-focus-task-list > article")).toHaveCount(3);
  await expect(page.locator(".week-focus-task-list")).not.toContainText("查看全部");
  await expect(page.locator(".week-focus-task-list")).not.toContainText("进行中");
  await expect(page.locator(".week-focus-task-list")).toHaveCSS("overflow-y", "auto");

  const peakBar = page.locator(".week-load-chart > button").nth(peakIndex);
  await peakBar.hover();
  await expect(peakBar.locator(".week-load-tooltip")).toHaveCSS("opacity", "1");
  await expect(peakBar).toHaveCSS("z-index", "40");
  await expect(peakBar.locator(".week-load-tooltip")).toHaveCSS("z-index", "100");
  await expect(peakBar.locator(".week-load-tooltip")).toContainText("2 项任务，计划 95 分钟");
  await peakBar.click();
  await expect(peakBar).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".week-load-selection")).toContainText("95 分钟");
  await expect(page.locator(".week-day-selector").getByRole("tab")).toHaveCount(7);
  await expect(page.locator(".week-day-focus")).toContainText("系统设计笔记复盘");
  await expect(page.locator(".week-focus-task-list > article")).toHaveCount(2);
  await expect(page.locator(".week-load-plan-fill")).toHaveCount(7);
  await expect(page.locator(".week-load-complete-fill")).toHaveCount(7);
  const riskFill = peakBar.locator(".week-load-plan-fill");
  await expect(riskFill).not.toHaveCSS("background-image", /rgb\(242, 178, 105\)/);

  const priorityStyles = await page.locator(".week-focus-task-priority").evaluateAll((items) => items.map((item) => ({
    label: item.textContent?.trim(),
    text: getComputedStyle(item).color,
    dot: getComputedStyle(item.querySelector("i")!).backgroundColor,
  })));
  expect(priorityStyles).toEqual(expect.arrayContaining([
    { label: "核心", text: "rgb(198, 60, 57)", dot: "rgb(198, 60, 57)" },
    { label: "低优先级", text: "rgb(117, 128, 151)", dot: "rgb(117, 128, 151)" },
  ]));
  const taskColumnLayout = await page.locator(".week-focus-task-list > article").first().evaluate((row) => {
    const title = row.querySelector<HTMLElement>(".week-focus-task-copy")!.getBoundingClientRect();
    const meta = row.querySelector<HTMLElement>(".week-focus-task-meta")!.getBoundingClientRect();
    return { titleRight: title.right, metaLeft: meta.left };
  });
  expect(taskColumnLayout.metaLeft).toBeGreaterThan(taskColumnLayout.titleRight);

  await page.getByRole("button", { name: "前往时间规划" }).click();
  await expect(todayPanel).toBeVisible();
  await expect(todayPanel.getByRole("button", { name: "打开时间规划" })).toBeVisible();
  await page.locator(".rhythm-panel").getByRole("button", { name: "本周" }).click();
  await expect(page.getByRole("region", { name: "本周计划" })).toBeVisible();

  await page.getByRole("button", { name: "智能调整本周" }).click();
  const adjustmentPreview = page.getByRole("dialog", { name: "预览本周智能调整" });
  await expect(adjustmentPreview).toContainText("确认后才会更新任务日期");
  await expect(adjustmentPreview).toContainText("系统设计笔记复盘");
  await adjustmentPreview.getByRole("button", { name: "确认并移动" }).click();
  await expect(page.locator(".week-action-notice")).toContainText("已将“系统设计笔记复盘”移至");
  await expect(page.locator(".week-risk-card")).toContainText("本周没有超过稳定上限");
  const movedTaskToggle = page.getByRole("button", { name: "标记为已完成：系统设计笔记复盘" });
  await expect(movedTaskToggle).toBeVisible();
  await movedTaskToggle.click();
  await expect(page.getByRole("button", { name: "标记为未完成：系统设计笔记复盘" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "返回今日" }).click();
  await expect(lead).toBeVisible();

  await page.getByRole("button", { name: /打开 Pilo 学习伙伴/ }).click();
  await expect(page).toHaveURL(/\/studio\/work(?:\?.*)?$/);
  expect(new URL(page.url()).searchParams.get("mode")).toBe("schedule");
  await expect(page.getByRole("dialog", { name: "Pilo 快捷陪伴" })).toBeVisible();
  await expect(page.getByRole("button", { name: "收起 Pilo 学习伙伴" })).toBeVisible();
});

test("本周页在没有任务时不生成虚构负荷与建议", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("planpilot-v2-tasks", "[]");
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
  });
  await page.goto("/studio/work?view=week");

  await expect(page.getByRole("region", { name: "本周计划" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "本周还没有形成可分析的任务安排。" })).toBeVisible();
  await expect(page.locator(".week-risk-card")).toContainText("当前不会展示虚构建议");
  await expect(page.locator(".week-load-chart > button")).toHaveCount(7);
  await expect(page.locator(".week-load-chart > button").filter({ hasText: "95" })).toHaveCount(0);
  await expect(page.locator(".week-day-focus")).toContainText("当天尚未安排任务。");
});

test("登录用户的深色洞察卡只展示真实长期学习习惯", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: {
      id: "member-habit",
      email: "habit@example.com",
      username: "学习者",
      timezone: "Asia/Shanghai",
      onboarding_completed: true,
    },
  }));
  await page.route("**/api/v1/tasks**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/goals/progress", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/schedule/*", (route) => route.fulfill({ json: { date: localIso(new Date()), blocks: [] } }));
  await page.route("**/api/v1/learner/decision-context**", (route) => route.fulfill({
    json: {
      active_patterns: [{
        id: "habit-evening",
        goal_id: null,
        scope: "user",
        pattern_type: "preferred_learning_time",
        pattern_value: { peak_hours: [19, 20] },
        confidence: 0.82,
        evidence_count: 18,
        last_confirmed_at: null,
        evidence: [],
        evidence_summary: { observation_window_days: 28 },
        explanation: "你的任务完成记录显示出稳定的学习时段偏好",
      }],
    },
  }));

  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  const lead = page.locator(".theme-lead-tech:visible");
  await expect(lead.getByRole("heading", { name: "你更常在 19:00–21:00 进入学习状态" })).toBeVisible();
  await expect(lead).toContainText("LEARNING SIGNAL · CONFIDENCE 82%");
  await expect(lead).toContainText("你的任务完成记录显示出稳定的学习时段偏好");
  await expect(lead).toContainText("安排高认知任务时，可优先使用这段时间");
  await expect(lead).not.toContainText("暂无实际记录");
  await expect(lead.getByRole("link", { name: "查看判断依据" })).toHaveAttribute("href", "/studio/coach/memory?pattern=habit-evening");
});

test("登录用户的四项洞察指标全部由真实接口数据生成", async ({ page }) => {
  const today = localIso(new Date());
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: { id: "member-metrics", email: "metrics@example.com", username: "学习者", timezone: "Asia/Shanghai", onboarding_completed: true },
  }));
  await page.route("**/api/v1/goals/progress", (route) => route.fulfill({ json: [
    { goal_id: "goal-1", total_tasks: 5, completed_tasks: 4, avg_completion_rate: 0.8, streak_days: 12, debt_count: 1, days_ahead_or_behind: -1 },
    { goal_id: "goal-2", total_tasks: 3, completed_tasks: 2, avg_completion_rate: 0.67, streak_days: 7, debt_count: 0, days_ahead_or_behind: 1 },
  ] }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: [
    { id: "goal-1", type: "skill", title: "算法基础", deadline: "2099-09-01", daily_hours: 1, current_level: "beginner", status: "active", created_at: "2026-08-01" },
    { id: "goal-2", type: "language", title: "英文阅读", deadline: "2099-10-01", daily_hours: 1, current_level: "beginner", status: "active", created_at: "2026-08-01" },
  ] }));
  await page.route("**/api/v1/tasks**", (route) => route.fulfill({ json: [
    { id: "task-1", title: "算法练习", goalId: "goal-1", goalTitle: "算法基础", done: true, estimatedMinutes: 180, actualMinutes: 180, date: today, priority: "high", masteryLevel: "learning" },
    { id: "task-2", title: "英文精读", goalId: "goal-2", goalTitle: "英文阅读", done: true, estimatedMinutes: 204, actualMinutes: 204, date: today, priority: "medium", masteryLevel: "learning" },
  ] }));
  await page.route("**/api/v1/schedule/today", (route) => route.fulfill({ json: { date: today, blocks: [] } }));
  await page.route("**/api/v1/learner/decision-context**", (route) => route.fulfill({ json: {
    active_patterns: [],
    knowledge_gaps: Array.from({ length: 8 }, (_, index) => ({
      id: `gap-${index}`,
      goal_id: "goal-1",
      name: `知识点 ${index + 1}`,
      mastery_score: 0.5,
      retention: index < 2 ? 0.4 : 0.7,
      gap_score: 0.5,
      forgetting_rate: 0.2,
      evidence_count: 3,
      missing_prerequisites: [],
    })),
  } }));

  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  const cards = page.locator(".theme-lead-tech:visible .tech-telemetry article");
  await expect(cards.nth(0)).toContainText("2个活跃目标");
  await expect(cards.nth(0)).toContainText("1 个目标本周有风险");
  await expect(cards.nth(1)).toContainText("12天连续学习");
  await expect(cards.nth(2)).toContainText("6.4小时本周投入");
  await expect(cards.nth(3)).toContainText("8项待复习知识");
  await expect(cards.nth(3)).toContainText("2 项保持率低于 50%");
});

test("登录用户任务行隐藏开始按钮并在执行时段触发内部观察", async ({ page }) => {
  const today = localIso(new Date());
  let observedStarts = 0;
  const pendingTask = {
    id: "task-layout-0",
    title: "未安排任务",
    goalId: "goal-start",
    goalTitle: "验证首个行动",
    done: false,
    status: "pending",
    estimatedMinutes: 25,
    actualMinutes: null,
    date: today,
    priority: "high",
    masteryLevel: "unknown",
  };
  const taskFixtures = [pendingTask, ...["构建混合检索流程", "实现 ReAct 推理循环", "重构会话摘要管线"].map((title, index) => ({
    ...pendingTask,
    id: `task-layout-${index + 1}`,
    title,
  }))];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: {
    id: "member-task-start",
    email: "start@example.com",
    username: "开始用户",
    timezone: "Asia/Shanghai",
    onboarding_completed: true,
  } }));
  await page.route("**/api/v1/goals/progress", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: [{
    id: "goal-start",
    type: "skill",
    title: "验证首个行动",
    deadline: "2099-09-01",
    daily_hours: 1,
    current_level: "beginner",
    status: "active",
    created_at: "2026-08-01",
  }] }));
  await page.route("**/api/v1/tasks**", async (route) => {
    if (route.request().method() === "POST" && route.request().url().endsWith("/observe-start")) {
      observedStarts += 1;
      await route.fulfill({ json: { ...pendingTask, status: "in_progress" } });
      return;
    }
    await route.fulfill({ json: taskFixtures });
  });
  await page.route("**/api/v1/schedule/**", (route) => route.fulfill({ json: { date: today, blocks: [{
    id: "observed-window",
    label: pendingTask.title,
    taskId: pendingTask.id,
    goalTitle: pendingTask.goalTitle,
    startHour: 0,
    durationMinutes: 1439,
    color: "#7c6cf2",
    progress: 0,
  }] } }));
  await page.route("**/api/v1/learner/decision-context**", (route) => route.fulfill({ json: { active_patterns: [], knowledge_gaps: [] } }));

  await page.goto("/studio/work");
  const row = page.locator(".task-item", { hasText: "未安排任务" });
  await expect(row).toContainText("00:00–23:59");
  await expect(row.getByRole("button", { name: /开始任务|任务进行中/ })).toHaveCount(0);
  await expect.poll(() => observedStarts).toBe(1);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(row).toContainText("00:00–23:59");
  const geometry = await row.evaluate((element) => ({
    documentWidth: document.documentElement.scrollWidth,
    rowRight: element.getBoundingClientRect().right,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(geometry.rowRight).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  const rowLayout = await page.locator(".task-item").evaluateAll((rows) => rows.map((element, index) => {
    const row = element.getBoundingClientRect();
    const meta = element.querySelector<HTMLElement>(".task-meta")!.getBoundingClientRect();
    const next = rows[index + 1]?.getBoundingClientRect();
    return {
      metaInsideRow: meta.bottom <= row.bottom + 1,
      clearOfNextRow: !next || meta.bottom <= next.top + 1,
    };
  }));
  expect(rowLayout.every((item) => item.metaInsideRow && item.clearOfNextRow)).toBe(true);
});

test("高屏幕下工作卡片按内容等高且学习伙伴紧跟其后", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const todayIso = localIso(new Date());
  await page.addInitScript(({ isoDate }) => {
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify(
      Array.from({ length: 7 }, (_, index) => ({
        id: 700 + index,
        goalId: "1",
        date: isoDate,
        title: `对齐测试任务 ${index + 1}`,
        goal: "算法基础",
        duration: "40 分钟",
        time: `18:${String(index * 5).padStart(2, "0")}`,
        done: false,
        priority: "普通优先级",
      })),
    ));
  }, { isoDate: todayIso });
  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  await expect(page.locator(".theme-lead-tech:visible")).toBeVisible();
  await expect(page.locator(".coach-strip-goal-advice:visible").first()).toBeVisible();
  await page.waitForTimeout(800);

  const geometry = await page.evaluate(() => {
    const lead = document.querySelector<HTMLElement>(".theme-lead-tech")!.getBoundingClientRect();
    const grid = [...document.querySelectorAll<HTMLElement>(".workspace-grid")]
      .map((element) => element.getBoundingClientRect())
      .find((bounds) => bounds.width > 0 && bounds.height > 0)!;
    const today = document.querySelector<HTMLElement>(".today-panel")!.getBoundingClientRect();
    const rhythm = document.querySelector<HTMLElement>(".rhythm-panel")!.getBoundingClientRect();
    const progress = document.querySelector<HTMLElement>(".today-panel .plan-progress")!.getBoundingClientRect();
    const rhythmHeader = document.querySelector<HTMLElement>(".rhythm-panel .panel-header")!.getBoundingClientRect();
    const heatmap = document.querySelector<HTMLElement>(".rhythm-panel .rhythm-heatmap")!.getBoundingClientRect();
    const summary = document.querySelector<HTMLElement>(".rhythm-summary")!.getBoundingClientRect();
    const partner = [...document.querySelectorAll<HTMLElement>(".coach-strip-goal-advice")]
      .map((element) => element.getBoundingClientRect())
      .find((bounds) => bounds.width > 0 && bounds.height > 0)!;
    const taskList = document.querySelector<HTMLElement>(".today-panel .task-list")!;
    return {
      gridHeight: grid.height,
      leadToGrid: grid.top - lead.bottom,
      cardHeightDifference: Math.abs(today.height - rhythm.height),
      rhythmBottomGap: rhythm.bottom - summary.bottom,
      gridToPartner: partner.top - grid.bottom,
      taskListClientHeight: taskList.clientHeight,
      taskListScrollHeight: taskList.scrollHeight,
      progressToTasks: taskList.getBoundingClientRect().top - progress.bottom,
      headerToHeatmap: heatmap.top - rhythmHeader.bottom,
    };
  });
  expect(geometry.gridHeight).toBeLessThan(450);
  expect(geometry.leadToGrid).toBeLessThanOrEqual(13);
  expect(geometry.cardHeightDifference).toBeLessThanOrEqual(1);
  expect(geometry.rhythmBottomGap).toBeLessThanOrEqual(24);
  expect(geometry.gridToPartner).toBeLessThanOrEqual(11);
  expect(geometry.taskListClientHeight).toBeLessThanOrEqual(232);
  expect(geometry.taskListScrollHeight).toBeGreaterThan(geometry.taskListClientHeight);
  expect(geometry.progressToTasks).toBeGreaterThanOrEqual(5);
  expect(geometry.headerToHeatmap).toBeGreaterThanOrEqual(5);
});

test("已完成任务用实际投入替换时间与优先级且可保存", async ({ page }) => {
  const today = localIso(new Date());
  await page.addInitScript(({ isoDate }) => {
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify([
      {
        id: 91,
        goalId: "1",
        date: isoDate,
        title: "完成后的投入记录",
        goal: "算法基础",
        duration: "30 分钟",
        time: "20:00",
        done: true,
        priority: "核心",
        actualMinutes: null,
      },
      {
        id: 92,
        goalId: "1",
        date: isoDate,
        title: "紧随其后的待办任务",
        goal: "算法基础",
        duration: "20 分钟",
        time: "21:00",
        done: false,
        priority: "普通",
        actualMinutes: null,
      },
    ]));
  }, { isoDate: today });

  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  const row = page.locator(".task-item", { hasText: "完成后的投入记录" });
  const actualButton = row.getByRole("button", { name: "记录实际投入" });
  await expect(actualButton).toBeVisible();
  await expect(actualButton).toHaveCSS("border-top-width", "0px");
  await expect(actualButton).toHaveCSS("border-bottom-width", "1px");
  await expect(actualButton).toHaveCSS("border-radius", "0px");
  await expect(actualButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(row.locator(".task-meta > small")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "完成后的投入记录优先级" })).toHaveCount(0);

  await row.getByRole("button", { name: "记录实际投入" }).click();
  const actualEditor = row.getByRole("form", { name: "记录“完成后的投入记录”的实际投入" });
  const actualInput = row.getByLabel("实际投入（分钟）");
  const saveButton = actualEditor.getByRole("button", { name: "保存", exact: true });
  await expect(actualEditor).toBeVisible();
  await expect(actualEditor).toContainText("分钟");
  await expect(actualInput).toHaveCSS("border-top-width", "0px");
  await expect(actualInput).toHaveCSS("border-radius", "0px");
  await expect(actualInput).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(saveButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(saveButton).toHaveCSS("border-radius", "0px");
  const editorPlacement = await row.evaluate((element) => {
    const rowRect = element.getBoundingClientRect();
    const editorRect = element.querySelector<HTMLElement>(".task-actual-editor")!.getBoundingClientRect();
    const nextRect = element.nextElementSibling?.getBoundingClientRect();
    return {
      editorBottom: editorRect.bottom,
      editorHeight: editorRect.height,
      editorTop: editorRect.top,
      nextTop: nextRect?.top ?? Number.POSITIVE_INFINITY,
      rowBottom: rowRect.bottom,
      rowTop: rowRect.top,
    };
  });
  expect(editorPlacement.editorHeight).toBeLessThanOrEqual(34);
  expect(editorPlacement.editorTop).toBeGreaterThanOrEqual(editorPlacement.rowTop);
  expect(editorPlacement.editorBottom).toBeLessThanOrEqual(editorPlacement.rowBottom + 1);
  expect(editorPlacement.editorBottom).toBeLessThanOrEqual(editorPlacement.nextTop);
  await page.getByRole("heading", { name: "今日计划" }).click();
  await expect(row.getByLabel("实际投入（分钟）")).toHaveCount(0);
  await row.getByRole("button", { name: "记录实际投入" }).click();
  await row.getByLabel("实际投入（分钟）").fill("37");
  await row.getByRole("button", { name: "保存" }).click();
  await expect(row.getByRole("button", { name: "实际 37 分钟" })).toBeVisible();

  await page.reload();
  const restoredRow = page.locator(".task-item", { hasText: "完成后的投入记录" });
  await expect(restoredRow.getByRole("button", { name: "实际 37 分钟" })).toBeVisible();
  await restoredRow.getByRole("button", { name: "标记为未完成：完成后的投入记录" }).click();
  await expect(restoredRow.getByRole("button", { name: "完成后的投入记录优先级" })).toBeVisible();
  await expect(restoredRow.locator(".task-meta > small")).toContainText("20:00");
  await expect(restoredRow.getByRole("button", { name: "实际 37 分钟" })).toHaveCount(0);
});

test("实际投入内联控件在 375px 下不造成页面横向溢出", async ({ page }) => {
  const today = localIso(new Date());
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(({ isoDate }) => {
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify([{
      id: 93,
      goalId: "1",
      date: isoDate,
      title: "窄屏投入记录",
      goal: "算法基础",
      duration: "30 分钟",
      time: "20:00",
      done: true,
      priority: "核心",
      actualMinutes: null,
    }]));
  }, { isoDate: today });

  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  const row = page.locator(".task-item", { hasText: "窄屏投入记录" });
  await row.getByRole("button", { name: "记录实际投入" }).click();
  const geometry = await row.evaluate((element) => {
    const rowRect = element.getBoundingClientRect();
    const editorRect = element.querySelector<HTMLElement>(".task-actual-editor")!.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      editorBottom: editorRect.bottom,
      editorHeight: editorRect.height,
      editorRight: editorRect.right,
      rowBottom: rowRect.bottom,
      rowRight: rowRect.right,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  expect(geometry.editorHeight).toBeLessThanOrEqual(34);
  expect(geometry.editorBottom).toBeLessThanOrEqual(geometry.rowBottom + 1);
  expect(geometry.editorRight).toBeLessThanOrEqual(geometry.rowRight + 1);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
});

test("取消任务完成后节奏统计立即扣除该任务的实际投入", async ({ page }) => {
  const today = localIso(new Date());
  const todayWeekday = new Date(`${today}T12:00:00`).getDay();
  const elapsedWeekDays = todayWeekday === 0 ? 7 : todayWeekday;
  const initialAverage = Math.round(84 / elapsedWeekDays);
  const remainingAverage = Math.round(40 / elapsedWeekDays);
  await page.addInitScript(({ isoDate }) => {
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify([
      {
        id: 201,
        goalId: "1",
        date: isoDate,
        title: "第一项已打卡任务",
        goal: "算法基础",
        duration: "40 分钟",
        time: "18:00",
        done: true,
        priority: "普通",
        actualMinutes: 44,
      },
      {
        id: 202,
        goalId: "1",
        date: isoDate,
        title: "第二项已打卡任务",
        goal: "算法基础",
        duration: "40 分钟",
        time: "19:00",
        done: true,
        priority: "普通",
        actualMinutes: 40,
      },
    ]));
  }, { isoDate: today });

  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  const rhythmPanel = page.locator(".rhythm-panel:visible");
  const rhythmSummary = rhythmPanel.locator(".rhythm-summary");
  await expect(rhythmSummary).toContainText(`平均每日${initialAverage} 分钟`);
  await expect(rhythmSummary).toContainText("本周已投入84 分钟");
  await expect(rhythmPanel.locator(".rhythm-peak-note")).toContainText("已投入 84 分钟");
  const todayRhythmState = rhythmPanel.locator(".rhythm-heatmap-grid > article.is-today > em");
  await expect(todayRhythmState).toHaveText("已投入");
  const todayRhythmAppearance = await rhythmPanel.locator(".rhythm-heatmap-grid > article.is-today").evaluate((element) => {
    const state = element.querySelector<HTMLElement>(":scope > em")!;
    return {
      textColor: getComputedStyle(element).color,
      stateFits: state.scrollWidth <= state.clientWidth,
    };
  });
  expect(todayRhythmAppearance.textColor).not.toBe("rgb(255, 255, 255)");
  expect(todayRhythmAppearance.stateFits).toBe(true);

  await page.getByRole("button", { name: "标记为未完成：第一项已打卡任务" }).click();
  await expect(rhythmSummary).toContainText(`平均每日${remainingAverage} 分钟`);
  await expect(rhythmSummary).toContainText("本周已投入40 分钟");
  await expect(rhythmPanel.locator(".rhythm-peak-note")).toContainText("已投入 40 分钟");
  await expect(rhythmPanel).not.toContainText("已投入 84 分钟");

  await page.getByRole("button", { name: "标记为未完成：第二项已打卡任务" }).click();
  await expect(rhythmPanel.locator(".rhythm-peak-note")).toContainText("本周实际投入等待记录");
  await expect(rhythmSummary).toContainText("平均每日—");
  await expect(rhythmSummary).toContainText("本周已投入—");
});

test("本周实际投入按分钟数形成连续的低饱和紫色色阶", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 7, 20, 12));
  await page.addInitScript(() => {
    window.localStorage.setItem("planpilot:guest-dataset-version", "4");
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify([
      { id: 301, goalId: "1", date: "2026-08-17", title: "轻量投入", goal: "算法基础", duration: "20 分钟", time: "18:00", done: true, priority: "普通", actualMinutes: 20 },
      { id: 302, goalId: "1", date: "2026-08-18", title: "稳定投入", goal: "算法基础", duration: "50 分钟", time: "18:00", done: true, priority: "普通", actualMinutes: 50 },
      { id: 303, goalId: "1", date: "2026-08-20", title: "较高投入", goal: "算法基础", duration: "85 分钟", time: "18:00", done: true, priority: "普通", actualMinutes: 85 },
    ]));
  });

  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  const cards = page.locator(".rhythm-panel:visible .rhythm-heatmap-grid > article");
  await expect(cards.nth(0).locator(":scope > strong")).toHaveText("20");
  await expect(cards.nth(1).locator(":scope > strong")).toHaveText("50");
  await expect(cards.nth(3).locator(":scope > strong")).toHaveText("85");
  const scale = await Promise.all([0, 1, 3].map((index) => cards.nth(index).evaluate((element) => ({
    fill: Number.parseFloat(getComputedStyle(element).getPropertyValue("--rhythm-fill")),
    background: getComputedStyle(element).backgroundImage,
    numberColor: getComputedStyle(element.querySelector<HTMLElement>(":scope > strong")!).color,
    unitColor: getComputedStyle(element.querySelector<HTMLElement>(":scope > small")!).color,
  }))));
  expect(scale[0].fill).toBeLessThan(scale[1].fill);
  expect(scale[1].fill).toBeLessThan(scale[2].fill);
  expect(new Set(scale.map((item) => item.background)).size).toBe(3);
  expect(new Set(scale.map((item) => item.numberColor)).size).toBe(1);
  expect(new Set(scale.map((item) => item.unitColor)).size).toBe(1);
  const investedState = cards.nth(3).locator(":scope > em");
  await expect(investedState).toHaveText("已投入");
  await expect(investedState).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(investedState).toHaveCSS("border-radius", "0px");
  await expect(cards.nth(3)).toHaveCSS("outline-style", "none");
  await expect(cards.nth(3)).toHaveCSS("border-top-width", "2px");
  await expect(cards.nth(4)).toHaveClass(/is-planned/);
  expect(await cards.nth(4).evaluate((element) => getComputedStyle(element).getPropertyValue("--rhythm-fill"))).toBe("");
});

test("今日任务可通过轻量交互定位到所属目标中的具体任务", async ({ page }) => {
  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  const taskRow = page.locator(".task-item", { hasText: "完成 Pandas 分组聚合练习" });
  const checkButton = page.getByRole("button", { name: "标记为已完成：完成 Pandas 分组聚合练习" });
  await taskRow.locator(":scope > div").click();
  await expect(checkButton).toHaveCount(1);
  await expect(checkButton).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(/\/studio\/work$/);
  const taskLink = page.getByRole("button", { name: "打开任务：完成 Pandas 分组聚合练习" });
  await expect(taskLink.locator(".task-open-indicator")).toBeVisible();
  await taskLink.click();
  await expect(page).toHaveURL(/\/studio\/work\/goals\/guest-skill\?taskId=guest-task-1/);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/studio/work?selected=guest-task-1");
});

test("登录用户接口失败时显示错误并可重试，不回退到访客示例", async ({ page }) => {
  let taskRequests = 0;
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: {
      id: "admin-today-error",
      email: "admin@example.com",
      username: "管理员",
      is_admin: true,
      timezone: "Asia/Shanghai",
      onboarding_completed: true,
    },
  }));
  await page.route("**/api/v1/tasks**", (route) => {
    taskRequests += 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "任务接口暂时不可用" }) });
  });
  await page.route("**/api/v1/goals", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ detail: "目标接口暂时不可用" }),
  }));
  await page.route("**/api/v1/schedule/today", (route) => route.fulfill({ json: { date: "2026-08-20", blocks: [] } }));

  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  const errorState = page.locator(".pp-data-sync-notice.is-error");
  await expect(errorState).toContainText("今日计划同步失败");
  await expect(errorState).toContainText("任务接口暂时不可用");
  await expect(errorState.getByRole("button", { name: "重新加载" })).toBeVisible();
  await expect(errorState).toHaveCSS("position", "fixed");
  await expect(page.locator(".task-item")).toHaveCount(0);
  await expect(page.locator(".dashboard-page:visible")).not.toContainText("完成动态规划练习");

  await errorState.getByRole("button", { name: "重新加载" }).click();
  await expect.poll(() => taskRequests).toBeGreaterThan(2);
  await expect(errorState).toContainText("任务接口暂时不可用");
});

test("管理后台入口以动作名称为主标题", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: {
      id: "admin-sidebar-type",
      email: "admin-sidebar@example.com",
      username: "管理员",
      is_admin: true,
      timezone: "Asia/Shanghai",
      onboarding_completed: true,
    },
  }));
  await page.route("**/api/v1/tasks**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/goals/progress", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/schedule/today", (route) => route.fulfill({ json: { date: "2026-08-24", blocks: [] } }));

  await page.goto("/studio/work");
  const entry = page.getByRole("link", { name: /进入管理后台/ });
  await expect(entry).toBeVisible();
  await expect(entry.locator("strong")).toHaveCSS("font-size", "12px");
  await expect(entry.locator("small")).toHaveCSS("font-size", "11px");
});

test("目标列表成功为空时不显示总体进度同步失败，也会清理失效关联任务", async ({ page }) => {
  let deletedTaskId = "";
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { id: "orphan-cleanup-user", email: "orphan@example.com", username: "清理用户", email_verified: true, onboarding_completed: true } }));
  await page.route("**/api/v1/schedule/*", (route) => route.fulfill({ json: { date: localIso(new Date()), blocks: [] } }));
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/goals/progress", (route) => route.fulfill({ status: 404, json: { detail: "目标不存在" } }));
  await page.route("**/api/v1/tasks**", (route) => {
    const url = route.request().url();
    if (url.includes("date_from=")) {
      return route.fulfill({ json: [{ id: "orphan-task-1", goalId: "deleted-goal", goalTitle: "已删除目标", title: "失效任务", description: "", estimatedMinutes: 30, date: "2026-08-20", done: false, priority: "medium", actualMinutes: null }] });
    }
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/v1/tasks/orphan-task-1", async (route) => {
    deletedTaskId = "orphan-task-1";
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  await expect(page.locator(".pp-data-sync-notice")).toHaveCount(0);
  await expect(page.locator(".task-item", { hasText: "失效任务" })).toHaveCount(0);
  await expect.poll(() => deletedTaskId).toBe("orphan-task-1");
});

test("登录用户添加任务只提交一次并写入真实目标与日期", async ({ page }) => {
  let createRequests = 0;
  let createBody: Record<string, unknown> | null = null;
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const goal = {
    id: "goal-today",
    type: "skill",
    title: "算法基础",
    deadline: "2026-09-01",
    daily_hours: 1,
    current_level: "入门",
    status: "active",
    created_at: "2026-08-01",
  };
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({
    json: {
      id: "member-today-add",
      email: "member@example.com",
      username: "学习者",
      timezone: "Asia/Shanghai",
      onboarding_completed: true,
    },
  }));
  await page.route("**/api/v1/tasks**", async (route) => {
    if (route.request().method() === "POST") {
      createRequests += 1;
      createBody = route.request().postDataJSON() as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({ json: {
        id: "created-today-task",
        title: "真实接口任务",
        goalId: goal.id,
        goalTitle: goal.title,
        done: false,
        estimatedMinutes: 30,
        actualMinutes: null,
        date: todayIso,
        priority: "medium",
        masteryLevel: "beginner",
      } });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/v1/goals", (route) => route.fulfill({ json: [goal] }));
  await page.route("**/api/v1/schedule/today", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ json: { date: todayIso, blocks: [] } });
      return;
    }
    await route.fulfill({ json: { date: todayIso, blocks: [] } });
  });

  await page.goto("/studio/work");
  await dismissGuestHomeIntro(page);
  await page.getByRole("button", { name: "添加任务" }).click();
  const dialog = page.getByRole("dialog", { name: "添加今日任务" });
  await expect(dialog.getByRole("combobox", { name: "关联目标" })).toContainText("算法基础");
  await dialog.getByLabel("任务名称").fill("真实接口任务");
  const submit = dialog.getByRole("button", { name: "添加到今日" });
  await submit.evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  await expect(page.locator(".task-item", { hasText: "真实接口任务" })).toBeVisible();
  expect(createRequests).toBe(1);
  expect(createBody).toMatchObject({ goalId: goal.id, estimatedMinutes: 30, date: todayIso });
  await expect(page.locator(".today-task-success")).toContainText("已添加");
});

test("今日计划在 reduced motion 下不保留动态动画", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/studio/work?view=week");
  const animation = await page.locator(".week-plan-context-track").evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(animation)).toBeLessThanOrEqual(0.0001);
});
