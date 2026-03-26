# cron-acp Skill 改造记录

## 版本历史

### v2.0.0 (2026-03-23)

**重大改造**：从简单的XML输出改为正确的sessions_spawn调用

#### 问题
旧版本的execute功能只是构造并输出`<acp_request>` XML，期望通过announce delivery传递到Discord，然后ACP从Discord接收。但这个流程是错误的：
- ❌ XML被直接announce到Discord
- ❌ ACP没有收到任何请求
- ❌ 任务实际上没有执行

#### 解决方案
修改execute功能，使用正确的acp-handoff插件机制：
1. ✅ 构造`<acp_request>` XML
2. ✅ 调用`sessions_spawn`工具，task参数包含`[acp-handoff]`标记
3. ✅ acp-handoff插件拦截并解析XML
4. ✅ 路由到ACP系统执行
5. ✅ ACP通过callback回调结果

#### 主要修改

**1. 目录结构（支持多agent）**
- 从固定路径 `~/.openclaw/workspace/cron/`
- 改为动态路径 `{workspace}/cron/`
  - main agent: `~/.openclaw/workspace/cron/`
  - 其他agent: `~/.openclaw/workspace-{agentId}/cron/`

**2. Agent概念区分**
- **OpenClaw agentId**：任务运行环境（如 `fox`, `main`, `koala`）
  - 决定workspace路径
  - 通过 `openclaw agents list` 查看
- **ACP agentId**：ACP系统内部标识符（如 `clg`, `clt`）
  - 在 `metadata.json` 中配置
  - 两者完全独立

**3. Execute功能核心改造**

**旧版本（错误）**：
```markdown
6. 构造 ACP 请求
7. 输出 XML
   - 输出会被 announce delivery 传递到渠道
   - ACP 从渠道接收并处理  ❌ 这不会发生
```

**新版本（正确）**：
```markdown
6. 构造 ACP 请求 XML
7. 调用 sessions_spawn 工具
   - task: "[acp-handoff] [cron-structured-request]\n\n<acp_request>..."
   - runtime: "acp"
   - agentId: "{从metadata.json}"
   - mode: "run"
8. 根据 responseMode 决定等待方式
   - async-callback: 立即返回
   - sync-return: 轮询直到完成
```

**4. 执行流程更新**

```
旧流程（错误）：
Cron → skill → 输出XML → announce → Discord → ❌ ACP收不到

新流程（正确）：
Cron → skill → 构造XML → sessions_spawn([acp-handoff])
  → acp-handoff插件拦截 → 解析XML → 路由到ACP
  → ACP执行 → callback回调结果
```

**5. 依赖工具新增**
- `sessions_spawn` - 派发ACP子任务（核心工具）
- `session_status` - 查询子任务状态（sync-return模式）

#### 文件变更

- `SKILL.md` - 完全重写（762行）
  - 新增OpenClaw agent支持
  - 修正execute功能的实现逻辑
  - 更新所有示例和说明
- `SKILL.md.backup-20260323-002106` - 旧版本备份（51行）

#### 技术细节

**acp-handoff插件触发机制**：
1. task参数必须包含 `[acp-handoff]` 标记
2. task参数必须包含 `[cron-structured-request]` 标记
3. task参数必须包含完整的 `<acp_request>` XML
4. XML必须包含 `<meta>` 和 `<cli_prompt>` 两个部分

**responseMode处理**：
- `async-callback`（推荐）：sessions_spawn返回后立即返回，结果异步回调
- `sync-return`：使用session_status轮询直到完成，返回最终结果

#### 参考文档
- OpenClaw文档：`docs/automation/cron-jobs.md`
- acp-handoff插件：`~/.openclaw/extensions/acp-handoff/`
- openclaw-runtime skill分析（第7节）

---

### v1.0.0 (2026-03-20)

初始版本，简单的XML输出实现（已废弃）

---

## 使用建议

1. **创建任务时**必须指定OpenClaw agentId
2. **metadata.json**中配置ACP agentId
3. **responseMode**推荐使用 `async-callback`
4. **callback.to**必须使用正确格式（`user:ID` 或 `channel:ID`）
5. 删除 `~/.openclaw/skills/cron-acp/` 避免加载旧版本

## 已知问题

无

## 待优化

- [ ] 添加更多错误处理场景
- [ ] 支持更多responseMode
- [ ] 添加任务执行历史查看功能
