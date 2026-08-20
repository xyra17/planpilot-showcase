# Dependency Audit

审计日期：2026-07-30

## Production dependency audit

命令：

```bash
npm audit --omit=dev
```

结果：

```text
0 vulnerabilities
81 production dependencies
```

## Development dependency audit

完整 `npm audit`：13 high，0 critical。

风险链集中于：

- `eslint` / `eslint-config-next`
- `minimatch` / `brace-expansion`
- `file-entry-cache` / `flat-cache`
- `rimraf` / `glob`
- ESLint React、Import、JSX A11y plugins

## Decision

Deferred，不在 Phase 4.5 强制升级。

原因：

- 受影响包仅用于 lint/build/dev，不包含在 standalone production runtime 中。
- 生产依赖审计为 0。
- npm 给出的自动修复要求 ESLint 10 或 Next 16 主版本升级，会改变现有 Next 15 lint 配置和兼容边界。
- 以覆盖版本强行提升 `minimatch` 会跨越其调用 API 主版本，存在破坏 ESLint 工具链的风险。

## Control

- 生产镜像继续使用 multi-stage build，只复制 `.next/standalone` 和静态产物。
- CI 分别执行 production audit 与完整 audit；前者作为发布门禁，后者作为跟踪项。
- Next/ESLint 主版本升级必须独立执行兼容性测试，不能只为清零 audit 数字合入。
