# PlanPilot 环境搭建与启动指南

> 适用对象：完全零基础的新开发者，或将项目迁移到新机器的场景。
> 按本文档顺序操作，无需任何额外知识即可将项目完整跑起来。

---

## 目录

1. [系统要求](#1-系统要求)
2. [需要安装的软件](#2-需要安装的软件)
3. [项目结构说明](#3-项目结构说明)
4. [第一步：配置环境变量](#4-第一步配置环境变量)
5. [第二步：启动后端服务（Docker）](#5-第二步启动后端服务docker)
6. [第三步：初始化 MinIO 存储桶](#6-第三步初始化-minio-存储桶)
7. [第四步：启动前端开发服务器](#7-第四步启动前端开发服务器)
8. [第五步：验证全部正常](#8-第五步验证全部正常)
9. [日常开发操作](#9-日常开发操作)
10. [集成测试（可选）](#10-集成测试可选)
11. [当前未集成 / 待完善项](#11-当前未集成--待完善项)
12. [常见问题排查](#12-常见问题排查)

---

## 1. 系统要求

| 项目 | 最低要求 |
|------|---------|
| 操作系统 | macOS 12+、Windows 10/11、Ubuntu 20.04+ |
| 内存 | 8 GB（推荐 16 GB） |
| 磁盘 | 至少 10 GB 可用空间 |
| 网络 | 首次启动需下载 Docker 镜像（约 2 GB） |

---

## 2. 需要安装的软件

本项目只需要在本机安装**两个软件**，其余所有服务（数据库、后端、缓存等）都运行在 Docker 容器内。

### 2.1 Docker Desktop

Docker 是本项目后端运行的基础，必须安装。

**下载地址：**
- Mac（Intel/Apple Silicon）：https://www.docker.com/products/docker-desktop/
- Windows：同上
- Linux：安装 Docker Engine + Docker Compose v2

**安装步骤（Mac 为例）：**
1. 打开上述链接，点击"Download for Mac"下载 `.dmg` 文件
2. 双击 `.dmg`，将 Docker 图标拖入 Applications 文件夹
3. 打开 Docker Desktop，等待右下角状态变为"Running"（绿色小鲸鱼图标）

**验证安装成功（打开终端执行）：**
```bash
docker --version
# 预期输出类似：Docker version 27.x.x
docker compose version
# 预期输出类似：Docker Compose version v2.x.x
```

> **Windows 用户注意**：需要在 Docker Desktop 设置中启用 WSL 2 后端，并确保 Hyper-V 已开启。

### 2.2 Node.js（前端使用）

**下载地址：** https://nodejs.org/

下载 **LTS 版本**（长期支持版，当前为 v20.x 或 v22.x）。

**安装步骤：**
1. 下载对应系统的安装包（`.pkg` for Mac，`.msi` for Windows）
2. 双击安装，全部默认选项即可

**验证安装成功：**
```bash
node --version
# 预期输出类似：v20.x.x 或 v22.x.x

npm --version
# 预期输出类似：10.x.x
```

---

## 3. 项目结构说明

```
PlanPilot/
├── backend/                # 后端代码（Python + FastAPI）
│   ├── src/
│   │   ├── api/            # 所有 API 路由（goals, tasks, agent 等）
│   │   ├── models.py       # 数据库模型定义
│   │   ├── main.py         # FastAPI 应用入口
│   │   └── tasks/          # Celery 异步任务
│   ├── tests/              # 单元测试 + 集成测试
│   ├── .env                # 【重要】后端环境变量（需手动创建）
│   ├── requirements.txt    # Python 依赖列表
│   └── Dockerfile          # 后端 Docker 构建文件
│
├── frontend/               # 前端代码（Next.js + React）
│   ├── app/                # Next.js 页面和路由
│   ├── lib/                # 工具函数、API 封装、状态管理
│   ├── .env.local          # 【重要】前端环境变量（需手动创建）
│   └── package.json        # 前端依赖列表
│
├── documents/              # 项目文档
├── docker-compose.yml      # Docker 服务编排配置
└── README.md
```

**架构简介：**
- **后端**：运行在 Docker 容器中（不需要在本机安装 Python）
- **前端**：运行在本机（需要 Node.js）
- **数据库**：PostgreSQL + pgvector，运行在 Docker 中
- **缓存**：Redis，运行在 Docker 中
- **对象存储**：MinIO（类 S3），运行在 Docker 中
- **异步任务**：Celery Worker + Beat，运行在 Docker 中

---

## 4. 第一步：配置环境变量

环境变量是项目运行所需的配置信息（如 API 密钥、数据库密码等），不放入代码仓库。需要手动创建两个配置文件。

### 4.1 后端环境变量（必须）

在 `backend/` 目录下创建 `.env` 文件（注意文件名以点开头）。

**操作步骤：**

打开终端，进入项目的 `backend/` 目录：
```bash
cd /path/to/PlanPilot/backend
```

> 把 `/path/to/PlanPilot/` 替换为你实际的项目路径。例如 Mac 上可能是 `/Users/yourname/Desktop/PlanPilot/backend`。

创建 `.env` 文件（用任意文本编辑器均可，如 VS Code、记事本）：

```bash
# 如果使用 VS Code：
code .env

# 如果在 Mac 终端：
touch .env && open .env
```

将以下内容**完整复制**粘贴进去，然后按说明填写：

```env
# ═══════════════════════════════════════════════════
# 数据库（Docker 内部地址，不要修改）
# ═══════════════════════════════════════════════════
DATABASE_URL=postgresql+asyncpg://planpilot:password@postgres:5432/planpilot

# ═══════════════════════════════════════════════════
# 认证密钥（必须修改为随机字符串，至少32位）
# ═══════════════════════════════════════════════════
SECRET_KEY=请替换为随机字符串例如abc123xyz789def456uvw012rst345mn
ACCESS_TOKEN_EXPIRE_DAYS=30

# ═══════════════════════════════════════════════════
# AI 接口配置（二选一：本地 LLM 或 DeepSeek 云端）
# ═══════════════════════════════════════════════════

# 选项 A：使用 DeepSeek 云端 API（推荐，简单）
# 在 https://platform.deepseek.com/ 注册后获取 API Key
SMART_API_KEY=sk-xxxx你的DeepSeek密钥xxxx
SMART_BASE_URL=https://api.deepseek.com/v1
SMART_MODEL_NAME=deepseek-chat

# 选项 B：使用 OpenAI（或兼容接口）
# OPENAI_API_KEY=sk-xxxx
# OPENAI_BASE_URL=https://api.openai.com/v1
# MODEL_NAME=gpt-4o-mini

# ═══════════════════════════════════════════════════
# Redis（Docker 内部地址，不要修改）
# ═══════════════════════════════════════════════════
REDIS_URL=redis://redis:6379/0

# ═══════════════════════════════════════════════════
# 邮件通知（可选，不填则邮件功能禁用）
# ═══════════════════════════════════════════════════
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_NAME=PlanPilot

# ═══════════════════════════════════════════════════
# 错误监控（可选，不填则禁用）
# ═══════════════════════════════════════════════════
SENTRY_DSN=
```

**填写说明：**

| 变量 | 是否必填 | 说明 |
|------|---------|------|
| `DATABASE_URL` | 必填（保持默认） | PostgreSQL 连接地址，Docker 内固定不变 |
| `SECRET_KEY` | 必填 | JWT 签名密钥，随机字符串，越长越安全 |
| `SMART_API_KEY` | 必填 | DeepSeek API 密钥，AI 功能核心依赖 |
| `SMART_BASE_URL` | 必填 | DeepSeek 接口地址（保持默认即可） |
| `SMART_MODEL_NAME` | 必填 | 使用的模型名称（保持默认即可） |
| `REDIS_URL` | 必填（保持默认） | Redis 地址，Docker 内固定不变 |
| `SMTP_*` | 可选 | 邮件功能，不填则无法发邮件通知 |
| `SENTRY_DSN` | 可选 | 错误上报，不填则禁用 |

> **如何获取 DeepSeek API Key：**
> 1. 访问 https://platform.deepseek.com/
> 2. 注册账号并充值（按量计费，测试花费极少）
> 3. 进入"API Keys"页面，点击"创建 API Key"
> 4. 复制生成的密钥（格式为 `sk-...`）填入上方

### 4.2 前端环境变量（必须）

在 `frontend/` 目录下创建 `.env.local` 文件：

```bash
cd /path/to/PlanPilot/frontend
```

创建并写入以下内容：

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

这一行告诉前端去哪里找后端 API（本机 8000 端口）。

---

## 5. 第二步：启动后端服务（Docker）

确保 Docker Desktop 已经在运行（任务栏/菜单栏有鲸鱼图标且为绿色）。

打开终端，**进入项目根目录**（包含 `docker-compose.yml` 的那层）：

```bash
cd /path/to/PlanPilot
```

执行以下命令：

```bash
docker compose up -d --build
```

参数说明：
- `up`：启动所有服务
- `-d`：在后台运行（不占用终端）
- `--build`：首次运行时构建镜像（后续启动可省略 `--build`）

**首次运行会下载镜像，耗时 5～15 分钟**（取决于网络速度）。

**验证所有服务正常启动：**

```bash
docker compose ps
```

预期看到类似输出（所有服务 STATUS 均为 `Up` 或 `healthy`）：

```
NAME                    STATUS          PORTS
planpilot-api-1         Up              0.0.0.0:8000->8000/tcp
planpilot-beat-1        Up
planpilot-minio-1       Up (healthy)    0.0.0.0:9000-9001->9000-9001/tcp
planpilot-postgres-1    Up (healthy)    0.0.0.0:5432->5432/tcp
planpilot-redis-1       Up (healthy)    0.0.0.0:6379->6379/tcp
planpilot-worker-1      Up
```

**查看后端日志（确认无报错）：**

```bash
docker compose logs api --tail=20
```

看到 `Application startup complete.` 即表示后端启动成功。

---

## 6. 第三步：初始化 MinIO 存储桶

MinIO 是对象存储服务（用于存储上传的文件，如学习资料）。首次启动后需要手动创建存储桶。

**方式一：通过管理控制台（推荐新人）**

1. 打开浏览器，访问 http://localhost:9001
2. 用以下账号登录：
   - 用户名：`planpilot`
   - 密码：`password123`（在 docker-compose.yml 中定义）
3. 点击左侧菜单"Buckets"→ 右上角"Create Bucket"
4. 输入存储桶名称：`planpilot`，点击"Create Bucket"

**方式二：通过命令行**

```bash
docker compose exec minio mc alias set local http://localhost:9000 planpilot password123
docker compose exec minio mc mb local/planpilot
```

---

## 7. 第四步：启动前端开发服务器

打开一个**新的终端窗口**，进入 `frontend/` 目录：

```bash
cd /path/to/PlanPilot/frontend
```

首次运行需要安装 Node.js 依赖（约 200MB，只需执行一次）：

```bash
npm install
```

安装完成后，启动开发服务器：

```bash
npm run dev
```

预期看到输出：

```
▲ Next.js 14.2.x
- Local:        http://localhost:3000
✓ Ready in 2s
```

此时前端已在 http://localhost:3000 运行。

> **注意**：`npm run dev` 命令运行时终端窗口不能关闭，否则前端停止服务。建议开一个专用终端窗口保持运行。

---

## 8. 第五步：验证全部正常

打开浏览器，依次访问以下地址确认各服务正常：

| 服务 | 地址 | 预期结果 |
|------|------|---------|
| 前端应用 | http://localhost:3000 | 显示 PlanPilot 登录/注册页面，有完整样式 |
| 后端 API 文档 | http://localhost:8000/docs | 显示 Swagger 接口文档页面 |
| 后端健康检查 | http://localhost:8000/health | 返回 `{"status":"ok"}` |
| MinIO 控制台 | http://localhost:9001 | 显示 MinIO 登录页 |

全部正常后，注册一个账号，创建一个学习目标，即可开始使用。

---

## 9. 日常开发操作

### 每次开发时的启动流程

**步骤 1**：启动 Docker 服务（如果 Docker Desktop 已在运行且服务未停止，可跳过）
```bash
cd /path/to/PlanPilot
docker compose up -d
```

**步骤 2**：启动前端
```bash
cd /path/to/PlanPilot/frontend
npm run dev
```

完成，访问 http://localhost:3000 即可。

### 停止所有服务

```bash
# 停止前端：在运行 npm run dev 的终端按 Ctrl+C

# 停止后端 Docker 服务：
cd /path/to/PlanPilot
docker compose down
```

### 修改后端代码后如何生效

后端代码挂载在 Docker 容器内，`uvicorn --reload` 会自动检测文件变更并重载，**无需重启容器**。

### 修改前端代码后如何生效

Next.js 开发模式支持热重载，保存文件后浏览器**自动刷新**，无需任何操作。

### 查看日志

```bash
# 后端 API 日志
docker compose logs api -f

# Celery Worker 日志（AI 任务）
docker compose logs worker -f

# 所有服务日志
docker compose logs -f
```

---

## 10. 集成测试（可选）

集成测试使用真实 PostgreSQL，覆盖全部 55 个 API 用例。

**第一次运行前，创建测试数据库：**

```bash
docker compose exec postgres psql -U planpilot -d postgres -c "CREATE DATABASE planpilot_test"
```

**运行测试：**

```bash
docker compose exec api bash -c "cd /app && TEST_DATABASE_URL='postgresql+asyncpg://planpilot:password@postgres:5432/planpilot_test' pytest tests/integration/ -v -m integration"
```

**预期结果：** `55 passed in ~40s`

测试报告（HTML格式）生成在 `backend/tests/integration/reports/` 目录下，用浏览器打开即可查看。

---

## 11. 当前未集成 / 待完善项

以下功能**代码层面已规划但尚未完整实现或接入**，新开发者需了解：

### 11.1 LLM 可观测性：Langfuse（未接入）

**是什么**：追踪 AI 调用的每条 prompt、响应、耗时、费用的可视化平台。

**当前状态**：`src/api/agent.py` 无任何 Langfuse 代码，LLM 调用无追踪。

**何时需要**：上线后希望监控 AI 质量和成本时。

**接入方式**（供参考）：
1. 在 `backend/requirements.txt` 添加 `langfuse`
2. 在 `backend/.env` 添加 `LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`、`LANGFUSE_HOST`
3. 用 `@observe` 装饰器包裹 `agent.py` 中的 LLM 调用函数

### 11.2 邮件功能：忘记密码 / SMTP（已实现，MVP 阶段暂不启用）

**当前状态**：

- SMTP（QQ 邮箱）已验证可用，`aiosmtplib` 发送测试邮件成功
- **忘记密码**流程已完整实现：前端 `/forgot-password` 和 `/reset-password` 页面、后端 `POST /auth/forgot-password` 和 `POST /auth/reset-password` 接口均已上线
- **MVP 阶段暂不对外推广**：原因是测试账号使用假邮箱（如 `test_other@example.com`），触发忘记密码时邮件会因收件域名不存在而退信，退信通知将发回开发者的 SMTP 邮箱（`385669487@qq.com`），造成垃圾邮件

**何时可以正常使用**：所有账号均使用真实邮箱注册后，该功能即可无障碍使用，无需任何代码改动。

**更新邮箱（将测试账号改为真实邮箱）：**
```bash
docker compose exec postgres psql -U planpilot -d planpilot -c \
  "UPDATE users SET email='你的真实邮箱' WHERE email='test_other@example.com';"
```

**配置方法**：当前已使用 QQ 邮箱，如需更换，在 `.env` 中修改 SMTP 相关变量：
- 国内：阿里云邮件推送、腾讯企业邮
- 国际：SendGrid、Mailgun、Gmail App Password

### 11.3 错误监控：Sentry（已接入 SDK，DSN 为空）

**当前状态**：`sentry-sdk[fastapi]` 已安装，代码中已初始化，但 `SENTRY_DSN` 为空，实际不上报。

**开启方法**：在 https://sentry.io 创建项目，将 DSN 填入 `.env`。

### 11.4 本地 LLM：mlx-lm（仅 Mac Apple Silicon）

#### 11.4.1 设计思路：双层模型架构

PlanPilot 使用**两套模型配置**，分工不同：

| 配置变量 | 用途 | 调用位置 |
|---------|------|---------|
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `MODEL_NAME` | 本地模型（轻量、免费） | embedding 向量化、每日任务生成（`generate_daily_tasks`）|
| `SMART_API_KEY` + `SMART_BASE_URL` + `SMART_MODEL_NAME` | 云端 Smart 模型（高质量） | 宏观计划、意图识别、重规划、验题、打卡分析等核心 Agent 节点 |

**为什么这样设计：**
- embedding（向量化）和每日任务生成调用频率高、对质量要求相对宽松 → 用本地模型节省成本
- 宏观计划、意图识别等需要复杂推理 → 必须用高质量云端模型
- 对话/打卡节点（`chat`、`checkin`、`replan_chat`）：Smart 优先，无 Smart 配置时自动降级到本地

**回退机制（本地失败自动切 Smart API）：**

代码中三处涉及本地模型的地方均已加入回退逻辑：
```
本地模型调用失败 → 自动切换到 Smart API → 仍失败则静默跳过
```
覆盖范围：`_vectorize`（知识库向量化）、语义搜索 embedding、`generate_daily_tasks`（每日任务生成）。

实际意义：**迁移到新电脑即使没有本地模型，只要配置了 `SMART_API_KEY`，所有功能均可正常使用。**

---

#### 11.4.2 适用条件

| 平台 | 支持情况 |
|------|---------|
| Mac（Apple M1/M2/M3/M4） | 支持，推荐 |
| Mac（Intel） | 不支持 mlx-lm |
| Windows / Linux | 不支持 mlx-lm，可替换为 Ollama（见下文） |

---

#### 11.4.3 推荐模型对照表（Mac Apple Silicon）

以下模型均来自 [mlx-community](https://huggingface.co/mlx-community)，均为 4-bit 量化版本，可直接用于 mlx-lm 启动。

| 模型 | 统一内存要求 | 磁盘占用 | 推荐机型 | 综合质量 | 备注 |
|------|-----------|---------|---------|---------|------|
| **Qwen2.5-7B-Instruct-4bit** | 8 GB+ | ~4 GB | M1/M2/M3/M4 16-32GB | ★★★★☆ | **推荐默认选择**，质量和速度平衡最佳 |
| **Qwen3.5-9B-MLX-4bit**（当前 .env 配置） | 8 GB+ | ~5 GB | M1/M2/M3/M4 16GB+ | ★★★★☆ | Qwen3.5 新一代模型，中文能力强，速度与质量平衡好 |
| **Llama-3.2-3B-Instruct-4bit** | 6 GB+ | ~2 GB | M1/M2 8GB | ★★★☆☆ | 英文任务优秀，中文稍弱 |

> 推荐 **M1/M2/M3/M4 16GB+** 用户选择 `Qwen3.5-9B-MLX-4bit`；更低配置可选 `Qwen2.5-7B-Instruct-4bit`。

---

#### 11.4.4 模型文件存储路径

mlx-lm 使用 Hugging Face Hub 管理模型，下载后自动存储于：

```
~/.cache/huggingface/hub/models--{org}--{model-name}/snapshots/{hash}/
```

例如 `mlx-community/Qwen2.5-7B-Instruct-4bit` 下载后路径类似：
```
~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-7B-Instruct-4bit/snapshots/abc123.../
```

**在 `.env` 中配置 `MODEL_NAME` 有两种方式：**

```env
# 方式一：使用 HuggingFace 模型 ID（启动时自动下载，推荐）
MODEL_NAME=mlx-community/Qwen2.5-7B-Instruct-4bit

# 方式二：使用本地绝对路径（已下载的模型）
MODEL_NAME=/Users/yourname/.cache/huggingface/hub/models--mlx-community--Qwen2.5-7B-Instruct-4bit/snapshots/abc123.../
```

方式一更简便，mlx-lm server 会自动下载（首次需要网络）；方式二适合离线环境。

---

#### 11.4.5 启动本地 LLM

```bash
# 安装 mlx-lm（只需一次）
pip install mlx-lm

# 启动服务（以 7B 模型为例，首次运行会自动下载模型）
mlx_lm.server --model mlx-community/Qwen2.5-7B-Instruct-4bit --port 8080
```

然后在 `backend/.env` 中配置：
```env
OPENAI_API_KEY=local
OPENAI_BASE_URL=http://localhost:8080/v1
MODEL_NAME=mlx-community/Qwen2.5-7B-Instruct-4bit
```

重启 API 容器生效：
```bash
docker compose restart api worker
```

---

#### 11.4.6 Windows / Linux 替代方案（Ollama）

Windows 和 Linux 用户可以使用 [Ollama](https://ollama.com) 替代 mlx-lm：

```bash
# 安装 Ollama（见 https://ollama.com）
ollama pull qwen2.5:7b

# 启动（默认监听 11434，需配置为 OpenAI 兼容格式）
ollama serve
```

在 `.env` 中配置：
```env
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
MODEL_NAME=qwen2.5:7b
```

> Ollama 的 `/v1` 端点与 OpenAI API 兼容，代码无需修改。

### 11.5 移动端 / 桌面端打包（规划中）

**当前状态**：纯 Web 应用，可在浏览器访问。

**规划方向**：
- **桌面端（macOS/Windows）**：使用 Tauri 或 Electron 包装
- **移动端（iOS/Android）**：使用 Capacitor 或 React Native 重写

目前无任何打包配置，需要额外开发工作。

### 11.6 生产部署（未配置）

当前项目仅配置了开发环境，用于生产需额外处理：
- Nginx 反向代理 + HTTPS 证书
- 环境变量安全管理（不能明文存放密钥）
- Docker 镜像推送到私有仓库
- 域名绑定

### 11.7 邮箱真实性验证（上线前实现）

**是什么**：注册时发送验证邮件，用户点击链接后账号才完全激活，确保邮箱真实可用。

**当前状态**：未实现。注册接口不校验邮箱有效性，用假邮箱可正常注册。

**MVP 阶段暂不实现的原因**：测试账号使用假邮箱，启用后这些账号无法激活。

**正式上线前需实现：**
1. `users` 表增加 `is_email_verified` 字段（默认 `false`）
2. 注册后发送验证邮件（复用忘记密码的 token 机制）
3. 未验证账号限制部分功能（或直接禁止登录）

**轻量替代方案（可提前做）**：注册时对邮箱域名做 MX 记录校验，拦截 `@example.com` 等假域名，无需发邮件，几毫秒内完成：
```python
import dns.resolver
def has_mx_record(domain: str) -> bool:
    try:
        dns.resolver.resolve(domain, "MX")
        return True
    except Exception:
        return False
```

### 11.8 人机验证 / 防滥用（上线前实现）

**当前状态**：
- `POST /login`：已有 `slowapi` 速率限制（10次/分钟）
- `POST /register`：已扩展速率限制（5次/小时）✓
- `POST /forgot-password`：已扩展速率限制（3次/小时）✓
- 无前端 CAPTCHA

**MVP 阶段已覆盖**：速率限制能防止基础暴力破解和邮件轰炸，满足开发测试需求。

**正式上线前需补充：**

| 措施 | 说明 |
|------|------|
| Cloudflare Turnstile | 前端 CAPTCHA，比 Google reCAPTCHA 更适合国内（不依赖 Google CDN）。在注册和忘记密码表单加一个 widget，后端接口验证 token |
| Cloudflare WAF | 域名接入 Cloudflare 后自动获得 DDoS 防护，无需代码改动 |

**Cloudflare Turnstile 接入要点：**
1. 在 Cloudflare 控制台创建站点，获取 `sitekey`（前端用）和 `secret`（后端验证用）
2. 前端注册/找回密码页面加入 Turnstile widget
3. 后端接口收到 `cf-turnstile-response` 后调用 Cloudflare 验证 API

---

## 12. 常见问题排查

### Q1：`docker compose up` 报错"端口已被占用"

**错误信息类似：** `Error starting userland proxy: listen tcp 0.0.0.0:5432: bind: address already in use`

**原因**：本机已有 PostgreSQL 或其他程序占用了对应端口。

**解决方法：**
```bash
# 查看占用端口的进程（以5432为例）
lsof -i :5432

# 停止本机 PostgreSQL（macOS）
brew services stop postgresql

# 或直接修改 docker-compose.yml 中的端口映射，改为其他端口，如 "5433:5432"
```

### Q2：前端页面无样式（纯文字，Times New Roman 字体）

**原因**：Next.js `.next` 缓存损坏。

**解决方法：**
```bash
# 停止前端服务（Ctrl+C），然后：
cd /path/to/PlanPilot/frontend
rm -rf .next
npm run dev
```

### Q3：登录后显示"网络请求失败"或接口报 500

**可能原因 1**：后端没有启动或启动失败。
```bash
docker compose ps          # 确认 api 服务状态为 Up
docker compose logs api    # 查看错误日志
```

**可能原因 2**：`.env` 文件中 `SMART_API_KEY` 未填写或填写错误。AI 相关接口（`/api/v1/agent/*`）在无 API Key 时会报错。

### Q4：`npm install` 安装很慢或失败

**解决方法（切换国内镜像）：**
```bash
npm config set registry https://registry.npmmirror.com
npm install
```

### Q5：Docker 容器启动后很快就退出（Exit 1）

```bash
docker compose logs api    # 查看具体错误
```

常见原因：
- `.env` 文件不存在或格式错误（有中文引号、多余空格等）
- `DATABASE_URL` 格式错误

### Q6：MinIO 无法访问或文件上传失败

确认 MinIO 服务健康且存储桶已创建：
```bash
docker compose ps minio    # 确认状态为 healthy
```
如未创建 `planpilot` 存储桶，参考第 6 节重新创建。

### Q7：AI 功能没有响应（宏观计划/每日简报无内容）

1. 检查 `.env` 中 `SMART_API_KEY` 是否正确填写
2. 确认 DeepSeek 账户余额充足
3. 查看 Celery Worker 日志：`docker compose logs worker -f`

### Q8：忘记账户密码，如何重置

在终端执行以下命令（把 `你的新密码` 和 `你的邮箱` 替换为实际值）：

```bash
docker compose exec api python -c "
import os, asyncio
from passlib.context import CryptContext
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

async def main():
    engine = create_async_engine(os.environ['DATABASE_URL'])
    hashed = CryptContext(schemes=['bcrypt']).hash('你的新密码')
    async with engine.begin() as conn:
        result = await conn.execute(
            text(\"UPDATE users SET hashed_password=:h WHERE email='你的邮箱'\"),
            {'h': hashed}
        )
    print('Done, rows updated:', result.rowcount)

asyncio.run(main())
"
```

看到 `Done, rows updated: 1` 即重置成功，然后用新密码登录即可。

> **注意**：不要用 bash 字符串直接拼接哈希值——bcrypt 哈希包含 `$` 符号，在 bash 双引号中会被当作变量展开导致哈希损坏，上面的 Python 方式可完全避免此问题。

### Q9：登录成功后立即退出 / 一直跳回登录页

**原因**：`backend/.env` 中 `SECRET_KEY` 未填写或使用了占位符默认值，导致后端每次重启 JWT 签名都发生变化，已登录的 token 立即失效。

**解决方法**：在 `backend/.env` 中将 `SECRET_KEY` 替换为一个随机字符串（至少 32 位）：
```bash
# 在终端生成一个随机密钥：
python3 -c "import secrets; print(secrets.token_hex(32))"
```
将输出结果填入 `.env`，然后重启容器：`docker compose restart api`。

### Q10：前端显示 CORS 错误或"Failed to fetch"

**可能原因 1**：`frontend/.env.local` 中 `NEXT_PUBLIC_API_URL` 填写有误（多了末尾斜杠、端口错误等）。
正确格式：
```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

**可能原因 2**：后端容器未运行。确认：
```bash
docker compose ps    # 确认 api 状态为 Up
```

### Q11：运行集成测试后主库数据被清空

**原因**：集成测试的 `setup_db` fixture 会清空所有表以保证测试幂等。若运行测试时未正确指定 `TEST_DATABASE_URL`，可能误连到主库 `planpilot` 并清空数据。

**预防**：运行集成测试时必须显式指定测试库：
```bash
# 在 Docker 容器内运行（推荐方式）：
docker compose exec api bash -c \
  "cd /app && TEST_DATABASE_URL='postgresql+asyncpg://planpilot:password@postgres:5432/planpilot_test' \
   pytest tests/integration/ -v -m integration"
```

**切勿**直接运行 `pytest tests/integration/` 而不设置 `TEST_DATABASE_URL`。

### Q12：集成测试报错 `type "vector" does not exist`

**原因**：`planpilot_test` 数据库未启用 pgvector 扩展。

**解决方法**：手动启用扩展后重新运行测试：
```bash
docker compose exec postgres psql -U planpilot -d planpilot_test \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### Q13：国内网络拉取 Docker 镜像超时 / 失败

**解决方法**：在 Docker Desktop 中配置镜像加速。

打开 Docker Desktop → Settings → Docker Engine，在 JSON 配置中添加：
```json
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://registry.cn-hangzhou.aliyuncs.com"
  ]
}
```
点击 "Apply & Restart"，然后重新执行 `docker compose up -d --build`。

### Q15：如何查看数据库中的用户列表（诊断账号问题）

当遇到账号丢失、无法登录等问题时，可直接查询数据库确认用户数据状态。

**方式一：终端命令**

```bash
# 查看主库中的用户列表
docker compose exec postgres psql -U planpilot -d planpilot -c "SELECT email, username, is_active, created_at FROM users;"

# 查看测试库中的用户列表（集成测试创建的账号）
docker compose exec postgres psql -U planpilot -d planpilot_test -c "SELECT email, username FROM users;"
```

**方式二：DataGrip（推荐，可视化操作）**

连接信息：Host=`localhost`，Port=`5432`，User=`planpilot`，Password=`password`。

连接后在左侧面板展开：`planpilot（数据源）→ planpilot（数据库）→ public → Tables → users`，双击即可查看数据，支持直接在单元格中编辑。

> **注意**：主库（`planpilot`）和测试库（`planpilot_test`）是完全独立的数据库。集成测试只写入测试库，但如果运行测试时未正确设置 `TEST_DATABASE_URL`，可能误操作主库（参考 Q11）。

**关于密码字段：**

数据库中存储的是 `hashed_password` 字段，内容类似 `$2b$12$xxxxx...`。这是 bcrypt 哈希值——bcrypt 是**单向加密**算法，哈希值无法还原成原始密码。如需重置密码，参考 Q8。

---

### Q14：Apple Silicon Mac（M1/M2/M3）容器启动报 `exec format error`

**原因**：部分 Docker 镜像只提供 `amd64` 架构，与 Apple Silicon 的 `arm64` 不兼容。

**解决方法**：在 `docker-compose.yml` 中为对应服务添加 `platform` 字段：
```yaml
services:
  api:
    platform: linux/amd64
    # ... 其余配置不变
```
修改后重新构建：`docker compose up -d --build`。

> Apple Silicon 的 Docker Desktop 内置 Rosetta 2 转译，加上 `platform: linux/amd64` 后性能略有下降但功能完全正常。

---

## 附录：服务端口速查表

| 服务 | 本机端口 | 说明 |
|------|---------|------|
| 前端 Next.js | 3000 | 主应用入口，浏览器访问 |
| 后端 FastAPI | 8000 | API 服务，含 /docs Swagger 页 |
| PostgreSQL | 5432 | 数据库（一般不需要直接访问） |
| Redis | 6379 | 缓存/消息队列（一般不需要直接访问） |
| MinIO API | 9000 | 对象存储 API |
| MinIO 控制台 | 9001 | MinIO 管理界面 |

---

*文档最后更新：2026-07-21*
