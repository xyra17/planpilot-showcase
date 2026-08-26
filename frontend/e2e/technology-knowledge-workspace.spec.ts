import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
  });
  await page.goto("/studio/work/knowledge");
  await expect(page.getByRole("dialog", { name: "访客体验" })).toHaveCount(0);
});

test("访客说明只在首页展示并提供登录注册入口", async ({ page }) => {
  await page.goto("/studio/work");
  const intro = page.getByRole("dialog", { name: "访客体验" });
  await expect(intro).toBeVisible();
  await expect(intro).toContainText("页面展示的是一组体验数据");
  await expect(intro.getByRole("heading", { name: "访客体验" })).toHaveCSS("font-size", "18px");
  await expect(intro.locator(".knowledge-demo-intro-icon .lucide-sparkles")).toBeVisible();
  await expect(intro.locator(".knowledge-demo-intro-heading p")).toHaveText("先看看一个完整的学习工作区");
  await expect(intro.locator(".knowledge-demo-intro-heading p")).toHaveCSS("font-size", "13px");
  await expect(intro.locator(".knowledge-guest-gate-message strong")).toHaveText("页面展示的是一组体验数据");
  const guestCopy = intro.locator(".knowledge-guest-gate-copy");
  const guestCopyLines = guestCopy.locator(":scope > span");
  await expect(guestCopyLines).toHaveText([
    "目标、任务、笔记、资料与 Pilo 对话互相关联；",
    "登录后将使用你自己的真实数据。",
  ]);
  const guestCopyBox = await guestCopyLines.first().boundingBox();
  const guestCopyTitleBox = await intro.locator(".knowledge-guest-gate-message strong").boundingBox();
  expect(Math.abs((guestCopyBox?.x ?? 0) - (guestCopyTitleBox?.x ?? 0))).toBeLessThanOrEqual(1);
  await expect(intro).toBeFocused();
  await expect(intro.getByRole("link", { name: "注册", exact: true })).toHaveAttribute("href", "/register");
  await expect(intro.getByRole("link", { name: "登录", exact: true })).toHaveAttribute("href", "/login");

  const desktopDialog = await intro.boundingBox();
  expect(Math.abs(((desktopDialog?.y ?? 0) + (desktopDialog?.height ?? 0) / 2) - 360)).toBeLessThanOrEqual(24);

  await page.setViewportSize({ width: 375, height: 667 });
  const mobileDialog = await intro.boundingBox();
  expect(mobileDialog?.x ?? -1).toBeGreaterThanOrEqual(16);
  expect((mobileDialog?.x ?? 999) + (mobileDialog?.width ?? 999)).toBeLessThanOrEqual(359);
  await expect(intro.getByRole("button", { name: "继续体验" })).toBeVisible();
  await expect(intro.getByRole("link", { name: "注册", exact: true })).toBeVisible();
  await expect(intro.getByRole("link", { name: "登录", exact: true })).toBeVisible();

  await intro.getByRole("button", { name: "继续体验" }).click();
  await page.goto("/studio/work/knowledge");
  await expect(page.getByRole("dialog", { name: "访客体验" })).toHaveCount(0);
});

