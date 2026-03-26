---
name: cron-acp
description: OpenClaw定时任务 + ACP请求构造工具。管理基于OpenClaw cron的定时任务，自动构造ACP请求格式。
user-invocable: true
---

# cron-acp

OpenClaw定时任务 + ACP请求构造工具

## 触发条件

当用户需要：
- 创建OpenClaw定时任务并发送ACP请求
- 管理现有的ACP定时任务
- 编辑任务配置（提示词或元数据）
- 测试ACP请求格式

## 任务目录结构

任务存储在OpenClaw agent的workspace中：`{workspace}/cron/`

**路径规则**：
- 默认agent（main）：`~/.openclaw/workspace/cron/`
- 指定agent：`~/.openclaw/workspace-{agentId}/cron/`
- 例如fox agent：`~/.openclaw/workspace-fox/cron/`
- 例如koala agent：`~/.openclaw/workspace-koala/cron/`

每个任务一个目录，固定包含两个文件：

```
{workspace}/cron/
├── env-snapshot/              # 环境快照任务
│   ├── prompt.md             # 任务提示词
│   └── metadata.json         # ACP元数据配置
├── daily-summary/             # 每日总结任务
│   ├── prompt.md
│   └── metadata.json
└── README.md                  # 使用说明（可选）
```

**设计原则**：
- 一个任务 = 一个目录
- 目录名 = 任务标识符（kebab-case）
- 固定文件名：`prompt.md` + `metadata.json`
- 任务绑定到特定的OpenClaw agent

**重要概念区分**：
- **OpenClaw agentId**：任务在哪个OpenClaw agent中运行（如 `fox`, `main`, `koala`）
  - 通过 `openclaw agents list` 查看
  - 决定workspace路径和任务运行环境
- **ACP agentId**：ACP系统中的 agent 标识符（如 `claude`, `copilot`，或你的自定义子 agent）
  - 在 `metadata.json` 中配置
  - 是ACP系统内部的概念
- **两者完全独立**：OpenClaw的fox agent可以调用ACP的clg agent

## 核心功能

1. **create** - 创建定时任务
2. **edit** - 编辑任务配置
3. **list** - 列出所有定时任务
4. **delete** - 删除定时任务
5. **test** - 测试请求格式
6. **execute** - 执行任务（由cron触发，内部功能）

---

## 功能1: create - 创建定时任务

### 步骤

1. **收集任务信息**：
   - **OpenClaw agentId**（任务运行在哪个agent，如 `fox`, `main`, `koala`）
     - 如果用户未指定，使用 `openclaw agents list` 查看可用agent并询问
     - 如果只有一个agent或用户明确当前agent，使用当前agent
     - 注意：这是OpenClaw的agent，不是ACP的agent
   - 任务标识符（目录名，如 `env-snapshot`）
   - 任务显示名称（如 "每日环境快照"）
   - Cron表达式（如 `15 9 * * *`）或一次性时间（ISO格式）
   - 时区（默认 `Asia/Shanghai`）
   - 提示词内容（用户指定或留空）
   - ACP元数据：
     - agentId（ACP系统的 agent，如 `claude`, `copilot`，与 OpenClaw agentId 完全不同）
     - sessionKey
     - model（默认 `default`）
     - responseMode（默认 `async-callback`）
     - callback.channel（如 `discord`）
     - callback.to（如 `user:123456`）

2. **确定workspace路径**：
   ```bash
   # 获取agent的workspace路径
   openclaw agents list | grep -A 1 "^- {agentId}" | grep "Workspace:"

   # 或使用规则：
   # main agent: ~/.openclaw/workspace
   # 其他agent: ~/.openclaw/workspace-{agentId}
   ```

3. **创建任务目录**：
   ```bash
   mkdir -p {workspace}/cron/{任务标识符}
   ```

4. **创建 prompt.md**：
   - 路径：`{workspace}/cron/{任务标识符}/prompt.md`
   - 内容：用户指定的提示词（如果用户未指定，创建空文件）

