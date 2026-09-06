import { expect, test } from "@playwright/test";

test("侧栏与知识空间使用统一的四字命名", async ({ page }) => {
  await page.goto("/studio/work/knowledge");

  const navigation = page.getByRole("navigation", { name: "产品导航" });
  await expect(navigation.getByText("计划管理", { exact: true })).toBeVisible();
  await expect(navigation.getByText("知识管理", { exact: true })).toBeVisible();
  await expect(navigation.getByText("智能助学", { exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "今日计划", exact: true })).toHaveAttribute("href", "/studio/work");
  await expect(navigation.getByRole("link", { name: "目标管理", exact: true })).toHaveAttribute("href", "/studio/work/goals");
  await expect(navigation.getByRole("link", { name: "知识空间", exact: true })).toHaveAttribute("href", "/studio/work/knowledge");
  await expect(navigation.getByRole("link", { name: "学习笔记", exact: true })).toHaveAttribute("href", "/studio/work/notes");
  await expect(navigation.getByRole("link", { name: "学习伙伴", exact: true })).toHaveAttribute("href", "/studio/coach");
  await expect(navigation.getByRole("link", { name: "记忆画像", exact: true })).toHaveAttribute("href", "/studio/coach/memory");
  await expect(page.getByRole("heading", { name: "知识空间", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "知识空间视图" })).toHaveCount(0);
});

test("访客笔记目标筛选显示实际关联篇数", async ({ page }) => {
  await page.goto("/studio/work/notes");

  await page.getByRole("button", { name: "筛选笔记目标", exact: true }).click();
  const goalOptions = page.getByRole("listbox", { name: "可筛选目标", exact: true });
  await expect(goalOptions.getByRole("option", { name: "全部目标 5 篇", exact: true })).toBeVisible();
  await expect(goalOptions.getByRole("option", { name: "研究生英语二 80 分冲刺 1 篇", exact: true })).toBeVisible();
  await expect(goalOptions.getByRole("option", { name: "通过 PMP 项目管理认证 1 篇", exact: true })).toBeVisible();
  await expect(goalOptions.getByRole("option", { name: "掌握 Python 数据分析 1 篇", exact: true })).toBeVisible();
  await expect(goalOptions.getByRole("option", { name: "读完《设计心理学》并输出卡片 1 篇", exact: true })).toBeVisible();
  await expect(goalOptions.getByRole("option", { name: "日语 N2 听读提升 1 篇", exact: true })).toBeVisible();
  await expect(goalOptions.getByRole("option", { name: "连续 30 天晨间写作 0 篇", exact: true })).toBeVisible();

  await goalOptions.getByRole("option", { name: "掌握 Python 数据分析 1 篇", exact: true }).click();
  await expect(page.locator(".notes-list-row")).toHaveCount(1);
  await expect(page.locator(".notes-list-row").first()).toContainText("Pandas 分组聚合");
});

test("左侧笔记卡片可关联和取消关联目标", async ({ page }) => {
  await page.goto("/studio/work/notes");

  const noteRow = page.locator(".notes-list-row").filter({ hasText: "Pandas 分组聚合" }).first();
  const relationTag = noteRow.locator(".note-list-goal-label");
  await expect(relationTag).toContainText("掌握 Python 数据分析");

  await relationTag.click();
  const relationMenu = page.getByRole("menu");
  await expect(relationMenu.getByText("选择关联目标", { exact: true })).toBeVisible();
  await relationMenu.getByRole("menuitem", { name: "取消目标关联", exact: true }).click();
  await expect(relationTag).toContainText("未关联");
  await expect(page.getByText("已取消与「掌握 Python 数据分析」的关联", { exact: true })).toBeVisible();

  await relationTag.click();
  await page.getByRole("menu").getByRole("menuitem", { name: "通过 PMP 项目管理认证", exact: true }).click();
  await expect(relationTag).toContainText("通过 PMP 项目管理认证");
  await expect(page.getByText("已关联到「通过 PMP 项目管理认证」", { exact: true })).toBeVisible();
});

test("删除笔记使用项目确认弹窗且取消后保留笔记", async ({ page }) => {
  await page.goto("/studio/work/notes");

  const noteRow = page.locator(".notes-list-row").first();
  const noteTitle = (await noteRow.locator(".note-list-select strong").textContent())?.trim() ?? "";
  await noteRow.getByRole("button", { name: /^删除笔记/ }).click();

  const dialog = page.getByRole("alertdialog", { name: `删除笔记“${noteTitle}”？` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/pp-confirm-dialog/);
  await expect(dialog).toContainText("这篇笔记将从笔记列表中移除，此操作无法撤销。");
  const dialogTypeScale = await dialog.evaluate((element) => ({
    confirmation: Number.parseFloat(getComputedStyle(element.querySelector(".pp-confirm-kicker")!).fontSize),
    objectTitle: Number.parseFloat(getComputedStyle(element.querySelector(".pp-confirm-title")!).fontSize),
    description: Number.parseFloat(getComputedStyle(element.querySelector(".pp-confirm-description")!).fontSize),
  }));
  expect(dialogTypeScale.confirmation).toBeGreaterThan(dialogTypeScale.objectTitle);
  expect(dialogTypeScale.objectTitle).toBeGreaterThan(dialogTypeScale.description);
  const dialogAlignment = await dialog.evaluate((element) => {
    const icon = element.querySelector(".pp-confirm-icon")!.getBoundingClientRect();
    const confirmation = element.querySelector(".pp-confirm-kicker")!.getBoundingClientRect();
    const objectTitle = element.querySelector(".pp-confirm-title")!.getBoundingClientRect();
    const description = element.querySelector(".pp-confirm-description")!.getBoundingClientRect();
    return {
      iconToConfirmationTop: Math.abs(icon.top - confirmation.top),
      descriptionToTitleLeft: Math.abs(description.left - objectTitle.left),
    };
  });
  expect(dialogAlignment.iconToConfirmationTop).toBeLessThanOrEqual(1);
  expect(dialogAlignment.descriptionToTitleLeft).toBeLessThanOrEqual(1);
  await expect(dialog.getByRole("button", { name: "确认删除" })).toHaveClass(/pp-danger-button/);
  await expect(dialog.getByRole("button", { name: "保留笔记" })).toBeFocused();

  await dialog.getByRole("button", { name: "保留笔记" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".notes-list-row").filter({ hasText: noteTitle }).first()).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await noteRow.getByRole("button", { name: /^删除笔记/ }).click();
  const mobileDialogBox = await dialog.boundingBox();
  expect(mobileDialogBox).not.toBeNull();
  expect(mobileDialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(mobileDialogBox!.x + mobileDialogBox!.width).toBeLessThanOrEqual(375);
  await dialog.getByRole("button", { name: "保留笔记" }).click();

  await page.setViewportSize({ width: 1280, height: 720 });
  await noteRow.getByRole("button", { name: /^删除笔记/ }).click();
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".notes-list-row").filter({ hasText: noteTitle })).toHaveCount(0);
});

