import { expect, test } from "@playwright/test";

test("暗黑与手帐侧栏保持单行状态和完整账户卡片", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 660 });
  await page.goto("/studio/settings");

  for (const theme of [
    { button: /暗黑模式/, value: "dark", consoleLabel: "WORKSPACE" },
    { button: /手帐纸张/, value: "notebook", consoleLabel: "JOURNAL" },
  ]) {
    await page.getByRole("button", { name: theme.button }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.value);
    await expect(page.locator(".sidebar-console-status > span")).toHaveText(theme.consoleLabel);

    const geometry = await page.locator(".sidebar").evaluate((sidebar) => {
      const sideBounds = sidebar.getBoundingClientRect();
      const status = sidebar.querySelector<HTMLElement>(".sidebar-rotating-status > span")!;
      const statusBounds = status.getBoundingClientRect();
      const footBounds = sidebar.querySelector<HTMLElement>(".sidebar-foot")!.getBoundingClientRect();
      const labels = Array.from(sidebar.querySelectorAll<HTMLElement>(".sidebar-nav a > span"));
      return {
        horizontalOverflow: sidebar.scrollWidth - sidebar.clientWidth,
        verticalOverflow: sidebar.scrollHeight - sidebar.clientHeight,
        statusHeight: statusBounds.height,
        statusWhiteSpace: getComputedStyle(status).whiteSpace,
        footBottomGap: sideBounds.bottom - footBounds.bottom,
        labelsFit: labels.every((label) => label.scrollWidth <= label.clientWidth && label.scrollHeight <= label.clientHeight),
      };
    });

    expect(geometry.horizontalOverflow).toBe(0);
    expect(geometry.verticalOverflow).toBe(0);
    expect(geometry.statusHeight).toBeLessThanOrEqual(22);
    expect(geometry.statusWhiteSpace).toBe("nowrap");
    expect(geometry.footBottomGap).toBeGreaterThanOrEqual(0);
    expect(geometry.labelsFit).toBe(true);
  }
});

test("手帐主题隔离知识、访客弹窗、Pilo 工作区和浮动建议", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 660 });
  await page.goto("/studio/settings");
  await page.getByRole("button", { name: /手帐纸张/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "notebook");

  await page.goto("/studio/work/knowledge");
  const knowledge = page.locator(".knowledge-reference-page");
  await expect(knowledge).toBeVisible();
  const knowledgePalette = await knowledge.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      accent: styles.getPropertyValue("--knowledge-accent").trim(),
      panel: styles.getPropertyValue("--knowledge-panel").trim(),
      text: styles.getPropertyValue("--knowledge-text").trim(),
    };
  });
  expect(knowledgePalette.accent).not.toBe("#6753eb");
  expect(knowledgePalette.panel).not.toBe("#ffffff");
  expect(knowledgePalette.text).not.toBe("#1d2435");
  await expect(knowledge.locator(".knowledge-import-primary")).not.toHaveCSS("background-image", /linear-gradient\(135deg, rgb\(120, 102, 242\)/);

  await page.goto("/studio/work");
  await page.evaluate(() => window.sessionStorage.removeItem("planpilot:guest-home-intro-seen:v1"));
  await page.reload();
  const guestDialog = page.getByRole("dialog", { name: "访客体验" });
  await expect(guestDialog).toBeVisible();
  expect(await guestDialog.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("repeating-linear-gradient");
  expect(Number.parseFloat(await guestDialog.evaluate((element) => getComputedStyle(element).borderRadius))).toBeLessThan(15);
  await guestDialog.getByRole("button", { name: "继续体验" }).click();

  const hint = page.locator(".pilo-companion__hint");
  if (await hint.isVisible()) {
    const hintColors = await hint.evaluate((element) => ({
      color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
    }));
    expect(hintColors.color).not.toBe("rgb(238, 242, 248)");
    expect(hintColors.background).not.toBe("rgba(18, 28, 49, 0.94)");
  }

  await page.goto("/studio/coach");
  const companion = page.locator(".companion-workspace");
  await expect(companion).toBeVisible();
  const companionPalette = await companion.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      canvas: styles.getPropertyValue("--comp-canvas").trim(),
      ink: styles.getPropertyValue("--comp-ink").trim(),
      backgroundImage: styles.backgroundImage,
    };
  });
  expect(companionPalette.canvas).not.toBe("#f3f6fb");
  expect(companionPalette.ink).not.toBe("#172033");
  expect(companionPalette.backgroundImage).toContain("repeating-linear-gradient");
});

