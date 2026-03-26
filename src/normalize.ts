import crypto from "node:crypto";
import {
  HANDOFF_SCHEMA_VERSION,
  MAX_HISTORY_ENTRY_CHARS,
  MAX_HISTORY_TOTAL_CHARS,
  MAX_PROMPT_CHARS,
  MAX_REQUESTED_TASK_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
} from "./constants.js";
import type { HandoffSnapshot, NormalizedContentBlock, NormalizedHistoryEntry } from "./types.js";

function clampText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean; rawChars: number; keptChars: number } {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return { text: trimmed, truncated: false, rawChars: trimmed.length, keptChars: trimmed.length };
  }
  return {
    text: `${trimmed.slice(0, maxChars)}\n[TRUNCATED: original length ${trimmed.length} chars]`,
    truncated: true,
    rawChars: trimmed.length,
    keptChars: maxChars,
  };
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeContentBlocks(record: Record<string, unknown>, role: string): NormalizedContentBlock[] {
  const content = record.content;
  if (typeof content === "string") {
    return content.trim() ? [{ kind: "text", text: content.trim() }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: NormalizedContentBlock[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "";
    const text = normalizeText(block.text) || normalizeText(block.content);
    const thinking = normalizeText(block.thinking);
    if ((type === "tool_use" || type === "toolCall") && typeof block.name === "string") {
      blocks.push({
        kind: "tool_use",
        name: block.name,
        argumentsText: stringifyUnknown(block.arguments),
      });
      continue;
    }

    if (type === "tool_result" || role === "toolResult") {
      const textFromBlock = text || normalizeText(block.error) || stringifyUnknown(block.details);
      blocks.push({
        kind: "tool_result",
        toolName: normalizeText(block.toolName) || normalizeText(record.toolName),
        toolCallId: normalizeText(block.toolCallId) || normalizeText(record.toolCallId),
        text: textFromBlock || stringifyUnknown(record.details),
        isError: block.isError === true || record.isError === true,
      });
      continue;
    }

    if (text) {
      blocks.push({ kind: "text", text });
      continue;
    }
    if (thinking) {
      blocks.push({ kind: "thinking", text: thinking });
    }
  }
  return blocks;
}

function summarizeBlocks(blocks: NormalizedContentBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "text":
          return block.text;
        case "thinking":
          return `[thinking]\n${block.text}`;
        case "tool_use":
          return block.argumentsText
            ? `[tool_use] ${block.name ?? "unknown"}\n${block.argumentsText}`
            : `[tool_use] ${block.name ?? "unknown"}`;
        case "tool_result":
          return block.text
            ? `[tool_result] ${block.toolName ?? "unknown"}\n${block.text}`
            : `[tool_result] ${block.toolName ?? "unknown"}`;
      }
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeRole(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function createHandoffId(seed: string): string {
  return `hf_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

export function normalizeHistoryMessages(
  messages: unknown[],
  source: "llm_input" | "transcript",
): {
  entries: NormalizedHistoryEntry[];
  seenMessages: number;
  keptMessages: number;
  truncatedEntries: number;
} {
  const normalized: NormalizedHistoryEntry[] = [];
  let totalChars = 0;
  let seenMessages = 0;
  let truncatedEntries = 0;

  for (const message of [...messages].reverse()) {
    seenMessages += 1;
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    const role = normalizeRole(record.role);
    const blocks = normalizeContentBlocks(record, role);
    const text = summarizeBlocks(blocks);
    if (!text) {
      continue;
    }
    const clamped = clampText(text, MAX_HISTORY_ENTRY_CHARS);
    if (totalChars + clamped.text.length > MAX_HISTORY_TOTAL_CHARS) {
      break;
    }
    normalized.push({
      role,
      text: clamped.text,
      truncated: clamped.truncated,
      source,
      blocks,
    });
    if (clamped.truncated) {
      truncatedEntries += 1;
    }
    totalChars += clamped.text.length;
  }

  normalized.reverse();

  return {
    entries: normalized,
    seenMessages,
    keptMessages: normalized.length,
    truncatedEntries,
  };
}

export function createSnapshot(params: {
  runId: string;
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  imagesCount: number;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
}): HandoffSnapshot {
  const capturedAt = new Date().toISOString();
  const systemPrompt = clampText(params.systemPrompt ?? "", MAX_SYSTEM_PROMPT_CHARS);
  const prompt = clampText(params.prompt, MAX_PROMPT_CHARS);
  const history = normalizeHistoryMessages(params.historyMessages, "llm_input");
  return {
    version: HANDOFF_SCHEMA_VERSION,
    handoffId: createHandoffId(`${params.runId}:${params.sessionId}:${capturedAt}`),
    capturedAt,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    provider: params.provider,
    model: params.model,
    imagesCount: params.imagesCount,
    systemPrompt: systemPrompt.text,
    prompt: prompt.text,
    history: history.entries,
    truncation: {
      systemPromptRawChars: systemPrompt.rawChars,
      systemPromptKeptChars: systemPrompt.keptChars,
      systemPromptTruncated: systemPrompt.truncated,
      promptRawChars: prompt.rawChars,
      promptKeptChars: prompt.keptChars,
      promptTruncated: prompt.truncated,
      requestedTaskRawChars: 0,
      requestedTaskKeptChars: 0,
      requestedTaskTruncated: false,
      historySeenMessages: history.seenMessages,
      historyKeptMessages: history.keptMessages,
      historyTruncatedEntries: history.truncatedEntries,
    },
  };
}

export function createTranscriptFallbackSnapshot(params: {
  sessionKey: string;
  workspaceDir?: string;
  agentId?: string;
  requestedTask: string;
  transcriptMessages: unknown[];
}): HandoffSnapshot {
  const capturedAt = new Date().toISOString();
  const prompt = clampText(params.requestedTask, MAX_PROMPT_CHARS);
  const requestedTask = clampText(params.requestedTask, MAX_REQUESTED_TASK_CHARS);
  const history = normalizeHistoryMessages(params.transcriptMessages, "transcript");
  return {
    version: HANDOFF_SCHEMA_VERSION,
    handoffId: createHandoffId(`${params.sessionKey}:${capturedAt}:transcript-fallback`),
    capturedAt,
    runId: "transcript-fallback",
    sessionId: "transcript-fallback",
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    provider: "unknown",
    model: "unknown",
    imagesCount: 0,
    systemPrompt: "",
    prompt: prompt.text,
    history: history.entries,
    truncation: {
      systemPromptRawChars: 0,
      systemPromptKeptChars: 0,
      systemPromptTruncated: false,
      promptRawChars: prompt.rawChars,
      promptKeptChars: prompt.keptChars,
      promptTruncated: prompt.truncated,
      requestedTaskRawChars: requestedTask.rawChars,
      requestedTaskKeptChars: requestedTask.keptChars,
      requestedTaskTruncated: requestedTask.truncated,
      historySeenMessages: history.seenMessages,
      historyKeptMessages: history.keptMessages,
      historyTruncatedEntries: history.truncatedEntries,
    },
  };
}
