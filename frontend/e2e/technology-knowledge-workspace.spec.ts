import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
  });
  await page.goto("/studio/work/knowledge");
  const intro = page.getByRole("dialog", { name: "访客模式" });
  await expect(intro).toBeVisible();
  await intro.getByRole("button", { name: "继续浏览" }).click();
});

test("访客进入知识空间时统一说明 Mock 数据并提供登录注册入口", async ({ page }) => {
  await page.reload();
  const intro = page.getByRole("dialog", { name: "访客模式" });
  await expect(intro).toBeVisible();
  await expect(intro).toContainText("这里展示的是 Mock 数据");
  await expect(intro.getByRole("heading", { name: "访客模式" })).toHaveCSS("font-size", "18px");
  await expect(intro.locator(".knowledge-demo-intro-icon .lucide-sparkles")).toBeVisible();
  await expect(intro.locator(".knowledge-demo-intro-heading p")).toHaveText("你可以先体验知识空间");
  await expect(intro.locator(".knowledge-demo-intro-heading p")).toHaveCSS("font-size", "13px");
  await expect(intro.locator(".knowledge-guest-gate-message strong")).toHaveText("这里展示的是 Mock 数据");
  await expect(intro.locator(".knowledge-guest-gate-message span")).toContainText("登录后可上传、编辑、资料问答");
  await expect(intro).not.toContainText("操作前我们会再次提醒");
  await expect(intro.getByRole("link", { name: "注册", exact: true })).toHaveAttribute("href", "/register");
  await expect(intro.getByRole("link", { name: "登录", exact: true })).toHaveAttribute("href", "/login");
  await expect(page.locator(".knowledge-demo-badge")).toHaveCount(0);
  await expect(page.locator(".knowledge-guest-demo-bar")).toHaveCount(0);

  await page.setViewportSize({ width: 375, height: 667 });
  const mobileDialog = await intro.boundingBox();
  expect(mobileDialog?.x ?? -1).toBeGreaterThanOrEqual(16);
  expect((mobileDialog?.x ?? 999) + (mobileDialog?.width ?? 999)).toBeLessThanOrEqual(359);
  await expect(intro.getByRole("button", { name: "继续浏览" })).toBeVisible();
  await expect(intro.getByRole("link", { name: "注册", exact: true })).toBeVisible();
  await expect(intro.getByRole("link", { name: "登录", exact: true })).toBeVisible();
});

test("知识空间以目标为主入口，文件夹仅承担归档职责", async ({ page }) => {
  const rail = page.locator(".knowledge-library-rail");
  const aiCard = page.locator(".knowledge-ai-assist-card");
  const table = page.getByRole("table", { name: "知识空间资料" });

  await expect(page.getByText("英语学术阅读", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("数据分析入门", { exact: true }).first()).toBeVisible();

  await expect(rail.getByRole("heading", { name: /^按目标/ })).toBeVisible();
  await expect(rail.getByRole("heading", { name: /^个人文件夹/ })).toBeVisible();
  await expect(aiCard.getByRole("heading", { name: /资料助手/ })).toBeVisible();
  await expect(rail.locator(".knowledge-goal-scroll > button").filter({ hasText: /^agent 开发/ })).toBeVisible();
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

  await rail.locator(".knowledge-goal-scroll > button").filter({ hasText: /^agent 开发/ }).click();
  await expect(page.locator(".knowledge-resource-context h2")).toHaveText("agent 开发");
  await expect(page.locator(".knowledge-resource-context p")).toContainText("已关联到当前学习目标");
  await expect(table.getByText("Agent 系统设计.pdf", { exact: true })).toBeVisible();
  await expect(table.getByText("agent 开发", { exact: true }).first()).toBeVisible();
});

test("资料全屏预览只占工作区并保留桌面导航", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.locator(".knowledge-resource-identity").filter({ hasText: "RAG 检索增强生成.md" }).click();
  const preview = page.getByRole("dialog", { name: "RAG 检索增强生成.md 预览" });
  await preview.getByRole("button", { name: "全屏预览" }).click();

  const geometry = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
    const drawer = document.querySelector<HTMLElement>(".document-drawer.is-fullscreen")?.getBoundingClientRect();
    const backdrop = document.querySelector<HTMLElement>(".document-drawer-backdrop")?.getBoundingClientRect();
    return {
      sidebarRight: sidebar?.right ?? -1,
      drawerLeft: drawer?.left ?? -1,
      drawerRight: drawer?.right ?? -1,
      drawerTop: drawer?.top ?? -1,
      drawerBottom: drawer?.bottom ?? -1,
      backdropLeft: backdrop?.left ?? -1,
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
  expect(geometry.topLeftClass).toContain("sidebar");
  await expect(preview.getByRole("button", { name: "退出全屏" })).toBeVisible();
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
  await page.locator(".knowledge-resource-identity").filter({ hasText: "RAG 检索增强生成.md" }).click();
  const preview = page.getByRole("dialog", { name: "RAG 检索增强生成.md 预览" });

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
  await expect(preview.getByRole("checkbox", { name: "agent 开发", exact: true })).toBeChecked();
  await libraryDestinationsToggle.click();
  await expect(libraryDestinationsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(preview.locator("#document-library-destinations")).toHaveCSS("overflow-y", "auto");
  await preview.getByRole("checkbox", { name: "项目资料" }).click();
  await expect(page.getByRole("dialog", { name: "继续使用完整知识空间" })).toContainText("保存资料的归档与目标关联");
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await preview.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "继续使用完整知识空间" })).toContainText("编辑并保存学习资料");
  await expect(preview.getByLabel("资料标题")).toHaveCount(0);
});

