import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { __testables } from "./index.ts";
import {
  renderConcretePrompt,
  resolveRenderedPromptArtifacts,
  writeRenderedPromptFile,
} from "./src/handoff-file.ts";
import { createSnapshot, createTranscriptFallbackSnapshot } from "./src/normalize.ts";

const tempDirs: string[] = [];
const PROJECT_CONTEXT_SYSTEM_PROMPT = [
  "OpenClaw system prompt header",
  "# Project Context",
  "## /workspace/IDENTITY.md",
  "You are Wolf.",
  "## /workspace/SOUL.md",
  "Speak with concise force.",
  "## /workspace/USER.md",
  "You help Xiaoha.",
  "## /workspace/RULES.md",
  "Protect correctness before speed.",
  "## /workspace/AGENTS.md",
  "Coordinate tasks in three steps.",
  "## /workspace/TOOLS.md",
  "Prefer read before edit.",
  "## /workspace/HEARTBEAT.md",
  "Stay proactive but calm.",
  "## /workspace/MEMORY.md",
  "Remember active project threads.",
  "## /workspace/BOOTSTRAP.md",
  "Bootstrap only when starting fresh.",
].join("\n");

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readLatestPromptDump(rootDir: string) {
  const handoffDir = path.join(rootDir, ".openclaw", "acp-handoff");
  const files = (await fs.readdir(handoffDir)).filter((entry) => entry.endsWith(".prompt.txt")).sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(`No prompt dump files found in ${handoffDir}`);
  }
  return fs.readFile(path.join(handoffDir, latest), "utf8");
}

async function readObservedPayloadMirror(rootDir: string) {
  return fs.readFile(
    path.join(rootDir, ".openclaw", "acp-handoff", "latest-observed-cli-payload.txt"),
    "utf8",
  );
}

async function readStructuredRequestMirror(rootDir: string) {
  return fs.readFile(
    path.join(rootDir, ".openclaw", "acp-handoff", "latest-observed-acp-request.xml"),
    "utf8",
  );
}

