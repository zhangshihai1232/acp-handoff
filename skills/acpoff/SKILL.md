---
name: acpoff
description: 当用户说"使用 acpoff 让 <agentId> 执行"时，自动构建完整的 acp_request 并调用 sessions_spawn 触发 ACP 子任务
user-invocable: true
---

# acpoff - ACP 任务触发器

## 你的职责

当用户使用极简语法触发 ACP 任务时，你需要：
1. 解析用户输入，提取目标 agent 和任务内容
2. 构建完整的 `<acp_request>` XML 结构
3. 调用 `sessions_spawn` 工具

## 用户输入格式

用户会使用以下格式：

```
使用 acpoff 让 <agentId> 执行以下任务：

<task>
<任务描述>
</task>
```

或者带选项：

```
使用 acpoff 让 <agentId> 执行以下任务（<选项>）：

<task>
<任务描述>
</task>
```

**支持的选项**：
- `同步` / `同步返回` / `sync` → 同步返回结果
- `异步` / `async` → 异步推送到 Discord（默认）
- `最小上下文` → 关闭 memory/rules/agents
- `完整上下文` → 开启所有上下文（包括 tools/artifacts）
- `续接 <sessionKey>` → 使用指定的 sessionKey

**示例输入 1**：
```
使用 acpoff 让 clg 执行以下任务：

<task>
分析 src/protocol.ts 的类型定义
</task>
```

**示例输入 2**：
```
使用 acpoff 让 clg 执行以下任务（同步返回）：

<task>
读取 src/protocol.ts 的前 50 行
</task>
```

**示例输入 3**：
```
使用 acpoff 让 clg 执行以下任务（最小上下文）：

<task>
统计 src 目录下的 .ts 文件数量
</task>
```

## 执行步骤

### 第 1 步：解析用户输入

从用户消息中提取以下信息：

1. **目标 agentId**：
   - 从 `使用 acpoff 让 <agentId> 执行` 中提取
   - 常见值：`clg`, `clt`, `wolf`, `fox`, `copilot`

2. **选项**（如果有）：
   - 从括号 `（...）` 中提取
   - 解析出：同步/异步、上下文控制、sessionKey

3. **任务内容**：
   - 提取 `<task>` 标签内的所有内容
   - 保持原样，不要改写或总结

### 第 2 步：构建 acp_request

根据提取的信息，构建完整的 XML 结构。

**模板**：

```xml
<acp_request>
  <meta>
    <agentId>{目标 agentId}</agentId>
    <responseMode>{同步或异步}</responseMode>
    {如果是异步，添加 callback}
    {如果有 sessionKey，添加}
    {如果有上下文控制，添加}
  </meta>
  <cli_prompt>
{任务内容}
  </cli_prompt>
</acp_request>
```

**关键规则**：

1. **agentId 必须包含**：
   ```xml
   <agentId>{从用户输入提取的 agentId}</agentId>
   ```
   这是最重要的，插件会优先使用这个值。

2. **默认使用异步模式**：
   ```xml
   <responseMode>async-callback</responseMode>
   ```
   除非用户明确说"同步"。

3. **异步模式需要 callback**：
   ```xml
   <callback>
     <channel>discord</channel>
     <to>{从当前会话的 deliveryContext 提取 Discord 用户 ID}</to>
   </callback>
   ```

   提取方法：
   - 检查当前会话的 deliveryContext
   - 如果 `channel === "discord"`，提取 `to` 字段
   - 格式应该是 `user:881734814204571708`

4. **同步模式不需要 callback**：
   ```xml
   <responseMode>sync-return</responseMode>
   ```

