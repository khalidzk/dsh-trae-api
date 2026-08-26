### 原项目：https://github.com/Wang-JQ77/dsh-trae-api

# dsh-trae-api (Trae Local API)

将 Trae Work CN 的**积分/额度**转化为本地 OpenAI/Anthropic 兼容 API 服务，让 Claude Code、Cursor、Cline、Windsurf 等第三方 AI 编程工具直接调用 Trae 底层模型（GLM、DeepSeek、Qwen、Kimi、MiniMax 等）。

本项目是一个 **DeepSeek Harness (DSH) 插件**（npm 包名 `@casually/dsh-trae-api`），安装后随 `dsh` 启动自动运行代理服务；也可以独立运行。

> npm 上的无 scope 包名 `dsh-trae-api` 归原项目作者所有；本 fork 以 `@casually/dsh-trae-api` 发布。

**v1.1.0 新增**：DSH Web **设置页面**（设置 → Trae API 代理）——实时状态、请求统计、Token 管理（刷新/重新解密）、上游连通性测试、配置热更新（保存即生效，无需重启 DSH）。

## 原理

1. 本机已安装并登录 Trae Work CN（或 TRAE SOLO CN / Trae SG / TRAE SOLO）
2. 脚本自动从本地 `storage.json` 中解密认证 Token（支持 tc 加密和明文两种格式）
3. 启动一个本地 Express 服务器，提供 OpenAI/Anthropic 兼容的 API 端点
4. 第三方 Agent 将请求发送到本地服务器，本地服务器转发到 Trae 上游 API
5. **消耗的是 Trae 的积分，无需额外付费**

## 支持的 Trae 版本

| 版本 | IDE 名称 | 加密格式 | 上游端点 |
|------|----------|----------|----------|
| `cn` | Trae CN 国内版 | tc 加密 | `trae-api-cn.mchost.guru` |
| `solo` | TRAE SOLO CN 独立部署版 | tc 加密 | `trae-api-cn.mchost.guru` |
| `sg` | Trae 国际版 | 明文 JSON | `a0ai-api-sg.byteintlapi.com` |
| `solo-sg` | TRAE SOLO 国际版 | tc 加密 | `a0ai-api-sg.byteintlapi.com` |

## 功能

- 自动解密四版本认证数据，无需手动配置 Token
- 提供 OpenAI (`/v1/chat/completions`) 和 Anthropic (`/v1/messages`) 兼容接口
- 支持 OpenAI Responses API (`/v1/responses`)，兼容新版 OpenAI SDK 和 Agents SDK
- Token 过期自动刷新，自动保存到 `.env`
- 支持流式输出 (SSE)
- 完整支持 Claude Code 工具调用
- 3 级 API 端点回退机制
- 自适应 CN/SG 两种 SSE 事件格式
- 上下文窗口自动截断，避免超出 Token 限制
- **DSH 设置页面**（v1.1.0+）：
  - 运行状态一览（监听地址、版本、上游、用户、Token/Refresh 过期倒计时）
  - 请求统计（各端点请求数、错误数、运行时长）
  - 一键刷新 Token / 重新解密凭证 / 测试上游连接
  - 端口、监听地址、API Key、版本、上游地址、上下文上限在线修改，**保存后代理热重启立即生效**

## 前置条件

- **Node.js >= 18**（内置 `fetch` 支持）
- **已安装并登录**以下任一 Trae IDE：
  - Trae CN（国内版）
  - TRAE SOLO CN（独立部署版）
  - Trae（国际版）
  - TRAE SOLO（国际版）
- 对应 IDE 的 `%APPDATA%` 目录下存在 `globalStorage/storage.json`

## 快速开始

### 方式 A：作为 DSH 插件安装（推荐）

前提：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` CLI）。

```bash
# 安装到 web profile
dsh plugin --profile web add @casually/dsh-trae-api

# 重启 dsh 使插件生效
dsh web
```

插件启动后，代理服务自动运行在 `http://localhost:9220`。可通过插件配置自定义端口和 API Key：