async function readCallbackMirror(rootDir: string) {
  const raw = await fs.readFile(
    path.join(rootDir, ".openclaw", "acp-handoff", "latest-resolved-callback.json"),
    "utf8",
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

async function listHandoffFiles(rootDir: string) {
  const handoffDir = path.join(rootDir, ".openclaw", "acp-handoff");
  try {
    return (await fs.readdir(handoffDir)).sort();
  } catch {
    return [];
  }
}

function createPluginApi(openClawRoot?: string) {
  const hooks: Record<string, Function[]> = {};
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    hooks,
    logger,
    api: {
      config: {
        acp: { defaultAgent: "copilot" },
        agents: {
          defaults: {},
          list: [],
        },
        bindings: [],
        channels: {
          discord: {
            accounts: {},
          },
        },
      },
      resolvePath(input: string) {
        if (input.startsWith("~/.openclaw") && openClawRoot) {
          return path.join(openClawRoot, input.slice("~/.openclaw".length));
        }
        if (input === "~" && openClawRoot) {
          return path.dirname(openClawRoot);
        }
        return path.isAbsolute(input) ? input : path.resolve(input);
      },
      logger,
      on(name: string, handler: Function) {
        hooks[name] ??= [];
        hooks[name].push(handler);
      },
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("acp-handoff prompt rendering", () => {
  it("renders the final context-plus-prompt payload directly from project context", async () => {
    const childWorkspace = await makeTempDir("acp-handoff-child-");

    const snapshot = createSnapshot({
      runId: "run-render",
      sessionId: "session-render",
      sessionKey: "agent:wolf:main",
      agentId: "wolf",
      workspaceDir: childWorkspace,
      provider: "demo",
      model: "demo-model",
      imagesCount: 0,
      systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
      prompt: [
        "solve the current task",
        "<reminder>",
        "<sql_tables>Available tables: todos, todo_deps</sql_tables>",
        "</reminder>",
        "<reminder>",
        "<todo_status>",
        "Todos: 1 in progress, 76 done (77 total)",
        "Use sql tool to query ready todos and update status as you work.",
        "</todo_status>",
        "</reminder>",
      ].join("\n"),
      historyMessages: [],
    });

    const prompt = renderConcretePrompt(
      snapshot,
      "continue the focused child task",
      resolveRenderedPromptArtifacts(snapshot),
    );
    await writeRenderedPromptFile({
      outputDir: childWorkspace,
      snapshot,
      prompt,
    });

    const promptDump = await readLatestPromptDump(childWorkspace);
    const observedMirror = await readObservedPayloadMirror(childWorkspace);
    expect(promptDump).toContain("<handoff_payload>");
    expect(promptDump).toContain("<handoff_context>");
    expect(promptDump).toContain("<agent_profile>");
    expect(promptDump).toContain("<identity>");
    expect(promptDump).toContain("You are Wolf.");
    expect(promptDump).toContain("<behavior_style>");
    expect(promptDump).toContain("Speak with concise force.");
    expect(promptDump).toContain("<operating_rules>");
    expect(promptDump).toContain("<rules>");
    expect(promptDump).toContain("Protect correctness before speed.");
    expect(promptDump).not.toContain("<HEARTBEAT>");
    expect(promptDump).not.toContain("<BOOTSTRAP>");
    expect(promptDump).toContain("<handoff_task>");
    expect(promptDump).toContain("<handoff_artifacts>");
    expect(promptDump).toContain("<exact_payload_file>");
    expect(promptDump).toContain(".openclaw/acp-handoff/");
    expect(promptDump).toContain(".prompt.txt");
    expect(promptDump).toContain("<latest_exact_payload_file>");
    expect(promptDump).toContain(".openclaw/acp-handoff/latest-observed-cli-payload.txt");
    expect(promptDump).toContain(
      "如果任务需要逐字保存、比对或转发当前收到的 payload，优先直接使用 <handoff_artifacts> 里的文件",
    );
    expect(promptDump).toContain("<guide>");
    expect(promptDump).toContain("你是 <identity> 定义的 Agent，按 <behavior_style> 的风格行事，服务对象是 <user_profile>。");
    expect(promptDump).toContain("<request>\ncontinue the focused child task\n</request>");
    expect(promptDump).not.toContain("<execution_reminders>");
    expect(promptDump).not.toContain("<sql_tables>");
    expect(promptDump).not.toContain("<todo_status>");
    expect(promptDump).not.toContain("<reminder>");
    expect(observedMirror).toBe(promptDump);
  });

  it("renders a minimal prompt when transcript fallback has no project context", () => {
    const snapshot = createTranscriptFallbackSnapshot({
      sessionKey: "agent:cow:main",
      workspaceDir: "/tmp/parent-from-transcript",
      agentId: "cow",
      requestedTask: "fallback task",
      transcriptMessages: [{ role: "user", content: [{ type: "text", text: "please continue" }] }],
    });

    const prompt = renderConcretePrompt(snapshot, "fallback task");
    expect(prompt).toContain("<handoff_context>");
    expect(prompt).toContain("</handoff_context>");
    expect(prompt).toContain("<handoff_task>");
    expect(prompt).toContain("<request>");
    expect(prompt).toContain("fallback task");
    expect(prompt).toContain("<identity>\n</identity>");
    expect(prompt).toContain("<behavior_style>\n</behavior_style>");
    expect(prompt).toContain("<user_profile>\n</user_profile>");
    expect(prompt).toContain("<rules>\n</rules>");
    expect(prompt).toContain("<workflow>\n</workflow>");
    expect(prompt).toContain("<tools>\n</tools>");
    expect(prompt).toContain("<memory>\n</memory>");
  });

  it("renders the requested task verbatim without adding extra explanation", () => {
    const snapshot = createSnapshot({
      runId: "run-introspection",
      sessionId: "session-introspection",
      sessionKey: "agent:wolf:main",
      agentId: "wolf",
      workspaceDir: "/tmp/wolf",
      provider: "demo",
      model: "demo-model",
      imagesCount: 0,
      systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
      prompt: "parent prompt",
      historyMessages: [],
    });

    const prompt = renderConcretePrompt(snapshot, "请把当前轮次收到的提示词写入文件中");
    expect(prompt).toContain("<request>\n请把当前轮次收到的提示词写入文件中\n</request>");
    expect(prompt).not.toContain("仅指你当前这条 user message 中可见的完整文本");
  });

  it("omits handoff artifacts when no prompt dump paths are supplied", () => {
    const snapshot = createSnapshot({
      runId: "run-no-artifacts",
      sessionId: "session-no-artifacts",
      sessionKey: "agent:wolf:main",
      agentId: "wolf",
      workspaceDir: "/tmp/wolf",
      provider: "demo",
      model: "demo-model",
      imagesCount: 0,
      systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
      prompt: "parent prompt",
      historyMessages: [],
    });

    const prompt = renderConcretePrompt(snapshot, "继续调查");
    expect(prompt).not.toContain("<handoff_artifacts>");
    expect(prompt).not.toContain("latest-observed-cli-payload.txt");
  });
});

describe("acp-handoff stalled ACP diagnostics", () => {
  it("reads acpx record summaries and resolves pid liveness", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const acpxRoot = path.join(homeRoot, ".acpx", "sessions");
    await fs.mkdir(openClawRoot, { recursive: true });
    await fs.mkdir(acpxRoot, { recursive: true });
    await fs.writeFile(
      path.join(acpxRoot, "record-1.json"),
      JSON.stringify(
        {
          pid: process.pid,
          closed: false,
          messages: [],
          updated_at: "2026-03-19T11:15:01.216Z",
          created_at: "2026-03-19T11:15:01.216Z",
          last_seq: 0,
          agent_command: "env CLAUDE_CODE_EXECUTABLE=/mock/clt npx -y @zed-industries/claude-agent-acp",
          acp_session_id: "1c08e5f6-e583-4028-a954-b3c119d66e3a",
          cwd: "/Users/example/workspace-fox",
          last_agent_exit_at: "2026-03-19T12:41:23.974Z",
          last_agent_exit_code: 1,
          last_agent_disconnect_reason: "connection_close",
        },
        null,
        2,
      ),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const summary = await __testables.resolveAcpRecordSummary(api as never, "record-1");

    expect(summary).toEqual(
      expect.objectContaining({
        exists: true,
        pid: process.pid,
        pidAlive: true,
        closed: false,
        messageCount: 0,
        lastSeq: 0,
        acpSessionId: "1c08e5f6-e583-4028-a954-b3c119d66e3a",
        cwd: "/Users/example/workspace-fox",
        lastAgentExitAt: "2026-03-19T12:41:23.974Z",
        lastAgentExitCode: 1,
        lastAgentDisconnectReason: "connection_close",
      }),
    );
    expect(summary?.agentCommand).toContain("CLAUDE_CODE_EXECUTABLE=/mock/clt");
  });

  it("reads Claude Code API errors from local session logs", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const claudeProjectDir = path.join(
      homeRoot,
      ".claude",
      "projects",
      "-Users-example--openclaw-workspace-fox",
    );
    await fs.mkdir(openClawRoot, { recursive: true });
    await fs.mkdir(claudeProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeProjectDir, "1c08e5f6-e583-4028-a954-b3c119d66e3a.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          isApiErrorMessage: true,
          message: {
            content: [
              {
                type: "text",
                text: "API Error: 502 <html>\n<head><title>502 Bad Gateway</title></head>\n<body><center><h1>502 Bad Gateway</h1></center></body>\n</html>\n",
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const summary = await __testables.resolveClaudeCodeSessionApiError(
      api as never,
      "1c08e5f6-e583-4028-a954-b3c119d66e3a",
      "/Users/example/.openclaw/workspace-fox",
    );

    expect(summary).toBe("Claude Code 会话失败：API Error 502（上游服务或网络异常）：Bad Gateway");
  });

  it("classifies common Claude Code API failures", () => {
    expect(
      __testables.summarizeClaudeApiError('API Error: 402 {"error":"Insufficient credits"}'),
    ).toBe("Claude Code 会话失败：API Error 402（余额、计费或配额不足）：Insufficient credits");

    expect(
      __testables.summarizeClaudeApiError(
        'API Error: 403 {"error":{"code":"","message":"用户已被封禁","type":"aix_api_error"}} · Please run /login',
      ),
    ).toBe("Claude Code 会话失败：API Error 403（认证或权限问题）：用户已被封禁 · Please run /login");

    expect(
      __testables.summarizeClaudeApiError(
        'API Error: 429 {"error":{"code":"1311","message":"当前订阅套餐暂未开放GLM-5权限"},"request_id":"req"}',
      ),
    ).toBe("Claude Code 会话失败：API Error 429（限流、套餐权限或配额问题）：当前订阅套餐暂未开放GLM-5权限");

    expect(
      __testables.summarizeClaudeApiError(
        'API Error: 503 {"error":{"code":"model_not_found","message":"分组 cheng 下模型 glm-4.7 无可用渠道（distributor）","type":"new_api_error"}}',
      ),
    ).toBe(
      "Claude Code 会话失败：API Error 503（模型、资源或渠道不可用）：分组 cheng 下模型 glm-4.7 无可用渠道（distributor）",
    );
  });

  it("reads Claude tool errors and assistant context from local session logs", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const claudeProjectDir = path.join(
      homeRoot,
      ".claude",
      "projects",
      "-Users-example--openclaw-workspace-fox",
    );
    await fs.mkdir(openClawRoot, { recursive: true });
    await fs.mkdir(claudeProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeProjectDir, "1c146abe-418b-4d62-a381-f2f7c3bf747d.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                is_error: true,
                content: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
              },
            ],
          },
          toolUseResult: "Error: File has not been read yet. Read it first before writing to it.",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "无法写入：工具要求的前置条件未满足。",
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const summary = await __testables.resolveClaudeCodeSessionTerminalState(
      api as never,
      "1c146abe-418b-4d62-a381-f2f7c3bf747d",
      "/Users/example/.openclaw/workspace-fox",
    );

    expect(summary).toEqual(
      expect.objectContaining({
        kind: "tool_error",
      }),
    );
    expect(summary?.text).toContain("文件读写规则问题");
    expect(summary?.text).toContain("File has not been read yet. Read it first before writing to it.");
    expect(summary?.text).toContain("前置条件未满足");
  });

  it("classifies Claude confirmation replies as waiting for user input", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const claudeProjectDir = path.join(
      homeRoot,
      ".claude",
      "projects",
      "-Users-example--openclaw-workspace-fox",
    );
    await fs.mkdir(openClawRoot, { recursive: true });
    await fs.mkdir(claudeProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeProjectDir, "claude-needs-input.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                is_error: true,
                content: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
              },
            ],
          },
          toolUseResult: "Error: File has not been read yet. Read it first before writing to it.",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [
              {
                type: "text",
                text: "请确认是否继续？",
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const summary = await __testables.resolveClaudeCodeSessionTerminalState(
      api as never,
      "claude-needs-input",
      "/Users/example/.openclaw/workspace-fox",
    );

    expect(summary).toEqual(
      expect.objectContaining({
        kind: "needs_user_input",
      }),
    );
    expect(summary?.text).toContain("等待用户输入");
    expect(summary?.text).toContain("请确认是否继续");
    expect(summary?.text).toContain("File has not been read yet");
  });

  it("prefers the latest successful assistant reply over older tool errors", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const claudeProjectDir = path.join(
      homeRoot,
      ".claude",
      "projects",
      "-Users-example--openclaw-workspace-fox",
    );
    await fs.mkdir(openClawRoot, { recursive: true });
    await fs.mkdir(claudeProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeProjectDir, "success-after-error.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                is_error: true,
                content: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
              },
            ],
          },
          toolUseResult: "Error: File has not been read yet. Read it first before writing to it.",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "done",
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const summary = await __testables.resolveClaudeCodeSessionTerminalState(
      api as never,
      "success-after-error",
      "/Users/example/.openclaw/workspace-fox",
    );

    expect(summary).toEqual(
      expect.objectContaining({
        kind: "assistant_final",
        text: "done",
      }),
    );
  });

  it("reads Copilot session errors from local session state", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const copilotSessionDir = path.join(
      homeRoot,
      ".copilot",
      "session-state",
      "52c0ef93-d803-444e-add7-8e4c161a1e66",
    );
    await fs.mkdir(openClawRoot, { recursive: true });
    await fs.mkdir(copilotSessionDir, { recursive: true });
    await fs.writeFile(
      path.join(copilotSessionDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "session.error",
          data: {
            errorType: "query",
            message:
              'Execution failed: CAPIError: 400 model "gpt-5.4" is not accessible via the /chat/completions endpoint',
            statusCode: 400,
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const summary = await __testables.resolveCopilotSessionTerminalState(
      api as never,
      "52c0ef93-d803-444e-add7-8e4c161a1e66",
    );

    expect(summary).toEqual(
      expect.objectContaining({
        kind: "api_error",
        runtimeLabel: "Copilot",
        text: 'Copilot 会话失败：API Error 400（模型、资源或渠道不可用）：model "gpt-5.4" is not accessible via the /chat/completions endpoint',
      }),
    );
  });

  it("reads Copilot tool errors and assistant context from local session state", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const copilotSessionDir = path.join(
      homeRoot,
      ".copilot",
      "session-state",
      "f764a077-30e0-4d00-80c9-c1b7e1fea4e3",
    );
    await fs.mkdir(openClawRoot, { recursive: true });
    await fs.mkdir(copilotSessionDir, { recursive: true });
    await fs.writeFile(
      path.join(copilotSessionDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "tool.execution_complete",
          data: {
            success: false,
            error: {
              message: "Path does not exist",
            },
          },
        }),
        JSON.stringify({
          type: "assistant.message",
          data: {
            content: "我现在无法继续，因为路径不存在。",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const summary = await __testables.resolveCopilotSessionTerminalState(
      api as never,
      "f764a077-30e0-4d00-80c9-c1b7e1fea4e3",
    );

    expect(summary).toEqual(
      expect.objectContaining({
        kind: "tool_error",
        runtimeLabel: "Copilot",
      }),
    );
    expect(summary?.text).toContain("路径或文件不存在");
    expect(summary?.text).toContain("Path does not exist");
    expect(summary?.text).toContain("我现在无法继续");
  });

  it("prefers the latest successful Copilot assistant reply over older tool errors", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const copilotSessionDir = path.join(
      homeRoot,
      ".copilot",
      "session-state",
      "copilot-success-after-error",
    );
    await fs.mkdir(openClawRoot, { recursive: true });
    await fs.mkdir(copilotSessionDir, { recursive: true });
    await fs.writeFile(
      path.join(copilotSessionDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "tool.execution_complete",
          data: {
            success: false,
            error: {
              message: "Path does not exist",
            },
          },
        }),
        JSON.stringify({
          type: "assistant.message",
          data: {
            content: "已保存到 /tmp/output.txt",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const summary = await __testables.resolveCopilotSessionTerminalState(
      api as never,
      "copilot-success-after-error",
    );

    expect(summary).toEqual(
      expect.objectContaining({
        kind: "assistant_final",
        runtimeLabel: "Copilot",
        text: "已保存到 /tmp/output.txt",
      }),
    );
  });

  it("classifies Copilot confirmation replies as waiting for user input", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const copilotSessionDir = path.join(
      homeRoot,
      ".copilot",
      "session-state",
      "copilot-needs-input",
    );
    await fs.mkdir(openClawRoot, { recursive: true });
    await fs.mkdir(copilotSessionDir, { recursive: true });
    await fs.writeFile(
      path.join(copilotSessionDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "tool.execution_complete",
          data: {
            success: false,
            error: {
              message: "Path does not exist",
            },
          },
        }),
        JSON.stringify({
          type: "assistant.turn_start",
          data: {
            turnId: "1",
          },
        }),
        JSON.stringify({
          type: "assistant.message",
          data: {
            content: "请确认是否继续？",
          },
        }),
        JSON.stringify({
          type: "assistant.turn_end",
          data: {
            turnId: "1",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const summary = await __testables.resolveCopilotSessionTerminalState(
      api as never,
      "copilot-needs-input",
    );

    expect(summary).toEqual(
      expect.objectContaining({
        kind: "needs_user_input",
        runtimeLabel: "Copilot",
      }),
    );
    expect(summary?.text).toContain("等待用户输入");
    expect(summary?.text).toContain("请确认是否继续");
    expect(summary?.text).toContain("Path does not exist");
  });

  it("uses local Claude fallback states when transcript never materializes", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const acpxRoot = path.join(homeRoot, ".acpx", "sessions");
    const cltSessionsDir = path.join(openClawRoot, "agents", "clt", "sessions");
    const claudeProjectDir = path.join(
      homeRoot,
      ".claude",
      "projects",
      "-Users-example--openclaw-workspace-fox",
    );
    await fs.mkdir(acpxRoot, { recursive: true });
    await fs.mkdir(cltSessionsDir, { recursive: true });
    await fs.mkdir(claudeProjectDir, { recursive: true });

    await fs.writeFile(
      path.join(cltSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:clt:acp:test-final-text": {
            sessionId: "missing-openclaw-session",
            updatedAt: 1773920190596,
            acp: {
              backend: "acpx",
              agent: "clt",
              identity: {
                acpxRecordId: "record-final",
                acpxSessionId: "record-final",
              },
              state: "running",
            },
          },
          "agent:clt:acp:test-tool-error": {
            sessionId: "missing-openclaw-session",
            updatedAt: 1773920190596,
            acp: {
              backend: "acpx",
              agent: "clt",
              identity: {
                acpxRecordId: "record-tool",
                acpxSessionId: "record-tool",
              },
              state: "running",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(acpxRoot, "record-final.stream.ndjson"),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "final-session",
          prompt: [{ type: "text", text: "demo" }],
        },
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(acpxRoot, "record-tool.stream.ndjson"),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "tool-session",
          prompt: [{ type: "text", text: "demo" }],
        },
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(acpxRoot, "record-final.json"),
      JSON.stringify(
        {
          pid: process.pid,
          closed: false,
          messages: [],
          updated_at: "2026-03-19T11:15:01.216Z",
          created_at: "2026-03-19T11:15:01.216Z",
          last_seq: 8,
          acp_session_id: "final-session",
          cwd: "/Users/example/.openclaw/workspace-fox",
          last_agent_exit_at: "2026-03-19T12:41:23.974Z",
          last_agent_disconnect_reason: "connection_close",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(acpxRoot, "record-tool.json"),
      JSON.stringify(
        {
          pid: process.pid,
          closed: false,
          messages: [],
          updated_at: "2026-03-19T11:15:01.216Z",
          created_at: "2026-03-19T11:15:01.216Z",
          last_seq: 8,
          acp_session_id: "tool-session",
          cwd: "/Users/example/.openclaw/workspace-fox",
          last_agent_exit_at: "2026-03-19T12:41:23.974Z",
          last_agent_disconnect_reason: "connection_close",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(claudeProjectDir, "final-session.jsonl"),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "done",
            },
          ],
        },
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(claudeProjectDir, "tool-session.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                is_error: true,
                content: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
              },
            ],
          },
          toolUseResult: "Error: File has not been read yet. Read it first before writing to it.",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "根据我的 CLAUDE.md 指引，写文件前需要先获得用户确认。\n\n请确认是否继续？",
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);

    const finalResult = await __testables.waitForChildSessionCompletion(
      "agent:clt:acp:test-final-text",
      api as never,
      500,
      10,
      500,
    );
    expect(finalResult).toEqual(
      expect.objectContaining({
        completed: true,
        text: "done",
      }),
    );

    const toolResult = await __testables.waitForChildSessionCompletion(
      "agent:clt:acp:test-tool-error",
      api as never,
      500,
      10,
      500,
    );
    expect(toolResult).toEqual(
      expect.objectContaining({
        completed: true,
        state: "needs_user_input",
      }),
    );
    expect(toolResult.text).toContain("等待用户输入");
    expect(toolResult.text).toContain("请确认是否继续");
  });

  it("reads acpx stream lock summaries and resolves queue-owner liveness", async () => {
    const homeRoot = await makeTempDir("acp-handoff-home-");
    const openClawRoot = path.join(homeRoot, ".openclaw");
    const acpxRoot = path.join(homeRoot, ".acpx", "sessions");
    await fs.mkdir(openClawRoot, { recursive: true });
    await fs.mkdir(acpxRoot, { recursive: true });
    await fs.writeFile(
      path.join(acpxRoot, "record-1.stream.lock"),
      JSON.stringify(
        {
          pid: process.pid,
          created_at: "2026-03-19T11:36:30.862Z",
        },
        null,
        2,
      ),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const summary = await __testables.resolveAcpEventLockSummary(api as never, "record-1");

    expect(summary).toEqual(
      expect.objectContaining({
        exists: true,
        pid: process.pid,
        pidAlive: true,
        createdAt: "2026-03-19T11:36:30.862Z",
      }),
    );
  });

  it("does not treat live queue-owner sessions as dead backends", () => {
    const diagnostic = __testables.describeAcpStalledSession({
      resolved: {
        sessionFile: "/tmp/missing-child.jsonl",
        exists: false,
        registryState: "running",
      },
      streamProgress: {
        promptSent: false,
        completed: false,
        text: "",
        backendSessionCreated: false,
      },
      recordSummary: {
        exists: true,
        pid: 92106,
        pidAlive: false,
        closed: false,
        messageCount: 0,
      },
      eventLockSummary: {
        exists: true,
        pid: process.pid,
        pidAlive: true,
      },
    });

    expect(diagnostic).toBeNull();
  });

  it("flags dead acpx backends that never sent a prompt", () => {
    const diagnostic = __testables.describeAcpStalledSession({
      resolved: {
        sessionFile: "/tmp/missing-child.jsonl",
        exists: false,
        registryState: "running",
      },
      streamProgress: {
        promptSent: false,
        completed: false,
        text: "",
        backendSessionCreated: false,
      },
      recordSummary: {
        exists: true,
        pid: 92106,
        pidAlive: false,
        closed: false,
        messageCount: 0,
      },
    });

    expect(diagnostic).toContain("ACP 会话疑似卡死");
    expect(diagnostic).toContain("pid 92106 已不存在");
    expect(diagnostic).toContain("registry 仍显示 running");
  });
});

describe("acp-handoff plugin hooks", () => {
  it("rewrites ACP spawn tasks and writes only the prompt dump into the child workspace", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    expect(llmInput).toBeTypeOf("function");
    expect(beforeToolCall).toBeTypeOf("function");

    await llmInput(
      {
        runId: "run-hook",
        sessionId: "session-hook",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: "parent prompt",
        historyMessages: [{ role: "user", content: [{ type: "text", text: "hello from parent" }] }],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-hook",
        runId: "run-hook",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-hook",
        params: {
          runtime: "acp",
          agentId: "claude",
          cwd: childWorkspace,
          task: "[[acp-handoff]] continue from parent",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-hook",
        sessionId: "session-hook",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.block).not.toBe(true);
    expect(result?.params?.agentId).toBe("claude");
    expect(result?.params?.task).toContain("<handoff_payload>");
    expect(result?.params?.task).toContain("<identity>");
    expect(result?.params?.task).toContain("You are Wolf.");
    expect(result?.params?.task).not.toContain("<HEARTBEAT>");
    expect(result?.params?.task).not.toContain("<BOOTSTRAP>");
    expect(result?.params?.task).toContain("<handoff_task>");
    expect(result?.params?.task).toContain("<request>\ncontinue from parent\n</request>");
    expect(result?.params?.task).not.toContain("Read the XML handoff file");
    expect(result?.params?.task).not.toContain("<execution_reminders>");
    expect(result?.params?.task).not.toContain("<sql_tables>");
    expect(result?.params?.task).not.toContain("<todo_status>");

    const promptDump = await readLatestPromptDump(childWorkspace);
    const observedMirror = await readObservedPayloadMirror(childWorkspace);
    expect(promptDump).toBe(result?.params?.task);
    expect(observedMirror).toBe(result?.params?.task);
    expect(await listHandoffFiles(childWorkspace)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.prompt\.txt$/)]),
    );
    expect(await listHandoffFiles(childWorkspace)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.xml$/)]),
    );
  });

  it("extracts only the acpoff task body from the parent user's visible utterance", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-exact-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-exact-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-exact",
        sessionId: "session-exact",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: [
          'Conversation info (untrusted metadata):\n```json\n{"message_id":"m1","sender_id":"u1"}\n```',
          "",
          "使用acpoff，创建子任务，让它把当前轮次收到的提示词写入文件中",
          "",
          "<reminder>",
          "<sql_tables>Available tables: todos, todo_deps</sql_tables>",
          "</reminder>",
          "<reminder>",
          "<todo_status>",
          "Todos: 1 in progress, 76 done (77 total)",
          "Use sql tool to query ready todos and update status as you work.",
          "</todo_status>",
          "</reminder>",
        ].join("\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-exact",
        runId: "run-exact",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-exact",
        params: {
          runtime: "acp",
          agentId: "claude",
          cwd: childWorkspace,
          task: "[acp-handoff] 请把你收到的提示词原样写入文件并回传路径",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-exact",
        sessionId: "session-exact",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.params?.task).toContain("<request>\n把当前轮次收到的提示词写入文件中\n</request>");
    expect(result?.params?.task).not.toContain("使用acpoff，创建子任务");
    expect(result?.params?.task).not.toContain("请把你收到的提示词原样写入文件并回传路径");
    expect(result?.params?.task).not.toContain("<reminder>");
    expect(result?.params?.task).not.toContain("<sql_tables>");
    expect(result?.params?.task).not.toContain("<todo_status>");
  });

  it("keeps the embedded child prompt clean when the parent acpoff request wraps it in outer instructions", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-embedded-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-embedded-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const embeddedPrompt = [
      "把当前轮次收到的提示词写入文件中，其存下的内容要与其输入一模一样，要完整的提示词，只要收到的就都保存(包括系统提示词，不要有任何遗漏)",
      "",
      "要求输出格式：",
      "1. 你当前所处环境",
      "2. 你是什么模型",
      "3. 完成的输入的提示词，不要有任何变化，输入什么格式，什么样子就什么样子，禁止修改格式，比如xml、markdown等等都保持与输入完全一致，禁止修改！！！",
      "",
      "你自己来决定这个名称和路径",
    ].join("\n");

    await llmInput(
      {
        runId: "run-embedded",
        sessionId: "session-embedded",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: [
          "System: [2026-03-19 16:55:31 GMT+8] Node: MBP-KXNDC7MGH0-0042 (172.29.128.31) · app 2026.3.13 (2026031390) · mode local",
          "",
          "使用acpoff，调用clt 命令，创建子任务。",
          "",
          "具体给子任务的完整提示词如下，这个提示词需要完整的给到它",
          "",
          "```",
          "",
          embeddedPrompt,
          "",
          "```",
        ].join("\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-embedded",
        runId: "run-embedded",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-embedded",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: `[acp-handoff] ${embeddedPrompt}`,
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-embedded",
        sessionId: "session-embedded",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.params?.agentId).toBe("clt");
    expect(result?.params?.task).toContain(`<request>\n${embeddedPrompt}\n</request>`);
    expect(result?.params?.task).not.toContain("使用acpoff，调用clt 命令，创建子任务");
    expect(result?.params?.task).not.toContain("具体给子任务的完整提示词如下");
    expect(result?.params?.task).not.toContain("System: [2026-03-19 16:55:31 GMT+8]");
  });

  it("parses structured cron requests from the parent prompt and forwards only the clean task", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-structured-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-structured-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>claude</agentId>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <task><![CDATA[structured child task]]></task>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-structured",
        sessionId: "session-structured",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-structured",
        runId: "run-structured",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-structured",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-structured",
        sessionId: "session-structured",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.block).not.toBe(true);
    expect(result?.params?.agentId).toBe("claude");
    expect(result?.params?.task).toContain("<request>\nstructured child task\n</request>");
    expect(result?.params?.task).not.toContain("<acp_request");
    expect(await readStructuredRequestMirror(childWorkspace)).toBe(envelope);
  });

  it("blocks malformed structured cron requests before spawning ACP", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-bad-structured-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-bad-structured-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-bad-structured",
        sessionId: "session-bad-structured",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: [
          "[cron-acp]",
          "",
          '<acp_request version="1">',
          "  <meta>",
          "    <agentId>claude</agentId>",
          "  </meta>",
          "</acp_request>",
        ].join("\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-bad-structured",
        runId: "run-bad-structured",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-bad-structured",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-bad-structured",
        sessionId: "session-bad-structured",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("requires a <cli_prompt> (or <task>) block");
  });

  it("preserves an explicit non-legacy ACP child agent selection", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-explicit-agent-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-explicit-agent-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-explicit-agent",
        sessionId: "session-explicit-agent",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: "使用acpoff，把任务交给 gemini 子会话继续处理",
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-explicit-agent",
        runId: "run-explicit-agent",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-explicit-agent",
        params: {
          runtime: "acp",
          agentId: "gemini",
          cwd: childWorkspace,
          task: "[acp-handoff] continue with explicit gemini child",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-explicit-agent",
        sessionId: "session-explicit-agent",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.params?.agentId).toBe("gemini");
  });

  it("uses the launcher explicitly requested in the visible acpoff prompt", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-launcher-request-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-launcher-request-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-launcher-request",
        sessionId: "session-launcher-request",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: [
          "使用acpoff，调用claude 命令，创建子任务。",
          "",
          "把当前轮次收到的提示词写入文件中。",
        ].join("\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-launcher-request",
        runId: "run-launcher-request",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-launcher-request",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] 请处理这个任务",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-launcher-request",
        sessionId: "session-launcher-request",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.params?.agentId).toBe("claude");
    expect(result?.params?.task).toContain("<request>\n把当前轮次收到的提示词写入文件中。\n</request>");
    expect(result?.params?.task).not.toContain("调用claude 命令");
  });

  it("preserves Claude-family launcher wrappers so runtime-specific env can be injected", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-custom-launcher-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-custom-launcher-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-custom-launcher",
        sessionId: "session-custom-launcher",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: [
          "使用acpoff，调用clmini 命令，创建子任务。",
          "",
          "继续处理当前任务。",
        ].join("\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-custom-launcher",
        runId: "run-custom-launcher",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-custom-launcher",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] continue with custom launcher",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-custom-launcher",
        sessionId: "session-custom-launcher",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.params?.agentId).toBe("clmini");
    expect(result?.params?.task).toContain("<request>\n继续处理当前任务。\n</request>");
    expect(result?.params?.task).not.toContain("调用clmini 命令");
  });

  it("strips cop launcher phrasing and child-wrapper prose from the visible prompt", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-cop-wrapper-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-cop-wrapper-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-cop-wrapper",
        sessionId: "session-cop-wrapper",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: [
          "使用acpoff，调用cop 命令，创建子任务。",
          "",
          "要求这个子任务(与你无关了)：把当前轮次收到的提示词写入文件中，其存下的内容要与其输入一模一样。",
        ].join("\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-cop-wrapper",
        runId: "run-cop-wrapper",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-cop-wrapper",
        params: {
          runtime: "acp",
          agentId: "claude",
          cwd: childWorkspace,
          task: "[acp-handoff] 请处理这个任务",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-cop-wrapper",
        sessionId: "session-cop-wrapper",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.params?.agentId).toBe("copilot");
    expect(result?.params?.task).toContain(
      "<request>\n把当前轮次收到的提示词写入文件中，其存下的内容要与其输入一模一样。\n</request>",
    );
    expect(result?.params?.task).not.toContain("调用cop 命令");
    expect(result?.params?.task).not.toContain("创建子任务");
    expect(result?.params?.task).not.toContain("要求这个子任务");
    expect(result?.params?.task).not.toContain("请处理这个任务");
  });

  it("accepts the single-bracket handoff signal", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-single-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-single-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-single",
        sessionId: "session-single",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: "parent prompt",
        historyMessages: [{ role: "user", content: [{ type: "text", text: "hello from parent" }] }],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-single",
        runId: "run-single",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-single",
        params: {
          runtime: "acp",
          agentId: "claude",
          cwd: childWorkspace,
          task: "[acp-handoff] continue with single bracket",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-single",
        sessionId: "session-single",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.block).not.toBe(true);
    expect(result?.params?.task).toContain("continue with single bracket");

    const promptDump = await readLatestPromptDump(childWorkspace);
    expect(promptDump).toContain("continue with single bracket");
  });

  it("accepts the acpoff signal alias and rewrites to the concrete handoff payload", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-acpoff-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-acpoff-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-acpoff",
        sessionId: "session-acpoff",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: "parent prompt",
        historyMessages: [{ role: "user", content: [{ type: "text", text: "hello from parent" }] }],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-acpoff",
        runId: "run-acpoff",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-acpoff",
        params: {
          runtime: "acp",
          agentId: "claude",
          cwd: childWorkspace,
          mode: "run",
          task: "[acpoff] continue through alias",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-acpoff",
        sessionKey: "agent:wolf:main",
        sessionId: "session-acpoff",
        agentId: "wolf",
      },
    );

    expect(result?.params?.task).toContain("<handoff_payload>");
    expect(result?.params?.task).toContain("<request>\ncontinue through alias\n</request>");
    expect(result?.params?.task).not.toContain("[acpoff]");
  });

  it("accepts the acp-off alias and rewrites to the concrete handoff payload", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-acp-off-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-acp-off-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-acp-off",
        sessionId: "session-acp-off",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: "parent prompt",
        historyMessages: [{ role: "user", content: [{ type: "text", text: "hello from parent" }] }],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-acp-off",
        runId: "run-acp-off",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-acp-off",
        params: {
          runtime: "acp",
          agentId: "claude",
          cwd: childWorkspace,
          mode: "run",
          task: "[acp-off] continue through hyphen alias",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-acp-off",
        sessionKey: "agent:wolf:main",
        sessionId: "session-acp-off",
        agentId: "wolf",
      },
    );

    expect(result?.params?.task).toContain("<handoff_payload>");
    expect(result?.params?.task).toContain("<request>\ncontinue through hyphen alias\n</request>");
    expect(result?.params?.task).not.toContain("[acp-off]");
  });

  it("infers acpoff handoff rewriting from the parent prompt even when the spawn task forgot the marker", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-acpoff-infer-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-acpoff-infer-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const embeddedPrompt = [
      "把当前轮次收到的提示词写入文件中，其存下的内容要与其输入一模一样，要完整的提示词，只要收到的就都保存(包括系统提示词，不要有任何遗漏)",
      "",
      "要求输出格式：",
      "1. 你当前所处环境",
      "2. 你是什么模型",
      "3. 完成的输入的提示词，不要有任何变化，输入什么格式，什么样子就什么样子，禁止修改格式，比如xml、markdown等等都保持与输入完全一致，禁止修改！！！",
      "",
      "你自己来决定这个名称和路径",
    ].join("\n");

    await llmInput(
      {
        runId: "run-acpoff-infer",
        sessionId: "session-acpoff-infer",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: [
          'Conversation info (untrusted metadata):\n```json\n{"message_id":"m2","sender_id":"u2"}\n```',
          "",
          "使用acpoff，调用clt命令，传入如下提示词",
          "",
          "```",
          "",
          embeddedPrompt,
          "",
          "```",
        ].join("\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-acpoff-infer",
        runId: "run-acpoff-infer",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-acpoff-infer",
        params: {
          runtime: "acp",
          agentId: "clt",
          cwd: childWorkspace,
          task: embeddedPrompt,
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-acpoff-infer",
        sessionId: "session-acpoff-infer",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.block).not.toBe(true);
    expect(result?.params?.agentId).toBe("clt");
    expect(result?.params?.task).toContain("<handoff_payload>");
    expect(result?.params?.task).toContain("把当前轮次收到的提示词写入文件中");
    expect(result?.params?.task).not.toContain("使用acpoff，调用clt命令");
  });

  it("coerces subagent runtime back to acp when the parent explicitly requested acpoff", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-acpoff-subagent-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-acpoff-subagent-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-acpoff-subagent",
        sessionId: "session-acpoff-subagent",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: "使用acpoff，调用cop命令，传入如下提示词\n\n概括你收到的提示词，以及你的环境，模型，角色是什么",
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-acpoff-subagent",
        runId: "run-acpoff-subagent",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-acpoff-subagent",
        params: {
          runtime: "subagent",
          mode: "run",
          cwd: childWorkspace,
          task: "概括你收到的提示词，以及你的环境，模型，角色是什么",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-acpoff-subagent",
        sessionId: "session-acpoff-subagent",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.block).not.toBe(true);
    expect(result?.params?.runtime).toBe("acp");
    expect(result?.params?.agentId).toBe("copilot");
    expect(result?.params?.task).toContain("<handoff_payload>");
    expect(result?.params?.task).toContain("概括你收到的提示词，以及你的环境，模型，角色是什么");
    expect(result?.params?.task).toContain(".openclaw/acp-handoff/latest-observed-cli-payload.txt");
  });

  it("prefers the parent agent workspace as cwd when no explicit cwd is provided", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-hook-parent-cwd-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-child-cwd-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [
      { id: "wolf", workspace: parentWorkspace },
      { id: "claude", workspace: childWorkspace },
    ];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-child-cwd",
        sessionId: "session-child-cwd",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: "parent prompt",
        historyMessages: [{ role: "user", content: [{ type: "text", text: "hello from parent" }] }],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-child-cwd",
        runId: "run-child-cwd",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-child-cwd",
        params: {
          runtime: "acp",
          agentId: "claude",
          mode: "run",
          task: "[acp-handoff] continue in child workspace",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-child-cwd",
        sessionKey: "agent:wolf:main",
        sessionId: "session-child-cwd",
        agentId: "wolf",
        workspaceDir: parentWorkspace,
      },
    );

    expect(result?.params?.cwd).toBe(parentWorkspace);

    const promptDump = await readLatestPromptDump(parentWorkspace);
    expect(promptDump).toContain("continue in child workspace");
  });

  it("falls back to transcript snapshots without pretending a system prompt exists", async () => {
    const fakeHome = await makeTempDir("acp-handoff-home-");
    const childWorkspace = await makeTempDir("acp-handoff-hook-fallback-");
    const transcriptDir = path.join(fakeHome, ".openclaw", "agents", "cow", "sessions");
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(
      path.join(transcriptDir, "session-fallback.jsonl"),
      [
        JSON.stringify({ type: "session", cwd: "/tmp/transcript-parent-workspace" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "history from transcript" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    const { api, hooks } = createPluginApi();
    await plugin.register(api as never);
    const beforeToolCall = hooks.before_tool_call?.[0];
    expect(beforeToolCall).toBeTypeOf("function");

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-no-cache",
        params: {
          runtime: "acp",
          agentId: "claude",
          cwd: childWorkspace,
          task: "[[acp-handoff]] fallback task",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-no-cache",
        sessionId: "session-fallback",
        sessionKey: "agent:cow:main",
        agentId: "cow",
      },
    );

    expect(result?.block).not.toBe(true);

    const promptDump = await readLatestPromptDump(childWorkspace);
    expect(promptDump).toContain("<handoff_context>");
    expect(promptDump).toContain("<request>");
    expect(promptDump).toContain("fallback task");
    expect(promptDump).toContain("<identity>\n</identity>");
    expect(promptDump).toContain("<rules>\n</rules>");
  });

  it("uses session registries plus prompt metadata to reply to Discord after ACP completion", async () => {
    const fakeHome = await makeTempDir("acp-handoff-discord-home-");
    const openClawRoot = path.join(fakeHome, ".openclaw");
    const rabbitSessionsDir = path.join(openClawRoot, "agents", "rabbit", "sessions");
    const claudeSessionsDir = path.join(openClawRoot, "agents", "claude", "sessions");
    await fs.mkdir(rabbitSessionsDir, { recursive: true });
    await fs.mkdir(claudeSessionsDir, { recursive: true });

    const childSessionFile = path.join(claudeSessionsDir, "child-session-file.jsonl");
    await fs.writeFile(
      childSessionFile,
      [
        JSON.stringify({ type: "session", version: 3, id: "child-session-file" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "child ACP result" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    await fs.writeFile(
      path.join(rabbitSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:rabbit:main": {
            deliveryContext: {
              channel: "discord",
              to: "channel:1481855674156580884",
              accountId: "bot4",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(claudeSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:claude:acp:test-child-key": {
            sessionFile: childSessionFile,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { api, hooks } = createPluginApi(openClawRoot);
    api.config.channels.discord.accounts = {
      bot4: { token: "discord-token" },
    };
    api.config.bindings = [
      {
        agentId: "rabbit",
        match: {
          channel: "discord",
          accountId: "bot4",
        },
      },
    ];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const afterToolCall = hooks.after_tool_call?.[0];

    expect(llmInput).toBeTypeOf("function");
    expect(afterToolCall).toBeTypeOf("function");

    await llmInput(
      {
        runId: "run-discord",
        sessionId: "session-discord",
        provider: "demo",
        model: "demo-model",
        systemPrompt: "system",
        prompt:
          'Conversation info (untrusted metadata):\n```json\n{"message_id":"1483139022380466340","sender_id":"881734814204571708"}\n```\n\nrun child task',
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "rabbit",
        sessionKey: "agent:rabbit:main",
        sessionId: "session-discord",
        runId: "run-discord",
      },
    );

    await afterToolCall(
      {
        toolName: "sessions_spawn",
        result: {
          details: {
            childSessionKey: "agent:claude:acp:test-child-key",
            mode: "run",
          },
        },
      },
      {
        toolName: "sessions_spawn",
        agentId: "rabbit",
        sessionKey: "agent:rabbit:main",
        sessionId: "session-discord",
        runId: "run-discord",
        toolCallId: "tool-call-1",
      },
    );

    const discordInfo = await __testables.extractDiscordTarget(
      {
        agentId: "rabbit",
        sessionKey: "agent:rabbit:main",
      },
      api as never,
    );
    expect(discordInfo).toEqual({
      to: "channel:1481855674156580884",
      accountId: "bot4",
    });

    const resolvedSession = await __testables.resolveSessionFileFromSessionKey(
      "agent:claude:acp:test-child-key",
      api as never,
    );
    expect(resolvedSession.sessionFile).toBe(childSessionFile);
    expect(resolvedSession.exists).toBe(true);
    expect(resolvedSession.source).toBe("registry-session-file");

    const output = await __testables.waitForSessionCompletion(childSessionFile, api as never, 20, 1);
    expect(output).toEqual({
      text: "child ACP result",
      completed: true,
    });
  });

  it("uses explicit structured callback routing even when the parent session has no Discord delivery metadata", async () => {
    const fakeHome = await makeTempDir("acp-handoff-structured-callback-home-");
    const openClawRoot = path.join(fakeHome, ".openclaw");
    const claudeSessionsDir = path.join(openClawRoot, "agents", "claude", "sessions");
    await fs.mkdir(claudeSessionsDir, { recursive: true });

    const childSessionFile = path.join(claudeSessionsDir, "structured-child-session.jsonl");
    await fs.writeFile(
      childSessionFile,
      [
        JSON.stringify({ type: "session", version: 3, id: "structured-child-session" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "structured callback result" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(claudeSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:claude:acp:test-structured-child": {
            sessionFile: childSessionFile,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { api, hooks } = createPluginApi(openClawRoot);
    api.config.agents.defaults.workspace = fakeHome;
    api.config.agents.list = [{ id: "wolf", workspace: fakeHome }];
    api.config.channels.discord.accounts = {
      bot6: { token: "discord-token" },
    };
    const sendMessageDiscord = vi.fn().mockResolvedValue(undefined);
    (api as any).runtime = {
      channel: {
        discord: { sendMessageDiscord },
      },
    };

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];
    const afterToolCall = hooks.after_tool_call?.[0];

    const childWorkspace = await makeTempDir("acp-handoff-structured-callback-child-");
    await llmInput(
      {
        runId: "run-structured-callback",
        sessionId: "session-structured-callback",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: [
          "[cron-acp]",
          "",
          '<acp_request version="1">',
          "  <meta>",
          "    <agentId>claude</agentId>",
          "    <responseMode>async-callback</responseMode>",
          "    <callback>",
          "      <channel>discord</channel>",
          "      <to>channel:1481855674156580884</to>",
          "      <accountId>bot6</accountId>",
          "    </callback>",
          "  </meta>",
          "  <task><![CDATA[dispatch structured callback task]]></task>",
          "</acp_request>",
        ].join("\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-structured-callback",
        runId: "run-structured-callback",
        workspaceDir: fakeHome,
      },
    );

    const beforeResult = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-structured-callback",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-structured-callback",
        sessionId: "session-structured-callback",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(beforeResult?.block).not.toBe(true);
    expect(beforeResult?.params?.agentId).toBe("claude");

    await afterToolCall(
      {
        toolName: "sessions_spawn",
        result: {
          details: {
            childSessionKey: "agent:claude:acp:test-structured-child",
            mode: "run",
          },
        },
      },
      {
        toolName: "sessions_spawn",
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-structured-callback",
        runId: "run-structured-callback",
        toolCallId: "tool-call-structured-callback",
      },
    );

    const callbackMirror = await readCallbackMirror(childWorkspace);
    expect(callbackMirror).toMatchObject({
      responseMode: "async-callback",
      callback: {
        channel: "discord",
        to: "channel:1481855674156580884",
        accountId: "bot6",
      },
      resolved: {
        to: "channel:1481855674156580884",
        accountId: "bot6",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 4500));

    expect(sendMessageDiscord).toHaveBeenCalledTimes(1);
    const [to, content, opts] = sendMessageDiscord.mock.calls[0] ?? [];
    expect(to).toBe("channel:1481855674156580884");
    expect(String(content)).toContain("structured callback result");
    expect(opts).toMatchObject({ accountId: "bot6" });
  });

  it("blocks follow-up tool calls in the same turn after an acpoff spawn has been accepted", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-post-spawn-guard-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-post-spawn-guard-child-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];
    const afterToolCall = hooks.after_tool_call?.[0];

    await llmInput(
      {
        runId: "run-post-spawn-guard",
        sessionId: "session-post-spawn-guard",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: "使用acpoff，调用clt命令，把当前轮次收到的提示词写入文件中。",
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-post-spawn-guard",
        runId: "run-post-spawn-guard",
        workspaceDir: parentWorkspace,
      },
    );

    const beforeSpawn = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-post-spawn-guard",
        params: {
          runtime: "acp",
          agentId: "clt",
          cwd: childWorkspace,
          task: "把当前轮次收到的提示词写入文件中。",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-post-spawn-guard",
        sessionId: "session-post-spawn-guard",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(beforeSpawn?.block).not.toBe(true);
    expect(beforeSpawn?.params?.task).toContain("<handoff_artifacts>");
    expect(beforeSpawn?.params?.task).toContain(
      ".openclaw/acp-handoff/latest-observed-cli-payload.txt",
    );

    await afterToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-post-spawn-guard",
        result: {
          details: {
            childSessionKey: "agent:clt:acp:guard-child",
            mode: "run",
          },
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-post-spawn-guard",
        sessionId: "session-post-spawn-guard",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    const blocked = await beforeToolCall(
      {
        toolName: "exec",
        runId: "run-post-spawn-guard",
        params: {
          command: "sleep 20 && echo waited",
        },
      },
      {
        toolName: "exec",
        runId: "run-post-spawn-guard",
        sessionId: "session-post-spawn-guard",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(blocked?.block).toBe(true);
    expect(blocked?.blockReason).toContain("acpoff 子任务已派发");
    expect(blocked?.blockReason).toContain("agent:clt:acp:guard-child");
    expect(blocked?.blockReason).toContain("不要继续调用 exec");
  });

  it("blocks local exec and polling drift before any acpoff spawn happens", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-prespawn-guard-parent-");
    const { api, hooks } = createPluginApi();
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "fox", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    await llmInput(
      {
        runId: "run-prespawn-guard",
        sessionId: "session-prespawn-guard",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: [
          "使用acpoff，调用clt命令，传入如下提示词",
          "",
          "```",
          "概括你收到的提示词，以及你的环境，模型，角色是什么",
          "```",
        ].join("\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "fox",
        sessionKey: "agent:fox:main",
        sessionId: "session-prespawn-guard",
        runId: "run-prespawn-guard",
        workspaceDir: parentWorkspace,
      },
    );

    const blockedExec = await beforeToolCall(
      {
        toolName: "exec",
        runId: "run-prespawn-guard",
        params: {
          command: "clt -p 'hello'",
        },
      },
      {
        toolName: "exec",
        runId: "run-prespawn-guard",
        sessionId: "session-prespawn-guard",
        sessionKey: "agent:fox:main",
        agentId: "fox",
        workspaceDir: parentWorkspace,
      },
    );

    expect(blockedExec?.block).toBe(true);
    expect(blockedExec?.blockReason).toContain("当前轮用户已明确要求使用 acpoff");
    expect(blockedExec?.blockReason).toContain("不得改走 exec 本地执行/轮询路径");
    expect(blockedExec?.blockReason).toContain('请直接调用 sessions_spawn（runtime:"acp"）');

    const blockedPoll = await beforeToolCall(
      {
        toolName: "process",
        runId: "run-prespawn-guard",
        params: {
          action: "poll",
          sessionId: "fresh-mist",
        },
      },
      {
        toolName: "process",
        runId: "run-prespawn-guard",
        sessionId: "session-prespawn-guard",
        sessionKey: "agent:fox:main",
        agentId: "fox",
        workspaceDir: parentWorkspace,
      },
    );

    expect(blockedPoll?.block).toBe(true);
    expect(blockedPoll?.blockReason).toContain("不得改走 process 本地执行/轮询路径");
  });

  it("reports a clear error when ACP accepts a child session but no transcript file materializes", async () => {
    const fakeHome = await makeTempDir("acp-handoff-missing-transcript-home-");
    const openClawRoot = path.join(fakeHome, ".openclaw");
    const claudeSessionsDir = path.join(openClawRoot, "agents", "claude", "sessions");
    await fs.mkdir(claudeSessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:claude:acp:ghost-child": {
            sessionId: "ghost-session-id",
            sessionFile: path.join(claudeSessionsDir, "ghost-session-id.jsonl"),
            updatedAt: Date.now(),
            acp: {
              state: "running",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const resolved = await __testables.resolveSessionFileFromSessionKey("agent:claude:acp:ghost-child", api as never);
    expect(resolved.exists).toBe(false);
    expect(resolved.source).toBe("missing");
    expect(resolved.sessionId).toBe("ghost-session-id");

    const output = await __testables.waitForChildSessionCompletion(
      "agent:claude:acp:ghost-child",
      api as never,
      25,
      5,
      25,
    );
    expect(output).toEqual({
      completed: false,
      text: null,
      sessionId: "ghost-session-id",
      error: "ACP 会话已接受，但 transcript 文件未落地（registry state=running）",
    });
  });

  it("uses acpx stream output when the child completes before transcript materializes", async () => {
    const fakeHome = await makeTempDir("acp-handoff-stream-fallback-home-");
    const openClawRoot = path.join(fakeHome, ".openclaw");
    const copilotSessionsDir = path.join(openClawRoot, "agents", "copilot", "sessions");
    const acpxSessionsDir = path.join(fakeHome, ".acpx", "sessions");
    await fs.mkdir(copilotSessionsDir, { recursive: true });
    await fs.mkdir(acpxSessionsDir, { recursive: true });

    await fs.writeFile(
      path.join(acpxSessionsDir, "cop-record-id.stream.ndjson"),
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: {
            sessionId: "backend-child-session",
            prompt: [{ type: "text", text: "do work" }],
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "backend-child-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "stream " },
            },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "backend-child-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "result" },
            },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: {
            stopReason: "end_turn",
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(copilotSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:copilot:acp:stream-only-child": {
            sessionId: "missing-transcript-session",
            sessionFile: path.join(copilotSessionsDir, "missing-transcript-session.jsonl"),
            updatedAt: Date.now(),
            acp: {
              state: "running",
              identity: {
                acpxRecordId: "cop-record-id",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const output = await __testables.waitForChildSessionCompletion(
      "agent:copilot:acp:stream-only-child",
      api as never,
      25,
      5,
      25,
    );

    expect(output).toEqual({
      completed: true,
      text: "stream result",
      sessionId: "missing-transcript-session",
    });
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("using stream fallback"),
    );
  });

  it("reports stalled nonterminal Claude sessions when local progress stops", async () => {
    const fakeHome = await makeTempDir("acp-handoff-local-stall-home-");
    const openClawRoot = path.join(fakeHome, ".openclaw");
    const acpxSessionsDir = path.join(fakeHome, ".acpx", "sessions");
    const cltSessionsDir = path.join(openClawRoot, "agents", "clt", "sessions");
    const claudeProjectDir = path.join(
      fakeHome,
      ".claude",
      "projects",
      "-Users-example--openclaw-workspace-fox",
    );
    await fs.mkdir(acpxSessionsDir, { recursive: true });
    await fs.mkdir(cltSessionsDir, { recursive: true });
    await fs.mkdir(claudeProjectDir, { recursive: true });

    await fs.writeFile(
      path.join(acpxSessionsDir, "stall-record.stream.ndjson"),
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: {
            sessionId: "backend-stall-session",
            prompt: [{ type: "text", text: "do work" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(acpxSessionsDir, "stall-record.json"),
      JSON.stringify(
        {
          schema: "acpx.session.v1",
          acpx_record_id: "stall-record",
          acp_session_id: "claude-stalled-session",
          agent_command: "env CLAUDE_CODE_EXECUTABLE=/mock/clt npx -y @zed-industries/claude-agent-acp@^0.21.0",
          cwd: "/Users/example/.openclaw/workspace-fox",
          closed: false,
          messages: [],
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(cltSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:clt:acp:stalled-child": {
            sessionId: "missing-transcript-session",
            sessionFile: path.join(cltSessionsDir, "missing-transcript-session.jsonl"),
            updatedAt: Date.now(),
            acp: {
              state: "running",
              identity: {
                acpxRecordId: "stall-record",
                acpxSessionId: "claude-stalled-session",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const localSessionPath = path.join(claudeProjectDir, "claude-stalled-session.jsonl");
    await fs.writeFile(
      localSessionPath,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: null,
            content: [
              {
                type: "text",
                text: "我将尽可能完整地保存所有内容：",
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const staleTime = new Date(Date.now() - 120_000);
    await fs.utimes(localSessionPath, staleTime, staleTime);

    const { api } = createPluginApi(openClawRoot);
    const output = await __testables.waitForChildSessionCompletion(
      "agent:clt:acp:stalled-child",
      api as never,
      25,
      5,
      25,
    );

    expect(output).toEqual(
      expect.objectContaining({
        completed: false,
        text: null,
        sessionId: "missing-transcript-session",
        state: "stalled_nonterminal",
      }),
    );
    expect(output.error).toContain("Claude Code 会话疑似卡住");
    expect(output.error).toContain("未完成的 assistant 回合");
  });

  it("uses local Copilot fallback errors when transcript never materializes", async () => {
    const fakeHome = await makeTempDir("acp-handoff-copilot-local-home-");
    const openClawRoot = path.join(fakeHome, ".openclaw");
    const copilotSessionsDir = path.join(openClawRoot, "agents", "copilot", "sessions");
    const acpxSessionsDir = path.join(fakeHome, ".acpx", "sessions");
    const copilotSessionDir = path.join(
      fakeHome,
      ".copilot",
      "session-state",
      "52c0ef93-d803-444e-add7-8e4c161a1e66",
    );
    await fs.mkdir(copilotSessionsDir, { recursive: true });
    await fs.mkdir(acpxSessionsDir, { recursive: true });
    await fs.mkdir(copilotSessionDir, { recursive: true });

    await fs.writeFile(
      path.join(acpxSessionsDir, "cop-local-error.stream.ndjson"),
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: {
            sessionId: "backend-child-session",
            prompt: [{ type: "text", text: "do work" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(acpxSessionsDir, "cop-local-error.json"),
      JSON.stringify(
        {
          schema: "acpx.session.v1",
          acpx_record_id: "cop-local-error",
          acp_session_id: "52c0ef93-d803-444e-add7-8e4c161a1e66",
          agent_command: "copilot --acp --stdio",
          cwd: "/Users/example/.openclaw/workspace-wolf",
          closed: true,
          last_agent_disconnect_reason: "connection_close",
          messages: [],
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(copilotSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:copilot:acp:local-error-child": {
            sessionId: "missing-transcript-session",
            sessionFile: path.join(copilotSessionsDir, "missing-transcript-session.jsonl"),
            updatedAt: Date.now(),
            acp: {
              state: "running",
              identity: {
                acpxRecordId: "cop-local-error",
                acpxSessionId: "52c0ef93-d803-444e-add7-8e4c161a1e66",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(copilotSessionDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "session.error",
          data: {
            errorType: "query",
            message:
              'Execution failed: CAPIError: 400 model "gpt-5.4" is not accessible via the /chat/completions endpoint',
            statusCode: 400,
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const output = await __testables.waitForChildSessionCompletion(
      "agent:copilot:acp:local-error-child",
      api as never,
      25,
      5,
      25,
    );

    expect(output).toEqual({
      completed: false,
      text: null,
      sessionId: "missing-transcript-session",
      error:
        'Copilot 会话失败：API Error 400（模型、资源或渠道不可用）：model "gpt-5.4" is not accessible via the /chat/completions endpoint',
      state: "api_error",
    });
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed inside Copilot before transcript materialized"),
    );
  });

  it("reports in-progress wording when prompt was accepted but transcript still does not materialize", async () => {
    const fakeHome = await makeTempDir("acp-handoff-stream-pending-home-");
    const openClawRoot = path.join(fakeHome, ".openclaw");
    const copilotSessionsDir = path.join(openClawRoot, "agents", "copilot", "sessions");
    const acpxSessionsDir = path.join(fakeHome, ".acpx", "sessions");
    await fs.mkdir(copilotSessionsDir, { recursive: true });
    await fs.mkdir(acpxSessionsDir, { recursive: true });

    await fs.writeFile(
      path.join(acpxSessionsDir, "cop-pending-record.stream.ndjson"),
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: {
            sessionId: "backend-pending-session",
            prompt: [{ type: "text", text: "do work" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(copilotSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:copilot:acp:pending-child": {
            sessionId: "pending-session-id",
            sessionFile: path.join(copilotSessionsDir, "pending-session-id.jsonl"),
            updatedAt: Date.now(),
            acp: {
              state: "running",
              identity: {
                acpxRecordId: "cop-pending-record",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const output = await __testables.waitForChildSessionCompletion(
      "agent:copilot:acp:pending-child",
      api as never,
      25,
      5,
      25,
    );

    expect(output).toEqual({
      completed: false,
      text: null,
      sessionId: "pending-session-id",
      error: "ACP 会话仍在执行中，结果尚未落盘（registry state=running；请勿过早手动 close）",
    });
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("accepted prompt, but transcript is not materialized yet"),
    );
  });

  it("returns runtime_error when ACP backend dies after session/new but before the first prompt", async () => {
    const fakeHome = await makeTempDir("acp-handoff-preprompt-death-home-");
    const openClawRoot = path.join(fakeHome, ".openclaw");
    const cltSessionsDir = path.join(openClawRoot, "agents", "clt", "sessions");
    const acpxSessionsDir = path.join(fakeHome, ".acpx", "sessions");
    await fs.mkdir(cltSessionsDir, { recursive: true });
    await fs.mkdir(acpxSessionsDir, { recursive: true });

    await fs.writeFile(
      path.join(acpxSessionsDir, "preprompt-death.stream.ndjson"),
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: {
              name: "acpx",
              version: "0.1.0",
            },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          result: {
            protocolVersion: 1,
            agentInfo: {
              name: "@zed-industries/claude-agent-acp",
              version: "0.21.0",
            },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "session/load",
          params: {
            sessionId: "preprompt-death",
            cwd: "/Users/example/.openclaw/workspace-fox",
            mcpServers: [],
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32002,
            message: "Resource not found: preprompt-death",
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: {
            cwd: "/Users/example/.openclaw/workspace-fox",
            mcpServers: [],
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            sessionId: "backend-preprompt-session",
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(acpxSessionsDir, "preprompt-death.json"),
      JSON.stringify(
        {
          schema: "acpx.session.v1",
          acpx_record_id: "preprompt-death",
          acp_session_id: "preprompt-death",
          agent_command: "env CLAUDE_CODE_EXECUTABLE=/mock/clt npx -y @zed-industries/claude-agent-acp@^0.21.0",
          cwd: "/Users/example/.openclaw/workspace-fox",
          pid: 999999,
          closed: false,
          messages: [],
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(cltSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:clt:acp:preprompt-death-child": {
            sessionId: "missing-transcript-session",
            sessionFile: path.join(cltSessionsDir, "missing-transcript-session.jsonl"),
            updatedAt: Date.now(),
            acp: {
              state: "running",
              identity: {
                acpxRecordId: "preprompt-death",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const output = await __testables.waitForChildSessionCompletion(
      "agent:clt:acp:preprompt-death-child",
      api as never,
      25,
      5,
      25,
    );

    expect(output).toEqual({
      completed: false,
      text: null,
      sessionId: "missing-transcript-session",
      error:
        "ACP 会话在首个 prompt 发送前即异常终止：registry 仍显示 running，acpx backend pid 999999 已不存在，且 backend 已创建 session backend-preprompt-session，但 stream 只走到了 session/new，未出现 session/prompt。请重新触发该子会话；这通常说明 ACP runtime 在真正投递 handoff prompt 前就已退出。",
      state: "runtime_error",
    });
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("首个 prompt 发送前即异常终止"),
    );
  });

  it("returns failure immediately when the ACP registry enters error before transcript materializes", async () => {
    const fakeHome = await makeTempDir("acp-handoff-registry-error-home-");
    const openClawRoot = path.join(fakeHome, ".openclaw");
    const cltSessionsDir = path.join(openClawRoot, "agents", "clt", "sessions");
    const acpxSessionsDir = path.join(fakeHome, ".acpx", "sessions");
    await fs.mkdir(cltSessionsDir, { recursive: true });
    await fs.mkdir(acpxSessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(acpxSessionsDir, "error-record-id.stream.ndjson"),
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32002,
            message: "Resource not found: error-record-id",
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          error: {
            code: -32603,
            message: "Internal error: API Error: Unable to connect to API (ENOTFOUND)",
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(cltSessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:clt:acp:error-child": {
            sessionId: "error-session-id",
            sessionFile: path.join(cltSessionsDir, "error-session-id.jsonl"),
            updatedAt: Date.now(),
            acp: {
              state: "error",
              lastError: "acpx exited with code 1",
              identity: {
                acpxRecordId: "error-record-id",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    const output = await __testables.waitForChildSessionCompletion(
      "agent:clt:acp:error-child",
      api as never,
      300,
      10,
      300,
    );
    expect(output).toEqual({
      completed: false,
      text: null,
      sessionId: "error-session-id",
      error: "API Error: Unable to connect to API (ENOTFOUND)",
    });
  });

  it("keeps waiting when a transcript exists but assistant output lands later", async () => {
    const fakeHome = await makeTempDir("acp-handoff-delayed-transcript-home-");
    const openClawRoot = path.join(fakeHome, ".openclaw");
    const claudeSessionsDir = path.join(openClawRoot, "agents", "claude", "sessions");
    await fs.mkdir(claudeSessionsDir, { recursive: true });
    const delayedSessionFile = path.join(claudeSessionsDir, "delayed-session.jsonl");
    await fs.writeFile(
      delayedSessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "delayed-session",
        timestamp: new Date().toISOString(),
        cwd: fakeHome,
      })}\n`,
      "utf8",
    );

    const { api } = createPluginApi(openClawRoot);
    setTimeout(async () => {
      await fs.appendFile(
        delayedSessionFile,
        `${JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "delayed ACP result" }],
          },
        })}\n`,
        "utf8",
      );
    }, 30);

    const output = await __testables.waitForSessionCompletion(
      delayedSessionFile,
      api as never,
      300,
      10,
    );
    expect(output).toEqual({
      completed: true,
      text: "delayed ACP result",
    });
  });

  it("delegates Discord delivery to api.runtime.channel.discord.sendMessageDiscord", async () => {
    const { api } = createPluginApi();
    const sendMessageDiscord = vi.fn().mockResolvedValue(undefined);
    (api as any).runtime = {
      channel: {
        discord: { sendMessageDiscord },
      },
    };

    await __testables.sendToDiscord(
      { to: "channel:channel-1", accountId: "bot4" },
      "hello",
      api as never,
    );

    expect(sendMessageDiscord).toHaveBeenCalledWith("channel:channel-1", "hello", { accountId: "bot4" });
    expect(api.logger.info).toHaveBeenCalledWith("acp-handoff: Discord message sent successfully");
  });

  it("logs and rethrows when Discord delivery fails", async () => {
    const { api } = createPluginApi();
    const sendError = new Error("network failure");
    const sendMessageDiscord = vi.fn().mockRejectedValue(sendError);
    (api as any).runtime = {
      channel: {
        discord: { sendMessageDiscord },
      },
    };

    await expect(
      __testables.sendToDiscord(
        { to: "channel:channel-1", accountId: "bot4" },
        "hello",
        api as never,
      ),
    ).rejects.toThrow("network failure");

    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Discord send failed: Error: network failure"),
    );
  });
});

// ── sessionKey / model 新功能测试 ────────────────────────────────────────────

import { parseStructuredAcpRequest } from "./src/protocol.ts";

describe("acp-handoff sessionKey and model fields", () => {
  it("parses sessionKey and model from <meta> block", () => {
    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>skill-builder-persistent</sessionKey>",
      "    <model>anthropic/claude-opus-4-6</model>",
      "    <responseMode>async-callback</responseMode>",
      "    <callback>",
      "      <channel>discord</channel>",
      "      <to>user:881734814204571708</to>",
      "    </callback>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    const result = parseStructuredAcpRequest(envelope);
    expect(result).not.toBeNull();
    expect(result?.sessionKey).toBe("skill-builder-persistent");
    expect(result?.model).toBe("anthropic/claude-opus-4-6");
    expect(result?.agentId).toBe("clt");
    expect(result?.task).toBe("do the task");
    expect(result?.responseMode).toBe("async-callback");
  });

  it("parses sessionKey without model", () => {
    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <sessionKey>my-persistent-session</sessionKey>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt>task content</cli_prompt>",
      "</acp_request>",
    ].join("\n");

    const result = parseStructuredAcpRequest(envelope);
    expect(result?.sessionKey).toBe("my-persistent-session");
    expect(result?.model).toBeUndefined();
  });

  it("parses model without sessionKey", () => {
    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <model>anthropic/claude-sonnet-4-6</model>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt>task content</cli_prompt>",
      "</acp_request>",
    ].join("\n");

    const result = parseStructuredAcpRequest(envelope);
    expect(result?.model).toBe("anthropic/claude-sonnet-4-6");
    expect(result?.sessionKey).toBeUndefined();
  });

  it("returns undefined sessionKey and model when absent", () => {
    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt>task</cli_prompt>",
      "</acp_request>",
    ].join("\n");

    const result = parseStructuredAcpRequest(envelope);
    expect(result?.sessionKey).toBeUndefined();
    expect(result?.model).toBeUndefined();
  });

  it("parses sessionKey with CDATA encoding", () => {
    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <sessionKey><![CDATA[session-with-special-chars]]></sessionKey>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt>task</cli_prompt>",
      "</acp_request>",
    ].join("\n");

    const result = parseStructuredAcpRequest(envelope);
    expect(result?.sessionKey).toBe("session-with-special-chars");
  });

  it("injects resumeSessionId into sessions_spawn params when stored session exists", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-session-key-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-session-key-child-");
    const openclawRoot = await makeTempDir("acp-handoff-openclaw-root-");

    // 预先写入存储的 session key 映射
    const sessionKeyDir = path.join(openclawRoot, "acp-handoff", "session-keys");
    await fs.mkdir(sessionKeyDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionKeyDir, "clt-skill-builder-persistent.json"),
      JSON.stringify({
        acpSessionId: "stored-acp-session-id-abc123",
        agentId: "clt",
        fixedName: "skill-builder-persistent",
        storedAt: Date.now(),
        turnCount: 1,
      }),
      "utf8",
    );

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>skill-builder-persistent</sessionKey>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[build the skill]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-session-key",
        sessionId: "session-session-key",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-session-key",
        runId: "run-session-key",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-session-key",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-session-key",
        sessionId: "session-session-key",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.block).not.toBe(true);
    // resumeSessionId 应该被注入
    expect(result?.params?.resumeSessionId).toBe("stored-acp-session-id-abc123");
    expect(result?.params?.agentId).toBe("clt");
    // 续接轮：只发纯任务，不包完整上下文
    expect(result?.params?.task).toBe("build the skill");
    expect(result?.params?.task).not.toContain("<handoff_payload>");
    expect(result?.params?.task).not.toContain("<handoff_context>");
  });

  it("does not inject resumeSessionId when no stored session exists", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-no-session-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-no-session-child-");
    const openclawRoot = await makeTempDir("acp-handoff-no-session-openclaw-");

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>brand-new-session</sessionKey>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[first run task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-no-session",
        sessionId: "session-no-session",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-no-session",
        runId: "run-no-session",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-no-session",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-no-session",
        sessionId: "session-no-session",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.block).not.toBe(true);
    // 第一次执行，没有存储记录，不应注入 resumeSessionId
    expect(result?.params?.resumeSessionId).toBeUndefined();
    expect(result?.params?.task).toContain("<request>\nfirst run task\n</request>");
  });

  it("stores structured field in PendingStructuredSpawnMonitor so model/sessionKey propagate to after_tool_call", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-structured-field-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-structured-field-child-");
    const openclawRoot = await makeTempDir("acp-handoff-structured-field-openclaw-");

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>my-session</sessionKey>",
      "    <model>anthropic/claude-opus-4-6</model>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do work]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-structured-field",
        sessionId: "session-structured-field",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-structured-field",
        runId: "run-structured-field",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-structured-field",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-structured-field",
        sessionId: "session-structured-field",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    expect(result?.block).not.toBe(true);

    // 验证 structured request mirror 写入了包含 sessionKey/model 的原始 envelope
    const mirror = await readStructuredRequestMirror(childWorkspace);
    expect(mirror).toContain("<sessionKey>my-session</sessionKey>");
    expect(mirror).toContain("<model>anthropic/claude-opus-4-6</model>");

    // 验证 pending registry 文件里包含 structured 字段（含 sessionKey 和 model）
    const pendingRegistryPath = path.join(parentWorkspace, ".openclaw", "acp-handoff", "pending-structured-spawns.json");
    const pendingRegistry = JSON.parse(await fs.readFile(pendingRegistryPath, "utf8"));
    const firstEntry = Object.values(pendingRegistry as Record<string, unknown[]>)[0]?.[0] as Record<string, unknown>;
    expect(firstEntry).toBeDefined();
    expect((firstEntry.structured as Record<string, unknown>)?.sessionKey).toBe("my-session");
    expect((firstEntry.structured as Record<string, unknown>)?.model).toBe("anthropic/claude-opus-4-6");
  });

  it("parses maxTurns from <meta> block", () => {
    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>my-session</sessionKey>",
      "    <maxTurns>3</maxTurns>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");
    const result = parseStructuredAcpRequest(envelope);
    expect(result?.maxTurns).toBe(3);
    expect(result?.sessionKey).toBe("my-session");
  });

  it("returns undefined maxTurns when absent", () => {
    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <sessionKey>my-session</sessionKey>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");
    const result = parseStructuredAcpRequest(envelope);
    expect(result?.maxTurns).toBeUndefined();
  });

  it("returns undefined maxTurns for invalid values (0, negative)", () => {
    for (const val of ["0", "-1", "abc"]) {
      const envelope = [
        '<acp_request version="1">',
        "  <meta>",
        `    <maxTurns>${val}</maxTurns>`,
        "    <responseMode>sync-return</responseMode>",
        "  </meta>",
        "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
        "</acp_request>",
      ].join("\n");
      const result = parseStructuredAcpRequest(envelope);
      expect(result?.maxTurns).toBeUndefined();
    }
  });

  it("resumes session when turnCount < maxTurns", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-maxturn-resume-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-maxturn-resume-child-");
    const openclawRoot = await makeTempDir("acp-handoff-maxturn-resume-root-");

    const sessionKeyDir = path.join(openclawRoot, "acp-handoff", "session-keys");
    await fs.mkdir(sessionKeyDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionKeyDir, "clt-persistent-session.json"),
      JSON.stringify({
        acpSessionId: "session-abc",
        agentId: "clt",
        fixedName: "persistent-session",
        storedAt: Date.now(),
        turnCount: 2,
      }),
      "utf8",
    );

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>persistent-session</sessionKey>",
      "    <maxTurns>3</maxTurns>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-maxturn-resume",
        sessionId: "session-maxturn-resume",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-maxturn-resume",
        runId: "run-maxturn-resume",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-maxturn-resume",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-maxturn-resume",
        sessionId: "session-maxturn-resume",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    // turnCount=2 < maxTurns=3 → 续接，注入 resumeSessionId
    expect(result?.block).not.toBe(true);
    expect(result?.params?.resumeSessionId).toBe("session-abc");
    expect(result?.params?.task).toBe("do the task");
    expect(result?.params?.task).not.toContain("<handoff_payload>");
  });

  it("forces new session when turnCount >= maxTurns", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-maxturn-force-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-maxturn-force-child-");
    const openclawRoot = await makeTempDir("acp-handoff-maxturn-force-root-");

    const sessionKeyDir = path.join(openclawRoot, "acp-handoff", "session-keys");
    await fs.mkdir(sessionKeyDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionKeyDir, "clt-persistent-session.json"),
      JSON.stringify({
        acpSessionId: "session-abc",
        agentId: "clt",
        fixedName: "persistent-session",
        storedAt: Date.now(),
        turnCount: 3,
      }),
      "utf8",
    );

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>persistent-session</sessionKey>",
      "    <maxTurns>3</maxTurns>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-maxturn-force",
        sessionId: "session-maxturn-force",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-maxturn-force",
        runId: "run-maxturn-force",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-maxturn-force",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-maxturn-force",
        sessionId: "session-maxturn-force",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    // turnCount=3 >= maxTurns=3 → 强制新建，不注入 resumeSessionId，task 含完整上下文
    expect(result?.block).not.toBe(true);
    expect(result?.params?.resumeSessionId).toBeUndefined();
    expect(result?.params?.task).toContain("<handoff_payload>");
    expect(result?.params?.task).toContain("<handoff_context>");
  });

  it("resumes without limit when maxTurns is undefined (turnCount=100)", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-maxturn-unlimited-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-maxturn-unlimited-child-");
    const openclawRoot = await makeTempDir("acp-handoff-maxturn-unlimited-root-");

    const sessionKeyDir = path.join(openclawRoot, "acp-handoff", "session-keys");
    await fs.mkdir(sessionKeyDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionKeyDir, "clt-unlimited-session.json"),
      JSON.stringify({
        acpSessionId: "session-xyz",
        agentId: "clt",
        fixedName: "unlimited-session",
        storedAt: Date.now(),
        turnCount: 100,
      }),
      "utf8",
    );

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>unlimited-session</sessionKey>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-maxturn-unlimited",
        sessionId: "session-maxturn-unlimited",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-maxturn-unlimited",
        runId: "run-maxturn-unlimited",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-maxturn-unlimited",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-maxturn-unlimited",
        sessionId: "session-maxturn-unlimited",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    // maxTurns=undefined → 无限续接，即使 turnCount=100 也续接
    expect(result?.block).not.toBe(true);
    expect(result?.params?.resumeSessionId).toBe("session-xyz");
    expect(result?.params?.task).toBe("do the task");
  });

  it("backward compatible: old store without turnCount defaults to turnCount=1 and resumes", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-compat-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-compat-child-");
    const openclawRoot = await makeTempDir("acp-handoff-compat-root-");

    const sessionKeyDir = path.join(openclawRoot, "acp-handoff", "session-keys");
    await fs.mkdir(sessionKeyDir, { recursive: true });
    // 旧格式：无 turnCount 字段
    await fs.writeFile(
      path.join(sessionKeyDir, "clt-old-session.json"),
      JSON.stringify({
        acpSessionId: "session-old",
        agentId: "clt",
        fixedName: "old-session",
        storedAt: Date.now(),
      }),
      "utf8",
    );

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>old-session</sessionKey>",
      "    <maxTurns>3</maxTurns>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-compat",
        sessionId: "session-compat",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-compat",
        runId: "run-compat",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-compat",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-compat",
        sessionId: "session-compat",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    // 旧存储无 turnCount → 默认 turnCount=1，1 < 3 → 续接
    expect(result?.block).not.toBe(true);
    expect(result?.params?.resumeSessionId).toBe("session-old");
    expect(result?.params?.task).toBe("do the task");
  });

  it("maxTurns=1: every trigger forces a new session (turnCount=1 >= maxTurns=1)", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-maxturn1-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-maxturn1-child-");
    const openclawRoot = await makeTempDir("acp-handoff-maxturn1-root-");

    const sessionKeyDir = path.join(openclawRoot, "acp-handoff", "session-keys");
    await fs.mkdir(sessionKeyDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionKeyDir, "clt-single-session.json"),
      JSON.stringify({
        acpSessionId: "session-prev",
        agentId: "clt",
        fixedName: "single-session",
        storedAt: Date.now(),
        turnCount: 1,
      }),
      "utf8",
    );

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>single-session</sessionKey>",
      "    <maxTurns>1</maxTurns>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-maxturn1",
        sessionId: "session-maxturn1",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-maxturn1",
        runId: "run-maxturn1",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-maxturn1",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-maxturn1",
        sessionId: "session-maxturn1",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    // maxTurns=1, turnCount=1 → 1>=1 → 强制新建每次
    expect(result?.block).not.toBe(true);
    expect(result?.params?.resumeSessionId).toBeUndefined();
    expect(result?.params?.task).toContain("<handoff_payload>");
    // 验证 logger 记录了强制新建的日志
    const logCalls = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(logCalls.some((msg) => msg.includes("turn limit reached") && msg.includes("forcing new session"))).toBe(true);
  });

  it("logs correct turn info in resume log message", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-turnlog-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-turnlog-child-");
    const openclawRoot = await makeTempDir("acp-handoff-turnlog-root-");

    const sessionKeyDir = path.join(openclawRoot, "acp-handoff", "session-keys");
    await fs.mkdir(sessionKeyDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionKeyDir, "clt-log-session.json"),
      JSON.stringify({
        acpSessionId: "session-log",
        agentId: "clt",
        fixedName: "log-session",
        storedAt: Date.now(),
        turnCount: 1,
      }),
      "utf8",
    );

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>log-session</sessionKey>",
      "    <maxTurns>5</maxTurns>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-turnlog",
        sessionId: "session-turnlog",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-turnlog",
        runId: "run-turnlog",
        workspaceDir: parentWorkspace,
      },
    );

    await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-turnlog",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-turnlog",
        sessionId: "session-turnlog",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    // 验证日志包含 "turn 2/5" 格式（turnCount=1 → 下次是第2轮，共5轮）
    const logCalls = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(logCalls.some((msg) => msg.includes("turn 2/5"))).toBe(true);
  });

  it("forces new session when turnCount > maxTurns (over-limit guard)", async () => {
    // 边界情况：存储的 turnCount 已经超过 maxTurns（比如 maxTurns 被调小了）
    const parentWorkspace = await makeTempDir("acp-handoff-overlimit-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-overlimit-child-");
    const openclawRoot = await makeTempDir("acp-handoff-overlimit-root-");

    const sessionKeyDir = path.join(openclawRoot, "acp-handoff", "session-keys");
    await fs.mkdir(sessionKeyDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionKeyDir, "clt-overlimit-session.json"),
      JSON.stringify({
        acpSessionId: "session-over",
        agentId: "clt",
        fixedName: "overlimit-session",
        storedAt: Date.now(),
        turnCount: 10, // 远超 maxTurns=2
      }),
      "utf8",
    );

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <sessionKey>overlimit-session</sessionKey>",
      "    <maxTurns>2</maxTurns>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-overlimit",
        sessionId: "session-overlimit",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-overlimit",
        runId: "run-overlimit",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-overlimit",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-overlimit",
        sessionId: "session-overlimit",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    // turnCount=10 > maxTurns=2 → 强制新建（兜底保护）
    expect(result?.block).not.toBe(true);
    expect(result?.params?.resumeSessionId).toBeUndefined();
    expect(result?.params?.task).toContain("<handoff_payload>");
  });

  it("no sessionKey: maxTurns is irrelevant, no context injection logic applied", async () => {
    const parentWorkspace = await makeTempDir("acp-handoff-nosessionkey-parent-");
    const childWorkspace = await makeTempDir("acp-handoff-nosessionkey-child-");
    const openclawRoot = await makeTempDir("acp-handoff-nosessionkey-root-");

    const { api, hooks } = createPluginApi(openclawRoot);
    api.config.agents.defaults.workspace = parentWorkspace;
    api.config.agents.list = [{ id: "wolf", workspace: parentWorkspace }];

    await plugin.register(api as never);
    const llmInput = hooks.llm_input?.[0];
    const beforeToolCall = hooks.before_tool_call?.[0];

    // 不写 sessionKey，但写了 maxTurns（maxTurns 应被忽略）
    const envelope = [
      '<acp_request version="1">',
      "  <meta>",
      "    <agentId>clt</agentId>",
      "    <maxTurns>2</maxTurns>",
      "    <responseMode>sync-return</responseMode>",
      "  </meta>",
      "  <cli_prompt><![CDATA[do the task]]></cli_prompt>",
      "</acp_request>",
    ].join("\n");

    await llmInput(
      {
        runId: "run-nosessionkey",
        sessionId: "session-nosessionkey",
        provider: "demo",
        model: "demo-model",
        systemPrompt: PROJECT_CONTEXT_SYSTEM_PROMPT,
        prompt: ["[cron-acp]", envelope].join("\n\n"),
        historyMessages: [],
        imagesCount: 0,
      },
      {
        agentId: "wolf",
        sessionKey: "agent:wolf:main",
        sessionId: "session-nosessionkey",
        runId: "run-nosessionkey",
        workspaceDir: parentWorkspace,
      },
    );

    const result = await beforeToolCall(
      {
        toolName: "sessions_spawn",
        runId: "run-nosessionkey",
        params: {
          runtime: "acp",
          agentId: "copilot",
          cwd: childWorkspace,
          task: "[acp-handoff] [cron-structured-request]",
        },
      },
      {
        toolName: "sessions_spawn",
        runId: "run-nosessionkey",
        sessionId: "session-nosessionkey",
        sessionKey: "agent:wolf:main",
        agentId: "wolf",
      },
    );

    // 无 sessionKey → 无轮次逻辑 → 始终首轮（完整上下文注入）
    expect(result?.block).not.toBe(true);
    expect(result?.params?.resumeSessionId).toBeUndefined();
    expect(result?.params?.task).toContain("<handoff_payload>");
  });
});
