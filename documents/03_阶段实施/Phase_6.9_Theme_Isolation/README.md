# Phase 6.9：界面风格隔离

完成日期：2026-07-31。

## 目标

在不改变普通用户产品路由、导航和业务页面结构的前提下，把原先“共享一份配色、依赖 CSS 补丁”的主题实现升级为真正隔离的界面风格系统。

## 完成内容

- 默认、暗黑、护眼分别保存自己的配色选择。
- 手账纸稿继续使用独立纸张 palette。
- 设置页只展示当前界面风格兼容的配色。
- 切换风格后，画布、侧栏、卡片、文字、边框、表单、图表、阴影和 Coach 背景同步变化。
- Admin Console 固定为运营后台视觉，不继承普通用户的个人主题。
- 保留旧 `theme-color-{userId}`，并自动迁移到新的分风格存储键。
- 增加主题隔离 E2E，覆盖四种风格、持久化和不兼容选项隐藏。

## 存储模型

```text
theme-mode-{userId}
theme-color-default-{userId}
theme-color-dark-{userId}
theme-color-eye-care-{userId}
journal-palette-{userId}
```

旧键 `theme-color-{userId}` 仅用于向后兼容和首次迁移。

## 风格边界

| 风格 | 视觉语言 | 可用配色 |
|---|---|---|
| 默认 | 清晰 SaaS、白色卡片、轻阴影 | 靛青、蓝、绿、紫、玫红、琥珀 |
| 暗黑 | 深色画布、深色表面、高可读文字 | 靛青、紫、青、绿、中性灰 |
| 护眼 | 暖纸色、低对比边框、柔和阴影 | 暖陶、鼠尾草、石灰岩、玫瑰灰、薰衣草 |
| 手账 | 纸张纹理、虚线、手绘形态 | 原木、青灰、旧报纸、麦香、深夜纸稿 |

## 验证

- `npm run lint`
- `npm run build`
- `e2e/theme-isolation.spec.ts`
- Admin Canary E2E 中验证暗黑用户主题不会污染 Admin 画布。
