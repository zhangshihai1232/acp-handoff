# ACP-Handoff 使用指南

## 目录

1. [功能概述](#功能概述)
2. [案例 1：对话中触发 ACP 异步执行](#案例-1对话中触发-acp-异步执行)
3. [案例 2：Cron 定时任务配置](#案例-2cron-定时任务配置)
4. [字段说明](#字段说明)
5. [最佳实践](#最佳实践)
6. [故障排查](#故障排查)

---

## 功能概述

acp-handoff 插件允许在对话或 Cron 任务中触发 ACP 子任务，并支持：

- **上下文交接**：自动打包父会话的 systemPrompt + 对话历史
- **细粒度控制**：7 个 Project Context 文件独立开关
- **自定义 guide**：覆盖默认执行指导
- **会话续接**：通过 sessionKey 实现多轮对话
- **模型切换**：为子任务指定不同模型
- **异步回调**：支持 Discord 消息推送

---

## 案例 1：对话中触发 ACP 异步执行

### 场景描述

在与任意 agent 的对话中，触发 `claude` 子 Agent 执行代码分析任务，结果通过 Discord 推送。

### 方式 1：极简格式（推荐）⭐

**最简单的触发方式**，只需要提供 agent 和任务内容：

```
使用 acpoff 让 claude 执行以下任务：

<task>
分析 src/protocol.ts 文件的类型定义，输出：
1. 所有导出的类型及其用途
2. 类型之间的依赖关系
3. 可能的优化建议
</task>
```

**说明**：`<task>` 标签用于隔离任务内容，避免 AI 将任务误认为是给自己的指令（尤其重要，当使用性能较弱的模型时）

**说明**：
- 自动使用异步模式（不阻塞对话）
- 自动推送到 Discord
- 自动应用优化的默认配置（不包含 tools/artifacts）

**可选配置**：

```
使用 acpoff 让 claude 执行以下任务（同步返回）：

<task>
读取 src/protocol.ts 的前 50 行
</task>
```

```
使用 acpoff 让 claude 执行以下任务（最小上下文）：

<task>
统计 src 目录下的 .ts 文件数量
</task>
```

```
使用 acpoff 让 claude 执行以下任务（续接 code-analysis）：

<task>
基于上次的分析，重点说明 ContextControl 的设计
</task>
```

**支持的选项**：
- `同步` / `同步返回` / `sync` → 同步返回结果
- `异步` / `async` → 异步推送到 Discord（默认）
- `最小上下文` → 只保留 IDENTITY + SOUL + USER
- `完整上下文` → 包含所有上下文（包括 tools/artifacts）
- `续接 <sessionKey>` → 续接指定的会话

### 方式 2：完整 XML 格式（高级用户）

如果需要更精细的控制，可以使用完整的 XML 格式：

### 完整提示词

```
请使用 acpoff skill 处理这个请求。

<acp_request>
  <meta>
    <agentId>claude</agentId>
    <sessionKey>code-analysis-session</sessionKey>
    <model>sonnet</model>
    <maxTurns>3</maxTurns>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:YOUR_DISCORD_USER_ID</to>
    </callback>
    <includeMemory>true</includeMemory>
    <includeRules>true</includeRules>
    <includeAgents>true</includeAgents>
    <includeTools>false</includeTools>
    <includeArtifacts>false</includeArtifacts>
  </meta>
  <cli_prompt>
分析 src/protocol.ts 文件的类型定义，输出：
1. 所有导出的类型及其用途
2. 类型之间的依赖关系
3. 可能的优化建议
  </cli_prompt>
</acp_request>
```

### 字段说明

| 字段 | 值 | 说明 |
|------|-----|------|
| `agentId` | `claude` | 目标 ACP 子 agent（示例名，替换为你实际配置的名称）|
| `sessionKey` | `code-analysis-session` | 会话标识（用于续接）|
| `model` | `sonnet` | 使用 Sonnet 模型 |
| `maxTurns` | `3` | 最多 3 轮对话 |
| `responseMode` | `async-callback` | 异步模式（必须配合 callback）|
| `callback.channel` | `discord` | 回调渠道 |
| `callback.to` | `user:YOUR_DISCORD_USER_ID` | 目标用户 ID |
| `includeMemory` | `true` | 包含历史记忆 |
| `includeRules` | `true` | 包含核心原则 |
| `includeAgents` | `true` | 包含协作规范 |
| `includeTools` | `false` | 不包含工具说明（节省 token）|
| `includeArtifacts` | `false` | 不包含文件路径（节省 token）|

### 执行流程

1. **触发**：在对话中发送上述提示词
2. **检测**：插件检测到 `[acp-handoff]` 标记（acpoff skill 自动添加）
3. **打包**：插件读取父会话快照，打包上下文
4. **执行**：spawn `claude` agent，传递完整 payload
5. **回调**：子任务完成后，通过 Discord 推送结果

### 预期结果

- Discord 收到消息，包含代码分析结果
- 会话 key 存储到 `~/.openclaw/acp-handoff/session-keys/claude-code-analysis-session.json`
- 下次使用相同 sessionKey 时，会续接同一个 session

### 续接示例

第二次触发（使用相同 sessionKey）：

```
请使用 acpoff skill 处理这个请求。

<acp_request>
  <meta>
    <agentId>claude</agentId>
    <sessionKey>code-analysis-session</sessionKey>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:881734814204571708</to>
    </callback>
  </meta>
  <cli_prompt>
基于上次的分析，重点说明 ContextControl 类型的设计意图。
  </cli_prompt>
</acp_request>
```

**注意**：第二次不需要重复注入上下文，插件会自动续接。

---

## 案例 2：Cron 定时任务配置

### 场景描述

每小时执行一次 skill 体系检查，发现缺失的 skill 并创建，结果推送到 Discord。

### 推荐方式：让 AI 用 cron-acp 创建

推荐流程不是先手写 `~/.openclaw/cron/jobs.json`，而是直接让 AI 使用 `cron-acp` skill 创建任务。

你可以这样说：

```text
使用 cron-acp 创建一个每小时执行一次的 skill 检查任务：

- OpenClaw agent：wolf
- 任务标识符：skill-builder-hourly
- 任务名称：Skill Builder - Hourly Check
- Cron：7 * * * *
- ACP agent：claude
- sessionKey：skill-builder-persistent
- 回调：discord -> user:YOUR_DISCORD_USER_ID
- 提示词：
  分析当前 skill 体系，识别缺失的常用 skill 类型，并为缺失项创建 SKILL.md。
```

### 创建后会得到什么

`cron-acp` 会在对应 OpenClaw workspace 下创建一个任务目录：

```text
~/.openclaw/workspace-wolf/cron/skill-builder-hourly/
├── prompt.md
└── metadata.json
```

- `prompt.md`：真正交给 ACP 子 agent 的任务正文
- `metadata.json`：`agentId`、`sessionKey`、`responseMode`、`callback` 等元数据

然后它会再创建一个**普通 OpenClaw cron**，负责按计划触发这个任务。

### 普通 cron 和 cron-acp cron 的差别

| 类型 | 任务内容放哪里 | 适合什么场景 |
|------|----------------|-------------|
| 普通 cron | 直接写在 cron 本身的 payload/message | 简单定时任务 |
| cron-acp cron | 写在 `{workspace}/cron/{taskId}/prompt.md` 和 `metadata.json` | 需要 ACP 子任务、续接、回调、后续可维护的任务 |

### 你平时应该编辑哪里

优先编辑这两个文件：

```text
~/.openclaw/workspace-wolf/cron/skill-builder-hourly/prompt.md
~/.openclaw/workspace-wolf/cron/skill-builder-hourly/metadata.json
```

`~/.openclaw/cron/jobs.json` 更适合作为调度层或排障视角查看，通常不是首选编辑入口。

### 怎么验证

```bash
# 查看 cron 是否已注册
openclaw cron list

# 手动触发一次
openclaw cron run skill-builder-hourly

# 查看任务内容文件
cat ~/.openclaw/workspace-wolf/cron/skill-builder-hourly/prompt.md
cat ~/.openclaw/workspace-wolf/cron/skill-builder-hourly/metadata.json

# 查看插件生成的 payload
cat ~/.openclaw/workspace-wolf/.openclaw/acp-handoff/latest-observed-cli-payload.txt

# 查看 sessionKey 映射
cat ~/.openclaw/acp-handoff/session-keys/claude-skill-builder-persistent.json
```

### 执行流程

1. **创建阶段**：AI 用 `cron-acp` 建任务目录并注册 cron
2. **触发阶段**：OpenClaw cron 到点后启动 `wolf` 会话
3. **读取阶段**：`cron-acp` 从 `prompt.md` 和 `metadata.json` 读取任务定义
4. **交接阶段**：插件检测 `[acp-handoff]`，打包上下文
5. **执行阶段**：创建 `claude` 子会话
6. **完成阶段**：子任务完成，结果按配置回推

### 验证方法

```bash
# 查看 cron 任务列表
openclaw cron list

# 手动触发测试
openclaw cron run skill-builder-hourly

# 查看任务定义文件
cat ~/.openclaw/workspace-wolf/cron/skill-builder-hourly/prompt.md
cat ~/.openclaw/workspace-wolf/cron/skill-builder-hourly/metadata.json

# 查看生成的 payload
cat ~/.openclaw/workspace-wolf/.openclaw/acp-handoff/latest-observed-cli-payload.txt

# 查看会话 key 存储
cat ~/.openclaw/acp-handoff/session-keys/claude-skill-builder-persistent.json
```

---

## 字段说明

### 必填字段

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `agentId` | string | 目标 ACP 子 agent ID | `claude`, `copilot`, `你的自定义 agent` |
| `cli_prompt` | string | 任务描述 | 分析代码结构 |

### 可选字段（会话控制）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sessionKey` | string | - | 会话标识（用于续接）|
| `model` | string | - | 模型名称（sonnet/opus/haiku）|
| `maxTurns` | number | - | 最大轮数限制 |

### 可选字段（响应模式）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `responseMode` | string | `sync-return` | 同步返回 / 异步回调 |
| `callback.channel` | string | - | 回调渠道（仅 discord）|
| `callback.to` | string | - | 目标地址（user:ID / channel:ID）|
| `callback.accountId` | string | - | 账户 ID（可选）|
| `callback.replyToId` | string | - | 回复消息 ID（可选）|

### 可选字段（上下文控制）

| 字段 | 类型 | 默认值 | 说明 | Token 影响 |
|------|------|--------|------|-----------|
| `includeIdentity` | boolean | `true` | IDENTITY.md（身份）| 必须 |
| `includeSoul` | boolean | `true` | SOUL.md（风格）| 必须 |
| `includeRules` | boolean | `true` | RULES.md（原则）| ~300 |
| `includeAgents` | boolean | `true` | AGENTS.md（协作）| ~200 |
| `includeMemory` | boolean | `true` | MEMORY.md（记忆）| 变化 |
| `includeTools` | boolean | `false` | TOOLS.md（工具）| ~400 |
| `includeArtifacts` | boolean | `false` | 文件路径 | ~200 |

**注意**：USER.md 始终包含，无法关闭。

### 可选字段（自定义 guide）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `customGuide` | string | - | 覆盖默认 guide（支持多行）|

---

## 最佳实践

### 1. 对话触发场景

**推荐配置**：
- `responseMode`: `async-callback`（避免阻塞对话）
- `includeMemory`: `true`（保留上下文）
- `includeRules`: `true`（保留原则）
- `includeAgents`: `true`（保留协作规范）
- `includeTools`: `false`（节省 token）
- `includeArtifacts`: `false`（节省 token）

**适用任务**：
- 代码分析
- 文档生成
- 数据处理

### 2. Cron 定时任务场景

**推荐配置**：
- 优先让 AI 用 `cron-acp` 创建 `{workspace}/cron/{taskId}/prompt.md` 和 `metadata.json`
- `includeMemory`: `false`（定时任务不需要历史）
- `includeAgents`: `false`（定时任务不需要协作）
- `customGuide`: 提供明确的执行流程

**适用任务**：
- 健康检查
- 定期分析
- 自动化维护

### 3. 简单任务场景

**推荐配置**：
- 关闭所有可选上下文（只保留 IDENTITY + SOUL + USER）
- 使用 `customGuide` 提供明确指导
- 节省 token：~1100 tokens

**适用任务**：
- 文件读取
- 简单分析
- 格式转换

### 4. 复杂任务场景

**推荐配置**：
- 启用所有上下文（包括 tools 和 artifacts）
- 使用默认 guide
- 提供详细的任务描述

**适用任务**：
- 系统重构
- 架构设计
- 复杂调试

---

## 故障排查

### 问题 1：Discord 没有收到消息

**可能原因**：
1. `callback.to` 格式错误（缺少 `user:` 或 `channel:` 前缀）
2. `responseMode` 不是 `async-callback`
3. Cron 任务使用了 cron 自带的 delivery（应该用 cron-acp skill）

**解决方案**：
```xml
<!-- 正确格式 -->
<callback>
  <channel>discord</channel>
  <to>user:881734814204571708</to>
</callback>
```

### 问题 2：子任务没有上下文

**可能原因**：
1. 没有添加 `[acp-handoff]` 标记（手动触发时）
2. 上下文字段被显式关闭

**解决方案**：
- 对话触发：使用 acpoff skill（自动添加标记）
- Cron 触发：使用 cron-acp skill（自动添加标记）
- 检查 includeXxx 字段是否正确

### 问题 3：Token 消耗过高

**可能原因**：
1. 包含了无用的 tools 和 artifacts
2. MEMORY.md 内容过大

**解决方案**：
```xml
<includeTools>false</includeTools>
<includeArtifacts>false</includeArtifacts>
<includeMemory>false</includeMemory>  <!-- 如果不需要历史 -->
```

### 问题 4：会话续接失败

**可能原因**：
1. `sessionKey` 拼写错误
2. `maxTurns` 达到上限
3. 会话 key 文件被删除

**解决方案**：
```bash
# 查看会话 key 存储
cat ~/.openclaw/acp-handoff/session-keys/<agentId>-<sessionKey>.json

# 检查 turnCount 是否达到 maxTurns
```

### 问题 5：自定义 guide 不生效

**可能原因**：
1. `customGuide` 标签拼写错误（区分大小写）
2. 内容为空

**解决方案**：
```xml
<!-- 正确格式 -->
<customGuide>
你是专家。
执行步骤：
1. 第一步
2. 第二步
</customGuide>
```

**注意**：不要使用 `<![CDATA[]]>` 标记，直接写内容即可。

---

## 验证清单

### 对话触发验证

- [ ] Discord 收到消息
- [ ] 消息包含完整结果
- [ ] 会话 key 正确存储
- [ ] 第二次触发能续接

### Cron 任务验证

- [ ] 任务按时触发
- [ ] 子任务正常执行
- [ ] Discord 收到消息
- [ ] 生成的 payload 文件正确

### Token 节省验证

- [ ] 默认不包含 artifacts
- [ ] 默认不包含 tools
- [ ] payload 文件大小减少 ~800 字节

---

## 相关文档

- **实施总结**：`IMPLEMENTATION_SUMMARY.md`
- **使用示例**：`CONTEXT_CONTROL_EXAMPLES.md`
- **验证清单**：`VERIFICATION_CHECKLIST.md`
- **内存记录**：`~/.claude/projects/.../memory/MEMORY.md`
