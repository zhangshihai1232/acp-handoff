import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TRANSCRIPT_MESSAGES } from "./constants.js";
import { createTranscriptFallbackSnapshot } from "./normalize.js";
import type { HandoffSnapshot } from "./types.js";

function resolveTranscriptPath(agentId: string, sessionId: string): string {
  return path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

export async function readTranscriptFallbackSnapshot(params: {
  agentId?: string;
  sessionId?: string;
  sessionKey: string;
  workspaceDir?: string;
  requestedTask: string;
}): Promise<HandoffSnapshot | null> {
  const agentId = params.agentId?.trim();
  const sessionId = params.sessionId?.trim();
  if (!agentId || !sessionId) {
    return null;
  }

  const transcriptPath = resolveTranscriptPath(agentId, sessionId);
  try {
    const raw = await fs.readFile(transcriptPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return null;
    }

    let headerCwd = params.workspaceDir;
    const transcriptMessages: unknown[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          cwd?: unknown;
          message?: unknown;
        };
        if (parsed.type === "session" && typeof parsed.cwd === "string" && parsed.cwd.trim()) {
          headerCwd = parsed.cwd.trim();
          continue;
        }
        if (parsed.type === "message" && parsed.message && typeof parsed.message === "object") {
          transcriptMessages.push(parsed.message);
        }
      } catch {
        continue;
      }
    }

    if (transcriptMessages.length === 0) {
      return null;
    }

    return createTranscriptFallbackSnapshot({
      sessionKey: params.sessionKey,
      workspaceDir: headerCwd,
      agentId,
      requestedTask: params.requestedTask,
      transcriptMessages: transcriptMessages.slice(-MAX_TRANSCRIPT_MESSAGES),
    });
  } catch {
    return null;
  }
}