5. **创建 metadata.json**：
   - 路径：`{workspace}/cron/{任务标识符}/metadata.json`
   - 内容：ACP元数据配置（JSON格式）

6. **构造 cron message**：
   ```
   使用 cron-acp skill 执行任务

   OpenClaw Agent: {OpenClaw agentId}
   任务：{任务标识符}
   ```

7. **调用 openclaw cron add**：
   ```bash
   openclaw cron add \
     --name "{任务显示名称}" \
     --cron "{cron表达式}" \
     --tz "{时区}" \
     --session isolated \
     --agent {OpenClaw agentId} \
     --message "使用 cron-acp skill 执行任务

   OpenClaw Agent: {OpenClaw agentId}
   任务：{任务标识符}" \
     --announce \
     --channel {回调渠道} \
     --to {回调目标}
   ```

   **注意**：`--agent` 参数指定任务运行在哪个OpenClaw agent中

8. **返回确认信息**：
   - OpenClaw agentId
   - 任务目录路径
   - OpenClaw任务ID
   - 下次执行时间

### 示例

```
用户: 创建一个每天早上9:15的环境快照任务

助手:
请提供以下信息：

1. 任务标识符（用作目录名）
   建议：env-snapshot

用户: env-snapshot

助手:
2. 任务显示名称
   建议：每日环境快照

用户: 每日环境快照

助手:
3. 提示词内容（或回复"跳过"留空）

用户:
概括当前环境、模型、角色信息，
输出到新文件，命名格式：snapshot-{北京时间YYYY-MM-DD_HHmmss}.md

助手:
4. ACP配置：
   - Agent ID:

用户: claude

助手:
   - Session Key:

用户: cron-acp-persistent

助手:
   - 回调渠道（discord/slack/telegram等）:

用户: discord

助手:
   - 回调目标:

用户: user:881734814204571708

助手:
确认创建任务？

任务配置：
- 标识符: env-snapshot
- 名称: 每日环境快照
- Cron: 15 9 * * *
- 时区: Asia/Shanghai
- 提示词: 已指定（3行）
- 回调: discord -> user:881734814204571708

用户: 确认

助手:
✓ 创建目录：~/.openclaw/workspace/cron/env-snapshot/
✓ 创建文件：prompt.md（3行）
✓ 创建文件：metadata.json

[执行命令]
openclaw cron add \
  --name "每日环境快照" \
  --cron "15 9 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "使用 cron-acp skill 执行任务

任务：env-snapshot" \
  --announce \
  --channel discord \
  --to "user:881734814204571708"

✓ OpenClaw定时任务创建成功！
  任务ID: cron_abc123
  下次执行：2026-03-23 09:15:00 CST
```

---

## 功能2: edit - 编辑任务配置

### 步骤

1. **列出现有任务目录**：
   ```bash
   ls ~/.openclaw/workspace/cron/
   ```

2. **用户选择任务**

3. **选择编辑内容**：
   - 编辑 prompt.md（提示词）
   - 编辑 metadata.json（ACP元数据）
   - 修改 cron 表达式（需要通过 `openclaw cron edit` 命令）

4. **使用 Edit 工具修改文件**

5. **确认修改**

### 示例

```
用户: 修改 env-snapshot 的提示词

助手:
当前 prompt.md 内容：
---
概括当前环境、模型、角色信息，
输出到新文件，命名格式：snapshot-{北京时间YYYY-MM-DD_HHmmss}.md
---

请提供新内容：

用户:
概括当前环境、模型、角色信息，
增加：当前工作目录、最近修改的文件
输出到新文件，命名格式：snapshot-{北京时间YYYY-MM-DD_HHmmss}.md

助手: [使用 Edit 工具]
✓ 已更新：~/.openclaw/workspace/cron/env-snapshot/prompt.md
  提示：下次执行时会使用新的提示词
```

---

## 功能3: list - 列出所有定时任务

### 步骤

1. **列出任务目录**：
   ```bash
   ls -la ~/.openclaw/workspace/cron/
   ```

