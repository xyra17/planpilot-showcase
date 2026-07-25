# PlanPilot 完整卸载与数据清理说明

**更新时间**：2026-07-25  
**适用环境**：当前 Mac 本地开发环境

仅删除 `/Users/Admin/Desktop/PlanPilot` 不等于完整卸载。PlanPilot 还使用了
Docker 数据卷、本地 Qwen3 Embedding 后台服务、生成模型文件和历史版本归档。

本文只提供清理步骤，不会自动执行。涉及数据库、用户上传文件和模型的步骤
不可恢复，执行前请先确认备份。

## 1. 删除前需要备份的内容

### 项目目录内

- `backend/.env`：本地数据库、API Key 和邮件等配置。
- `backend/uploads/`：用户上传的原始文件。
- Git 仓库：尚未推送到远程仓库的提交和分支。
- `documents/`：工程审计和测试报告。

### Docker 数据

当前项目数据卷：

- `planpilot_postgres_data`：PostgreSQL 用户、目标、任务、知识记录和向量。
- `planpilot_minio_data`：MinIO 对象数据。
- `planpilot_redis_data`：Redis 缓存、队列和令牌状态。

其中 PostgreSQL 数据卷当前约 86 MB，是最需要确认是否备份的部分。

可在删除前导出数据库：

```bash
cd /Users/Admin/Desktop/PlanPilot
docker compose exec -T postgres \
  pg_dump -U planpilot -d planpilot -Fc \
  > /Users/Admin/Desktop/planpilot_backup.dump
```

## 2. 推荐卸载顺序

必须先在项目目录仍然存在时停止 Docker 服务：

```bash
cd /Users/Admin/Desktop/PlanPilot
docker compose down --volumes --remove-orphans
```

这条命令会删除：

- PlanPilot 所有 Compose 容器；
- `planpilot_default` 网络；
- 三个 `planpilot_*_data` 数据卷；
- 当前遗留的 `planpilot-web-1` orphan 容器。

`--volumes` 会永久删除数据库和 MinIO 数据。只想暂时停用时，应执行：

```bash
docker compose down --remove-orphans
```

不要添加 `--volumes`。

## 3. 停止并移除 Qwen3 Embedding 后台服务

先卸载当前用户的 launchd 服务：

```bash
launchctl bootout \
  gui/$(id -u) \
  /Users/Admin/Library/LaunchAgents/com.planpilot.embedding.plist
```

然后删除：

- `/Users/Admin/Library/LaunchAgents/com.planpilot.embedding.plist`
- `/Users/Admin/Library/Application Support/PlanPilot/`
- `/Users/Admin/Library/Logs/PlanPilot/`

当前占用大约：

| 路径 | 大小 | 是否项目专用 |
|---|---:|---|
| `~/Library/Application Support/PlanPilot/` | 610 MB | 是 |
| `~/Library/Logs/PlanPilot/` | 8 KB | 是 |
| `~/Library/LaunchAgents/com.planpilot.embedding.plist` | 4 KB | 是 |

删除后可确认服务已消失：

```bash
launchctl print gui/$(id -u)/com.planpilot.embedding
```

预期返回“Could not find service”。

## 4. 模型归档

Qwen3 Embedding 的原始归档位于：

`/Users/Admin/Downloads/models/Qwen/Qwen3-Embedding-0.6B-GGUF/`

当前约 624 MB。它不是项目源码，也不会进入 Git。

- 如果其他项目还会使用 Qwen3 Embedding，可以保留。
- 如果以后不再使用，可以删除整个上述目录。

不要删除整个 `/Users/Admin/Downloads/models/`，其中还有其他模型，例如
`Qwen3.5-9B-MLX-4bit`。该生成模型当前由 PlanPilot 使用，具体路径为：

`/Users/Admin/Downloads/models/lmstudio-community/Qwen3.5-9B-MLX-4bit`

目前生成模型通过终端中的 MLX-LM 服务运行，没有新增 launchd 项。卸载前可
停止对应的 `python -m mlx_lm server` 进程；确认其他项目不使用后，才删除该
模型目录。若后续按架构路线新增 `com.planpilot.llm.plist`，也应像 Embedding
服务一样先 `launchctl bootout`，再删除 plist 和对应日志。

机器中原有的 `text-embedding-nomic-embed-text-v1.5` 不是本项目新增内容，
不需要随 PlanPilot 删除。

## 5. Docker 镜像

`docker compose down` 默认不会删除镜像。当前项目专用镜像：

- `planpilot-api:latest`
- `planpilot-worker:latest`
- `planpilot-beat:latest`
- `planpilot-frontend:latest`
- `planpilot-web:latest`

确认不再使用后可删除：

```bash
docker image rm \
  planpilot-api:latest \
  planpilot-worker:latest \
  planpilot-beat:latest \
  planpilot-frontend:latest \
  planpilot-web:latest
```

以下基础镜像可能被其他项目复用，建议默认保留：

- `pgvector/pgvector:pg16`
- `redis:7-alpine`
- `minio/minio:latest`

## 6. 历史版本归档

第一阶段从项目中移出的旧版本位于：

`/Users/Admin/Desktop/PlanPilot_archives/`

当前约 242 MB。

该目录不在现有 Git 仓库中。确认不需要回看旧版 `v1/`、`v2/` 后可以单独删除。

## 7. 删除项目目录

完成 Docker 停止、数据备份和后台服务卸载后，再删除：

`/Users/Admin/Desktop/PlanPilot/`

删除项目目录会同时删除：

- 源代码和 `.git` 历史；
- 未提交的本地修改；
- 被 Git 忽略的 `.env`；
- `backend/uploads/` 中的真实用户文件；
- `frontend/node_modules/` 和构建缓存；
- 工程报告与测试报告。

## 8. 不需要随项目卸载的共享软件

除非其他用途也不再需要，否则不要删除：

- Docker Desktop；
- Bionic；
- Python / Miniconda；
- Node.js / npm；
- `/Users/Admin/.lmstudio/` 整个目录；
- DeepSeek 账号或 API Key 本身；
- 其他项目使用的 PostgreSQL、Redis、MinIO 基础镜像。

## 9. 最终检查

完整卸载后可执行以下只读检查：

```bash
docker ps -a --filter label=com.docker.compose.project=planpilot
docker volume ls --filter name=planpilot
docker image ls --filter reference='planpilot-*'
launchctl print gui/$(id -u)/com.planpilot.embedding
```

并确认以下路径不存在：

- `/Users/Admin/Desktop/PlanPilot`
- `/Users/Admin/Library/LaunchAgents/com.planpilot.embedding.plist`
- `/Users/Admin/Library/Application Support/PlanPilot`
- `/Users/Admin/Library/Logs/PlanPilot`

模型归档和 `PlanPilot_archives` 是否删除，由是否需要复用或留档决定。