test("知识空间独立组织目标与个人文件夹", async ({ page }) => {
  const rail = page.locator(".knowledge-library-rail");
  const aiCard = page.locator(".knowledge-ai-assist-card");
  const table = page.getByRole("table", { name: "知识空间资料" });

  await expect(page.getByText("读完《设计心理学》并输出卡片", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("掌握 Python 数据分析", { exact: true }).first()).toBeVisible();

  await expect(rail.getByRole("heading", { name: /^按目标/ })).toBeVisible();
  await expect(rail.getByRole("link", { name: "管理", exact: true })).toHaveCount(0);
  await expect(rail.getByRole("heading", { name: /^个人文件夹/ })).toBeVisible();
  await expect(rail.locator(".knowledge-library-list-section").getByText("稍后精读", { exact: true })).toBeVisible();
  await expect(rail.locator(".knowledge-library-list-section").getByText("常用模板", { exact: true })).toBeVisible();
  await expect(rail.locator(".knowledge-library-list-section").getByText("Python 数据分析", { exact: true })).toHaveCount(0);
  await expect(rail.locator(".knowledge-scope-shortcuts").getByRole("button", { name: "未关联资料 1" })).toBeVisible();
  await expect(page.getByText("学习目标与个人文件夹独立分类，可任选一种或同时关联", { exact: true })).toBeVisible();
  const classificationResizer = rail.getByRole("separator", { name: "调整目标与个人文件夹区域高度" });
  await expect(classificationResizer).toBeVisible();
  await expect(classificationResizer).toHaveAttribute("aria-orientation", "horizontal");
  await expect(classificationResizer).toHaveAttribute("aria-valuenow", "50");
  await classificationResizer.press("ArrowDown");
  await expect(classificationResizer).toHaveAttribute("aria-valuenow", "55");
  await classificationResizer.press("ArrowUp");
  await expect(classificationResizer).toHaveAttribute("aria-valuenow", "50");
  await expect(aiCard.getByRole("heading", { name: /资料助手/ })).toBeVisible();
  await expect(rail.locator(".knowledge-goal-scroll > button").filter({ hasText: /^掌握 Python 数据分析/ })).toBeVisible();
  await expect(page.getByText("资料库列表", { exact: true })).toHaveCount(0);
  await expect(page.getByText("快捷访问", { exact: true })).toHaveCount(0);
  await expect(page.getByText("资料库分组", { exact: true })).toHaveCount(0);
  await expect(page.getByText("资料可用度", { exact: true })).toHaveCount(0);
  await expect(page.locator(".knowledge-resource-toolbar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "切换资料排序" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /批量操作/ })).toHaveCount(0);
  const selectAll = page.getByLabel("选择全部资料");
  const rowCheckboxes = page.locator('.knowledge-resource-table article input[type="checkbox"]');
  await expect(selectAll).toBeVisible();
  const rowCount = await rowCheckboxes.count();
  expect(rowCount).toBeGreaterThan(0);
  await selectAll.check();
  await expect(page.locator(".knowledge-resource-table article.is-selected")).toHaveCount(rowCount);
  await expect(page.getByRole("button", { name: "批量操作" })).toBeVisible();
  await page.getByRole("button", { name: "批量操作" }).click();
  await expect(page.getByRole("menuitem", { name: "批量删除" })).toBeVisible();
  await page.getByRole("button", { name: "批量操作" }).click();
  await selectAll.uncheck();
  await expect(page.locator(".knowledge-resource-table article.is-selected")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "批量操作" })).toHaveCount(0);
  await expect(page.locator(".knowledge-resource-table")).toHaveCSS("overflow-y", "auto");
  await expect(page.locator(".knowledge-resource-context p")).toHaveCSS("white-space", "nowrap");

  for (const selector of [".knowledge-goal-scroll", ".knowledge-library-list", ".knowledge-resource-table"]) {
    const scrollRegion = page.locator(selector);
    await scrollRegion.evaluate((element) => element.dispatchEvent(new Event("scroll", { bubbles: true })));
    await expect(scrollRegion).toHaveClass(/is-scrolling/);
    await expect(scrollRegion).not.toHaveClass(/is-scrolling/, { timeout: 1_500 });
  }

  const aiTrigger = aiCard.getByRole("button", { name: /资料助手/ });
  await expect(aiTrigger).toHaveAttribute("aria-expanded", "false");
  await aiTrigger.click();
  await expect(aiTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(aiCard.getByText("自动摘要", { exact: true })).toBeVisible();
  await aiTrigger.click();
  await expect(aiTrigger).toHaveAttribute("aria-expanded", "false");

  await rail.locator(".knowledge-goal-scroll > button").filter({ hasText: /^掌握 Python 数据分析/ }).click();
  await expect(page.locator(".knowledge-resource-context h2")).toHaveText("掌握 Python 数据分析");
  await expect(page.locator(".knowledge-resource-context p")).toContainText("已关联到当前学习目标");
  await expect(table.getByText("电商订单数据分析实战.md", { exact: true })).toBeVisible();
  await expect(table.getByText("掌握 Python 数据分析", { exact: true }).first()).toBeVisible();

  await rail.locator(".knowledge-library-row > button:first-child").filter({ hasText: /^稍后精读/ }).click();
  await expect(page.locator(".knowledge-resource-context h2")).toHaveText("稍后精读");
  await expect(table.getByText("英语二阅读结构识别清单.pdf", { exact: true })).toBeVisible();
  await expect(table.getByText("《设计心理学》概念卡片.md", { exact: true })).toBeVisible();

  await rail.locator(".knowledge-scope-shortcuts").getByRole("button", { name: "未关联资料 1" }).click();
  await expect(table.getByText("晨间写作 30 天题目卡.md", { exact: true })).toBeVisible();
  await expect(page.locator(".knowledge-resource-table article")).toHaveCount(1);
});

test("资料表为关联目标留出空间，并说明收藏与编辑操作", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = page.locator(".knowledge-resource-table article");
  const rowGoalStates = await rows.evaluateAll((items) => items.map((item) => !item.querySelector(".knowledge-resource-goals .is-unlinked")));
  expect(rowGoalStates).toEqual([...rowGoalStates].sort((a, b) => Number(b) - Number(a)));

  const headerCheckbox = await page.getByLabel("选择全部资料").boundingBox();
  const firstRowCheckbox = await rows.first().locator('input[type="checkbox"]').boundingBox();
  expect(Math.abs((headerCheckbox?.x ?? 0) - (firstRowCheckbox?.x ?? 0))).toBeLessThanOrEqual(1);

  const firstRow = page.locator(".knowledge-resource-table article").first();
  const cells = firstRow.locator(":scope > *");
  const nameCell = await cells.nth(1).boundingBox();
  const goalCell = await cells.nth(2).boundingBox();
  const dateCell = await cells.nth(4).boundingBox();
  const actionCell = await cells.nth(5).boundingBox();

  expect(dateCell?.width ?? 999).toBeLessThanOrEqual(78);
  expect(actionCell?.width ?? 999).toBeLessThanOrEqual(68);
  expect(goalCell?.width ?? 0).toBeGreaterThan((dateCell?.width ?? 999) * 2);
  expect((nameCell?.width ?? 0) / (goalCell?.width ?? 1)).toBeLessThanOrEqual(2.4);

  const alignment = await page.evaluate(() => ({
    nameHead: getComputedStyle(document.querySelector<HTMLElement>(".knowledge-resource-name-head")!).textAlign,
    nameCell: getComputedStyle(document.querySelector<HTMLElement>(".knowledge-resource-identity")!).justifyContent,
    goalCell: getComputedStyle(document.querySelector<HTMLElement>(".knowledge-resource-goals")!).justifyContent,
  }));
  expect(alignment).toEqual({ nameHead: "center", nameCell: "flex-start", goalCell: "center" });

  const favorite = firstRow.locator(".knowledge-row-action-cell button").first();
  const edit = firstRow.locator(".knowledge-row-action-cell button").nth(1);
  await expect(favorite).toHaveAttribute("data-tooltip", "收藏资料");
  await expect(edit).toHaveAttribute("data-tooltip", "编辑资料");
  await favorite.hover();
  await expect.poll(() => favorite.evaluate((button) => getComputedStyle(button, "::after").opacity)).toBe("1");
  await edit.focus();
  await expect.poll(() => edit.evaluate((button) => getComputedStyle(button, "::after").opacity)).toBe("1");
});

test("资料表可从表头调整整列宽度并保留本机偏好", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const header = page.locator(".knowledge-resource-table-head");
  const firstRow = page.locator(".knowledge-resource-table article").first();
  const nameHandle = page.getByRole("separator", { name: "调整资料名称列宽度" });
  const headerName = header.locator(":scope > span").nth(1);
  const rowName = firstRow.locator(":scope > *").nth(1);
  const initialHeaderWidth = (await headerName.boundingBox())?.width ?? 0;

  const handleBox = await nameHandle.boundingBox();
  await page.mouse.move((handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2, (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2);
  await page.mouse.down();
  await page.mouse.move((handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2 + 24, (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2);
  await page.mouse.up();
  const resizedHeaderWidth = (await headerName.boundingBox())?.width ?? 0;
  const resizedRowWidth = (await rowName.boundingBox())?.width ?? 0;
  expect(resizedHeaderWidth).toBeGreaterThan(initialHeaderWidth + 12);
  expect(Math.abs(resizedHeaderWidth - resizedRowWidth)).toBeLessThanOrEqual(1);

  const saved = await page.evaluate(() => localStorage.getItem("planpilot:knowledge-resource-columns:v1"));
  expect(saved).toContain("name");

  const goalHandle = page.getByRole("separator", { name: "调整关联目标列宽度" });
  const goalBeforeKeyboard = (await header.locator(":scope > span").nth(2).boundingBox())?.width ?? 0;
  await goalHandle.focus();
  await goalHandle.press("ArrowLeft");
  expect((await header.locator(":scope > span").nth(2).boundingBox())?.width ?? 0).toBeLessThan(goalBeforeKeyboard - 4);

  await nameHandle.dblclick();
  expect(Math.abs(((await page.locator(".knowledge-resource-table-head > span").nth(1).boundingBox())?.width ?? 0) - initialHeaderWidth)).toBeLessThanOrEqual(2);
});

test("资料全屏预览只占工作区并保留桌面导航", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.locator(".knowledge-resource-identity").filter({ hasText: "电商订单数据分析实战.md" }).click();
  const preview = page.getByRole("dialog", { name: "电商订单数据分析实战.md 预览" });
  await preview.getByRole("button", { name: "全屏预览" }).click();

  const geometry = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
    const drawer = document.querySelector<HTMLElement>(".document-drawer.is-fullscreen")?.getBoundingClientRect();
    const backdrop = document.querySelector<HTMLElement>(".document-drawer-backdrop")?.getBoundingClientRect();
    const previewPane = document.querySelector<HTMLElement>(".document-preview-pane")?.getBoundingClientRect();
    const infoPane = document.querySelector<HTMLElement>(".document-info-pane")?.getBoundingClientRect();
    return {
      sidebarRight: sidebar?.right ?? -1,
      drawerLeft: drawer?.left ?? -1,
      drawerRight: drawer?.right ?? -1,
      drawerTop: drawer?.top ?? -1,
      drawerBottom: drawer?.bottom ?? -1,
      backdropLeft: backdrop?.left ?? -1,
      previewLeft: previewPane?.left ?? -1,
      infoRight: infoPane?.right ?? -1,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      topLeftClass: document.elementFromPoint(12, 12)?.closest(".sidebar")?.className ?? "",
    };
  });

  expect(geometry.sidebarRight).toBe(220);
  expect(geometry.drawerLeft).toBe(geometry.sidebarRight);
  expect(geometry.backdropLeft).toBe(geometry.sidebarRight);
  expect(geometry.drawerRight).toBe(geometry.viewportWidth);
  expect(geometry.drawerTop).toBe(0);
  expect(geometry.drawerBottom).toBe(geometry.viewportHeight);
  expect(geometry.previewLeft).toBe(geometry.sidebarRight);
  expect(geometry.infoRight).toBe(geometry.viewportWidth);
  expect(geometry.topLeftClass).toContain("sidebar");
  await expect(preview.getByRole("button", { name: "退出全屏" })).toBeVisible();

  await preview.getByRole("button", { name: "收起资料信息" }).click();
  await expect(preview.getByRole("button", { name: "展开资料信息" })).toBeVisible();
  await expect.poll(() => page.locator(".document-preview-pane").evaluate((pane) => pane.getBoundingClientRect().right)).toBe(geometry.viewportWidth - 10);
});

test("访客上传资料时先说明存储边界并提供注册登录入口", async ({ page }) => {
  await page.getByRole("button", { name: "导入资料", exact: true }).click();
  await page.getByRole("button", { name: /上传文件/ }).click();
  const accountDialog = page.getByRole("dialog", { name: "继续使用完整知识空间" });
  await expect(accountDialog).toBeVisible();
  await expect(accountDialog).toContainText("登录后即可继续这项操作");
  await expect(accountDialog.locator(".knowledge-auth-gate-heading")).toBeVisible();
  await expect(accountDialog.locator(".knowledge-auth-gate-icon .lucide-sparkles")).toBeVisible();
  await expect(accountDialog.locator(".knowledge-guest-gate-message")).toHaveCSS("display", "grid");
  await expect(accountDialog.getByRole("heading", { name: "继续使用完整知识空间" })).toHaveCSS("font-size", "18px");
  await expect(accountDialog.locator(".knowledge-auth-gate-heading p")).toHaveText("登录后，资料与学习进度会持续保存");
  await expect(accountDialog.locator(".knowledge-guest-gate-message strong")).toHaveText("你正在尝试上传文件并建立索引");
  await expect(accountDialog.locator(".knowledge-auth-gate-note")).toHaveCount(0);
  expect((await accountDialog.boundingBox())?.height ?? 999).toBeLessThan(430);
  await expect(accountDialog.getByRole("link", { name: "注册", exact: true })).toHaveAttribute("href", "/register");
  await expect(accountDialog.getByRole("link", { name: "登录", exact: true })).toHaveAttribute("href", "/login");
  await expect(page.getByRole("dialog", { name: "上传学习资料" })).toHaveCount(0);
});

test("访客资料问答不会进入真实后端流程", async ({ page }) => {
  const assistant = page.locator(".knowledge-ai-assist-card");
  await assistant.getByRole("button", { name: /资料助手/ }).click();
  await assistant.getByRole("button", { name: "资料问答" }).click();
  const accountDialog = page.getByRole("dialog", { name: "继续使用完整知识空间" });
  await expect(accountDialog).toContainText("使用真实资料向学习伙伴提问");
  await expect(page).toHaveURL(/\/studio\/work\/knowledge$/);
});

test("访客导入网页和创建文件夹使用同一账号提示", async ({ page }) => {
  await page.getByRole("button", { name: "导入资料", exact: true }).click();
  await page.getByRole("button", { name: /导入网址/ }).click();
  await expect(page.getByRole("dialog", { name: "继续使用完整知识空间" })).toContainText("导入网页并建立索引");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "新建文件夹" }).click();
  await expect(page.getByRole("dialog", { name: "继续使用完整知识空间" })).toContainText("创建并保存个人文件夹");
  await expect(page.getByRole("dialog", { name: "新建文件夹" })).toHaveCount(0);
});

