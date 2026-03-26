# ACP Handoff 插件图解手册

> 本文件用 Mermaid 图从多个维度可视化 acp-handoff 插件的核心原理。
> 配合 DEEP_DIVE.md 阅读效果最佳。

---

## 目录

1. [问题起点：没有插件时的信息断层](#1-问题起点没有插件时的信息断层)
2. [插件介入后：完整系统架构](#2-插件介入后完整系统架构)
3. [三大事件钩子的时序关系](#3-三大事件钩子的时序关系)
4. [llm_input 快照捕获流程](#4-llm_input-快照捕获流程)
5. [before_tool_call 上下文注入决策树](#5-before_tool_call-上下文注入决策树)
6. [同步模式（sync-return）完整时序](#6-同步模式sync-return完整时序)
7. [异步模式（async-callback）完整时序](#7-异步模式async-callback完整时序)
8. [Cron 场景：为什么普通 acpoff 失效](#8-cron-场景为什么普通-acpoff-失效)
9. [Cron 场景：cron-acp skill 修复路径](#9-cron-场景cron-acp-skill-修复路径)
10. [sessionKey 续接状态机](#10-sessionkey-续接状态机)
11. [maxTurns 轮次控制流程](#11-maxturns-轮次控制流程)
12. [首轮 vs 续接轮：task 内容对比](#12-首轮-vs-续接轮task-内容对比)
13. [handoff_payload 的构成结构](#13-handoff_payload-的构成结构)
14. [Discord 回调目标解析路径](#14-discord-回调目标解析路径)
15. [startBackgroundMonitor 后台监听流程](#15-startbackgroundmonitor-后台监听流程)
16. [数据存储全景图](#16-数据存储全景图)
17. [skill-builder-hourly-v2 端到端完整流程](#17-skill-builder-hourly-v2-端到端完整流程)

---

## 1. 问题起点：没有插件时的信息断层

没有 `acp-handoff` 时，父 Agent 派发子任务的信息极度贫乏：

```mermaid
sequenceDiagram
    participant User as 用户
    participant Wolf as 父 Agent (wolf)
    participant Spawn as sessions_spawn
    participant Child as 子 Agent (clt)

    User->>Wolf: "帮我重构这个模块"
    Note over Wolf: 系统提示包含：<br/>IDENTITY + SOUL + AGENTS<br/>+ PROJECT CONTEXT<br/>+ 对话历史

    Wolf->>Spawn: task = "重构这个模块"
    Note over Spawn: ⚠️ 只有一个字符串！<br/>没有身份、没有规则、<br/>没有项目背景

    Spawn->>Child: task = "重构这个模块"
    Note over Child: ❌ 子 Agent 不知道：<br/>- 自己是谁<br/>- 用什么规范<br/>- 项目是什么<br/>- 用户是谁
    Child-->>Wolf: 结果可能不符合期望
```

---

## 2. 插件介入后：完整系统架构

```mermaid
graph TB
    subgraph OpenClaw["OpenClaw Gateway"]
        subgraph Parent["父 Agent 会话 (wolf)"]
            LLM["LLM 推理<br/>llm_input 事件"]
            SP["sessions_spawn 调用"]
        end

        subgraph Plugin["acp-handoff 插件"]
            direction TB
            H1["① llm_input 钩子<br/>捕获快照<br/>(systemPrompt + history)"]
            H2["② before_tool_call 钩子<br/>读快照 → 渲染 handoff_payload<br/>改写 task 参数"]
            H3["③ after_tool_call 钩子<br/>启动后台监听<br/>(setImmediate 非阻塞)"]
            MON["后台监听器<br/>waitForChildSessionCompletion<br/>(轮询 session 文件)"]
        end

        subgraph ACP["ACP Runtime (acpx)"]
            CHILD["子 Agent 会话 (clmini)<br/>收到完整 handoff_payload"]
            SESS["session 文件<br/>.jsonl 转录"]
        end

        subgraph Storage["持久化存储"]
            CACHE["快照缓存<br/>~/.openclaw/acp-handoff/cache/"]
            SK["session-keys/<br/>fixedName → acpSessionId<br/>+ turnCount"]
            ACPX["acpx index.json<br/>childSessionKey → acpSessionId"]
        end
    end

    DISCORD["Discord<br/>用户收到结果"]

    LLM -->|"触发"| H1
    H1 -->|"存储"| CACHE
    SP -->|"拦截"| H2
    H2 -->|"读取"| CACHE
    H2 -->|"改写 task"| SP
    SP -->|"完成后"| H3
    H3 -->|"setImmediate"| MON
    MON -->|"轮询"| SESS
    CHILD -->|"写入"| SESS
    MON -->|"存储"| SK
    MON -->|"查询"| ACPX
    MON -->|"sendToDiscord"| DISCORD

    style Plugin fill:#e8f4f8,stroke:#2196F3
    style ACP fill:#f0f8e8,stroke:#4CAF50
    style Storage fill:#fff8e8,stroke:#FF9800
```

---

## 3. 三大事件钩子的时序关系

```mermaid
sequenceDiagram
    participant U as 用户/Cron
    participant W as 父 Agent (wolf)
    participant P as acp-handoff 插件
    participant ACP as ACP Runtime
    participant C as 子 Agent (clmini)
    participant D as Discord

    Note over P: 插件监听三个事件

    U->>W: 触发（对话 / cron）
    W->>P: 🔴 llm_input 事件
    P->>P: createSnapshot()
    Note over P: 存 systemPrompt + history
    P-->>W: (异步存储，不阻塞)

    W->>P: 🟡 before_tool_call(sessions_spawn)
    P->>P: 读快照 → 渲染 handoff_payload
    P->>P: 检查 sessionKey → resumeSessionId?
    P-->>W: 返回改写后的 params {task: handoff_payload, resumeSessionId?}

    W->>ACP: sessions_spawn(改写后的 params)
    ACP->>C: 启动子 session（含完整上下文）
    ACP-->>W: accepted {childSessionKey}

    W->>P: 🟢 after_tool_call(sessions_spawn)
    P->>P: 解析 childSessionKey
    P->>P: 解析 Discord 目标
    P-->>W: (立即返回，不阻塞)

    Note over P: setImmediate → 后台运行
    P->>C: 轮询 session 文件（每 2s）
    C->>C: 执行任务...
    C-->>P: session 完成（stopReason 检测）
    P->>P: storeSessionKey(turnCount+1)
    P->>D: sendToDiscord("✅ 执行完成：...")
    D-->>U: 收到结果通知
```

---

## 4. llm_input 快照捕获流程

```mermaid
flowchart TD
    E["llm_input 事件触发"]
    E --> A{"sessionKey<br/>存在?"}
    A -->|"否"| SKIP["跳过，不处理"]
    A -->|"是"| B["rememberPromptConversationInfo()"]
    B --> C["createSnapshot()"]

    C --> D["收集字段"]
    D --> D1["runId / sessionId / sessionKey"]
    D --> D2["provider / model / imagesCount"]
    D --> D3["systemPrompt<br/>(截断至 60,000 字符)"]
    D --> D4["prompt<br/>(截断至 20,000 字符)"]
    D --> D5["historyMessages<br/>(逆序处理，总量上限 80,000 字符)"]

    D1 & D2 & D3 & D4 & D5 --> E2["storeSnapshot(snapshot)"]

    E2 --> F["内存缓存<br/>Map&lt;sessionKey, snapshot&gt;"]
    E2 --> G["磁盘缓存<br/>~/.openclaw/acp-handoff/cache/{hash16}.json"]
    E2 --> H["runs 子目录<br/>.../cache/runs/{runId}.json"]

    style D3 fill:#ffe0e0
    style D4 fill:#ffe0e0
    style D5 fill:#ffe0e0
    style F fill:#e0f0ff
    style G fill:#e0ffe0
    style H fill:#e0ffe0
```

**快照大小限制（防止 token 超限）**：

```mermaid
xychart-beta
    title "各字段字符数上限"
    x-axis ["systemPrompt", "historyMessages", "prompt", "requestedTask", "单条历史"]
    y-axis "字符数上限" 0 --> 90000
    bar [60000, 80000, 20000, 12000, 4000]
```

---

## 5. before_tool_call 上下文注入决策树

```mermaid
flowchart TD
    START["before_tool_call<br/>sessions_spawn 触发"]

    START --> G1{"acpoffReturnGuard<br/>已激活?"}
    G1 -->|"是"| BLOCK["阻止工具调用<br/>(子任务已派发，等待结果)"]
    G1 -->|"否"| G2{"task 包含<br/>[acp-handoff] 信号?"}

    G2 -->|"否"| PASS["透传，不处理"]
    G2 -->|"是"| SNAP["读取快照"]

    SNAP --> SNAP1{"runId 缓存<br/>命中?"}
    SNAP1 -->|"是"| GOT_SNAP["获得快照"]
    SNAP1 -->|"否"| SNAP2{"sessionKey 缓存<br/>命中?"}
    SNAP2 -->|"是"| GOT_SNAP
    SNAP2 -->|"否"| SNAP3["transcript 降级<br/>(读 .jsonl 文件)"]
    SNAP3 --> GOT_SNAP

    GOT_SNAP --> PARSE{"task 包含<br/>&lt;acp_request&gt; XML?"}

    PARSE -->|"是 (结构化)"| STRUCT["parseStructuredAcpRequest()<br/>提取 agentId/sessionKey/model<br/>/maxTurns/responseMode/callback"]
    PARSE -->|"否 (普通)"| PLAIN["使用原始 task 文本"]

    PARSE -->|"[cron-structured-request]"| CRON["从父 prompt 提取<br/>&lt;acp_request&gt; XML"]
    CRON --> STRUCT

    STRUCT --> SK{"有 sessionKey<br/>且有 childAgentId?"}
    PLAIN --> RENDER_FULL

    SK -->|"否"| RENDER_FULL["renderConcretePrompt()<br/>首轮：完整 handoff_payload"]
    SK -->|"是"| READ_STORE["readStoredSessionKey()<br/>读 session-keys/*.json"]

    READ_STORE --> HAS_STORE{"存储存在<br/>且有 acpSessionId?"}
    HAS_STORE -->|"否"| RENDER_FULL
    HAS_STORE -->|"是"| CHECK_TURNS{"maxTurns 设置<br/>且 turnCount >= maxTurns?"}

    CHECK_TURNS -->|"是 (超轮次)"| FORCE_NEW["强制新建 session<br/>resumeSessionId = undefined<br/>→ 完整上下文注入"]
    CHECK_TURNS -->|"否 (未超限)"| RESUME["resumeSessionId = acpSessionId<br/>续接模式"]

    FORCE_NEW --> RENDER_FULL
    RESUME --> RENDER_TASK["task = promptTask<br/>(纯任务文本，不注入上下文)"]

    RENDER_FULL --> RETURN["返回改写后的 params<br/>{runtime:'acp', agentId, task, cwd,<br/>resumeSessionId?}"]
    RENDER_TASK --> RETURN

    style BLOCK fill:#ffcccc
    style RENDER_FULL fill:#ccffcc
    style RENDER_TASK fill:#cce0ff
    style FORCE_NEW fill:#ffe0cc
```

---

## 6. 同步模式（sync-return）完整时序

`responseMode=sync-return`：父 Agent 等待子任务完成，结果直接在对话中返回。

```mermaid
sequenceDiagram
    participant U as 用户
    participant W as 父 Agent (wolf)
    participant P as acp-handoff 插件
    participant ACP as ACP Runtime
    participant C as 子 Agent (clt)

    U->>W: "使用 acpoff，帮我分析这段代码"

    Note over P: llm_input 事件
    W->>P: llm_input (捕获快照)
    P-->>W: 快照已存储

    W->>P: before_tool_call(sessions_spawn)
    P->>P: 读快照 → renderConcretePrompt()
    P-->>W: task = handoff_payload / runtime = "acp"

    W->>ACP: sessions_spawn(task=完整payload, mode="run")
    ACP->>C: 启动子 session
    Note over C: 执行分析任务...
    C-->>ACP: 完成，返回结果文本

    ACP-->>W: result = {text: "分析结果...", completed: true}

    W->>P: after_tool_call
    Note over P: responseMode = sync-return<br/>→ 跳过后台监听<br/>→ 不推送 Discord
    P-->>W: (直接返回)

    W-->>U: "分析结果：..."

    Note over U,C: 整个过程同步，用户等待完成后收到回复
```

---

## 7. 异步模式（async-callback）完整时序

`responseMode=async-callback`：父 Agent 立即返回，子任务在后台执行，完成后推送 Discord。

```mermaid
sequenceDiagram
    participant U as 用户/Cron
    participant W as 父 Agent (wolf)
    participant P as acp-handoff 插件
    participant ACP as ACP Runtime
    participant C as 子 Agent (clmini)
    participant BG as 后台监听器
    participant D as Discord

    U->>W: 触发（对话 / cron 定时）

    Note over P: llm_input 事件
    W->>P: llm_input (捕获快照)
    P-->>W: 快照已存储

    W->>P: before_tool_call(sessions_spawn)
    P->>P: 解析 acp_request
    Note over P: 提取 callback={to, accountId}
    P->>P: 读快照 → renderConcretePrompt()
    P->>P: 入队 pendingStructuredSpawn
    Note over P: 保存 callback 信息
    P-->>W: task = handoff_payload / resumeSessionId? (续接时)

    W->>ACP: sessions_spawn(...)
    ACP->>C: 启动子 session
    ACP-->>W: accepted {childSessionKey}

    Note over W: ⚡ 立即返回给用户
    W-->>U: "ACP 子任务已派发，结果将异步回调"

    W->>P: after_tool_call
    P->>P: 出队 pendingStructuredSpawn
    Note over P: 获取 callback 信息
    P->>P: resolveExplicitDiscordTarget()
    Note over P: → {to: "user:xxx", accountId: "bot6"}
    P->>BG: setImmediate(startBackgroundMonitor)
    P-->>W: (立即返回，不阻塞)

    Note over BG,C: ⏳ 后台异步执行（最多 120s）
    loop 每 2 秒轮询
        BG->>C: 检查 session 文件 mtime
        C->>C: 执行任务中...
    end

    C-->>BG: session 完成 (stopReason 检测)

    BG->>BG: findAcpxSessionId()
    Note over BG: 从 acpx index 获取 UUID
    BG->>BG: storeSessionKey(turnCount+1)
    Note over BG: 更新 session-keys/*.json

    BG->>D: sendToDiscord() "✅ ACP 子会话执行完成：[子 Agent 输出]"
    D-->>U: 收到 Discord 通知

    Note over U,D: 用户在 Discord 收到结果<br/>父 Agent 早已结束当前轮次
```

---

## 8. Cron 场景：为什么普通 acpoff 失效

```mermaid
flowchart TD
    subgraph CRON_SESSION["Cron 触发的 wolf session"]
        CS["sessionKey = agent:wolf:cron:xxx<br/>deliveryContext.channel = 'webchat'"]
    end

    subgraph PLUGIN["acp-handoff after_tool_call"]
        ET["extractDiscordTarget(ctx, api)"]
        CHECK{"deliveryContext.channel<br/>=== 'discord'?"}
        CHECK2{"origin.provider<br/>=== 'discord'?"}
        CHECK3{"origin.surface<br/>=== 'discord'?"}
        NULL["返回 null<br/>⚠️ 静默跳过 Discord 推送"]
        OK["返回 {to, accountId}"]
    end

    CS -->|"传入 ctx"| ET
    ET --> CHECK
    CHECK -->|"否 (webchat ≠ discord)"| CHECK2
    CHECK2 -->|"否"| CHECK3
    CHECK3 -->|"否"| NULL

    NULL -->|"after_tool_call 检查"| SKIP["if (!discordTarget) return<br/>不启动 startBackgroundMonitor<br/>不推送 Discord"]

    style NULL fill:#ffcccc
    style SKIP fill:#ffcccc
    style CS fill:#fff3cc

    Note1["❌ 问题根因：<br/>cron session 的 deliveryContext 由<br/>OpenClaw 调度器设置为 webchat，<br/>不是用户从 Discord 发起的会话，<br/>所以 isDiscordSession 检查永远失败"]
    SKIP -.-> Note1
```

---

## 9. Cron 场景：cron-acp skill 修复路径

```mermaid
flowchart TD
    subgraph CRON_MSG["Cron payload.message"]
        MSG["使用 cron-acp skill...<br/><br/>&lt;acp_request&gt;<br/>  &lt;meta&gt;<br/>    &lt;responseMode&gt;async-callback&lt;/responseMode&gt;<br/>    &lt;callback&gt;<br/>      &lt;channel&gt;discord&lt;/channel&gt;<br/>      &lt;to&gt;user:881734814204571708&lt;/to&gt;<br/>    &lt;/callback&gt;<br/>  &lt;/meta&gt;<br/>  &lt;cli_prompt&gt;任务内容&lt;/cli_prompt&gt;<br/>&lt;/acp_request&gt;"]
    end

    subgraph WOLF["wolf 执行 cron-acp skill"]
        W_SPAWN["sessions_spawn(<br/>  task: '[acp-handoff] [cron-structured-request]',<br/>  runtime: 'acp',<br/>  agentId: 'clmini',<br/>  mode: 'run'<br/>)"]
    end

    subgraph BEFORE["before_tool_call"]
        DETECT["检测 [cron-structured-request] 信号"]
        FROM_PROMPT["从父 prompt 提取 &lt;acp_request&gt;<br/>(不是从 task 里找)"]
        PARSE["parseStructuredAcpRequest()<br/>得到 callback={to, accountId}"]
        QUEUE["入队 pendingStructuredSpawn<br/>{responseMode, callback}"]
    end

    subgraph AFTER["after_tool_call"]
        DEQUEUE["出队 pendingStructuredSpawn"]
        EXPLICIT["resolveExplicitDiscordTarget(callback)<br/>直接用 callback.to + callback.accountId<br/>⚡ 不走 deliveryContext 检查"]
        BG["startBackgroundMonitor()<br/>后台监听 + Discord 推送"]
    end

    MSG --> W_SPAWN
    W_SPAWN --> DETECT
    DETECT --> FROM_PROMPT
    FROM_PROMPT --> PARSE
    PARSE --> QUEUE
    QUEUE -->|"sessions_spawn 执行"| DEQUEUE
    DEQUEUE --> EXPLICIT
    EXPLICIT --> BG

    style EXPLICIT fill:#ccffcc
    style FROM_PROMPT fill:#cce0ff

    KEY["🔑 关键差异：<br/>普通路径用 extractDiscordTarget()<br/>→ 依赖 deliveryContext (cron 里是 webchat)<br/><br/>cron-acp 路径用 resolveExplicitDiscordTarget()<br/>→ 直接读 &lt;callback&gt; 块，绕过 deliveryContext"]
    BG -.-> KEY
```

---

## 10. sessionKey 续接状态机

```mermaid
stateDiagram-v2
    [*] --> NoStore : 首次触发

    state NoStore {
        [*] --> CheckStore : readStoredSessionKey()
        CheckStore --> NullResult : 文件不存在
    }

    state FirstTurn {
        [*] --> NewSession : resumeSessionId = undefined
        NewSession --> FullPayload : renderConcretePrompt()<br/>完整 handoff_payload
        FullPayload --> Execute : sessions_spawn
        Execute --> StoreKey : storeSessionKey(turnCount=1)
    }

    state ResumeTurn {
        [*] --> CheckLimit : 读取 stored.turnCount
        CheckLimit --> WithinLimit : turnCount < maxTurns<br/>(或 maxTurns 未设置)
        CheckLimit --> OverLimit : turnCount >= maxTurns
        WithinLimit --> InjectResume : resumeSessionId = acpSessionId
        InjectResume --> PureTask : task = promptTask 纯文本
        PureTask --> Execute2 : sessions_spawn + resumeSessionId
        Execute2 --> UpdateKey : storeSessionKey(turnCount+1)
        OverLimit --> ForceNew : resumeSessionId = undefined<br/>强制新建 session
        ForceNew --> FullPayload2 : renderConcretePrompt()<br/>完整 handoff_payload
        FullPayload2 --> Execute3 : sessions_spawn（新 session）
        Execute3 --> ResetKey : storeSessionKey(turnCount=1)
    }

    NoStore --> FirstTurn
    FirstTurn --> ResumeTurn : 下次触发
    ResumeTurn --> ResumeTurn : 继续触发

    note right of OverLimit
        maxTurns 设计目的：
        防止 autocompact 导致
        子 Agent 失去身份认知
    end note

    note right of InjectResume
        续接时 sessions_spawn 携带
        resumeSessionId 参数，
        子 Agent 恢复历史上下文
    end note
```

---

## 11. maxTurns 轮次控制流程

以 `maxTurns=3` 为例：

```mermaid
timeline
    title maxTurns=3 的 session 生命周期

    section Session A（第1-3轮）
        第1次触发 : stored=null
                  : 新建 Session A
                  : turnCount=1 存储
                  : 注入完整上下文

        第2次触发 : stored={A, turnCount=1}
                  : 1 < 3，续接 A
                  : turnCount=2 更新
                  : 只发纯任务

        第3次触发 : stored={A, turnCount=2}
                  : 2 < 3，续接 A
                  : turnCount=3 更新
                  : 只发纯任务

    section Session B（第4-6轮）
        第4次触发 : stored={A, turnCount=3}
                  : 3 >= 3，强制新建！
                  : 新建 Session B
                  : turnCount=1 重置
                  : 重新注入完整上下文

        第5次触发 : stored={B, turnCount=1}
                  : 1 < 3，续接 B
                  : turnCount=2 更新

        第6次触发 : stored={B, turnCount=2}
                  : 2 < 3，续接 B
                  : turnCount=3 更新
```

**turnCount 计算逻辑**：

```mermaid
flowchart LR
    START["startBackgroundMonitor 完成后"]
    READ["readStoredSessionKey()<br/>读取 existingStore"]
    COMPARE{"existingStore.acpSessionId<br/>=== 新的 acpSessionId?"}
    NEW["isNewSession = true<br/>nextTurnCount = 1"]
    CONT["isNewSession = false<br/>nextTurnCount = existingStore.turnCount + 1"]
    STORE["storeSessionKey(nextTurnCount)"]

    START --> READ
    READ --> COMPARE
    COMPARE -->|"不同（新 session）"| NEW
    COMPARE -->|"相同（续接）"| CONT
    NEW --> STORE
    CONT --> STORE

    style NEW fill:#ffe0cc
    style CONT fill:#ccffcc
```

---

## 12. 首轮 vs 续接轮：task 内容对比

```mermaid
block-beta
    columns 2

    block:FIRST["首轮（无 resumeSessionId）"]:1
        F1["&lt;handoff_payload&gt;"]
        F2["  &lt;handoff_context&gt;"]
        F3["    IDENTITY.md 内容"]
        F4["    SOUL.md 内容"]
        F5["    AGENTS.md 内容"]
        F6["    TOOLS.md 内容"]
        F7["    USER.md 内容"]
        F8["    MEMORY.md 内容"]
        F9["  &lt;/handoff_context&gt;"]
        F10["  &lt;handoff_task&gt;"]
        F11["    用户的实际任务"]
        F12["  &lt;/handoff_task&gt;"]
        F13["&lt;/handoff_payload&gt;"]
    end

    block:RESUME["续接轮（有 resumeSessionId）"]:1
        R1["用户的实际任务"]
        R2["（纯文本，无任何包装）"]
        SPACE1[" "]
        SPACE2[" "]
        SPACE3[" "]
        SPACE4[" "]
        SPACE5[" "]
        SPACE6[" "]
        SPACE7[" "]
        SPACE8[" "]
        SPACE9[" "]
        SPACE10[" "]
        SPACE11[" "]
    end
```

**为什么续接轮不注入上下文？**

```mermaid
graph LR
    A["子 Agent session<br/>已有历史记录"]
    B["历史中包含首轮的<br/>handoff_payload"]
    C["IDENTITY/SOUL/规则<br/>已在 session 历史里"]
    D["重复注入 = 浪费 token<br/>+ 可能混淆子 Agent"]
    E["续接轮只发任务文本<br/>子 Agent 凭历史理解上下文"]

    A --> B --> C --> D
    D --> E

    style E fill:#ccffcc
    style D fill:#ffcccc
```

---

## 13. handoff_payload 的构成结构

```mermaid
graph TD
    HP["&lt;handoff_payload&gt;"]

    HP --> HC["&lt;handoff_context&gt;<br/>父 Agent 的完整身份信息"]
    HP --> HA["&lt;handoff_artifacts&gt;<br/>观测副本文件路径"]
    HP --> HT["&lt;handoff_task&gt;<br/>子 Agent 要执行的任务"]

    HC --> AP["&lt;agent_profile&gt;"]
    HC --> OR["&lt;operating_rules&gt;"]
    HC --> UP["&lt;user_profile&gt;<br/>USER.md 内容"]
    HC --> MEM["&lt;memory&gt;<br/>MEMORY.md 内容"]

    AP --> ID["&lt;identity&gt;<br/>IDENTITY.md"]
    AP --> BS["&lt;behavior_style&gt;<br/>SOUL.md"]

    OR --> RU["&lt;rules&gt;<br/>RULES.md"]
    OR --> WF["&lt;workflow&gt;<br/>AGENTS.md"]
    OR --> TO["&lt;tools&gt;<br/>TOOLS.md"]

    HA --> EP["exact_payload_file<br/>时间戳版本路径"]
    HA --> LP["latest_exact_payload_file<br/>latest 符号链接"]

    HT --> GU["&lt;guide&gt;<br/>执行规则优先级说明"]
    HT --> REQ["&lt;request&gt;<br/>用户的原始任务"]

    style HP fill:#e8f4f8,stroke:#2196F3
    style HC fill:#fff3e0,stroke:#FF9800
    style HT fill:#e8f5e9,stroke:#4CAF50
    style HA fill:#f3e5f5,stroke:#9C27B0
```

**Project Context 提取规则**：

```mermaid
flowchart LR
    SP["systemPrompt<br/>(父 Agent 的系统提示)"]
    PC["# Project Context 标记"]
    EX["extractProjectContextFiles()"]

    SP --> PC
    PC --> EX

    EX --> I["## IDENTITY.md → &lt;identity&gt;"]
    EX --> S["## SOUL.md → &lt;behavior_style&gt;"]
    EX --> U["## USER.md → &lt;user_profile&gt;"]
    EX --> R["## RULES.md → &lt;rules&gt;"]
    EX --> A["## AGENTS.md → &lt;workflow&gt;"]
    EX --> T["## TOOLS.md → &lt;tools&gt;"]
    EX --> M["## MEMORY.md → &lt;memory&gt;"]
```

---

## 14. Discord 回调目标解析路径

```mermaid
flowchart TD
    START["after_tool_call<br/>需要 Discord 目标"]

    START --> HAS_CB{"pendingStructuredSpawn<br/>有显式 callback?"}

    subgraph PATH1["路径一：显式 callback（cron-acp / 结构化请求）"]
        P1["resolveExplicitDiscordTarget(callback)"]
        P1A["to = callback.to<br/>(如 'user:881734814204571708')"]
        P1B["accountId = callback.accountId<br/>?? resolveDiscordBindingAccountId(api, agentId)"]
        P1C["✅ 返回 {to, accountId}"]
        P1 --> P1A --> P1B --> P1C
    end

    subgraph PATH2["路径二：从 session 提取（普通 Discord 对话）"]
        P2["extractDiscordTarget(ctx, api)"]
        P2A["readSessionRegistryEntry()<br/>读 deliveryContext + origin"]
        P2B{"isDiscordSession?<br/>deliveryContext.channel === 'discord'<br/>OR origin.provider === 'discord'"}
        P2C["❌ 返回 null<br/>(cron 场景失败)"]
        P2D["提取 accountId<br/>deliveryContext > origin > binding"]
        P2E["提取 to<br/>deliveryContext.to > origin.to"]
        P2F["✅ 返回 {to, accountId}"]
        P2 --> P2A --> P2B
        P2B -->|"否"| P2C
        P2B -->|"是"| P2D --> P2E --> P2F
    end

    subgraph RESULT["结果处理"]
        NULL_CHECK{"target 为 null?"}
        SKIP["跳过 Discord 推送<br/>静默返回"]
        MONITOR["startBackgroundMonitor(target)"]
    end

    HAS_CB -->|"是"| PATH1
    HAS_CB -->|"否"| PATH2

    P1C --> NULL_CHECK
    P2C --> NULL_CHECK
    P2F --> NULL_CHECK

    NULL_CHECK -->|"是"| SKIP
    NULL_CHECK -->|"否"| MONITOR

    style P1C fill:#ccffcc
    style P2C fill:#ffcccc
    style SKIP fill:#ffcccc
    style MONITOR fill:#ccffcc
```

---

## 15. startBackgroundMonitor 后台监听流程

```mermaid
flowchart TD
    ENTRY["startBackgroundMonitor(<br/>  childSessionKey,<br/>  target: DiscordDeliveryTarget,<br/>  options: {model, fixedSessionKey, maxTurns, agentId}<br/>)"]

    ENTRY --> SI["return new Promise<br/>→ setImmediate(async () => ...)"]
    Note1["⚡ setImmediate 确保<br/>不阻塞父 Agent 的当前轮次"]
    SI -.-> Note1

    SI --> MODEL{"options.model<br/>指定了模型?"}
    MODEL -->|"是"| SET_MODEL["setAcpxModel()<br/>acpx &lt;agentId&gt; set model &lt;value&gt;<br/>--session &lt;childSessionKey&gt;"]
    MODEL -->|"否"| WAIT
    SET_MODEL -->|"失败只记 warning"| WAIT

    WAIT["waitForChildSessionCompletion()<br/>最多 120s，每 2s 轮询<br/><br/>轮询目标：<br/>1. session registry<br/>2. session .jsonl 文件 mtime<br/>3. 检测 stopReason / tool error"]

    WAIT --> DONE{"子会话<br/>完成?"}

    DONE -->|"超时"| TIMEOUT["output.completed = false<br/>output.error = '超时'"]
    DONE -->|"完成"| SK_STORE{"有 fixedSessionKey<br/>且有 agentId?"}

    SK_STORE -->|"是"| FIND["findAcpxSessionId()<br/>从 acpx index.json 查 UUID"]
    SK_STORE -->|"否"| SEND

    FIND --> CALC["计算 nextTurnCount<br/>isNewSession ? 1 : stored.turnCount+1"]
    CALC --> STORE["storeSessionKey(<br/>  agentId, fixedSessionKey,<br/>  acpSessionId, nextTurnCount<br/>)"]
    STORE --> SEND

    SEND{"子会话状态?"}
    TIMEOUT --> SEND

    SEND -->|"!output.completed"| ERR["sendToDiscord<br/>'⚠️ ACP 子会话执行失败：...'"]
    SEND -->|"needs_user_input"| WAIT_MSG["sendToDiscord<br/>'🟡 ACP 子会话等待输入：...'"]
    SEND -->|"成功完成"| OK["sendToDiscord<br/>'✅ ACP 子会话执行完成：<br/>[子 Agent 输出]'"]

    ERR & WAIT_MSG & OK --> END["resolve()<br/>后台任务结束"]

    style SI fill:#e0f0ff
    style SET_MODEL fill:#fff3cc
    style STORE fill:#e0ffe0
    style OK fill:#ccffcc
    style ERR fill:#ffcccc
```

---

## 16. 数据存储全景图

```mermaid
graph TB
    subgraph OPENCLAW["~/.openclaw/"]
        subgraph AHP["acp-handoff/"]
            CACHE["cache/<br/>  {hash16}.json       ← 按 sessionKey 的最新快照<br/>  runs/{runId}.json   ← 按 runId 的历史快照"]
            SK["session-keys/<br/>  {agentId}-{fixedName}.json<br/>  字段：acpSessionId, turnCount,<br/>        agentId, fixedName, storedAt"]
        end

        subgraph AGENTS["agents/{agentId}/"]
            SESS_REG["sessions/sessions.json<br/>  会话注册表<br/>  含 deliveryContext, origin"]
            SESS_FILE["sessions/{sessionId}.jsonl<br/>  会话完整转录<br/>  (waitForChildSessionCompletion 轮询此文件)"]
        end

        subgraph WS["workspace-{agentId}/"]
            ACPX_IDX[".acpx/sessions/index.json<br/>  entries: [{name: childSessionKey,<br/>             acpSessionId: uuid}]<br/>  (findAcpxSessionId 读取此文件)"]
        end
    end

    subgraph WORKDIR["工作目录/{workspaceDir}/"]
        subgraph DOTOC[".openclaw/acp-handoff/"]
            PROMPT_TS["2026-03-20T12-34-56-clmini.prompt.txt<br/>  时间戳版本 handoff_payload 副本"]
            PROMPT_LATEST["latest-observed-cli-payload.txt<br/>  最新 handoff_payload 副本"]
            ACP_REQ["latest-observed-acp-request.xml<br/>  最新 &lt;acp_request&gt; 副本（调试用）"]
            CB_MIRROR["latest-resolved-callback.json<br/>  最新 Discord 目标（调试用）"]
            PENDING["pending-structured-spawns.json<br/>  待处理的结构化请求队列<br/>  (after_tool_call 从此恢复)"]
        end
    end

    subgraph FLOW["数据流向"]
        direction LR
        E1["llm_input"] -->|"写"| CACHE
        E2["before_tool_call"] -->|"读"| CACHE
        E2 -->|"读"| SK
        E2 -->|"写"| PENDING
        E2 -->|"写"| PROMPT_TS
        E2 -->|"写"| PROMPT_LATEST
        E3["after_tool_call"] -->|"读"| PENDING
        E4["startBackgroundMonitor"] -->|"读"| ACPX_IDX
        E4 -->|"写"| SK
        E4 -->|"轮询"| SESS_FILE
        E4 -->|"读"| SESS_REG
    end

    style AHP fill:#fff3e0
    style AGENTS fill:#e8f5e9
    style WS fill:#e3f2fd
    style DOTOC fill:#f3e5f5
```

---

## 17. skill-builder-hourly-v2 端到端完整流程

```mermaid
sequenceDiagram
    participant CRON as OpenClaw Cron 调度器
    participant W as wolf (isolated session)
    participant P as acp-handoff 插件
    participant ACP as ACP Runtime (acpx)
    participant CM as clmini 子 Agent
    participant BG as 后台监听器
    participant SK as session-keys 存储
    participant D as Discord (user:881734814204571708)

    Note over CRON: 每小时触发
    CRON->>W: 启动 isolated session (agentId=wolf)
    Note over W: payload 含 cron-acp skill + acp_request XML

    Note over P: llm_input 事件
    W->>P: llm_input (wolf 的系统提示 + payload)
    P->>P: createSnapshot()
    Note over P: 捕获 wolf 的 IDENTITY/SOUL/AGENTS/TOOLS/USER
    P-->>W: 快照存入 cache

    Note over W: wolf 识别 "使用 cron-acp skill"
    W->>P: before_tool_call(sessions_spawn)
    Note over W: task="[acp-handoff] [cron-structured-request]"

    P->>P: 检测 [cron-structured-request] 信号
    P->>P: 从父 prompt 提取 acp_request
    P->>P: 解析得到 agentId=clmini
    Note over P: sessionKey=skill-builder-persistent-test<br/>model=minimax/MiniMax-M2.7-highspeed<br/>responseMode=async-callback<br/>callback={to:"user:881734814204571708"}

    P->>SK: readStoredSessionKey(clmini, skill-builder-persistent-test)
    SK-->>P: {acpSessionId: "04fd5f7a-...", turnCount: N}

    alt turnCount < maxTurns (或未设置 maxTurns)
        P->>P: resumeSessionId = "04fd5f7a-..."
        P->>P: rewrittenTask = promptTask (纯 cli_prompt 内容)
    else turnCount >= maxTurns
        P->>P: resumeSessionId = undefined
        P->>P: rewrittenTask = renderConcretePrompt() (完整 handoff_payload)
    end

    P->>P: 入队 pendingStructuredSpawn
    Note over P: {responseMode: async-callback, callback}
    P-->>W: task=rewrittenTask, resumeSessionId?

    W->>ACP: sessions_spawn(runtime="acp", agentId="clmini", task=rewrittenTask, resumeSessionId?)
    ACP->>CM: 启动/续接 clmini session
    ACP-->>W: accepted {childSessionKey: "agent:clmini:acp:xxx"}

    Note over W: ⚡ wolf 立即结束当前轮次
    W-->>CRON: "ACP 子任务已派发，结果将异步回调"

    W->>P: after_tool_call
    P->>P: 出队 pendingStructuredSpawn
    P->>P: resolveExplicitDiscordTarget(callback)
    Note over P: → {to: "user:881734814204571708", accountId: "bot6"}
    P->>BG: setImmediate(startBackgroundMonitor)
    P-->>W: 立即返回

    Note over BG,CM: 后台异步执行（约 17-725 秒）
    BG->>ACP: acpx clmini set model minimax/MiniMax-M2.7-highspeed --session agent:clmini:acp:xxx

    loop 每 2 秒
        BG->>CM: 检查 session 文件 mtime 是否稳定
    end

    CM->>CM: 执行 cli_prompt 任务 (概括提示词，写时间戳文件)
    CM-->>BG: session 完成 (stopReason 检测)

    BG->>ACP: findAcpxSessionId() 读 workspace-clmini/.acpx/sessions/index.json
    ACP-->>BG: acpSessionId = "04fd5f7a-..."

    BG->>SK: storeSessionKey(agentId=clmini, fixedName=skill-builder-persistent-test, turnCount=N+1)

    BG->>D: sendMessageDiscord("user:881734814204571708", "✅ ACP 子会话执行完成", {accountId:"bot6"})
    D-->>D: 用户收到 Discord 消息
```

---

## 附：各图索引

| 图编号 | 主题 | 类型 |
|--------|------|------|
| 图1 | 没有插件时的信息断层 | sequenceDiagram |
| 图2 | 插件介入后的完整系统架构 | graph TB |
| 图3 | 三大事件钩子的时序关系 | sequenceDiagram |
| 图4 | llm_input 快照捕获流程 | flowchart |
| 图5 | before_tool_call 上下文注入决策树 | flowchart |
| 图6 | 同步模式（sync-return）时序 | sequenceDiagram |
| 图7 | 异步模式（async-callback）时序 | sequenceDiagram |
| 图8 | cron 场景 Discord 失效原因 | flowchart |
| 图9 | cron-acp skill 修复路径 | flowchart |
| 图10 | sessionKey 续接状态机 | stateDiagram |
| 图11 | maxTurns 轮次控制流程 | timeline + flowchart |
| 图12 | 首轮 vs 续接轮 task 内容对比 | block |
| 图13 | handoff_payload 构成结构 | graph |
| 图14 | Discord 回调目标解析路径 | flowchart |
| 图15 | startBackgroundMonitor 后台监听流程 | flowchart |
| 图16 | 数据存储全景图 | graph |
| 图17 | skill-builder-hourly-v2 端到端完整流程 | sequenceDiagram |

*文档生成时间：2026-03-20*
