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

安装完成后，可以直接使用仓库自带的 `acpoff` skill：

```text
使用 acpoff 让 clg 执行以下任务：

<task>
分析 src/protocol.ts 文件的类型定义，并总结关键结构。
</task>
```

### Cron 场景

如果你在 `~/.openclaw/cron/jobs.json` 中配置定时任务，可以使用 `cron-acp` skill 作为统一入口，让插件在 Cron 场景下也能完成 ACP 上下文交接和异步回推。

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