```yaml
# 编辑 profile 的 cordis.patch.yml
- insert:
    - id: trae-api
      name: '@casually/dsh-trae-api'
      config:
        port: 9220
        apiKey: ***
```

卸载：

```bash
dsh plugin --profile web remove @casually/dsh-trae-api
```

### 方式 B：独立运行

#### 1. 安装依赖

```bash
npm install
```

#### 2. 一键启动

```bash
# Windows 双击 start.bat 即可
start.bat

# 或命令行
npm start
```

**首次运行**会自动从本机 Trae IDE 的 `storage.json` 解密认证数据并保存到 `.env`，之后直接读取 `.env` 启动。

### 3. 连接第三方 Agent

#### Claude Code

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:9220"
$env:ANTHROPIC_API_KEY = "trae-local-api"
claude
```

#### Cursor

- Base URL: `http://localhost:9220/v1`
- API Key: `trae-local-api`
- Model: 选择任意模型名（如 `claude-sonnet-4-6`、`gpt-4o`、`auto`）

#### Cline / Roo Code

在扩展设置中配置：
- OpenAI Compatible Base URL: `http://localhost:9220/v1`
- API Key: `trae-local-api`
- Model ID: `claude-sonnet-4-6`

#### Windsurf

在配置中添加自定义模型：
- Provider: OpenAI Compatible
- Base URL: `http://localhost:9220/v1`
- API Key: `trae-local-api`

#### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9220/v1", api_key="***")

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

## DSH 设置页面（v1.1.0+）

以 DSH 插件方式安装后，打开 DSH Web 界面 **设置 → Trae API 代理**：

| 区块 | 说明 |
|------|------|
| 运行状态 | 监听地址、Trae 版本、上游地址、用户 ID、Token/Refresh Token 过期时间与剩余时长 |
| 操作 | 刷新状态 · 立即刷新 Token · 重新解密凭证（可指定版本）· 测试上游连接（发送最小探针请求，消耗极少量 token） |
| 请求统计 | chat / messages / count_tokens / responses / models / status 各端点请求数、错误数、运行时长 |
| 服务配置 | 端口、监听地址（127.0.0.1 / 0.0.0.0）、API Key、Trae 版本、上游地址、最大上下文 |
| 客户端接入 | Claude Code / Cursor / Cline 接入示例（一键复制） |

**配置优先级**（后者覆盖前者）：

```
内置默认值 < $DSH_HOME/plug-trae-api.json（设置页保存） < cordis.patch.yml 的 config 块
```

- 设置页保存的配置写入 `$DSH_HOME/plug-trae-api.json`，跨 DSH 重启保留；
- 保存后内部代理服务**热重启**，新端口/密钥立即生效，无需重启 DSH；
- 若某字段在 `cordis.patch.yml` 的 `config` 中显式声明，设置页修改会被其覆盖（页面会提示被锁定的字段）。

### 设置页本地 JSON API

设置页面通过以下宿主路由与插件通信（仅监听在 DSH Web 服务器上）：