test("AI 可用说明仅在状态标签悬浮或聚焦时显示", async ({ page }) => {
  await page.locator(".knowledge-resource-identity").filter({ hasText: "Agent 系统设计.pdf" }).click();
  const preview = page.getByRole("dialog", { name: "Agent 系统设计.pdf 预览" });
  const previewPane = preview.locator(".document-preview-pane");
  const previewSummary = preview.locator(".knowledge-demo-document-preview");
  const previewSpacing = await Promise.all([previewPane.boundingBox(), previewSummary.boundingBox()]);

  expect((previewSpacing[1]?.y ?? 999) - (previewSpacing[0]?.y ?? 0)).toBeLessThanOrEqual(32);
  await expect(preview.locator(".document-identity-title-row")).toContainText("Agent 系统设计.pdf资料预览");
  await expect(previewSummary.getByText("资料预览", { exact: true })).toHaveCount(0);
  await expect(previewSummary.getByRole("heading", { name: "Agent 系统设计" })).toHaveCSS("font-size", "26px");
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
  await page.locator(".knowledge-resource-identity").filter({ hasText: "Agent 系统设计.pdf" }).click();
  const preview = page.getByRole("dialog", { name: "Agent 系统设计.pdf 预览" });
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
  await page.locator(".knowledge-resource-identity").filter({ hasText: "RAG 检索增强生成.md" }).click();
  const preview = page.getByRole("dialog", { name: "RAG 检索增强生成.md 预览" });
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
    goalIds: ["goal-1"],
    kbId: "kb-1",
    kbIds: ["kb-1"],
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
      await route.fulfill({ json: { items: [{ id: "kb-1", name: "个人资料", description: "", goal_id: null, item_count: 1, created_at: "2026-08-14" }] } });
      return;
    }
    if (apiPath === "/api/v1/goals") {
      await route.fulfill({ json: [{ id: "goal-1", type: "skill", title: "学习方法", deadline: "2026-09-01", daily_hours: 1, current_level: "入门", status: "active", created_at: "2026-08-01" }] });
      return;
    }
    if (apiPath === "/api/v1/knowledge/files" && request.method() === "GET") {
      await route.fulfill({ json: { items: [resource] } });
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
  await page.getByRole("button", { name: "编辑或删除文件夹 个人资料" }).click();
  const folderSettings = page.getByRole("dialog", { name: "管理 个人资料" });
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
  await expect(page.getByLabel("移动端资料范围")).toBeVisible();
  await page.getByLabel("移动端资料范围").selectOption("goal:sample-agent-goal");
  await expect(page.locator(".knowledge-resource-context h2")).toHaveText("agent 开发");

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