test("访客可预览资料，但修改归档或正文时需要账号", async ({ page }) => {
  await page.locator(".knowledge-resource-identity").filter({ hasText: "电商订单数据分析实战.md" }).click();
  const preview = page.getByRole("dialog", { name: "电商订单数据分析实战.md 预览" });

  await expect(preview.getByLabel("归档到")).toBeVisible();
  const archiveToggle = preview.getByRole("button", { name: /^归档到/ });
  await expect(archiveToggle).toHaveAttribute("aria-expanded", "true");
  await archiveToggle.click();
  await expect(archiveToggle).toHaveAttribute("aria-expanded", "false");
  await expect(preview.locator("#document-destination-body")).toHaveCount(0);
  await archiveToggle.click();
  await expect(preview.locator("#document-destination-body")).toBeVisible();
  const goalDestinationsToggle = preview.getByRole("button", { name: /目标分类/ });
  const libraryDestinationsToggle = preview.getByRole("button", { name: /个人文件夹/ });
  await expect(goalDestinationsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(libraryDestinationsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(preview.locator("#document-goal-destinations")).toHaveCSS("overflow-y", "auto");
  await expect(preview.getByRole("checkbox", { name: "掌握 Python 数据分析", exact: true })).toBeChecked();
  await libraryDestinationsToggle.click();
  await expect(libraryDestinationsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(preview.locator("#document-library-destinations")).toHaveCSS("overflow-y", "auto");
  await preview.getByRole("checkbox", { name: "稍后精读", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "继续使用完整知识空间" })).toContainText("保存资料的归档与目标关联");
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await preview.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "继续使用完整知识空间" })).toContainText("编辑并保存学习资料");
  await expect(preview.getByLabel("资料标题")).toHaveCount(0);
});