test("设置页对齐主题层级并压平学习时间编辑器", async ({ page }, testInfo) => {
  await page.goto("/studio/settings");

  const appearance = page.locator("#settings-appearance:visible").last();
  const accentTitle = appearance.getByText("强调配色", { exact: true });
  const firstThemeOption = appearance.locator(".style-option").first();
  await expect.poll(async () => {
    const titleAlignment = await Promise.all([
      accentTitle.evaluate((element) => element.getBoundingClientRect().left),
      firstThemeOption.evaluate((element) => element.getBoundingClientRect().left),
    ]);
    return Math.abs(titleAlignment[0] - titleAlignment[1]);
  }).toBeLessThanOrEqual(1);

  const preferences = page.locator("#settings-preferences:visible").last();
  const preferenceHeading = preferences.locator(".weekly-settings-heading");
  await expect(preferenceHeading).toHaveCSS("border-bottom-width", "0px");
  for (const section of [appearance, preferences, page.locator("#settings-reminders:visible").last(), page.locator("#settings-account:visible").last()]) {
    const headingSize = Number.parseFloat(await section.locator(".settings-section-head h2").evaluate((element) => getComputedStyle(element).fontSize));
    const subtitleSize = Number.parseFloat(await section.locator(".settings-section-head p").evaluate((element) => getComputedStyle(element).fontSize));
    expect(headingSize / subtitleSize).toBeGreaterThanOrEqual(1.45);
  }
  await expect(preferences.getByRole("heading", { name: "每周可用时间" })).toBeVisible();
  const timeCard = preferences.locator(".availability-time-card");
  await expect(timeCard.getByText("每周可用时间（硬约束）", { exact: true })).toHaveCount(0);
  await expect(timeCard.getByText("系统安排任务时会遵守这些可学习时间窗口。", { exact: true })).toHaveCount(0);
  await expect(preferences).toHaveCSS("border-top-width", "1px");
  await expect(timeCard).toHaveCSS("border-top-width", "0px");
  await expect(page.getByText("学习偏好", { exact: true })).toHaveCount(0);
  await expect(preferences.getByText("每日专注目标", { exact: true })).toHaveCount(0);
  await expect(preferences.getByText("周末强度", { exact: true })).toHaveCount(0);

  const monday = preferences.getByRole("tab", { name: "周一，1 可用时段" });
  const sunday = preferences.getByRole("tab", { name: "周日，休息" });
  await expect(monday).not.toContainText("1 可用时段");
  await expect(sunday).not.toContainText("休息");
  expect(await monday.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(45.9);
  expect(await monday.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(46.1);
  expect(Number.parseFloat(await monday.locator("strong").evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
  await expect(monday).toHaveCSS("box-shadow", "none");
  await expect(monday).toHaveCSS("border-radius", "0px");
  await expect(preferences.getByRole("tab", { name: "周二，1 可用时段" })).toHaveCSS("border-left-width", "0px");
  const activeUnderline = await monday.evaluate((element) => ({
    height: getComputedStyle(element, "::before").height,
    opacity: getComputedStyle(element, "::before").opacity,
  }));
  expect(activeUnderline.height).toBe("2px");
  expect(activeUnderline.opacity).toBe("1");
  const dayCenterOffsets = await Promise.all([monday, sunday].map((day) => day.evaluate((element) => {
    const button = element.getBoundingClientRect();
    const label = element.querySelector("strong")?.getBoundingClientRect();
    return label ? Math.abs((button.left + button.width / 2) - (label.left + label.width / 2)) : Number.POSITIVE_INFINITY;
  })));
  expect(Math.max(...dayCenterOffsets)).toBeLessThanOrEqual(1);
  const beforeHover = await monday.evaluate((element) => ({
    content: getComputedStyle(element, "::after").content,
    opacity: getComputedStyle(element, "::after").opacity,
  }));
  expect(beforeHover.content).toContain("1 可用时段");
  expect(beforeHover.opacity).toBe("0");
  const restBeforeHover = await sunday.evaluate((element) => ({
    content: getComputedStyle(element, "::after").content,
    opacity: getComputedStyle(element, "::after").opacity,
  }));
  expect(restBeforeHover.content).toContain("休息");
  expect(restBeforeHover.opacity).toBe("0");

  await expect(preferences.getByText("可添加多个互不重叠的时间段", { exact: true })).toHaveCount(0);
  const dayEditor = preferences.locator(".availability-day-editor");
  await expect(dayEditor.getByText("周一", { exact: true })).toHaveCount(0);
  await expect(dayEditor.getByText("周一的可用时间区间", { exact: true })).toHaveCount(0);
  await expect(dayEditor.getByText("这里只定义可以学习的时间，不是任务列表。", { exact: true })).toHaveCount(0);
  await expect(dayEditor.getByRole("button", { name: "沿用至其他工作日" })).toBeVisible();
  await expect(dayEditor.getByText("将当前时间设置复制到周一至周五", { exact: true })).toHaveCount(0);
  await expect(dayEditor.getByRole("button", { name: "添加时段" })).toBeVisible();
  await expect(dayEditor.getByRole("button", { name: "添加时段" })).toHaveAttribute("data-hint", "同一天可以添加多个互不重叠的时间段");
  const revokeRange = dayEditor.getByRole("button", { name: "撤销周一第 1 个设定时段" });
  await expect(revokeRange).toContainText("撤销");
  await expect(dayEditor.getByRole("button", { name: /删除周一/ })).toHaveCount(0);
  await expect(dayEditor).toHaveCSS("border-top-width", "1px");

  const firstRangeRow = dayEditor.locator(".availability-range-row").first();
  const saveArrangement = preferences.getByRole("button", { name: "保存安排" });
  const editorMain = dayEditor.locator(".availability-editor-main");
  const [headingPosition, dayTabsPosition, editorPosition, editorMainPosition, addPosition, rangePosition, rangeRowPosition, revokePosition, savePosition] = await Promise.all([
    preferenceHeading.evaluate((element) => element.getBoundingClientRect()),
    preferences.locator(".availability-day-tabs").evaluate((element) => element.getBoundingClientRect()),
    dayEditor.evaluate((element) => element.getBoundingClientRect()),
    editorMain.evaluate((element) => element.getBoundingClientRect()),
    dayEditor.getByRole("button", { name: "添加时段" }).evaluate((element) => element.getBoundingClientRect()),
    firstRangeRow.locator(".availability-range").evaluate((element) => element.getBoundingClientRect()),
    firstRangeRow.evaluate((element) => element.getBoundingClientRect()),
    revokeRange.evaluate((element) => element.getBoundingClientRect()),
    saveArrangement.evaluate((element) => element.getBoundingClientRect()),
  ]);
  expect(rangePosition.top - dayTabsPosition.bottom).toBeLessThanOrEqual(30);
  expect(rangePosition.right).toBeLessThanOrEqual(revokePosition.left);
  expect(revokePosition.left - rangePosition.right).toBeLessThanOrEqual(8);
  const copyAction = dayEditor.getByRole("button", { name: "沿用至其他工作日" });
  const copyPosition = await copyAction.evaluate((element) => element.getBoundingClientRect());
  expect(editorPosition.right - addPosition.right).toBeLessThanOrEqual(1);
  const [weekdayTextLeft, startLabelLeft] = await Promise.all([
    monday.locator("strong").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().left;
    }),
    firstRangeRow.locator(".availability-time-label").first().evaluate((element) => element.getBoundingClientRect().left),
  ]);
  expect(Math.abs(weekdayTextLeft - startLabelLeft)).toBeLessThanOrEqual(1);
  expect(rangePosition.left - editorMainPosition.left).toBeGreaterThan(30);
  expect(savePosition.width).toBeGreaterThanOrEqual(150);
  expect(savePosition.top).toBeGreaterThanOrEqual(headingPosition.top);
  expect(savePosition.bottom).toBeLessThanOrEqual(headingPosition.bottom + 1);
  expect(dayTabsPosition.top - savePosition.bottom).toBeGreaterThanOrEqual(8);
  expect(Math.abs(headingPosition.right - savePosition.right)).toBeLessThanOrEqual(1);
  await expect(dayEditor.locator(".availability-inline-actions")).toHaveCount(0);
  await expect(saveArrangement).toHaveCSS("border-top-width", "1px");
  expect(await saveArrangement.evaluate((element) => getComputedStyle(element).backgroundImage)).not.toBe("none");
  expect(Number.parseFloat(await saveArrangement.evaluate((element) => getComputedStyle(element).borderRadius))).toBeGreaterThanOrEqual(8);
  expect(await saveArrangement.evaluate((element) => getComputedStyle(element, "::after").content)).toBe("none");
  expect(addPosition.top).toBeGreaterThanOrEqual(copyPosition.bottom - 1);
  expect(Math.abs(rangeRowPosition.bottom - addPosition.bottom)).toBeLessThanOrEqual(4);
  expect(Math.abs(copyPosition.left - addPosition.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(copyPosition.width - addPosition.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(savePosition.left - addPosition.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(savePosition.width - addPosition.width)).toBeLessThanOrEqual(1);
  expect(Number.parseFloat(await dayEditor.getByRole("button", { name: "添加时段" }).evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
  expect(Number.parseFloat(await copyAction.evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
  const operationFontSizes = await Promise.all([
    dayEditor.getByRole("button", { name: "添加时段" }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    copyAction.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    revokeRange.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  expect(Math.max(...operationFontSizes) - Math.min(...operationFontSizes)).toBeLessThanOrEqual(.1);
  await expect(copyAction).toHaveCSS("border-top-width", "0px");
  await expect(copyAction).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(await copyAction.evaluate((element) => getComputedStyle(element, "::before").height)).toBe("1.5px");
  await expect(revokeRange).toHaveCSS("border-top-width", "0px");
  await expect(revokeRange).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(await revokeRange.evaluate((element) => getComputedStyle(element).color)).not.toBe(await copyAction.evaluate((element) => getComputedStyle(element).color));

  await revokeRange.click();
  await expect(dayEditor.getByRole("status")).toContainText("暂无可用时段");
  await expect(dayEditor.getByRole("status")).toContainText("当前按休息日处理");
  await expect(dayEditor.getByRole("button", { name: "设置可用时段" })).toBeVisible();
  await expect(dayEditor.getByRole("button", { name: "沿用至其他工作日" })).toBeDisabled();
  await dayEditor.getByRole("button", { name: "设置可用时段" }).click();

  const startLabel = preferences.locator(".availability-time-field").first().locator(":scope > label").first();
  const startWrapper = preferences.locator(".availability-time-input").first();
  const startInput = preferences.getByLabel("周一开始时间", { exact: true });
  expect(Number.parseFloat(await startLabel.evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
  await expect(startWrapper).toHaveCSS("border-left-width", "0px");
  await expect(startWrapper).toHaveCSS("border-top-width", "0px");
  await expect(startWrapper).toHaveCSS("border-right-width", "0px");
  await startInput.click();
  await expect(startWrapper).toHaveCSS("box-shadow", "none");
  expect(Number.parseFloat(await startInput.evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(15);
  await expect(startInput).toHaveCSS("text-align", "center");
  await expect(startInput).toHaveCSS("color", /rgb/);
  const startControl = preferences.locator(".availability-time-control").first();
  const underlineWidth = Number.parseFloat(await startControl.evaluate((element) => getComputedStyle(element, "::after").width));
  const controlWidth = await startControl.evaluate((element) => element.getBoundingClientRect().width);
  expect(underlineWidth).toBeLessThan(controlWidth * .75);
  const pickerTrigger = preferences.getByRole("button", { name: "选择周一开始时间" }).first();
  await expect(pickerTrigger.locator(".lucide-chevron-down")).toHaveCount(1);
  await expect(pickerTrigger.locator(".lucide-clock-3")).toHaveCount(0);
  await expect(pickerTrigger).toHaveCSS("border-top-width", "0px");
  await expect(pickerTrigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await pickerTrigger.click();
  await expect(pickerTrigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const timePicker = preferences.getByRole("dialog", { name: "选择周一开始时间" });
  await expect(timePicker).toBeVisible();
  await expect(timePicker).toHaveCSS("opacity", "1");
  await expect(timePicker.getByRole("button", { name: "19 时" })).toHaveAttribute("aria-pressed", "true");
  const pickerGeometry = await timePicker.evaluate((element) => {
    const picker = element.getBoundingClientRect();
    const rangeList = element.closest(".availability-range-list");
    const selectedHour = element.querySelector<HTMLElement>('[aria-label="19 时"]');
    const hourList = selectedHour?.parentElement;
    const selected = selectedHour?.getBoundingClientRect();
    const list = hourList?.getBoundingClientRect();
    return {
      width: picker.width,
      radius: Number.parseFloat(getComputedStyle(element).borderRadius),
      rangeOverflow: rangeList ? getComputedStyle(rangeList).overflow : "",
      selectedVisible: Boolean(selected && list && selected.bottom > list.top && selected.top < list.bottom),
      headerTitleSize: Number.parseFloat(getComputedStyle(element.querySelector("header span")!).fontSize),
      headerValueSize: Number.parseFloat(getComputedStyle(element.querySelector("header strong")!).fontSize),
    };
  });
  expect(pickerGeometry.width).toBeGreaterThanOrEqual(275);
  expect(pickerGeometry.radius).toBeGreaterThanOrEqual(15);
  expect(pickerGeometry.rangeOverflow).toBe("visible");
  expect(pickerGeometry.selectedVisible).toBe(true);
  expect(pickerGeometry.headerValueSize).toBeGreaterThan(pickerGeometry.headerTitleSize);
  await timePicker.getByRole("button", { name: "30 分" }).click();
  await timePicker.getByRole("button", { name: "应用时间" }).click();
  await expect(startInput).toHaveValue("19:30");
  await startInput.fill("2045");
  await startInput.press("Tab");
  await expect(startInput).toHaveValue("20:45");

  await expect(preferences.getByText("规划密度偏好", { exact: true })).toHaveCount(0);
  await expect(preferences.getByRole("button", { name: /轻松|均衡|紧凑/ })).toHaveCount(0);
  await expect(preferences.getByRole("button", { name: "保存安排" })).toBeVisible();

  const reminders = page.locator("#settings-reminders:visible").last();
  const timezone = reminders.locator("#settings-timezone");
  const timezoneGeometry = await timezone.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const styles = getComputedStyle(element);
    return { width: bounds.width, height: bounds.height, textLeft: bounds.left + Number.parseFloat(styles.paddingLeft) };
  });
  expect(timezoneGeometry.width).toBeLessThanOrEqual(172.1);
  expect(timezoneGeometry.height).toBeLessThanOrEqual(44.1);
  await timezone.focus();
  await expect(timezone).toHaveCSS("outline-style", "none");
  await expect(reminders.getByText("自动保存", { exact: true })).toHaveCount(0);
  await expect(reminders.getByText("已开启", { exact: true })).toHaveCount(0);
  await expect(reminders.getByRole("button", { name: "晚间学习邮件提醒：已关闭" })).toBeDisabled();
  const disabledCopy = reminders.locator(".reminder-disabled-copy");
  await expect(disabledCopy).toContainText("开启后设置提醒时间与邮件收件地址");
  await expect(disabledCopy).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const [disabledCopyBounds, reminderRowBounds] = await Promise.all([
    disabledCopy.evaluate((element) => element.getBoundingClientRect()),
    reminders.locator(".email-reminder-row").evaluate((element) => element.getBoundingClientRect()),
  ]);
  expect(reminderRowBounds.right - disabledCopyBounds.right).toBeLessThanOrEqual(6);
  expect(await disabledCopy.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(Math.ceil(disabledCopyBounds.width));
  await testInfo.attach("settings-reminders-disabled", {
    body: await reminders.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
});

test("可用时间把时段贴近日期并保持行内操作关系", async ({ page }) => {
  await page.goto("/studio/settings#settings-preferences");

  const preferences = page.locator("#settings-preferences:visible").last();
  const dayTabs = preferences.locator(".availability-day-tabs");
  const dayEditor = preferences.locator(".availability-day-editor");
  const rangeRow = dayEditor.locator(".availability-range-row").first();
  const range = rangeRow.locator(".availability-range");
  const revoke = rangeRow.getByRole("button", { name: "撤销周一第 1 个设定时段" });
  const add = dayEditor.getByRole("button", { name: "添加时段" });
  const copy = dayEditor.getByRole("button", { name: "沿用至其他工作日" });

  const [tabsBox, rangeBox, revokeBox, addBox, copyBox] = await Promise.all([
    dayTabs.evaluate((element) => element.getBoundingClientRect()),
    range.evaluate((element) => element.getBoundingClientRect()),
    revoke.evaluate((element) => element.getBoundingClientRect()),
    add.evaluate((element) => element.getBoundingClientRect()),
    copy.evaluate((element) => element.getBoundingClientRect()),
  ]);
  expect(rangeBox.top - tabsBox.bottom).toBeLessThanOrEqual(30);
  expect(revokeBox.left - rangeBox.right).toBeLessThanOrEqual(8);
  expect(addBox.top).toBeGreaterThanOrEqual(copyBox.bottom - 1);
  expect(Math.abs(addBox.left - copyBox.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(addBox.width - copyBox.width)).toBeLessThanOrEqual(1);
  await expect(revoke).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  const rangeList = dayEditor.locator(".availability-range-list");
  for (let index = 0; index < 4; index += 1) await add.click();
  const boundedHeight = await rangeList.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(boundedHeight.scrollHeight).toBeGreaterThan(boundedHeight.clientHeight);
  for (let index = 0; index < 3; index += 1) await add.click();
  const afterMoreRanges = await rangeList.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(Math.abs(afterMoreRanges.clientHeight - boundedHeight.clientHeight)).toBeLessThanOrEqual(1);
  expect(afterMoreRanges.scrollHeight).toBeGreaterThan(boundedHeight.scrollHeight);

  await page.setViewportSize({ width: 375, height: 667 });
  await rangeList.scrollIntoViewIfNeeded();
  const mobileList = await rangeList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    right: element.getBoundingClientRect().right,
  }));
  expect(mobileList.clientHeight).toBeLessThanOrEqual(186);
  expect(mobileList.scrollHeight).toBeGreaterThan(mobileList.clientHeight);
  expect(mobileList.right).toBeLessThanOrEqual(375);

  const [mobileRange, mobileSeparator, mobileSave, mobileHeading] = await Promise.all([
    dayEditor.locator(".availability-range").first().evaluate((element) => element.getBoundingClientRect()),
    dayEditor.locator(".availability-range > i").first().evaluate((element) => element.getBoundingClientRect()),
    preferences.getByRole("button", { name: "保存安排" }).evaluate((element) => element.getBoundingClientRect()),
    preferences.locator(".weekly-settings-heading").evaluate((element) => element.getBoundingClientRect()),
  ]);
  expect(Math.abs((mobileSeparator.left + mobileSeparator.width / 2) - (mobileRange.left + mobileRange.width / 2))).toBeLessThanOrEqual(1);
  expect(mobileSave.right).toBeLessThanOrEqual(375);
  expect(mobileSave.top).toBeGreaterThanOrEqual(mobileHeading.top);
  expect(mobileSave.bottom).toBeLessThanOrEqual(mobileHeading.bottom + 1);

  const pickerTrigger = preferences.getByRole("button", { name: "选择周一开始时间" }).first();
  await expect(pickerTrigger.locator(".lucide-chevron-down")).toHaveCount(1);
  await expect(pickerTrigger.locator(".lucide-clock-3")).toHaveCount(0);
  await pickerTrigger.click();
  const mobilePicker = preferences.getByRole("dialog", { name: "选择周一开始时间" });
  await expect(mobilePicker).toBeVisible();
  const mobilePickerBounds = await mobilePicker.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, width: bounds.width };
  });
  expect(mobilePickerBounds.left).toBeGreaterThanOrEqual(0);
  expect(mobilePickerBounds.right).toBeLessThanOrEqual(375);
  expect(mobilePickerBounds.width).toBeLessThanOrEqual(333);
});

test("账户卡片以导出数据和退出账号收尾", async ({ page }, testInfo) => {
  const user = {
    id: "settings-layout-user",
    email: "settings@example.com",
    username: "设置测试",
    avatar_url: null,
    email_verified: true,
    timezone: "Asia/Shanghai",
    language: "zh-CN",
    week_start: "monday",
    study_days: ["mon", "tue", "wed", "thu", "fri"],
    availability_windows: ["evening"],
    account_preferences: { study_preferences: { reminder_enabled: true, reminder_time: "21:30", reminder_channel: "email", reminder_email: "alerts@example.com", focus_target: "90", weekend_intensity: "light" } },
    created_at: "2026-01-01T00:00:00Z",
  };
  await page.addInitScript((cachedUser) => {
    window.localStorage.setItem("access_token", "settings-layout-token");
    window.localStorage.setItem("user_info", JSON.stringify(cachedUser));
  }, user);
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) }));
  await page.route("**/api/v1/notifications/email-reminder-status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: true, recipient: "alerts@example.com", email_verified: true, timezone: user.timezone }) }));
  await page.goto("/studio/settings");

  const remindersCard = page.locator("#settings-reminders:visible").last();
  const timezoneSelect = remindersCard.locator("#settings-timezone");
  const saveArrangement = page.locator("#settings-preferences:visible").last().getByRole("button", { name: "保存安排" });
  const [timezoneSize, saveArrangementSize] = await Promise.all([
    timezoneSelect.evaluate((element) => element.getBoundingClientRect()),
    saveArrangement.evaluate((element) => element.getBoundingClientRect()),
  ]);
  expect(Math.abs(timezoneSize.width - saveArrangementSize.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(timezoneSize.height - saveArrangementSize.height)).toBeLessThanOrEqual(1);
  await expect(remindersCard.getByText("已开启", { exact: true })).toHaveCount(0);
  await expect(remindersCard.getByRole("button", { name: "晚间学习邮件提醒：已开启" })).toHaveAttribute("aria-pressed", "true");
  await expect(remindersCard.getByLabel("晚间学习邮件提醒时间", { exact: true })).toHaveValue("21:30");
  await expect(remindersCard.locator(".reminder-delivery-label").filter({ hasText: "收件邮箱" })).toBeVisible();
  await expect(remindersCard.getByText("账号邮箱", { exact: true })).toHaveCount(0);
  await expect(remindersCard.getByText("alerts@example.com", { exact: true })).toBeVisible();
  await expect(remindersCard.getByLabel("晚间学习邮件提醒时间", { exact: true })).toHaveCSS("text-align", "center");
  expect(Number.parseFloat(await remindersCard.getByRole("button", { name: "更换", exact: true }).evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
  const headingRows = await Promise.all([
    remindersCard.locator(".email-reminder-title"),
    remindersCard.locator(".reminder-time-setting .reminder-delivery-label"),
    remindersCard.locator(".reminder-channel .reminder-delivery-label"),
  ].map((element) => element.evaluate((node) => node.getBoundingClientRect())));
  expect(Math.max(...headingRows.map((box) => box.top)) - Math.min(...headingRows.map((box) => box.top))).toBeLessThanOrEqual(1);
  const valueRows = await Promise.all([
    remindersCard.locator(".email-reminder-copy > small"),
    remindersCard.locator(".reminder-time-setting .availability-time-control"),
    remindersCard.locator(".reminder-email-value"),
  ].map((element) => element.evaluate((node) => node.getBoundingClientRect())));
  expect(Math.max(...valueRows.map((box) => box.top)) - Math.min(...valueRows.map((box) => box.top))).toBeLessThanOrEqual(1);
  expect(valueRows[1].top - headingRows[1].bottom).toBeLessThanOrEqual(1);
  expect(valueRows[2].top - headingRows[2].bottom).toBeLessThanOrEqual(1);
  const reminderTimeCenterOffset = Math.abs(
    (headingRows[1].left + headingRows[1].width / 2)
      - (valueRows[1].left + valueRows[1].width / 2),
  );
  expect(reminderTimeCenterOffset).toBeLessThanOrEqual(1);
  expect(Number.parseFloat(await remindersCard.locator(".reminder-channel").evaluate((element) => getComputedStyle(element).paddingLeft))).toBeGreaterThanOrEqual(28);
  await expect(remindersCard.getByLabel("提醒邮箱", { exact: true })).toHaveCount(0);
  await remindersCard.getByRole("button", { name: "更换", exact: true }).click();
  await expect(remindersCard.getByLabel("提醒邮箱", { exact: true })).toHaveValue("alerts@example.com");
  await remindersCard.getByRole("button", { name: "取消更换提醒邮箱" }).click();
  const [remindersBox, reminderToggleBox] = await Promise.all([
    remindersCard.evaluate((element) => element.getBoundingClientRect()),
    remindersCard.getByRole("button", { name: "晚间学习邮件提醒：已开启" }).evaluate((element) => element.getBoundingClientRect()),
  ]);
  expect(remindersBox.right - reminderToggleBox.right).toBeGreaterThanOrEqual(70);
  const [deliveryBox, toggleSize] = await Promise.all([
    remindersCard.locator(".reminder-delivery-settings").evaluate((element) => element.getBoundingClientRect()),
    remindersCard.getByRole("button", { name: "晚间学习邮件提醒：已开启" }).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }),
  ]);
  expect(deliveryBox.right).toBeLessThanOrEqual(remindersBox.right + 1);
  expect(toggleSize.width).toBeLessThanOrEqual(44);
  expect(toggleSize.height).toBeLessThanOrEqual(38);

  const reminderPickerTrigger = remindersCard.getByRole("button", { name: "选择晚间学习邮件提醒时间" });
  await reminderPickerTrigger.click();
  const reminderPicker = remindersCard.getByRole("dialog", { name: "选择晚间学习邮件提醒时间" });
  await expect(reminderPicker).toBeVisible();
  const [cardBounds, triggerBounds, pickerBounds, cardOverflow, viewportHeight] = await Promise.all([
    remindersCard.evaluate((element) => element.getBoundingClientRect()),
    reminderPickerTrigger.evaluate((element) => element.getBoundingClientRect()),
    reminderPicker.evaluate((element) => element.getBoundingClientRect()),
    remindersCard.evaluate((element) => getComputedStyle(element).overflow),
    page.locator("body").evaluate(() => window.innerHeight),
  ]);
  expect(pickerBounds.top).toBeLessThan(triggerBounds.top);
  expect(pickerBounds.top).toBeGreaterThanOrEqual(0);
  expect(pickerBounds.bottom).toBeLessThanOrEqual(viewportHeight);
  expect(cardBounds.width).toBeGreaterThan(pickerBounds.width);
  expect(cardOverflow).toBe("visible");
  await testInfo.attach("settings-reminders-refined", {
    body: await remindersCard.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });

  const accountCard = page.locator("#settings-account:visible").last();
  await expect(page.locator("#settings-data")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "隐私与数据" })).toHaveCount(0);
  await expect(accountCard.getByText("加入时间", { exact: true })).toHaveCount(0);
  const accountRows = accountCard.locator(":scope > .setting-row-grid");
  await expect(accountRows.nth(-2)).toContainText("导出学习数据");
  await expect(accountRows.nth(-2).getByRole("button", { name: "导出", exact: true })).toBeVisible();
  await expect(accountRows.last()).toContainText("退出当前账号");
  const exportButton = accountRows.nth(-2).getByRole("button", { name: "导出", exact: true });
  const exitButton = accountRows.last().getByRole("button", { name: "退出", exact: true });
  await expect(exitButton).toBeVisible();
  const actionHeights = await Promise.all([exportButton, exitButton].map((button) => button.evaluate((element) => element.getBoundingClientRect().height)));
  expect(Math.abs(actionHeights[0] - actionHeights[1])).toBeLessThanOrEqual(1);
  expect(actionHeights[0]).toBeGreaterThanOrEqual(42);
  expect(await exitButton.evaluate((element) => getComputedStyle(element).color)).not.toBe(await exportButton.evaluate((element) => getComputedStyle(element).color));
  const [exportLine, exitLine] = await Promise.all([
    exportButton.evaluate((element) => getComputedStyle(element, "::after").backgroundImage),
    exitButton.evaluate((element) => getComputedStyle(element, "::after").backgroundImage),
  ]);
  expect(exitLine).not.toBe(exportLine);
  const exitLineRgb = exitLine.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)?.slice(1).map(Number);
  expect(exitLineRgb).toBeTruthy();
  expect(exitLineRgb?.[0] ?? 0).toBeGreaterThan((exitLineRgb?.[1] ?? 0) + 40);
  expect(exitLineRgb?.[0] ?? 0).toBeGreaterThan((exitLineRgb?.[2] ?? 0) + 40);
  await expect(exportButton).toHaveCSS("border-top-width", "0px");
  await expect(exportButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const beforeHover = await exportButton.evaluate((element) => getComputedStyle(element, "::after").transform);
  await exportButton.hover();
  await expect.poll(() => exportButton.evaluate((element) => getComputedStyle(element, "::after").transform)).not.toBe(beforeHover);
  await testInfo.attach("settings-account-flat-actions", {
    body: await accountCard.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });

  await page.setViewportSize({ width: 375, height: 667 });
  await accountCard.scrollIntoViewIfNeeded();
  for (const action of [exportButton, exitButton]) {
    const box = await action.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
  }
  await testInfo.attach("settings-account-flat-actions-mobile", {
    body: await accountCard.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
});
