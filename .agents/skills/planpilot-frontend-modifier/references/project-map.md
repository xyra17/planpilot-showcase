# PlanPilot frontend project map

## Active application

- Work in `frontend/`. It is the active Next.js 15, React 18, TypeScript product frontend.
- The product workspace lives under `/studio/*`.
- Do not import from `archive/frontend-minimal-2026-08-08`, old `frontend2` paths mentioned in historical tasks, `website/`, backup ZIPs, generated `.next*` folders, or design mockups unless the user explicitly asks to recover or compare them.
- Root and post-login product entry points lead to `/studio/work`.

## Important locations

- Routes: `frontend/app/(technology)/studio/`
- Product shell and providers: `frontend/components/technology/`
- Shared app shell: `frontend/components/app/` and `frontend/components/shell/`
- Domain adapters and context: `frontend/lib/technology/`
- Product styles: `frontend/styles/technology/`
- Shared primitives: `frontend/components/ui/`
- Browser tests: `frontend/e2e/`
- Playwright configuration: `frontend/playwright.config.ts`

## Styling cascade

The technology layout imports styles in this order:

1. `base.css`
2. `product-redesign.css`
3. `theme-experiences.css`
4. `usability.css`
5. domain workspaces: goal, notes, knowledge, companion, settings
6. `settings-task-redesign.css`
7. `theme-coherence.css`

Later files can override earlier files. Inspect all matching selectors and computed styles before adding a new rule. `theme-coherence.css` intentionally stabilizes Chinese typography across dark and notebook themes.

## Theme model

`ThemeProvider.tsx` applies `data-surface-theme`, `data-theme`, and `data-accent` to the document element.

- Surface themes: `base`, `dark`, `notebook`
- Default/dark accents: `violet`, `ocean`, `forest`
- Notebook accents: `wood`, `slate`, `newspaper`, `wheat`, `night`
- Theme selection may be stored locally and synchronized for authenticated users.

Prefer workspace variables such as `--workspace-text`, `--workspace-secondary`, `--workspace-accent`, `--workspace-hover`, `--workspace-panel`, and `--workspace-border`. An accent change must remain coherent across navigation, hover, headings, dashboard leads, and controls rather than recoloring one button.

## Interaction stack

- Radix UI primitives provide dialogs, dropdowns, selects, tabs, tooltips, and other accessible controls.
- `motion` is available for purposeful animation.
- Tiptap powers rich-text editing. Avoid dependency-version changes unless the editor itself requires them.
- Playwright defaults to `http://127.0.0.1:3000`; override with `PLANPILOT_WEB_URL` when current source runs elsewhere.

## Verification routing

Choose the closest existing E2E suite:

- dashboard/today: `technology-dashboard-lead.spec.ts`, `day-scheduler.spec.ts`
- goals: `technology-goals.spec.ts`
- knowledge: `technology-knowledge-workspace.spec.ts`
- notes: `technology-notes.spec.ts`
- Pilo: `pilo-life-actions.spec.ts`, `pilo-state-system.spec.ts`
- auth/onboarding: corresponding auth, registration, recovery, and onboarding specs

Use a targeted test first. Shared shell, theme, authentication, or route changes justify broader checks.