| 路由 | 方法 | 说明 |
|------|------|------|
| `/plug-trae-api/status` | GET | 运行状态 + 认证信息 + 请求统计 |
| `/plug-trae-api/config` | GET/POST | 读取/保存配置（POST 保存后热重启代理） |
| `/plug-trae-api/refresh-token` | POST | 手动触发 Token 刷新（ExchangeToken） |
| `/plug-trae-api/reauth` | POST | 重新从本机 Trae IDE 解密凭证（可指定 edition） |
| `/plug-trae-api/test` | POST | 上游连通性探针（约消耗几十~几百上游 token） |

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/status` | 服务状态 |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | OpenAI 格式对话 |
| POST | `/v1/messages` | Anthropic 格式对话 |
| POST | `/v1/messages/count_tokens` | 估算 Token 数 |
| POST | `/v1/responses` | OpenAI Responses API |

## 模型映射

请求时传入 Claude/GPT 等模型名，会自动映射到 Trae 内部模型：

| 请求模型 | 映射到 | 档位 |
|----------|--------|------|
| `claude-opus-4-7` / `4-6` / `4-5` | glm-5.2 | T1 |
| `claude-sonnet-4-6` / `4-5` / `4` | glm-5.2 | T1 |
| `claude-3.5-sonnet` / `3.7-sonnet` | glm-5.2 | T1 |
| `claude-haiku-4-5` | glm-5.1 | T2 |
| `gpt-4o` / `gpt-4.1` | DeepSeek-V4-Pro | T2 |
| `gpt-4o-mini` | DeepSeek-V4-Flash | T3 |
| `auto` | glm-5.2 | T1 |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TRAE_EDITION` | Trae 版本 (cn/solo/sg/solo-sg) | cn |
| `TRAE_TOKEN` | 解密后的 JWT Token | (自动生成) |
| `TRAE_REFRESH_TOKEN` | 刷新用 Token | (自动生成) |
| `TRAE_USER_ID` | 用户 ID | (自动生成) |
| `TRAE_API_HOST` | Token 刷新服务地址 | (自动设置) |
| `API_KEY` | 本服务的 API Key（设为 `none` 可禁用鉴权，不推荐） | trae-local-api |
| `PORT` | 监听端口 | 9220 |
| `HOST` | 监听地址（`0.0.0.0` 开放局域网，需自担风险） | 127.0.0.1 |
| `BASE_URL` | 上游 API 地址 | (按版本自动设置) |
| `MAX_CONTEXT_TOKENS` | 最大上下文 Token 数 | 200000 |
| `TRAE_MANUAL_TOKEN` | 手动指定 Token (备用) | (空) |

## 手动解密

如果自动解密失败，可以单独运行解密流程：

```bash
npm run setup
```

或在 DSH 设置页面点击「重新解密凭证」。

## 开发与测试

```bash
npm install
node test/test.mjs   # 冒烟测试：挂载插件 + 遍历全部本地 API 路由
```

## 项目结构

```
dsh-trae-api/
├── lib/
│   └── index.js           # DSH 插件入口 (ESM, 代理启动 + /plug-trae-api/* JSON API)
├── client.js              # DSH Web 设置页面 (浏览器端, ModuleLoader + React)
├── cordis.patch.yml       # DSH bundle patch (挂载到 loader)
├── start.bat              # Windows 一键启动
├── setup.js               # 自动解密配置
├── package.json           # 项目配置 (含 dsh.bundle / dsh.client 声明)
├── .env.example           # 环境变量模板
├── .gitignore
├── LICENSE
├── README.md
├── test/
│   └── test.mjs           # 冒烟测试
└── src/
    ├── server.js          # 独立运行入口
    ├── server-core.js     # 可复用服务器核心 (startServer + stats)
    ├── auth.js            # 认证管理 (Token 刷新 / getAuthInfo)
    ├── trae-decrypt.js    # tc 加密解密核心
    ├── trae-client.js     # Trae API 客户端
    ├── openai-format.js   # OpenAI 格式转换
    └── anthropic-format.js # Anthropic 格式转换
```

## 注意事项

- 本工具仅在你**已经拥有 Trae 积分**的情况下有效，本质上是将 Trae 的 API 额度通过本地代理暴露为标准接口
- 默认仅监听 `127.0.0.1`，局域网与公网无法访问；如需开放给局域网设备，设置 `HOST=0.0.0.0`（请同时设置强 API_KEY）
- 默认启用 API Key 鉴权（默认值 `trae-local-api`，建议修改）；设置 `API_KEY=none` 可禁用鉴权，不推荐
- CORS 仅允许 `localhost` 来源的浏览器跨域请求，第三方网页无法盗刷积分
- Token 过期会自动刷新并回写 `.env`；`BASE_URL`、`MAX_CONTEXT_TOKENS` 等自定义配置会被保留
- 请勿将 `.env` 文件提交到版本控制（已在 `.gitignore` 中忽略）

## 免责声明

本工具仅供学习和研究使用。使用本工具调用 Trae API 所产生的费用和合规问题由用户自行承担。请遵守 Trae 平台的使用条款。
