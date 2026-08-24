# PlanPilot

PlanPilot 是一个面向自主学习的 AI 计划与执行工作台。它把目标、任务、打卡、知识库、学习者画像和可审核的 Agent 操作放在同一套产品中。

> 当前定位：可本地运行的开发者预览版。适合下载体验和二次开发，尚不是免配置的桌面安装包，也不承诺生产级 SLA。

## 功能概览

- 目标、任务、日程、打卡与进度管理
- 文件知识库、分块索引、语义检索与笔记
- AI 学习伙伴、每日任务、复习题和答案验证
- 带 Proposal、用户确认、执行与 Trace 的 Agent 工作流
- 学习者画像、模式、记忆和自适应计划
- Prompt、模型、策略、灰度和评测运营后台

## 最快体验方式

需要安装 Docker Desktop（或 Docker Engine + Compose v2）。首次构建会下载镜像和依赖，请预留约 10 GB 磁盘空间。

```bash
git clone <your-github-repository-url>
cd PlanPilot
cp backend/.env.example backend/.env
docker compose up --build
```

服务启动后访问：

- 产品界面：http://localhost:3000
- API 文档：http://localhost:8000/docs
- 健康检查：http://localhost:8000/ready

首次启动会自动执行数据库迁移。停止服务使用：

```bash
docker compose down
```

保留的数据位于 Docker volumes 中；如需删除全部本地体验数据，可使用 `docker compose down -v`。该命令不可恢复。

## 启用 AI 功能

不配置模型也可以启动产品并体验账户、目标、任务、打卡等基础功能。学习建议（内部模块标识为 `coach`）、计划生成、验题和知识库语义检索需要模型。

最简单的方式是在 `backend/.env` 中填写 DeepSeek API Key：

```env
SMART_API_KEY=你的_API_Key
SMART_BASE_URL=https://api.deepseek.com/v1
SMART_MODEL_NAME=deepseek-v4-flash
SMART_PRO_MODEL_NAME=deepseek-v4-pro
```

API Key 只保存在被 Git 忽略的 `backend/.env` 中，不要提交到仓库、Issue、截图或前端代码。

知识库语义检索还需要 OpenAI-compatible Embedding 服务。使用宿主机服务时，在项目根目录创建 `.env`：

```env
PLANPILOT_EMBEDDING_URL=http://host.docker.internal:1234/v1
```

并在 `backend/.env` 中配置服务所需的 Key、模型名和固定 1024 维输出：

```env
EMBEDDING_API_KEY=local
EMBEDDING_MODEL_NAME=qwen3-embedding-0.6b
EMBEDDING_DIMENSIONS=1024
```

本地生成模型也可通过根目录 `.env` 中的 `PLANPILOT_LOCAL_LLM_URL` 接入。完整说明见 [环境搭建与启动指南](documents/06_运维与部署/PlanPilot_环境搭建与启动指南.md) 和 [模型供应商切换说明](documents/06_运维与部署/PlanPilot_模型供应商切换说明.md)。

模型职责以 [模型角色与并发规范](documents/02_架构与技术规格/技术规格说明书/PlanPilot_模型角色与并发规范.md) 为准：交互、本地优先；结构化、Flash 优先；关键判断使用 Pro；Embedding 独立运行。

在 Apple Silicon Mac 上运行项目自带的 MLX 服务前，使用独立的宿主机 Python 环境安装可选依赖：

```bash
pip install -r backend/requirements-mlx.txt
```

## 本地开发

前端使用 Next.js 15、React 18 和 pnpm；后端使用 FastAPI、PostgreSQL/pgvector、Redis 与 Celery。

```bash
cd frontend
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

常用验证命令：

```bash
cd frontend && pnpm build
cd backend && pytest tests --ignore=tests/integration -m "not integration and not soak" -q
docker compose config --quiet
```

## 项目结构

```text
backend/                 FastAPI、Agent、任务队列、数据库迁移与测试
frontend/                当前 Next.js 产品前端
documents/               产品、架构、阶段报告和运维文档
ops/                     备份与恢复脚本
docker-compose.yml       本地下载体验与开发环境
docker-compose.prod.yml  生产部署参考，不用于零配置体验
```

## 当前限制

- 这是源码分发，不是 DMG/Windows 安装包。
- AI 功能需要用户自行提供云端 API Key 或本地模型服务。
- Embedding 未配置时，知识库语义索引不可用。
- 首次 Docker 构建时间取决于网络和机器性能。
- 公开发布前需要由仓库所有者选择并添加许可证。

## 安全

- 不要提交任何 `.env`、API Key、用户上传文件、数据库备份或模型权重。
- 示例账号、截图和评测数据不得包含真实个人信息。
- 发现安全问题时请不要创建公开 Issue；在仓库发布前配置私密安全报告渠道。

更详细的文档索引见 [documents/README.md](documents/README.md)。
