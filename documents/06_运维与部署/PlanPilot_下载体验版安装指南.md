# PlanPilot 下载体验版安装指南

> 适用版本：Docker 下载体验版
> 适用对象：希望在自己的电脑上体验 PlanPilot 的开发者和早期用户

PlanPilot 下载体验版会在本机运行产品界面、API、PostgreSQL、Redis、任务队列和文件存储。首次启动向导会自动生成安全密钥；即使暂不配置 AI，也可以使用账户、目标、任务、打卡和笔记等基础功能。

## 1. 安装前准备

| 项目 | 最低要求 | 建议 |
| --- | --- | --- |
| 操作系统 | macOS 12+、Windows 10/11、Ubuntu 20.04+ | 使用仍在安全支持期内的版本 |
| 内存 | 8 GB | 云端 AI 16 GB；本地 9B 模型 24 GB 以上 |
| 磁盘 | 10 GB 可用空间 | 使用本地模型时预留 20 GB |
| 软件 | Docker Desktop，或 Docker Engine + Compose v2 | Docker Desktop 保持最新稳定版 |

安装并启动 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，等待状态显示为 Running。Windows 用户需要启用 WSL 2 后端。

## 2. 下载和启动

从 [PlanPilot GitHub Releases](https://github.com/xyra17/planpilot-showcase/releases/latest) 下载名称类似 `PlanPilot-v*-docker-preview.zip` 的文件并解压。不要下载模型权重，也不要将程序解压到系统只读目录。

### macOS / Linux

打开终端，进入解压后的 `PlanPilot` 目录：

```bash
chmod +x start.sh stop.sh scripts/release/*.sh
./start.sh
```

### Windows

右键开始菜单打开 PowerShell，进入解压后的 `PlanPilot` 目录：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start.ps1
```

首次启动会进行以下操作：

1. 检查 Docker、Compose、磁盘空间和所需端口。
2. 自动创建 `.env` 与 `backend/.env`。
3. 为登录会话、数据库和本地对象存储生成独立随机密钥。
4. 询问要暂不配置 AI、使用云端 API，还是连接已有本地模型。
5. 构建容器、执行数据库迁移并打开 `http://localhost:3000`。

首次构建需要下载 Docker 镜像和项目依赖，耗时取决于网络环境。生成的密钥和 API Key 只保存在本机被 Git 忽略的配置文件中。

## 3. 选择 AI 模式

### A. 暂不配置

这是最安全的首次体验选项。以下功能仍可使用：

- 注册和登录
- 目标、任务、日程与打卡
- 笔记和基础知识库管理
- 数据导出和界面个性化

学习建议、计划生成、答案验证等生成式 AI 功能暂不可用；知识库会使用关键词检索，而不是语义检索。产品界面会明确显示这一状态。

### B. 云端 OpenAI-compatible API

向导会询问 Base URL、日常模型名、高质量模型名和 API Key。可以连接 DeepSeek 或其他兼容 OpenAI Chat Completions 接口的服务。

使用云端模型意味着相关提示词和上下文会发送给所选服务商。请阅读对应服务商的隐私政策和计费规则，不要把 API Key 发给他人或提交到 Git。

### C. 已有本地模型服务

PlanPilot 连接 OpenAI-compatible API，不要求模型文件放在项目目录内。Docker 容器访问宿主机服务时通常使用：

```text
http://host.docker.internal:8080/v1
```

本地模式至少需要一个生成模型服务；知识库语义检索还需要一个独立的 Embedding 服务。开始配置前，请先确认以下地址能返回模型列表：

```text
http://localhost:8080/v1/models
http://localhost:1234/v1/models
```

当前验证过的模型组合：

| 用途 | 模型 | 下载页面 | 运行方式 |
| --- | --- | --- | --- |
| 文本生成 | Qwen3.5-9B MLX 4-bit，约 5.6 GB | [Hugging Face](https://huggingface.co/mlx-community/Qwen3.5-9B-MLX-4bit) | Apple Silicon + MLX |
| 语义向量 | Qwen3-Embedding-0.6B GGUF | [Hugging Face](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF) | llama.cpp / LM Studio |

MLX 模型只适用于 Apple Silicon Mac。Windows、Intel Mac 和 Linux 用户应使用对应的 GGUF/llama.cpp 模型，或者选择云端 AI。模型权重不会包含在 PlanPilot 压缩包中；下载前请确认来源、文件哈希、许可证和机器内存是否满足要求。

需要重新运行配置向导时：

```bash
./scripts/release/configure.sh
```

Windows：

```powershell
.\scripts\release\configure.ps1
```

## 4. 停止、更新和卸载

停止并保留数据：

```bash
./stop.sh
```

Windows 使用 `.\stop.ps1`。再次运行启动脚本即可继续使用。

更新时，先停止旧版本并备份数据，再下载新压缩包。不要直接删除 Docker volumes。完整备份、恢复和彻底清理步骤见 [完整卸载与数据清理说明](./PlanPilot_完整卸载与数据清理说明.md)。

## 5. 常见问题

### 提示端口被占用

PlanPilot 默认只在本机绑定 `3000`、`8000`、`5432`、`6379`、`9000` 和 `9001` 端口。关闭占用端口的其他程序后重新运行启动脚本。

### AI 未配置是否代表启动失败？

不是。它只表示 AI 相关功能暂不可用，基础学习管理功能仍可正常使用。

### 本地模型明明启动了，但检查失败

确认模型服务监听 `0.0.0.0`，并在 PlanPilot 配置中使用 `host.docker.internal`，而不是容器内部的 `localhost`。Linux Docker Engine 如无法解析该域名，需要在 Docker 配置中启用 host-gateway 映射。

### 查看运行日志

```bash
docker compose logs --tail=200
docker compose ps
```

健康检查地址：

- 产品：`http://localhost:3000`
- API：`http://localhost:8000/ready`
- AI 状态：`http://localhost:8000/health/ai`
