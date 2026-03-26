import path from "node:path";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readLatestSnapshotBySessionKey, readSnapshotByRunId, storeSnapshot } from "./src/cache.js";
import {
  CRON_STRUCTURED_REQUEST_MARKER,
  HANDOFF_DIR,
  HANDOFF_SIGNAL_ALIASES,
  LATEST_CALLBACK_FILE,
  LATEST_STRUCTURED_REQUEST_FILE,
  PENDING_SPAWN_REGISTRY_FILE,
} from "./src/constants.js";
import {
  renderConcretePrompt,
  resolveRenderedPromptArtifacts,
  writeRenderedPromptFile,
} from "./src/handoff-file.js";
import { createSnapshot } from "./src/normalize.js";
import {
  parseStructuredAcpRequest,
  StructuredAcpRequestError,
  type StructuredAcpRequest,
  type StructuredDiscordCallback,
  type StructuredResponseMode,
} from "./src/protocol.js";
import { readTranscriptFallbackSnapshot } from "./src/transcript.js";
import type { HandoffSnapshotSource } from "./src/types.js";

function normalizeRuntime(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeLauncherName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]*$/.test(normalized) ? normalized : null;
}

const COPILOT_LAUNCHER_ALIASES = new Set(["cop", "copilot"]);
const ACPOFF_PRESPAWN_BLOCKED_TOOLS = new Set(["exec", "process", "sessions_list", "sessions_history"]);

function canonicalizeLauncherName(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (COPILOT_LAUNCHER_ALIASES.has(value)) {
    return "copilot";
  }
  return value;
}

function extractRequestedTask(rawTask: string): string | null {
  const signals = [...HANDOFF_SIGNAL_ALIASES].sort((left, right) => right.length - left.length);
  for (const signal of signals) {
    const index = rawTask.indexOf(signal);
    if (index !== -1) {
      const before = rawTask.slice(0, index);
      const after = rawTask.slice(index + signal.length);
      return `${before}${after}`.trim();
    }
  }
  return null;
}

function resolveWorkspaceDir(api: OpenClawPluginApi, agentId?: string): string | undefined {
  const normalizedAgentId = agentId?.trim();
  const matchingAgent = normalizedAgentId
    ? (api.config.agents?.list ?? []).find((entry) => entry.id?.trim() === normalizedAgentId)
    : undefined;
  const workspace =
    matchingAgent?.workspace?.trim() || api.config.agents?.defaults?.workspace?.trim() || "";
  return workspace ? api.resolvePath(workspace) : undefined;
}

function sliceFromAcpoffInvocation(visiblePrompt: string): string {
  const match = visiblePrompt.match(/\bacpoff\b/i);
  if (!match || match.index === undefined) {
    return visiblePrompt.trim();
  }
  return visiblePrompt.slice(match.index).trim();
}

function extractRequestedLauncher(visiblePrompt: string): string | null {
  if (!/\bacpoff\b/i.test(visiblePrompt)) {
    return null;
  }

  let launcherPrompt = sliceFromAcpoffInvocation(visiblePrompt);
  launcherPrompt = launcherPrompt.replace(/^(?:请)?(?:(?:使用|用|通过)\s*)?acpoff[\s，,：:、]*/i, "");
  const match = launcherPrompt.match(
    /^(?:请)?(?:调用|使用|用)\s*([A-Za-z][A-Za-z0-9_-]*)\s*命令(?=[\s，,：:、。]|$)/i,
  );
  return canonicalizeLauncherName(normalizeLauncherName(match?.[1] ?? null));
}

function resolvePreferredChildAgentId(api: OpenClawPluginApi): string | undefined {
  return canonicalizeLauncherName(normalizeLauncherName(api.config.acp?.defaultAgent)) ?? "copilot";
}

function resolveChildAgentId(
  api: OpenClawPluginApi,
  params: Record<string, unknown>,
  snapshotPrompt?: string,
  forcedChildAgentId?: string,
): string | undefined {
  if (forcedChildAgentId) {
    return forcedChildAgentId;
  }
  const visiblePrompt = snapshotPrompt ? extractVisibleUserPromptText(snapshotPrompt) : null;
  const requestedLauncher = visiblePrompt ? extractRequestedLauncher(visiblePrompt) : null;
  if (requestedLauncher) {
    return requestedLauncher;
  }

  const explicit = canonicalizeLauncherName(normalizeLauncherName(params.agentId));
  const preferred = resolvePreferredChildAgentId(api);
  if (!explicit) {
    return preferred || undefined;
  }
  return explicit;
}

function resolveOutputDir(
  api: OpenClawPluginApi,
  params: Record<string, unknown>,
  fallbackWorkspaceDir?: string,
): string | undefined {
  const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
  if (cwd) {
    return path.resolve(api.resolvePath(cwd));
  }
  if (fallbackWorkspaceDir) {
    return path.resolve(fallbackWorkspaceDir);
  }
  return undefined;
}

async function resolveCurrentTurnSnapshot(
  api: OpenClawPluginApi,
  ctx: {
    runId?: string;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    workspaceDir?: string;
    requestedTask?: string;
    allowTranscriptFallback?: boolean;
  },
) {
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const parentWorkspaceDir = ctx.workspaceDir || resolveWorkspaceDir(api, ctx.agentId);
  const runId = ctx.runId?.trim();

  let snapshot = runId ? await readSnapshotByRunId({ runId, workspaceDir: parentWorkspaceDir }) : null;
  if (!snapshot) {
    snapshot = await readLatestSnapshotBySessionKey({ sessionKey, workspaceDir: parentWorkspaceDir });
  }
  if (!snapshot) {
    if (!ctx.allowTranscriptFallback) {
      return null;
    }
    snapshot = await readTranscriptFallbackSnapshot({
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      sessionKey,
      workspaceDir: parentWorkspaceDir,
      requestedTask: ctx.requestedTask ?? "",
    });
  }
  return snapshot;
}

type SessionDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  replyToId?: string;
};

type SessionOrigin = {
  provider?: string;
  surface?: string;
  to?: string;
  accountId?: string;
};

type SessionRegistryEntry = {
  deliveryContext?: SessionDeliveryContext;
  origin?: SessionOrigin;
  sessionFile?: string;
  sessionId?: string;
  updatedAt?: number;
  spawnedBy?: string;
  acp?: {
    state?: string;
    lastActivityAt?: number;
    lastError?: string;
    identity?: {
      acpxRecordId?: string;
      acpxSessionId?: string;
    };
  };
};

type ResolvedSessionFile = {
  sessionFile: string;
  sessionId?: string;
  exists: boolean;
  source: "registry-session-file" | "registry-session-id" | "child-session-key" | "mtime-heuristic" | "missing";
  registryState?: string;
  registryLastError?: string;
  acpxRecordId?: string;
  updatedAt?: number;
};

type ResolvedAcpStreamProgress = {
  promptSent: boolean;
  completed: boolean;
  text: string;
  backendSessionCreated: boolean;
  backendSessionId?: string;
};

type ResolvedAcpRecordSummary = {
  exists: boolean;
  pid?: number;
  pidAlive?: boolean;
  closed?: boolean;
  messageCount?: number;
  updatedAt?: string;
  createdAt?: string;
  lastSeq?: number;
  agentCommand?: string;
  acpSessionId?: string;
  cwd?: string;
  lastAgentExitAt?: string;
  lastAgentExitCode?: number;
  lastAgentDisconnectReason?: string;
};

type ResolvedAcpEventLockSummary = {
  exists: boolean;
  pid?: number;
  pidAlive?: boolean;
  createdAt?: string;
};

type ResolvedLocalSessionTerminalState =
  | {
      kind: "api_error";
      text: string;
      sessionFile: string;
      runtimeLabel: string;
    }
  | {
      kind: "tool_error";
      text: string;
      sessionFile: string;
      runtimeLabel: string;
    }
  | {
      kind: "runtime_error";
      text: string;
      sessionFile: string;
      runtimeLabel: string;
    }
  | {
      kind: "assistant_final";
      text: string;
      sessionFile: string;
      runtimeLabel: string;
    }
  | {
      kind: "needs_user_input";
      text: string;
      sessionFile: string;
      runtimeLabel: string;
    }
  | {
      kind: "stalled_nonterminal";
      text: string;
      sessionFile: string;
      runtimeLabel: string;
    };

type ResolvedClaudeSessionTerminalState = ResolvedLocalSessionTerminalState;

type PromptConversationInfo = {
  messageId?: string;
  senderId?: string;
};

type PendingStructuredSpawnMonitor = {
  responseMode: StructuredResponseMode;
  callback?: StructuredDiscordCallback;
  outputDir?: string;
  structured?: StructuredAcpRequest;
};

type ResolvedHandoffRequest = {
  task: string;
  childAgentIdOverride?: string;
  structured?: StructuredAcpRequest;
};

const latestPromptConversationInfoBySessionKey = new Map<string, PromptConversationInfo>();
const pendingStructuredSpawnMonitorsByKey = new Map<string, PendingStructuredSpawnMonitor[]>();
const pendingAcpoffReturnGuardsBySpawnKey = new Set<string>();
const activeAcpoffReturnGuardsByTurnKey = new Map<string, { childSessionKey?: string }>();
const ACP_CHILD_COMPLETION_MAX_WAIT_MS = 90 * 60 * 1000;
const ACP_CHILD_POLL_INTERVAL_MS = 2000;
const ACP_CHILD_STALE_DIAGNOSTIC_MIN_WAIT_MS = 60_000;
const ACP_CHILD_LOCAL_STALE_DIAGNOSTIC_MS = 60_000;

function resolveOpenClawRoot(api: OpenClawPluginApi): string {
  return api.resolvePath("~/.openclaw");
}

// ── session-key persistence ──────────────────────────────────────────────────

type SessionKeyStore = {
  acpSessionId: string;
  agentId: string;
  fixedName: string;
  storedAt: number;
  turnCount: number;
};

function buildSessionKeyStorePath(openclawRoot: string, agentId: string, fixedName: string): string {
  const safeName = fixedName.replace(/[^A-Za-z0-9_-]/g, "_");
  const safeAgent = agentId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(openclawRoot, "acp-handoff", "session-keys", `${safeAgent}-${safeName}.json`);
}