test("AI 可用说明仅在状态标签悬浮或聚焦时显示", async ({ page }) => {
  await page.locator(".knowledge-resource-identity").filter({ hasText: "英语二阅读结构识别清单.pdf" }).click();
  const preview = page.getByRole("dialog", { name: "英语二阅读结构识别清单.pdf 预览" });
  const previewPane = preview.locator(".document-preview-pane");
  const previewSummary = preview.locator(".knowledge-demo-document-preview");
  const previewSpacing = await Promise.all([previewPane.boundingBox(), previewSummary.boundingBox()]);

  expect((previewSpacing[1]?.y ?? 999) - (previewSpacing[0]?.y ?? 0)).toBeLessThanOrEqual(32);
  await expect(preview.locator(".document-identity-title-row")).toContainText("英语二阅读结构识别清单.pdf资料预览");
  await expect(previewSummary.getByText("资料预览", { exact: true })).toHaveCount(0);
  await expect(previewSummary.getByRole("heading", { name: "英语二阅读结构识别清单" })).toHaveCSS("font-size", "26px");
  const status = preview.locator(".document-ai-status > span");
  const tooltip = preview.getByRole("tooltip");

  await expect(status).toContainText("可用于 AI");
  await expect(tooltip).toBeHidden();
  const discussLink = preview.getByRole("link", { name: "与学习伙伴讨论" });
  await expect(discussLink).toHaveCSS("color", "rgb(247, 249, 255)");
  await expect(discussLink).toHaveCSS("background-image", /linear-gradient/);
  await status.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText("这份资料已完成索引，可由学习伙伴检索和引用。");
});

