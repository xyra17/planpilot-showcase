import { expect, test } from "@playwright/test";
import {
  availabilityForToday,
  getCurrentMinute,
  getIsoDateForTimezone,
  getWeekDatesForTimezone,
  planDaySchedule,
  weeklyAvailabilityFromPreferences,
  type DayScheduleBlock,
  type DayScheduleTask,
} from "../lib/technology/dayScheduler";

const colors = ["#6657d9", "#7184df"];
const availability = [{ startMinute: 9 * 60, endMinute: 11 * 60 }];

function task(id: string, durationMinutes: number, priority = "普通优先级"): DayScheduleTask {
  return {
    id,
    title: `任务 ${id}`,
    goalTitle: "测试目标",
    durationMinutes,
    priority,
    done: false,
  };
}

function block(taskId: string, startHour: number, durationMinutes: number): DayScheduleBlock {
  return {
    id: `technology-schedule-${taskId}`,
    label: `任务 ${taskId}`,
    taskId,
    goalTitle: "测试目标",
    startHour,
    durationMinutes,
    color: colors[0],
    progress: 0,
  };
}

test("旧版可用时段会转换为逐日精确时间", () => {
  const weekly = weeklyAvailabilityFromPreferences(["afternoon", "evening"], ["mon", "wed"]);

  expect(weekly.mon).toEqual([{ start: "13:00", end: "22:00" }]);
  expect(weekly.tue).toEqual([]);
  expect(weekly.wed).toEqual([{ start: "13:00", end: "22:00" }]);
});

test("按用户时区读取当天可用时间", () => {
  const weekly = {
    mon: [{ start: "09:00", end: "11:30" }],
    tue: [{ start: "14:00", end: "18:00" }],
  };
  const instant = new Date("2026-08-03T16:30:00.000Z");

  expect(availabilityForToday(weekly, "Asia/Shanghai", instant)).toEqual([
    { startMinute: 14 * 60, endMinute: 18 * 60 },
  ]);
  expect(availabilityForToday(weekly, "UTC", instant)).toEqual([
    { startMinute: 9 * 60, endMinute: 11 * 60 + 30 },
  ]);
});

test("今日与本周边界按用户时区计算", () => {
  const instant = new Date("2026-08-19T16:30:00.000Z");

  expect(getIsoDateForTimezone("Asia/Shanghai", instant)).toBe("2026-08-20");
  expect(getIsoDateForTimezone("America/New_York", instant)).toBe("2026-08-19");
  expect(getWeekDatesForTimezone("Asia/Shanghai", instant)).toEqual([
    "2026-08-17",
    "2026-08-18",
    "2026-08-19",
    "2026-08-20",
    "2026-08-21",
    "2026-08-22",
    "2026-08-23",
  ]);
});

test("纽约 DST 跳时和重复小时按墙上时钟稳定计算", () => {
  expect(getCurrentMinute("America/New_York", new Date("2026-03-08T06:30:00Z"))).toBe(90);
  expect(getCurrentMinute("America/New_York", new Date("2026-03-08T07:30:00Z"))).toBe(210);

  expect(getCurrentMinute("America/New_York", new Date("2026-11-01T05:30:00Z"))).toBe(90);
  expect(getCurrentMinute("America/New_York", new Date("2026-11-01T06:30:00Z"))).toBe(90);
});

test("自动规划从点击时刻向上取整到十五分钟", () => {
  const result = planDaySchedule({
    tasks: [task("rounded", 30)],
    existingBlocks: [],
    availability: [{ startMinute: 20 * 60, endMinute: 22 * 60 }],
    operation: "replan_all",
    strategy: "compact",
    nowMinute: 20 * 60 + 17,
    colors,
  });

  expect(result.blocks[0]).toMatchObject({ taskId: "rounded", startHour: 20.5 });
});

test("从现在补排只添加待安排任务并保留已有时间块", () => {
  const existing = block("existing", 9, 40);
  const result = planDaySchedule({
    tasks: [task("existing", 40), task("new", 40)],
    existingBlocks: [existing],
    availability,
    operation: "append_unscheduled",
    strategy: "balanced",
    nowMinute: 8 * 60,
    colors,
  });

  expect(result.blocks).toHaveLength(2);
  expect(result.blocks[0]).toEqual(existing);
  expect(result.blocks[1]).toMatchObject({ taskId: "new", startHour: 9 + 50 / 60 });
  expect(result.scheduledTaskIds).toEqual(["new"]);
});