2. **列出 OpenClaw cron 任务**：
   ```bash
   openclaw cron list
   ```

3. **关联显示**：
   - 任务目录名
   - OpenClaw任务ID
   - Cron表达式
   - 下次执行时间
   - 状态（enabled/disabled）

### 示例

```
用户: 列出所有定时任务

助手:
[执行 ls ~/.openclaw/workspace/cron/]
任务目录：
- env-snapshot/
- daily-summary/

[执行 openclaw cron list]
OpenClaw定时任务：

1. 每日环境快照
   - 任务ID: cron_abc123
   - 目录: env-snapshot/
   - Cron: 15 9 * * *
   - 下次执行: 2026-03-23 09:15:00 CST
   - 状态: enabled

2. 每日总结
   - 任务ID: cron_def456
   - 目录: daily-summary/
   - Cron: 0 22 * * *
   - 下次执行: 2026-03-22 22:00:00 CST
   - 状态: enabled
```

---

## 功能4: delete - 删除定时任务

### 步骤

1. **列出任务**（调用 list 功能）

2. **用户选择任务**

3. **删除 OpenClaw cron 任务**：
   ```bash
   openclaw cron remove {jobId}
   ```

4. **询问是否删除任务目录**：
   ```
   是否同时删除任务目录？
   路径：~/.openclaw/workspace/cron/{任务标识符}/
   （包含 prompt.md 和 metadata.json）
   ```

5. **如果用户确认，删除目录**：
   ```bash
   rm -rf ~/.openclaw/workspace/cron/{任务标识符}
   ```

6. **返回确认信息**

### 示例

```
用户: 删除 env-snapshot 任务

助手:
找到任务：
- OpenClaw任务ID: cron_abc123
- 任务目录: ~/.openclaw/workspace/cron/env-snapshot/
- 包含文件: prompt.md, metadata.json

确认删除？

用户: 确认

助手:
[执行 openclaw cron remove cron_abc123]
✓ 已删除OpenClaw定时任务: cron_abc123

是否同时删除任务目录？
路径：~/.openclaw/workspace/cron/env-snapshot/

用户: 是

助手:
[执行 rm -rf ~/.openclaw/workspace/cron/env-snapshot]
✓ 已删除任务目录: env-snapshot/
```

---

## 功能5: test - 测试请求格式

### 步骤

1. **用户指定参数**：
   - OpenClaw agentId（如 `main`、`fox`）
   - 任务标识符（如 `env-snapshot`）

2. **确定workspace路径**

3. **读取文件**：
   ```
   Read({file_path: "{workspace}/cron/{任务标识符}/prompt.md"})
   Read({file_path: "{workspace}/cron/{任务标识符}/metadata.json"})
   ```

4. **解析 metadata.json**

5. **构造 ACP 请求**（同功能6）

6. **显示完整请求**（不实际发送）

7. **让用户确认格式**

### 示例

```
用户: 测试 env-snapshot

助手:
读取任务配置...
✓ prompt.md（3行）
✓ metadata.json（有效）

构造的ACP请求：
---
<acp_request>
  <meta>
    <agentId>claude</agentId>
    <sessionKey>cron-acp-persistent</sessionKey>
    <model>default</model>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:881734814204571708</to>
    </callback>
  </meta>
  <cli_prompt>
概括当前环境、模型、角色信息，
输出到新文件，命名格式：snapshot-{北京时间YYYY-MM-DD_HHmmss}.md
  </cli_prompt>
</acp_request>
---

✓ 格式正确！可以创建定时任务。
```

---

## 功能6: execute - 执行任务（内部功能）

### 触发条件

OpenClaw cron 触发时，收到包含以下内容的 message：
```
使用 cron-acp skill 执行任务

OpenClaw Agent: fox
任务：env-snapshot
```

### 步骤

1. **解析参数**：
   - 从 message 中提取 OpenClaw agentId（"OpenClaw Agent:" 后面的内容）
   - 从 message 中提取任务标识符（"任务：" 后面的内容）

