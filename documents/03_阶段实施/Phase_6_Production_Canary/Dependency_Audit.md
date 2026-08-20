# Phase 6 Dependency Audit

检查日期：2026-07-30。

## 生产依赖

```text
npm audit --omit=dev
0 vulnerabilities
```

生产镜像只安装 production dependencies，当前无已知 npm 漏洞。

## 开发依赖

`npm audit` 报告 13 个 high，无 critical。依赖链为 ESLint 8 / `eslint-config-next` 工具链，主要经过 `minimatch → brace-expansion` 以及 `flat-cache → rimraf → glob`。它们不会进入 `npm run start` 的生产依赖集。

## 决策

本阶段不执行 `npm audit fix --force`，也不升级 Next.js / ESLint 主版本。原因是强制修复需要改变 lint CLI 和规则基线，属于独立的破坏性工具链升级。

后续计划：

1. 在独立分支将 `next lint` 迁移为 ESLint CLI。
2. 升级 ESLint 与 `eslint-config-next` 的兼容组合，不单独 override 间接包。
3. 重跑 lint、production build、Playwright 和完整 audit。
4. 只在回归通过后合并，期间保留当前 lockfile 作为可回滚基线。