test("放不下长任务时仍继续回填短任务", () => {
  const result = planDaySchedule({
    tasks: [task("long", 70, "核心"), task("short", 30, "低优先级")],
    existingBlocks: [],
    availability: [{ startMinute: 9 * 60, endMinute: 10 * 60 }],
    operation: "replan_all",
    strategy: "balanced",
    nowMinute: 8 * 60,
    colors,
  });

  expect(result.blocks.map((item) => item.taskId)).toEqual(["short"]);
  expect(result.unscheduled).toEqual([
    { taskId: "long", reason: "没有连续 70 分钟的空闲时间" },
  ]);
});

test("紧凑模式可以利用均衡模式保留的休息间隔", () => {
  const request = {
    tasks: [task("one", 40), task("two", 40)],
    existingBlocks: [],
    availability: [{ startMinute: 9 * 60, endMinute: 10 * 60 + 20 }],
    operation: "replan_all" as const,
    nowMinute: 8 * 60,
    colors,
  };

  const balanced = planDaySchedule({ ...request, strategy: "balanced" });
  const compact = planDaySchedule({ ...request, strategy: "compact" });

  expect(balanced.blocks).toHaveLength(1);
  expect(balanced.unscheduled).toEqual([
    { taskId: "two", reason: "均衡方式下空间不足，可切换紧凑方式安排" },
  ]);
  expect(compact.blocks).toHaveLength(2);
  expect(compact.unscheduled).toHaveLength(0);
});

test("重新规划未来任务时保留已经开始的时间块", () => {
  const past = block("past", 9, 40);
  const future = block("future", 14, 40);
  const result = planDaySchedule({
    tasks: [task("past", 40), task("future", 40)],
    existingBlocks: [past, future],
    availability: [{ startMinute: 9 * 60, endMinute: 18 * 60 }],
    operation: "replan_future",
    strategy: "balanced",
    nowMinute: 12 * 60,
    colors,
  });

  expect(result.blocks).toHaveLength(2);
  expect(result.blocks[0]).toEqual(past);
  expect(result.blocks[1]).toMatchObject({ taskId: "future", startHour: 12 });
});

test("当天可用时段结束后返回明确原因", () => {
  const result = planDaySchedule({
    tasks: [task("late", 30)],
    existingBlocks: [],
    availability,
    operation: "replan_all",
    strategy: "compact",
    nowMinute: 22 * 60,
    colors,
  });

  expect(result.blocks).toHaveLength(0);
  expect(result.unscheduled).toEqual([
    { taskId: "late", reason: "今天的可用时段已经结束" },
  ]);
});

