# PlanPilot product frontend

This is the active PlanPilot product frontend. It maintains one complete UI:
the technology workspace under `/studio/*`.

Its routes, components, data adapters and visual tokens live in
`app/(technology)`, `components/technology`, `lib/technology` and
`styles/technology`. Material themes (`base`, `notebook`, `dark`) and accent
colors are appearance layers inside the same technology layout.

The former minimal frontend and its `/work`, `/coach` and `/settings` routes
were removed from the runtime tree on 2026-08-08. A source-only recovery copy is
kept in `../archive/frontend-minimal-2026-08-08` and must not be imported by
active frontend code.

The root product route and post-login flow both enter `/studio/work`. Docker
Compose builds this directory only.
