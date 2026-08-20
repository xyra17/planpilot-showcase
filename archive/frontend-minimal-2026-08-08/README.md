# 简约型前端归档

归档日期：2026-08-08

本目录保存 PlanPilot 已退出运行入口的简约型前端。当前产品只维护 `/studio/*` 科技型工作台；归档内容不会参与 Next.js 路由、类型检查或生产构建。

## 已归档内容

- `routes/product`：原 `/work`、`/coach`、`/settings` 产品路由包装层。
- `routes/dashboard`：原简约型页面实现。
- `components`：只被简约型页面使用，或经依赖检查确认没有活动引用的组件。
- `lib`：旧全局主题运行时与简约型调色板定义。
- `e2e`：只验证旧 `/work` 页面结构的端到端用例。
- `styles/globals-before-minimal-archive.css`：清理前的完整全局样式快照。
- `styles/*-before-minimal-theme-prune.css`：移除 `eye-care / minimal` 主题分支前的科技样式快照。

目标详情页和管理端智能体操作页原先位于旧路由树，但仍是活动功能，因此已分别迁移到：

- `frontend/app/(technology)/studio/work/goals/[id]`
- `frontend/app/(admin)/admin/_components/AgentOperationsPage.tsx`

## 恢复说明

如需恢复简约型前端，应建立独立分支，将路由与组件移回 `frontend`，再恢复对应样式快照和 `/work` 入口。不要直接从本归档目录建立跨目录运行时导入，否则归档会重新进入构建依赖图。