2. **确定workspace路径**：
   ```
   如果 agentId == "main":
     workspace = "~/.openclaw/workspace"
   否则:
     workspace = "~/.openclaw/workspace-{agentId}"
   ```

3. **构造文件路径**：
   - Prompt：`{workspace}/cron/{任务标识符}/prompt.md`
   - Metadata：`{workspace}/cron/{任务标识符}/metadata.json`

4. **读取文件**：
   ```
   Read({file_path: "{workspace}/cron/{任务标识符}/prompt.md"})
   Read({file_path: "{workspace}/cron/{任务标识符}/metadata.json"})
   ```

5. **解析 metadata.json**：
   - 使用 JSON.parse 解析
   - 提取字段：agentId（ACP的），sessionKey, model, responseMode, callback

6. **构造 ACP 请求 XML**：
   ```xml
   <acp_request>
     <meta>
       <agentId>{从metadata解析}</agentId>
       <sessionKey>{从metadata解析}</sessionKey>
       <model>{从metadata解析，默认default}</model>
       <responseMode>{从metadata解析，默认async-callback}</responseMode>
       <callback>
         <channel>{从metadata.callback.channel解析}</channel>
         <to>{从metadata.callback.to解析}</to>
       </callback>
     </meta>
     <cli_prompt>
   {从prompt.md读取的完整内容，原样保留，不做任何修改}
     </cli_prompt>
   </acp_request>
   ```

7. **调用 sessions_spawn 工具**：

   **重要**：不能直接输出XML！必须通过sessions_spawn工具调用ACP。

   构造task参数：
   ```
   [acp-handoff] [cron-structured-request]

   <acp_request>
     <meta>...</meta>
     <cli_prompt>...</cli_prompt>
   </acp_request>
   ```

   调用sessions_spawn：
   ```json
   {
     "task": "[acp-handoff] [cron-structured-request]\n\n<上面构造的完整XML>",
     "runtime": "acp",
     "agentId": "{从metadata.json的agentId字段}",
     "mode": "run"
   }
   ```

   **标记说明**：
   - `[acp-handoff]` - 触发acp-handoff插件拦截
   - `[cron-structured-request]` - 告诉插件从XML中提取cli_prompt和meta信息

8. **根据 responseMode 决定等待方式**：

   从metadata中读取responseMode：

   - **async-callback**（默认）：
     ```
     sessions_spawn返回后立即返回
     回复：ACP任务已派发，结果将通过{callback.channel}异步回调到{callback.to}
     ```

   - **sync-return**：
     ```
     使用session_status工具轮询，直到任务完成
     返回最终结果文本
     ```

   **注意**：由于是cron isolated session，responseMode通常应该是async-callback

### 错误处理

- **任务目录不存在**：
  ```
  错误：任务目录不存在
  路径：~/.openclaw/workspace/cron/{任务标识符}/
  请检查任务是否已创建。
  ```

- **prompt.md 不存在**：
  ```
  错误：提示词文件缺失
  路径：~/.openclaw/workspace/cron/{任务标识符}/prompt.md
  ```

- **metadata.json 不存在**：
  ```
  错误：元数据文件缺失
  路径：~/.openclaw/workspace/cron/{任务标识符}/metadata.json
  ```

- **JSON 解析失败**：
  ```
  错误：metadata.json 格式错误
  原因：{解析错误信息}
  请检查 JSON 格式是否正确。
  ```

- **必需字段缺失**：
  ```
  错误：metadata.json 缺少必需字段
  缺失字段：{列出缺失的字段}
  必需字段：agentId, sessionKey, callback.channel, callback.to
  ```

### 示例

