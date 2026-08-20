# PlanPilot 模型存储布局

**更新时间**：2026-08-03  
**适用环境**：当前 Mac 本地开发环境

## 1. 权威模型目录

PlanPilot 与 SEKAP 共用模型根目录，但只把真实被项目加载的权重放进对应项目
文件夹：

```text
/Users/Admin/Downloads/models/
├── shared/       # 两边共同加载；当前为空
├── PlanPilot/
│   ├── Qwen/Qwen3-Embedding-0.6B-GGUF/
│   └── lmstudio-community/Qwen3.5-9B-MLX-4bit/
└── SEKAP/        # 由 SEKAP 自己维护，PlanPilot 不读取
```

PlanPilot 当前实际使用的两个模型都是专用模型：

| 模型 | 权威路径 | 加载方式 |
| --- | --- | --- |
| Qwen3.5-9B-MLX-4bit | `/Users/Admin/Downloads/models/PlanPilot/lmstudio-community/Qwen3.5-9B-MLX-4bit` | MLX-LM OpenAI-compatible 服务，端口 8080 |
| Qwen3-Embedding-0.6B | `/Users/Admin/Downloads/models/PlanPilot/Qwen/Qwen3-Embedding-0.6B-GGUF` | LM Studio/llama.cpp Embedding 服务，端口 1234 |

当前审计没有发现 PlanPilot 与 SEKAP 共同加载的权重，因此 `shared` 目录保留为
空目录。以后只有在两边代码和运行配置同时引用同一权重时，才把它放入 `shared`。

## 2. 运行副本

macOS 的 MLX-LM launchd 安装器会把生成模型做 APFS 写时复制，放在：

```text
~/Library/Application Support/PlanPilot/models/Qwen3.5-9B-MLX-4bit/
```

这是后台服务的运行副本，不是第二份逻辑模型来源。修改权威目录后，重新运行：

```bash
cd /Users/Admin/Desktop/PlanPilot
./scripts/macos/install_local_llm_service.sh
```

LM Studio 的 Embedding 服务也可能继续指向其应用数据目录中的运行副本。重新选
择模型时，应选择 `Downloads/models/PlanPilot/Qwen/` 下的 GGUF 文件，并保持端口
`1234` 与 `backend/.env` 的 `EMBEDDING_BASE_URL` 一致。

## 3. 配置与验收

`backend/.env` 中的本地生成模型配置为：

```dotenv
MODEL_NAME=/Users/Admin/Downloads/models/PlanPilot/lmstudio-community/Qwen3.5-9B-MLX-4bit
OPENAI_BASE_URL=http://localhost:8080/v1
EMBEDDING_BASE_URL=http://localhost:1234/v1
EMBEDDING_MODEL_NAME=qwen3-embedding-0.6b
```

移动目录后检查：

```bash
test -f /Users/Admin/Downloads/models/PlanPilot/lmstudio-community/Qwen3.5-9B-MLX-4bit/config.json
test -f /Users/Admin/Downloads/models/PlanPilot/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
curl -fsS http://127.0.0.1:8080/v1/models >/dev/null
curl -fsS http://127.0.0.1:1234/v1/models >/dev/null
```

模型文件不提交 Git，也不应由应用进程在运行时自动下载或覆盖。
