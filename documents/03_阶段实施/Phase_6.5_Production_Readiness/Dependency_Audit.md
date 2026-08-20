# Dependency Audit Report

审计日期：2026-07-30。

## 决策

生产依赖以 `npm audit --omit=dev` 为门禁；开发依赖告警单独记录，不为清零数字强制升级 Next.js / ESLint 主版本。

| 范围 | 结论 | 处理 |
|---|---|---|
| 生产依赖 | 0 vulnerabilities | 允许生产构建 |
| 开发工具链 | 13 high | 暂缓破坏性升级 |

`npm audit` 报告的包为 `@eslint/eslintrc`、`@humanwhocodes/config-array`、`brace-expansion`、`eslint`、`eslint-config-next`、`eslint-plugin-import`、`eslint-plugin-jsx-a11y`、`eslint-plugin-react`、`file-entry-cache`、`flat-cache`、`glob`、`minimatch` 和 `rimraf`。这些告警来自 lint/build/dev toolchain，不进入 `npm run start` 的生产运行依赖图。当前生产镜像使用 multi-stage build，只把 standalone runtime 与静态资源带入运行层。

## 暂缓原因与升级计划

强制修复需要 Next.js/ESLint 生态主版本变更，可能影响 App Router、ESLint config 和构建输出。后续在独立分支中执行：升级矩阵确认 → codemod → lint/build/E2E → Docker 镜像扫描 → Canary；不得与 Agent 发布混在同一变更窗口。