test("科技学习笔记保留完整状态与操作按钮", async ({ page }) => {
  await page.addInitScript(() => {
    const capture = { options: null as unknown, text: "", closed: false };
    (window as typeof window & { __markdownSaveCapture?: typeof capture }).__markdownSaveCapture = capture;
    (window as typeof window & { showSaveFilePicker?: (options: unknown) => Promise<unknown> }).showSaveFilePicker = async (options) => {
      capture.options = options;
      return {
        createWritable: async () => ({
          write: async (blob: Blob) => { capture.text = await blob.text(); },
          close: async () => { capture.closed = true; },
        }),
      };
    };
  });
  await page.goto("/studio/work/notes");

  await expect(page.getByRole("heading", { name: "学习笔记", exact: true })).toBeVisible();
  await expect(page.getByText("NOTE INDEX", { exact: true })).toHaveCount(0);

  const collapseIndex = page.getByRole("button", { name: "收起笔记列表", exact: true });
  await expect(collapseIndex).toBeVisible();
  await expect(collapseIndex).toHaveAttribute("aria-expanded", "true");

  const expandedLayout = await page.locator(".notes-workspace:visible").last().evaluate((element) => {
    const list = element.querySelector(".notes-list")?.getBoundingClientRect();
    const editor = element.querySelector(".note-editor")?.getBoundingClientRect();
    return {
      listWidth: list?.width ?? 0,
      columnGap: list && editor ? editor.left - list.right : 0,
      heightDelta: list && editor ? Math.abs(list.height - editor.height) : Number.POSITIVE_INFINITY,
    };
  });
  expect(expandedLayout.listWidth).toBeCloseTo(228, 0);
  expect(expandedLayout.columnGap).toBeCloseTo(12, 0);
  expect(expandedLayout.heightDelta).toBeLessThanOrEqual(1);

  await collapseIndex.click();
  const expandIndex = page.getByRole("button", { name: "展开笔记列表", exact: true });
  await expect(expandIndex).toBeVisible();
  await expect(expandIndex).toHaveAttribute("aria-expanded", "false");
  await expandIndex.click();

  await expect(page.locator(".notion-editor-toolbar")).toBeVisible();
  const editorOrder = await page.locator(".note-editor").evaluate((element) => {
    const toolbar = element.querySelector(".notion-editor-toolbar")?.getBoundingClientRect();
    const title = element.querySelector(".note-title-editor")?.getBoundingClientRect();
    const body = element.querySelector(".notion-prosemirror")?.getBoundingClientRect();
    return { toolbarBottom: toolbar?.bottom, titleTop: title?.top, titleBottom: title?.bottom, bodyTop: body?.top };
  });
  expect(editorOrder.toolbarBottom).toBeLessThanOrEqual(editorOrder.titleTop ?? 0);
  expect(editorOrder.titleBottom).toBeLessThanOrEqual(editorOrder.bodyTop ?? 0);

  await expect(page.getByLabel("筛选笔记日期")).toHaveCount(0);
  const filterTrigger = page.getByRole("button", { name: "筛选笔记目标", exact: true });
  await filterTrigger.click();
  const filterListbox = page.getByRole("listbox", { name: "可筛选目标", exact: true });
  await expect(filterListbox).toBeVisible();
  await expect(filterListbox.getByRole("option")).not.toHaveCount(0);
  await expect(filterListbox.getByText("筛选笔记", { exact: true })).toHaveCount(0);
  await expect(filterListbox.getByText(/可查看全部笔记/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(filterListbox).toBeHidden();
  await page.getByRole("textbox", { name: "搜索笔记", exact: true }).click();
  await page.waitForTimeout(240);

  const listHeadingStyle = await page.locator(".notes-goal-trigger").evaluate((element) => {
    const title = element.querySelector(".notes-filter-copy > strong") as HTMLElement;
    const copy = element.querySelector(".notes-filter-copy") as HTMLElement;
    const titleRect = title.getBoundingClientRect();
    const copyRect = copy.getBoundingClientRect();
    return {
      title: title.textContent?.trim(),
      titleFits: title.scrollWidth <= title.clientWidth,
      horizontalCenterDelta: Math.abs((titleRect.left + titleRect.right) / 2 - (copyRect.left + copyRect.right) / 2),
      verticalCenterDelta: Math.abs((titleRect.top + titleRect.bottom) / 2 - (copyRect.top + copyRect.bottom) / 2),
    };
  });
  expect(listHeadingStyle.title).toBe("全部目标");
  expect(listHeadingStyle.titleFits).toBe(true);
  expect(listHeadingStyle.horizontalCenterDelta).toBeLessThanOrEqual(1);
  expect(listHeadingStyle.verticalCenterDelta).toBeLessThanOrEqual(1);
  const leftIndexAlignment = await page.locator(".notes-list").evaluate((element) => {
    const icon = element.querySelector(".notes-goal-trigger > svg:first-child") as SVGElement;
    const filterTitle = element.querySelector(".notes-filter-copy > strong") as HTMLElement;
    const noteTitle = element.querySelector(".note-list-select strong") as HTMLElement;
    const preview = element.querySelector(".note-list-preview") as HTMLElement;
    const textBounds = (target: Element) => {
      const range = document.createRange();
      range.selectNodeContents(target);
      return range.getBoundingClientRect();
    };
    return {
      iconTitleGap: textBounds(filterTitle).left - icon.getBoundingClientRect().right,
      previewIndent: textBounds(preview).left - textBounds(noteTitle).left,
    };
  });
  expect(leftIndexAlignment.iconTitleGap).toBeLessThanOrEqual(18);
  expect(leftIndexAlignment.previewIndent).toBeLessThanOrEqual(1);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(220);
  const filterMetaResting = await page.locator(".notes-filter-meta").evaluate((element) => ({
    metaOpacity: Number.parseFloat(getComputedStyle(element).opacity),
    countOpacity: Number.parseFloat(getComputedStyle(element.querySelector(".notes-filter-count")!).opacity),
    arrowOpacity: Number.parseFloat(getComputedStyle(element.querySelector("svg")!).opacity),
  }));
  await filterTrigger.hover();
  await page.waitForTimeout(420);
  const filterMetaHovered = await page.locator(".notes-filter-meta").evaluate((element) => ({
    metaOpacity: Number.parseFloat(getComputedStyle(element).opacity),
    countOpacity: Number.parseFloat(getComputedStyle(element.querySelector(".notes-filter-count")!).opacity),
    arrowOpacity: Number.parseFloat(getComputedStyle(element.querySelector("svg")!).opacity),
    countFontSize: Number.parseFloat(getComputedStyle(element.querySelector(".notes-filter-count")!).fontSize),
    countUnitFontSize: Number.parseFloat(getComputedStyle(element.querySelector(".notes-filter-count > span")!).fontSize),
    countPartsCenterDelta: Math.abs(
      (element.querySelector(".notes-filter-count > b")!.getBoundingClientRect().top + element.querySelector(".notes-filter-count > b")!.getBoundingClientRect().bottom) / 2
      - (element.querySelector(".notes-filter-count > span")!.getBoundingClientRect().top + element.querySelector(".notes-filter-count > span")!.getBoundingClientRect().bottom) / 2,
    ),
    titleFontSize: Number.parseFloat(getComputedStyle(element.parentElement!.querySelector("strong")!).fontSize),
    rowCenterDelta: Math.abs(
      (element.querySelector(".notes-filter-count")!.getBoundingClientRect().top + element.querySelector(".notes-filter-count")!.getBoundingClientRect().bottom) / 2
      - (element.querySelector("svg")!.getBoundingClientRect().top + element.querySelector("svg")!.getBoundingClientRect().bottom) / 2,
    ),
    copyCenterDelta: Math.abs(
      (element.getBoundingClientRect().top + element.getBoundingClientRect().bottom) / 2
      - (element.parentElement!.getBoundingClientRect().top + element.parentElement!.getBoundingClientRect().bottom) / 2,
    ),
  }));
  expect(filterMetaResting.metaOpacity).toBeLessThanOrEqual(0.05);
  expect(filterMetaHovered.countOpacity).toBeGreaterThanOrEqual(0.95);
  expect(filterMetaHovered.arrowOpacity).toBeGreaterThanOrEqual(0.95);
  expect(filterMetaHovered.metaOpacity).toBeGreaterThanOrEqual(0.95);
  expect(filterMetaHovered.countFontSize).toBeLessThan(filterMetaHovered.titleFontSize);
  expect(filterMetaHovered.countUnitFontSize).toBe(filterMetaHovered.countFontSize);
  expect(filterMetaHovered.countPartsCenterDelta).toBeCloseTo(1, 1);
  expect(filterMetaHovered.rowCenterDelta).toBeLessThanOrEqual(1);
  expect(filterMetaHovered.copyCenterDelta).toBeLessThanOrEqual(1);
  await expect(filterTrigger).toHaveCSS("gap", "0px");
  await expect(page.locator(".notes-count-reel-track")).toHaveCount(0);

  await expect(page.locator(".note-list-save-state")).toHaveCount(0);
  await expect(page.locator(".notion-toolbar-end").getByRole("button", { name: "全屏编辑", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消修改", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存笔记", exact: true })).toHaveCount(0);
  await expect(page.locator(".note-card-download")).toHaveCount(0);
  const saveAsAction = page.getByRole("button", { name: /另存为 Markdown$/ }).first();
  await expect(saveAsAction).toBeVisible();
  await expect(saveAsAction.locator("svg")).toHaveCount(0);
  await saveAsAction.click();
  await expect(page.getByText("已保存为 Markdown", { exact: true })).toBeVisible();
  const markdownSave = await page.evaluate(() => (
    window as typeof window & {
      __markdownSaveCapture?: { options: { suggestedName: string; types: Array<{ accept: Record<string, string[]> }> }; text: string; closed: boolean };
    }
  ).__markdownSaveCapture);
  expect(markdownSave?.options.suggestedName).toMatch(/\.md$/);
  expect(markdownSave?.options.types[0].accept["text/markdown"]).toEqual([".md"]);
  expect(markdownSave?.text).toMatch(/^# /);
  expect(markdownSave?.closed).toBe(true);
  const compactToolbarActions = await page.locator(".notion-toolbar-end").evaluate((element) => {
    const saveAs = element.querySelector(".note-toolbar-save-as")?.getBoundingClientRect();
    const edit = element.querySelector(".notion-view-switch-summary")?.getBoundingClientRect();
    return {
      saveAsFontSize: Number.parseFloat(getComputedStyle(element.querySelector(".note-toolbar-save-as")!).fontSize),
      editFontSize: Number.parseFloat(getComputedStyle(element.querySelector(".notion-view-switch-summary")!).fontSize),
      heightDelta: saveAs && edit ? Math.abs(saveAs.height - edit.height) : Number.POSITIVE_INFINITY,
      saveAsBeforeEdit: saveAs && edit ? saveAs.right <= edit.left : false,
    };
  });
  expect(compactToolbarActions.saveAsFontSize).toBe(13);
  expect(compactToolbarActions.editFontSize).toBe(13);
  expect(compactToolbarActions.heightDelta).toBeLessThanOrEqual(1);
  expect(compactToolbarActions.saveAsBeforeEdit).toBe(true);
  await expect(page.locator(".note-card-delete").first()).toBeVisible();
  const indexGeometry = await page.locator(".notes-workspace").evaluate((workspace) => {
    const aside = workspace.querySelector(".notes-list")?.getBoundingClientRect();
    const firstRow = workspace.querySelector(".notes-list-row")?.getBoundingClientRect();
    return {
      width: aside?.width ?? 0,
      firstRowHeight: firstRow?.height ?? Number.POSITIVE_INFINITY,
    };
  });
  expect(indexGeometry.width).toBeCloseTo(228, 0);
  expect(indexGeometry.firstRowHeight).toBeGreaterThanOrEqual(86);
  expect(indexGeometry.firstRowHeight).toBeLessThanOrEqual(112);
  await expect(page.locator(".note-list-goal-label")).toHaveCount(await page.locator(".notes-list-row").count());
  const rowActionAlignment = await page.locator(".notes-list-row").first().evaluate((element) => {
    const actions = [...element.querySelectorAll(".note-card-action")].map((action) => action.getBoundingClientRect());
    return {
      count: actions.length,
      actionWidth: actions[0]?.width ?? 0,
    };
  });
  expect(rowActionAlignment.count).toBe(1);
  expect(rowActionAlignment.actionWidth).toBeGreaterThanOrEqual(24);
  await expect(page.locator(".note-list-meta small").first()).toHaveAttribute("aria-label", /^创建于 /);
  await expect(page.locator(".note-list-meta small").nth(1)).toHaveAttribute("title", /^创建于 .+\d{2}:\d{2}$/);
  await expect(page.locator(".note-list-meta small").nth(1)).toContainText(/\d{1,2}:\d{2}/);
  const dateTypography = await page.locator(".note-list-meta small").nth(1).evaluate((element) => ({
    date: Number.parseFloat(getComputedStyle(element.querySelector("span")!).fontSize),
    clock: Number.parseFloat(getComputedStyle(element.querySelector("time")!).fontSize),
  }));
  expect(Math.abs(dateTypography.clock - dateTypography.date)).toBeLessThanOrEqual(0.1);
  expect(dateTypography.date).toBe(13);
  const previewLayout = await page.locator(".note-list-preview").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      whiteSpace: style.whiteSpace,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      paddingLeft: Number.parseFloat(style.paddingLeft),
      isTruncated: element.scrollWidth > element.clientWidth,
    };
  });
  expect(previewLayout.whiteSpace).toBe("nowrap");
  expect(previewLayout.overflow).toBe("hidden");
  expect(previewLayout.textOverflow).toBe("ellipsis");
  expect(previewLayout.paddingLeft).toBe(0);
  expect(previewLayout.isTruncated).toBe(true);
  await expect(page.getByRole("button", { name: "全屏编辑", exact: true })).toBeVisible();
  const fullscreenButtonStyle = await page.getByRole("button", { name: "全屏编辑", exact: true }).evaluate((element) => {
    const style = getComputedStyle(element);
    const underline = getComputedStyle(element, "::after");
    return { background: style.backgroundColor, border: style.borderLeftWidth, animation: style.animationName, underlineDisplay: underline.display };
  });
  expect(fullscreenButtonStyle.border).toBe("1px");
  expect(fullscreenButtonStyle.animation).toBe("notes-fullscreen-icon-breathe");
  expect(fullscreenButtonStyle.underlineDisplay).toBe("none");
  await expect(page.getByRole("button", { name: "全屏编辑", exact: true }).locator("svg")).toBeVisible();
  await expect(page.getByRole("button", { name: "全屏编辑", exact: true })).not.toContainText("全屏编辑");
  await expect(page.getByText("需要更多排版时，可输入 / 添加内容块", { exact: true })).toHaveCount(0);
  const characterBadge = page.locator(".notion-editor-footer");
  await expect(characterBadge).toContainText(/\d+ 个字符/);
  await expect(characterBadge).toContainText("需要标题、清单或引用时可输入 /");
  const characterBadgeGeometry = await characterBadge.evaluate((element) => {
    const badge = element.getBoundingClientRect();
    const canvas = element.parentElement?.querySelector(".notes-notion-canvas")?.getBoundingClientRect();
    return canvas ? { right: canvas.right - badge.right, bottom: canvas.bottom - badge.bottom } : null;
  });
  expect(characterBadgeGeometry?.right).toBeGreaterThanOrEqual(12);
  expect(characterBadgeGeometry?.right).toBeLessThanOrEqual(16);
  expect(characterBadgeGeometry?.bottom).toBeGreaterThanOrEqual(0);
  expect(characterBadgeGeometry?.bottom).toBeLessThanOrEqual(8);
  await page.getByRole("button", { name: "文本样式", exact: true }).click();
  const styleListbox = page.getByRole("listbox", { name: "选择文本样式", exact: true });
  await expect(styleListbox).toBeVisible();
  await expect(styleListbox.getByRole("option")).toHaveCount(4);
  await styleListbox.getByRole("option", { name: "标题 3", exact: true }).click();
  await expect(styleListbox).toBeHidden();
  await expect(page.getByRole("button", { name: "文本样式", exact: true })).toHaveText("标题 3");
  const pinnedBadgeBefore = await characterBadge.boundingBox();
  await page.locator(".notion-prosemirror").fill(Array.from({ length: 36 }, (_, index) => `第 ${index + 1} 段长文本用于验证字符统计固定。`).join("\n\n"));
  await page.locator(".notes-notion-canvas").evaluate((canvas) => { canvas.scrollTop = canvas.scrollHeight; });
  const pinnedBadgeAfter = await characterBadge.boundingBox();
  expect(Math.abs(((pinnedBadgeAfter?.x ?? 0) + (pinnedBadgeAfter?.width ?? 0)) - ((pinnedBadgeBefore?.x ?? 0) + (pinnedBadgeBefore?.width ?? 0)))).toBeLessThanOrEqual(1);
  expect(Math.abs(((pinnedBadgeAfter?.y ?? 0) + (pinnedBadgeAfter?.height ?? 0)) - ((pinnedBadgeBefore?.y ?? 0) + (pinnedBadgeBefore?.height ?? 0)))).toBeLessThanOrEqual(1);
  await page.locator(".notes-notion-canvas").evaluate((canvas) => { canvas.scrollTop = 0; });
  const editorHeaderGeometry = await page.locator(".notes-workspace").evaluate((workspace) => {
    const leftHeader = workspace.querySelector(".notes-list > header")?.getBoundingClientRect();
    const toolbar = workspace.querySelector(".notion-editor-toolbar")?.getBoundingClientRect();
    const collapse = workspace.querySelector(".notes-index-collapse")?.getBoundingClientRect();
    const undo = workspace.querySelector('[aria-label="撤销"]')?.getBoundingClientRect();
    const styleTrigger = workspace.querySelector(".notion-style-trigger")?.getBoundingClientRect();
    const fontSizeTrigger = workspace.querySelector(".notion-font-size-trigger")?.getBoundingClientRect();
    const redo = workspace.querySelector('[aria-label="重做"]')?.getBoundingClientRect();
    const fullscreenAction = workspace.querySelector(".note-toolbar-fullscreen")?.getBoundingClientRect();
    const viewSwitch = workspace.querySelector(".notion-view-switch")?.getBoundingClientRect();
    const titleHeading = workspace.querySelector(".note-document-heading")?.getBoundingClientRect();
    const goalTrigger = workspace.querySelector(".notes-goal-trigger")?.getBoundingClientRect();
    return {
      bottomDelta: leftHeader && toolbar ? Math.abs(leftHeader.bottom - toolbar.bottom) : Number.POSITIVE_INFINITY,
      centerDelta: collapse && undo ? Math.abs((collapse.top + collapse.height / 2) - (undo.top + undo.height / 2)) : Number.POSITIVE_INFINITY,
      styleWidth: styleTrigger?.width ?? Number.POSITIVE_INFINITY,
      fontSizeWidth: fontSizeTrigger?.width ?? Number.POSITIVE_INFINITY,
      selectorHeightDelta: styleTrigger && fontSizeTrigger ? Math.abs(styleTrigger.height - fontSizeTrigger.height) : Number.POSITIVE_INFINITY,
      undoRedoWidth: undo && redo ? redo.right - undo.left : Number.POSITIVE_INFINITY,
      toolbarRightGap: toolbar && fullscreenAction ? toolbar.right - fullscreenAction.right : Number.POSITIVE_INFINITY,
      viewSwitchWidth: viewSwitch?.width ?? Number.POSITIVE_INFINITY,
      headingHeight: titleHeading?.height ?? Number.POSITIVE_INFINITY,
      goalLeftInset: leftHeader && goalTrigger
        ? goalTrigger.left - leftHeader.left
        : Number.POSITIVE_INFINITY,
    };
  });
  expect(editorHeaderGeometry.bottomDelta).toBeLessThanOrEqual(1);
  expect(editorHeaderGeometry.centerDelta).toBeLessThanOrEqual(1);
  expect(editorHeaderGeometry.styleWidth).toBeLessThanOrEqual(74);
  expect(editorHeaderGeometry.styleWidth).toBeGreaterThanOrEqual(54);
  expect(Math.abs(editorHeaderGeometry.styleWidth - editorHeaderGeometry.fontSizeWidth)).toBeLessThanOrEqual(12);
  expect(editorHeaderGeometry.selectorHeightDelta).toBeLessThanOrEqual(1);
  expect(editorHeaderGeometry.undoRedoWidth).toBeLessThanOrEqual(54);
  expect(editorHeaderGeometry.toolbarRightGap).toBeGreaterThanOrEqual(6);
  expect(editorHeaderGeometry.toolbarRightGap).toBeLessThanOrEqual(10);
  expect(editorHeaderGeometry.viewSwitchWidth).toBeLessThanOrEqual(78);
  expect(editorHeaderGeometry.headingHeight).toBeLessThanOrEqual(52);
  expect(editorHeaderGeometry.goalLeftInset).toBeGreaterThanOrEqual(8);
  expect(editorHeaderGeometry.goalLeftInset).toBeLessThanOrEqual(12);

  const editorCanvas = page.locator(".notes-notion-canvas");
  await expect(editorCanvas).not.toHaveClass(/is-scrolling/);
  await editorCanvas.dispatchEvent("scroll");
  await expect(editorCanvas).toHaveClass(/is-scrolling/);
  await expect(editorCanvas).not.toHaveClass(/is-scrolling/, { timeout: 1_500 });

  await page.getByLabel("笔记标题").fill("更新后的学习笔记");
  await expect(page.getByRole("button", { name: "取消修改", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存笔记", exact: true })).toHaveCount(0);
  await expect(page.locator(".note-list-save-state")).toHaveCount(0);

  await page.getByRole("button", { name: "全屏编辑", exact: true }).click();
  await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "返回笔记", exact: true })).toBeVisible();

  const fullscreenTopbarStyles = await page.locator(".note-fullscreen-topbar").evaluate((topbar) => {
    const back = topbar.querySelector<HTMLElement>("button");
    if (!back) return null;
    const backStyle = getComputedStyle(back);
    return {
      backFontSize: Number.parseFloat(backStyle.fontSize),
      backBorderWidth: Number.parseFloat(backStyle.borderTopWidth),
      backBackground: backStyle.backgroundColor,
      backAnimation: backStyle.animationName,
    };
  });
  expect(fullscreenTopbarStyles).not.toBeNull();
  expect(fullscreenTopbarStyles?.backFontSize ?? 0).toBeGreaterThanOrEqual(14);
  expect(fullscreenTopbarStyles?.backBorderWidth ?? 1).toBe(0);
  expect(fullscreenTopbarStyles?.backBackground).toBe("rgba(0, 0, 0, 0)");
  expect(fullscreenTopbarStyles?.backAnimation).toBe("notes-back-link-breathe");
  await expect(page.getByText("专注编辑", { exact: true })).toHaveCount(0);

  const fullscreenLayout = await page.locator(".note-editor.is-fullscreen").evaluate((element) => {
    const editor = element.getBoundingClientRect();
    const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
    const toolbar = element.querySelector(".notion-editor-toolbar")?.getBoundingClientRect();
    const status = element.querySelector(".notion-toolbar-end")?.getBoundingClientRect();
    return {
      editorLeft: editor.left,
      editorTop: editor.top,
      editorRight: editor.right,
      editorBottom: editor.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      sidebarRight: sidebar?.right ?? 0,
      keepsSidebarVisible: Boolean(document.elementFromPoint(8, 8)?.closest(".sidebar")),
      toolbarLeft: toolbar?.left ?? -1,
      statusRight: status?.right ?? Number.POSITIVE_INFINITY,
    };
  });
  expect(Math.abs(fullscreenLayout.editorLeft - fullscreenLayout.sidebarRight)).toBeLessThanOrEqual(1);
  expect(fullscreenLayout.editorTop).toBeLessThanOrEqual(1);
  expect(fullscreenLayout.editorRight).toBeGreaterThanOrEqual(fullscreenLayout.viewportWidth - 1);
  expect(fullscreenLayout.editorBottom).toBeGreaterThanOrEqual(fullscreenLayout.viewportHeight - 1);
  expect(fullscreenLayout.keepsSidebarVisible).toBe(true);
  expect(fullscreenLayout.toolbarLeft).toBeGreaterThanOrEqual(fullscreenLayout.editorLeft);
  expect(fullscreenLayout.statusRight).toBeLessThanOrEqual(fullscreenLayout.editorRight);

  const colors = await page.locator(".tech-notes-migrated").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      localAccent: style.getPropertyValue("--notes-accent").trim(),
      workspaceAccent: style.getPropertyValue("--workspace-accent").trim(),
      rootAccent: document.documentElement.style.getPropertyValue("--notes-accent").trim(),
    };
  });
  expect(colors.localAccent).toBe(colors.workspaceAccent);
  expect(colors.localAccent).not.toBe("");
  expect(colors.rootAccent).toBe("");
});