test("资料信息栏可拖动调宽并完整收起", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.locator(".knowledge-resource-identity").filter({ hasText: "英语二阅读结构识别清单.pdf" }).click();
  const preview = page.getByRole("dialog", { name: "英语二阅读结构识别清单.pdf 预览" });
  const resizer = preview.getByRole("separator", { name: "调整资料信息栏宽度" });
  const infoPane = preview.locator(".document-info-pane");
  const previewPane = preview.locator(".document-preview-pane");
  const initialInfoWidth = (await infoPane.boundingBox())?.width ?? 0;
  const initialPreviewWidth = (await previewPane.boundingBox())?.width ?? 0;

  await resizer.press("ArrowLeft");
  await expect.poll(async () => (await infoPane.boundingBox())?.width ?? 0).toBeGreaterThan(initialInfoWidth);

  await preview.getByRole("button", { name: "收起资料信息" }).click();
  await expect(preview.getByRole("button", { name: "展开资料信息" })).toHaveAttribute("aria-expanded", "false");
  await expect(infoPane).toHaveCSS("visibility", "hidden");
  await expect.poll(async () => (await previewPane.boundingBox())?.width ?? 0).toBeGreaterThan(initialPreviewWidth);

  await preview.getByRole("button", { name: "展开资料信息" }).click();
  await expect(infoPane).toHaveCSS("visibility", "visible");

  await page.setViewportSize({ width: 375, height: 667 });
  await expect(resizer).toBeHidden();
  await expect(infoPane).toBeVisible();
});

test("访客不能进入会产生未持久化内容的 Markdown 编辑器", async ({ page }) => {
  await page.locator(".knowledge-resource-identity").filter({ hasText: "电商订单数据分析实战.md" }).click();
  const preview = page.getByRole("dialog", { name: "电商订单数据分析实战.md 预览" });
  await preview.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "继续使用完整知识空间" })).toBeVisible();
  await expect(preview.getByRole("tab", { name: "编辑" })).toHaveCount(0);
});

