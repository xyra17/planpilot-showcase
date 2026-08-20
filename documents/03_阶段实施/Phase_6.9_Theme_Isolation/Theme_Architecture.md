# Theme Architecture

## 状态层

主题定义集中在 `frontend/lib/theme-presets.ts`。该文件负责：

- 风格与配色类型；
- 每种风格允许的配色集合；
- 默认配色；
- 手账纸张 palette；
- 兼容性校验。

`ThemeProvider` 只负责读取、迁移、持久化和把当前结果写入 HTML attributes：

```html
<html data-theme="dark" data-color="violet" data-journal="wood">
```

不兼容的配色不会被 `setColorScheme()` 接受。

## 表现层

所有普通用户页面通过以下语义变量消费主题：

```css
--theme-canvas
--theme-surface
--theme-surface-muted
--theme-surface-raised
--theme-border
--theme-text
--theme-text-secondary
--theme-text-muted
--theme-input
--theme-hover
--theme-shadow
--theme-card-radius
```

这些变量再桥接到旧的 `--pp-*` 与现有页面 class，从而保持历史页面兼容，并允许组件逐步移除 `bg-white`、`text-gray-*` 等硬编码。

## 产品表面

`ProductShell` 只增加 surface 标记，不改变导航：

- `pp-work-surface`
- `pp-coach-surface`
- `pp-settings-surface`

Coach 在四种主题内保留 AI 产品识别，但颜色和材质仍服从当前用户风格。

## Admin 隔离

Admin 不属于个人学习界面，因此 `.pp-admin-shell` 重置主题 token，并对常见 Tailwind 背景、文字、边框和表单样式做高优先级固定映射。用户即使选择暗黑或手账，Admin 仍保持统一运营视觉。

## 后续迁移规则

新增普通用户组件时，应优先使用语义变量或现有 UI primitive。禁止新增只在某一种风格正确的固定白色背景、固定灰色正文或全局主题选择器。