test("不支持系统保存选择器时先确认而不是直接下载", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
  await page.goto("/studio/work/notes");

  let downloadStarted = false;
  page.on("download", () => { downloadStarted = true; });
  await page.getByRole("button", { name: /另存为 Markdown$/ }).first().click();

  const dialog = page.getByRole("alertdialog", { name: "当前浏览器无法选择保存位置" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Chrome 或 Edge");
  await expect(dialog.getByRole("button", { name: "下载到默认位置", exact: true })).toBeVisible();
  expect(downloadStarted).toBe(false);

  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载到默认位置", exact: true }).click();
  await download;
  await expect(page.getByText("已下载 Markdown", { exact: true })).toBeVisible();
});

test("笔记目标筛选、数量与新建继承保持一致", async ({ page }) => {
  await page.goto("/studio/work/notes");

  const filterTrigger = page.getByRole("button", { name: "筛选笔记目标", exact: true });
  await filterTrigger.click();
  await page.getByRole("listbox", { name: "可筛选目标", exact: true }).getByRole("option", { name: /算法基础/ }).click();
  await expect(filterTrigger).toContainText("算法基础");
  await expect(page.getByLabel("2 篇笔记")).toBeVisible();
  await expect(page.locator(".notes-list-row")).toHaveCount(2);
  await expect(page.getByText("浏览器事件循环复盘", { exact: true })).toHaveCount(0);

  await filterTrigger.click();
  await page.getByRole("listbox", { name: "可筛选目标", exact: true }).getByRole("option", { name: /面试准备/ }).click();
  await expect(filterTrigger).toContainText("面试准备");
  await expect(page.getByLabel("1 篇笔记")).toBeVisible();
  await expect(page.locator(".notes-list-row")).toHaveCount(1);

  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await expect(page.getByLabel("笔记标题", { exact: true })).toBeFocused();
  await expect(page.getByLabel("笔记标题", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("笔记标题", { exact: true })).toHaveAttribute("placeholder", "为这篇笔记命名");
  await page.locator(".notion-prosemirror").fill("把知识讲给别人听，能暴露真正没有理解的地方。");
  await expect(page.getByLabel("笔记标题", { exact: true })).toHaveValue("把知识讲给别人听，能暴露真正没有理解的地方");
  await expect(page.locator(".note-list-select strong").first()).toContainText("把知识讲给别人听", { timeout: 5_000 });
  await expect(page.locator(".note-list-goal-label").filter({ hasText: "未关联" })).toHaveCount(0);
});

test("新建笔记不会挤窄列表导航或截断选中色块", async ({ page }) => {
  await page.goto("/studio/work/notes");
  await expect(page.locator(".notes-list-row").first()).toBeVisible();

  const notesList = page.locator(".notes-list-scroll:visible").last();
  await expect(notesList).toHaveCSS("scrollbar-color", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
  await notesList.evaluate((element) => element.dispatchEvent(new Event("scroll", { bubbles: true })));
  await expect(notesList).toHaveClass(/is-scrolling/);
  await expect(notesList).not.toHaveClass(/is-scrolling/, { timeout: 1_500 });

  const measureListRail = () => page.locator(".notes-list-scroll:visible").last().evaluate((scroll) => {
    const row = scroll.querySelector<HTMLElement>(".notes-list-row");
    const scrollBounds = scroll.getBoundingClientRect();
    const rowBounds = row?.getBoundingClientRect();
    return {
      clientWidth: scroll.clientWidth,
      rowWidth: rowBounds?.width ?? 0,
      rightGap: rowBounds ? Math.round((scrollBounds.right - rowBounds.right) * 100) / 100 : Number.POSITIVE_INFINITY,
      activeShadow: row?.classList.contains("is-active") ? getComputedStyle(row).boxShadow : "none",
    };
  });

  const before = await measureListRail();
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  const after = await measureListRail();

  expect(after.clientWidth).toBe(before.clientWidth);
  expect(after.rowWidth).toBe(before.rowWidth);
  expect(after.rightGap).toBeLessThanOrEqual(16);
  expect(after.activeShadow).not.toBe("none");
});

test("快速开始仅为空白笔记出现，应用模板后退出", async ({ page }) => {
  await page.goto("/studio/work/notes");
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();

  const quickStart = page.getByRole("region", { name: "快速开始笔记", exact: true });
  await expect(quickStart).toBeVisible();
  await expect(quickStart).not.toHaveClass(/is-collapsed/);
  const dragHandle = quickStart.getByRole("button", { name: "拖动快速开始", exact: true });
  await expect(dragHandle).toBeVisible();
  const quickStartGeometry = await quickStart.evaluate((element) => {
    const body = element.closest(".notion-editor-body")?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return {
      position: getComputedStyle(element).position,
      insideBody: body ? bounds.left >= body.left && bounds.right <= body.right : false,
      width: bounds.width,
      bodyWidth: body?.width ?? 0,
      left: bounds.left,
      top: bounds.top,
    };
  });
  expect(quickStartGeometry.position).toBe("absolute");
  expect(quickStartGeometry.insideBody).toBe(true);
  expect(quickStartGeometry.width).toBeLessThanOrEqual(quickStartGeometry.bodyWidth);
  const dragBounds = await dragHandle.boundingBox();
  expect(dragBounds).not.toBeNull();
  await page.mouse.move(dragBounds!.x + dragBounds!.width / 2, dragBounds!.y + dragBounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBounds!.x + dragBounds!.width / 2 + 54, dragBounds!.y + dragBounds!.height / 2 + 38, { steps: 5 });
  await page.mouse.up();
  const movedGeometry = await quickStart.boundingBox();
  expect(movedGeometry).not.toBeNull();
  expect(movedGeometry!.x).toBeGreaterThan(quickStartGeometry.left + 35);
  expect(movedGeometry!.y).toBeGreaterThan(quickStartGeometry.top + 20);
  await expect(quickStart.getByRole("button", { name: /记录今日学习/ })).toBeVisible();
  await expect(quickStart.getByRole("button", { name: /整理一个概念/ })).toBeVisible();
  await expect(quickStart.getByRole("button", { name: /记录一个疑问/ })).toBeVisible();
  const horizontalTemplateGeometry = await quickStart.locator(".notion-quick-start-actions > button").evaluateAll((buttons) => (
    buttons.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { left: bounds.left, centerY: bounds.top + bounds.height / 2 };
    })
  ));
  expect(horizontalTemplateGeometry).toHaveLength(3);
  expect(horizontalTemplateGeometry[1].left).toBeGreaterThan(horizontalTemplateGeometry[0].left);
  expect(horizontalTemplateGeometry[2].left).toBeGreaterThan(horizontalTemplateGeometry[1].left);
  expect(Math.max(...horizontalTemplateGeometry.map((item) => item.centerY)) - Math.min(...horizontalTemplateGeometry.map((item) => item.centerY))).toBeLessThanOrEqual(1);
  await quickStart.getByRole("button", { name: /整理一个概念/ }).click();

  await expect(quickStart).toHaveCount(0);
  await expect(page.getByLabel("笔记标题", { exact: true })).toHaveValue("概念拆解");
  await expect(page.locator(".notion-prosemirror > h2")).toHaveCount(0);
  await expect(page.locator(".notion-prosemirror blockquote")).toContainText("不要照抄定义");
  await expect(page.locator(".notion-prosemirror")).toContainText("一句话解释");
  await expect(page.locator(".notion-prosemirror h3")).toHaveCount(4);
  await expect(page.locator(".notion-prosemirror")).toContainText("边界与易混点");
  const templateStepColors = await page.locator(".notion-prosemirror h3 > span").evaluateAll((steps) => (
    Array.from(new Set(steps.map((step) => getComputedStyle(step).color)))
  ));
  expect(templateStepColors).toHaveLength(1);

});

test("待办复选框与第一行正文水平对齐", async ({ page }) => {
  await page.goto("/studio/work/notes");
  const alignment = await page.locator(".notion-prosemirror").evaluate((editor) => {
    const fixture = document.createElement("ul");
    fixture.dataset.type = "taskList";
    fixture.innerHTML = '<li data-type="taskItem"><label><input type="checkbox"></label><div><p>复习今天的笔记</p></div></li>';
    editor.append(fixture);
    const checkbox = fixture.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const paragraph = fixture.querySelector("p");
    if (!checkbox || !paragraph) return null;
    const checkboxBounds = checkbox.getBoundingClientRect();
    const paragraphBounds = paragraph.getBoundingClientRect();
    const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
    const difference = Math.abs(
      checkboxBounds.top + checkboxBounds.height / 2
      - (paragraphBounds.top + lineHeight / 2),
    );
    fixture.remove();
    return difference;
  });

  expect(alignment).not.toBeNull();
  expect(alignment ?? 99).toBeLessThanOrEqual(1.5);
});

test("笔记正文可以选择并保存文字颜色", async ({ page }) => {
  await page.goto("/studio/work/notes");
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();

  const editor = page.locator(".notion-prosemirror");
  await editor.fill("给这句话换一个颜色");
  await editor.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.getByRole("button", { name: "文字颜色", exact: true }).click();
  await page.getByRole("option", { name: "薄荷绿", exact: true }).click();

  const coloredText = editor.locator("span[style*='color']");
  await expect(coloredText).toContainText("给这句话换一个颜色");
  await expect(coloredText).toHaveAttribute("style", /#278a72|rgb\(39, 138, 114\)/);
});

test("笔记正文可以单独调整字号", async ({ page }) => {
  await page.goto("/studio/work/notes");
  const editor = page.locator(".notion-prosemirror");
  await editor.fill("字号应该独立于正文和标题层级");
  await editor.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.getByRole("button", { name: "字号", exact: true }).click();
  const fontSizeMenu = page.getByRole("listbox", { name: "选择字号", exact: true });
  await expect(fontSizeMenu).toBeVisible();
  await fontSizeMenu.getByRole("option", { name: "Aa 18 px" }).click();
  await expect(editor.locator("span[style*='font-size']")).toHaveCSS("font-size", "18px");
  await expect(page.getByRole("button", { name: "字号", exact: true })).toContainText("18");
  const formatGeometry = await page.locator(".notion-format-selectors").evaluate((element) => {
    const style = element.querySelector(".notion-style-trigger")?.getBoundingClientRect();
    const size = element.querySelector(".notion-font-size-trigger")?.getBoundingClientRect();
    const inner = element.querySelector(".is-format-inner")?.getBoundingClientRect();
    const left = element.previousElementSibling?.getBoundingClientRect();
    const right = element.nextElementSibling?.getBoundingClientRect();
    if (!style || !size || !inner || !left || !right) return null;
    return {
      centers: [style, size, inner, left, right].map((rect) => rect.top + rect.height / 2),
      gaps: [style.left - left.right, inner.left - style.right, size.left - inner.right, right.left - size.right],
    };
  });
  expect(formatGeometry).not.toBeNull();
  expect(Math.max(...formatGeometry!.centers) - Math.min(...formatGeometry!.centers)).toBeLessThanOrEqual(1);
  expect(Math.max(...formatGeometry!.gaps)).toBeLessThanOrEqual(3);
});

test("两种列表生成真实文档节点", async ({ page }) => {
  await page.goto("/studio/work/notes");
  const editor = page.locator(".notion-prosemirror");

  await editor.fill("项目列表内容");
  await editor.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.getByRole("button", { name: "项目列表", exact: true }).click();
  await expect(editor.locator("ul:not([data-type='taskList']) > li")).toContainText("项目列表内容");

  await editor.fill("编号列表内容");
  await editor.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.getByRole("button", { name: "编号列表", exact: true }).click();
  await expect(editor.locator("ol > li").filter({ hasText: "编号列表内容" })).toHaveCount(1);
});

test("笔记编辑器不再展示插入与布局工具", async ({ page }) => {
  await page.goto("/studio/work/notes");
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();

  await expect(page.getByRole("button", { name: /插入与布局/ })).toHaveCount(0);
  await expect(page.getByLabel("插入与布局工具", { exact: true })).toHaveCount(0);
});

test("斜杠内容块菜单点击编辑空白处后收起", async ({ page }) => {
  await page.goto("/studio/work/notes");
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  const editor = page.locator(".notion-prosemirror");
  await editor.click();
  await editor.press("/");
  const slashMenu = page.getByRole("menu", { name: "内容块菜单", exact: true });
  await expect(slashMenu).toBeVisible();
  await page.locator(".notion-editor-body").click({ position: { x: 420, y: 300 } });
  await expect(slashMenu).toBeHidden();
});

test("高亮可以选择颜色并清除", async ({ page }) => {
  await page.goto("/studio/work/notes");
  const editor = page.locator(".notion-prosemirror");
  await editor.fill("需要重点复习");
  await editor.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.getByRole("button", { name: "高亮颜色", exact: true }).click();
  await page.getByRole("listbox", { name: "选择高亮颜色", exact: true }).getByRole("option", { name: "薄荷绿色", exact: true }).click();
  await expect(editor.locator("mark")).toHaveAttribute("data-color", "#bcebdc");

  await editor.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.getByRole("button", { name: "高亮颜色", exact: true }).click();
  await page.getByRole("listbox", { name: "选择高亮颜色", exact: true }).getByRole("option", { name: "清除高亮", exact: true }).click();
  await expect(editor.locator("mark")).toHaveCount(0);
});

test("Markdown 支持源码编辑、预览与富文本粘贴转换", async ({ page }) => {
  await page.goto("/studio/work/notes");
  const modeSummary = page.getByRole("button", { name: "展开编辑模式", exact: true });
  await expect(modeSummary).toHaveAttribute("aria-keyshortcuts", /Shift\+M/);
  const toolbarWidthBeforeModeMenu = await page.locator(".notion-editor-toolbar").evaluate((element) => element.getBoundingClientRect().width);
  await modeSummary.click();
  await page.waitForTimeout(180);
  const downwardMenuGeometry = await page.locator(".notion-view-switch").evaluate((switcher) => {
    const trigger = switcher.querySelector(".notion-view-switch-summary")?.getBoundingClientRect();
    const menu = switcher.querySelector(".notion-view-switch-menu")?.getBoundingClientRect();
    const toolbar = switcher.closest(".notion-editor-toolbar")?.getBoundingClientRect();
    return trigger && menu && toolbar ? {
      topGap: menu.top - trigger.bottom,
      toolbarWidth: toolbar.width,
      staysInsideViewport: menu.left >= 0 && menu.right <= window.innerWidth,
    } : null;
  });
  expect(downwardMenuGeometry?.topGap).toBeGreaterThanOrEqual(5);
  expect(downwardMenuGeometry?.toolbarWidth).toBe(toolbarWidthBeforeModeMenu);
  expect(downwardMenuGeometry?.staysInsideViewport).toBe(true);
  await page.getByRole("tab", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Markdown 源码", exact: true });
  await source.fill("");
  await source.press("/");
  const markdownCommandMenu = page.getByRole("menu", { name: "Markdown 命令菜单", exact: true });
  await expect(markdownCommandMenu).toBeVisible();
  await expect(markdownCommandMenu.getByRole("menuitem")).toHaveCount(8);
  await markdownCommandMenu.getByRole("menuitem", { name: /二级标题/ }).click();
  await expect(markdownCommandMenu).toBeHidden();
  await expect(source).toContainText("##");
  await source.fill("# 学习总结\n\n- 理解状态转移\n- 完成一道练习\n\n`const done = true`");
  await expect(page.getByRole("toolbar", { name: "Markdown 格式工具", exact: true })).toHaveCount(0);

  await modeSummary.click();
  await page.getByRole("tab", { name: "分栏", exact: true }).click();
  await expect(page.locator(".note-editor")).toHaveClass(/is-fullscreen/);
  const fullscreenTopbar = page.locator(".note-fullscreen-topbar");
  await expect(fullscreenTopbar).toBeVisible();
  await expect(fullscreenTopbar.getByRole("button", { name: "展开编辑模式", exact: true })).toBeVisible();
  await expect(fullscreenTopbar.getByRole("button", { name: /另存为 Markdown$/ })).toBeVisible();
  await expect(fullscreenTopbar.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  await expect(page.locator(".notion-editor-toolbar.is-end-portaled")).toBeHidden();
  const split = page.getByLabel("Markdown 分栏编辑", { exact: true });
  await expect(split.getByRole("textbox", { name: "Markdown 源码", exact: true })).toBeVisible();
  await expect(split.getByLabel("Markdown 实时预览", { exact: true }).getByRole("heading", { name: "学习总结", exact: true })).toBeVisible();
  const splitLayers = await split.evaluate((element) => {
    const shell = element.querySelector(".notion-source-editor-shell") as HTMLElement;
    const preview = element.querySelector(".notion-markdown-preview") as HTMLElement;
    return {
      splitBorder: Number.parseFloat(getComputedStyle(element).borderTopWidth),
      splitRadius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
      sourceBorder: Number.parseFloat(getComputedStyle(shell).borderTopWidth),
      sourceRadius: Number.parseFloat(getComputedStyle(shell).borderTopLeftRadius),
      centerRule: Number.parseFloat(getComputedStyle(preview).borderLeftWidth),
    };
  });
  expect(splitLayers.splitBorder).toBe(0);
  expect(splitLayers.splitRadius).toBe(0);
  expect(splitLayers.sourceBorder).toBe(0);
  expect(splitLayers.sourceRadius).toBe(0);
  expect(splitLayers.centerRule).toBe(1);

  await modeSummary.click();
  await page.getByRole("tab", { name: "预览", exact: true }).click();
  const preview = page.getByLabel("Markdown 预览", { exact: true });
  await expect(preview.getByRole("heading", { name: "学习总结", exact: true })).toBeVisible();
  await expect(preview.locator("li")).toHaveCount(2);
  await expect(preview.locator("code")).toHaveText("const done = true");

  await modeSummary.click();
  await page.getByRole("tab", { name: "编辑", exact: true }).click();
  const editor = page.locator(".notion-prosemirror");
  await expect(editor.locator("h1")).toHaveText("学习总结");
  await expect(editor.locator("ul > li")).toHaveCount(2);
  await expect(editor.locator("code")).toHaveText("const done = true");

  await editor.fill("");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => navigator.clipboard.writeText("## 粘贴标题\n\n1. 第一项\n2. 第二项\n\n`inline`"));
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await expect(editor.locator("h2")).toHaveText("粘贴标题");
  await expect(editor.locator("ol > li")).toHaveCount(2);
  await expect(editor.locator("code").filter({ hasText: /^inline$/ })).toHaveCount(1);
});

test("Pilo 只接收加载完成后的真实笔记上下文", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("planpilot-v2-notes", JSON.stringify([{
      id: "loaded-note",
      goalId: null,
      title: "真实加载的笔记",
      date: "今天 10:30",
      goal: "未关联",
      content: "这条笔记用于验证进入页面时的上下文。",
      contentFormat: "plain",
    }]));
    const target = window as typeof window & { __piloContextSignals?: Array<Record<string, unknown>> };
    target.__piloContextSignals = [];
    window.addEventListener("planpilot:pilo-context", (event) => {
      target.__piloContextSignals?.push((event as CustomEvent<Record<string, unknown>>).detail);
    });
  });

  await page.goto("/studio/work/notes");
  await expect(page.getByLabel("笔记标题", { exact: true })).toHaveValue("真实加载的笔记");
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __piloContextSignals?: Array<Record<string, unknown>> }
  ).__piloContextSignals ?? [])).toContainEqual(expect.objectContaining({
    kind: "object-opened",
    surface: "notes",
    itemCount: 1,
    objectId: "loaded-note",
    objectTitle: "真实加载的笔记",
  }));
  const signals = await page.evaluate(() => (
    window as typeof window & { __piloContextSignals?: Array<Record<string, unknown>> }
  ).__piloContextSignals ?? []);
  expect(signals).not.toContainEqual(expect.objectContaining({ itemCount: 3 }));
});

