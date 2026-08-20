# PlanPilot 文档中心

本目录按“产品定位 → 架构规格 → 阶段实施 → 产品体验 → 工程审计 → 运维部署 → 历史归档”分类。真实代码和数据库迁移始终优先于历史设计文档；阶段完成报告用于说明对应时间点的实现状态。

## 目录导航

| 分类 | 内容 | 推荐入口 |
|---|---|---|
| [01 产品与项目](./01_产品与项目/README.md) | 产品定位、市场场景、0→1 技术路线 | [PlanPilot 0→1 技术开发文档](./01_产品与项目/PlanPilot%200→1%20技术开发文档.md) |
| [02 架构与技术规格](./02_架构与技术规格/README.md) | 总体架构、ADR、模块规格、测试体系、模型路由 | [技术规格说明书 Part 1](./02_架构与技术规格/技术规格说明书/技术规格说明书_Part1_概览与目录树.md) |
| [03 阶段实施](./03_阶段实施/README.md) | Phase 2～6.9 的设计、实施和完成报告 | [阶段索引](./03_阶段实施/README.md) |
| [04 前端与体验](./04_前端与体验/README.md) | Agent 工作台、交互实施报告、视觉参考 | [前端与体验索引](./04_前端与体验/README.md) |
| [05 工程审计](./05_工程审计/README.md) | Agent、知识库、模型链路和评测验收报告 | [工程审计索引](./05_工程审计/README.md) |
| [06 运维与部署](./06_运维与部署/README.md) | 环境搭建、模型供应商切换、完整卸载 | [环境搭建与启动指南](./06_运维与部署/PlanPilot_环境搭建与启动指南.md) |
| [07 归档](./07_归档/README.md) | 已过期 backlog 和历史测试报告 | [归档说明](./07_归档/README.md) |

## 当前主线

```text
Phase 2：Event / Pattern / Profile / Proposal
  → Phase 3：Production Hardening / Runtime / Scheduling
  → Phase 4：Cognitive / Memory / Adaptive Planning / Knowledge Intelligence
  → Phase 4.5：Dependency / Time / Database / Calibration Hardening
  → Phase 5：Versioning / Evaluation / Experiment / Feedback / Monitoring / Rollback
  → Phase 6：Offline Gate / Canary / Model Gateway / Calibration
  → Phase 6.5：Distributed Runtime / Timezone / Observation / Agent Trace
  → Phase 6.8：Frontend Product Architecture / User-Coach-Admin Separation
  → Phase 6.9：Theme Isolation / Per-style Palette / Admin Theme Boundary
```

当前最新阶段报告：

- [Phase 6.9 README](./03_阶段实施/Phase_6.9_Theme_Isolation/README.md)
- [Phase 6.9 Theme Architecture](./03_阶段实施/Phase_6.9_Theme_Isolation/Theme_Architecture.md)

## 阅读建议

- 产品或业务背景：先读 `01_产品与项目`。
- 新开发者接管：依次阅读本页、环境搭建指南、技术规格说明书和最新 Phase 报告。
- 排查架构决策：阅读 `02_架构与技术规格/技术规格说明书/技术规格说明书_ADR_架构决策记录.md`。
- 核对某次实现：阅读 `03_阶段实施` 中对应阶段的 README 和 Completion/Implementation Report。
- 生产故障或环境迁移：阅读 `06_运维与部署`。

## 维护约定

1. 新阶段文档放入 `03_阶段实施/Phase_X_*`，不要再放在 `documents/` 根目录。
2. 当前架构说明放入 `02_架构与技术规格`；历史验收证据放入 `05_工程审计`。
3. 前端视觉参考和实现报告放入 `04_前端与体验`。
4. 不再适用于当前代码的文档移动到 `07_归档`，并在文首注明归档原因。
5. 移动文档后必须同步修正相对链接和仓库内路径引用。
