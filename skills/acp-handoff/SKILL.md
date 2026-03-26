---
name: acp-handoff
description: 当需要把当前 OpenClaw 父会话上下文交接给 ACP 外部 harness 时，由内部协议直接构建最终 prompt，不建议直接让用户手写
user-invocable: false
---

# ACP Handoff

当你要把当前父会话的上下文交接给 Claude Code、Codex 等 ACP harness 时，内部协议会在 `sessions_spawn` 上直接构建最终 `<handoff_payload>`。该 payload 由 `<handoff_context> / <handoff_task> / <execution_reminders>` 组成。触发标记优先使用 `[acp-handoff]`，同时兼容旧写法 `[[acp-handoff]]`。

插件会：

- 读取最近一次父会话 `llm_input` 快照
- 从父系统提示里的 Project Context 提取 bootstrap 内容
- 直接把 ACP 的 task 改写为最终 `<handoff_payload>` 提示词
- 可选地在工作区落一个 `.prompt.txt` 观测副本

## requested_task 约束

- `requested_task` 应视为用户明确交给 CLI 的任务主体
- 除非上游明确要求改写，否则不要改写其语义
- 不要把用户任务替换成“等待更多内容”“先去找别的文件”“把任务再包装成角色设定”
- handoff 的职责是补父上下文，不是重写用户意图

## 何时使用

- 你要把当前讨论的上下文延续给 `runtime: "acp"` 的外部 coding harness
- 子任务依赖当前系统提示、用户请求和最近对话历史
- 你准备开启一个较长的外部 coding session

## 推荐搭配

优先通过上层用户入口调用，例如 `acpoff`，由该入口统一生成底层 `sessions_spawn` 参数。

如果你在内部实现中需要直接触发底层协议，默认优先用一次性 run：

```json
{
  "task": "[acp-handoff] Continue the coding task using the handed-off parent context.",
  "runtime": "acp",
  "agentId": "claude",
  "mode": "run"
}
```

只有在明确需要持续会话时，再使用持久 ACP session：

```json
{
  "task": "[acp-handoff] Continue the coding task using the handed-off parent context.",
  "runtime": "acp",
  "agentId": "claude",
  "thread": true,
  "mode": "session"
}
```

## 何时不用

- 只是一次性独立任务
- 不需要继承当前父会话上下文
- 目标不是 ACP harness
