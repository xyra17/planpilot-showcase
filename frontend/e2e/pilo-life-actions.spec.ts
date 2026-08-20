import { expect, test, type Page } from "@playwright/test";

async function dismissKnowledgeGuestIntro(page: Page) {
  const dialog = page.getByRole("dialog", { name: "访客模式" });
  try {
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByRole("button", { name: "继续浏览" }).click();
  } catch {
    // Authenticated runs do not show the guest contract.
  }
}

const LIFE_ACTIONS = [
  ["tea-break", "resting", "none"],
  ["capture-idea", "working", "glasses"],
  ["check-timer", "checking", "none"],
  ["tidy-desk", "checking", "glasses"],
  ["nurture-growth", "success", "wristwarmers"],
  ["relief", "resting", "none"],
  ["nap", "resting", "none"],
  ["sign-off", "greeting", "none"],
] as const;

test.describe("Pilo supplemental life actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.addInitScript(() => {
      window.localStorage.setItem("pp-pilo-preferences-v2", JSON.stringify({
        activity: "docked",
        mode: "balanced",
        outfit: "auto",
        outfitDefaultVersion: 2,
        particles: false,
        initiative: "balanced",
        features: { lifestyleStates: true, contextAwareness: true, adaptiveTiming: true },
        quietHours: { enabled: false, start: 22, end: 8 },
        home: { x: 0, y: 0 },
        pausedUntil: 0,
      }));
    });
    await page.goto("/studio/work?piloDebug=1&piloSeed=81");
    await expect(page.locator(".pilo-companion")).toBeVisible();
  });

  test("loads all eight actions and keeps one unscaled pose through phase changes", async ({ page }) => {
    const companion = page.locator(".pilo-companion");
    const avatar = companion.locator(".pilo-avatar");

    for (const [lifeAction, state, accessory] of LIFE_ACTIONS) {
      await page.evaluate(({ action, nextState, nextAccessory }) => {
        window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
          detail: {
            state: nextState,
            layer: "system",
            source: "system:life-action-test",
            reason: `验收生活动作：${action}`,
            duration: 30_000,
            accessory: nextAccessory,
            lifeAction: action,
          },
        }));
      }, { action: lifeAction, nextState: state, nextAccessory: accessory });

      await expect(companion).toHaveAttribute("data-pilo-life-action", lifeAction);
      await expect(avatar).toHaveAttribute("data-pilo-life-action", lifeAction);
      await expect(companion.locator(".pilo-avatar__pose")).toHaveCount(1);
      await expect.poll(async () => companion.locator(".pilo-avatar__pose img").evaluate((image) => (
        image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
      ))).toBe(true);

      await page.waitForTimeout(620);
      await expect(companion).toHaveAttribute("data-pilo-phase", "holding");
      const frame = Number(await avatar.getAttribute("data-pilo-frame"));
      expect([3, 4, 5, 6]).toContain(frame);
      const geometry = await companion.locator(".pilo-avatar__body").evaluate((body) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(body).transform);
        return { scaleX: matrix.a, scaleY: matrix.d, poseCount: body.querySelectorAll(".pilo-avatar__pose").length };
      });
      expect(geometry).toEqual({ scaleX: 1, scaleY: 1, poseCount: 1 });
    }
  });

  test("uses generated actions for note capture without leaking scene art into the floating Pilo", async ({ page }) => {
    await page.goto("/studio/work/notes?piloSeed=81");
    await page.getByRole("button", { name: "新建笔记" }).click();
    await expect(page.locator(".pilo-companion")).toHaveAttribute("data-pilo-life-action", "capture-idea");

    await page.reload();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-scene", { detail: { scene: "lunch" } })));
    const companion = page.locator(".pilo-companion");
    await expect(companion).toHaveAttribute("data-pilo-scene", "lunch");
    await expect(companion).toHaveAttribute("data-pilo-life-action", "none");
    await companion.locator(".pilo-scene").getByRole("button", { name: /关闭/ }).click();
    await expect(companion).toHaveAttribute("data-pilo-scene", "none");
    await expect(companion).not.toHaveAttribute("data-pilo-phase", "leaving");
    await expect(companion.locator(".pilo-companion__pet .pilo-avatar")).toHaveAttribute("data-pilo-life-action", "none");
  });

  test("plays nurture growth once and keeps the finished watering pose", async ({ page }) => {
    const companion = page.locator(".pilo-companion");
    const avatar = companion.locator(".pilo-avatar");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
      detail: {
        state: "success",
        layer: "system",
        source: "system:nurture-once-test",
        duration: 10_000,
        accessory: "wristwarmers",
        lifeAction: "nurture-growth",
      },
    })));

    await expect(companion).toHaveAttribute("data-pilo-life-action", "nurture-growth");
    await expect(companion).toHaveAttribute("data-pilo-phase", "holding");
    await expect(avatar).toHaveAttribute("data-pilo-frame", "5");
    await page.waitForTimeout(700);
    await expect(avatar).toHaveAttribute("data-pilo-frame", "5");
  });

  test("does not perform a life action from navigation alone", async ({ page }) => {
    for (const path of ["/studio/work/notes", "/studio/work/knowledge", "/studio/work/goals"]) {
      await page.goto(`${path}?piloSeed=81`);
      if (path.includes("knowledge")) await dismissKnowledgeGuestIntro(page);
      await expect(page.locator(".pilo-companion")).toHaveAttribute("data-pilo-life-action", "none");
      await page.waitForTimeout(2_400);
      await expect(page.locator(".pilo-companion")).toHaveAttribute("data-pilo-life-action", "none");
    }
  });

  test("releases a goal action while navigating to notes", async ({ page }) => {
    const companion = page.locator(".pilo-companion");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
      detail: {
        state: "success",
        layer: "system",
        source: "context:goals:completed",
        duration: 10_000,
        accessory: "wristwarmers",
        lifeAction: "nurture-growth",
      },
    })));
    await expect(companion).toHaveAttribute("data-pilo-life-action", "nurture-growth");
    await page.goto("/studio/work/notes?piloSeed=81");
    await expect(companion).toHaveAttribute("data-pilo-life-action", "none");
    await page.waitForTimeout(1_200);
    await expect(companion).toHaveAttribute("data-pilo-life-action", "none");
  });

  test("uses object activity instead of route entry to select life actions", async ({ page }) => {
    const companion = page.locator(".pilo-companion");
    await page.goto("/studio/work/notes?piloSeed=81");
    await expect(companion).toHaveAttribute("data-pilo-life-action", "none");

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-context", {
      detail: { kind: "object-opened", surface: "notes", objectId: "note-qa", objectTitle: "测试笔记" },
    })));
    await expect(companion).toHaveAttribute("data-pilo-life-action", "none");

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-context", {
      detail: { kind: "editing", surface: "notes", objectId: "note-qa", objectTitle: "测试笔记" },
    })));
    await expect(companion).toHaveAttribute("data-pilo-life-action", "capture-idea");

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-context", {
      detail: { kind: "object-opened", surface: "knowledge", objectId: "resource-qa", objectTitle: "测试资料" },
    })));
    await expect(companion).toHaveAttribute("data-pilo-life-action", "read");
    await expect(companion).toHaveAttribute("data-pilo-phase", "holding", { timeout: 1_500 });
  });

  test("suspends Pilo for the guest edit gate and resumes reading", async ({ page }) => {
    await page.goto("/studio/work/knowledge?piloSeed=81");
    await dismissKnowledgeGuestIntro(page);
    const companion = page.locator(".pilo-companion");
    await page.getByRole("button", { name: /RAG 检索增强生成\.md Markdown/ }).click();
    await expect(page.getByRole("dialog", { name: /RAG 检索增强生成\.md 预览/ })).toBeVisible();
    await expect(companion).toBeVisible();
    await expect(companion).toHaveAttribute("data-pilo-life-action", "read");

    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const editGate = page.getByRole("dialog", { name: "继续使用完整知识空间" });
    await expect(editGate).toBeVisible();
    await expect(companion).toHaveCount(0);
    await editGate.getByRole("button", { name: "继续浏览" }).click();
    await expect(companion).toHaveAttribute("data-pilo-state", "reading");
    await expect(companion).toHaveAttribute("data-pilo-life-action", "read");
    await expect(companion).toHaveAttribute("data-pilo-phase", "holding", { timeout: 1_500 });
  });

  test("sign off waves once and settles with its hand lowered", async ({ page }) => {
    const companion = page.locator(".pilo-companion");
    const avatar = companion.locator(".pilo-avatar");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("planpilot:pilo-state", {
      detail: { state: "greeting", layer: "system", source: "system:sign-off-test", duration: 10_000, lifeAction: "sign-off" },
    })));
    await expect(companion).toHaveAttribute("data-pilo-life-action", "sign-off");
    await expect(companion).toHaveAttribute("data-pilo-phase", "holding");
    await expect(avatar).toHaveAttribute("data-pilo-frame", "6", { timeout: 1_800 });
    await page.waitForTimeout(600);
    await expect(avatar).toHaveAttribute("data-pilo-frame", "6");
  });
});