5. **上下文控制（可选）**：

   **默认配置**（不需要显式写出）：
   - includeMemory: true
   - includeRules: true
   - includeAgents: true
   - includeTools: false
   - includeArtifacts: false

   **最小上下文**（用户说"最小上下文"时）：
   ```xml
   <includeMemory>false</includeMemory>
   <includeRules>false</includeRules>
   <includeAgents>false</includeAgents>
   <includeTools>false</includeTools>
   <includeArtifacts>false</includeArtifacts>
   ```

   **完整上下文**（用户说"完整上下文"时）：
   ```xml
   <includeTools>true</includeTools>
   <includeArtifacts>true</includeArtifacts>
   ```

6. **sessionKey（可选）**：
   如果用户说"续接 xxx"，添加：
   ```xml
   <sessionKey>xxx</sessionKey>
   ```

### 第 3 步：调用 sessions_spawn

使用以下参数调用 `sessions_spawn` 工具：

```json
{
  "runtime": "acp",
  "mode": "run",
  "task": "[acp-handoff] <完整的 acp_request>"
}
```

**重要**：
- `task` 必须以 `[acp-handoff]` 开头
- 后面跟完整的 `<acp_request>` 结构
- **不需要**传递 `agentId` 参数（插件会从 XML 中提取）

### 第 4 步：返回确认

调用 `sessions_spawn` 后，立即返回确认消息：

- **异步模式**：`已触发 {agentId} agent 执行任务，结果将通过 Discord 推送。`
- **同步模式**：`已触发 {agentId} agent 执行任务，等待结果...`

然后**立即结束**，不要做任何其他操作：
- ❌ 不要轮询状态
- ❌ 不要等待结果
- ❌ 不要调用 `sessions_list` 或 `sessions_history`
- ❌ 不要调用 `sleep` 或 `process poll`

## 完整示例

### 示例 1：最简单（异步，默认配置）

**用户输入**：
```
使用 acpoff 让 clg 执行以下任务：

<task>
分析 src/protocol.ts 的类型定义
</task>
```

**你需要构建的 acp_request**：
```xml
<acp_request>
  <meta>
    <agentId>clg</agentId>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:881734814204571708</to>
    </callback>
  </meta>
  <cli_prompt>
分析 src/protocol.ts 的类型定义
  </cli_prompt>
</acp_request>
```

**调用 sessions_spawn**：
```json
{
  "runtime": "acp",
  "mode": "run",
  "task": "[acp-handoff] <acp_request>\n  <meta>\n    <agentId>clg</agentId>\n    <responseMode>async-callback</responseMode>\n    <callback>\n      <channel>discord</channel>\n      <to>user:881734814204571708</to>\n    </callback>\n  </meta>\n  <cli_prompt>\n分析 src/protocol.ts 的类型定义\n  </cli_prompt>\n</acp_request>"
}
```

**返回消息**：
```
已触发 clg agent 执行任务，结果将通过 Discord 推送。
```

### 示例 2：同步返回

**用户输入**：
```
使用 acpoff 让 clg 执行以下任务（同步返回）：

<task>
读取 src/protocol.ts 的前 50 行
</task>
```

**你需要构建的 acp_request**：
```xml
<acp_request>
  <meta>
    <agentId>clg</agentId>
    <responseMode>sync-return</responseMode>
  </meta>
  <cli_prompt>
读取 src/protocol.ts 的前 50 行
  </cli_prompt>
</acp_request>
```

**返回消息**：
```
已触发 clg agent 执行任务，等待结果...
```

### 示例 3：最小上下文

**用户输入**：
```
使用 acpoff 让 clg 执行以下任务（最小上下文）：

<task>
统计 src 目录下的 .ts 文件数量
</task>
```

**你需要构建的 acp_request**：
```xml
<acp_request>
  <meta>
    <agentId>clg</agentId>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:881734814204571708</to>
    </callback>
    <includeMemory>false</includeMemory>
    <includeRules>false</includeRules>
    <includeAgents>false</includeAgents>
    <includeTools>false</includeTools>
    <includeArtifacts>false</includeArtifacts>
  </meta>
  <cli_prompt>
统计 src 目录下的 .ts 文件数量
  </cli_prompt>
</acp_request>
```