test("添加今日任务复用设置页时间选择器", async ({ page }) => {
  const now = new Date();
  now.setHours(11, 23, 0, 0);
  await page.clock.setFixedTime(now);
  await page.goto("/studio/work");
  await page.getByRole("button", { name: "添加任务" }).click();

  const taskDialog = page.getByRole("dialog", { name: "添加今日任务" });
  const timeInput = taskDialog.getByLabel("今日任务开始时间", { exact: true });
  const endTimeInput = taskDialog.getByLabel("今日任务结束时间", { exact: true });
  await expect(timeInput).toHaveAttribute("type", "text");
  await expect(timeInput).toHaveValue("11:23");
  await expect(endTimeInput).toHaveValue("11:53");
  await expect(taskDialog.locator('input[type="time"]')).toHaveCount(0);

  await taskDialog.getByRole("button", { name: "选择今日任务开始时间" }).click();
  const timePicker = taskDialog.getByRole("dialog", { name: "选择今日任务开始时间" });
  await expect(timePicker).toBeVisible();
  await expect(timePicker.getByRole("button", { name: "11 时" })).toHaveAttribute("aria-pressed", "true");
  await expect(timePicker.getByRole("button", { name: "23 分" })).toHaveAttribute("aria-pressed", "true");
  const timeLists = timePicker.locator(".availability-time-options");
  for (const selectedOption of [
    timePicker.getByRole("button", { name: "11 时" }),
    timePicker.getByRole("button", { name: "23 分" }),
  ]) {
    const alignment = await selectedOption.evaluate((option) => {
      const list = option.parentElement;
      if (!list) return Number.POSITIVE_INFINITY;
      return Math.abs(option.getBoundingClientRect().top - list.getBoundingClientRect().top);
    });
    expect(alignment).toBeLessThanOrEqual(1);
  }
  const initialHourScroll = await timeLists.first().evaluate((list) => list.scrollTop);
  const scrolledHourPosition = await timeLists.first().evaluate((list) => {
    list.scrollTop += 32;
    return list.scrollTop;
  });
  expect(scrolledHourPosition).toBeGreaterThan(initialHourScroll);
  await timePicker.getByRole("button", { name: "21 时" }).click();
  await timePicker.getByRole("button", { name: "15 分" }).click();
  await expect(timePicker.getByRole("button", { name: "取消" })).toBeVisible();
  await timePicker.getByRole("button", { name: "应用时间" }).click();
  await expect(timeInput).toHaveValue("21:15");
  await expect(endTimeInput).toHaveValue("21:45");

  await taskDialog.getByRole("button", { name: "选择今日任务结束时间" }).click();
  const endTimePicker = taskDialog.getByRole("dialog", { name: "选择今日任务结束时间" });
  await endTimePicker.getByRole("button", { name: "22 时" }).click();
  await endTimePicker.getByRole("button", { name: "00 分" }).click();
  await endTimePicker.getByRole("button", { name: "应用时间" }).click();
  await expect(endTimeInput).toHaveValue("22:00");

  await timeInput.fill("2045");
  await expect(timeInput).toHaveValue("20:45");
  await timeInput.evaluate((input) => (input as HTMLInputElement).setSelectionRange(2, 2));
  await timeInput.press("Delete");
  await expect(timeInput).toHaveValue("20:45");
  await timeInput.press("Tab");
  await expect(timeInput).toHaveValue("20:45");

  await page.setViewportSize({ width: 375, height: 812 });
  await taskDialog.getByRole("button", { name: "选择今日任务开始时间" }).click();
  const mobilePicker = taskDialog.getByRole("dialog", { name: "选择今日任务开始时间" });
  await expect(mobilePicker).toBeVisible();
  const mobilePickerBox = await mobilePicker.boundingBox();
  expect(mobilePickerBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((mobilePickerBox?.x ?? 376) + (mobilePickerBox?.width ?? 0)).toBeLessThanOrEqual(375);
  await mobilePicker.getByRole("button", { name: "应用时间" }).scrollIntoViewIfNeeded();
  await expect(mobilePicker.getByRole("button", { name: "应用时间" })).toBeVisible();
});

test("添加今日任务使用主题化目标和优先级菜单", async ({ page }) => {
  await page.goto("/studio/work");
  await page.getByRole("button", { name: "添加任务" }).click();

  const taskDialog = page.getByRole("dialog", { name: "添加今日任务" });
  await expect(taskDialog.locator(".quick-task-select-trigger")).toHaveCount(2);
  await expect(taskDialog.getByText("预计时长", { exact: true })).toHaveCount(0);

  const goalSelect = taskDialog.getByRole("combobox", { name: "关联目标" });
  await goalSelect.click();
  const goalMenu = page.getByRole("listbox", { name: "选择关联目标" });
  await expect(goalMenu).toBeVisible();
  await goalMenu.getByRole("option", { name: /面试准备/ }).click();
  await expect(goalSelect).toContainText("面试准备");

  const prioritySelect = taskDialog.getByRole("combobox", { name: "优先级" });
  await prioritySelect.click();
  const priorityMenu = page.getByRole("listbox", { name: "选择任务优先级" });
  await expect(priorityMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(priorityMenu).toBeHidden();
  await expect(taskDialog).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await goalSelect.click();
  const menuBox = await goalMenu.boundingBox();
  expect(menuBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((menuBox?.x ?? 376) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(375);
});

test("添加今日任务根据开始和结束时间计算时长", async ({ page }) => {
  await page.goto("/studio/work");
  await page.getByRole("button", { name: "添加任务" }).click();

  const taskDialog = page.getByRole("dialog", { name: "添加今日任务" });
  await taskDialog.getByLabel("任务名称").fill("时间范围测试任务");
  await taskDialog.getByLabel("今日任务开始时间", { exact: true }).fill("0830");
  const endTimeInput = taskDialog.getByLabel("今日任务结束时间", { exact: true });
  await endTimeInput.fill("0800");
  await taskDialog.getByRole("button", { name: "添加到今日" }).click();
  await expect(taskDialog.getByRole("alert")).toHaveText("结束时间需要晚于开始时间");

  await endTimeInput.fill("1000");
  await taskDialog.getByRole("button", { name: "添加到今日" }).click();
  const createdTask = page.locator(".task-item").filter({ hasText: "时间范围测试任务" });
  await expect(createdTask).toContainText("90 分钟");
  await expect(createdTask).toContainText("08:30–10:00");
});

test("首页自动规划读取设置页保存的逐日可用时段", async ({ page }) => {
  const today = new Date();
  const fixedMorning = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 8);
  const isoDate = [
    fixedMorning.getFullYear(),
    String(fixedMorning.getMonth() + 1).padStart(2, "0"),
    String(fixedMorning.getDate()).padStart(2, "0"),
  ].join("-");
  const weekdayKey = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][fixedMorning.getDay()];
  const weeklyAvailability = Object.fromEntries(
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
      day,
      day === weekdayKey ? [{ start: "14:00", end: "15:30" }] : [],
    ]),
  );

  await page.clock.setFixedTime(fixedMorning);
  await page.addInitScript(({ date, weekly }) => {
    window.localStorage.setItem("planpilot-v2-weekly-availability", JSON.stringify(weekly));
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify([{
      id: 1,
      goalId: "1",
      date,
      title: "验证设置时段",
      goal: "测试目标",
      duration: "30 分钟",
      time: "待安排",
      done: false,
      priority: "核心",
    }]));
    window.localStorage.removeItem("planpilot.technology.schedule.today");
  }, { date: isoDate, weekly: weeklyAvailability });

  await page.goto("/studio/work");
  const panel = page.locator(".today-panel");
  await panel.getByRole("button", { name: "打开时间规划" }).click();
  await panel.getByRole("button", { name: "自动规划" }).click();

  const planner = panel.getByRole("dialog", { name: "自动规划今天的任务" });
  await expect(planner.locator(".today-schedule-planner-availability")).toContainText("14:00–15:30");
  await expect(planner.getByText("14:00–14:30")).toBeVisible();
});

