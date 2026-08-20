# PlanPilot 模型供应商切换说明

PlanPilot 不强制依赖 DeepSeek。生成模型只要求服务提供 OpenAI-compatible
`/chat/completions` 接口；Embedding 使用独立的 OpenAI-compatible
`/embeddings` 接口。

## 1. 推荐：交互式配置

在项目目录执行：

```bash
cd /Users/Admin/Desktop/PlanPilot/backend
python scripts/configure_models.py
```

脚本支持：

1. DeepSeek 预设；
2. 任意 OpenAI-compatible 服务；
3. 纯本地模式，不配置云端回退。

写入前会显示模型地址和模型 ID，但 API Key 只显示脱敏片段。确认写入时，脚本会先在
`backend/` 下创建带时间戳的 `.env.model-config-*.bak` 备份。

配置完成后重启后端相关服务：

```bash
cd /Users/Admin/Desktop/PlanPilot
docker compose restart api worker beat
```

## 2. 查看当前配置

```bash
cd /Users/Admin/Desktop/PlanPilot/backend
python scripts/configure_models.py --show
```

该命令不会修改文件，也不会显示完整密钥。

## 3. 非交互切换到其他兼容服务

为避免 API Key 留在 shell 历史中，先通过环境变量传入：

```bash
cd /Users/Admin/Desktop/PlanPilot/backend

PLANPILOT_CLOUD_API_KEY='sk-xxxxxx' \
python scripts/configure_models.py \
  --provider compatible \
  --base-url 'https://example.com/v1' \
  --routine-model 'fast-model-id' \
  --pro-model 'quality-model-id' \
  --yes
```

`routine-model` 用于高频聊天、日常任务、普通规划和结构化草案；`pro-model` 用于复杂
重规划与最终评分。两者可以填写同一个模型 ID。

## 4. 纯本地模式

```bash
cd /Users/Admin/Desktop/PlanPilot/backend
python scripts/configure_models.py \
  --provider local-only \
  --local-enabled true \
  --local-base-url 'http://localhost:8080/v1' \
  --local-model '本地服务返回的模型ID' \
  --yes
```

纯本地模式下，复杂重规划和最终评分没有云端备用模型。普通功能仍可运行，但本地模型
失败时无法自动回退。

## 5. Embedding 必须独立配置

生成模型和 Embedding 模型不是同一种能力。即使某个聊天服务提供商没有 Embedding，
也不影响使用它生成计划；继续保留本地 Qwen3 Embedding 即可：

```bash
python scripts/configure_models.py \
  --provider compatible \
  --base-url 'https://example.com/v1' \
  --routine-model 'fast-model-id' \
  --pro-model 'quality-model-id' \
  --embedding-base-url 'http://localhost:1234/v1' \
  --embedding-model 'qwen3-embedding-0.6b' \
  --yes
```

PlanPilot 数据库向量列固定为 1024 维，因此替换 Embedding 模型时必须保证输出维度为
1024；否则服务会拒绝结果，而不是把错误维度写入数据库。

## 6. 配置项名称说明

为了兼容现有部署，云端配置仍沿用 `SMART_*` 环境变量名称，但其含义已经是“任意
OpenAI-compatible 云端模型”，并不代表必须使用 DeepSeek：

| 配置 | 含义 |
|---|---|
| `SMART_BASE_URL` | 云端 OpenAI-compatible 地址 |
| `SMART_API_KEY` | 云端服务 Key |
| `SMART_MODEL_NAME` | 日常／快速模型 ID |
| `SMART_PRO_MODEL_NAME` | 复杂任务／审核模型 ID |
| `OPENAI_BASE_URL` | 本地生成服务地址 |
| `MODEL_NAME` | 本地生成模型 ID |
| `EMBEDDING_BASE_URL` | 独立向量服务地址 |
| `EMBEDDING_MODEL_NAME` | 1024 维 Embedding 模型 ID |

后续如需彻底重命名 `SMART_*` 为 `CLOUD_*`，应通过兼容迁移完成，不建议直接删除旧变量，
否则现有 `.env` 和 Docker 部署会突然失效。
