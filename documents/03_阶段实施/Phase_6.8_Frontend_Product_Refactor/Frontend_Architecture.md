# Frontend Architecture

## 产品空间

### 学习空间 `/work`

面向用户主动执行：总览、目标、回顾、知识、笔记。首页只保留轻量“今日洞察”，完整认知画像和建议进入学习伙伴。

### 学习伙伴 `/coach`

面向智能协作：学习对话、认知画像、行为证据、Proposal 审阅和复杂任务协作。全局模式切换器支持在学习空间与学习伙伴之间切换，URL 可刷新、可深链、支持浏览器历史。

### Admin Console `/admin`

面向内部运营：Offline Gate、Canary、Experiment、Model Gateway、Metrics、Incident、Rollback 和 Agent Trace。普通用户不显示入口；访问 `/admin` 时调用 `/api/v1/auth/me` 做权威角色校验，失败后返回 `/work`。后端 Admin dependency 仍是最终安全边界。

## 代码结构

```text
app/
├── (auth)/
├── (product)/
│   ├── work/
│   ├── coach/
│   └── settings/
├── (admin)/admin/
└── (dashboard)/dashboard/   # 兼容旧 URL，逐步退出

components/app/
├── ProductShell
├── AdminShell
├── AuthBoundary
├── ModeSwitch
├── AppBrand
└── AppProviders
```

当前阶段使用 canonical route 复用已验证页面实现，内部导航全部指向新 URL。这样避免 Big Bang 重写业务页面，同时先建立稳定的产品骨架；后续可按 feature 逐页把源文件从 legacy 目录迁到 `features/`。

## 权限边界

前端 guard 负责产品可见性，后端负责数据安全。localStorage 中的用户信息只用于首屏提示，Admin Shell 必须重新请求 `/auth/me`，不能信任本地 `is_admin`。未来迁移 HttpOnly Cookie/BFF 后可进一步在服务端拒绝 Admin route bundle。
