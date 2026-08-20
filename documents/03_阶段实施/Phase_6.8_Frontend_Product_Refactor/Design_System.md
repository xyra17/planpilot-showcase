# Design System

## 设计原则

- 用户端安静、轻量、强调当天行动。
- 学习伙伴使用同一体系，但用紫色语义突出智能协作。
- Admin 使用独立深色侧栏和高密度数据表面。
- 状态颜色必须有文字，不只依赖颜色传达。

## Token

Phase 6.8 在 `globals.css` 新增 `--pp-*` token：canvas、panel、ink、muted、line、primary、coach、success、radius 和 shadow。既有主题系统仍可覆盖页面内容，新 Shell 同时支持 dark mode。

## 基础交互

- 统一 10–24px 圆角层级。
- 导航项包含标题和简短用途，折叠后保留 tooltip。
- Button/Link 使用统一 focus-visible outline。
- Desktop 使用固定侧栏，移动端使用 drawer 和顶部模式入口。
- Auth 页面使用独立品牌介绍和一致的表单表面。
- Loading、无权限跳转和认证刷新期间不渲染受保护内容。