test("输入后立即离开页面也会静默保存", async ({ page }) => {
  await page.goto("/studio/work/notes");
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByLabel("笔记标题", { exact: true }).fill("离开页面自动保存验证");
  await page.locator(".notion-prosemirror").fill("不点击保存，直接离开页面。内容回来后仍然存在。");

  const navigation = page.getByRole("navigation", { name: "产品导航" });
  await navigation.getByRole("link", { name: "目标管理", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/work\/goals/);
  await navigation.getByRole("link", { name: "学习笔记", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/work\/notes/);

  await expect(page.getByText("离开页面自动保存验证", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存笔记", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消修改", exact: true })).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("窄屏笔记工具栏与文本样式菜单保持可用", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/studio/work/notes");

  const goalTrigger = page.getByRole("button", { name: "筛选笔记目标", exact: true });
  const narrowHeading = await goalTrigger.evaluate((element) => {
    const title = element.querySelector(".notes-filter-copy > strong") as HTMLElement;
    return { text: title.textContent?.trim(), fits: title.scrollWidth <= title.clientWidth };
  });
  expect(narrowHeading).toEqual({ text: "全部目标", fits: true });
  await goalTrigger.click();
  await expect(page.locator(".notes-filter-count")).toHaveCSS("opacity", "1");
  await goalTrigger.click();

  const styleTrigger = page.getByRole("button", { name: "文本样式", exact: true });
  await styleTrigger.scrollIntoViewIfNeeded();
  await expect(styleTrigger).toBeVisible();
  await styleTrigger.click();
  const styleMenu = page.getByRole("listbox", { name: "选择文本样式", exact: true });
  await expect(styleMenu).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
