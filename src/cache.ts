import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, RUN_CACHE_DIR } from "./constants.js";
import type { HandoffSnapshot } from "./types.js";

const snapshotByRunId = new Map<string, HandoffSnapshot>();
const latestRunIdBySessionKey = new Map<string, string>();

function cacheFilePath(workspaceDir: string, sessionKey: string) {
  const hash = crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
  return path.join(workspaceDir, ...CACHE_DIR, `${hash}.json`);
}

function runCacheFilePath(workspaceDir: string, runId: string) {
  return path.join(workspaceDir, ...RUN_CACHE_DIR, `${runId}.json`);
}

export async function storeSnapshot(snapshot: HandoffSnapshot): Promise<void> {
  snapshotByRunId.set(snapshot.runId, snapshot);
  latestRunIdBySessionKey.set(snapshot.sessionKey, snapshot.runId);
  if (!snapshot.workspaceDir) {
    return;
  }
  const filePath = cacheFilePath(snapshot.workspaceDir, snapshot.sessionKey);
  const runFilePath = runCacheFilePath(snapshot.workspaceDir, snapshot.runId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.mkdir(path.dirname(runFilePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await fs.writeFile(runFilePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function readSnapshotByRunId(params: {
  runId: string;
  workspaceDir?: string;
}): Promise<HandoffSnapshot | null> {
  const inMemory = snapshotByRunId.get(params.runId);
  if (inMemory) {
    return inMemory;
  }
  if (!params.workspaceDir) {
    return null;
  }
  const filePath = runCacheFilePath(params.workspaceDir, params.runId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as HandoffSnapshot;
    snapshotByRunId.set(params.runId, parsed);
    latestRunIdBySessionKey.set(parsed.sessionKey, parsed.runId);
    return parsed;
  } catch {
    return null;
  }
}

export async function readLatestSnapshotBySessionKey(params: {
  sessionKey: string;
  workspaceDir?: string;
}): Promise<HandoffSnapshot | null> {
  const latestRunId = latestRunIdBySessionKey.get(params.sessionKey);
  if (latestRunId) {
    const inMemory = snapshotByRunId.get(latestRunId);
    if (inMemory) {
      return inMemory;
    }
  }
  if (!params.workspaceDir) {
    return null;
  }
  const filePath = cacheFilePath(params.workspaceDir, params.sessionKey);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as HandoffSnapshot;
    snapshotByRunId.set(parsed.runId, parsed);
    latestRunIdBySessionKey.set(params.sessionKey, parsed.runId);
    return parsed;
  } catch {
    return null;
  }
}
