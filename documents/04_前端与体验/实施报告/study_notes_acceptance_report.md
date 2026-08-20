# 学习记录功能升级 — 验收报告

日期：2026-07-25

## 一、本次变更摘要

在 commit `24f1d4f` 修复4项核心缺陷之后，本次完成以下收尾工作：

| 项目 | 内容 |
|------|------|
| 图片鉴权修复 | TiptapEditor.tsx 引入 Blob URL 机制，避免 `<img>` 无法携带 Bearer Token |
| 格式校验 | `NoteCreate.noteDate` 新增 `field_validator`，非法日期格式返回 422 |
| 级联删除 | `delete_item` 端点删除笔记时同步删除其专属附件 |
| 专项测试 | `test_09_study_notes.py` 新增 8 个集成测试用例 |

---

## 二、各项验收结果

### 2.1 前端 build

```
✓ Compiled successfully
✓ Linting and checking validity of types
```

Next.js 14 生产构建无 TypeScript 错误，`/dashboard/notes` 路由正常生成。

### 2.2 后端测试 test_09_study_notes.py（8/8 通过）

| # | 用例 | 结果 |
|---|------|------|
| 1 | 同一天可创建多篇笔记，按 note_date 过滤返回正确条数 | PASSED |
| 2 | 历史日期笔记仅出现在对应日期查询结果，不污染其他日期 | PASSED |
| 3 | PATCH 笔记可更新 goalId，传空字符串可清除关联 | PASSED |
| 4 | 上传附件时传入 note_id，附件正确关联到指定笔记 | PASSED |
| 5 | 附件不出现在 `GET /knowledge/files` 知识库列表 | PASSED |
| 6 | 删除笔记后其专属附件一并删除，`/files/{id}/serve` 返回 404 | PASSED |
| 7 | 其他用户无法修改或删除不属于自己的笔记（返回 403/404） | PASSED |
| 8 | `noteDate` 格式非法（非 YYYY-MM-DD）返回 422 | PASSED |

### 2.3 历史测试套件

本次新增测试不影响已有 46 个通过用例（test_01 ～ test_08）。

---

## 三、技术实现要点

### Blob URL 图片鉴权（TiptapEditor.tsx）

```
保存路径：  /api/v1/knowledge/files/{id}/serve  ← 存入 DB
显示路径：  blob:http://.../{uuid}               ← 仅在内存
```

- `resolveImages(html)`：启动时将 API 路径 fetch（带 Bearer Token）→ 创建 Blob URL，替换 HTML 中的 src
- `dehydrate(html)`：保存前将 Blob URL 还原为 API 路径
- `suppressUpdate` ref：防止 `setContent()` 触发 onChange 死循环
- 组件卸载时 `URL.revokeObjectURL()` 释放内存

### noteDate 校验（knowledge.py）

```python
@field_validator("noteDate")
@classmethod
def validate_note_date(cls, v):
    if v is None: return v
    datetime.strptime(v, "%Y-%m-%d")  # raises ValueError → 422
    return v
```

### 级联删除附件（knowledge.py delete_item）

删除 KnowledgeItem 时，先查询所有 `note_id == item_id` 的子条目并删除（含磁盘文件），再删除主条目。

---

## 五、补丁修复（patch commit）

**问题：** 工具栏上传图片后，`setImage` 触发 `onUpdate` → `dehydrate` 返回 API 路径 → `onChange` 更新父组件 `content` → `useEffect` 判断 `content === dehydrate(editor.getHTML())` 相等 → 提前返回，图片 src 始终停留在需要鉴权的 API 路径，无法即时显示。

**修复：** 在 `onUpdate` 末尾检测编辑器 HTML 中是否仍有未解析的 SERVE_RE 路径；若有，立即异步调用 `resolveImages` 并通过 `suppressUpdate` 保护更新编辑器内容，使新插入图片在上传后立即以 Blob URL 显示。

前端 build 验证通过，笔误 `revokeObjectObject` → `revokeObjectURL` 一并修正。

- **测试数据库迁移**：`note_date` 列通过 asyncpg 直接 `ALTER TABLE ADD COLUMN IF NOT EXISTS` 补全（生产环境请运行 `alembic upgrade head`）
- `note_id` 外键策略为 `ondelete="SET NULL"`，仅用于普通附件的软关联；专属附件的级联删除由应用层逻辑保证