test("卡片内规划面板实时预览节奏并在应用后更新安排", async ({ page }) => {
  const today = new Date();
  const fixedMorning = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 8);
  const isoDate = [
    fixedMorning.getFullYear(),
    String(fixedMorning.getMonth() + 1).padStart(2, "0"),
    String(fixedMorning.getDate()).padStart(2, "0"),
  ].join("-");
  await page.clock.setFixedTime(fixedMorning);
  await page.addInitScript(({ tasks, schedule, date }) => {
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify(tasks));
    window.localStorage.setItem(`planpilot.technology.schedule.${date}`, JSON.stringify(schedule));
  }, {
    date: isoDate,
    tasks: [
      { id: 1, goalId: "1", date: isoDate, title: "已有任务", goal: "测试目标", duration: "40 分钟", time: "09:00", done: false, priority: "核心" },
      { id: 2, goalId: "1", date: isoDate, title: "会话管理接口", goal: "测试目标", duration: "40 分钟", time: "待安排", done: false, priority: "普通优先级" },
    ],
    schedule: [block("1", 9, 40)],
  });

  await page.goto("/studio/work");
  const panel = page.locator(".today-panel");
  await panel.getByRole("button", { name: "打开时间规划" }).click();
  await expect(panel.locator(".today-schedule-row")).toHaveCount(1);
  await panel.getByRole("button", { name: "自动规划" }).click();

  const planner = panel.getByRole("dialog", { name: "自动规划今天的任务" });
  await expect(planner).toBeVisible();
  await expect(planner.getByRole("group", { name: "选择规划节奏" })).toBeVisible();
  const balancedMode = planner.getByRole("button", { name: /均衡/ });
  const balancedTooltip = balancedMode.getByRole("tooltip");
  const timeline = planner.locator(".today-schedule-planner-timeline");
  await timeline.hover();
  await expect(balancedTooltip).toHaveCSS("opacity", "0");
  await expect(timeline).toHaveCSS("scrollbar-color", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
  await timeline.evaluate((element) => { element.dispatchEvent(new Event("scroll")); });
  await expect(timeline).toHaveClass(/is-scrolling/);
  const modeTypography = await balancedMode.evaluate((button) => ({
    align: getComputedStyle(button).justifyContent,
    height: button.getBoundingClientRect().height,
    labelSize: Number.parseFloat(getComputedStyle(button.querySelector("span")!).fontSize),
    groupWidth: button.parentElement!.getBoundingClientRect().width,
  }));
  expect(modeTypography.align).toBe("center");
  expect(modeTypography.height).toBeLessThanOrEqual(30);
  expect(modeTypography.labelSize).toBeGreaterThanOrEqual(13);
  expect(modeTypography.groupWidth).toBeLessThanOrEqual(122);
  const headerAlignment = await planner.locator("header").evaluate((header) => {
    const modes = header.querySelector(".today-schedule-planner-modes")!.getBoundingClientRect();
    const close = header.querySelector(".today-schedule-planner-close")!.getBoundingClientRect();
    return {
      modesCenter: modes.top + modes.height / 2,
      closeCenter: close.top + close.height / 2,
    };
  });
  expect(Math.abs(headerAlignment.modesCenter - headerAlignment.closeCenter)).toBeLessThanOrEqual(2);
  await balancedMode.focus();
  await expect(balancedTooltip).toHaveCSS("opacity", "1");
  expect(Number.parseInt(await balancedTooltip.evaluate((tooltip) => getComputedStyle(tooltip).zIndex), 10)).toBeGreaterThanOrEqual(100);
  const availability = planner.locator(".today-schedule-planner-availability");
  await expect(availability).toContainText("今天可用");
  await expect(planner.getByText("安排预览", { exact: true })).toHaveCount(0);
  await expect(planner.getByText(/个时间块$/)).toHaveCount(0);
  await expect(availability).toHaveCSS("border-top-width", "1px");
  const applyButton = planner.getByRole("button", { name: "应用", exact: true });
  const cancelButton = planner.getByRole("button", { name: "取消", exact: true });
  await expect(applyButton).toHaveCSS("min-height", "30px");
  await expect(applyButton).toHaveCSS("white-space", "nowrap");
  await expect(cancelButton).toHaveCSS("white-space", "nowrap");
  const footerOrder = await planner.evaluate((dialog) => {
    const preview = dialog.querySelector(".today-schedule-planner-preview")!.getBoundingClientRect();
    const available = dialog.querySelector(".today-schedule-planner-availability")!.getBoundingClientRect();
    const footerElement = dialog.querySelector("footer")!;
    const footer = footerElement.getBoundingClientRect();
    const cancel = footerElement.querySelector("button:not(.is-primary)")!.getBoundingClientRect();
    const apply = footerElement.querySelector("button.is-primary")!.getBoundingClientRect();
    return {
      previewBottom: preview.bottom,
      availabilityTop: available.top,
      availabilityBottom: available.bottom,
      footerTop: footer.top,
      cancelTop: cancel.top,
      applyTop: apply.top,
      cancelHeight: cancel.height,
      applyHeight: apply.height,
    };
  });
  expect(footerOrder.previewBottom).toBeLessThanOrEqual(footerOrder.availabilityTop);
  expect(footerOrder.availabilityBottom).toBeLessThanOrEqual(footerOrder.footerTop);
  expect(Math.abs(footerOrder.cancelTop - footerOrder.applyTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(footerOrder.cancelHeight - footerOrder.applyHeight)).toBeLessThanOrEqual(2);
  await expect(planner.getByText("09:50–10:30")).toBeVisible();
  await expect(panel.locator(".today-schedule-row")).toHaveCount(1);

  await planner.getByRole("button", { name: /紧凑/ }).click();
  await expect(planner.getByText("09:40–10:20")).toBeVisible();
  await applyButton.click();

  await expect(panel.locator(".today-schedule-row")).toHaveCount(2);
  await expect(panel.locator(".today-schedule-row").first()).toContainText("09:00–09:40");
  await expect(panel.getByText("已按紧凑方式生成安排，请确认后保存。")).toBeVisible();
  await expect(planner).toHaveCount(0);
});