```
[2026-03-23 09:15:00 CST - OpenClaw Cron 触发]

Message:
使用 cron-acp skill 执行任务

OpenClaw Agent: fox
任务：env-snapshot

[cron-acp skill execute 功能]

1. 解析参数：
   ✓ OpenClaw agentId: fox
   ✓ 任务标识符: env-snapshot

2. 确定workspace路径：
   ✓ workspace: ~/.openclaw/workspace-fox

3. 读取文件：
   ✓ ~/.openclaw/workspace-fox/cron/env-snapshot/prompt.md
   ✓ ~/.openclaw/workspace-fox/cron/env-snapshot/metadata.json

4. 解析元数据：
   ✓ ACP agentId: claude
   ✓ sessionKey: cron-acp-persistent
   ✓ responseMode: async-callback
   ✓ callback: discord -> user:881734814204571708

5. 构造 ACP 请求 XML：
<acp_request>
  <meta>
    <agentId>claude</agentId>
    <sessionKey>cron-acp-persistent</sessionKey>
    <model>default</model>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:881734814204571708</to>
    </callback>
  </meta>
  <cli_prompt>
概括当前环境、模型、角色信息，
输出到新文件，命名格式：snapshot-{北京时间YYYY-MM-DD_HHmmss}.md
  </cli_prompt>
</acp_request>

6. 调用 sessions_spawn 工具：
   ✓ task: "[acp-handoff] [cron-structured-request]\n\n<acp_request>...</acp_request>"
   ✓ runtime: "acp"
   ✓ agentId: "claude"
   ✓ mode: "run"

7. sessions_spawn 返回：
   ✓ 子任务已派发
   ✓ responseMode=async-callback，立即返回

8. 回复消息：
   "ACP任务已派发，结果将通过discord异步回调到user:881734814204571708"

[后台流程]
→ acp-handoff插件拦截sessions_spawn
→ 解析<acp_request>，提取meta和cli_prompt
→ 派发到ACP系统（agentId=claude）
→ ACP执行任务
→ ACP通过Discord回调返回结果（user:881734814204571708）
```

---

## 完整执行流程

```
用户请求创建任务
   ↓
cron-acp skill (create功能)
   ↓
创建任务目录和文件
   ↓
调用 openclaw cron add
   ↓
OpenClaw 存储任务
   ↓
[定时触发]
   ↓
OpenClaw Cron 调度器
   ↓
启动 isolated job
   ↓
Message 传递给 Claude
   ↓
Claude 识别 "使用 cron-acp skill"
   ↓
cron-acp skill (execute功能)
   ↓
读取 prompt.md 和 metadata.json
   ↓
构造 ACP 请求（XML）
   ↓
调用 sessions_spawn 工具
   ├─ task: "[acp-handoff] [cron-structured-request]\n\n<acp_request>..."
   ├─ runtime: "acp"
   ├─ agentId: "{ACP的agentId}"
   └─ mode: "run"
   ↓
acp-handoff 插件拦截
   ├─ 识别 [acp-handoff] 标记
   ├─ 解析 <acp_request> XML
   ├─ 提取 <meta> 和 <cli_prompt>
   └─ 路由到 ACP 系统
   ↓
ACP 系统执行任务
   ├─ 使用指定的 agentId (如 claude)
   ├─ 使用指定的 sessionKey
   └─ 执行 cli_prompt 中的任务
   ↓
ACP 通过 callback 回调结果
   └─ 发送到 {callback.channel} 的 {callback.to}
```

---

## 注意事项

1. **OpenClaw Agent 确定**：
   - **优先级1**：用户明确指定agent（如"在fox agent中创建"）
   - **优先级2**：如果当前会话有明确的agent上下文，使用当前agent
   - **优先级3**：如果用户未指定，使用 `openclaw agents list` 查看可用agent并询问
   - **默认**：如果只有一个agent，直接使用
   - **重要**：创建任务前必须确认agent，因为它决定了workspace路径
   - **注意**：OpenClaw agent（如fox）与ACP agent（如clg）是完全不同的概念

2. **目录命名规范**：
   - 使用 kebab-case（小写字母 + 连字符）
   - 避免空格和特殊字符
   - 简短且描述性强
   - 示例：`env-snapshot`, `daily-summary`, `pr-reminder`

