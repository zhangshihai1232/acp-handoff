# ACP Handoff 插件深度说明文档

> 版本：基于 2026-03-20 代码分析
> 文档涵盖：插件原理、完整数据流、配置方式、skill 使用、定时任务集成

---

## 目录

1. [插件存在的意义](#1-插件存在的意义)
2. [整体架构图](#2-整体架构图)
3. [核心原理：完整执行链路](#3-核心原理完整执行链路)
   - 3.1 [OpenClaw → ACP 的信息断层问题](#31-openclaw--acp-的信息断层问题)
   - 3.2 [llm_input 快照捕获](#32-llm_input-快照捕获)
   - 3.3 [before_tool_call：上下文注入](#33-before_tool_call上下文注入)
   - 3.4 [after_tool_call：异步结果回推](#34-after_tool_call异步结果回推)
4. [Session 持久化与续接机制](#4-session-持久化与续接机制)
   - 4.1 [sessionKey 工作原理](#41-sessionkey-工作原理)
   - 4.2 [maxTurns 轮次限制](#42-maxturns-轮次限制)
   - 4.3 [首轮 vs 续接轮的差异](#43-首轮-vs-续接轮的差异)
5. [结构化 ACP 请求协议](#5-结构化-acp-请求协议)
   - 5.1 [XML 信封格式](#51-xml-信封格式)
   - 5.2 [字段说明](#52-字段说明)
   - 5.3 [responseMode 两种模式](#53-responsemode-两种模式)
6. [Cron 定时任务集成](#6-cron-定时任务集成)
   - 6.1 [cron 场景的特殊挑战](#61-cron-场景的特殊挑战)
   - 6.2 [cron-acp skill 解决方案](#62-cron-acp-skill-解决方案)
   - 6.3 [skill-builder-hourly-v2 案例分析](#63-skill-builder-hourly-v2-案例分析)
7. [Skills 使用指南](#7-skills-使用指南)
   - 7.1 [acpoff（用户入口）](#71-acpoff用户入口)
   - 7.2 [acp-handoff（内部协议）](#72-acp-handoff内部协议)
   - 7.3 [cron-acp（cron 专用）](#73-cron-acpcron-专用)
8. [数据存储结构](#8-数据存储结构)
9. [Discord 回调流程](#9-discord-回调流程)
10. [配置参考](#10-配置参考)
11. [排障指南](#11-排障指南)

---

## 1. 插件存在的意义

OpenClaw 的 `sessions_spawn` 工具只能传递一个字符串 `task`。当父 Agent（如 wolf）派发子任务给 ACP 子 Agent（如 clt/clmini）时，子 Agent 对以下信息一无所知：

- 父 Agent 的身份（IDENTITY.md）
- 父 Agent 的行为原则（SOUL.md）
- 当前项目上下文（USER.md、TOOLS.md、AGENTS.md）
- 父会话的对话历史

`acp-handoff` 插件解决了这个"信息断层"：它拦截 `sessions_spawn` 调用，自动将父会话的完整上下文打包注入到子任务中，让子 Agent 以完整身份执行任务。

---

## 2. 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                              │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  父 Agent（wolf/fox 等）                                  │  │
│  │                                                            │  │
│  │  用户消息 → LLM 推理 → sessions_spawn(task="[acp-handoff] ...")  │
│  └──────────────┬───────────────────────────────────────────┘  │
│                 │ 拦截                                           │
│  ┌──────────────▼───────────────────────────────────────────┐  │
│  │  acp-handoff 插件                                         │  │
│  │                                                            │  │
│  │  llm_input ──→ 捕获快照（systemPrompt + history）         │  │
│  │                    ↓                                       │  │
│  │  before_tool_call ──→ 读快照 → 渲染 handoff_payload       │  │
│  │                    ↓                                       │  │
│  │  after_tool_call ──→ 启动后台监听 → Discord 回推          │  │
│  └──────────────┬───────────────────────────────────────────┘  │
│                 │ 改写后的 task                                  │
│  ┌──────────────▼───────────────────────────────────────────┐  │
│  │  ACP Runtime (acpx)                                       │  │
│  │                                                            │  │
│  │  创建子 Agent 独立 session                                 │  │
│  │  子 Agent 收到完整 <handoff_payload>                       │  │
│  │  执行任务 → 结果写入 session 文件                          │  │
│  └──────────────┬───────────────────────────────────────────┘  │
│                 │ 轮询检测完成                                   │
│  ┌──────────────▼───────────────────────────────────────────┐  │
│  │  后台监听器（setImmediate 非阻塞）                         │  │
│  │                                                            │  │
│  │  waitForChildSessionCompletion（最多 120 秒）              │  │
│  │  → 存储 sessionKey 映射（用于下次续接）                    │  │
│  │  → sendToDiscord（api.runtime.channel.discord）            │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心原理：完整执行链路

### 3.1 OpenClaw → ACP 的信息断层问题

OpenClaw 的 Agent 系统提示由以下部分构成：

```
系统提示 = IDENTITY.md + SOUL.md + AGENTS.md + TOOLS.md + USER.md（Project Context）
```

当父 Agent 调用 `sessions_spawn(runtime="acp", task="做某事")` 时，ACP 子 Agent 只收到 `"做某事"` 这个字符串，完全不知道自己是谁、有什么规则、用户是谁。

`acp-handoff` 的解法：在 `sessions_spawn` 实际执行前，把父 Agent 的完整系统提示和对话历史"塞进" task，让子 Agent 以完整上下文启动。

### 3.2 llm_input 快照捕获

每次父 Agent 进行 LLM 推理时，插件监听 `llm_input` 事件并创建快照：

```
llm_input 事件
    ↓
createSnapshot({
    runId,
    sessionId,
    sessionKey,          ← "agent:wolf:webchat:xxxx"
    agentId,             ← "wolf"
    workspaceDir,
    provider,            ← "anthropic"
    model,               ← "claude-opus-4-6"
    systemPrompt,        ← 完整系统提示（含 IDENTITY/SOUL/Project Context）
    prompt,              ← 用户最新消息
    historyMessages,     ← 完整对话历史
})
    ↓
storeSnapshot(snapshot)
    ↓
    ├─ 内存缓存（Map<sessionKey, snapshot>）
    └─ 磁盘缓存（~/.openclaw/acp-handoff/cache/{hash16}.json）
              └─ runs 子目录（~/.openclaw/acp-handoff/cache/runs/{runId}.json）
```

**快照的大小限制**（防止超出 token 限制）：

| 字段 | 上限 |
|------|------|
| systemPrompt | 60,000 字符 |
| prompt（用户消息） | 20,000 字符 |
| 单条历史消息 | 4,000 字符 |
| 历史消息总量 | 80,000 字符 |
| 子任务文本 | 12,000 字符 |

### 3.3 before_tool_call：上下文注入

```
sessions_spawn 调用（含 [acp-handoff] 信号）
    ↓
1. 提取信号，识别触发模式（普通 / 结构化 / cron）
    ↓
2. 读取快照（优先 runId → sessionKey → transcript 降级）
    ↓
3. 解析结构化请求（如果有 <acp_request> XML）
    ↓
4. 检查 sessionKey → 读取存储的 acpSessionId
   ├─ 有 resumeSessionId 且未超轮次 → 续接模式
   └─ 无 / 超轮次 → 首轮模式
    ↓
5. 构建 rewrittenTask：
   ├─ 首轮：renderConcretePrompt() → 完整 <handoff_payload>
   └─ 续接：promptTask（纯任务文本）
    ↓
6. 返回改写后的 params：
   {
     runtime: "acp",
     agentId: childAgentId,
     task: rewrittenTask,
     cwd: outputDir,
     resumeSessionId?: acpSessionId,  ← 续接时注入
   }
```

**触发信号识别**：

| 信号 | 用途 |
|------|------|
| `[acp-handoff]` | 标准信号，触发上下文打包 |
| `[acpoff]` | 简写别名 |
| `[[acp-handoff]]` | 双括号变体 |
| `[acp-off]` | 连字符变体 |
| `[cron-structured-request]` | cron 专用，从父 prompt 提取 `<acp_request>` |

**handoff_payload 完整结构**：

```xml
<handoff_payload>

  <handoff_context>
    <agent_profile>
      <identity>[IDENTITY.md 内容]</identity>
      <behavior_style>[SOUL.md 内容]</behavior_style>
    </agent_profile>

    <operating_rules>
      <rules>[RULES.md 内容]</rules>
      <workflow>[AGENTS.md 内容]</workflow>
      <tools>[TOOLS.md 内容]</tools>
    </operating_rules>

    <user_profile>[USER.md 内容]</user_profile>
    <memory>[MEMORY.md 内容]</memory>
  </handoff_context>

  <handoff_artifacts>
    <exact_payload_file>.openclaw/acp-handoff/2026-03-20T12-34-56-123-a1b2c3d4-clmini.prompt.txt</exact_payload_file>
    <latest_exact_payload_file>.openclaw/acp-handoff/latest-observed-cli-payload.txt</latest_exact_payload_file>
  </handoff_artifacts>

  <handoff_task>
    <guide>你是 identity 定义的 Agent，执行规则优先级：rules > workflow > behavior_style</guide>
    <request>[用户的实际任务]</request>
  </handoff_task>

</handoff_payload>
```

### 3.4 after_tool_call：异步结果回推

```
sessions_spawn 返回（childSessionKey 已知）
    ↓
1. 解析返回值，提取 childSessionKey
    ↓
2. 恢复 pendingStructuredSpawn（从内存或磁盘）
    ↓
3. 解析 Discord 投递目标：
   ├─ 有显式 callback → resolveExplicitDiscordTarget()
   └─ 无 → extractDiscordTarget()（检查 deliveryContext.channel === "discord"）
    ↓
4. 若 responseMode === "sync-return" → 跳过，直接返回
    ↓
5. startBackgroundMonitor()（setImmediate 非阻塞）
   ├─ 设置子 session 模型（acpx set model）
   ├─ 轮询等待子会话完成（最多 120 秒，每 2 秒一次）
   ├─ 存储 sessionKey 映射（turnCount 更新）
   └─ sendToDiscord（推送结果）
```

---

## 4. Session 持久化与续接机制

### 4.1 sessionKey 工作原理

`sessionKey` 是一个用户自定义的固定名称，用于在多次触发之间复用同一个 Claude Code session。

```
存储文件路径：
~/.openclaw/acp-handoff/session-keys/{safeAgent}-{safeName}.json

示例：
~/.openclaw/acp-handoff/session-keys/clmini-skill-builder-persistent-test.json

文件内容：
{
  "acpSessionId": "04fd5f7a-e1b0-493b-be8d-b5ff8fe1af16",
  "agentId": "clmini",
  "fixedName": "skill-builder-persistent-test",
  "storedAt": 1774008284068,
  "turnCount": 3
}
```

**关键设计**：
- `fixedName`（用户写的 `sessionKey` 值）= 文件系统索引键，永远不变
- `acpSessionId`（Claude Code session UUID）= 存储的值，每次完成后覆盖更新
- 强制新建时：不注入 `resumeSessionId` → 子 Agent 创建新 session → 新 UUID
- 新 UUID 在 `startBackgroundMonitor` 里覆盖存储，下次续接使用新 session

**acpx session 索引查找**：

```
~/.openclaw/workspace-{agentId}/.acpx/sessions/index.json
{
  "entries": [
    {
      "name": "agent:clmini:acp:xxxxx-xxxxx",  ← childSessionKey
      "acpSessionId": "04fd5f7a-...",           ← 实际 UUID
    }
  ]
}
```

插件通过 `findAcpxSessionId(acpxRoot, childSessionKey)` 从这里找到 UUID，然后存入 session-keys 文件。

### 4.2 maxTurns 轮次限制

当 session 积累大量历史后，Claude Code 会触发 autocompact（上下文压缩），导致首轮注入的身份/规则被截断，子 Agent 失去角色认知。

`maxTurns` 让用户设置最大续接轮数，到达上限后自动强制新建 session，重新注入完整上下文。

**数据流示例（maxTurns=3）**：

```
第1次：stored=null → 新建 session A → 存 {acpSessionId=A, turnCount=1}
第2次：stored={A, turnCount=1} → 1<3 → 续接A → 存 {acpSessionId=A, turnCount=2}
第3次：stored={A, turnCount=2} → 2<3 → 续接A → 存 {acpSessionId=A, turnCount=3}
第4次：stored={A, turnCount=3} → 3>=3 → 强制新建 → 新建 session B → 存 {acpSessionId=B, turnCount=1}
第5次：stored={B, turnCount=1} → 1<3 → 续接B → 存 {acpSessionId=B, turnCount=2}
```

**边界情况**：

| 情况 | 处理 |
|------|------|
| `<maxTurns>` 不写 | `maxTurns=undefined`，无限续接 |
| `<maxTurns>0</maxTurns>` 或负数 | 解析为 `undefined`，无限续接 |
| `<maxTurns>1</maxTurns>` | 每次都新建（首轮完成 turnCount=1，下次 1>=1 强制新建） |
| 旧存储文件无 `turnCount` 字段 | 默认 `turnCount=1`，向后兼容 |
| 不写 `sessionKey` | 整个轮次逻辑跳过，行为与之前完全一致 |

### 4.3 首轮 vs 续接轮的差异

```
首轮（无 resumeSessionId）：
  task = renderConcretePrompt(snapshot, promptTask)
  → 完整 <handoff_payload>（含 IDENTITY/SOUL/AGENTS/PROJECT CONTEXT）
  → 子 Agent 知道自己是谁，有完整背景

续接轮（有 resumeSessionId）：
  task = promptTask（纯任务文本）
  → 子 Agent session 已有历史，不需要重复注入
  → 节省大量 token
  → sessions_spawn 参数额外携带 resumeSessionId
```

---

## 5. 结构化 ACP 请求协议

### 5.1 XML 信封格式

结构化请求通过 `<acp_request>` XML 信封传递，支持完整的元数据配置：

```xml
<acp_request version="1">
  <meta>
    <agentId>clmini</agentId>
    <sessionKey>my-persistent-session</sessionKey>
    <model>minimax/MiniMax-M2.7-highspeed</model>
    <maxTurns>5</maxTurns>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:881734814204571708</to>
      <accountId>bot6</accountId>
      <replyToId>msg-123456</replyToId>
    </callback>
  </meta>

  <cli_prompt><![CDATA[
    这里是透传给子 Agent CLI 的完整提示词内容。
    支持 CDATA 包裹，可以包含任意字符。
    <cli_prompt> 是 <task> 的语义别名，推荐用前者。
  ]]></cli_prompt>

</acp_request>
```

### 5.2 字段说明

| 字段 | 位置 | 必须 | 说明 |
|------|------|------|------|
| `version` | `<acp_request>` 属性 | 否 | 协议版本，默认 "1" |
| `agentId` | `<meta>` | 否 | 目标子 Agent ID（如 clt、clmini、clg） |
| `sessionKey` | `<meta>` | 否 | 固定会话键，用于跨次续接 |
| `model` | `<meta>` | 否 | 指定子 Agent 使用的模型 |
| `maxTurns` | `<meta>` | 否 | 最大续接轮数，超出后强制新建 session |
| `responseMode` | `<meta>` | 否 | `sync-return`（默认）或 `async-callback` |
| `callback.channel` | `<meta><callback>` | 条件必须 | 目前仅支持 `discord` |
| `callback.to` | `<meta><callback>` | 条件必须 | 格式：`user:USER_ID` 或 `channel:CHANNEL_ID` |
| `callback.accountId` | `<meta><callback>` | 否 | Discord bot 账户 ID |
| `callback.replyToId` | `<meta><callback>` | 否 | 回复的消息 ID |
| `cli_prompt` | `<acp_request>` 直接子标签 | 是 | 子 Agent 实际执行的任务（`<task>` 是别名） |

> **注意**：`responseMode=async-callback` 时，`<callback>` 块是必须的。

### 5.3 responseMode 两种模式

```
sync-return（同步返回）：
  父 Agent 等待子任务完成，直接在对话中得到结果。
  不启动后台监听，不推送 Discord。
  适用：快速任务、需要直接回复用户的场景。

async-callback（异步回调）：
  父 Agent 派发后立即返回（"ACP 子任务已派发，结果将异步回调"）。
  后台监听子会话完成，通过 Discord 推送结果。
  适用：长时间任务、cron 定时任务、不需要阻塞父 Agent 的场景。
```

---

## 6. Cron 定时任务集成

### 6.1 cron 场景的特殊挑战

Cron 触发的 session 有一个已知限制：

```
cron session 的 deliveryContext.channel = "webchat"（不是 "discord"）

acp-handoff 插件的 after_tool_call 中：
  extractDiscordTarget() → 检查 isDiscordSession
  → deliveryContext.channel !== "discord" → 返回 null
  → Discord 推送被静默跳过
```

**解决方案**：使用 `cron-acp` skill，在 `<meta>` 里显式指定 `<callback>` 块，绕过 `deliveryContext` 检查。

### 6.2 cron-acp skill 解决方案

`cron-acp` skill 的核心设计：

```
cron 触发 wolf session
    ↓
wolf 读取 payload，识别 "使用 cron-acp skill"
    ↓
wolf 调用 sessions_spawn：
{
  "task": "[acp-handoff] [cron-structured-request]",
  "runtime": "acp",
  "agentId": "clmini",
  "mode": "run"
}
    ↓
acp-handoff 插件 before_tool_call：
  检测到 [cron-structured-request] 信号
  → 从父 prompt 的 <acp_request> 提取结构化请求
  → 解析 <callback> 块，得到显式 Discord 目标
  → 构建 handoff_payload（首轮注入完整上下文）
    ↓
after_tool_call：
  pendingStructuredSpawn 中有显式 callback
  → resolveExplicitDiscordTarget()（不走 deliveryContext 检查）
  → 启动 startBackgroundMonitor
  → 子任务完成后推送 Discord
```

**关键点**：`[cron-structured-request]` 信号让插件从父 prompt 而非 task 中读取 `<acp_request>`，因为 cron payload 里的 XML 是 wolf 的输入，不是直接出现在 sessions_spawn 的 task 里。

### 6.3 skill-builder-hourly-v2 案例分析

这是一个生产中运行的定时任务，每小时触发一次，派发 ACP 子任务检查 skill 体系。

**完整配置**（`~/.openclaw/cron/jobs.json`）：

```json
{
  "id": "137c2258-d85e-4902-aebc-46d5142d897a",
  "agentId": "wolf",
  "name": "skill-builder-hourly-v2",
  "description": "每小时以 structured cron-acp 方式派发 ACP 子任务，检查 skill 体系并仅为缺失项新建 SKILL.md；结果由 cron delivery 推送到 Discord。",
  "enabled": true,
  "schedule": {
    "kind": "every",
    "everyMs": 3600000,
    "anchorMs": 1773982969245
  },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "使用 cron-acp skill 处理这个请求。<cli_prompt> 里的内容是透传给 ACP CLI 的。\n\n<acp_request>\n\n  <meta>\n    <agentId>clmini</agentId>\n    <sessionKey>skill-builder-persistent-test</sessionKey>\n    <model>minimax/MiniMax-M2.7-highspeed</model>\n    <responseMode>async-callback</responseMode>\n    <callback>\n      <channel>discord</channel>\n      <to>user:881734814204571708</to>\n    </callback>\n  </meta>\n\n  <cli_prompt>\n概括你收到的提示词，以及你的环境，模型，角色是什么;\n最重要的是，你是什么公司的，什么编程工具。\n然后命名上，用一个北京时间的年月日，时分秒的形式，写到一个新的文件中，要求这个命名非常清晰。\n  </cli_prompt>\n\n</acp_request>",
    "model": "minimax/MiniMax-M2.7-highspeed"
  },
  "delivery": {
    "mode": "announce",
    "channel": "discord",
    "to": "user:881734814204571708",
    "bestEffort": false
  },
  "state": {
    "lastRunAtMs": 1774008262770,
    "lastRunStatus": "ok",
    "lastStatus": "ok",
    "lastDurationMs": 17214,
    "lastDelivered": true,
    "lastDeliveryStatus": "delivered",
    "consecutiveErrors": 0
  }
}
```

**执行流程图**：

```
每小时触发
    ↓
wolf isolated session 启动
（sessionTarget="isolated"，sessionKey="agent:wolf:cron:137c2258-..."）
    ↓
wolf 读取 payload.message，识别 "使用 cron-acp skill"
    ↓
wolf 调用 sessions_spawn：
{
  task: "[acp-handoff] [cron-structured-request]",
  runtime: "acp",
  agentId: "clmini",
  mode: "run"
}
    ↓
acp-handoff before_tool_call：
  [cron-structured-request] → 从 wolf 的 prompt 里提取 <acp_request>
  解析得到：
    agentId=clmini, sessionKey=skill-builder-persistent-test
    model=minimax/MiniMax-M2.7-highspeed, responseMode=async-callback
    callback={channel:discord, to:user:881734814204571708}
  检查 session-keys/clmini-skill-builder-persistent-test.json
  → 首轮：注入完整 handoff_payload（含 wolf 的 IDENTITY/SOUL/PROJECT CONTEXT）
  → 续接轮：只发 cli_prompt 内容
  注入 resumeSessionId（如果续接）
    ↓
acpx 启动 clmini 子 session
  clmini 执行：概括提示词 + 写时间戳文件
    ↓
acp-handoff after_tool_call：
  pendingStructuredSpawn 有显式 callback
  → resolveExplicitDiscordTarget() → {to: "user:881734814204571708", accountId: "bot6"}
  → startBackgroundMonitor（后台异步）
    ↓
startBackgroundMonitor：
  等待 clmini 完成（轮询 session 文件）
  → 更新 clmini-skill-builder-persistent-test.json（turnCount+1）
  → sendToDiscord("✅ ACP 子会话执行完成：\n\n[clmini 的输出]")
    ↓
用户在 Discord 收到结果
```

**运行历史**（44 次连续成功，100% 成功率）：
- 平均执行时间：~120 秒
- 最短：17 秒，最长：725 秒
- 当前 acpSessionId：`04fd5f7a-e1b0-493b-be8d-b5ff8fe1af16`

---

## 7. Skills 使用指南

### 7.1 acpoff（用户入口）

**用途**：用户直接对话触发 ACP 子任务的入口 skill。

**触发方式**：

```
用户说："使用 acpoff，把这个任务交给 clt"
```

**Agent 行为**：立即调用 sessions_spawn，不等待，不轮询：

```json
{
  "task": "[acp-handoff] 用户的任务正文",
  "runtime": "acp",
  "agentId": "clt",
  "mode": "run"
}
```

**agentId 映射规则**：
- `cop` / `copilot` → `"copilot"`
- `clt` → `"clt"`
- `claude` → `"claude"`
- 未指定 → 省略（使用默认）

**注意**：acpoff 是用户可调用的（`user-invocable: true`）。

### 7.2 acp-handoff（内部协议）

**用途**：内部协议 skill，描述插件的工作方式。不建议用户直接调用。

**触发方式**（内部使用）：

```json
{
  "task": "[acp-handoff] 任务内容",
  "runtime": "acp",
  "agentId": "claude",
  "mode": "run"
}
```

### 7.3 cron-acp（cron 专用）

**用途**：解决 cron 场景下 Discord 回推失效的问题。

**触发条件**：payload.message 中包含 "使用 cron-acp skill"。

**两种使用模式**：

**模式一：含 `<acp_request>` 块（推荐）**

```
使用 cron-acp skill 处理这个请求。<cli_prompt> 里的内容是透传给 ACP CLI 的。

<acp_request>
  <meta>
    <agentId>clmini</agentId>
    <sessionKey>my-persistent-key</sessionKey>
    <model>minimax/MiniMax-M2.7-highspeed</model>
    <maxTurns>10</maxTurns>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:881734814204571708</to>
    </callback>
  </meta>

  <cli_prompt>
    这里是子 Agent 实际执行的任务内容。
    可以是任意文本，支持 CDATA。
  </cli_prompt>

</acp_request>
```

Agent 行为：
1. 调用 `sessions_spawn({ task: "[acp-handoff] [cron-structured-request]", runtime: "acp", agentId: "clmini", mode: "run" })`
2. `responseMode=async-callback` → 立即返回 "ACP 子任务已派发，结果将异步回调"

**模式二：不含 `<acp_request>` 块（简单模式）**

```
[cron-acp] target=user:881734814204571708 agentId=clt
任务内容...
```

Agent 行为：
1. 调用 `sessions_spawn({ task: "[acp-handoff] 任务内容...", runtime: "acp", agentId: "clt", mode: "run" })`
2. 轮询等待结果后返回（sync-return 模式）

**配置要求**：
- cron 任务的 `delivery.mode` 可保持 `"announce"`（结果由 skill 推送，cron delivery 只是 wolf 的简单回复）
- `sessionTarget` 保持 `"isolated"`

---

## 8. 数据存储结构

```
~/.openclaw/
├── acp-handoff/
│   ├── cache/
│   │   ├── {hash16}.json              # 按 sessionKey 的最新快照
│   │   └── runs/
│   │       └── {runId}.json           # 按 runId 的历史快照
│   └── session-keys/
│       └── {agentId}-{fixedName}.json # sessionKey 映射（含 turnCount）

~/.openclaw/workspace-{agentId}/
└── .acpx/
    └── sessions/
        └── index.json                 # acpx session 索引（childSessionKey → acpSessionId）

~/.openclaw/agents/{agentId}/
└── sessions/
    ├── sessions.json                  # session 注册表（含 deliveryContext）
    └── {sessionId}.jsonl              # 会话完整转录

{workspaceDir}/
└── .openclaw/
    └── acp-handoff/
        ├── {timestamp}-{hash}-{agentId}.prompt.txt    # 时间戳 prompt 副本
        ├── latest-observed-cli-payload.txt             # 最新 prompt 副本
        ├── latest-observed-acp-request.xml             # 最新 <acp_request>
        ├── latest-resolved-callback.json               # 最新 Discord 目标（调试用）
        └── pending-structured-spawns.json              # 待处理的结构化请求
```

**快照缓存键计算**：

```typescript
const hash = crypto.createHash("sha256")
  .update(sessionKey)
  .digest("hex")
  .slice(0, 16);  // 取前 16 个 hex 字符
// 文件：~/.openclaw/acp-handoff/cache/a3b2c1d0e9f8g7h6.json
```

**session-keys 文件结构**：

```json
{
  "acpSessionId": "04fd5f7a-e1b0-493b-be8d-b5ff8fe1af16",
  "agentId": "clmini",
  "fixedName": "skill-builder-persistent-test",
  "storedAt": 1774008284068,
  "turnCount": 3
}
```

---

## 9. Discord 回调流程

### 两种 Discord 目标解析路径

```
路径一：显式 callback（来自 <acp_request><callback>）
  resolveExplicitDiscordTarget(callback, api, agentId)
  → to = callback.to
  → accountId = callback.accountId ?? resolveDiscordBindingAccountId(api, agentId)
  → 不检查 deliveryContext（绕过 cron 限制）

路径二：从 session 提取（普通 Discord 对话）
  extractDiscordTarget(ctx, api)
  → readSessionRegistryEntry(api, agentId, sessionKey)
  → 检查 deliveryContext.channel === "discord"（cron 场景失败）
  → accountId = deliveryContext.accountId ?? origin.accountId ?? binding lookup
  → to = deliveryContext.to ?? origin.to
```

### Discord 消息格式

```
成功完成：
✅ ACP 子会话执行完成：

[子 Agent 的输出文本]

失败：
⚠️ ACP 子会话执行失败：[错误信息]

等待输入：
🟡 ACP 子会话等待输入：

[子 Agent 的输出文本]
```

### agent 与 Discord bot 的绑定关系

| Agent | Bot | 状态 |
|-------|-----|------|
| wolf | bot6 | 启用 |
| fox | bot1 | 启用 |
| rabbit | bot4 | 启用 |
| tigger | bot5 | 启用 |
| horse | bot9 | 启用 |
| 其他 | bot2-12 | 禁用 |

---

## 10. 配置参考

### 创建 cron 定时任务（完整模板）

```bash
openclaw cron add \
  --name "my-hourly-task" \
  --cron "0 * * * *" \
  --session isolated \
  --message "使用 cron-acp skill 处理这个请求。<cli_prompt> 里的内容是透传给 ACP CLI 的。

<acp_request>
  <meta>
    <agentId>clmini</agentId>
    <sessionKey>my-task-persistent</sessionKey>
    <model>minimax/MiniMax-M2.7-highspeed</model>
    <maxTurns>10</maxTurns>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:881734814204571708</to>
    </callback>
  </meta>

  <cli_prompt>
    在这里写子 Agent 要执行的任务。
  </cli_prompt>

</acp_request>"
```

### 对话中使用 acpoff（快速派发）

```
使用 acpoff，把以下任务交给 clt：
[任务内容]
```

### 对话中使用完整结构化请求

```
使用 acpoff，把以下任务交给 clmini：

<acp_request>
  <meta>
    <agentId>clmini</agentId>
    <sessionKey>my-project-session</sessionKey>
    <maxTurns>5</maxTurns>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:881734814204571708</to>
    </callback>
  </meta>

  <cli_prompt>
    任务内容...
  </cli_prompt>

</acp_request>
```

### 查看 session-key 存储

```bash
# 查看所有 session key 映射
ls ~/.openclaw/acp-handoff/session-keys/

# 查看某个 session key 的详情
cat ~/.openclaw/acp-handoff/session-keys/clmini-skill-builder-persistent-test.json

# 手动重置（强制下次新建 session）
rm ~/.openclaw/acp-handoff/session-keys/clmini-my-task.json
```

### 查看 cron 执行历史

```bash
# 查看任务列表
openclaw cron list

# 查看执行历史
openclaw cron runs --id 137c2258-d85e-4902-aebc-46d5142d897a

# 立即触发
openclaw cron run 137c2258-d85e-4902-aebc-46d5142d897a
```

---

## 11. 排障指南

### 子 Agent 不知道父会话上下文

**症状**：子 Agent 不知道自己是谁、没有项目背景知识。

**排查**：

```bash
# 检查快照缓存是否存在
ls ~/.openclaw/acp-handoff/cache/

# 检查最新的 prompt 副本
cat ~/.openclaw/workspace-wolf/.openclaw/acp-handoff/latest-observed-cli-payload.txt
```

**原因**：`llm_input` 事件没有触发（父会话不是 LLM 推理触发的），导致快照为空。

### Discord 推送没收到

**排查顺序**：

```bash
# 1. 检查 gateway 日志
grep -i "acp-handoff" ~/.openclaw/logs/gateway.log | tail -50

# 2. 检查是否有 "skipping notification" 或 "not backed by Discord"
grep -i "skipping\|discord\|delivery" ~/.openclaw/logs/gateway.log | tail -30

# 3. 检查最新的 callback 解析结果
cat {workspaceDir}/.openclaw/acp-handoff/latest-resolved-callback.json
```

**常见原因**：
- cron 场景没有使用 `cron-acp` skill（导致 extractDiscordTarget 返回 null）
- `callback.to` 格式错误（必须是 `channel:ID` 或 `user:ID`，不能是裸 ID）
- `responseMode` 是 `sync-return`（不会推 Discord）

### cron 里 Discord 没收到

**确认用了 cron-acp skill**：

```
payload.message 应该包含：
"使用 cron-acp skill 处理这个请求"
+ <acp_request>...</acp_request>
+ <callback><channel>discord</channel><to>user:xxx</to></callback>
```

**不要**：
- 使用普通 acpoff（不带 callback 块）
- 把 `delivery.mode` 改成 `none`（会导致 wolf 的回复也不推送）

### 子 Agent 忘记了身份（autocompact 问题）

**症状**：多次续接后，子 Agent 不再知道自己的角色、规则。

**解决**：在 `<meta>` 里设置 `<maxTurns>`，让插件自动在上限时新建 session：

```xml
<meta>
  <sessionKey>my-session</sessionKey>
  <maxTurns>5</maxTurns>
  ...
</meta>
```

**验证**：

```bash
# 检查 turnCount
cat ~/.openclaw/acp-handoff/session-keys/clmini-my-session.json
# 当 turnCount >= maxTurns 时，下次触发会看到日志：
grep "forcing new session" ~/.openclaw/logs/gateway.log
```

### 子任务超时

**默认超时**：120 秒。

**症状**：`waitForChildSessionCompletion` 超时，Discord 收到 `⚠️ ACP 子会话执行失败`。

**排查**：

```bash
# 查看子 session 文件
ls ~/.openclaw/agents/clmini/sessions/
tail -50 ~/.openclaw/agents/clmini/sessions/{sessionId}.jsonl
```

### 日志关键词速查

| 场景 | 日志关键词 |
|------|---------|
| 续接成功 | `resuming session ... for fixedSessionKey=...` |
| 强制新建 | `turn limit reached ... forcing new session` |
| 存储 session key | `stored session key mapping fixedSessionKey=...` |
| Discord 推送成功 | `Discord message sent successfully` |
| Discord 推送失败 | `Discord send failed` |
| cron 场景跳过 | `not backed by Discord delivery` |
| 快照捕获 | `acp-handoff: stored snapshot` |

---

*文档生成时间：2026-03-20*
*基于代码版本：index.ts (2901 行), src/protocol.ts, src/cache.ts, src/types.ts, src/normalize.ts, src/handoff-file.ts*