async function storeSessionKey(
  openclawRoot: string,
  agentId: string,
  fixedName: string,
  acpSessionId: string,
  turnCount: number,
): Promise<void> {
  const storePath = buildSessionKeyStorePath(openclawRoot, agentId, fixedName);
  const store: SessionKeyStore = { acpSessionId, agentId, fixedName, storedAt: Date.now(), turnCount };
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

async function readStoredSessionKey(
  openclawRoot: string,
  agentId: string,
  fixedName: string,
): Promise<SessionKeyStore | null> {
  const storePath = buildSessionKeyStorePath(openclawRoot, agentId, fixedName);
  try {
    const content = await readFile(storePath, "utf8");
    const parsed = JSON.parse(content) as SessionKeyStore;
    if (!parsed || typeof parsed.acpSessionId !== "string") return null;
    const turnCount = typeof parsed.turnCount === "number" && parsed.turnCount >= 1 ? parsed.turnCount : 1;
    return { ...parsed, turnCount };
  } catch {
    return null;
  }
}

async function findAcpxSessionId(
  acpxRoot: string,
  childSessionKey: string,
): Promise<string | undefined> {
  const indexPath = path.join(acpxRoot, "sessions", "index.json");
  try {
    const content = await readFile(indexPath, "utf8");
    const index = JSON.parse(content) as { entries?: Array<Record<string, unknown>> };
    const entry = index.entries?.find((e) => e.name === childSessionKey);
    const acpSessionId = entry?.acpSessionId ?? entry?.acp_session_id;
    return typeof acpSessionId === "string" && acpSessionId.trim() ? acpSessionId.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ── acpx binary resolution ───────────────────────────────────────────────────

function resolveAcpxBin(api: OpenClawPluginApi): string {
  const configuredCommand = (api.config.plugins?.entries?.acpx as Record<string, unknown> | undefined)?.command;
  if (typeof configuredCommand === "string" && configuredCommand.trim()) {
    return configuredCommand.trim();
  }
  // 尝试 load.paths 中的 acpx 扩展路径
  const loadPaths = (api.config.plugins as Record<string, unknown> | undefined)?.load as
    | { paths?: string[] }
    | undefined;
  for (const loadPath of loadPaths?.paths ?? []) {
    if (loadPath.includes("acpx")) {
      const resolved = api.resolvePath(loadPath);
      return path.join(resolved, "node_modules", ".bin", "acpx");
    }
  }
  return api.resolvePath("~/.npm-global/lib/node_modules/openclaw/extensions/acpx/node_modules/.bin/acpx");
}

async function setAcpxModel(
  api: OpenClawPluginApi,
  agentId: string,
  childSessionKey: string,
  model: string,
  cwd: string,
): Promise<void> {
  const acpxBin = resolveAcpxBin(api);
  // acpx <agentId> set model <value> --session <childSessionKey>
  const args = [agentId, "set", "model", model, "--session", childSessionKey];
  await new Promise<void>((resolve) => {
    const child = execFile(acpxBin, args, { cwd, timeout: 10_000 }, (error) => {
      if (error) {
        api.logger.warn(`acp-handoff: set model failed for ${childSessionKey}: ${String(error)}`);
      } else {
        api.logger.info(`acp-handoff: set model ${model} for session ${childSessionKey}`);
      }
      resolve();
    });
    void child;
  });
}

// ────────────────────────────────────────────────────────────────────────────

function resolveAcpxRoot(api: OpenClawPluginApi): string {
  return path.join(path.dirname(resolveOpenClawRoot(api)), ".acpx");
}

function resolveClaudeProjectsRoot(api: OpenClawPluginApi): string {
  return path.join(api.resolvePath("~"), ".claude", "projects");
}

function encodeClaudeProjectDir(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9_-]/g, "-");
}

function buildClaudeSessionFilePath(
  api: OpenClawPluginApi,
  acpSessionId?: string,
  cwd?: string,
): string | null {
  const sessionId = acpSessionId?.trim();
  const sessionCwd = cwd?.trim();
  if (!sessionId || !sessionCwd) {
    return null;
  }
  return path.join(
    resolveClaudeProjectsRoot(api),
    encodeClaudeProjectDir(sessionCwd),
    `${sessionId}.jsonl`,
  );
}

function resolveCopilotSessionStateRoot(api: OpenClawPluginApi): string {
  return path.join(api.resolvePath("~"), ".copilot", "session-state");
}

function buildCopilotSessionFilePath(api: OpenClawPluginApi, acpSessionId?: string): string | null {
  const sessionId = acpSessionId?.trim();
  if (!sessionId) {
    return null;
  }
  return path.join(resolveCopilotSessionStateRoot(api), sessionId, "events.jsonl");
}

function parseConversationInfoFromPrompt(prompt: unknown): PromptConversationInfo | null {
  if (typeof prompt !== "string") {
    return null;
  }
  const match = prompt.match(
    /Conversation info \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/i,
  );
  if (!match?.[1]) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    const messageId = typeof parsed.message_id === "string" ? parsed.message_id : undefined;
    const senderId = typeof parsed.sender_id === "string" ? parsed.sender_id : undefined;
    if (!messageId && !senderId) {
      return null;
    }
    return { messageId, senderId };
  } catch {
    return null;
  }
}

function rememberPromptConversationInfo(sessionKey: string, prompt: unknown) {
  const parsed = parseConversationInfoFromPrompt(prompt);
  if (parsed) {
    latestPromptConversationInfoBySessionKey.set(sessionKey, parsed);
  }
}

function stripTrailingInjectedReminders(text: string): string {
  let current = text;
  let previous = "";

  while (current !== previous) {
    previous = current;
    current = current
      .replace(/\n*<execution_reminders>\s*[\s\S]*?<\/execution_reminders>\s*$/i, "")
      .replace(/\n*<reminder>\s*[\s\S]*?<\/reminder>\s*$/i, "")
      .trimEnd();
  }

  return current;
}

function extractVisibleUserPromptText(prompt: unknown): string | null {
  if (typeof prompt !== "string") {
    return null;
  }

  const stripped = prompt
    .replace(/(?:^|\n)Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "\n")
    .replace(/(?:^|\n)Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "\n")
    .replace(/(?:^|\n)Replied message \(untrusted, for context\):\s*```json[\s\S]*?```\s*/gi, "\n")
    .trim();

  const normalized = stripTrailingInjectedReminders(stripped)
    .trim();

  return normalized || null;
}

