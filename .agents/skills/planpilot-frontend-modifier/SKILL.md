---
name: planpilot-frontend-modifier
description: Modify, redesign, debug, and visually verify the active PlanPilot product frontend while preserving its product semantics, theme system, interaction boundaries, and established user preferences. Use for PlanPilot UI/UX changes, screenshot-driven alignment, responsive layout work, theme or CSS fixes, component refactors, loading or empty states, Pilo interactions, settings pages, notes, goals, knowledge, dashboard, and frontend visual regressions under frontend/.
---

# Modify the PlanPilot Frontend

Implement frontend changes against the current product, not a remembered or archived version. Treat rendered behavior and visual evidence as the acceptance surface.

## Load project context

1. Read `frontend/README.md` and the files named in the request.
2. Read [references/project-map.md](references/project-map.md) before choosing routes, stylesheets, tokens, or tests.
3. Read [references/design-preferences.md](references/design-preferences.md) for visual, interaction, and product rules.
4. Inspect `git status --short`. Preserve unrelated and pre-existing changes.
5. If the request includes screenshots, inspect every image before editing. Separate structural requirements from stylistic references.

## Understand before editing

Translate the request into a short internal acceptance list:

- Identify the affected page, object, action, and scope.
- Decide what is primary, secondary, interactive, status-only, or destructive.
- Resolve whether an action belongs to the page, a selected item, a goal, or the global shell.
- Distinguish an explicit user requirement from an optional suggestion. Do not remove a requested feature merely because another feature appears redundant.
- Inspect current rendered behavior or existing tests when the request refers to what the user sees.

Explain the interpretation briefly in commentary when the user explicitly asks to “先理解再做” or when semantics determine the layout. Continue implementation unless a missing decision would materially change the result.

## Find the real implementation layer

1. Search with `rg` from `frontend/`; do not assume a selector, route, or component is still active.
2. Follow the stylesheet import order in `app/(technology)/studio/layout.tsx`.
3. Check later selectors, specificity, media queries, theme attributes, and inline styles before adding overrides.
4. Reuse existing components, design tokens, title cards, tags, button patterns, and page geometry when the user asks for consistency.
5. Modify the actual text or control node when a global rule overrides a wrapper. Verify computed styles after editing.
6. Keep structural code in TSX and shared visual rules in the narrowest existing stylesheet. Avoid accumulating emergency overrides at the end of unrelated CSS files.

## Design the change

Apply these priorities in order:

1. Preserve task flow and product meaning.
2. Establish hierarchy with content order, typography, spacing, and contrast.
3. Reduce visual containers and decoration.
4. Keep controls close to the values or objects they affect.
5. Preserve theme and responsive behavior.
6. Add motion only when it explains state or interaction.

Prefer one clear primary action. Use progressive disclosure for evidence, advanced settings, and AI reasoning. Keep dense pages bounded with internal scrolling when their neighboring PlanPilot pages use a fixed workspace bottom.

## Implement safely

- Preserve React, TypeScript, accessibility semantics, keyboard focus, reduced motion, and existing data flows.
- Keep theme identity in tokens, materials, and accents; do not change layout or information architecture between themes.
- Use semantic colors consistently. Reserve red for destructive actions and errors; keep success, warning, accent, disabled, and text roles distinct.
- Maintain touch targets even when the visible icon or capsule becomes visually compact.
- Add empty, loading, saving, success, failure, and retry states when a changed async flow needs them.
- For AI or Pilo features, show previews and require confirmation before changing tasks, dates, plans, notes, goals, or learner memory.
- Never fake a working backend feature with an enabled-looking control. State whether a preference is local or synchronized.

## Verify the result

Use verification proportional to the change, but never skip actual rendering for visual work.

1. Run targeted TypeScript and ESLint checks.
2. Run the nearest Playwright test; add or update a focused test for behavior that could regress.
3. Open the correct development URL from `frontend/playwright.config.ts` or the active process. Confirm it serves current source rather than an old Docker or Next.js instance.
4. Inspect the changed state at desktop width and at 375px when the surface is user-facing.
5. Capture or inspect screenshots and check alignment, hierarchy, clipping, overflow, scroll boundaries, focus, hover, open/closed states, and theme variants affected by the change.
6. Read computed styles or element geometry for exact font sizes, gaps, and alignment requests. Do not infer visual success from CSS source alone.
7. Run a production build for cross-route, theme, or shared-shell changes when practical.

If the rendered page is stale, first confirm the active port and source. Clear `.next` or restart services only when evidence points to stale output; do not treat cache clearing as a substitute for fixing CSS.

## Report honestly

Lead with what changed. Mention the exact behavior, files, verification performed, and current URL when useful. Include a screenshot for material visual changes. Distinguish new failures from pre-existing failures and never claim visual completion before inspecting the rendered result.