### 示例 4：会话续接

**用户输入**：
```
使用 acpoff 让 clg 执行以下任务（续接 code-analysis）：

<task>
基于上次的分析，重点说明 ContextControl 的设计
</task>
```

**你需要构建的 acp_request**：
```xml
<acp_request>
  <meta>
    <agentId>clg</agentId>
    <sessionKey>code-analysis</sessionKey>
    <responseMode>async-callback</responseMode>
    <callback>
      <channel>discord</channel>
      <to>user:881734814204571708</to>
    </callback>
  </meta>
  <cli_prompt>
基于上次的分析，重点说明 ContextControl 的设计
  </cli_prompt>
</acp_request>
```

### 示例 5：组合选项

**用户输入**：
```
使用 acpoff 让 clg 执行以下任务（同步，最小上下文）：

<task>
列出所有 .md 文件
</task>
```

**你需要构建的 acp_request**：
```xml
<acp_request>
  <meta>
    <agentId>clg</agentId>
    <responseMode>sync-return</responseMode>
    <includeMemory>false</includeMemory>
    <includeRules>false</includeRules>
    <includeAgents>false</includeAgents>
    <includeTools>false</includeTools>
    <includeArtifacts>false</includeArtifacts>
  </meta>
  <cli_prompt>
列出所有 .md 文件
  </cli_prompt>
</acp_request>
```

## 约束和注意事项

### 必须遵守

1. **agentId 必须包含**：
   - 从用户输入提取的 agentId 必须放在 `<meta>` 的 `<agentId>` 标签中
   - 这是插件识别目标 agent 的最高优先级方式

2. **任务内容原样保留**：
   - `<task>` 标签内的内容原样复制到 `<cli_prompt>` 中
   - 不要改写、不要总结、不要添加任何内容

3. **task 必须以 [acp-handoff] 开头**：
   - 调用 `sessions_spawn` 时，`task` 参数必须以 `[acp-handoff]` 开头
   - 这是插件检测的标记

4. **立即返回**：
   - 调用 `sessions_spawn` 后立即返回确认消息
   - 不要等待、不要轮询、不要检查状态

### 错误处理

1. **缺少 <task> 标签**：
   - 返回错误：`错误：请使用 <task> 标签包裹任务内容。`
   - 给出正确格式示例

2. **无法提取 agentId**：
   - 返回错误：`错误：无法识别目标 agent，请使用格式"使用 acpoff 让 <agentId> 执行以下任务"`
   - 列出常用的 agentId：clg, clt, wolf, fox

3. **异步模式但无法提取 Discord ID**：
   - 返回错误：`错误：当前会话不在 Discord 渠道，请使用同步模式：（同步返回）`

### 不要做的事

1. ❌ 不要在 `sessions_spawn` 中传递 `agentId` 参数
2. ❌ 不要改写或总结任务内容
3. ❌ 不要等待子任务完成
4. ❌ 不要轮询状态或查看历史
5. ❌ 不要尝试读取生成的 payload 文件
6. ❌ 不要调用除 `sessions_spawn` 之外的其他工具

## 常见 agentId

| agentId | 说明 |
|---------|------|
| `clg` | Claude Code General - 通用任务 |
| `clt` | Claude Code - 代码相关任务 |
| `wolf` | Wolf - 复杂任务协调 |
| `fox` | Fox - 快速响应 |
| `copilot` | Copilot - 代码辅助 |

## 记忆要点

- **用户输入用 `<task>` 标签隔离任务内容**，避免你混淆控制指令和任务本体
- **agentId 必须放在 `<meta>` 的 `<agentId>` 标签中**，这是插件识别目标 agent 的关键
- **默认使用异步模式**，除非用户明确说"同步"
- **异步需要 callback，同步不需要**
- **调用 sessions_spawn 后立即返回**，不要做任何额外操作
