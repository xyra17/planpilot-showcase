# PlanPilot design and interaction preferences

These rules summarize recurring decisions from PlanPilot task history. Apply them as defaults, not as replacements for an explicit current request.

## Visual hierarchy and density

- Avoid “盒子套盒子”: do not stack background, border, shadow, and nested cards when spacing or a divider can express the same grouping.
- Preserve a continuous flow from heading or tab to its content. Do not insert unrelated banners between a section label and its list.
- Make names and current objects primary; make counts, dates, descriptions, and status metadata visibly secondary.
- Keep related controls near the value or card they affect. Align icon actions with their corresponding text baseline or edge.
- Prefer compact, flat rows for settings and metadata. Use one item per row when the content is scanned vertically.
- Use a constrained content width on wide screens. Avoid making users scan from the far left label to a far right action.
- Bound long workspaces and use internal scroll regions instead of allowing one page to grow indefinitely.
- Increase readability through contrast before adding saturation, heavy shadows, borders, or larger type.

## Consistency

- Reuse the exact established component or selector when asked to match another PlanPilot page; do not approximate dimensions by eye.
- The same entity should use the same tag, title card, count treatment, icon position, and state language across filtered and unfiltered views.
- Themes may change palette, surface material, texture, and restrained motion. Core layout, icon placement, navigation geometry, content order, and Chinese typography must remain stable.
- Preserve layout details explicitly requested by the user even when a different design might also be defensible.

## Color and material

- Avoid generic pale-purple SaaS styling and excessive low-contrast gray-on-gray surfaces.
- Use the configured accent globally and coherently. Do not leave stale blue, red, or violet accents in global navigation, hover states, headings, or lead cards.
- Reserve red for errors and destructive actions. A destructive icon may remain red without a permanent red block when the user wants a lighter treatment.
- Use green for success, warning colors for attention, the accent for interaction, and gray for disabled states.
- Notebook mode should feel like a low-saturation paper system, but must retain module separation and readable Chinese type. Do not turn it into a modern UI with a paper texture pasted behind it.

## Interaction and state

- Add hover, active, focus-visible, disabled, and reduced-motion behavior to interactive controls.
- Keep the visible control compact when requested while preserving an adequate hit target.
- Make saving behavior explicit: saving, saved, failure, and retry.
- Replace unexplained disabled controls with a useful next action or reason. Never present local-only behavior as account synchronization.
- For data-heavy pages, design empty, loading, error, and overflow states along with the normal state.
- Validate menus, drawers, dialogs, filters, scrolling, and state transitions—not only the resting screenshot.

## Pilo and AI boundaries

- Treat Pilo as a contextual learning-assistance layer, not a duplicate navigation or CRUD toolbar.
- Keep Pilo's cross-goal, long-term observation as an always-on context layer rather than a selectable peer of goal focus. The compact top-bar control belongs to the current conversation and lets the user choose only the round focus: no specific goal or one active goal. Explain this layering inside the opened menu without consuming conversation space.
- Do not render a generic learning-observation card merely because long-term patterns exist. Show it on a direct coach entry, an observation-triggered entry, or when the source intent explicitly asks to inspect learning judgments; object actions from notes, knowledge, and goals should lead with that object and use long-term patterns silently unless they are relevant to the requested action.
- Keep at most two high-value contextual actions plus an entry to full conversation in the left-click panel.
- Permanent actions must remain useful whenever that context is active. Conditional suggestions require clear evidence.
- Never navigate automatically because a suggestion appeared. Let the user click, carry structured context and a return route, then show the source and reason in the coach page.
- Keep success feedback and recoverable page errors on the current page. Route reasoning, comparison, explanation, and plan generation to the learning partner.
- Require user confirmation before AI changes tasks, dates, plans, goals, notes, or long-term learner memory.
- Do not hide or remove Pilo simply because a page has another AI entry point unless the user explicitly approves that behavior.

## Acceptance habits learned from prior iterations

- Inspect the actual screenshot or rendered page before declaring completion.
- When typography or spacing “does not change,” find the rule affecting the real text node and inspect the computed value.
- Measure alignment and page geometry for exact requests; do not rely on visual guesswork.
- Check current-source ports before testing. Port 3000 has previously served an old Docker build while source ran on 3001.
- Test with enough list items to expose overflow and scrolling problems.
- Check desktop and 375px layouts for user-facing changes.
- If the user supplies a reference image, preserve the requested PlanPilot structure and transfer only the intended style or material cues.
- Do not fake a flat hierarchy by merely reducing borders, backgrounds, or font sizes on nested controls. A date/filter row inside an expanded section must read as one continuous control surface, with clearly larger primary labels and quieter values—not several miniature cards inside a larger card.
- Do not use an unstyled native select when the opened menu is part of the requested visual experience. Design and verify the trigger, floating option panel, selected state, hover/focus state, typography hierarchy, motion, and narrow-screen behavior together.
- When the user approves a distinctive state cue—such as a short mint rail on the current date—preserve that cue in later refinements. Improve its contrast or motion without silently replacing its visual identity.