3. **文件命名固定**：
   - 必须使用 `prompt.md` 和 `metadata.json`
   - 不要重命名这两个文件

4. **提示词内容**：
   - 用户指定了内容，按用户描述写入
   - 用户未指定，创建空文件
   - 不要自作主张添加内容

5. **元数据必需字段**：
   - `agentId` - ACP Agent标识符（注意：这是ACP的，不是OpenClaw的）
   - `sessionKey` - 会话密钥
   - `callback.channel` - 回调渠道
   - `callback.to` - 回调目标

6. **Cron 表达式建议**：
   - 避免整点（:00）和半点（:30），减少服务器压力
   - 使用 OpenClaw 的 stagger 功能分散负载
   - 明确指定时区，避免 UTC 和本地时间混淆

7. **Git 备份**：
   - 整个 `cron/` 目录在 workspace 中，可被 git 管理
   - 建议定期 commit 任务配置变更
   - 元数据可能包含敏感信息，注意 .gitignore

8. **任务管理**：
   - 删除 OpenClaw 任务时，询问是否同时删除目录
   - 避免孤立的任务目录或 cron 配置
   - 定期检查任务目录和 OpenClaw 任务列表的一致性

9. **错误处理**：
   - 文件读取失败时给出明确路径（包含agent信息）
   - JSON 解析失败时指出具体问题
   - 提供可操作的修复建议

10. **Agent概念区分（重要）**：
    - **OpenClaw agentId**：任务运行的环境（如 `fox`, `main`, `koala`）
      - 决定workspace路径和sessions存储
      - 通过 `openclaw agents list` 查看
    - **ACP agentId**：ACP系统中的 agent 标识符（如 `claude`, `copilot`）
      - 在metadata.json中配置
      - 是ACP系统内部概念
    - **两者完全独立**：OpenClaw 的 `fox` 可以调用 ACP 的 `claude`，也可以调用其他自定义子 agent
    - **创建任务时**：需要同时指定这两个agent

---

## 依赖工具

- **Bash** - 执行 `openclaw cron` 命令和目录操作
- **Read** - 读取任务文件（prompt.md, metadata.json）
- **Write** - 创建任务文件
- **Edit** - 修改任务文件
- **sessions_spawn** - 派发ACP子任务（execute功能的核心）
  - 用于将构造的<acp_request>发送到ACP系统
  - 配合[acp-handoff]标记触发acp-handoff插件
- **session_status** - 查询子任务状态（sync-return模式需要）
- **AskUserQuestion** - 收集用户输入（可选）

---

## metadata.json 格式参考

```json
{
  "agentId": "claude",
  "sessionKey": "cron-acp-persistent",
  "model": "default",
  "responseMode": "async-callback",
  "callback": {
    "channel": "discord",
    "to": "user:881734814204571708"
  }
}
```

**字段说明**：
- `agentId` - Agent标识符（必需）
- `sessionKey` - 会话密钥（必需）
- `model` - 模型名称（可选，默认 `default`）
- `responseMode` - 响应模式（可选，默认 `async-callback`）
  - `async-callback` - 异步回调
  - `sync-return` - 同步返回
- `callback` - 回调配置（必需）
  - `channel` - 渠道（discord/slack/telegram等）
  - `to` - 目标（如 `user:123456`, `channel:789`）

---

## prompt.md 格式参考

prompt.md 是纯文本文件，内容完全由用户决定。

**示例1：环境快照**
```markdown
概括当前环境、模型、角色信息，
输出到新文件，命名格式：snapshot-{北京时间YYYY-MM-DD_HHmmss}.md
```

**示例2：每日总结**
```markdown
总结今天的工作进展：
1. 完成的任务
2. 遇到的问题
3. 明天的计划

输出格式：Markdown，包含标题和列表
```

**示例3：代码审查提醒**
```markdown
检查是否有待审查的 Pull Request。
如果有，列出 PR 标题和链接。
如果没有，回复"暂无待审查的PR"。
```

**示例4：空提示词**
```
（文件为空或只包含注释）
```