test("登录用户复用笔记编辑器，但 Markdown 资料只写入资料存储", async ({ page }) => {
  const resource = {
    id: "resource-md-1",
    name: "学习方法.md",
    size: "1.2 KB",
    uploadDate: "2026-08-14T09:30:00+08:00",
    type: "md",
    // Simulate legacy data: the goal relation only exists through the goal's
    // internal knowledge-base id, not through an explicit goalIds field.
    goalIds: [],
    kbId: "kb-1",
    kbIds: ["kb-1", "goal-kb-1"],
    taskId: "",
    status: "ready",
    error: null,
    retryCount: 0,
    contentLength: 18,
    summary: "一份 Markdown 学习资料",
    sourceUrl: null,
    content: "# 学习方法\n\n先理解，再练习。",
    contentFormat: "markdown" as const,
  };
  const writes: Array<{ url: string; method: string; body: string | null }> = [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const apiPath = url.pathname.replace(/^\/api\/backend/, "");
    if (request.method() !== "GET") {
      writes.push({ url: apiPath, method: request.method(), body: request.postData() });
    }
    if (apiPath === "/api/v1/auth/me") {
      await route.fulfill({ json: { id: "user-1", email: "user@example.com", username: "学习者" } });
      return;
    }
    if (apiPath === "/api/v1/knowledge/kbs") {
      await route.fulfill({ json: { items: [
        { id: "kb-1", name: "个人资料", description: "", goal_id: null, item_count: 1, created_at: "2026-08-14" },
        { id: "goal-kb-1", name: "学习方法目标资料", description: "", goal_id: "goal-1", item_count: 1, created_at: "2026-08-14" },
      ] } });
      return;
    }
    if (apiPath === "/api/v1/goals") {
      await route.fulfill({ json: [{ id: "goal-1", type: "skill", title: "学习方法", deadline: "2026-09-01", daily_hours: 1, current_level: "入门", status: "active", created_at: "2026-08-01", kb_id: "goal-kb-1" }] });
      return;
    }
    if (apiPath === "/api/v1/knowledge/files" && request.method() === "GET") {
      await route.fulfill({ json: { items: [resource] } });
      return;
    }
    if (apiPath === "/api/v1/knowledge/files/resource-md-1/serve" && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "text/markdown", body: resource.content });
      return;
    }
    if (apiPath === "/api/v1/knowledge/files/resource-md-1" && request.method() === "PATCH") {
      const body = request.postDataJSON() as { title: string; content: string; content_format: string };
      await route.fulfill({ json: { ...resource, name: body.title, content: body.content, contentFormat: body.content_format } });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
  await page.addInitScript(() => {
    localStorage.setItem("access_token", "knowledge-editor-test-token");
    localStorage.setItem("user_info", JSON.stringify({ id: "user-1", email: "user@example.com", username: "学习者" }));
  });
  await page.reload();

  await expect(page.getByRole("dialog", { name: "访客模式" })).toHaveCount(0);
  await expect(page.locator(".knowledge-library-list-section").getByText("学习方法目标资料", { exact: true })).toHaveCount(0);
  await expect(page.locator(".knowledge-library-list-section").getByText("个人资料", { exact: true })).toBeVisible();
  await expect(page.locator(".knowledge-goal-scroll > button").filter({ hasText: /^学习方法/ })).toContainText("1");
  await expect(page.locator(".knowledge-resource-table").getByText("学习方法", { exact: true })).toBeVisible();
  await expect(page.locator(".knowledge-library-list-section").getByRole("button", { name: /编辑|管理|设置/ })).toHaveCount(0);
  await page.locator(".knowledge-library-row > button").filter({ hasText: /^个人资料/ }).click();
  await page.getByRole("button", { name: "文件夹设置 个人资料" }).click();
  const folderSettings = page.getByRole("dialog", { name: "文件夹设置 个人资料" });
  await expect(folderSettings.locator(".library-settings-note")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(folderSettings.locator(".library-settings-note")).toHaveCSS("padding", "0px");
  await folderSettings.getByRole("button", { name: "删除文件夹" }).click();
  const deleteFolderDialog = page.getByRole("alertdialog", { name: "删除文件夹“个人资料”？" });
  await expect(deleteFolderDialog).toBeVisible();
  await expect(deleteFolderDialog).toHaveClass(/pp-confirm-dialog/);
  await expect(deleteFolderDialog.locator(".pp-confirm-kicker")).toHaveText("删除确认");
  await expect(deleteFolderDialog).toContainText("资料会保留为未归档");
  await deleteFolderDialog.getByRole("button", { name: "保留文件夹" }).click();
  await expect(deleteFolderDialog).toHaveCount(0);

  const selectAllResources = page.locator('input[aria-label="选择全部资料"]:visible').last();
  await selectAllResources.check();
  await page.getByRole("button", { name: "批量操作" }).click();
  await page.getByRole("menuitem", { name: "批量删除" }).click();
  const deleteResourceDialog = page.getByRole("alertdialog", { name: "删除选中的 1 份资料？" });
  await expect(deleteResourceDialog).toBeVisible();
  await expect(deleteResourceDialog).toHaveClass(/pp-confirm-dialog/);
  await expect(deleteResourceDialog).toContainText("已有索引与关联信息也会一并删除");
  await expect(deleteResourceDialog.getByRole("button", { name: "确认删除" })).toHaveClass(/pp-danger-button/);
  await deleteResourceDialog.getByRole("button", { name: "保留资料" }).click();
  await expect(deleteResourceDialog).toHaveCount(0);
  await selectAllResources.uncheck();
  await page.locator(".knowledge-resource-identity").filter({ hasText: "学习方法.md" }).click();
  const preview = page.getByRole("dialog", { name: "学习方法.md 预览" });
  await expect(preview.getByText("文件预览", { exact: true })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "原始", exact: true })).toHaveCount(0);
  await preview.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(preview.locator(".notion-resource-editor")).toBeVisible();
  const markdownEditor = preview.getByRole("textbox", { name: "Markdown 源码", exact: true });
  await expect(markdownEditor).toContainText("# 学习方法");
  await expect(markdownEditor).toContainText("先理解，再练习。");
  await expect(preview.locator(".notion-rich-controls")).toHaveCount(0);
  await expect(preview.getByLabel("插入与布局工具", { exact: true })).toHaveCount(0);
  await expect(preview.getByRole("region", { name: "快速开始笔记", exact: true })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "展开编辑模式" })).toBeVisible();
  await preview.getByRole("button", { name: "展开编辑模式" }).click();
  await expect(preview.getByRole("tab", { name: "编辑", exact: true })).toHaveCount(0);
  await expect(preview.getByRole("tab", { name: "Markdown", exact: true })).toBeVisible();
  await expect(preview.getByRole("tab", { name: "分栏", exact: true })).toBeVisible();
  await expect(preview.getByRole("tab", { name: "预览", exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "收起编辑模式" }).click();
  const editorGeometry = await preview.evaluate((dialog) => {
    const toolbar = dialog.querySelector<HTMLElement>(".notion-editor-toolbar")!;
    const toolbarScroll = dialog.querySelector<HTMLElement>(".notion-toolbar-scroll")!;
    const title = dialog.querySelector<HTMLElement>(".knowledge-document-heading")!;
    const body = dialog.querySelector<HTMLElement>(".notion-editor-body")!;
    const toolbarBox = toolbar.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    return {
      toolbarHeight: toolbarBox.height,
      toolbarDisplay: getComputedStyle(toolbar).display,
      toolbarDirection: getComputedStyle(toolbar).flexDirection,
      toolbarScrollHeight: toolbarScroll.getBoundingClientRect().height,
      titleBelowToolbar: titleBox.top >= toolbarBox.bottom - 1,
      bodyBelowTitle: bodyBox.top >= titleBox.bottom - 1,
    };
  });
  expect(editorGeometry.toolbarDisplay).toBe("flex");
  expect(editorGeometry.toolbarDirection).toBe("row");
  expect(editorGeometry.toolbarHeight).toBeLessThanOrEqual(64);
  expect(editorGeometry.toolbarScrollHeight).toBeLessThanOrEqual(54);
  expect(editorGeometry.titleBelowToolbar).toBe(true);
  expect(editorGeometry.bodyBelowTitle).toBe(true);
  await preview.getByLabel("资料标题").fill("学习方法（修订）.md");
  await markdownEditor.fill("# 学习方法\n\n先理解，再练习。\n\n补充练习。");
  await expect(preview.getByText("资料编辑", { exact: true })).toHaveCount(0);
  await expect(preview.getByText("Markdown 源码", { exact: true })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "保存资料" })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "取消编辑" })).toHaveCount(0);
  await expect(preview.locator('[aria-label="已保存"], [aria-label="未保存"]')).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  const mobileEditorGeometry = await preview.evaluate((dialog) => {
    const editor = dialog.querySelector<HTMLElement>(".notion-source-editor-shell")?.getBoundingClientRect();
    const dialogBounds = dialog.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      editorInside: editor ? editor.left >= dialogBounds.left && editor.right <= dialogBounds.right + 1 : false,
    };
  });
  expect(mobileEditorGeometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(mobileEditorGeometry.editorInside).toBe(true);
  await page.setViewportSize({ width: 1280, height: 820 });
  await preview.getByRole("button", { name: "关闭预览" }).click();

  await expect.poll(() => writes.some((write) => write.url === "/api/v1/knowledge/files/resource-md-1" && write.method === "PATCH")).toBe(true);
  const knowledgeWrite = writes.find((write) => write.url === "/api/v1/knowledge/files/resource-md-1");
  expect(JSON.parse(knowledgeWrite?.body ?? "{}")).toMatchObject({
    title: "学习方法（修订）.md",
    content: "# 学习方法\n\n先理解，再练习。\n\n补充练习。",
    content_format: "markdown",
  });
  expect(writes.some((write) => write.url.includes("/knowledge/notes"))).toBe(false);
  await expect(preview).toHaveCount(0);

  await page.locator(".knowledge-resource-identity").filter({ hasText: "学习方法（修订）.md" }).click();
  const updatedPreview = page.getByRole("dialog", { name: "学习方法（修订）.md 预览" });
  await updatedPreview.getByRole("button", { name: "编辑", exact: true }).click();
  await updatedPreview.getByLabel("资料标题").fill("仍在修改的学习方法.md");
  await updatedPreview.getByRole("button", { name: "关闭预览" }).click();
  await expect(page.getByRole("alertdialog", { name: "还有修改没有保存" })).toHaveCount(0);
  await expect.poll(() => writes.filter((write) => write.url === "/api/v1/knowledge/files/resource-md-1" && write.method === "PATCH").length).toBe(2);
  const latestWrite = writes.filter((write) => write.url === "/api/v1/knowledge/files/resource-md-1").at(-1);
  expect(JSON.parse(latestWrite?.body ?? "{}")).toMatchObject({ title: "仍在修改的学习方法.md" });
});

