export type NormalizedContentBlock =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "thinking";
      text: string;
    }
  | {
      kind: "tool_use";
      name?: string;
      argumentsText?: string;
    }
  | {
      kind: "tool_result";
      toolName?: string;
      toolCallId?: string;
      text?: string;
      isError?: boolean;
    };

export type NormalizedHistoryEntry = {
  role: string;
  text: string;
  truncated: boolean;
  source: "llm_input" | "transcript";
  blocks: NormalizedContentBlock[];
};

export type HandoffSnapshotSource = "run-cache" | "session-cache" | "transcript-fallback";

export type HandoffTruncationStats = {
  systemPromptRawChars: number;
  systemPromptKeptChars: number;
  systemPromptTruncated: boolean;
  promptRawChars: number;
  promptKeptChars: number;
  promptTruncated: boolean;
  requestedTaskRawChars: number;
  requestedTaskKeptChars: number;
  requestedTaskTruncated: boolean;
  historySeenMessages: number;
  historyKeptMessages: number;
  historyTruncatedEntries: number;
};

export type HandoffSnapshot = {
  version: 3;
  handoffId: string;
  capturedAt: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  imagesCount: number;
  systemPrompt: string;
  prompt: string;
  history: NormalizedHistoryEntry[];
  truncation: HandoffTruncationStats;
};

export type HandoffContext = {
  runtime: "acp";
  childAgentId?: string;
  childCwd?: string;
  snapshotSource: HandoffSnapshotSource;
  outputDir: string;
};