test("空状态中的待安排入口打开自动规划面板", async ({ page }) => {
  const today = new Date();
  const fixedMorning = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 8);
  const isoDate = [
    fixedMorning.getFullYear(),
    String(fixedMorning.getMonth() + 1).padStart(2, "0"),
    String(fixedMorning.getDate()).padStart(2, "0"),
  ].join("-");
  await page.clock.setFixedTime(fixedMorning);
  await page.addInitScript(({ date }) => {
    const tasks = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      goalId: "1",
      date,
      title: `待安排任务 ${index + 1}`,
      goal: "测试目标",
      duration: "40 分钟",
      time: "待安排",
      done: false,
      priority: index === 0 ? "核心" : "普通优先级",
    }));
    window.localStorage.setItem("planpilot-v2-tasks", JSON.stringify(tasks));
    window.localStorage.removeItem("planpilot.technology.schedule.today");
  }, { date: isoDate });

  await page.goto("/studio/work");
  const panel = page.locator(".today-panel");
  await panel.getByRole("button", { name: "打开时间规划" }).click();
  const emptyState = panel.locator(".today-schedule-empty");
  await expect(emptyState).toBeVisible();
  expect((await emptyState.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(180);
  await emptyState.getByRole("button", { name: "7 项任务待安排" }).click();
  await expect(panel.getByRole("dialog", { name: "自动规划今天的任务" })).toBeVisible();
});

test("账号时区跨午夜后自动刷新今日日期", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-20T15:59:40.000Z") });
  await page.goto("/studio/work");
  await expect(page.locator(".dashboard-page")).toHaveAttribute("data-today-iso", "2026-08-20");

  await page.clock.fastForward(31_000);
  await expect(page.locator(".dashboard-page")).toHaveAttribute("data-today-iso", "2026-08-21");
});
