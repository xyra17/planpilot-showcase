import { expect, test, type Page } from "@playwright/test";

const guestPiloStorageKey = (key: string) => `planpilot:storage:v1:guest:pilo:${key}`;

async function writeGuestPiloStorage(page: Page, key: string, value: unknown) {
  await page.evaluate(({ legacyKey, scopedKey, nextValue }) => {
    const serialized = typeof nextValue === "string" ? nextValue : JSON.stringify(nextValue);
    window.localStorage.setItem(legacyKey, serialized);
    window.localStorage.setItem(scopedKey, serialized);
  }, { legacyKey: key, scopedKey: guestPiloStorageKey(key), nextValue: value });
}

async function readGuestPiloStorage<T>(page: Page, key: string): Promise<T> {
  return page.evaluate((scopedKey) => JSON.parse(window.localStorage.getItem(scopedKey) ?? "{}") as T, guestPiloStorageKey(key));
}

async function dismissKnowledgeGuestIntro(page: Page) {
  const dialog = page.getByRole("dialog", { name: "访客模式" });
  try {
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByRole("button", { name: "继续浏览" }).click();
  } catch {
    // Authenticated runs do not show the guest contract.
  }
}

test.describe("Pilo v3 state-driven companion workflow", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date());
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      window.sessionStorage.setItem("planpilot:guest-home-intro-seen:v1", "1");
      window.localStorage.setItem("pp-pilo-random-seed-v2", "42");
      if (!window.localStorage.getItem("pp-pilo-preferences-v2")) window.localStorage.setItem("pp-pilo-preferences-v2", JSON.stringify({
        activity: "docked",
        mode: "balanced",
        outfit: "auto",
        outfitDefaultVersion: 2,
        particles: false,
        initiative: "balanced",
        features: {
          proactiveHints: true,
          stretchReminders: true,
          lifestyleStates: true,
          contextAwareness: true,
          adaptiveTiming: true,
          stateExplanations: true,
        },
        quietHours: { enabled: false, start: 22, end: 8 },
        home: { x: 0, y: 0 },
        pausedUntil: 0,
      }));
    });
    await page.goto("/studio/work?piloDebug=1&piloSeed=42");
    await expect(page.locator(".pilo-companion")).toBeVisible();
  });

  test("guest coach asks the user to log in without preview boilerplate", async ({ page }) => {
    await page.goto("/studio/coach?piloSeed=42");
    await page.locator("#companion-composer").fill("我想讨论刚才的观察");
    await page.getByRole("button", { name: "发送给 Pilo" }).click();

    await expect(page.getByText("你还没有登录，请先", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "登录后继续" })).toHaveAttribute("href", "/login?next=%2Fstudio%2Fcoach");
    const loginReply = page.locator(".companion-message.is-assistant").filter({ hasText: "你还没有登录" });
    await expect(loginReply).toContainText("给出更贴合你的建议");
    await expect(loginReply).not.toContainText("对话上下文");
    await expect(loginReply.getByRole("button", { name: "查看依据" })).toHaveCount(0);
    await expect(page.getByText(/科技风 Studio|交互预览|登录后，我会结合你的目标/)).toHaveCount(0);
  });

  test("shows state reason, priority layer and reproducible timeline", async ({ page }) => {
    const pet = page.locator(".pilo-companion__pet");
    await pet.click({ button: "right" });

    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    // The settings dialog is owned by Pilo. Opening it must not be mistaken
    // for an external modal and cause the companion to unmount itself.
    await expect(settings).toBeVisible();
    await expect(page.locator(".pilo-companion")).toBeVisible();
    await page.waitForTimeout(250);
    await expect(settings).toBeVisible();
    await settings.getByRole("tab", { name: "概览" }).click();
    const overviewToggle = settings.getByRole("button", { name: "展开快捷陪伴方案" });
    await expect(overviewToggle).toHaveAttribute("aria-expanded", "false");
    await expect(settings.getByRole("button", { name: "展开今天 Pilo 出现了什么" })).toHaveAttribute("aria-expanded", "false");
    await expect(settings.getByLabel("今天 Pilo 为什么出现")).toHaveCSS("border-top-style", "dashed");
    const quickIcons = settings.locator(".pilo-companion__context-quick > :is(a, button) > svg:first-child");
    await expect(quickIcons).toHaveCount(2);
    await expect(quickIcons.nth(0)).toHaveCSS("color", "rgb(169, 159, 255)");
    await expect(quickIcons.nth(1)).toHaveCSS("color", "rgb(155, 233, 207)");
    await settings.getByRole("tab", { name: "场景" }).click();
    await expect(settings.locator("#pilo-settings-panel-scenes .pilo-companion__appearance-intro").first().locator(":scope > svg")).toHaveCSS("color", "rgb(169, 159, 255)");
    await expect(settings.locator("#pilo-settings-panel-scenes .pilo-companion__collapse-toggle").first()).toHaveCSS("color", "rgb(155, 233, 207)");
    for (const label of ["展开动作预览", "展开场景预览", "展开装扮选项"]) {
      await expect(settings.getByRole("button", { name: label })).toHaveAttribute("aria-expanded", "false");
    }
    await settings.getByRole("tab", { name: "功能" }).click();
    for (const label of ["展开活动与出现", "展开自动陪伴", "展开场景自动化", "展开体验与节奏"]) {
      await expect(settings.getByRole("button", { name: label })).toHaveAttribute("aria-expanded", "false");
    }
    for (const description of ["控制 Pilo 在页面中的存在感", "决定 Pilo 何时主动响应", "按时间与真实进度轻声出现", "调整视觉反馈和个性化程度"]) {
      await expect(settings.getByText(description, { exact: true })).toBeVisible();
    }
    await settings.getByRole("tab", { name: "概览" }).click();
    const focusToggle = settings.getByRole("button", { name: /专注计时/ });
    await expect(focusToggle).toHaveAttribute("aria-expanded", "false");
    await focusToggle.click();
    const focusTimer = settings.getByRole("region", { name: "专注计时器" });
    await expect(focusTimer).toBeVisible();
    await expect(focusTimer.locator(".pilo-companion__focus-clock")).toHaveCount(0);
    await focusTimer.getByRole("radio", { name: "15 分钟" }).click();
    await expect(focusTimer.getByRole("button", { name: "开始 15 分钟专注" })).toBeVisible();
    await focusTimer.getByRole("button", { name: "开始 15 分钟专注" }).click();
    await expect(focusTimer).toContainText("15:00");
    await expect(page.locator(".pilo-companion")).toHaveAttribute("data-pilo-state", "working");
    await focusTimer.getByRole("button", { name: "暂停" }).click();
    await expect(focusTimer).toContainText("已暂停");
    await focusTimer.getByRole("button", { name: "继续" }).click();
    await focusTimer.getByRole("button", { name: "结束本轮" }).click();
    await expect(focusTimer.locator(".pilo-companion__focus-clock")).toHaveCount(0);
    await overviewToggle.click();
    const reasonToggle = settings.getByRole("button", { name: /状态说明/ });
    await expect(reasonToggle).toBeVisible();
    await expect(reasonToggle).toHaveAttribute("aria-expanded", "false");
    await reasonToggle.click();
    await expect(reasonToggle).toHaveAttribute("aria-expanded", "true");
    await expect(settings.locator(".pilo-companion__version-reason")).toContainText("你正在调整陪伴方式");
    await expect(settings.getByLabel("当前设置摘要")).toContainText("快捷陪伴方案");
    const learningCompanionMode = settings.getByRole("radio", { name: /学习伙伴/ });
    if (await learningCompanionMode.getAttribute("aria-checked") !== "true") await learningCompanionMode.click();
    await expect(learningCompanionMode).toHaveAttribute("aria-checked", "true");
    await expect(settings.locator(".pilo-companion__version-flow")).toHaveScreenshot("pilo-state-reason.png", { animations: "disabled", maxDiffPixelRatio: .035 });
    await settings.getByRole("tab", { name: "功能" }).click();
    const timelineToggle = settings.getByRole("button", { name: /状态时间线/ });
    await expect(timelineToggle).toHaveAttribute("aria-expanded", "false");
    await timelineToggle.click();
    await expect(timelineToggle).toHaveAttribute("aria-expanded", "true");
    await expect(settings.getByTestId("pilo-debug-timeline")).toBeVisible();
    const debugTimelineStyle = await timelineToggle.evaluate((element) => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, paddingLeft: style.paddingLeft, fontSize: getComputedStyle(element.querySelector("strong")!).fontSize };
    });
    await settings.getByRole("tab", { name: "概览" }).click();
    const todayTimelineToggle = settings.getByRole("button", { name: /今天 Pilo 出现了什么/ });
    const todayTimelineStyle = await todayTimelineToggle.evaluate((element) => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, paddingLeft: style.paddingLeft, fontSize: getComputedStyle(element.querySelector("strong")!).fontSize };
    });
    expect(todayTimelineStyle).toEqual(debugTimelineStyle);
    await expect(todayTimelineToggle.locator("svg")).toHaveCount(1);
    await settings.getByRole("tab", { name: "功能" }).click();
    await expect(timelineToggle.locator("svg")).toHaveCount(1);
    await expect(settings.getByTestId("pilo-debug-timeline")).toContainText("收到状态请求");
    await expect(settings.getByTestId("pilo-debug-timeline")).not.toContainText(/requested|activated|resumed|interrupted|released|expired|cooled-down/);
    await expect(page.locator(".pilo-companion")).toHaveAttribute("data-pilo-seed", "42");

    await settings.getByTestId("pilo-debug-checking").click();
    await expect(page.locator(".pilo-companion")).toHaveAttribute("data-pilo-state", "checking");
    await expect(pet.locator(".pilo-avatar")).toHaveAttribute("data-pilo-atlas-state", "idle");
    await settings.getByRole("tab", { name: "概览" }).click();
    const updatedReasonToggle = settings.getByRole("button", { name: /状态说明/ });
    if (await updatedReasonToggle.getAttribute("aria-expanded") === "false") await updatedReasonToggle.click();
    await expect(settings.locator(".pilo-companion__version-reason")).toContainText("Pilo 正在检查结果");
    await expect(settings.locator(".pilo-companion__version-reason")).toContainText("你正在调整陪伴方式");
    await expect(settings).toHaveScreenshot("pilo-explainable-checking.png", { animations: "disabled", maxDiffPixelRatio: .012 });
  });

  test("keeps suggestion initiative, scene frequency and state explanations independent", async ({ page }) => {
    const pet = page.locator(".pilo-companion__pet");
    await pet.click({ button: "right" });
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });

    await settings.getByRole("tab", { name: "功能" }).click();
    await settings.getByRole("button", { name: "展开活动与出现" }).click();
    const suggestions = settings.getByRole("radiogroup", { name: "选择 Pilo 建议主动程度" });
    await suggestions.getByRole("radio", { name: "安静观察" }).click();

    await settings.getByRole("button", { name: "展开场景自动化" }).click();
    const scenes = settings.getByRole("radiogroup", { name: "选择 Pilo 主动场景频率" });
    await expect(scenes.getByRole("radio", { name: /多次出现/ })).toHaveAttribute("aria-checked", "true");
    await scenes.getByRole("radio", { name: /适时出现/ }).click();
    await expect(suggestions.getByRole("radio", { name: "安静观察" })).toHaveAttribute("aria-checked", "true");

    await settings.getByRole("button", { name: "展开体验与节奏" }).press("Enter");
    const explanations = settings.getByRole("switch", { name: /判断依据/ });
    await explanations.click();
    await settings.getByRole("tab", { name: "概览" }).click();
    await settings.getByRole("button", { name: "展开快捷陪伴方案" }).click();
    await expect(settings.getByRole("button", { name: "状态说明" })).toHaveCount(0);

    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("pp-pilo-preferences-v2") ?? "{}"));
    expect(stored).toMatchObject({ suggestionInitiative: "quiet", sceneFrequency: "balanced" });
    expect(stored).not.toHaveProperty("initiative");

    await settings.getByRole("button", { name: "关闭 Pilo 设置" }).click();
    await pet.click();
    await expect(page.getByRole("dialog", { name: "Pilo 快捷陪伴" }).getByRole("button", { name: "为什么 Pilo 现在这样？" })).toHaveCount(0);
  });

  test("uses docked companionship as the durable default without overriding a later manual choice", async ({ page }) => {
    const legacyActivity = await readGuestPiloStorage<Record<string, unknown>>(page, "pp-pilo-preferences-v2");
    delete legacyActivity.activityDefaultVersion;
    await writeGuestPiloStorage(page, "pp-pilo-preferences-v2", { ...legacyActivity, activity: "active", mode: "coach" });
    await page.reload();

    let stored = await readGuestPiloStorage<Record<string, unknown>>(page, "pp-pilo-preferences-v2");
    expect(stored).toMatchObject({ activity: "docked", activityDefaultVersion: 1, mode: "custom" });

    const pet = page.locator(".pilo-companion__pet");
    await pet.click({ button: "right" });
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await settings.getByRole("tab", { name: "功能" }).click();
    await settings.getByRole("button", { name: "展开活动与出现" }).click();
    await settings.getByRole("radio", { name: "自由漫游" }).click();
    await settings.getByRole("button", { name: "关闭 Pilo 设置" }).click();
    await page.reload();

    stored = await readGuestPiloStorage<Record<string, unknown>>(page, "pp-pilo-preferences-v2");
    expect(stored).toMatchObject({ activity: "active", activityDefaultVersion: 1, mode: "custom" });
  });

  test("finishes a persisted focus session while the settings panel is closed", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const now = await page.evaluate(() => Date.now());
    await writeGuestPiloStorage(page, "pp-pilo-focus-session-v1", {
      durationMinutes: 15,
      remainingSeconds: 1,
      endsAt: now + 1_000,
      status: "running",
      completionNotified: false,
    });
    await page.reload();
    await page.clock.setFixedTime(new Date(now + 1_500));
    await page.waitForTimeout(1_200);

    await expect(page.locator(".pilo-companion")).toHaveAttribute("data-pilo-state", "success");
    await expect(page.locator(".pilo-companion__hint")).toContainText("完成了 15 分钟专注");
    await expect(page.locator(".pilo-companion__hint-source")).toContainText("Pilo 回应");
    await expect(page.locator(".pilo-companion__particles")).toBeVisible();

    await page.locator(".pilo-companion__pet").click({ button: "right" });
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await settings.getByRole("button", { name: "展开今天 Pilo 出现了什么" }).click();
    await expect(settings.getByText("完成一轮专注", { exact: true })).toBeVisible();
    await expect(settings.getByLabel("今天 Pilo 为什么出现")).toContainText("状态回应");
  });

  test("uses learning events instead of a fixed route timer for proactive suggestions", async ({ page }) => {
    await page.goto("/studio/work/notes?piloSeed=42");
    await page.clock.setFixedTime(new Date(Date.now() + 3_000));
    await page.waitForTimeout(1_100);

    const hint = page.locator(".pilo-companion__hint");
    await expect(hint).toContainText(/在笔记里/);
    await hint.locator(".pilo-companion__hint-main").click();
    const panel = page.getByRole("dialog", { name: "Pilo 快捷陪伴" });
    await expect(panel).toContainText(/把.*笔记|刚写下的内容/);
    await panel.getByRole("button", { name: "收起 Pilo" }).click();

    await page.evaluate(() => {
      const detail = { kind: "editing", surface: "notes", objectId: "test-note", objectTitle: "状态转移复盘" };
      window.dispatchEvent(new CustomEvent("planpilot:pilo-context", { detail }));
      window.dispatchEvent(new CustomEvent("planpilot:pilo-context", { detail }));
      window.dispatchEvent(new CustomEvent("planpilot:pilo-context", { detail }));
    });
    await page.clock.setFixedTime(new Date(Date.now() + 20_000));
    await page.waitForTimeout(1_100);

    await expect(hint).toContainText("刚补了不少内容");
    await expect(hint).toContainText("整理成 3 个要点");
    await hint.locator(".pilo-companion__hint-main").click();
    await expect(panel.locator(".pilo-companion__suggestion")).toContainText("刚完成一轮编辑");
    await expect(panel.getByRole("button", { name: "稍后提醒" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "少提醒这类" })).toBeVisible();

    const suggestionLink = panel.getByRole("link", { name: /整理成 3 个要点/ });
    const suggestionUrl = new URL(await suggestionLink.getAttribute("href") ?? "", "http://planpilot.local");
    expect(suggestionUrl.searchParams.get("surface")).toBe("notes");
    expect(suggestionUrl.searchParams.get("objectId")).toBe("test-note");
    expect(suggestionUrl.searchParams.get("suggestionId")).toContain("notes-organize");
    expect(suggestionUrl.searchParams.get("returnTo")).toBe("/studio/work/notes?piloSeed=42");
    expect(suggestionUrl.searchParams.get("reason")).toContain("刚完成一轮编辑");
    expect(suggestionUrl.searchParams.get("entryMode")).toBe("observation");
    expect(suggestionUrl.searchParams.get("observationTitle")).toContain("3 个复习要点");

    await suggestionLink.click();
    await expect(page).toHaveURL(/\/studio\/coach\?/);
    const source = page.getByRole("region", { name: "这次对话的页面来源" });
    await expect(source).toContainText("来自：学习笔记");
    await expect(source).toContainText("状态转移复盘");
    await expect(source).toContainText("整理成 3 个要点");
    await expect(source.getByRole("link", { name: "返回学习笔记" })).toHaveAttribute("href", "/studio/work/notes?piloSeed=42");
    const relevantObservation = page.getByRole("region", { name: "Pilo 的学习观察" });
    await expect(relevantObservation).toContainText("3 个复习要点");
    await expect(relevantObservation).toContainText("相关性：与本轮入口直接相关");
    await expect(page.locator("#companion-composer")).toHaveValue(/状态转移复盘/);
  });

  test("keeps object context separate from relevant learning observations", async ({ page }) => {
    await page.goto("/studio/coach?surface=knowledge&actionLabel=%E6%A3%80%E6%9F%A5%E5%8F%AF%E7%94%A8%E8%B5%84%E6%96%99&entryMode=object&goalScope=unlinked&returnTo=%2Fstudio%2Fwork%2Fknowledge");
    let source = page.getByRole("region", { name: "这次对话的页面来源" });
    await expect(source).toContainText("未关联学习目标 · 本轮保持不限目标");
    await expect(page.getByRole("region", { name: "Pilo 的学习观察" })).toHaveCount(0);

    await page.goto("/studio/coach?surface=notes&objectTitle=%E7%8A%B6%E6%80%81%E8%BD%AC%E7%A7%BB%E5%A4%8D%E7%9B%98&actionLabel=%E6%95%B4%E7%90%86%E5%BD%93%E5%89%8D%E7%AC%94%E8%AE%B0&entryMode=object&goalScope=linked&goalIds=guest-skill");
    source = page.getByRole("region", { name: "这次对话的页面来源" });
    await expect(source).toContainText("关联目标：掌握 Python 数据分析 · 已作为本轮聚焦");
    await expect(page.getByRole("button", { name: /本轮聚焦：掌握 Python 数据分析/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Pilo 的学习观察" })).toHaveCount(0);

    await page.goto("/studio/coach?surface=review&actionLabel=%E8%A7%A3%E9%87%8A%E4%B8%80%E6%9D%A1%E5%88%A4%E6%96%AD&entryMode=observation&observationTitle=%E4%BD%A0%E5%9C%A8%E6%99%9A%E9%97%B4%E6%9B%B4%E5%AE%B9%E6%98%93%E5%AE%8C%E6%88%90%E9%AB%98%E8%AE%A4%E7%9F%A5%E4%BB%BB%E5%8A%A1&reason=%E8%BF%99%E4%B8%8E%E6%9C%AC%E8%BD%AE%E6%A0%A1%E6%AD%A3%E7%9A%84%E5%AD%A6%E4%B9%A0%E5%88%A4%E6%96%AD%E7%9B%B4%E6%8E%A5%E7%9B%B8%E5%85%B3");
    const observation = page.getByRole("region", { name: "Pilo 的学习观察" });
    await expect(observation).toContainText("你在晚间更容易完成高认知任务");
    await expect(observation).toContainText("这与本轮校正的学习判断直接相关");
    await expect(observation).toContainText("相关性：与本轮入口直接相关");
  });

  test("pins the Pilo hint close action to the top-right corner", async ({ page }, testInfo) => {
    await page.goto("/studio/work/notes?piloSeed=42");
    await page.clock.setFixedTime(new Date(Date.now() + 3_000));
    await page.waitForTimeout(1_100);

    const hint = page.locator(".pilo-companion__hint");
    await expect(hint).toContainText(/在笔记里/);
    const dismissHint = hint.getByRole("button", { name: "关闭这条 Pilo 提示" });
    await expect(dismissHint).toBeVisible();
    await expect(dismissHint).toHaveCSS("position", "absolute");
    await expect(dismissHint).toHaveCSS("top", "3px");
    await expect(dismissHint).toHaveCSS("right", "3px");
    const persistentHighlight = await dismissHint.evaluate((button) => {
      const highlight = getComputedStyle(button, "::before");
      return { width: highlight.width, height: highlight.height, backgroundColor: highlight.backgroundColor };
    });
    expect(persistentHighlight).toEqual({ width: "30px", height: "30px", backgroundColor: "rgba(139, 122, 246, 0.25)" });

    const assertTopRight = async () => {
      const hintBounds = await hint.boundingBox();
      const dismissBounds = await dismissHint.boundingBox();
      expect(dismissBounds?.width).toBe(44);
      expect(dismissBounds?.height).toBe(44);
      expect((hintBounds?.x ?? 0) + (hintBounds?.width ?? 0) - (dismissBounds?.x ?? 0) - (dismissBounds?.width ?? 0)).toBeLessThanOrEqual(16);
      expect((dismissBounds?.y ?? 0) - (hintBounds?.y ?? 0)).toBeLessThanOrEqual(16);
    };

    await assertTopRight();
    await testInfo.attach("pilo-hint-desktop", { body: await hint.screenshot({ animations: "disabled" }), contentType: "image/png" });
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(350);
    await assertTopRight();
  });

  test("anchors the quick panel to Pilo after moving between viewport corners", async ({ page }) => {
    const assertAnchored = async (placement: "above-right" | "below-left") => {
      const pet = page.locator(".pilo-companion__pet");
      await pet.click();
      const panel = page.getByRole("dialog", { name: "Pilo 快捷陪伴" });
      await expect(panel).toBeVisible();
      const geometry = await page.evaluate(() => {
        const petRect = document.querySelector<HTMLElement>(".pilo-companion__pet")!.getBoundingClientRect();
        const panelRect = document.querySelector<HTMLElement>(".pilo-companion__panel")!.getBoundingClientRect();
        return {
          pet: { top: petRect.top, right: petRect.right, bottom: petRect.bottom, left: petRect.left },
          panel: { top: panelRect.top, right: panelRect.right, bottom: panelRect.bottom, left: panelRect.left },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      });
      expect(geometry.panel.left).toBeGreaterThanOrEqual(12);
      expect(geometry.panel.top).toBeGreaterThanOrEqual(12);
      expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewport.width - 12);
      expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height - 12);
      if (placement === "above-right") {
        expect(geometry.pet.top - geometry.panel.bottom).toBeCloseTo(12, 0);
        expect(geometry.pet.right - geometry.panel.right).toBeCloseTo(0, 0);
      } else {
        expect(geometry.panel.top - geometry.pet.bottom).toBeCloseTo(12, 0);
        expect(geometry.panel.left - geometry.pet.left).toBeCloseTo(0, 0);
      }
      await panel.getByRole("button", { name: "收起 Pilo" }).click();
    };

    await assertAnchored("above-right");
    const movedPreferences = await readGuestPiloStorage<Record<string, unknown>>(page, "pp-pilo-preferences-v2");
    const movedHome = await page.evaluate(() => ({ x: Math.min(0, -window.innerWidth + 162), y: Math.min(0, -window.innerHeight + 196) }));
    await writeGuestPiloStorage(page, "pp-pilo-preferences-v2", { ...movedPreferences, home: movedHome });
    await page.reload();
    await expect(page.locator(".pilo-companion")).toBeVisible();
    await assertAnchored("below-left");
  });

  test("changes persistent actions with the page and keeps settings user-initiated", async ({ page }) => {
    const pet = page.locator(".pilo-companion__pet");
    await pet.click();
    let panel = page.getByRole("dialog", { name: "Pilo 快捷陪伴" });
    await expect(panel.getByRole("link", { name: "从今天任务里选一项" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "预览剩余时间调整" })).toBeVisible();

    const todayLink = panel.getByRole("link", { name: "从今天任务里选一项" });
    const todayUrl = new URL(await todayLink.getAttribute("href") ?? "", "http://planpilot.local");
    expect(todayUrl.searchParams.get("intent")).toBe("pick-next-task");
    expect(todayUrl.searchParams.get("surface")).toBe("today");
    expect(todayUrl.searchParams.get("returnTo")).toBe("/studio/work?piloDebug=1&piloSeed=42");
    await panel.getByRole("button", { name: "收起 Pilo" }).click();

    await page.goto("/studio/work/knowledge?piloSeed=42");
    await dismissKnowledgeGuestIntro(page);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-context", {
      detail: { kind: "object-opened", surface: "knowledge", objectId: "resource-7", objectTitle: "间隔复习研究" },
    })));
    await pet.click();
    panel = page.getByRole("dialog", { name: "Pilo 快捷陪伴" });
    await expect(panel.getByRole("link", { name: "提炼当前资料" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "生成复习问题" })).toBeVisible();
    const resourceUrl = new URL(await panel.getByRole("link", { name: "提炼当前资料" }).getAttribute("href") ?? "", "http://planpilot.local");
    expect(resourceUrl.searchParams.get("objectTitle")).toBe("间隔复习研究");
    expect(resourceUrl.searchParams.get("objectId")).toBe("resource-7");

    await page.goto("/studio/settings?piloSeed=42");
    await page.clock.setFixedTime(new Date(Date.now() + 20_000));
    await page.waitForTimeout(1_100);
    await expect(page.locator(".pilo-companion__hint")).toHaveCount(0);
    await pet.click();
    panel = page.getByRole("dialog", { name: "Pilo 快捷陪伴" });
    await expect(panel.getByRole("link", { name: "检查规划条件" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "解释数据与记忆" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "从今天任务里选一项" })).toHaveCount(0);
  });

  test("keeps a stable personality hierarchy and explains the current body language", async ({ page }) => {
    const companion = page.locator(".pilo-companion");
    const pet = page.locator(".pilo-companion__pet");

    await pet.click();
    const panel = page.getByRole("dialog", { name: "Pilo 快捷陪伴" });
    const reasonToggle = panel.getByRole("button", { name: "为什么 Pilo 现在这样？" });
    await expect(reasonToggle).toHaveAttribute("aria-expanded", "false");
    await reasonToggle.click();
    await expect(reasonToggle).toHaveAttribute("aria-expanded", "true");
    await expect(panel.locator("#pilo-panel-state-reason")).toContainText("用户交互");
    await expect(panel.locator("#pilo-panel-state-reason")).toContainText("打开了 Pilo 对话入口");
    await panel.getByRole("button", { name: "收起 Pilo" }).click();

    await pet.click({ button: "right" });
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await settings.getByRole("tab", { name: "概览" }).click();
    await settings.getByRole("button", { name: "展开快捷陪伴方案" }).click();
    for (const mode of ["学习伙伴", "原地陪伴"]) {
      await expect(settings.getByRole("radio", { name: new RegExp(mode) })).toBeVisible();
    }
    await expect(settings.getByRole("radio", { name: /日常陪伴|共同专注|完全停靠/ })).toHaveCount(0);
    await settings.getByRole("button", { name: "关闭 Pilo 设置" }).click();

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
      detail: { state: "working", layer: "agent", source: "agent:personality-test", reason: "正在继续当前对话", duration: 30_000 },
    })));
    await expect(companion).toHaveAttribute("data-pilo-state", "working");

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
      detail: { state: "failure", source: "system:personality-test", reason: "当前操作遇到阻碍", duration: 700 },
    })));
    await expect(companion).toHaveAttribute("data-pilo-layer", "system");
    await expect(companion).toHaveAttribute("data-pilo-state", "failure");
    const personalityClock = await page.evaluate(() => Date.now());
    await page.clock.setFixedTime(new Date(personalityClock + 1_000));
    await page.waitForTimeout(900);
    // Ordinary state transitions stay in a stable pose; only supplemental
    // life-action sequences render dedicated leaving frames.
    await expect(companion).toHaveAttribute("data-pilo-phase", "holding");
    await page.clock.setFixedTime(new Date(personalityClock + 4_000));
    await page.waitForTimeout(2_000);
    await expect(companion).toHaveAttribute("data-pilo-state", "working");
  });

  test("speaks when navigation enters knowledge, goals and notes despite stale intro cooldowns", async ({ page }) => {
    await page.evaluate(() => {
      const blockedUntil = new Date("2030-01-01T00:00:00+08:00").getTime();
      const blocked = { shown: 4, accepted: 0, ignored: 2, dismissed: 0, snoozed: 0, lastShownAt: blockedUntil - 1_000, nextEligibleAt: blockedUntil };
      window.localStorage.setItem("pp-pilo-learned-preferences-v2", JSON.stringify({
        opened: 0,
        ignored: 0,
        reminderAffinity: 0,
        lastInteractionAt: null,
        suggestions: {
          "intro-knowledge": blocked,
          "intro-goals": blocked,
          "intro-notes": blocked,
        },
      }));
    });
    await page.reload();

    const navigation = page.getByRole("navigation", { name: "产品导航" });
    const hint = page.locator(".pilo-companion__hint");
    const pet = page.locator(".pilo-companion__pet");
    const companion = page.locator(".pilo-companion");
    const stateBeforeNavigation = await companion.getAttribute("data-pilo-state");

    await navigation.getByRole("link", { name: "知识空间", exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/work\/knowledge/);
    const knowledgeGuestIntro = page.getByRole("dialog", { name: "访客模式" });
    if (await knowledgeGuestIntro.isVisible()) {
      await knowledgeGuestIntro.getByRole("button", { name: "继续浏览" }).click();
    }
    await expect(companion).toHaveAttribute("data-pilo-state", stateBeforeNavigation ?? "idle");
    await page.waitForTimeout(300);
    await page.clock.setFixedTime(new Date(Date.now() + 3_000));
    await page.waitForTimeout(1_100);
    await expect(hint).toContainText("在知识空间里");
    await pet.hover();
    await expect(hint).toBeVisible();

    await navigation.getByRole("link", { name: "目标管理", exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/work\/goals/);
    await expect(companion).toHaveAttribute("data-pilo-state", stateBeforeNavigation ?? "idle");
    await page.waitForTimeout(300);
    await page.clock.setFixedTime(new Date(Date.now() + 7_000));
    await page.waitForTimeout(1_100);
    await expect(hint).toContainText("在目标里");

    await navigation.getByRole("link", { name: "学习笔记", exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/work\/notes/);
    await expect(companion).toHaveAttribute("data-pilo-state", stateBeforeNavigation ?? "idle");
    await page.waitForTimeout(300);
    await page.clock.setFixedTime(new Date(Date.now() + 11_000));
    await page.waitForTimeout(1_100);
    await expect(hint).toContainText("在笔记里");
  });

  test("keeps the current action across page navigation and never scales the body during pose swaps", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.reload();
    const companion = page.locator(".pilo-companion");
    const pet = page.locator(".pilo-companion__pet");

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
        detail: {
          state: "waiting",
          layer: "agent",
          source: "agent:navigation-stability",
          reason: "等待用户确认",
          duration: 30_000,
        },
      }));
    });
    await expect(companion).toHaveAttribute("data-pilo-state", "waiting");
    await page.getByRole("navigation", { name: "产品导航" }).getByRole("link", { name: "知识空间", exact: true }).click();
    await dismissKnowledgeGuestIntro(page);
    await expect(companion).toHaveAttribute("data-pilo-state", "waiting");

    for (const state of ["thinking", "resting", "idle"] as const) {
      const samples = page.evaluate(async () => {
        const result: Array<{ width: number; height: number; scaleX: number; scaleY: number; poseCount: number }> = [];
        for (let frame = 0; frame < 18; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const body = document.querySelector<HTMLElement>(".pilo-companion__pet .pilo-avatar__body");
          const avatar = document.querySelector<HTMLElement>(".pilo-companion__pet .pilo-avatar");
          if (!body || !avatar) continue;
          const bounds = avatar.getBoundingClientRect();
          const transform = getComputedStyle(body).transform;
          const matrix = transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
          result.push({
            width: bounds.width,
            height: bounds.height,
            scaleX: Math.hypot(matrix.a, matrix.b),
            scaleY: Math.hypot(matrix.c, matrix.d),
            poseCount: avatar.querySelectorAll(".pilo-avatar__pose").length,
          });
        }
        return result;
      });
      await page.evaluate((nextState) => {
        window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
          detail: {
            state: nextState,
            layer: "interaction",
            source: "test:stable-pose-swap",
            reason: `稳定切换：${nextState}`,
            duration: 4_000,
          },
        }));
      }, state);
      await expect(companion).toHaveAttribute("data-pilo-state", state);
      const transitionSamples = await samples;
      expect(transitionSamples.length).toBeGreaterThan(0);
      expect(Math.max(...transitionSamples.map((sample) => sample.width)) - Math.min(...transitionSamples.map((sample) => sample.width))).toBeLessThan(.1);
      expect(Math.max(...transitionSamples.map((sample) => sample.height)) - Math.min(...transitionSamples.map((sample) => sample.height))).toBeLessThan(.1);
      expect(Math.max(...transitionSamples.map((sample) => Math.abs(sample.scaleX - 1)))).toBeLessThan(.001);
      expect(Math.max(...transitionSamples.map((sample) => Math.abs(sample.scaleY - 1)))).toBeLessThan(.001);
      expect(Math.max(...transitionSamples.map((sample) => sample.poseCount))).toBeLessThanOrEqual(1);
    }

    await expect(pet.locator(".pilo-avatar")).toHaveAttribute("data-pilo-visual-scale", "1");
  });

  test("uses complete rendered assets and keeps exercise jump out of page navigation", async ({ page }) => {
    const adaptiveOutfit = await readGuestPiloStorage<Record<string, unknown>>(page, "pp-pilo-preferences-v2");
    await writeGuestPiloStorage(page, "pp-pilo-preferences-v2", { ...adaptiveOutfit, outfit: "auto", outfits: [], outfitDefaultVersion: 3 });
    await page.evaluate(() => window.dispatchEvent(new Event("planpilot:pilo-appearance-changed")));
    const pet = page.locator(".pilo-companion__pet");
    await pet.click({ button: "right" });
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await settings.getByRole("tab", { name: "功能" }).click();
    await settings.getByRole("button", { name: /状态时间线/ }).click();

    await settings.getByTestId("pilo-debug-reading").click();
    await expect(page.locator(".pilo-companion")).toHaveAttribute("data-pilo-state", "reading");
    await expect(pet.locator(".pilo-avatar")).toHaveAttribute("data-pilo-accessory", /glasses/);
    await expect(pet.locator(".pilo-avatar")).toHaveAttribute("data-pilo-asset-coverage", "ready");

    await page.goto("/studio/work/notes?piloDebug=1&piloSeed=42");
    await expect(page.locator(".pilo-companion")).not.toHaveAttribute("data-pilo-state", "stretching");

    await pet.click({ button: "right" });
    const reopenedSettings = page.getByRole("dialog", { name: "Pilo 设置" });
    await reopenedSettings.getByRole("tab", { name: "功能" }).click();
    await reopenedSettings.getByRole("button", { name: /状态时间线/ }).click();
    await reopenedSettings.getByTestId("pilo-debug-stretching").click();
    await expect(page.locator(".pilo-companion")).toHaveAttribute("data-pilo-state", "stretching");
    await expect(pet.locator(".pilo-avatar")).toHaveAttribute("data-pilo-accessory", /headband/);
    await reopenedSettings.getByRole("button", { name: "关闭 Pilo 设置" }).click();
    await expect(reopenedSettings).toBeHidden();
    await expect(pet).toHaveScreenshot("pilo-exercise-reminder.png", {
      animations: "disabled",
      maxDiffPixels: 150,
    });
  });

  test("arbitrates interaction above agent and feedback without losing queued state", async ({ page }) => {
    const companion = page.locator(".pilo-companion");
    const pet = page.locator(".pilo-companion__pet");
    const emit = (detail: Record<string, unknown>) => page.evaluate((payload) => {
      window.dispatchEvent(new CustomEvent("planpilot:pilo-state", { detail: payload }));
    }, detail);

    await emit({ state: "working", layer: "agent", source: "agent:test", reason: "执行测试工具", duration: 30_000 });
    await expect(companion).toHaveAttribute("data-pilo-state", "working");
    await emit({ state: "success", layer: "feedback", source: "feedback:other", reason: "另一个结果", duration: 30_000 });
    await expect(companion).toHaveAttribute("data-pilo-state", "working");

    await pet.hover();
    await expect(companion).toHaveAttribute("data-pilo-state", "working");
    await page.mouse.move(500, 300);
    await expect(companion).toHaveAttribute("data-pilo-state", "working");

    await emit({ state: "idle", layer: "agent", source: "agent:test", clear: true });
    await expect(companion).toHaveAttribute("data-pilo-state", "success");
  });

  test("keeps the explainable settings inside a small safe viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();
    const pet = page.locator(".pilo-companion__pet");
    await pet.click({ button: "right" });
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await expect(settings).toBeVisible();
    const bounds = await settings.boundingBox();
    expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(bounds?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(667);
    await expect(settings.getByRole("button", { name: "关闭 Pilo 设置" })).toHaveCSS("width", "44px");
    await settings.getByRole("tab", { name: "概览" }).click();
    await settings.getByRole("button", { name: /专注计时/ }).click();
    const durationOptions = settings.getByRole("radiogroup", { name: "选择专注时长" });
    const durationBounds = await durationOptions.boundingBox();
    expect(durationBounds?.x ?? -1).toBeGreaterThanOrEqual(bounds?.x ?? 0);
    expect((durationBounds?.x ?? 0) + (durationBounds?.width ?? 0)).toBeLessThanOrEqual((bounds?.x ?? 0) + (bounds?.width ?? 0));
    await expect(settings.locator(".pilo-companion__focus-clock")).toHaveCount(0);

    await page.setViewportSize({ width: 667, height: 375 });
    await expect(settings).toHaveCSS("max-height", "355px");
    const landscapeBounds = await settings.boundingBox();
    expect(landscapeBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(landscapeBounds?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((landscapeBounds?.x ?? 0) + (landscapeBounds?.width ?? 0)).toBeLessThanOrEqual(667);
    expect((landscapeBounds?.y ?? 0) + (landscapeBounds?.height ?? 0)).toBeLessThanOrEqual(375);
  });

  test("offers labelled scene, appearance and function controls from click and context menu", async ({ page }) => {
    const companion = page.locator(".pilo-companion");
    const pet = page.locator(".pilo-companion__pet");
    const positionBeforeOpen = await pet.boundingBox();
    const clickContinuity = page.evaluate(async () => {
      const samples: Array<{ petY: number; visualHeight: number }> = [];
      for (let frame = 0; frame < 32; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const petElement = document.querySelector<HTMLElement>(".pilo-companion__pet");
        const visual = document.querySelector<HTMLElement>(".pilo-avatar__pose > :is(img, .pilo-avatar__sprite)");
        if (petElement && visual) {
          samples.push({ petY: petElement.getBoundingClientRect().y, visualHeight: visual.getBoundingClientRect().height });
        }
      }
      return samples;
    });
    await pet.click();
    const clickSamples = await clickContinuity;
    expect(Math.max(...clickSamples.map((sample) => sample.petY)) - Math.min(...clickSamples.map((sample) => sample.petY))).toBeLessThan(.5);
    expect(Math.min(...clickSamples.map((sample) => sample.visualHeight))).toBeGreaterThan(100);
    const conversationPanel = page.locator(".pilo-companion__panel");
    await expect(conversationPanel.getByRole("button", { name: "装扮与功能" })).toHaveCount(0);
    await expect(conversationPanel.getByText("安静陪我一会儿")).toHaveCount(0);
    await expect(conversationPanel.locator(".pilo-companion__state-summary")).toHaveCount(0);
    await expect(companion).toHaveAttribute("data-pilo-state", "listening");
    await expect(pet.locator(".pilo-avatar")).toHaveAttribute("data-pilo-atlas-state", "supplemental");
    await expect(pet.locator(".pilo-avatar__body img")).toHaveCount(1);
    await expect(pet.locator(".pilo-avatar")).toHaveClass(/is-illuminated/);
    await page.waitForTimeout(1_300);
    const positionAfterOpen = await pet.boundingBox();
    expect(positionAfterOpen?.x).toBeCloseTo(positionBeforeOpen?.x ?? 0, 1);
    expect(positionAfterOpen?.y).toBeCloseTo(positionBeforeOpen?.y ?? 0, 1);
    await pet.click({ button: "right" });

    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await settings.getByRole("tab", { name: "场景", exact: true }).click();
    await expect(settings.getByRole("tab", { name: "场景", exact: true })).toHaveAttribute("aria-selected", "true");
    await settings.getByRole("button", { name: "展开动作预览" }).click();
    await expect(settings.getByText("动作预览")).toBeVisible();
    const lifeActionTabs = settings.getByRole("tablist", { name: "选择动作类型" });
    await expect(lifeActionTabs.getByRole("tab")).toHaveCount(2);
    await expect(lifeActionTabs.getByRole("tab", { name: "基础动作" })).toHaveAttribute("aria-selected", "true");
    const lifeActions = settings.getByRole("tabpanel", { name: "基础动作" });
    await expect(lifeActions.getByRole("button")).toHaveCount(8);
    for (const label of ["坐下休息", "慢慢走动", "捧星等待", "安慰自己", "回应完成", "短暂打盹", "松一口气", "收工告别"]) {
      await expect(lifeActions.getByRole("button", { name: `预览${label}动作` })).toBeVisible();
    }
    await lifeActionTabs.getByRole("tab", { name: "道具动作" }).click();
    await expect(lifeActionTabs.getByRole("tab", { name: "道具动作" })).toHaveAttribute("aria-selected", "true");
    const propLifeActions = settings.getByRole("tabpanel", { name: "道具动作" });
    await expect(propLifeActions.getByRole("button")).toHaveCount(8);
    for (const label of ["安静阅读", "敲电脑", "伸展活动", "茶歇", "记录灵感", "查看计时器", "整理桌面", "照顾小芽"]) {
      await expect(propLifeActions.getByRole("button", { name: `预览${label}动作` })).toBeVisible();
    }
    await propLifeActions.getByRole("button", { name: "预览茶歇动作" }).click();
    await expect(settings).toHaveCount(0);
    await expect(companion).toHaveAttribute("data-pilo-life-action", "tea-break");
    await pet.click({ button: "right" });
    await settings.getByRole("tab", { name: "场景", exact: true }).click();
    await settings.getByRole("button", { name: "展开装扮选项" }).press("Enter");
    const outfitChoices = settings.getByRole("group", { name: "选择 Pilo 装扮" });
    await expect(outfitChoices.getByRole("button")).toHaveCount(9);
    const outfitCollapse = settings.getByRole("button", { name: "收起装扮选项" });
    await expect(outfitCollapse).toHaveAttribute("aria-expanded", "true");
    await outfitCollapse.click();
    await expect(settings.getByRole("group", { name: "选择 Pilo 装扮" })).toHaveCount(0);
    await settings.getByRole("button", { name: "展开装扮选项" }).press("Enter");
    await expect(settings.getByRole("group", { name: "选择 Pilo 装扮" }).getByRole("button")).toHaveCount(9);
    for (const label of ["圆框眼镜", "短围巾", "运动头带"]) {
      await expect(outfitChoices.getByRole("button", { name: new RegExp(label) }).locator(".pilo-avatar")).toHaveAttribute("data-pilo-mood", "idle");
    }
    await outfitChoices.getByRole("button", { name: /圆框眼镜/ }).click();
    await outfitChoices.getByRole("button", { name: /短围巾/ }).click();
    await outfitChoices.getByRole("button", { name: /运动头带/ }).click();
    await outfitChoices.getByRole("button", { name: /低轮廓耳机/ }).click();
    await expect(outfitChoices.getByRole("button", { name: /圆框眼镜/ })).toHaveAttribute("aria-pressed", "true");
    await expect(outfitChoices.getByRole("button", { name: /短围巾/ })).toHaveAttribute("aria-pressed", "true");
    await expect(outfitChoices.getByRole("button", { name: /运动头带/ })).toHaveAttribute("aria-pressed", "false");
    await expect(outfitChoices.getByRole("button", { name: /低轮廓耳机/ })).toHaveAttribute("aria-pressed", "true");
    await expect(pet.locator(".pilo-avatar")).toHaveAttribute("data-pilo-accessory", "glasses scarf earmuffs");
    await expect(pet.locator(".pilo-avatar__outfit-layer")).toHaveCount(2);
    await expect(settings.getByRole("status")).toContainText("已用低轮廓耳机替换运动头带");
    await expect(companion).toHaveAttribute("data-pilo-state", "listening");

    await settings.getByRole("tab", { name: "功能" }).click();
    await expect(settings.getByRole("button", { name: "让 Pilo 休息" })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "暂时隐藏" })).toHaveCount(0);

    await settings.getByRole("button", { name: "展开活动与出现" }).click();
    const activitySection = settings.getByRole("button", { name: "收起活动与出现" });
    await expect(activitySection).toHaveAttribute("aria-expanded", "true");
    const activityChoice = settings.getByRole("radiogroup", { name: "选择 Pilo 活动范围" });
    const choiceBounds = await activityChoice.getByRole("radio", { name: "原地陪伴" }).boundingBox();
    expect(choiceBounds?.height).toBe(44);
    await activitySection.click();
    await expect(settings.getByRole("button", { name: "展开活动与出现" })).toHaveAttribute("aria-expanded", "false");
    await expect(activityChoice).toHaveCount(0);

    const automaticSection = settings.getByRole("button", { name: "展开自动陪伴" });
    await expect(automaticSection).toHaveAttribute("aria-expanded", "false");
    await automaticSection.click();
    await expect(settings.getByRole("button", { name: "收起自动陪伴" })).toHaveAttribute("aria-expanded", "true");
    const contextSwitch = settings.getByRole("switch", { name: /情境陪伴/ });
    await contextSwitch.click();
    await expect(contextSwitch).toHaveAttribute("aria-checked", "false");
    await settings.getByRole("button", { name: "关闭 Pilo 设置" }).click();

    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("pp-pilo-preferences-v2") ?? "{}"));
    expect(stored.outfit).toBe("earmuffs");
    expect(stored.outfits).toEqual(["glasses", "scarf", "earmuffs"]);
    expect(stored.features.contextAwareness).toBe(false);
  });

  test("keeps every outfit choice reachable on a compact screen", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const pet = page.locator(".pilo-companion__pet");
    await pet.click({ button: "right" });

    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await settings.getByRole("tab", { name: "场景", exact: true }).click();
    await settings.getByRole("button", { name: "展开装扮选项" }).click();
    const outfitChoices = settings.getByRole("group", { name: "选择 Pilo 装扮" });
    await expect(outfitChoices.getByRole("button")).toHaveCount(9);
    await outfitChoices.getByRole("button", { name: /云朵护腕/ }).click();
    await expect(outfitChoices.getByRole("button", { name: /云朵护腕/ })).toHaveAttribute("aria-pressed", "true");
    await expect(pet.locator(".pilo-avatar")).toHaveAttribute("data-pilo-accessory", "wristwarmers");

    const bounds = await settings.boundingBox();
    expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(bounds?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(667);
  });

  test("migrates the former automatic default to the classic outfit", async ({ page }) => {
    const legacyOutfit = await readGuestPiloStorage<Record<string, unknown>>(page, "pp-pilo-preferences-v2");
    delete legacyOutfit.outfitDefaultVersion;
    await writeGuestPiloStorage(page, "pp-pilo-preferences-v2", { ...legacyOutfit, outfit: "auto" });
    await page.reload();

    const pet = page.locator(".pilo-companion__pet");
    await expect(pet.locator(".pilo-avatar")).toHaveAttribute("data-pilo-accessory", "none");
    await pet.click({ button: "right" });
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await settings.getByRole("tab", { name: "场景", exact: true }).click();
    await settings.getByRole("button", { name: "展开装扮选项" }).click();
    await expect(settings.getByRole("button", { name: /经典造型/ })).toHaveAttribute("aria-pressed", "true");

    const stored = await readGuestPiloStorage<Record<string, unknown>>(page, "pp-pilo-preferences-v2");
    expect(stored.outfit).toBe("none");
    expect(stored.outfitDefaultVersion).toBe(3);
  });

  test("keeps hover feedback without tracking the pointer direction", async ({ page }) => {
    const companion = page.locator(".pilo-companion");
    const pet = page.locator(".pilo-companion__pet");
    const avatar = pet.locator(".pilo-avatar");
    const body = pet.locator(".pilo-avatar__body");
    const bounds = await pet.boundingBox();
    expect(bounds).not.toBeNull();
    const stateBeforeHover = await companion.getAttribute("data-pilo-state");
    const atlasBeforeHover = await avatar.getAttribute("data-pilo-atlas-state");
    const accessoryBeforeHover = await avatar.getAttribute("data-pilo-accessory");
    const transformBeforeHover = await pet.evaluate((element) => getComputedStyle(element).transform);

    await page.mouse.move((bounds?.x ?? 0) + 18, (bounds?.y ?? 0) + 20);
    await expect(companion).toHaveAttribute("data-pilo-state", stateBeforeHover ?? "idle");
    await expect(avatar).toHaveAttribute("data-pilo-atlas-state", atlasBeforeHover ?? "idle");
    await expect(avatar).toHaveAttribute("data-pilo-accessory", accessoryBeforeHover ?? "none");
    await expect(pet).toHaveCSS("transform", transformBeforeHover);
    const firstTransform = await body.evaluate((element) => getComputedStyle(element).transform);
    await page.mouse.move((bounds?.x ?? 0) + (bounds?.width ?? 0) - 18, (bounds?.y ?? 0) + (bounds?.height ?? 0) - 20);
    const secondTransform = await body.evaluate((element) => getComputedStyle(element).transform);
    expect(secondTransform).toBe(firstTransform);
    await expect(pet.locator(".pilo-avatar")).toHaveClass(/is-illuminated/);

    await page.mouse.down();
    const pressedScale = await pet.evaluate((element) => {
      const transform = getComputedStyle(element).transform;
      if (transform === "none") return { x: 1, y: 1 };
      const matrix = new DOMMatrixReadOnly(transform);
      return { x: matrix.a, y: matrix.d };
    });
    expect(pressedScale.x).toBeCloseTo(1, 3);
    expect(pressedScale.y).toBeCloseTo(1, 3);
    await page.mouse.up();
  });

  test("keeps Pilo's standing silhouette stable throughout a manual drag", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.reload();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "notebook";
    });

    const companion = page.locator(".pilo-companion");
    const pet = page.locator(".pilo-companion__pet");
    const avatar = pet.locator(".pilo-avatar");
    const visual = pet.locator(".pilo-avatar__sprite");
    const petBounds = await pet.boundingBox();
    const visualBefore = await visual.boundingBox();
    expect(petBounds).not.toBeNull();
    expect(visualBefore).not.toBeNull();
    const restingVisualScale = await visual.evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return { scaleX: matrix.a, scaleY: matrix.d };
    });
    expect(restingVisualScale.scaleX).toBeCloseTo(1.12, 2);
    expect(restingVisualScale.scaleY).toBeCloseTo(1, 2);

    await page.mouse.move(
      (petBounds?.x ?? 0) + (petBounds?.width ?? 0) / 2,
      (petBounds?.y ?? 0) + (petBounds?.height ?? 0) / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      (petBounds?.x ?? 0) + (petBounds?.width ?? 0) / 2 - 44,
      (petBounds?.y ?? 0) + (petBounds?.height ?? 0) / 2 - 32,
      { steps: 12 },
    );

    await expect(companion).toHaveClass(/is-dragging/);
    await expect(companion).toHaveAttribute("data-pilo-state", "idle");
    await expect(avatar).toHaveAttribute("data-pilo-mood", "idle");
    const pressedTransform = await pet.evaluate((element) => {
      const transform = getComputedStyle(element).transform;
      const matrix = transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
      return { scaleX: matrix.a, scaleY: matrix.d, skewX: matrix.b, skewY: matrix.c };
    });
    const visualDuring = await visual.boundingBox();
    expect(pressedTransform.scaleX).toBeCloseTo(1, 3);
    expect(pressedTransform.scaleY).toBeCloseTo(1, 3);
    expect(pressedTransform.skewX).toBeCloseTo(0, 3);
    expect(pressedTransform.skewY).toBeCloseTo(0, 3);
    expect(visualDuring?.width).toBeCloseTo(visualBefore?.width ?? 0, 1);
    expect(visualDuring?.height).toBeCloseTo(visualBefore?.height ?? 0, 1);

    await page.mouse.up();
    await expect(companion).not.toHaveClass(/is-dragging/);
  });

  test("keeps Pilo above the Today navigation card after a left-side drag", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.reload();

    const companion = page.locator(".pilo-companion");
    const pet = page.locator(".pilo-companion__pet");
    const bounds = await pet.boundingBox();
    expect(bounds).not.toBeNull();

    await page.mouse.move(
      (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
      (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
    );
    await page.mouse.down();
    await page.mouse.move(80, 650, { steps: 30 });
    await page.mouse.up();

    await expect(companion).toHaveClass(/is-left-side/);
    const stacking = await page.evaluate(() => {
      const companionElement = document.querySelector<HTMLElement>(".pilo-companion")!;
      const petElement = document.querySelector<HTMLElement>(".pilo-companion__pet")!;
      const sidebarElement = document.querySelector<HTMLElement>(".sidebar")!;
      const rect = petElement.getBoundingClientRect();
      const samplePoints = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + 18, rect.top + rect.height * .62],
        [rect.right - 18, rect.top + rect.height * .62],
      ];
      return {
        companionZ: Number.parseInt(getComputedStyle(companionElement).zIndex, 10),
        petOwnsAllSamplePoints: samplePoints.every(([x, y]) => petElement.contains(document.elementFromPoint(x, y))),
        sidebarZ: Number.parseInt(getComputedStyle(sidebarElement).zIndex, 10),
      };
    });
    expect(stacking.companionZ).toBeGreaterThan(stacking.sidebarZ);
    expect(stacking.petOwnsAllSamplePoints).toBe(true);
  });

  test("uses one stable drag pose from every action state", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.reload();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "notebook";
    });

    const states = [
      "reading",
      "thinking",
      "working",
      "checking",
      "waiting",
      "success",
      "failure",
      "greeting",
      "stretching",
      "resting",
      "listening",
      "walking",
      "idle",
    ] as const;
    const companion = page.locator(".pilo-companion");
    const pet = page.locator(".pilo-companion__pet");
    const avatar = pet.locator(".pilo-avatar");

    for (const [index, state] of states.entries()) {
      const source = "drag-matrix:test";
      await page.evaluate(({ nextState, nextSource }) => {
        window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
          detail: {
            state: nextState,
            layer: "agent",
            source: nextSource,
            reason: `拖动矩阵：${nextState}`,
            duration: 30_000,
            interrupt: "same-or-higher",
          },
        }));
      }, { nextState: state, nextSource: source });
      await expect(companion).toHaveAttribute("data-pilo-state", state);

      const bounds = await pet.boundingBox();
      expect(bounds).not.toBeNull();
      const direction = index % 2 === 0 ? -1 : 1;
      const centerX = (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2;
      const centerY = (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2;
      await page.mouse.move(centerX, centerY);
      await page.mouse.down();
      await page.mouse.move(centerX + direction * 24, centerY - 18, { steps: 6 });

      await expect(companion).toHaveClass(/is-dragging/);
      await expect(avatar).toHaveAttribute("data-pilo-mood", "idle");
      await expect(avatar).toHaveAttribute("data-pilo-accessory", "none");
      await expect(avatar).toHaveAttribute("data-pilo-frame", "0");
      await expect(avatar.locator(".pilo-avatar__pose")).toHaveCount(1);
      await expect(avatar.locator(".pilo-avatar__sprite")).toHaveCount(1);
      const transform = await pet.evaluate((element) => {
        const value = getComputedStyle(element).transform;
        const matrix = value === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(value);
        return { scaleX: matrix.a, scaleY: matrix.d, skewX: matrix.b, skewY: matrix.c };
      });
      expect(transform.scaleX).toBeCloseTo(1, 3);
      expect(transform.scaleY).toBeCloseTo(1, 3);
      expect(transform.skewX).toBeCloseTo(0, 3);
      expect(transform.skewY).toBeCloseTo(0, 3);

      await page.mouse.up();
      await expect(companion).not.toHaveClass(/is-dragging/);
      await expect(page.locator(".pilo-companion__panel")).toHaveCount(0);
      await expect(companion).toHaveAttribute("data-pilo-state", state);
      await page.evaluate(({ nextSource }) => {
        window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
          detail: { state: "idle", layer: "agent", source: nextSource, clear: true },
        }));
      }, { nextSource: source });
      await page.waitForTimeout(450);
    }
  });

  test("glides Pilo into 学习伙伴 on one continuous path with a stable landing silhouette", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.reload();
    const source = await page.locator(".pilo-companion__pet").boundingBox();
    expect(source).not.toBeNull();

    const destinationFrames = page.evaluate(async () => {
      const waitForDestination = () => new Promise<HTMLElement>((resolve) => {
        const existing = document.querySelector<HTMLElement>(".companion-brand-avatar-motion");
        if (existing) {
          resolve(existing);
          return;
        }
        const observer = new MutationObserver(() => {
          const destination = document.querySelector<HTMLElement>(".companion-brand-avatar-motion");
          if (!destination) return;
          observer.disconnect();
          resolve(destination);
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      const motion = await waitForDestination();
      const destination = motion.closest<HTMLElement>(".companion-brand-avatar-shell")!;
      const samples: Array<{
        x: number;
        y: number;
        width: number;
        height: number;
        scaleX: number;
        scaleY: number;
        skewX: number;
        skewY: number;
        settling: boolean;
        transitioning: boolean;
        mood: string | null;
        spriteFrame: string | null;
        illuminated: boolean;
      }> = [];
      for (let frame = 0; frame < 90; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const avatar = destination.querySelector<HTMLElement>(".pilo-avatar");
        const bounds = motion.getBoundingClientRect();
        const transform = getComputedStyle(motion).transform;
        const matrix = transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(transform);
        samples.push({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          scaleX: matrix.a,
          scaleY: matrix.d,
          skewX: matrix.b,
          skewY: matrix.c,
          settling: destination.classList.contains("is-settling"),
          transitioning: destination.classList.contains("is-transition-active"),
          mood: avatar?.dataset.piloMood ?? null,
          spriteFrame: avatar?.dataset.piloFrame ?? null,
          illuminated: avatar?.classList.contains("is-illuminated") ?? false,
        });
      }
      return samples;
    });

    await page.getByRole("link", { name: "学习伙伴", exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/coach(?:\?|$)/);
    const frames = await destinationFrames;
    const animatedFrames = frames.filter((frame) => frame.transitioning);
    const range = (values: number[]) => Math.max(...values) - Math.min(...values);
    const target = frames.at(-1)!;
    const distances = frames.map((frame) => Math.hypot(frame.x - target.x, frame.y - target.y));
    const increases = distances.slice(1).map((distance, index) => distance - distances[index]);
    const settledFrames = frames.slice(-18);
    const sourceCenter = {
      x: (source?.x ?? 0) + (source?.width ?? 0) / 2,
      y: (source?.y ?? 0) + (source?.height ?? 0) / 2,
    };
    const firstCenter = {
      x: frames[0].x + frames[0].width / 2,
      y: frames[0].y + frames[0].height / 2,
    };

    expect(frames).toHaveLength(90);
    expect(Math.hypot(firstCenter.x - sourceCenter.x, firstCenter.y - sourceCenter.y)).toBeLessThan(20);
    expect(distances[0]).toBeGreaterThan(300);
    expect(Math.max(...increases)).toBeLessThan(1);
    expect(range(frames.map((frame) => frame.width))).toBeLessThan(.5);
    expect(range(frames.map((frame) => frame.height))).toBeLessThan(.5);
    frames.forEach((frame) => {
      expect(frame.scaleX).toBeCloseTo(1, 3);
      expect(frame.scaleY).toBeCloseTo(1, 3);
      expect(frame.skewX).toBeCloseTo(0, 3);
      expect(frame.skewY).toBeCloseTo(0, 3);
    });
    expect(animatedFrames.length).toBeGreaterThan(10);
    expect(animatedFrames.every((frame) => frame.mood === "walking-left" || frame.mood === "walking-right")).toBe(true);
    expect(frames.some((frame) => frame.settling && (frame.mood === "walking-left" || frame.mood === "walking-right") && frame.illuminated)).toBe(true);
    expect(range(settledFrames.map((frame) => frame.x))).toBeLessThan(.5);
    expect(range(settledFrames.map((frame) => frame.y))).toBeLessThan(2);
    await expect(page.locator(".companion-brand-avatar-shell")).not.toHaveClass(/is-transition-active|is-settling/);
    await expect(page.locator(".companion-brand-avatar-motion .pilo-avatar")).toHaveAttribute("data-pilo-mood", "listening");
    expect(await page.evaluate(() => window.sessionStorage.getItem("pp-pilo-coach-transition-v2"))).toBeNull();
  });

  test("enters 学习伙伴 directly when reduced motion is enabled", async ({ page }) => {
    await page.getByRole("link", { name: "学习伙伴", exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/coach(?:\?|$)/);
    const destination = page.locator(".companion-brand-avatar-shell");
    await expect(destination).toHaveAttribute("aria-label", "Pilo 在学习伙伴页陪伴");
    await expect(destination).not.toHaveClass(/is-transition-active|is-settling/);
    await expect(destination.locator(".companion-brand-avatar-motion")).toHaveCSS("transform", "none");
    await expect(destination.locator(".pilo-avatar")).not.toHaveClass(/is-illuminated/);
  });

  test("persists the collapsible daily-scene controls", async ({ page }) => {
    const pet = page.locator(".pilo-companion__pet");
    await pet.click({ button: "right" });
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await settings.getByRole("tab", { name: "功能" }).click();

    const sceneToggle = settings.getByRole("button", { name: "展开场景自动化" });
    await expect(sceneToggle).toHaveAttribute("aria-expanded", "false");
    await sceneToggle.click();
    await expect(settings.getByRole("button", { name: "收起场景自动化" })).toHaveAttribute("aria-expanded", "true");

    const master = settings.getByRole("switch", { name: /一日陪伴场景/ });
    await expect(master).toHaveAttribute("aria-checked", "true");
    await expect(settings.getByRole("switch", { name: /早晨问候/ })).toBeVisible();
    await expect(settings.getByRole("switch", { name: /工作陪伴/ })).toBeVisible();
    await expect(settings.getByRole("switch", { name: /用餐场景/ })).toBeVisible();
    await expect(settings.getByRole("switch", { name: /运动与休息/ })).toBeVisible();
    await expect(settings.getByRole("switch", { name: /晚间回顾/ })).toBeVisible();
    await expect(settings.getByRole("switch", { name: /夜间作息/ })).toBeVisible();
    await expect(settings.getByRole("switch", { name: /结合我的计划/ })).toBeVisible();
    await expect(settings.getByLabel("Pilo 睡眠提醒时间")).toBeDisabled();
    await expect(settings.getByRole("radiogroup", { name: "选择 Pilo 主动场景频率" })).toBeVisible();

    await master.click();
    await expect(master).toHaveAttribute("aria-checked", "false");
    await expect(settings.getByRole("switch", { name: /用餐场景/ })).toHaveCount(0);
    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("pp-pilo-preferences-v2") ?? "{}"));
    expect(stored.features.dailyScenes).toBe(false);
  });

  test("renders every daily scene as one stage and yields to higher-priority state", async ({ page }) => {
    const companion = page.locator(".pilo-companion");
    const pet = page.locator(".pilo-companion__pet");
    for (const scene of ["morning", "focus", "lunch", "dinner", "movement", "review", "night"] as const) {
      await page.evaluate((nextScene) => window.dispatchEvent(new CustomEvent("planpilot:pilo-scene", {
        detail: { scene: nextScene },
      })), scene);
      await expect(companion).toHaveAttribute("data-pilo-scene", scene);
      const stage = page.locator(`.pilo-scene--${scene}`);
      await expect(stage).toBeVisible();
      await expect(stage.locator(".pilo-avatar")).toHaveCount(0);
      await expect(stage.locator(".pilo-scene__frame")).toHaveCount(2);
      await expect(stage.locator(".pilo-scene__frame--base")).toBeVisible();
      await expect(stage.locator(".pilo-scene__foreground")).toHaveCount(0);
      await expect(stage.getByRole("button", { name: new RegExp(`和.*场景里的 Pilo 聊聊`) })).toBeVisible();
      const sceneGeometry = await stage.locator(".pilo-scene__visual").evaluate((visual) => {
        const frames = [...visual.querySelectorAll<HTMLElement>(".pilo-scene__frame")];
        const bounds = frames.map((frame) => frame.getBoundingClientRect());
        return {
          frameCount: frames.length,
          sameSize: bounds.length === 2
            && Math.abs(bounds[0].width - bounds[1].width) < .5
            && Math.abs(bounds[0].height - bounds[1].height) < .5,
        };
      });
      expect(sceneGeometry).toEqual({ frameCount: 2, sameSize: true });
      await expect(pet.locator(".pilo-avatar")).toHaveCount(1);
      await expect(pet).toHaveCSS("opacity", "0");
      await stage.getByRole("button", { name: new RegExp(`关闭`) }).click();
      await expect(companion).toHaveAttribute("data-pilo-scene", "none");
      await expect(pet).toHaveCSS("opacity", "1");
    }

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-scene", { detail: { scene: "morning" } })));
    await expect(companion).toHaveAttribute("data-pilo-scene", "morning");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
      detail: { state: "working", layer: "agent", source: "agent:scene-priority", reason: "正在执行任务", duration: 30_000 },
    })));
    await expect(companion).toHaveAttribute("data-pilo-state", "working");
    await expect(companion).toHaveAttribute("data-pilo-scene", "none");
  });

  test("uses action-specific integrated scene art and records why Pilo appeared", async ({ page }) => {
    const pet = page.locator(".pilo-companion__pet");
    await pet.click({ button: "right" });
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await settings.getByRole("tab", { name: "场景", exact: true }).click();
    await settings.getByRole("button", { name: "展开装扮选项" }).click();
    const outfits = settings.getByRole("group", { name: "选择 Pilo 装扮" });
    await outfits.getByRole("button", { name: /圆框眼镜/ }).click();
    await outfits.getByRole("button", { name: /短围巾/ }).click();
    await settings.getByRole("button", { name: "关闭 Pilo 设置" }).click();

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-scene", { detail: { scene: "focus" } })));
    const stage = page.locator(".pilo-scene--focus");
    await expect(stage).toBeVisible();
    await expect(stage.locator(".pilo-avatar")).toHaveCount(0);
    await expect(stage.locator(".pilo-scene__frame")).toHaveCount(2);
    await expect(stage.locator(".pilo-scene__foreground")).toHaveCount(0);
    await stage.getByRole("button", { name: /关闭/ }).click();

    await pet.click({ button: "right" });
    await settings.getByRole("tab", { name: "概览" }).click();
    await settings.getByRole("button", { name: "展开今天 Pilo 出现了什么" }).click();
    await expect(settings.getByLabel("今天 Pilo 为什么出现")).toContainText("桌前陪伴");
  });

  test("keeps daily scenes inside portrait and landscape safe areas", async ({ page }) => {
    const assertSceneBounds = async (width: number, height: number) => {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-scene", { detail: { scene: "night" } })));
      const stage = page.locator(".pilo-scene--night");
      await expect(stage).toBeVisible();
      const bounds = await stage.boundingBox();
      expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect(bounds?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(height);
      await expect(stage).toHaveAttribute("data-reduce-motion", "true");
      await expect(stage.locator(".pilo-scene__light")).toHaveCSS("animation-name", "none");
      await expect(stage.locator(".pilo-scene__frame--alternate")).toHaveCSS("animation-name", "none");
      const primary = stage.locator(".pilo-scene__primary");
      const later = stage.locator(".pilo-scene__later");
      await expect(primary).toHaveCSS("justify-content", "center");
      await expect(primary).toHaveCSS("text-align", "center");
      await expect(later).toHaveCSS("justify-content", "center");
      await expect(later).toHaveCSS("text-align", "center");
      expect(parseFloat(await primary.evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(11);
      expect(parseFloat(await later.evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(10.5);
      await expect(later).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    };
    await assertSceneBounds(375, 667);
    await page.locator(".pilo-scene--night").getByRole("button", { name: /关闭/ }).click();
    await assertSceneBounds(667, 375);
  });

  test("场景预览移除夜间休息且右键后的主形象不切换浅边静态图", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const petAvatar = page.locator(".pilo-companion__pet .pilo-avatar");
    await page.locator(".pilo-companion__pet").click({ button: "right" });
    await expect(petAvatar).toHaveAttribute("data-pilo-mood", "idle");
    await expect(petAvatar).toHaveAttribute("data-pilo-atlas-state", "idle");
    await expect(petAvatar.locator(".pilo-avatar__body img")).toHaveCount(0);
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await settings.getByRole("tab", { name: "场景", exact: true }).click();
    const movement = await page.evaluate(() => new Promise<{ panel: number; companion: number }>((resolve) => {
      const panelPositions: number[] = [];
      const companionPositions: number[] = [];
      const startedAt = performance.now();
      const sample = () => {
        const panel = document.querySelector<HTMLElement>(".pilo-companion__context")?.getBoundingClientRect();
        const companion = document.querySelector<HTMLElement>(".pilo-companion")?.getBoundingClientRect();
        if (panel) panelPositions.push(panel.y);
        if (companion) companionPositions.push(companion.y);
        if (performance.now() - startedAt < 500) {
          window.requestAnimationFrame(sample);
          return;
        }
        const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
        resolve({ panel: spread(panelPositions), companion: spread(companionPositions) });
      };
      window.requestAnimationFrame(sample);
    }));
    expect(movement.panel).toBeLessThanOrEqual(0.25);
    expect(movement.companion).toBeLessThanOrEqual(0.25);
    await settings.getByRole("button", { name: "展开场景预览" }).click();
    await expect(settings.getByRole("button", { name: "收起场景预览" })).toBeVisible();
    const previews = settings.locator(".pilo-companion__scene-preview-grid > button");
    await expect(previews).toHaveCount(6);
    await expect(settings.getByText("夜间休息", { exact: true })).toHaveCount(0);
    await previews.filter({ hasText: "晚间回顾" }).click();
    await expect(page.locator(".pilo-companion")).toHaveAttribute("data-pilo-scene", "review");
  });
});

test.describe("Pilo coach toolbar", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      const at = (monthOffset: number, dayOffset: number) => {
        const value = new Date();
        value.setMonth(value.getMonth() + monthOffset);
        value.setDate(value.getDate() + dayOffset);
        value.setHours(19, 30, 0, 0);
        return value.toISOString();
      };
      const conversation = (id: string, title: string, goalTitle: string, updatedAt: string) => ({
        id,
        sessionId: id,
        goalId: null,
        goalTitle,
        title,
        summary: `${title}的会话摘要`,
        piloFeedback: `Pilo 已整理${title}的下一步`,
        messages: [{ id: `${id}-u`, role: "user", content: title }, { id: `${id}-a`, role: "assistant", content: `一起处理${title}` }],
        createdAt: updatedAt,
        updatedAt,
        association: "测试会话",
        isFavorite: false,
      });
      const fixtures = [
        conversation("legacy-algorithm", "调整本周算法计划", "算法进阶", at(0, 0)),
        conversation("legacy-load", "降低学习负荷", "跨目标节奏", at(0, -10)),
        conversation("legacy-review", "复盘上月学习节奏", "数据结构巩固", at(-1, -2)),
      ];
      fixtures[0].isFavorite = true;
      fixtures[1].isFavorite = true;
      window.localStorage.setItem("planpilot:guest-dataset-version", "4");
      window.localStorage.setItem("planpilot:pilo-demo-archive-version", "4");
      window.localStorage.setItem("planpilot:pilo-conversations:guest", JSON.stringify(fixtures));
    });
    await page.goto("/studio/coach");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(150);
  });

  test("keeps the compact desktop toolbar inside the learning partner viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });

    const geometry = await page.evaluate(() => {
      const workspace = document.querySelector<HTMLElement>(".companion-workspace")!;
      const commandbar = document.querySelector<HTMLElement>(".companion-commandbar")!;
      const history = document.querySelector<HTMLElement>(".companion-history-link")!;
      const panel = document.querySelector<HTMLElement>(".companion-chat-panel")!;
      const workspaceBounds = workspace.getBoundingClientRect();
      const commandbarBounds = commandbar.getBoundingClientRect();
      const historyBounds = history.getBoundingClientRect();
      const panelBounds = panel.getBoundingClientRect();
      return {
        documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        workspaceFits: workspace.scrollWidth <= workspace.clientWidth,
        commandbarFits: commandbarBounds.right <= workspaceBounds.right,
        historyFits: historyBounds.right <= commandbarBounds.right,
        panelFits: panelBounds.right <= workspaceBounds.right,
      };
    });

    expect(geometry).toEqual({
      documentFits: true,
      workspaceFits: true,
      commandbarFits: true,
      historyFits: true,
      panelFits: true,
    });
    await expect(page.locator(".companion-settings-link > span")).toBeHidden();
    await expect(page.locator(".companion-history-link > span")).toBeHidden();
    await expect(page.getByRole("button", { name: "打开 Pilo 设置" }).locator("svg")).toBeVisible();
    await expect(page.getByRole("button", { name: "查看历史会话" }).locator("svg")).toBeVisible();
  });

  test("matches the round-focus menu to the history drawer language", async ({ page }) => {
    await page.getByRole("button", { name: /本轮聚焦/ }).click();
    const menu = page.getByRole("listbox", { name: "选择本轮聚焦目标" });
    const selected = menu.getByRole("option", { selected: true });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS("width", "360px");
    await expect(menu).toHaveCSS("border-radius", "18px");
    await expect(selected).toHaveCSS("border-radius", "0px");
    await expect(selected.locator(".companion-goal-option-mark")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    await page.getByRole("button", { name: /本轮聚焦/ }).click();
    await page.getByRole("button", { name: "拉灯切换到深色模式" }).click();
    await page.getByRole("button", { name: /本轮聚焦/ }).click();
    await expect(menu).toHaveCSS("background-image", /radial-gradient.*linear-gradient/);

    await page.setViewportSize({ width: 375, height: 812 });
    const bounds = await menu.boundingBox();
    expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });

  test("keeps proposal actions and dark action previews readable", async ({ page }) => {
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".companion-feed")!;
      const fixture = document.createElement("div");
      fixture.dataset.contrastFixture = "true";
      fixture.innerHTML = `
        <article class="companion-proposal">
          <footer><button type="button" class="is-primary"><span>✓</span>记下这条提醒</button></footer>
        </article>
        <section class="companion-action-run" aria-label="暗色行动任务样式检查">
          <header><div><small>行动任务</small><h3>建议重新安排逾期任务</h3></div><span><i></i>等你确认</span></header>
          <ul class="companion-action-operations">
            <li><span>模块与包导入</span><small>待调整</small><p>2026-08-19 → 2026-08-24</p></li>
          </ul>
        </section>`;
      host.append(fixture);
    });

    const primary = page.locator("[data-contrast-fixture] .companion-proposal button.is-primary");
    await expect(primary).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(primary).toHaveCSS("background-image", /linear-gradient/);

    await page.getByRole("button", { name: "拉灯切换到深色模式" }).click();
    await expect(page.locator(".companion-workspace")).toHaveClass(/is-dark/);
    await expect(page.locator(".companion-workspace")).toHaveCSS(
      "background-image",
      /rgb\(14, 23, 41\).*rgb\(17, 30, 54\)/,
    );
    const action = page.getByRole("region", { name: "暗色行动任务样式检查" });
    await expect(action.locator("h3")).toHaveCSS("color", "rgb(242, 245, 250)");
    await expect(action.locator(".companion-action-operations > li > span")).toHaveCSS("color", "rgb(242, 245, 250)");
    await expect(action.locator(".companion-action-operations > li > p")).toHaveCSS("color", "rgb(189, 199, 215)");
    await expect(action.locator(".companion-action-operations > li")).toHaveCSS("border-top-color", "rgba(190, 201, 222, 0.2)");
  });

  test("keeps long-term observation always on and lets the user choose the round focus", async ({ page }) => {
    const trigger = page.locator(".companion-goal-trigger");
    await expect(trigger).toHaveAccessibleName(/本轮聚焦：不限目标/);
    await expect(trigger).toContainText("本轮聚焦");
    await expect(trigger).toContainText("不限目标");
    await expect(page.locator(".companion-feed .companion-goal-picker")).toHaveCount(0);
    await expect(page.locator(".companion-command-actions .companion-goal-picker")).toHaveCount(1);
    const settingsAction = page.getByRole("button", { name: "打开 Pilo 设置" });
    const historyAction = page.getByRole("button", { name: "查看历史会话" });
    await expect(settingsAction).toContainText("Pilo 设置");
    await expect(historyAction).toContainText("历史记录");
    await settingsAction.click();
    const settingsPanel = page.getByRole("dialog", { name: "Pilo 设置" });
    await expect(settingsPanel).toBeVisible();
    const settingsScroll = settingsPanel.locator(".companion-settings-scroll");
    await expect(settingsScroll).toHaveCSS("overflow-y", "auto");
    await expect(settingsScroll).toHaveCSS("scrollbar-width", "thin");
    await expect(settingsPanel.locator(".companion-settings-saved")).toBeVisible();
    await expect(settingsPanel.getByText("让陪伴更像你需要的方式")).toHaveCount(0);
    const toneToggle = settingsPanel.getByRole("button", { name: /对话语气/ });
    const initiativeToggle = settingsPanel.getByRole("button", { name: /陪伴主动性/ });
    const detailToggle = settingsPanel.getByRole("button", { name: /回复信息量/ });
    const behaviorToggle = settingsPanel.getByRole("button", { name: /反馈与动作/ });
    await expect(toneToggle).toHaveAttribute("aria-expanded", "true");
    await expect(initiativeToggle).toHaveAttribute("aria-expanded", "false");
    await expect(detailToggle).toHaveAttribute("aria-expanded", "false");
    await expect(behaviorToggle).toHaveAttribute("aria-expanded", "false");
    await expect(settingsPanel.locator(".companion-settings-section").first()).toHaveCSS("border-top-width", "0px");
    await expect(settingsPanel.locator(".companion-settings-section__toggle small").first()).toHaveCSS("color", "rgb(90, 75, 193)");
    await expect(toneToggle).toHaveCSS("border-top-width", "1px");
    await expect(settingsPanel.getByRole("radiogroup", { name: "选择对话语气" })).toBeVisible();
    const selectedTone = settingsPanel.getByRole("radio", { name: /温暖平和/ });
    await expect(selectedTone).toHaveAttribute("aria-checked", "true");
    await expect(selectedTone).toHaveCSS("background-image", "none");
    await expect(settingsPanel.locator(".companion-settings-section__toggle small").first()).toHaveCSS("font-size", "10px");
    await initiativeToggle.click();
    await expect(initiativeToggle).toHaveAttribute("aria-expanded", "true");
    await expect(settingsPanel.getByRole("link", { name: /记忆与画像/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    const triggerBounds = await trigger.boundingBox();
    const settingsBounds = await settingsAction.boundingBox();
    const historyBounds = await historyAction.boundingBox();
    expect(triggerBounds?.height).toBe(settingsBounds?.height);
    expect(triggerBounds?.y).toBe(settingsBounds?.y);
    expect(Math.abs((settingsBounds?.height ?? 0) - (historyBounds?.height ?? 0))).toBeLessThanOrEqual(1);
    expect(settingsBounds?.y).toBe(historyBounds?.y);
    const selectedGoalText = trigger.locator(".companion-goal-copy > strong");
    await expect(selectedGoalText).toHaveText("不限目标");
    expect(await selectedGoalText.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

    const feed = page.locator(".companion-feed");
    await expect(feed).toHaveCSS("overflow-y", "auto");
    await expect(feed).toHaveCSS("scrollbar-width", "none");
    const chatPanel = page.locator(".companion-chat-panel");
    const inputNote = page.locator(".companion-input-note");
    const panelBounds = await chatPanel.boundingBox();
    const noteBounds = await inputNote.boundingBox();
    expect(panelBounds?.width ?? 999).toBeLessThanOrEqual(840);
    expect(Math.round((panelBounds?.y ?? 0) + (panelBounds?.height ?? 0))).toBe(800);
    expect((noteBounds?.y ?? 0) + (noteBounds?.height ?? 0)).toBeGreaterThan(770);
    await expect(page.getByRole("button", { name: /试试其他/ })).toBeVisible();
    const openingObservation = page.locator(".companion-insight-card.is-opening-card");
    const evidenceAction = openingObservation.getByRole("button", { name: /查看依据/ });
    await expect(evidenceAction).toBeVisible();

    const composer = page.getByLabel("给 Pilo 发送消息");
    await composer.fill("这个月错题有点散，我不知道该从哪里重新开始。");
    await composer.press("Enter");
    await expect(page.locator(".companion-message.is-user")).toHaveCount(1);
    await expect(page.locator(".companion-message.is-assistant")).toHaveCount(1);
    await expect(page.locator(".companion-message.is-user > .companion-message-speaker > .companion-message-avatar")).toBeVisible();
    await expect(page.locator(".companion-message.is-assistant > .companion-message-speaker > .companion-message-avatar .pilo-avatar")).toBeVisible();
    await expect(page.locator(".companion-message-speaker > strong")).toHaveCount(0);
    const assistantBubble = page.locator(".companion-message.is-assistant > .companion-message-bubble");
    const userBubble = page.locator(".companion-message.is-user > .companion-message-bubble");
    await expect(assistantBubble).toHaveCSS("border-color", "rgba(117, 103, 248, 0.28)");
    await expect(userBubble).toHaveCSS("border-color", "rgba(88, 76, 198, 0.3)");
    expect(await assistantBubble.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
    expect(await userBubble.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
    const assistantBubbleBounds = await assistantBubble.boundingBox();
    const userBubbleBounds = await userBubble.boundingBox();
    expect(assistantBubbleBounds?.width ?? 999).toBeLessThanOrEqual(520);
    expect(userBubbleBounds?.width ?? 999).toBeLessThanOrEqual(520);
    expect(Math.abs((assistantBubbleBounds?.width ?? 0) - (userBubbleBounds?.width ?? 0))).toBeGreaterThan(8);
    expect(assistantBubbleBounds?.x ?? 999).toBeLessThan(userBubbleBounds?.x ?? 0);
    await expect(openingObservation).toHaveClass(/is-collapsed/);
    await expect(openingObservation.getByRole("button", { name: "展开 Pilo 的观察" })).toBeVisible();
    await expect(page.locator(".companion-message-header > .companion-message-author")).toHaveCount(0);
    await expect(page.locator(".companion-message.is-user time")).toHaveCount(1);
    await expect(page.locator(".companion-message.is-assistant time")).toHaveCount(0);
    await expect(page.locator(".companion-message.is-assistant .companion-message-header")).toHaveCount(0);
    await expect(page.locator(".companion-message footer")).toHaveCount(0);
    await expect(page.locator(".companion-input-note")).toHaveCount(1);
    await expect.poll(async () => feed.evaluate((element) => {
      const node = element as HTMLElement;
      return Math.round(node.scrollHeight - node.scrollTop - node.clientHeight);
    })).toBeLessThanOrEqual(1);
    const feedBounds = await feed.boundingBox();
    const commandbarBounds = await page.locator(".companion-commandbar").boundingBox();
    const dayBounds = await page.locator(".companion-day-separator").boundingBox();
    expect(dayBounds?.y ?? 0).toBeGreaterThanOrEqual(commandbarBounds?.height ?? 0);
    expect(feedBounds?.y ?? 0).toBe((commandbarBounds?.y ?? 0) + (commandbarBounds?.height ?? 0));
    await openingObservation.getByRole("button", { name: "展开 Pilo 的观察" }).click();
    await expect(openingObservation).not.toHaveClass(/is-collapsed/);
    await openingObservation.getByRole("button", { name: "收起 Pilo 的观察" }).click();
    await expect(openingObservation).toHaveClass(/is-collapsed/);

    await evidenceAction.click();
    const evidencePanel = page.getByRole("dialog", { name: "依据来源" });
    await expect(evidencePanel).toBeVisible();
    await expect(evidencePanel.locator(".companion-context-scroll")).toHaveCSS("overflow-y", "auto");
    await expect(evidencePanel.getByRole("heading", { name: "依据来源" })).toBeVisible();
    await expect(evidencePanel).toContainText(/\d+ 条近期记录/);
    const patternsToggle = evidencePanel.getByRole("button", { name: /与你有关的学习习惯/ });
    const memoryToggle = evidencePanel.getByRole("button", { name: /本轮参考的长期记录/ });
    const resourcesToggle = evidencePanel.getByRole("button", { name: /本轮可用资料/ });
    await expect(patternsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(memoryToggle).toHaveAttribute("aria-expanded", "false");
    await memoryToggle.click();
    await expect(evidencePanel.locator(".companion-memory-list > a").first()).toHaveAttribute("href", "/studio/coach/memory");
    await resourcesToggle.click();
    await expect(evidencePanel.locator(".companion-resource-list > a").first()).toHaveAttribute("href", /\/studio\/work\/knowledge\?query=/);
    await page.keyboard.press("Escape");

    await historyAction.click();
    const historyPanel = page.getByRole("dialog", { name: "对话记录" });
    const historyScroll = historyPanel.locator(".companion-history-scroll");
    await expect(historyScroll).toHaveCSS("scrollbar-width", "thin");
    await expect(historyScroll).not.toHaveClass(/is-scrolling/);
    await historyScroll.evaluate((element) => element.dispatchEvent(new Event("scroll", { bubbles: true })));
    await expect(historyScroll).toHaveClass(/is-scrolling/);
    await expect(historyScroll).not.toHaveClass(/is-scrolling/, { timeout: 1_500 });
    const historySearch = historyPanel.getByPlaceholder("搜索问题、Pilo 反馈或关联内容");
    await historySearch.click();
    await expect(historyPanel.locator(".companion-history-search")).toHaveCSS("background-image", "none");
    await expect(historyPanel.locator(".companion-history-search")).toHaveCSS("border-radius", "0px");
    await expect(historyPanel.locator(".companion-history-search")).toHaveCSS("box-shadow", "none");
    await expect(historyPanel.locator(".companion-history-filter")).toHaveCSS("background-image", "none");
    await expect(historyPanel.locator(".companion-history-filter")).toHaveCSS("border-radius", "0px");
    const historyGoalFilter = historyPanel.getByRole("button", { name: "按目标筛选历史会话" });
    await historyGoalFilter.click();
    const historyGoalMenu = historyPanel.getByRole("listbox", { name: "历史会话目标" });
    await expect(historyGoalMenu).toBeVisible();
    const selectedHistoryGoal = historyGoalMenu.getByRole("option", { name: "全部目标" });
    await expect(selectedHistoryGoal).toHaveAttribute("aria-selected", "true");
    await expect(selectedHistoryGoal).toHaveCSS("background-image", "none");
    await expect(selectedHistoryGoal).toHaveCSS("box-shadow", "none");
    await selectedHistoryGoal.click();
    await expect(historyPanel.getByText("延续上次的思路")).toHaveCount(0);
    await expect(historyPanel.getByRole("button", { name: "开始新对话" })).toBeVisible();
    await expect(historyPanel.getByRole("button", { name: /导出存档/ })).toBeVisible();
    await expect(historyPanel.getByRole("button", { name: /导入存档/ })).toBeVisible();
    await expect(historyPanel.getByText("昨天", { exact: true })).toHaveCount(0);
    await expect(historyPanel.getByText("本月", { exact: true })).toHaveCount(0);
    await expect(historyPanel.getByText("2026年7月", { exact: true })).toHaveCount(0);
    const weekToggle = historyPanel.getByRole("button", { name: "收起本周历史会话" });
    await expect(weekToggle).toHaveAttribute("aria-expanded", "true");
    await weekToggle.click();
    await expect(historyPanel.getByRole("button", { name: "展开本周历史会话" })).toHaveAttribute("aria-expanded", "false");
    await historyPanel.getByRole("button", { name: "展开本周历史会话" }).click();
    const weekPicker = historyPanel.locator(".companion-history-weekdays");
    await expect(weekPicker.getByRole("button")).toHaveCount(7);
    const todayButton = weekPicker.getByRole("button", { name: /今天/ });
    await expect(todayButton).toHaveAttribute("aria-current", "date");
    await expect(todayButton).not.toHaveCSS("background-image", "none");
    const recordedWeekday = weekPicker.getByRole("button", { name: /\d+ 次会话/ }).first();
    await recordedWeekday.click();
    await expect(recordedWeekday).toHaveAttribute("aria-pressed", "true");
    const selectedDayCount = Number((await recordedWeekday.getAttribute("aria-label"))?.match(/(\d+) 次会话/)?.[1] ?? 0);
    await expect(historyPanel.locator(".companion-history-period.is-week .companion-thread-item")).toHaveCount(selectedDayCount);
    await recordedWeekday.click();
    await expect(recordedWeekday).toHaveAttribute("aria-pressed", "false");
    const archiveToggle = historyPanel.getByRole("button", { name: "展开更早的历史会话" });
    await expect(archiveToggle).toBeVisible();
    await expect(archiveToggle).toHaveAttribute("aria-expanded", "false");
    await historySearch.fill("降低学习负荷");
    await expect(historyPanel.locator(".companion-thread-heading")).toContainText("降低学习负荷");
    const emptyArchiveToggle = historyPanel.getByRole("button", { name: "收起更早的历史会话" });
    await expect(emptyArchiveToggle).toContainText("1 次记录");
    await expect(historyPanel.getByText("还没有本周以前的会话", { exact: true })).toHaveCount(0);
    await expect(historyPanel.locator(".companion-history-date-picker")).toHaveCount(1);
    await historySearch.fill("");
    await expect(archiveToggle).toHaveAttribute("aria-expanded", "false");
    const favoritesOnly = historyPanel.getByRole("button", { name: "仅看收藏会话" });
    await favoritesOnly.click();
    await expect(favoritesOnly).toHaveAttribute("aria-pressed", "true");
    await expect(historyPanel.locator(".companion-thread-item")).toHaveCount(2);
    await favoritesOnly.click();
    await expect(favoritesOnly).toHaveAttribute("aria-pressed", "false");
    await archiveToggle.click();
    await expect(historyPanel.getByRole("button", { name: "收起更早的历史会话" })).toHaveAttribute("aria-expanded", "true");
    await expect(historyPanel.getByRole("combobox", { name: "选择历史会话年份" })).toBeVisible();
    const archiveMonth = historyPanel.getByRole("combobox", { name: "选择历史会话月份" });
    await expect(archiveMonth).toBeVisible();
    const archiveDay = historyPanel.getByRole("combobox", { name: "选择历史会话日期" });
    await expect(archiveDay).toBeVisible();
    await expect(archiveDay).toContainText("全部日期");
    await archiveMonth.click();
    const monthMenu = page.getByRole("listbox");
    await expect(monthMenu).toBeVisible();
    await expect(monthMenu).toHaveCSS("border-radius", "11px");
    await expect(monthMenu.locator("[data-radix-select-viewport]")).toHaveCSS("overflow-y", "auto");
    await monthMenu.getByRole("option", { name: "7 月" }).click();
    await expect(historyPanel.getByText("复盘上月学习节奏", { exact: true })).toBeVisible();
    await archiveMonth.click();
    await page.getByRole("option", { name: "8 月" }).click();
    await archiveDay.click();
    const preciseDay = page.getByRole("option", { name: /\d+ 日/ }).first();
    const preciseDayLabel = await preciseDay.innerText();
    await preciseDay.click();
    await expect(archiveDay).toContainText(preciseDayLabel);
    await archiveDay.click();
    await page.getByRole("option", { name: "全部日期" }).click();
    await expect(historyPanel.locator(".companion-history-date-field__label").first()).toHaveCSS("text-align", "left");
    const todayRail = await todayButton.evaluate((button) => getComputedStyle(button, "::before").width);
    expect(todayRail).toBe("1.5px");
    expect(await historyPanel.locator(".companion-thread-feedback").count()).toBeGreaterThanOrEqual(3);
    const piloFace = historyPanel.locator(".companion-thread-pilo-face").first();
    await expect(piloFace).toBeVisible();
    await expect(piloFace).toHaveCSS("overflow", "hidden");
    await expect(piloFace.locator(".pilo-avatar")).toHaveCSS("top", "-9px");
    await expect(historyPanel.locator(".companion-history-period-toggle strong")).toHaveCSS("font-size", "14px");
    const historyRows = historyPanel.locator(".companion-thread-open");
    const algorithmHistoryRow = historyRows.filter({ hasText: "调整本周算法计划" });
    expect(await algorithmHistoryRow.evaluate((row) => row.getBoundingClientRect().height)).toBeLessThanOrEqual(166);
    await expect(algorithmHistoryRow.locator(".companion-thread-goal")).toContainText("算法进阶");
    await expect(algorithmHistoryRow.locator(".companion-thread-heading")).toContainText("调整本周算法计划");
    await algorithmHistoryRow.click();
    await historyAction.click();
    const reopenedHistoryPanel = page.getByRole("dialog", { name: "对话记录" });
    const activeHistoryItem = reopenedHistoryPanel.locator(".companion-thread-item.is-active");
    const activeHistoryRow = activeHistoryItem.locator(".companion-thread-open");
    await expect(activeHistoryRow).toHaveCSS("background-image", "none");
    await expect(activeHistoryRow).toHaveCSS("box-shadow", "none");
    await expect(activeHistoryRow).toHaveCSS("border-radius", "0px");
    await expect(activeHistoryItem, "对话详情彩带应常驻").toHaveCSS("overflow", "hidden");
    const persistentRibbon = await activeHistoryItem.evaluate((item) => getComputedStyle(item, "::before").opacity);
    expect(Number(persistentRibbon)).toBeGreaterThan(0.7);
    await activeHistoryItem.getByRole("button", { name: /收藏会话：调整本周算法计划|取消收藏会话：调整本周算法计划/ }).click();
    await activeHistoryItem.getByRole("button", { name: "删除会话：调整本周算法计划" }).click();
    await expect(activeHistoryItem.getByRole("button", { name: "确认删除" })).toBeVisible();
    await activeHistoryItem.getByRole("button", { name: "确认删除" }).click();
    await expect(reopenedHistoryPanel.getByText("调整本周算法计划", { exact: true })).toHaveCount(0);
    const historyPanelBounds = await historyPanel.boundingBox();
    expect(historyPanelBounds?.y).toBeGreaterThanOrEqual(12);
    expect((historyPanelBounds?.y ?? 0) + (historyPanelBounds?.height ?? 0)).toBeLessThanOrEqual(784);
    await page.keyboard.press("Escape");
    await trigger.press("ArrowDown");

    const menu = page.getByRole("listbox", { name: "选择本轮聚焦目标" });
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("长期观察始终参与");
    await expect(menu.getByRole("option", { name: /不限目标/ })).toHaveAttribute("aria-selected", "true");
    await expect(menu.getByRole("option", { name: /掌握 Python 数据分析/ })).toBeVisible();
    await expect(menu.getByRole("option", { name: /研究生英语二 80 分冲刺/ })).toBeVisible();
    await expect(menu).toContainText("不会修改长期画像或自动调整计划");
    await menu.getByRole("option", { name: /掌握 Python 数据分析/ }).click();
    await expect(trigger).toContainText("掌握 Python 数据分析");
    await trigger.press("ArrowDown");
    await expect(menu.getByRole("option", { name: /掌握 Python 数据分析/ })).toHaveAttribute("aria-selected", "true");
    await menu.getByRole("option", { name: /不限目标/ }).click();
    await expect(trigger).toContainText("不限目标");
    await trigger.press("ArrowDown");
    const goalContext = page.locator(".companion-goal-menu-context");
    await expect(goalContext.locator("strong")).toHaveCSS("font-size", "14px");
    await expect(goalContext.locator("small")).toHaveCSS("font-size", "12px");
    await expect(goalContext.locator("svg")).toHaveCSS("width", "18px");
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await page.setViewportSize({ width: 375, height: 667 });
    await trigger.press("ArrowDown");
    await expect.poll(async () => {
      const bounds = await menu.boundingBox();
      return (bounds?.x ?? 0) + (bounds?.width ?? 0);
    }).toBeLessThanOrEqual(375);
    const menuBounds = await menu.boundingBox();
    expect(menuBounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((menuBounds?.x ?? 0) + (menuBounds?.width ?? 0)).toBeLessThanOrEqual(375);
    await page.keyboard.press("Escape");
    await historyAction.click();
    const mobileHistoryPanel = page.getByRole("dialog", { name: "对话记录" });
    const mobileHistoryBounds = await mobileHistoryPanel.boundingBox();
    expect(mobileHistoryBounds?.x).toBe(0);
    expect(mobileHistoryBounds?.width).toBe(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    await expect(mobileHistoryPanel.locator(".companion-history-scroll")).toHaveCSS("overflow-y", "auto");
  });

  test("light coach controls keep contrast and history scrollbar only appears while scrolling", async ({ page }) => {
    await page.getByRole("button", { name: "打开 Pilo 设置" }).click();
    const settings = page.getByRole("dialog", { name: "Pilo 设置" });
    await expect(settings.locator(".companion-settings-section__toggle small").first()).toHaveCSS("color", "rgb(90, 75, 193)");
    await expect(settings.getByRole("radio", { name: /温暖平和/ }).locator("i")).toHaveCSS("background-color", "rgb(90, 75, 193)");
    await settings.getByRole("button", { name: "关闭 Pilo 设置" }).click();

    const focusTrigger = page.getByRole("button", { name: /本轮聚焦：/ });
    await focusTrigger.click();
    const goalContext = page.locator(".companion-goal-menu-context");
    await expect(goalContext.locator("strong")).toHaveCSS("font-size", "14px");
    await expect(goalContext.locator("small")).toHaveCSS("font-size", "12px");
    await expect(goalContext.locator("svg")).toHaveCSS("width", "18px");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "查看历史会话" }).click();
    const historyScroll = page.getByRole("dialog", { name: "对话记录" }).locator(".companion-history-scroll");
    await expect(historyScroll).not.toHaveClass(/is-scrolling/);
    await expect(historyScroll).toHaveCSS("scrollbar-color", "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
    await historyScroll.evaluate((element) => element.dispatchEvent(new Event("scroll", { bubbles: true })));
    await expect(historyScroll).toHaveClass(/is-scrolling/);
    await expect(historyScroll).toHaveCSS("scrollbar-color", "rgba(139, 125, 246, 0.58) rgba(0, 0, 0, 0)");
    await expect(historyScroll).not.toHaveClass(/is-scrolling/, { timeout: 1_500 });
  });

  test("themes drawers with the pull-cord and lifts night conversation contrast", async ({ page }) => {
    const workspace = page.locator(".companion-workspace");
    await expect(workspace).toHaveClass(/is-light/);
    const commandbar = page.locator(".companion-commandbar");
    await expect(commandbar).toHaveCSS("border-color", "rgba(117, 103, 248, 0.42)");
    await expect(commandbar).toHaveCSS("background-image", /linear-gradient/);
    await expect(commandbar.locator(".companion-brand-copy > strong")).toHaveCSS("color", "rgb(23, 35, 58)");
    await expect(page.locator(".companion-commandbar")).toHaveCSS("border-radius", "18px");

    await page.getByRole("button", { name: "查看历史会话" }).click();
    const lightHistory = page.getByRole("dialog", { name: "对话记录" });
    await expect(lightHistory).toHaveClass(/is-light/);
    await expect(lightHistory).toHaveCSS("color", "rgb(38, 51, 74)");
    await expect(lightHistory).toHaveCSS("border-color", "rgba(73, 89, 116, 0.16)");
    await lightHistory.getByRole("button", { name: "展开更早的历史会话" }).click();
    await lightHistory.getByRole("combobox", { name: "选择历史会话年份" }).click();
    const lightDateMenu = page.locator(".companion-history-date-menu.is-light");
    await expect(lightDateMenu).toBeVisible();
    await expect(lightDateMenu).toHaveCSS("color", "rgb(38, 51, 74)");
    await expect(lightDateMenu).toHaveCSS("border-color", "rgba(56, 73, 101, 0.18)");
    await lightDateMenu.getByRole("option").first().click();
    await lightHistory.getByLabel("关闭历史会话").click();

    await page.getByRole("button", { name: "打开 Pilo 设置" }).click();
    const lightSettings = page.getByRole("dialog", { name: "Pilo 设置" });
    await expect(lightSettings).toHaveClass(/is-light/);
    await expect(lightSettings.locator(".companion-settings-section__toggle").first()).toHaveCSS("color", "rgb(38, 51, 74)");
    await lightSettings.getByLabel("关闭 Pilo 设置").click();

    await page.getByRole("button", { name: /查看依据/ }).click();
    const lightContext = page.getByRole("dialog", { name: "依据来源" });
    await expect(lightContext).toHaveClass(/is-light/);
    await expect(lightContext.locator(".companion-context-scope > strong")).toHaveCSS("color", "rgb(28, 41, 64)");
    await lightContext.getByLabel("关闭依据来源").click();

    await page.getByRole("button", { name: "拉灯切换到深色模式" }).click();
    await expect(workspace).toHaveClass(/is-dark/);
    await expect(page.getByText("理解你的学习，陪你走得更远", { exact: true })).toBeVisible();
    await expect(page.locator(".companion-commandbar")).toHaveCSS("border-color", "rgba(139, 229, 197, 0.62)");
    expect(await page.locator(".companion-commandbar").evaluate((element) => getComputedStyle(element).boxShadow)).toContain("rgba(139, 229, 197");
    await expect(page.locator(".companion-input-dock")).toHaveCSS("background-image", "none");
    await expect(page.locator(".companion-prompt-label")).toHaveCSS("color", "rgb(196, 206, 222)");
    await expect(page.locator(".companion-prompt-chips > button").first()).toHaveCSS("color", "rgb(214, 222, 234)");
    await expect(page.getByLabel("给 Pilo 发送消息")).toHaveCSS("color", "rgb(242, 245, 250)");

    await page.getByRole("button", { name: "查看历史会话" }).click();
    const darkHistory = page.getByRole("dialog", { name: "对话记录" });
    await expect(darkHistory).toHaveClass(/is-dark/);
    await expect(darkHistory).toHaveCSS("color", "rgb(238, 242, 251)");
    await expect(darkHistory).toHaveCSS("border-color", "rgba(190, 201, 222, 0.2)");
    await expect(darkHistory.getByPlaceholder("搜索问题、Pilo 反馈或关联内容")).toHaveCSS("font-size", "12px");
    await expect(darkHistory.getByRole("button", { name: "仅看收藏会话" })).toHaveCSS("font-size", "12px");
  });
});
