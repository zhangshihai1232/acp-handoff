# acp-handoff

`acp-handoff` 是一个安装在 OpenClaw `extensions` 目录下的插件，用来拦截 ACP 子任务创建流程，把父会话的上下文、规则和必要的任务元信息打包后交给子 Agent，解决 `sessions_spawn` 只有字符串 `task`、上下文容易丢失的问题。

## 快速开始

1. 确保本机已安装 OpenClaw。
2. 执行一键安装命令，把插件放到 `~/.openclaw/extensions/acp-handoff`。
3. 确认目录中存在 `openclaw.plugin.json`。
4. 在 OpenClaw 中使用内置的 `acpoff` 或 `cron-acp` skill 触发 ACP 子任务。
5. 按需参考 `docs/USAGE_GUIDE.md` 和 `docs/DEEP_DIVE.md` 深入配置。

## 核心功能

- 上下文交接：捕获父会话的 system prompt、对话上下文和项目规则，并注入到 ACP 子任务。
- 结构化请求：支持用 XML 风格的 `acp_request` 描述目标 Agent、模型、回调方式和上下文裁剪策略。
- Skill 入口：仓库内置 `acpoff`、`acp-handoff`、`cron-acp` 三套 skill，分别面向日常触发、内部协议和定时任务。
- 会话续接：支持通过 `sessionKey` 维持子任务会话，减少重复注入上下文。
- 异步回推：支持在异步执行完成后，把结果通过 callback 通道回推。

## 安装

### 方式一：`curl | bash` 一键安装

默认安装到 `~/.openclaw/extensions/acp-handoff`：

```bash
curl -fsSL https://raw.githubusercontent.com/zhangshihai1232/acp-handoff/main/install.sh | bash
```

如果你的 OpenClaw 根目录不是默认的 `~/.openclaw`，可以先指定 `OPENCLAW_HOME`：

```bash
OPENCLAW_HOME=/path/to/.openclaw \
curl -fsSL https://raw.githubusercontent.com/zhangshihai1232/acp-handoff/main/install.sh | bash
```

安装脚本会：

- 下载当前仓库的 `main` 分支源码归档
- 安装到 `${OPENCLAW_HOME:-$HOME/.openclaw}/extensions/acp-handoff`
- 如果目标目录已存在，先备份为 `acp-handoff.backup-时间戳`

### 方式二：手动安装

```bash
mkdir -p ~/.openclaw/extensions
git clone https://github.com/zhangshihai1232/acp-handoff.git ~/.openclaw/extensions/acp-handoff
```

## 环境要求

- 已安装并可正常使用的 OpenClaw
- `bash`
- `curl`
- `tar`

## 使用示例

### 对话中触发 ACP 子任务

安装完成后，可以直接使用仓库自带的 `acpoff` skill。

其中 `claude` 只是示例名，请替换成你在 ACP / OpenClaw 环境里实际可用的子 Agent 名称：

```text
使用 acpoff 让 claude 执行以下任务：

<task>
分析 src/protocol.ts 文件的类型定义，并输出：
1. 所有导出的类型
2. 类型之间的依赖关系
3. 两条潜在的重构建议
</task>
```

如果你希望当前对话里同步拿到结果，可以这样写：

```text
使用 acpoff 让 claude 执行以下任务（同步返回）：

<task>
读取 src/protocol.ts 的前 80 行，并说明 ContextControl 相关字段的作用。
</task>
```

### Cron 场景

推荐方式不是手写 `jobs.json`，而是**直接让 AI 使用 `cron-acp` skill 创建任务**。

例如你可以直接对 OpenClaw 说：

```text
使用 cron-acp 创建一个每小时执行一次的代码巡检任务：

- OpenClaw agent：wolf
- 任务标识符：hourly-review
- 任务名称：Hourly Review
- Cron：7 * * * *
- ACP agent：claude
- sessionKey：hourly-review
- 回调：discord -> user:YOUR_DISCORD_USER_ID
- 提示词：检查当前仓库最近一小时新增的风险点，并给出简短总结。
```

`cron-acp` 会帮你做三件事：

1. 在对应 workspace 下创建任务目录  
   `~/.openclaw/workspace-wolf/cron/hourly-review/`
2. 写入两个任务文件  
   - `prompt.md`：真正给 ACP 子 Agent 的任务内容  
   - `metadata.json`：`agentId`、`sessionKey`、`responseMode`、`callback` 等元数据
3. 再注册一个**普通 OpenClaw cron**，让它按计划触发这个任务

这里要注意两层 agent：

- `wolf` 是 **OpenClaw 里负责执行 cron 的 agent**
- `claude` 是 **真正被派发出去的 ACP 子 Agent**

### Cron 怎么用

1. 让 AI 用 `cron-acp` 创建任务。
2. 检查生成的文件：  
   - `~/.openclaw/workspace-wolf/cron/hourly-review/prompt.md`  
   - `~/.openclaw/workspace-wolf/cron/hourly-review/metadata.json`
3. 执行 `openclaw cron list`，确认 cron 已注册。
4. 执行 `openclaw cron run hourly-review` 手动跑一遍。
5. 检查 `~/.openclaw/workspace-wolf/.openclaw/acp-handoff/latest-observed-cli-payload.txt`，确认插件已经生成最终 handoff payload。
6. 检查 `~/.openclaw/acp-handoff/session-keys/claude-hourly-review.json`，确认 `sessionKey` 已被记录。

### 普通 cron 和 cron-acp cron 的差别

- **普通 cron**：任务内容通常直接写在 cron 本身的 payload/message 里。
- **cron-acp cron**：cron 只负责“定时触发哪个任务”；真正任务内容放在 `prompt.md` 和 `metadata.json` 里。

所以大多数情况下，你只需要关心 `workspace/cron/{taskId}/` 下面的两个文件，不需要先手写 `jobs.json`。

### Cron 常见坑

- `callback.to` 要替换成你自己的真实目标，例如 `user:1234567890`。
- 如果你只是修改任务内容，优先改 `prompt.md` 或 `metadata.json`，不要先改底层 cron 注册项。
- `~/.openclaw/cron/jobs.json` 更适合当作调试 / 排障视角来看，不是推荐的主编辑入口。

更完整的对话示例、Cron 配置和字段说明见：

- `docs/USAGE_GUIDE.md`
- `docs/DEEP_DIVE.md`
- `docs/DIAGRAMS.md`

## 项目结构

```text
.
├── index.ts               # 插件入口
├── openclaw.plugin.json   # OpenClaw 插件清单
├── install.sh             # curl | bash 安装脚本
├── skills/                # 内置 skills
└── docs/                  # 使用说明和设计文档
```

## License

当前仓库未包含 `LICENSE` 文件。若你要对外分发或开源，请补充明确的许可证声明后再使用。
