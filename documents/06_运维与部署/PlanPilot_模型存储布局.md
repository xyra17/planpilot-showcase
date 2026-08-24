# PlanPilot 模型存储布局

**更新时间**：2026-08-22
**适用环境**：当前 Mac 本地开发环境

## 1. 权威模型目录

PlanPilot 本地服务只使用 Downloads 下便于查找的目录：

```text
/Users/Admin/Downloads/models/PlanPilot/
├── lmstudio-community/Qwen3.5-9B-MLX-4bit/
└── Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
```

PlanPilot 当前实际使用的两个模型都是专用模型：

| 模型 | 权威路径 | 加载方式 |
| --- | --- | --- |
| Qwen3.5-9B-MLX-4bit | `/Users/Admin/Downloads/models/PlanPilot/lmstudio-community/Qwen3.5-9B-MLX-4bit` | MLX-LM OpenAI-compatible 服务，端口 8080 |
| Qwen3-Embedding-0.6B | `/Users/Admin/Downloads/models/PlanPilot/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf` | llama.cpp Embedding 服务，端口 1234 |

Application Support 下经逐文件核验一致的旧运行副本已于 2026-08-22 移入废纸篓。
模型不与其他项目共用；不要再次创建第二份运行副本。

## 2. 后台服务

生成与向量服务均由 launchd 直接读取上述目录。更新生成服务配置后运行：

```bash
cd /Users/Admin/Desktop/PlanPilot
./scripts/macos/install_local_llm_service.sh
```

Embedding 服务读取同一目录中的 GGUF 文件，并保持端口 `1234` 与
`backend/.env` 的 `EMBEDDING_BASE_URL` 一致。

## 3. 配置与验收

`backend/.env` 中的本地生成模型配置为：

```dotenv
MODEL_NAME=/Users/Admin/Downloads/models/PlanPilot/lmstudio-community/Qwen3.5-9B-MLX-4bit
OPENAI_BASE_URL=http://localhost:8080/v1
EMBEDDING_BASE_URL=http://localhost:1234/v1
EMBEDDING_MODEL_NAME=/Users/Admin/Downloads/models/PlanPilot/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
```

移动目录后检查：

```bash
test -f "/Users/Admin/Downloads/models/PlanPilot/lmstudio-community/Qwen3.5-9B-MLX-4bit/config.json"
test -f "/Users/Admin/Downloads/models/PlanPilot/Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
curl -fsS http://127.0.0.1:8080/v1/models >/dev/null
curl -fsS http://127.0.0.1:1234/v1/models >/dev/null
```

模型文件不提交 Git，也不应由应用进程在运行时自动下载或覆盖。
