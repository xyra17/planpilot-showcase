# Phase 6.8 Frontend Product Architecture Refactor

Phase 6.8 在 Phase 7 前重新建立前端产品边界，不增加新的 Agent 后端能力。

## 目标

- 普通用户产品与内部 Admin Console 分离。
- 普通学习功能与学习伙伴形成明确的双模式体验。
- 统一导航、页面骨架、视觉 token、响应式和认证状态。
- 保持 Phase 2–6.5 已有业务闭环和旧 URL 可用。

## 结果

```text
PlanPilot
├── /work        学习空间
├── /coach       学习伙伴
├── /settings    用户设置
└── /admin       内部管理后台（Admin only）
```

详细设计见 [Frontend Architecture](./Frontend_Architecture.md)，实施结果见 [Completion Report](./Phase_6.8_Completion_Report.md)。