function extractAcpoffTaskBody(visiblePrompt: string): string | null {
  if (!/\bacpoff\b/i.test(visiblePrompt)) {
    return null;
  }

  let taskBody = sliceFromAcpoffInvocation(visiblePrompt);
  const embeddedPromptCue =
    /(?:完整(?:的)?提示词|具体给子任务的(?:完整)?提示词|提示词如下|prompt如下|prompt below|交给\s*cli|给到它|原样透传)/i;
  if (embeddedPromptCue.test(taskBody)) {
    const fencedBlocks = [...taskBody.matchAll(/```(?:[^\n`]*)\n?([\s\S]*?)```/g)];
    const embeddedPrompt = fencedBlocks.at(-1)?.[1]?.trim();
    if (embeddedPrompt) {
      return embeddedPrompt;
    }
  }

  taskBody = taskBody.replace(/^(?:请)?(?:(?:使用|用|通过)\s*)?acpoff[\s，,：:、]*/i, "");
  taskBody = taskBody.replace(/^(?:请)?(?:调用|使用|用)\s*[A-Za-z][A-Za-z0-9_-]*\s*命令[\s，,：:、]*/i, "");
  taskBody = taskBody.replace(/^(?:来)?(?:创建|新建|开|启动)(?:一个)?(?:子任务|acp子任务|acpoff子任务|cli子任务)[\s，,：:、。]*/i, "");
  taskBody = taskBody.replace(/^(?:并|然后|再|接着)\s*/i, "");
  taskBody = taskBody.replace(/^(?:让它|让子任务|让cli|让子会话)(?:去)?[\s，,：:、]*/i, "");
  taskBody = taskBody.replace(/^[，,：:、。\s]+/, "").trim();
  taskBody = taskBody.replace(
    /^(?:要求)?(?:这个)?(?:子任务|acp子任务|acpoff子任务|cli子任务|子会话)(?:[（(]\s*与你无关了\s*[）)])?(?:去)?[\s。；;，,：:、]*/i,
    "",
  );
  taskBody = taskBody.replace(/^[，,：:、。\s]+/, "").trim();

  return taskBody || null;
}

function looksLikeAcpoffWrapper(taskBody: string): boolean {
  return /(?:使用|用|通过)\s*acpoff|(?:调用|使用|用)\s*[A-Za-z][A-Za-z0-9_-]*\s*命令|(?:创建|新建|启动)(?:一个)?(?:子任务|子会话)|具体给子任务|完整(?:的)?提示词(?:如下)?|交给\s*cli|给到它|原样透传/i.test(
    taskBody,
  );
}

function containsStructuredAcpRequest(text: string): boolean {
  return /<acp_request\b/i.test(text);
}

function preferExactUserPrompt(snapshotPrompt: string, requestedTask: string): string {
  const visiblePrompt = extractVisibleUserPromptText(snapshotPrompt);
  if (visiblePrompt) {
    const taskBody = extractAcpoffTaskBody(visiblePrompt);
    if (taskBody && !looksLikeAcpoffWrapper(taskBody)) {
      return taskBody;
    }
  }
  return requestedTask;
}

function buildResolvedStructuredRequest(structured: StructuredAcpRequest): ResolvedHandoffRequest {
  const childAgentIdOverride = structured.agentId
    ? canonicalizeLauncherName(normalizeLauncherName(structured.agentId))
    : null;
  if (structured.agentId && !childAgentIdOverride) {
    throw new StructuredAcpRequestError(`Invalid structured ACP agentId: ${structured.agentId}`);
  }
  return {
    task: structured.task,
    ...(childAgentIdOverride ? { childAgentIdOverride } : {}),
    structured,
  };
}

function resolveRequestedTask(snapshotPrompt: string, requestedTask: string): ResolvedHandoffRequest {
  const trimmedTask = requestedTask.trim();
  if (containsStructuredAcpRequest(trimmedTask)) {
    const structured = parseStructuredAcpRequest(trimmedTask);
    if (!structured) {
      throw new StructuredAcpRequestError("Structured ACP request could not be parsed from inline task text.");
    }
    return buildResolvedStructuredRequest(structured);
  }

  if (trimmedTask.includes(CRON_STRUCTURED_REQUEST_MARKER)) {
    const visiblePrompt = extractVisibleUserPromptText(snapshotPrompt) ?? snapshotPrompt;
    const structured = parseStructuredAcpRequest(visiblePrompt);
    if (!structured) {
      throw new StructuredAcpRequestError(
        "Structured ACP marker was used, but no <acp_request> block was found in the parent prompt.",
      );
    }
    return buildResolvedStructuredRequest(structured);
  }

  return { task: preferExactUserPrompt(snapshotPrompt, trimmedTask) };
}

function buildPendingSpawnQueueKey(event: { runId?: unknown }, ctx: Record<string, unknown>): string {
  const agentId = typeof ctx.agentId === "string" ? ctx.agentId.trim() : "";
  const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  const runId =
    (typeof ctx.runId === "string" ? ctx.runId.trim() : "") ||
    (typeof event.runId === "string" ? event.runId.trim() : "");
  return `${agentId}::${sessionKey}::${runId}::sessions_spawn`;
}

function buildToolCallTurnKey(event: { runId?: unknown }, ctx: Record<string, unknown>): string {
  const agentId = typeof ctx.agentId === "string" ? ctx.agentId.trim() : "";
  const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  const runId =
    (typeof ctx.runId === "string" ? ctx.runId.trim() : "") ||
    (typeof event.runId === "string" ? event.runId.trim() : "");
  return `${agentId}::${sessionKey}::${runId}`;
}

function enqueuePendingStructuredSpawn(key: string, entry: PendingStructuredSpawnMonitor) {
  const queue = pendingStructuredSpawnMonitorsByKey.get(key) ?? [];
  queue.push(entry);
  pendingStructuredSpawnMonitorsByKey.set(key, queue);
}

function dequeuePendingStructuredSpawn(key: string): PendingStructuredSpawnMonitor | undefined {
  const queue = pendingStructuredSpawnMonitorsByKey.get(key);
  if (!queue?.length) {
    return undefined;
  }
  const next = queue.shift();
  if (queue.length === 0) {
    pendingStructuredSpawnMonitorsByKey.delete(key);
  } else {
    pendingStructuredSpawnMonitorsByKey.set(key, queue);
  }
  return next;
}

async function writeHandoffArtifact(outputDir: string, fileName: string, content: string): Promise<string> {
  const relativePath = path.join(...HANDOFF_DIR, fileName);
  const absolutePath = path.join(outputDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return relativePath.split(path.sep).join("/");
}

function buildPendingSpawnRegistryPath(workspaceDir: string): string {
  return path.join(workspaceDir, ...HANDOFF_DIR, PENDING_SPAWN_REGISTRY_FILE);
}

async function readPendingStructuredSpawnRegistry(
  workspaceDir: string,
): Promise<Record<string, PendingStructuredSpawnMonitor[]>> {
  try {
    const content = await readFile(buildPendingSpawnRegistryPath(workspaceDir), "utf8");
    const parsed = JSON.parse(content) as Record<string, PendingStructuredSpawnMonitor[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function persistPendingStructuredSpawn(
  workspaceDir: string,
  key: string,
  entry: PendingStructuredSpawnMonitor,
): Promise<void> {
  const registryPath = buildPendingSpawnRegistryPath(workspaceDir);
  const registry = await readPendingStructuredSpawnRegistry(workspaceDir);
  const queue = Array.isArray(registry[key]) ? registry[key] : [];
  queue.push(entry);
  registry[key] = queue;
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");
}

async function takePersistedPendingStructuredSpawn(
  workspaceDir: string,
  key: string,
): Promise<PendingStructuredSpawnMonitor | undefined> {
  const registryPath = buildPendingSpawnRegistryPath(workspaceDir);
  const registry = await readPendingStructuredSpawnRegistry(workspaceDir);
  const queue = Array.isArray(registry[key]) ? registry[key] : [];
  if (!queue.length) {
    return undefined;
  }
  const next = queue.shift();
  if (queue.length === 0) {
    delete registry[key];
  } else {
    registry[key] = queue;
  }
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");
  return next;
}

async function readSessionRegistry(
  api: OpenClawPluginApi,
  agentId: string,
): Promise<Record<string, SessionRegistryEntry> | null> {
  const sessionIndexFile = path.join(resolveOpenClawRoot(api), "agents", agentId, "sessions", "sessions.json");
  try {
    const content = await readFile(sessionIndexFile, "utf8");
    const parsed = JSON.parse(content) as Record<string, SessionRegistryEntry>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    api.logger.warn(`acp-handoff: failed to read session registry for ${agentId}: ${String(error)}`);
    return null;
  }
}

async function readSessionRegistryEntry(
  api: OpenClawPluginApi,
  agentId: string,
  sessionKey: string,
): Promise<SessionRegistryEntry | null> {
  const registry = await readSessionRegistry(api, agentId);
  const entry = registry?.[sessionKey];
  return entry && typeof entry === "object" ? entry : null;
}

function buildAgentSessionsDir(api: OpenClawPluginApi, agentId: string): string {
  return path.join(resolveOpenClawRoot(api), "agents", agentId, "sessions");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function chooseHeuristicSessionFile(
  sessionsDir: string,
  updatedAt?: number,
): Promise<{ sessionFile: string; sessionId?: string } | null> {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    return null;
  }

  let entries: string[] = [];
  try {
    entries = (await readdir(sessionsDir)).filter((entry) => entry.endsWith(".jsonl"));
  } catch {
    return null;
  }

  const candidates: Array<{ sessionFile: string; sessionId: string }> = [];
  for (const entry of entries) {
    const sessionFile = path.join(sessionsDir, entry);
    try {
      const fileStat = await stat(sessionFile);
      if (Math.abs(fileStat.mtimeMs - updatedAt) <= 30_000) {
        candidates.push({
          sessionFile,
          sessionId: path.basename(entry, path.extname(entry)),
        });
      }
    } catch {
      continue;
    }
  }

  if (candidates.length !== 1) {
    return null;
  }

  return candidates[0];
}

function resolveDiscordBindingAccountId(api: OpenClawPluginApi, agentId: string): string | undefined {
  const bindings = Array.isArray((api.config as Record<string, unknown>).bindings)
    ? ((api.config as Record<string, unknown>).bindings as Array<Record<string, unknown>>)
    : [];
  const binding = bindings.find(
    (entry) =>
      entry.agentId === agentId &&
      typeof entry.match === "object" &&
      entry.match !== null &&
      (entry.match as Record<string, unknown>).channel === "discord",
  );
  const match = binding?.match as Record<string, unknown> | undefined;
  return typeof match?.accountId === "string" ? match.accountId : undefined;
}

function extractDiscordChannelId(target: unknown): string | undefined {
  if (typeof target !== "string") {
    return undefined;
  }
  const normalized = target.trim();
  if (!normalized.startsWith("channel:")) {
    return undefined;
  }
  const channelId = normalized.slice("channel:".length).trim();
  return channelId || undefined;
}

async function resolveSessionFileFromSessionKey(
  childSessionKey: string,
  api: OpenClawPluginApi,
): Promise<ResolvedSessionFile> {
  const parts = childSessionKey.split(":");
  if (parts.length < 4) {
    throw new Error(`Invalid childSessionKey format: ${childSessionKey}`);
  }
  const childAgentId = parts[1]?.trim();
  if (!childAgentId) {
    throw new Error(`Unable to determine child agent from ${childSessionKey}`);
  }

  const entry = await readSessionRegistryEntry(api, childAgentId, childSessionKey);
  const sessionsDir = buildAgentSessionsDir(api, childAgentId);
  const registryState = typeof entry?.acp?.state === "string" ? entry.acp.state : undefined;
  const registryLastError = typeof entry?.acp?.lastError === "string" ? entry.acp.lastError : undefined;
  const acpxRecordId =
    (typeof entry?.acp?.identity?.acpxRecordId === "string" ? entry.acp.identity.acpxRecordId : undefined) ??
    (typeof entry?.acp?.identity?.acpxSessionId === "string" ? entry.acp.identity.acpxSessionId : undefined);
  const updatedAt = typeof entry?.updatedAt === "number" ? entry.updatedAt : undefined;
  const sessionFile = typeof entry?.sessionFile === "string" ? entry.sessionFile.trim() : "";
  if (sessionFile && (await pathExists(sessionFile))) {
    return {
      sessionFile,
      sessionId: path.basename(sessionFile, path.extname(sessionFile)),
      exists: true,
      source: "registry-session-file",
      registryState,
      registryLastError,
      acpxRecordId,
      updatedAt,
    };
  }

  const registrySessionId = typeof entry?.sessionId === "string" ? entry.sessionId.trim() : "";
  if (registrySessionId) {
    const registrySessionFile = path.join(sessionsDir, `${registrySessionId}.jsonl`);
    if (await pathExists(registrySessionFile)) {
      return {
        sessionFile: registrySessionFile,
        sessionId: registrySessionId,
        exists: true,
        source: "registry-session-id",
        registryState,
        registryLastError,
        acpxRecordId,
        updatedAt,
      };
    }
  }

  const fallbackSessionId = parts[parts.length - 1]?.trim();
  if (!fallbackSessionId) {
    throw new Error(`Unable to determine child session id from ${childSessionKey}`);
  }
  const fallbackSessionFile = path.join(sessionsDir, `${fallbackSessionId}.jsonl`);
  if (await pathExists(fallbackSessionFile)) {
    return {
      sessionFile: fallbackSessionFile,
      sessionId: fallbackSessionId,
      exists: true,
      source: "child-session-key",
      registryState,
      registryLastError,
      acpxRecordId,
      updatedAt,
    };
  }

  const heuristicMatch = await chooseHeuristicSessionFile(sessionsDir, updatedAt);
  if (heuristicMatch) {
    return {
      sessionFile: heuristicMatch.sessionFile,
      sessionId: heuristicMatch.sessionId,
      exists: true,
      source: "mtime-heuristic",
      registryState,
      registryLastError,
      acpxRecordId,
      updatedAt,
    };
  }

  return {
    sessionFile: sessionFile || fallbackSessionFile,
    sessionId: registrySessionId || fallbackSessionId,
    exists: false,
    source: "missing",
    registryState,
    registryLastError,
    acpxRecordId,
    updatedAt,
  };
}

function normalizeAcpFailureMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^Internal error:\s*/i, "");
}

async function resolveDetailedAcpFailure(
  api: OpenClawPluginApi,
  acpxRecordId?: string,
): Promise<string | null> {
  const recordId = acpxRecordId?.trim();
  if (!recordId) {
    return null;
  }
  const streamPath = path.join(resolveAcpxRoot(api), "sessions", `${recordId}.stream.ndjson`);
  try {
    const content = await readFile(streamPath, "utf8");
    const errors = content
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, any>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, any> => Boolean(entry?.error))
      .map((entry) => entry.error as { code?: number; message?: string });
    const preferred =
      [...errors].reverse().find((error) => typeof error.message === "string" && error.code !== -32002) ??
      [...errors].reverse().find((error) => typeof error.message === "string");
    const message = typeof preferred?.message === "string" ? normalizeAcpFailureMessage(preferred.message) : "";
    return message || null;
  } catch {
    return null;
  }
}

function extractStreamTextChunk(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const content = (value as Record<string, any>).content;
  if (typeof content === "string") {
    return content;
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  if (typeof (value as Record<string, any>).text === "string") {
    return (value as Record<string, any>).text;
  }
  return "";
}

async function resolveAcpStreamProgress(
  api: OpenClawPluginApi,
  acpxRecordId?: string,
): Promise<ResolvedAcpStreamProgress | null> {
  const recordId = acpxRecordId?.trim();
  if (!recordId) {
    return null;
  }

  const streamPath = path.join(resolveAcpxRoot(api), "sessions", `${recordId}.stream.ndjson`);
  try {
    const content = await readFile(streamPath, "utf8");
    let promptSent = false;
    let completed = false;
    let backendSessionCreated = false;
    let backendSessionId: string | undefined;
    const outputChunks: string[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: Record<string, any> | null = null;
      try {
        parsed = JSON.parse(trimmed) as Record<string, any>;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      if (parsed.method === "session/prompt") {
        promptSent = true;
      }

      if (
        parsed.result &&
        typeof parsed.result === "object" &&
        typeof parsed.result.sessionId === "string" &&
        parsed.result.sessionId.trim()
      ) {
        backendSessionCreated = true;
        backendSessionId = parsed.result.sessionId.trim();
      }

      if (parsed.method === "session/update") {
        const update = parsed.params?.update;
        if (update?.sessionUpdate === "agent_message_chunk") {
          const chunk = extractStreamTextChunk(update);
          if (chunk) {
            outputChunks.push(chunk);
          }
        }
      }

      if (
        parsed.result &&
        typeof parsed.result === "object" &&
        typeof parsed.result.stopReason === "string"
      ) {
        completed = true;
      }
    }

    return {
      promptSent,
      completed,
      text: outputChunks.join("").trim(),
      backendSessionCreated,
      backendSessionId,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function resolveAcpRecordSummary(
  api: OpenClawPluginApi,
  acpxRecordId?: string,
): Promise<ResolvedAcpRecordSummary | null> {
  const recordId = acpxRecordId?.trim();
  if (!recordId) {
    return null;
  }

  const recordPath = path.join(resolveAcpxRoot(api), "sessions", `${recordId}.json`);
  try {
    const raw = await readFile(recordPath, "utf8");
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      closed?: unknown;
      messages?: unknown;
      updated_at?: unknown;
      created_at?: unknown;
      last_seq?: unknown;
      agent_command?: unknown;
      acp_session_id?: unknown;
      cwd?: unknown;
      last_agent_exit_at?: unknown;
      last_agent_exit_code?: unknown;
      last_agent_disconnect_reason?: unknown;
    };
    const pid = typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
    const messages = Array.isArray(parsed.messages) ? parsed.messages.length : undefined;
    return {
      exists: true,
      pid,
      pidAlive: pid !== undefined ? isProcessAlive(pid) : undefined,
      closed: typeof parsed.closed === "boolean" ? parsed.closed : undefined,
      messageCount: messages,
      updatedAt: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
      createdAt: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
      lastSeq: typeof parsed.last_seq === "number" ? parsed.last_seq : undefined,
      agentCommand: typeof parsed.agent_command === "string" ? parsed.agent_command : undefined,
      acpSessionId: typeof parsed.acp_session_id === "string" ? parsed.acp_session_id : undefined,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      lastAgentExitAt: typeof parsed.last_agent_exit_at === "string" ? parsed.last_agent_exit_at : undefined,
      lastAgentExitCode:
        typeof parsed.last_agent_exit_code === "number" && Number.isInteger(parsed.last_agent_exit_code)
          ? parsed.last_agent_exit_code
          : undefined,
      lastAgentDisconnectReason:
        typeof parsed.last_agent_disconnect_reason === "string"
          ? parsed.last_agent_disconnect_reason
          : undefined,
    };
  } catch {
    return null;
  }
}

function extractClaudeSessionText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is {
        type?: unknown;
        text?: unknown;
      } => typeof block === "object" && block !== null,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

function extractClaudeApiReason(rawText: string): string | null {
  const text = rawText.trim();
  if (!text) {
    return null;
  }

  const htmlTitleMatch = text.match(/<title>([^<]+)<\/title>/i) || text.match(/<h1>([^<]+)<\/h1>/i);
  if (htmlTitleMatch?.[1]) {
    return htmlTitleMatch[1].trim().replace(/^\d{3}\s+/, "");
  }

  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    const jsonSlice = text.slice(jsonStart, jsonEnd + 1);
    try {
      const parsed = JSON.parse(jsonSlice) as {
        error?: unknown;
      };
      let reason: string | null = null;
      if (typeof parsed.error === "string") {
        reason = parsed.error;
      } else if (parsed.error && typeof parsed.error === "object") {
        const nested = parsed.error as {
          message?: unknown;
          code?: unknown;
        };
        if (typeof nested.message === "string" && nested.message.trim()) {
          reason = nested.message.trim();
        } else if (typeof nested.code === "string" && nested.code.trim()) {
          reason = nested.code.trim();
        }
      }
      const suffix = text.slice(jsonEnd + 1).replace(/^[\s·•:：-]+/, "").trim();
      if (reason && suffix) {
        return `${reason} · ${suffix}`;
      }
      if (reason) {
        return reason;
      }
      if (suffix) {
        return suffix;
      }
    } catch {
      // fall through to first-line fallback
    }
  }

  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) {
    return null;
  }
  return firstLine.replace(/^API Error:\s*(?:\d+\s*)?/i, "").trim() || null;
}

function extractClaudeApiVendorCode(rawText: string): string | null {
  const text = rawText.trim();
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
      error?: unknown;
    };
    if (parsed.error && typeof parsed.error === "object") {
      const nested = parsed.error as {
        code?: unknown;
      };
      return typeof nested.code === "string" && nested.code.trim() ? nested.code.trim() : null;
    }
  } catch {
    return null;
  }
  return null;
}

function classifyClaudeApiFailure(
  status: string | null,
  reason: string | null,
  vendorCode: string | null,
): string | null {
  const haystack = `${status ?? ""} ${vendorCode ?? ""} ${reason ?? ""}`.toLowerCase();

  if (
    /insufficient credits|insufficient balance|balance|credit|quota exceeded|payment required|余额|计费不足|余额不足/.test(
      haystack,
    ) ||
    status === "402"
  ) {
    return "余额、计费或配额不足";
  }
  if (
    /authentication_failed|unauthorized|forbidden|please run \/login|api key|token|login|被封禁|无权限|权限问题|permission|access denied|denied/.test(
      haystack,
    ) ||
    status === "401" ||
    status === "403"
  ) {
    return "认证或权限问题";
  }
  if (
    /model_not_found|not found|resource not found|endpoint|unsupported model|不存在|无可用渠道|distributor/.test(
      haystack,
    ) ||
    status === "404"
  ) {
    return "模型、资源或渠道不可用";
  }
  if (
    /rate limit|too many requests|throttl|套餐暂未开放|subscription|plan|1311/.test(haystack) ||
    status === "429"
  ) {
    return "限流、套餐权限或配额问题";
  }
  if (
    /bad gateway|gateway|openresty|upstream|timeout|timed out|connection|network/.test(haystack) ||
    status === "500" ||
    status === "502" ||
    status === "503" ||
    status === "504"
  ) {
    return "上游服务或网络异常";
  }
  if (status?.startsWith("4")) {
    return "请求或配置错误";
  }
  if (status?.startsWith("5")) {
    return "上游服务异常";
  }
  return null;
}

function buildClaudeApiPrefix(status: string | null, category: string | null): string {
  if (status && category) {
    return `Claude Code 会话失败：API Error ${status}（${category}）`;
  }
  if (status) {
    return `Claude Code 会话失败：API Error ${status}`;
  }
  if (category) {
    return `Claude Code 会话失败（${category}）`;
  }
  return "Claude Code 会话失败";
}

function summarizeClaudeApiError(rawText: string): string {
  const text = rawText.trim();
  if (!text) {
    return "Claude Code 会话失败：上游 API 返回空错误响应。";
  }
  const status = text.match(/API Error:\s*(\d{3})/i)?.[1] ?? null;
  const reason = extractClaudeApiReason(text);
  const vendorCode = extractClaudeApiVendorCode(text);
  const category = classifyClaudeApiFailure(status, reason, vendorCode);
  const prefix = buildClaudeApiPrefix(status, category);
  return reason ? `${prefix}：${reason}` : prefix;
}

function normalizeClaudeToolError(text: string): string {
  return text
    .replace(/<\/?tool_use_error>/gi, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

function extractClaudeToolErrorFromEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const parsed = entry as {
    type?: unknown;
    toolUseResult?: unknown;
    message?: {
      role?: unknown;
      content?: unknown;
    };
  };

  if (typeof parsed.toolUseResult === "string" && parsed.toolUseResult.trim()) {
    return normalizeClaudeToolError(parsed.toolUseResult);
  }

  if (parsed.type !== "user" || parsed.message?.role !== "user" || !Array.isArray(parsed.message?.content)) {
    return null;
  }

  for (const block of parsed.message.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const toolResultBlock = block as {
      type?: unknown;
      is_error?: unknown;
      content?: unknown;
    };
    if (toolResultBlock.type !== "tool_result" || toolResultBlock.is_error !== true) {
      continue;
    }
    const content =
      typeof toolResultBlock.content === "string"
        ? toolResultBlock.content
        : extractClaudeSessionText(toolResultBlock.content);
    const normalized = normalizeClaudeToolError(content);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function classifyClaudeToolFailure(errorText: string, assistantText?: string | null): string {
  const haystack = `${errorText} ${assistantText ?? ""}`.toLowerCase();
  if (/read it first before writing|not been read yet|先读取/.test(haystack)) {
    return "文件读写规则问题";
  }
  if (/permission denied|access denied|not allowed|请确认是否继续|获得用户确认|confirm/.test(haystack)) {
    return "权限或确认问题";
  }
  if (/no such file|not found|路径不存在|file not found/.test(haystack)) {
    return "路径或文件不存在";
  }
  return "工具执行问题";
}

function summarizeClaudeToolError(errorText: string, assistantText?: string | null): string {
  const normalizedError = normalizeClaudeToolError(errorText);
  const category = classifyClaudeToolFailure(normalizedError, assistantText);
  const normalizedAssistant = assistantText?.trim();
  if (normalizedAssistant) {
    return `Claude Code 会话失败（${category}）：${normalizedError}；assistant 回复：${normalizedAssistant}`;
  }
  return `Claude Code 会话失败（${category}）：${normalizedError}`;
}

function assistantTextSuggestsUserInput(text: string): boolean {
  const haystack = text.toLowerCase();
  return /请确认|确认是否继续|是否继续|confirm|approval|approve|需要你的(?:确认|输入|回复)|等待你的(?:确认|输入|回复)|请提供|请告诉我|告诉我是否|告诉我哪|告诉我什么|which (?:path|option|file)|what (?:path|option|file)|provide (?:the|a).*(?:path|option|file)/.test(
    haystack,
  );
}

function assistantTextSuggestsFailure(text: string): boolean {
  const haystack = text.toLowerCase();
  return /无法|不能|failed|error|需要先|read it first before writing|not been read yet|permission denied|access denied|path does not exist|not found|路径不存在/.test(
    haystack,
  );
}

function summarizeNeedsUserInput(
  runtimeLabel: string,
  assistantText: string,
  contextText?: string | null,
): string {
  const normalizedAssistant = assistantText.trim();
  const normalizedContext = contextText?.trim();
  if (normalizedContext) {
    return `${runtimeLabel} 会话等待用户输入：${normalizedAssistant}；上下文：${normalizedContext}`;
  }
  return `${runtimeLabel} 会话等待用户输入：${normalizedAssistant}`;
}

function truncateDiagnosticText(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function summarizeNonterminalStall(runtimeLabel: string, detail: string): string {
  return `${runtimeLabel} 会话疑似卡住：${detail}`;
}

function describeClaudeNonterminalState(lines: string[], idleMs: number, staleAfterMs: number): string | null {
  if (idleMs < staleAfterMs || lines.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(lines.at(-1) ?? "") as {
      type?: unknown;
      toolUseResult?: unknown;
      message?: {
        role?: unknown;
        stop_reason?: unknown;
        content?: unknown;
      };
    };
    if (parsed.type === "assistant" && parsed.message?.role === "assistant") {
      const text = extractClaudeSessionText(parsed.message?.content).trim();
      if (parsed.message?.stop_reason === null) {
        return summarizeNonterminalStall(
          "Claude Code",
          text ? `最后停在未完成的 assistant 回合：${truncateDiagnosticText(text)}` : "最后停在未完成的 assistant 回合。",
        );
      }
      if (parsed.message?.stop_reason === "tool_use") {
        return summarizeNonterminalStall("Claude Code", "最后停在 tool_use 请求，尚未看到对应结果。");
      }
    }
    if (typeof parsed.toolUseResult === "string" || parsed.message?.role === "user") {
      return summarizeNonterminalStall("Claude Code", "已拿到 tool_result，但后续 assistant 未继续。");
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveClaudeCodeSessionTerminalState(
  api: OpenClawPluginApi,
  acpSessionId?: string,
  cwd?: string,
  staleAfterMs = 0,
): Promise<ResolvedClaudeSessionTerminalState | null> {
  const sessionFile = buildClaudeSessionFilePath(api, acpSessionId, cwd);
  if (!sessionFile) {
    return null;
  }

  try {
    const sessionStats = await stat(sessionFile);
    const raw = await readFile(sessionFile, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let latestAssistantText: string | null = null;
    let latestAssistantNeedsFailure = false;
    let latestAssistantNeedsInput = false;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as {
          type?: unknown;
          isApiErrorMessage?: unknown;
          message?: {
            role?: unknown;
            content?: unknown;
            stop_reason?: unknown;
          };
        };
        if (parsed.isApiErrorMessage === true) {
          const text = extractClaudeSessionText(parsed.message?.content);
          return {
            kind: "api_error",
            text: summarizeClaudeApiError(text),
            sessionFile,
            runtimeLabel: "Claude Code",
          };
        }
        if (!latestAssistantText && parsed.type === "assistant" && parsed.message?.role === "assistant") {
          if (parsed.message?.stop_reason === null) {
            continue;
          }
          if (parsed.message?.stop_reason === "tool_use") {
            continue;
          }
          const text = extractClaudeSessionText(parsed.message?.content).trim();
          if (text) {
            latestAssistantText = text;
            latestAssistantNeedsInput = assistantTextSuggestsUserInput(text);
            latestAssistantNeedsFailure = assistantTextSuggestsFailure(text);
            if (!latestAssistantNeedsInput && !latestAssistantNeedsFailure) {
              return {
                kind: "assistant_final",
                text,
                sessionFile,
                runtimeLabel: "Claude Code",
              };
            }
          }
          continue;
        }
        const toolError = extractClaudeToolErrorFromEntry(parsed);
        if (toolError) {
          if (!latestAssistantText) {
            return {
              kind: "tool_error",
              text: summarizeClaudeToolError(toolError),
              sessionFile,
              runtimeLabel: "Claude Code",
            };
          }
          if (latestAssistantNeedsInput) {
            return {
              kind: "needs_user_input",
              text: summarizeNeedsUserInput("Claude Code", latestAssistantText, toolError),
              sessionFile,
              runtimeLabel: "Claude Code",
            };
          }
          if (latestAssistantNeedsFailure) {
            return {
              kind: "tool_error",
              text: summarizeClaudeToolError(toolError, latestAssistantText),
              sessionFile,
              runtimeLabel: "Claude Code",
            };
          }
        }
      } catch {
        continue;
      }
    }

    if (latestAssistantText) {
      if (latestAssistantNeedsInput) {
        return {
          kind: "needs_user_input",
          text: summarizeNeedsUserInput("Claude Code", latestAssistantText),
          sessionFile,
          runtimeLabel: "Claude Code",
        };
      }
      return {
        kind: "assistant_final",
        text: latestAssistantText,
        sessionFile,
        runtimeLabel: "Claude Code",
      };
    }
    const stalledText = describeClaudeNonterminalState(
      lines,
      Date.now() - sessionStats.mtimeMs,
      staleAfterMs,
    );
    if (stalledText) {
      return {
        kind: "stalled_nonterminal",
        text: stalledText,
        sessionFile,
        runtimeLabel: "Claude Code",
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveClaudeCodeSessionApiError(
  api: OpenClawPluginApi,
  acpSessionId?: string,
  cwd?: string,
): Promise<string | null> {
  const terminalState = await resolveClaudeCodeSessionTerminalState(api, acpSessionId, cwd);
  return terminalState?.kind === "api_error" ? terminalState.text : null;
}

function extractCopilotSessionErrorStatus(message: string, statusCode?: unknown): string | null {
  if (typeof statusCode === "number" && Number.isInteger(statusCode)) {
    return String(statusCode);
  }
  if (typeof statusCode === "string" && /^\d{3}$/.test(statusCode.trim())) {
    return statusCode.trim();
  }
  return (
    message.match(/\bCAPIError:\s*(\d{3})\b/i)?.[1] ??
    message.match(/\bstatus(?: code)?\s*[:=]?\s*(\d{3})\b/i)?.[1] ??
    null
  );
}

function extractCopilotSessionErrorReason(message: string): string | null {
  const text = message.trim();
  if (!text) {
    return null;
  }
  return text
    .replace(/^Execution failed:\s*/i, "")
    .replace(/^CAPIError:\s*\d+\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

function classifyCopilotRuntimeFailure(errorType: string | null, reason: string | null): string {
  const haystack = `${errorType ?? ""} ${reason ?? ""}`.toLowerCase();
  if (/eio|enoent|eacces|i\/o|disk|filesystem|read eio/.test(haystack)) {
    return "I/O 或本地运行时问题";
  }
  if (/assert|assertion/.test(haystack)) {
    return "本地运行时断言异常";
  }
  if (/abort|aborted|cancelled|canceled/.test(haystack)) {
    return "本地运行时中断";
  }
  if (/timeout|timed out/.test(haystack)) {
    return "本地运行时超时";
  }
  return "本地运行时异常";
}

function buildCopilotApiPrefix(status: string | null, category: string | null): string {
  if (status && category) {
    return `Copilot 会话失败：API Error ${status}（${category}）`;
  }
  if (status) {
    return `Copilot 会话失败：API Error ${status}`;
  }
  if (category) {
    return `Copilot 会话失败（${category}）`;
  }
  return "Copilot 会话失败";
}

function summarizeCopilotSessionError(errorType: string | null, message: string, statusCode?: unknown): string {
  const status = extractCopilotSessionErrorStatus(message, statusCode);
  const reason = extractCopilotSessionErrorReason(message);
  const looksLikeApiError = Boolean(status) || errorType === "query" || /capierror|\/chat\/completions|api/i.test(message);
  if (looksLikeApiError) {
    const category = classifyClaudeApiFailure(status, reason, null) ?? (errorType === "query" ? "请求或配置错误" : null);
    const prefix = buildCopilotApiPrefix(status, category);
    return reason ? `${prefix}：${reason}` : prefix;
  }
  const category = classifyCopilotRuntimeFailure(errorType, reason);
  return reason ? `Copilot 会话失败（${category}）：${reason}` : `Copilot 会话失败（${category}）`;
}

function summarizeCopilotToolError(errorText: string, assistantText?: string | null): string {
  const normalizedError = normalizeClaudeToolError(errorText);
  const category = classifyClaudeToolFailure(normalizedError, assistantText);
  const normalizedAssistant = assistantText?.trim();
  if (normalizedAssistant) {
    return `Copilot 会话失败（${category}）：${normalizedError}；assistant 回复：${normalizedAssistant}`;
  }
  return `Copilot 会话失败（${category}）：${normalizedError}`;
}

function extractCopilotToolErrorFromEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const parsed = entry as {
    type?: unknown;
    data?: {
      success?: unknown;
      error?: {
        message?: unknown;
      };
    };
  };
  if (parsed.type !== "tool.execution_complete" || parsed.data?.success !== false) {
    return null;
  }
  const message = parsed.data.error?.message;
  return typeof message === "string" && message.trim() ? normalizeClaudeToolError(message) : null;
}

function describeCopilotNonterminalState(
  lines: string[],
  idleMs: number,
  staleAfterMs: number,
): string | null {
  if (idleMs < staleAfterMs || lines.length === 0) {
    return null;
  }
  const hasTurnMarkers = lines.some((line) => line.includes('"type":"assistant.turn_end"') || line.includes('"type":"assistant.turn_start"'));
  try {
    const parsed = JSON.parse(lines.at(-1) ?? "") as {
      type?: unknown;
      data?: {
        content?: unknown;
      };
    };
    if (parsed.type === "assistant.turn_start") {
      return summarizeNonterminalStall("Copilot", "assistant 回合已开始，但未结束。");
    }
    if (parsed.type === "assistant.message" && hasTurnMarkers) {
      const text = typeof parsed.data?.content === "string" ? parsed.data.content.trim() : "";
      return summarizeNonterminalStall(
        "Copilot",
        text ? `最后停在未结束的 assistant 回合：${truncateDiagnosticText(text)}` : "最后停在未结束的 assistant 回合。",
      );
    }
    if (parsed.type === "tool.execution_start") {
      return summarizeNonterminalStall("Copilot", "工具执行已开始，但未收到完成事件。");
    }
    if (parsed.type === "tool.execution_complete") {
      return summarizeNonterminalStall("Copilot", "工具执行已完成，但 assistant 未继续。");
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveCopilotSessionTerminalState(
  api: OpenClawPluginApi,
  acpSessionId?: string,
  staleAfterMs = 0,
): Promise<ResolvedLocalSessionTerminalState | null> {
  const sessionFile = buildCopilotSessionFilePath(api, acpSessionId);
  if (!sessionFile) {
    return null;
  }

  try {
    const sessionStats = await stat(sessionFile);
    const raw = await readFile(sessionFile, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const hasTurnMarkers = lines.some(
      (line) => line.includes('"type":"assistant.turn_end"') || line.includes('"type":"assistant.turn_start"'),
    );
    let latestAssistantText: string | null = null;
    let latestAssistantNeedsFailureContext = false;
    let latestAssistantNeedsInput = false;
    let sawCompletedAssistantTurn = !hasTurnMarkers;

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as {
          type?: unknown;
          data?: {
            content?: unknown;
            errorType?: unknown;
            message?: unknown;
            statusCode?: unknown;
          };
        };
        if (parsed.type === "assistant.turn_end") {
          sawCompletedAssistantTurn = true;
          continue;
        }
        if (!latestAssistantText && parsed.type === "assistant.message") {
          const text = typeof parsed.data?.content === "string" ? parsed.data.content.trim() : "";
          if (text) {
            if (!sawCompletedAssistantTurn) {
              continue;
            }
            latestAssistantText = text;
            latestAssistantNeedsInput = assistantTextSuggestsUserInput(text);
            latestAssistantNeedsFailureContext = assistantTextSuggestsFailure(text);
            if (!latestAssistantNeedsInput && !latestAssistantNeedsFailureContext) {
              return {
                kind: "assistant_final",
                text,
                sessionFile,
                runtimeLabel: "Copilot",
              };
            }
          }
          continue;
        }

        if (parsed.type === "session.error" && typeof parsed.data?.message === "string" && parsed.data.message.trim()) {
          const errorType =
            typeof parsed.data.errorType === "string" && parsed.data.errorType.trim()
              ? parsed.data.errorType.trim()
              : null;
          const text = summarizeCopilotSessionError(errorType, parsed.data.message, parsed.data.statusCode);
          const kind: ResolvedLocalSessionTerminalState["kind"] =
            extractCopilotSessionErrorStatus(parsed.data.message, parsed.data.statusCode) || errorType === "query"
              ? "api_error"
              : "runtime_error";
          if (!latestAssistantText || latestAssistantNeedsFailureContext || latestAssistantNeedsInput) {
            if (latestAssistantNeedsInput && latestAssistantText) {
              return {
                kind: "needs_user_input",
                text: summarizeNeedsUserInput("Copilot", latestAssistantText, text),
                sessionFile,
                runtimeLabel: "Copilot",
              };
            }
            return {
              kind,
              text,
              sessionFile,
              runtimeLabel: "Copilot",
            };
          }
          continue;
        }

        const toolError = extractCopilotToolErrorFromEntry(parsed);
        if (toolError) {
          if (!latestAssistantText) {
            return {
              kind: "tool_error",
              text: summarizeCopilotToolError(toolError),
              sessionFile,
              runtimeLabel: "Copilot",
            };
          }
          if (latestAssistantNeedsInput) {
            return {
              kind: "needs_user_input",
              text: summarizeNeedsUserInput("Copilot", latestAssistantText, toolError),
              sessionFile,
              runtimeLabel: "Copilot",
            };
          }
          if (latestAssistantNeedsFailureContext) {
            return {
              kind: "tool_error",
              text: summarizeCopilotToolError(toolError, latestAssistantText),
              sessionFile,
              runtimeLabel: "Copilot",
            };
          }
        }
      } catch {
        continue;
      }
    }

    if (latestAssistantText) {
      if (latestAssistantNeedsInput) {
        return {
          kind: "needs_user_input",
          text: summarizeNeedsUserInput("Copilot", latestAssistantText),
          sessionFile,
          runtimeLabel: "Copilot",
        };
      }
      return {
        kind: "assistant_final",
        text: latestAssistantText,
        sessionFile,
        runtimeLabel: "Copilot",
      };
    }
    const stalledText = describeCopilotNonterminalState(
      lines,
      Date.now() - sessionStats.mtimeMs,
      staleAfterMs,
    );
    if (stalledText) {
      return {
        kind: "stalled_nonterminal",
        text: stalledText,
        sessionFile,
        runtimeLabel: "Copilot",
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveLocalAgentTerminalState(
  api: OpenClawPluginApi,
  recordSummary?: ResolvedAcpRecordSummary | null,
  staleAfterMs = 0,
): Promise<ResolvedLocalSessionTerminalState | null> {
  if (!recordSummary) {
    return null;
  }
  const agentCommand = recordSummary.agentCommand?.trim() ?? "";
  if (/\bcopilot\b/.test(agentCommand) && /--acp\b/.test(agentCommand)) {
    return resolveCopilotSessionTerminalState(api, recordSummary.acpSessionId, staleAfterMs);
  }
  return resolveClaudeCodeSessionTerminalState(
    api,
    recordSummary.acpSessionId,
    recordSummary.cwd,
    staleAfterMs,
  );
}

async function resolveAcpEventLockSummary(
  api: OpenClawPluginApi,
  acpxRecordId?: string,
): Promise<ResolvedAcpEventLockSummary | null> {
  const recordId = acpxRecordId?.trim();
  if (!recordId) {
    return null;
  }

  const lockPath = path.join(resolveAcpxRoot(api), "sessions", `${recordId}.stream.lock`);
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      created_at?: unknown;
    };
    const pid = typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
    return {
      exists: true,
      pid,
      pidAlive: pid !== undefined ? isProcessAlive(pid) : undefined,
      createdAt: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
    };
  } catch {
    return null;
  }
}

function describeAcpStalledSession(params: {
  resolved: Pick<ResolvedSessionFile, "sessionFile" | "exists" | "registryState">;
  streamProgress?: ResolvedAcpStreamProgress | null;
  recordSummary?: ResolvedAcpRecordSummary | null;
  eventLockSummary?: ResolvedAcpEventLockSummary | null;
}): string | null {
  const registryState = params.resolved.registryState?.trim() || "unknown";
  const promptSent = params.streamProgress?.promptSent === true;
  const record = params.recordSummary;
  const eventLock = params.eventLockSummary;
  if (promptSent || !record?.exists) {
    return null;
  }
  if (record.closed === true) {
    return null;
  }
  if ((record.messageCount ?? 0) > 0) {
    return null;
  }
  if (eventLock?.exists && eventLock.pidAlive === true && typeof eventLock.pid === "number") {
    return null;
  }
  if (record.pidAlive !== false || typeof record.pid !== "number") {
    return null;
  }

  return `ACP 会话疑似卡死：registry 仍显示 ${registryState}，但 acpx backend pid ${record.pid} 已不存在，且 transcript 未落盘、stream 也未出现 prompt。请重新触发该子会话；这通常不是 child agent 选择错误，而是 ACP runtime 生命周期失活。`;
}

function describeAcpPrePromptRuntimeDeath(params: {
  resolved: Pick<ResolvedSessionFile, "registryState">;
  streamProgress?: ResolvedAcpStreamProgress | null;
  recordSummary?: ResolvedAcpRecordSummary | null;
  eventLockSummary?: ResolvedAcpEventLockSummary | null;
}): string | null {
  const registryState = params.resolved.registryState?.trim() || "unknown";
  const stream = params.streamProgress;
  const record = params.recordSummary;
  const eventLock = params.eventLockSummary;
  if (!record?.exists || stream?.promptSent === true) {
    return null;
  }
  if (record.closed === true) {
    return null;
  }
  if ((record.messageCount ?? 0) > 0) {
    return null;
  }
  if (eventLock?.exists && eventLock.pidAlive === true && typeof eventLock.pid === "number") {
    return null;
  }
  if (record.pidAlive !== false || typeof record.pid !== "number") {
    return null;
  }
  if (!stream?.backendSessionCreated) {
    return null;
  }

  const backendSessionHint = stream.backendSessionId
    ? `，且 backend 已创建 session ${stream.backendSessionId}`
    : "";
  return `ACP 会话在首个 prompt 发送前即异常终止：registry 仍显示 ${registryState}，acpx backend pid ${record.pid} 已不存在${backendSessionHint}，但 stream 只走到了 session/new，未出现 session/prompt。请重新触发该子会话；这通常说明 ACP runtime 在真正投递 handoff prompt 前就已退出。`;
}

const plugin = {
  id: "acp-handoff",
  name: "ACP Handoff",

  register(api: OpenClawPluginApi) {
    pendingAcpoffReturnGuardsBySpawnKey.clear();
    activeAcpoffReturnGuardsByTurnKey.clear();

    api.on("llm_input", async (event, ctx) => {
      const sessionKey = ctx.sessionKey?.trim();
      if (!sessionKey) {
        return;
      }
      rememberPromptConversationInfo(sessionKey, event.prompt);
      const snapshot = createSnapshot({
        runId: event.runId,
        sessionId: event.sessionId,
        sessionKey,
        agentId: ctx.agentId,
        workspaceDir: ctx.workspaceDir,
        provider: event.provider,
        model: event.model,
        imagesCount: event.imagesCount,
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyMessages: event.historyMessages,
      });
      try {
        await storeSnapshot(snapshot);
      } catch (error) {
        api.logger.warn(`acp-handoff: failed to store snapshot: ${String(error)}`);
      }
    });

    api.on("before_tool_call", async (event, ctx) => {
      const turnKey = buildToolCallTurnKey(event, ctx);
      const activeAcpoffReturnGuard = activeAcpoffReturnGuardsByTurnKey.get(turnKey);
      if (activeAcpoffReturnGuard) {
        const childHint = activeAcpoffReturnGuard.childSessionKey
          ? `（child=${activeAcpoffReturnGuard.childSessionKey}）`
          : "";
        return {
          block: true,
          blockReason: `acpoff 子任务已派发${childHint}；当前回合必须立即返回，不要继续调用 ${event.toolName}。如需跟进子会话，请等待后台回调，或在下一轮由用户明确要求“查状态”。`,
        };
      }
      if (event.toolName !== "sessions_spawn" && ACPOFF_PRESPAWN_BLOCKED_TOOLS.has(event.toolName)) {
        const snapshot = await resolveCurrentTurnSnapshot(api, { ...ctx, allowTranscriptFallback: true });
        const visiblePrompt = snapshot ? extractVisibleUserPromptText(snapshot.prompt) ?? snapshot.prompt : "";
        if (/\bacpoff\b/i.test(visiblePrompt)) {
          return {
            block: true,
            blockReason: `当前轮用户已明确要求使用 acpoff；父会话不得改走 ${event.toolName} 本地执行/轮询路径。请直接调用 sessions_spawn（runtime:"acp"），并在 accepted 后立即返回。`,
          };
        }
      }
      if (event.toolName !== "sessions_spawn") {
        return;
      }
      const params = event.params as Record<string, unknown>;
      const normalizedRuntime = normalizeRuntime(params.runtime);
      const rawTask = typeof params.task === "string" ? params.task : "";
      const requestedTaskFromSignal = extractRequestedTask(rawTask);
      const sessionKey = ctx.sessionKey?.trim();
      if (!sessionKey) {
        return {
          block: true,
          blockReason: "ACP handoff requested but parent sessionKey is unavailable.",
        };
      }

      try {
        const parentWorkspaceDir = ctx.workspaceDir || resolveWorkspaceDir(api, ctx.agentId);
        const childCwd = resolveOutputDir(api, params, undefined);
        const runId = ctx.runId?.trim() || event.runId?.trim();

        let snapshot = await resolveCurrentTurnSnapshot(api, {
          runId,
          sessionKey,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          workspaceDir: parentWorkspaceDir,
          requestedTask: requestedTaskFromSignal || rawTask.trim(),
          allowTranscriptFallback: false,
        });
        let snapshotSource: HandoffSnapshotSource = "run-cache";
        if (!snapshot && runId) {
          snapshotSource = "run-cache";
        } else if (!snapshot) {
          snapshotSource = "session-cache";
        } else if (runId) {
          snapshotSource = "run-cache";
        }
        if (!snapshot) {
          snapshot = await readTranscriptFallbackSnapshot({
            agentId: ctx.agentId,
            sessionId: ctx.sessionId,
            sessionKey,
            workspaceDir: parentWorkspaceDir,
            requestedTask: requestedTaskFromSignal || rawTask.trim(),
          });
          snapshotSource = "transcript-fallback";
        }
        if (!snapshot) {
          api.logger.warn(
            `acp-handoff: blocking spawn; no parent snapshot or transcript fallback found for ${sessionKey}`,
          );
          return {
            block: true,
            blockReason:
              "ACP handoff was explicitly requested, but no matching parent snapshot or transcript fallback could be prepared.",
            };
        }

        const visiblePrompt = extractVisibleUserPromptText(snapshot.prompt) ?? snapshot.prompt;
        const acpoffRequestedByUser = /\bacpoff\b/i.test(visiblePrompt);
        const shouldForceAcpRuntime = normalizedRuntime !== "acp" && acpoffRequestedByUser;
        if (normalizedRuntime !== "acp" && !shouldForceAcpRuntime) {
          return;
        }
        let requestedTask = requestedTaskFromSignal;
        if (!requestedTask && acpoffRequestedByUser) {
          requestedTask = extractAcpoffTaskBody(visiblePrompt);
        }
        if (!requestedTask) {
          return;
        }
        if (shouldForceAcpRuntime) {
          api.logger.info(
            `acp-handoff: coercing sessions_spawn runtime from ${normalizedRuntime || "unspecified"} to acp for explicit acpoff request in ${sessionKey}`,
          );
        }

        const outputDir = childCwd || snapshot.workspaceDir || parentWorkspaceDir;
        let handoffRequest: ResolvedHandoffRequest;
        try {
          handoffRequest = resolveRequestedTask(snapshot.prompt, requestedTask);
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message
              : "ACP handoff was explicitly requested, but the request could not be parsed.";
          api.logger.warn(`acp-handoff: blocking spawn; ${reason}`);
          return {
            block: true,
            blockReason: reason,
          };
        }
        const childAgentId = resolveChildAgentId(
          api,
          params,
          snapshot.prompt,
          handoffRequest.childAgentIdOverride,
        );
        const promptTask = handoffRequest.task;

        // 先查 resumeSessionId，决定是首轮还是续接轮
        const fixedSessionKey = handoffRequest.structured?.sessionKey;
        const maxTurnsLimit = handoffRequest.structured?.maxTurns;
        let resumeSessionId: string | undefined;
        if (fixedSessionKey && childAgentId) {
          const openclawRoot = resolveOpenClawRoot(api);
          const stored = await readStoredSessionKey(openclawRoot, childAgentId, fixedSessionKey);
          if (stored?.acpSessionId) {
            const currentTurnCount = stored.turnCount;
            if (maxTurnsLimit !== undefined && currentTurnCount >= maxTurnsLimit) {
              api.logger.info(
                `acp-handoff: turn limit reached (turnCount=${currentTurnCount} >= maxTurns=${maxTurnsLimit}) for fixedSessionKey=${fixedSessionKey}, forcing new session`,
              );
              // resumeSessionId 保持 undefined → 走首轮逻辑（完整上下文）
            } else {
              resumeSessionId = stored.acpSessionId;
              api.logger.info(
                `acp-handoff: resuming session ${resumeSessionId} for fixedSessionKey=${fixedSessionKey} (turn ${currentTurnCount + 1}${maxTurnsLimit ? `/${maxTurnsLimit}` : ""})`,
              );
            }
          }
        }

        // 首轮：注入完整上下文（systemPrompt + project context）
        // 续接轮：只发纯任务，子 session 已有历史，无需重复注入上下文
        const contextControl = handoffRequest.structured?.contextControl;
        const customGuide = handoffRequest.structured?.customGuide;
        const promptArtifacts = outputDir ? resolveRenderedPromptArtifacts(snapshot) : undefined;
        const rewrittenTask = resumeSessionId
          ? promptTask
          : renderConcretePrompt(snapshot, promptTask, promptArtifacts, contextControl, customGuide);
        if (resumeSessionId) {
          api.logger.info(
            `acp-handoff: resume mode — skipping context injection for ${sessionKey}, sending task only`,
          );
        }

        if (outputDir) {
          const promptFile = await writeRenderedPromptFile({
            outputDir,
            snapshot,
            prompt: rewrittenTask,
          });
          api.logger.info(
            `acp-handoff: wrote prompt dump ${promptFile.relativePath} and fixed mirror ${promptFile.latestRelativePath} for ${sessionKey} (source=${snapshotSource})`,
          );
          if (handoffRequest.structured) {
            try {
              const artifactPath = await writeHandoffArtifact(
                outputDir,
                LATEST_STRUCTURED_REQUEST_FILE,
                handoffRequest.structured.rawEnvelope,
              );
              api.logger.info(`acp-handoff: wrote structured request mirror ${artifactPath} for ${sessionKey}`);
            } catch (error) {
              api.logger.warn(
                `acp-handoff: failed to write structured request mirror for ${sessionKey}: ${String(error)}`,
              );
            }
          }
        } else {
          api.logger.warn(`acp-handoff: no writable workspace resolved for ${sessionKey}; skipping prompt dump`);
        }

        if (handoffRequest.structured) {
          const pendingEntry: PendingStructuredSpawnMonitor = {
            responseMode: handoffRequest.structured.responseMode,
            ...(handoffRequest.structured.callback ? { callback: handoffRequest.structured.callback } : {}),
            ...(outputDir ? { outputDir } : {}),
            structured: handoffRequest.structured,
          };
          const pendingKey = buildPendingSpawnQueueKey(event, ctx);
          enqueuePendingStructuredSpawn(pendingKey, pendingEntry);
          if (parentWorkspaceDir) {
            try {
              await persistPendingStructuredSpawn(parentWorkspaceDir, pendingKey, pendingEntry);
            } catch (error) {
              api.logger.warn(
                `acp-handoff: failed to persist pending structured spawn for ${sessionKey}: ${String(error)}`,
              );
            }
          }
        }
        if (acpoffRequestedByUser) {
          pendingAcpoffReturnGuardsBySpawnKey.add(buildPendingSpawnQueueKey(event, ctx));
        }
        return {
          params: {
            ...params,
            runtime: "acp",
            ...(childAgentId ? { agentId: childAgentId } : {}),
            task: rewrittenTask,
            ...(outputDir ? { cwd: outputDir } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
          },
        };
      } catch (error) {
        api.logger.warn(`acp-handoff: blocking spawn; failed to build direct handoff prompt: ${String(error)}`);
        return {
          block: true,
          blockReason: "ACP handoff was explicitly requested, but the direct handoff prompt could not be prepared.",
        };
      }
    });

    // 监听 sessions_spawn 完成后，异步推送结果到 Discord
    api.on("after_tool_call", async (event, ctx) => {
      api.logger.info(`acp-handoff: after_tool_call triggered for tool: ${event.toolName}`);

      if (event.toolName !== "sessions_spawn") {
        return;
      }

      api.logger.info("acp-handoff: after_tool_call for sessions_spawn");

      api.logger.info(`acp-handoff: event.result type: ${typeof event.result}, value: ${JSON.stringify(event.result).substring(0, 500)}`);

      // event.result 可能是字符串（JSON）或对象，尝试解析
      let result: Record<string, unknown>;
      if (typeof event.result === "string") {
        try {
          result = JSON.parse(event.result);
        } catch {
          api.logger.warn("acp-handoff: failed to parse event.result as JSON");
          return;
        }
      } else {
        result = event.result as Record<string, unknown>;
      }

      // 结果可能在 details 字段中
      if (result.details && typeof result.details === "object") {
        result = result.details as Record<string, unknown>;
      }

      const childSessionKey = typeof result.childSessionKey === "string" ? result.childSessionKey : "";
      const mode = typeof result.mode === "string" ? result.mode : "";
      const pendingKey = buildPendingSpawnQueueKey(event, ctx);
      const shouldActivateAcpoffReturnGuard = pendingAcpoffReturnGuardsBySpawnKey.delete(pendingKey);
      let pendingStructuredSpawn = dequeuePendingStructuredSpawn(pendingKey);
      if (!pendingStructuredSpawn) {
        const parentWorkspaceDir =
          (typeof ctx.workspaceDir === "string" ? ctx.workspaceDir : "") || resolveWorkspaceDir(api, ctx.agentId);
        if (parentWorkspaceDir) {
          try {
            pendingStructuredSpawn = await takePersistedPendingStructuredSpawn(parentWorkspaceDir, pendingKey);
          } catch (error) {
            api.logger.warn(
              `acp-handoff: failed to restore pending structured spawn for ${childSessionKey || pendingKey}: ${String(error)}`,
            );
          }
        }
      }

      api.logger.info(`acp-handoff: childSessionKey=${childSessionKey}, mode=${mode}`);

      if (shouldActivateAcpoffReturnGuard && childSessionKey) {
        activeAcpoffReturnGuardsByTurnKey.set(buildToolCallTurnKey(event, ctx), { childSessionKey });
      }

      // 只处理 run 模式的 ACP 会话
      if (!childSessionKey || mode !== "run") {
        api.logger.info("acp-handoff: skipping (not run mode or no childSessionKey)");
        return;
      }

      if (pendingStructuredSpawn?.responseMode === "sync-return") {
        api.logger.info("acp-handoff: skipping callback monitor for structured sync-return request");
        return;
      }

      let discordTarget: DiscordDeliveryTarget | null = null;
      if (pendingStructuredSpawn?.callback) {
        discordTarget = await resolveExplicitDiscordTarget(pendingStructuredSpawn.callback, ctx, api);
        if (!discordTarget) {
          api.logger.warn("acp-handoff: explicit callback could not be resolved, skipping notification");
          return;
        }
        if (pendingStructuredSpawn.outputDir) {
          try {
            const artifactPath = await writeHandoffArtifact(
              pendingStructuredSpawn.outputDir,
              LATEST_CALLBACK_FILE,
              JSON.stringify(
                {
                  responseMode: pendingStructuredSpawn.responseMode,
                  callback: pendingStructuredSpawn.callback,
                  resolved: {
                    to: discordTarget.to,
                    accountId: discordTarget.accountId,
                  },
                },
                null,
                2,
              ),
            );
            api.logger.info(`acp-handoff: wrote callback routing mirror ${artifactPath} for ${childSessionKey}`);
          } catch (error) {
            api.logger.warn(
              `acp-handoff: failed to write callback routing mirror for ${childSessionKey}: ${String(error)}`,
            );
          }
        }
      } else {
        api.logger.info(`acp-handoff: extracting Discord info, ctx keys: ${Object.keys(ctx).join(", ")}`);
        discordTarget = await extractDiscordTarget(ctx, api);
      }
      if (!discordTarget) {
        api.logger.warn("acp-handoff: cannot extract Discord info, skipping notification");
        return;
      }

      api.logger.info(`acp-handoff: Discord target resolved: to=${discordTarget.to}, accountId=${discordTarget.accountId}`);

      // 启动后台监听任务（不阻塞父会话）
      // agentId 用 child agent id（从 childSessionKey 或 structured.agentId 解析），
      // 保证 session key 存储路径与 before_tool_call 里的读取路径一致
      const childAgentIdForMonitor =
        pendingStructuredSpawn?.structured?.agentId ??
        childSessionKey.split(":")[1]?.trim() ??
        (typeof ctx.agentId === "string" ? ctx.agentId : undefined);
      startBackgroundMonitor(childSessionKey, discordTarget, api, {
        model: pendingStructuredSpawn?.structured?.model,
        fixedSessionKey: pendingStructuredSpawn?.structured?.sessionKey,
        maxTurns: pendingStructuredSpawn?.structured?.maxTurns,
        agentId: childAgentIdForMonitor,
        workspaceDir: pendingStructuredSpawn?.outputDir,
      }).catch((error) => {
        api.logger.error(`acp-handoff: background monitor failed: ${String(error)}`);
      });

      api.logger.info(`acp-handoff: background monitor started for ${childSessionKey}`);
    });
  },
};

// Discord 投递目标（to 支持 channel:ID 或 user:ID，由内置栈处理转换）
type DiscordDeliveryTarget = {
  to: string;
  accountId: string;
};

async function resolveExplicitDiscordTarget(
  callback: StructuredDiscordCallback,
  ctx: any,
  api: OpenClawPluginApi,
): Promise<DiscordDeliveryTarget | null> {
  const accountId =
    callback.accountId?.trim() ||
    (typeof ctx.agentId === "string" ? resolveDiscordBindingAccountId(api, ctx.agentId.trim()) : undefined);
  if (!accountId) {
    api.logger.warn("acp-handoff: explicit callback has no Discord accountId and no binding fallback");
    return null;
  }
  const to = callback.to?.trim();
  if (!to) {
    api.logger.warn("acp-handoff: explicit callback has no target (to)");
    return null;
  }
  return { to, accountId };
}

// 从 session 上下文提取 Discord 投递目标（用于非 cron 的普通 Discord 会话）
async function extractDiscordTarget(ctx: any, api: OpenClawPluginApi): Promise<DiscordDeliveryTarget | null> {
  const agentId = typeof ctx.agentId === "string" ? ctx.agentId.trim() : "";
  if (!agentId) {
    api.logger.warn("acp-handoff: no agentId in context");
    return null;
  }

  const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  if (!sessionKey) {
    api.logger.warn("acp-handoff: no sessionKey in context");
    return null;
  }

  api.logger.info(`acp-handoff: looking for delivery context for session ${sessionKey}`);
  const sessionEntry = await readSessionRegistryEntry(api, agentId, sessionKey);
  const deliveryContext = sessionEntry?.deliveryContext;
  const origin = sessionEntry?.origin;
  const isDiscordSession = deliveryContext?.channel === "discord" || origin?.provider === "discord" || origin?.surface === "discord";
  if (!isDiscordSession) {
    api.logger.warn(`acp-handoff: session ${sessionKey} is not backed by Discord delivery`);
    return null;
  }

  const accountId =
    (typeof deliveryContext?.accountId === "string" ? deliveryContext.accountId : undefined) ??
    (typeof origin?.accountId === "string" ? origin.accountId : undefined) ??
    resolveDiscordBindingAccountId(api, agentId);
  if (!accountId) {
    api.logger.warn(`acp-handoff: no Discord accountId found for agent ${agentId}`);
    return null;
  }

  const to =
    (typeof deliveryContext?.to === "string" ? deliveryContext.to.trim() : undefined) ??
    (typeof origin?.to === "string" ? origin.to.trim() : undefined);
  if (!to) {
    api.logger.warn(`acp-handoff: no Discord channel target found for session ${sessionKey}`);
    return null;
  }

  return { to, accountId };
}

// 后台监听子会话完成并推送结果
async function startBackgroundMonitor(
  childSessionKey: string,
  target: DiscordDeliveryTarget,
  api: OpenClawPluginApi,
  options?: {
    model?: string;
    fixedSessionKey?: string;
    maxTurns?: number;
    agentId?: string;
    workspaceDir?: string;
  },
): Promise<void> {
  // 使用 setImmediate 确保不阻塞主线程
  return new Promise((resolve) => {
    setImmediate(async () => {
      try {
        // 设置模型（在轮询开始前）
        if (options?.model && options.agentId && options.workspaceDir) {
          await setAcpxModel(api, options.agentId, childSessionKey, options.model, options.workspaceDir);
        }

        const output = await waitForChildSessionCompletion(
          childSessionKey,
          api,
          ACP_CHILD_COMPLETION_MAX_WAIT_MS,
          ACP_CHILD_POLL_INTERVAL_MS,
        );

        // 存储 session key 映射（用于下次 resumeSessionId 注入）
        if (options?.fixedSessionKey && options.agentId) {
          const acpxRoot = resolveAcpxRoot(api);
          const openclawRoot = resolveOpenClawRoot(api);
          const acpSessionId = await findAcpxSessionId(acpxRoot, childSessionKey);
          if (acpSessionId) {
            try {
              const existingStore = await readStoredSessionKey(openclawRoot, options.agentId, options.fixedSessionKey);
              const isNewSession = !existingStore || existingStore.acpSessionId !== acpSessionId;
              const nextTurnCount = isNewSession ? 1 : (existingStore.turnCount + 1);
              await storeSessionKey(openclawRoot, options.agentId, options.fixedSessionKey, acpSessionId, nextTurnCount);
              api.logger.info(
                `acp-handoff: stored session key mapping fixedSessionKey=${options.fixedSessionKey} -> acpSessionId=${acpSessionId} (turn ${nextTurnCount}${options.maxTurns ? `/${options.maxTurns}` : ""})`,
              );
            } catch (error) {
              api.logger.warn(`acp-handoff: failed to store session key mapping: ${String(error)}`);
            }
          } else {
            api.logger.warn(
              `acp-handoff: could not find acpSessionId for childSessionKey=${childSessionKey} in acpx index`,
            );
          }
        }
        const sessionLabel = output.sessionId || childSessionKey;

        if (!output.completed) {
          api.logger.warn(`acp-handoff: session ${sessionLabel} ${output.error || "failed"}`);
          await sendToDiscord(
            target,
            `⚠️ ACP 子会话执行失败：${output.error || "未知错误"}`,
            api,
          );
          resolve();
          return;
        }

        if (output.state === "needs_user_input") {
          api.logger.info(`acp-handoff: session ${sessionLabel} is waiting for user input`);
          await sendToDiscord(target, `🟡 ACP 子会话等待输入：\n\n${output.text}`, api);
          api.logger.info(`acp-handoff: notification sent to Discord for ${sessionLabel}`);
          resolve();
          return;
        }

        api.logger.info(`acp-handoff: session ${sessionLabel} completed, sending to Discord...`);

        // 推送结果到 Discord
        await sendToDiscord(target, `✅ ACP 子会话执行完成：\n\n${output.text}`, api);

        api.logger.info(`acp-handoff: notification sent to Discord for ${sessionLabel}`);
        resolve();
      } catch (error) {
        api.logger.error(`acp-handoff: monitor error: ${String(error)}`);
        resolve();
      }
    });
  });
}

// 等待子会话完成
interface SessionOutput {
  completed: boolean;
  text: string | null;
  sessionId?: string;
  error?: string;
  state?: ResolvedLocalSessionTerminalState["kind"];
}

async function waitForSessionCompletion(
  sessionFile: string,
  api: OpenClawPluginApi,
  maxWaitTime = 120000,
  pollInterval = 2000,
): Promise<SessionOutput> {
  let elapsed = 0;
  let lastModified = 0;
  let stableCount = 0;

  while (elapsed < maxWaitTime) {
    try {
      const stats = await stat(sessionFile);
      const currentModified = stats.mtimeMs;

      // 文件修改时间稳定（连续2次检查都没变化），认为会话已完成
      if (currentModified === lastModified) {
        stableCount++;
        if (stableCount >= 2) {
          // 读取会话文件
          const content = await readFile(sessionFile, "utf-8");
          const lines = content.trim().split("\n").filter((line) => line.trim());

          if (lines.length === 0) {
            stableCount = 0;
            continue;
          }

          // 解析所有消息
          const messages = lines
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter((m) => m !== null);

          // 找到最后一条 assistant 消息
          const lastAssistant = messages
            .filter((m: any) => m.type === "message" && m.message?.role === "assistant")
            .pop();

          if (lastAssistant) {
            const content = lastAssistant.message.content;
            let text = "";
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              text = content
                .filter((block: any) => block.type === "text")
                .map((block: any) => block.text)
                .join("\n\n");
            }

            api.logger.info(`acp-handoff: extracted output, length: ${text.length}`);
            return assistantTextSuggestsUserInput(text)
              ? { completed: true, text, state: "needs_user_input" }
              : { completed: true, text };
          }

          stableCount = 0;
        }
      } else {
        lastModified = currentModified;
        stableCount = 0;
      }
    } catch (error) {
      // 文件可能还不存在，继续等待
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  api.logger.warn(`acp-handoff: session timeout after ${maxWaitTime}ms`);
  return { completed: false, text: null, error: `执行超时（${maxWaitTime / 1000}秒）` };
}

async function waitForChildSessionCompletion(
  childSessionKey: string,
  api: OpenClawPluginApi,
  maxWaitTime = ACP_CHILD_COMPLETION_MAX_WAIT_MS,
  pollInterval = ACP_CHILD_POLL_INTERVAL_MS,
  transcriptMaterializationWaitTime = maxWaitTime,
): Promise<SessionOutput> {
  let elapsed = 0;
  let lastResolvedMissing: ResolvedSessionFile | null = null;
  let sawPromptWithoutTranscript = false;

  while (elapsed < transcriptMaterializationWaitTime) {
    const resolved = await resolveSessionFileFromSessionKey(childSessionKey, api);
    if (resolved.registryState === "error") {
      const detailedError = await resolveDetailedAcpFailure(api, resolved.acpxRecordId);
      const registryError = resolved.registryLastError?.trim();
      const errorText =
        detailedError || registryError || "registry state=error";
      api.logger.warn(
        `acp-handoff: child session entered registry error state for ${childSessionKey}${errorText ? `: ${errorText}` : ""}`,
      );
      return {
        completed: false,
        text: null,
        sessionId: resolved.sessionId,
        error: errorText,
      };
    }
    if (resolved.exists) {
      if (resolved.source !== "registry-session-file") {
        api.logger.warn(
          `acp-handoff: resolved ${childSessionKey} via ${resolved.source} -> ${resolved.sessionFile}`,
        );
      }
      const output = await waitForSessionCompletion(resolved.sessionFile, api, maxWaitTime, pollInterval);
      return {
        ...output,
        sessionId: resolved.sessionId,
      };
    }

    const streamProgress = await resolveAcpStreamProgress(api, resolved.acpxRecordId);
    const shouldCheckStall =
      elapsed >= ACP_CHILD_STALE_DIAGNOSTIC_MIN_WAIT_MS && streamProgress?.promptSent !== true;
    const shouldInspectRecord = Boolean(resolved.acpxRecordId);
    const [recordSummary, eventLockSummary] = await Promise.all([
      shouldInspectRecord ? resolveAcpRecordSummary(api, resolved.acpxRecordId) : Promise.resolve(null),
      shouldInspectRecord ? resolveAcpEventLockSummary(api, resolved.acpxRecordId) : Promise.resolve(null),
    ]);
    if (streamProgress?.completed) {
      const fallbackText =
        streamProgress.text || "ACP 会话已完成，但 transcript 尚未落盘；已改用 acpx stream 结果返回。";
      api.logger.warn(
        `acp-handoff: child session ${childSessionKey} completed in acpx stream before transcript materialized; using stream fallback`,
      );
      return {
        completed: true,
        text: fallbackText,
        sessionId: resolved.sessionId,
      };
    }
    const prePromptRuntimeDeath = describeAcpPrePromptRuntimeDeath({
      resolved,
      streamProgress,
      recordSummary,
      eventLockSummary,
    });
    if (prePromptRuntimeDeath) {
      api.logger.warn(`acp-handoff: ${prePromptRuntimeDeath} (${childSessionKey})`);
      return {
        completed: false,
        text: null,
        sessionId: resolved.sessionId,
        error: prePromptRuntimeDeath,
        state: "runtime_error",
      };
    }
    const localTerminalState =
      recordSummary &&
      (streamProgress?.promptSent === true ||
      streamProgress?.backendSessionCreated === true ||
      recordSummary.lastAgentDisconnectReason ||
      recordSummary.lastAgentExitAt ||
      recordSummary.closed === true)
        ? await resolveLocalAgentTerminalState(api, recordSummary, ACP_CHILD_LOCAL_STALE_DIAGNOSTIC_MS)
        : null;
    if (
      localTerminalState?.kind === "api_error" ||
      localTerminalState?.kind === "tool_error" ||
      localTerminalState?.kind === "runtime_error" ||
      localTerminalState?.kind === "stalled_nonterminal"
    ) {
      api.logger.warn(
        `acp-handoff: child session ${childSessionKey} failed inside ${localTerminalState.runtimeLabel} before transcript materialized: ${localTerminalState.text}`,
      );
      return {
        completed: false,
        text: null,
        sessionId: resolved.sessionId,
        error: localTerminalState.text,
        state: localTerminalState.kind,
      };
    }
    if (
      localTerminalState?.kind === "assistant_final" ||
      localTerminalState?.kind === "needs_user_input"
    ) {
      api.logger.warn(
        `acp-handoff: child session ${childSessionKey} completed inside ${localTerminalState.runtimeLabel} before transcript materialized; using local-session fallback`,
      );
      return {
        completed: true,
        text: localTerminalState.text,
        sessionId: resolved.sessionId,
        ...(localTerminalState.kind === "needs_user_input" ? { state: "needs_user_input" as const } : {}),
      };
    }
    const stallDiagnostic = shouldCheckStall
      ? describeAcpStalledSession({
          resolved,
          streamProgress,
          recordSummary,
          eventLockSummary,
        })
      : null;
    if (stallDiagnostic) {
      api.logger.warn(`acp-handoff: ${stallDiagnostic} (${childSessionKey})`);
      return {
        completed: false,
        text: null,
        sessionId: resolved.sessionId,
        error: stallDiagnostic,
      };
    }
    if (streamProgress?.promptSent && !sawPromptWithoutTranscript) {
      sawPromptWithoutTranscript = true;
      api.logger.info(
        `acp-handoff: child session ${childSessionKey} accepted prompt, but transcript is not materialized yet; continuing to wait`,
      );
    }

    lastResolvedMissing = resolved;
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  const finalStreamProgress = await resolveAcpStreamProgress(api, lastResolvedMissing?.acpxRecordId);
  const [finalRecordSummary, finalEventLockSummary] = await Promise.all([
    resolveAcpRecordSummary(api, lastResolvedMissing?.acpxRecordId),
    resolveAcpEventLockSummary(api, lastResolvedMissing?.acpxRecordId),
  ]);
  const finalLocalTerminalState = finalRecordSummary
    ? await resolveLocalAgentTerminalState(api, finalRecordSummary, ACP_CHILD_LOCAL_STALE_DIAGNOSTIC_MS)
    : null;
  const finalPrePromptRuntimeDeath =
    lastResolvedMissing && finalRecordSummary
      ? describeAcpPrePromptRuntimeDeath({
          resolved: lastResolvedMissing,
          streamProgress: finalStreamProgress,
          recordSummary: finalRecordSummary,
          eventLockSummary: finalEventLockSummary,
        })
      : null;
  if (finalPrePromptRuntimeDeath) {
    api.logger.warn(`acp-handoff: ${finalPrePromptRuntimeDeath} (${childSessionKey})`);
    return {
      completed: false,
      text: null,
      sessionId: lastResolvedMissing?.sessionId,
      error: finalPrePromptRuntimeDeath,
      state: "runtime_error",
    };
  }
  if (
    finalLocalTerminalState?.kind === "api_error" ||
    finalLocalTerminalState?.kind === "tool_error" ||
    finalLocalTerminalState?.kind === "runtime_error" ||
    finalLocalTerminalState?.kind === "stalled_nonterminal"
  ) {
    api.logger.warn(
      `acp-handoff: child session ${childSessionKey} failed inside ${finalLocalTerminalState.runtimeLabel} before transcript materialized: ${finalLocalTerminalState.text}`,
    );
    return {
      completed: false,
      text: null,
      sessionId: lastResolvedMissing?.sessionId,
      error: finalLocalTerminalState.text,
      state: finalLocalTerminalState.kind,
    };
  }
  if (
    finalLocalTerminalState?.kind === "assistant_final" ||
    finalLocalTerminalState?.kind === "needs_user_input"
  ) {
    api.logger.warn(
      `acp-handoff: child session ${childSessionKey} completed inside ${finalLocalTerminalState.runtimeLabel} before transcript materialized; using local-session fallback`,
    );
    return {
      completed: true,
      text: finalLocalTerminalState.text,
      sessionId: lastResolvedMissing?.sessionId,
      ...(finalLocalTerminalState.kind === "needs_user_input" ? { state: "needs_user_input" as const } : {}),
    };
  }
  const registryHint = lastResolvedMissing?.registryState
    ? `registry state=${lastResolvedMissing.registryState}`
    : "registry has no usable session file";
  const stallDiagnostic =
    lastResolvedMissing && finalRecordSummary
      ? describeAcpStalledSession({
          resolved: lastResolvedMissing,
          streamProgress: finalStreamProgress,
          recordSummary: finalRecordSummary,
          eventLockSummary: finalEventLockSummary,
        })
      : null;
  const timeoutError =
    stallDiagnostic ??
    (finalStreamProgress?.promptSent
      ? `ACP 会话仍在执行中，结果尚未落盘（${registryHint}；请勿过早手动 close）`
      : `ACP 会话已接受，但 transcript 文件未落地（${registryHint}）`);
  api.logger.warn(
    `acp-handoff: child session transcript did not materialize for ${childSessionKey} (${registryHint}; promptSent=${finalStreamProgress?.promptSent === true})`,
  );
  return {
    completed: false,
    text: null,
    sessionId: lastResolvedMissing?.sessionId,
    error: timeoutError,
  };
}

// 发送消息到 Discord（使用 OpenClaw 内置栈，支持 channel:ID 和 user:ID）
async function sendToDiscord(
  target: DiscordDeliveryTarget,
  content: string,
  api: OpenClawPluginApi,
): Promise<void> {
  try {
    await api.runtime.channel.discord.sendMessageDiscord(target.to, content, {
      accountId: target.accountId,
    });
    api.logger.info("acp-handoff: Discord message sent successfully");
  } catch (error) {
    api.logger.error(`acp-handoff: Discord send failed: ${String(error)}`);
    throw error;
  }
}

export default plugin;

export const __testables = {
  describeAcpStalledSession,
  extractDiscordTarget,
  parseConversationInfoFromPrompt,
  rememberPromptConversationInfo,
  resolveClaudeCodeSessionApiError,
  resolveClaudeCodeSessionTerminalState,
  resolveCopilotSessionTerminalState,
  resolveAcpEventLockSummary,
  resolveAcpRecordSummary,
  resolveExplicitDiscordTarget,
  resolveAcpStreamProgress,
  resolveSessionFileFromSessionKey,
  sendToDiscord,
  summarizeCopilotSessionError,
  summarizeClaudeApiError,
  waitForChildSessionCompletion,
  waitForSessionCompletion,
};
