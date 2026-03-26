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

### 完整 Cron 配置

**文件位置**：`~/.openclaw/cron/jobs.json`

```json
{
  "jobs": [
    {
      "id": "skill-builder-hourly",
      "name": "Skill Builder - Hourly Check",
      "schedule": "7 * * * *",
      "enabled": true,
      "agent": "wolf",
      "delivery": {
        "mode": "none"
      },
      "sessionTarget": "isolated",
      "payload": {
        "kind": "agentTurn",
        "message": "使用 cron-acp skill 处理这个请求。\n\n<acp_request>\n  <meta>\n    <agentId>claude</agentId>\n    <sessionKey>skill-builder-persistent</sessionKey>\n    <model>sonnet</model>\n    <maxTurns>5</maxTurns>\n    <responseMode>async-callback</responseMode>\n    <callback>\n      <channel>discord</channel>\n      <to>user:YOUR_DISCORD_USER_ID</to>\n    </callback>\n    <includeMemory>false</includeMemory>\n    <includeRules>true</includeRules>\n    <includeAgents>false</includeAgents>\n    <includeTools>false</includeTools>\n    <includeArtifacts>false</includeArtifacts>\n    <customGuide>\n你是 Skill 构建专家，专注于创建规范的 SKILL.md 文件。\n\n执行流程：\n1. 读取 ~/.claude/skills/ 目录，分析现有 skill 结构\n2. 识别用户需求中缺失的 skill 类型\n3. 为每个缺失项创建符合规范的 SKILL.md\n4. 不修改任何现有文件\n\n质量标准：\n- 文件名：kebab-case，描述性强\n- 结构：包含 description, triggers, examples\n- 内容：简洁、可执行、有示例\n    </customGuide>\n  </meta>\n  <cli_prompt>\n分析当前 skill 体系，识别缺失的常用 skill 类型（如数据分析、文档生成、测试辅助等），为每个缺失项创建 SKILL.md 文件。\n\n要求：\n1. 只创建真正缺失的 skill\n2. 每个 skill 必须有明确的使用场景\n3. 输出创建的文件列表和简要说明\n  </cli_prompt>\n</acp_request>"
      }
    }
  ]
}
```

### 字段说明（Cron 层级）

| 字段 | 值 | 说明 |
|------|-----|------|
| `id` | `skill-builder-hourly` | 任务唯一标识 |
| `name` | `Skill Builder - Hourly Check` | 任务名称 |
| `schedule` | `7 * * * *` | 每小时第 7 分钟执行（避开整点）|
| `enabled` | `true` | 任务启用状态 |
| `agent` | `wolf` | 执行任务的 agent |
| `delivery.mode` | `none` | 不使用 cron 自带的 delivery（由 skill 推送）|
| `sessionTarget` | `isolated` | 独立会话（必须）|
| `payload.kind` | `agentTurn` | agent 执行任务（必须）|

### 字段说明（ACP 层级）

| 字段 | 值 | 说明 |
|------|-----|------|
| `agentId` | `claude` | 目标 ACP 子 agent |
| `sessionKey` | `skill-builder-persistent` | 会话标识（续接）|
| `model` | `sonnet` | 使用 Sonnet 模型 |
| `maxTurns` | `5` | 最多 5 轮对话 |
| `responseMode` | `async-callback` | 异步模式 |
| `callback.to` | `user:YOUR_DISCORD_USER_ID` | 目标用户 ID |
| `includeMemory` | `false` | Cron 任务不需要历史记忆 |
| `includeRules` | `true` | 保留核心原则 |
| `includeAgents` | `false` | Cron 任务不需要协作规范 |
| `includeTools` | `false` | 不包含工具说明 |
| `includeArtifacts` | `false` | 不包含文件路径 |
| `customGuide` | 自定义内容 | 覆盖默认 guide |

### 关键配置说明

#### 1. 使用 cron-acp skill

```
使用 cron-acp skill 处理这个请求。
```

**作用**：
- 自动添加 `[acp-handoff]` 标记（触发插件）
- 等待子任务完成
- 通过 Discord 推送结果（弥补 cron 的 after_tool_call 失效）

#### 2. delivery.mode = "none"

```json
"delivery": {
  "mode": "none"
}
```

**作用**：关闭 cron 自带的 delivery，由 cron-acp skill 自己推送。

#### 3. sessionTarget = "isolated"

```json
"sessionTarget": "isolated"
```

**作用**：创建独立会话，不影响主会话。

#### 4. payload.kind = "agentTurn"

```json
"payload": {
  "kind": "agentTurn",
  "message": "..."
}
```

**作用**：agent 执行任务（不是系统事件）。

### 这个 Cron 配置怎么用

1. 把上面的任务写进 `~/.openclaw/cron/jobs.json`。
2. 执行 `openclaw cron list`，确认任务 `skill-builder-hourly` 已被加载。
3. 执行 `openclaw cron run skill-builder-hourly` 做一次手动验证。
4. 检查 `~/.openclaw/workspace-wolf/.openclaw/acp-handoff/latest-observed-cli-payload.txt`，确认插件已生成最终 payload。
5. 检查 `~/.openclaw/acp-handoff/session-keys/claude-skill-builder-persistent.json`，确认 `sessionKey` 已被记录。
6. 如果配置了 Discord 回调，再确认你的 Discord 收到了结果消息。

### 执行流程

1. **触发**：Cron 到达 schedule 时间
2. **启动**：wolf agent 启动 isolated session
3. **执行**：wolf 调用 cron-acp skill
4. **交接**：插件检测 `[acp-handoff]`，打包上下文
5. **spawn**：创建 `claude` 子会话
6. **完成**：子任务完成，cron-acp skill 推送到 Discord

### 验证方法

```bash
# 查看 cron 任务列表
openclaw cron list

# 手动触发测试
openclaw cron run skill-builder-hourly

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
- `delivery.mode`: `none`（使用 cron-acp skill）
- `sessionTarget`: `isolated`（独立会话）
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