test("纯文本资料按原格式编辑并继续保存为 plain", async ({ page }) => {
  const resource = {
    id: "resource-txt-1",
    name: "复习清单.txt",
    size: "0.8 KB",
    uploadDate: "2026-08-19T10:20:00+08:00",
    type: "txt",
    goalIds: ["goal-1"],
    kbId: "kb-1",
    kbIds: ["kb-1"],
    taskId: "",
    status: "ready",
    error: null,
    retryCount: 0,
    contentLength: 12,
    summary: "纯文本复习清单",
    sourceUrl: null,
    content: "复习链表\n完成两道题",
    contentFormat: "plain" as const,
  };
  let savedBody: { content?: string; content_format?: string } | null = null;

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const apiPath = new URL(request.url()).pathname.replace(/^\/api\/backend/, "");
    if (apiPath === "/api/v1/auth/me") {
      await route.fulfill({ json: { id: "user-1", email: "user@example.com", username: "学习者" } });
      return;
    }
    if (apiPath === "/api/v1/knowledge/kbs") {
      await route.fulfill({ json: { items: [{ id: "kb-1", name: "个人资料", description: "", goal_id: null, item_count: 1, created_at: "2026-08-19" }] } });
      return;
    }
    if (apiPath === "/api/v1/goals") {
      await route.fulfill({ json: [{ id: "goal-1", type: "skill", title: "算法基础", deadline: "2026-09-01", daily_hours: 1, current_level: "入门", status: "active", created_at: "2026-08-01" }] });
      return;
    }
    if (apiPath === "/api/v1/knowledge/files" && request.method() === "GET") {
      await route.fulfill({ json: { items: [resource] } });
      return;
    }
    if (apiPath === "/api/v1/knowledge/files/resource-txt-1/serve" && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "text/plain", body: resource.content });
      return;
    }
    if (apiPath === "/api/v1/knowledge/files/resource-txt-1" && request.method() === "PATCH") {
      savedBody = request.postDataJSON() as { content?: string; content_format?: string };
      await route.fulfill({ json: { ...resource, content: savedBody.content, contentFormat: savedBody.content_format } });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
  await page.addInitScript(() => {
    localStorage.setItem("access_token", "plain-editor-test-token");
    localStorage.setItem("user_info", JSON.stringify({ id: "user-1", email: "user@example.com", username: "学习者" }));
  });
  await page.reload();

  await page.locator(".knowledge-resource-identity").filter({ hasText: "复习清单.txt" }).click();
  const preview = page.getByRole("dialog", { name: "复习清单.txt 预览" });
  await preview.getByRole("button", { name: "编辑", exact: true }).click();
  const plainEditor = preview.getByRole("textbox", { name: "纯文本原文", exact: true });
  await expect(plainEditor).toContainText("复习链表");
  await expect(preview.getByRole("button", { name: "当前为纯文本编辑", exact: true })).toBeVisible();
  await expect(preview.getByRole("toolbar", { name: "Markdown 格式工具", exact: true })).toHaveCount(0);
  await expect(preview.locator(".notion-rich-controls")).toHaveCount(0);
  await plainEditor.fill("复习链表\n完成三道题");
  await expect(preview.getByRole("button", { name: "保存资料" })).toHaveCount(0);
  await preview.getByRole("button", { name: "关闭预览" }).click();

  await expect.poll(() => savedBody).not.toBeNull();
  expect(savedBody).toMatchObject({
    content: "复习链表\n完成三道题",
    content_format: "plain",
  });
});

test("窄屏优先展示资料，并保留目标和文件夹的范围选择", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("separator", { name: "调整目标与个人文件夹区域高度" })).toBeHidden();
  await expect(page.getByLabel("移动端资料范围")).toBeVisible();
  await page.getByLabel("移动端资料范围").selectOption("goal:guest-skill");
  await expect(page.locator(".knowledge-resource-context h2")).toHaveText("掌握 Python 数据分析");

  const geometry = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>(".knowledge-library-rail")?.getBoundingClientRect();
    const ai = document.querySelector<HTMLElement>(".knowledge-ai-assist-card")?.getBoundingClientRect();
    const panel = document.querySelector<HTMLElement>(".knowledge-resource-panel")?.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      railTop: rail?.top ?? 0,
      aiTop: ai?.top ?? 0,
      panelTop: panel?.top ?? 0,
    };
  });
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.documentScrollHeight).toBeGreaterThan(geometry.viewportHeight);
  expect(geometry.panelTop).toBeLessThan(geometry.railTop);
  expect(geometry.aiTop).toBeGreaterThan(geometry.railTop);
});
