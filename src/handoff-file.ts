import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HANDOFF_DIR, LATEST_PROMPT_FILE } from "./constants.js";
import type { ContextControl } from "./protocol.js";
import type { HandoffSnapshot } from "./types.js";

export type HandoffPromptArtifacts = {
  exactPayloadFile?: string;
  latestExactPayloadFile?: string;
};

const PROJECT_CONTEXT_TAGS = new Map<string, string>([
  ["IDENTITY.md", "IDENTITY"],
  ["SOUL.md", "SOUL"],
  ["USER.md", "USER"],
  ["RULES.md", "RULES"],
  ["AGENTS.md", "AGENTS"],
  ["TOOLS.md", "TOOLS"],
  ["MEMORY.md", "MEMORY"],
]);

function sessionHash(sessionKey: string) {
  return crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 8);
}

function buildPromptFileName(snapshot: HandoffSnapshot): string {
  return `${snapshot.capturedAt.replaceAll(/[:.]/g, "-")}-${sessionHash(snapshot.sessionKey)}-${snapshot.agentId ?? "agent"}.prompt.txt`;
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function resolveRenderedPromptArtifacts(snapshot: HandoffSnapshot): HandoffPromptArtifacts {
  const promptFileName = buildPromptFileName(snapshot);
  return {
    exactPayloadFile: toPortablePath(path.join(...HANDOFF_DIR, promptFileName)),
    latestExactPayloadFile: toPortablePath(path.join(...HANDOFF_DIR, LATEST_PROMPT_FILE)),
  };
}

function extractProjectContextFiles(systemPrompt: string): Map<string, string> {
  const projectContextIndex = systemPrompt.indexOf("# Project Context");
  if (projectContextIndex === -1) {
    return new Map();
  }

  const projectContextRaw = systemPrompt.slice(projectContextIndex);
  const filePattern = /^## (\/[^\n]+\.md)\s*$/gm;
  const matches = [...projectContextRaw.matchAll(filePattern)];
  const fileMap = new Map<string, string>();

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const filePath = match[1]?.trim();
    const start = (match.index ?? 0) + match[0].length;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? projectContextRaw.length)
        : projectContextRaw.length;
    const content = projectContextRaw.slice(start, end).trim();
    if (!filePath || !content) {
      continue;
    }
    const tag = PROJECT_CONTEXT_TAGS.get(path.basename(filePath));
    if (!tag) {
      continue;
    }
    fileMap.set(tag, content);
  }

  return fileMap;
}

export function renderConcretePrompt(
  snapshot: HandoffSnapshot,
  requestedTask: string,
  artifacts?: HandoffPromptArtifacts,
  contextControl?: ContextControl,
  customGuide?: string,
): string {
  // 应用默认值（用户未提供时的合理默认）
  const control = {
    includeArtifacts: contextControl?.includeArtifacts ?? false,
    includeTools: contextControl?.includeTools ?? false,
    includeMemory: contextControl?.includeMemory ?? true,
    includeRules: contextControl?.includeRules ?? true,
    includeAgents: contextControl?.includeAgents ?? true,
    includeIdentity: contextControl?.includeIdentity ?? true,
    includeSoul: contextControl?.includeSoul ?? true,
  };

  const fileMap = extractProjectContextFiles(snapshot.systemPrompt);
  const hasArtifactPaths = Boolean(artifacts?.exactPayloadFile || artifacts?.latestExactPayloadFile);

  const lines = [
    "<handoff_payload>",
    "",
    "<handoff_context>",
    "",
    // 条件渲染 agent_profile
    ...(control.includeIdentity || control.includeSoul
      ? renderAgentProfileBlock(fileMap, control)
      : []),

    // USER 始终包含（无条件）
    ...renderTagBlock("user_profile", fileMap.get("USER")),

    // 条件渲染 operating_rules
    ...(control.includeRules || control.includeAgents || control.includeTools
      ? renderOperatingRulesBlock(fileMap, control)
      : []),

    // 条件渲染 memory
    ...(control.includeMemory ? renderTagBlock("memory", fileMap.get("MEMORY")) : []),

    "</handoff_context>",
    "",

    // 条件渲染 artifacts
    ...(control.includeArtifacts && hasArtifactPaths
      ? renderHandoffArtifactsBlock(artifacts)
      : []),

    "<handoff_task>",
    "",

    // 使用自定义 guide 或默认 guide
    ...renderGuideBlock(customGuide, control, hasArtifactPaths),

    "",
    "<request>",
    requestedTask.trim(),
    "</request>",
    "",
    "</handoff_task>",
    "",
    "</handoff_payload>",
  ];

  return lines.join("\n");
}

function renderAgentProfileBlock(fileMap: Map<string, string>, control: ContextControl): string[] {
  // 如果两者都不包含，返回空（不输出 <agent_profile> 块）
  if (!control.includeIdentity && !control.includeSoul) {
    return [];
  }

  const lines = ["<agent_profile>"];

  // 条件渲染 identity
  if (control.includeIdentity) {
    lines.push(...renderTagBlock("identity", fileMap.get("IDENTITY"), false));
  }

  // 条件渲染 behavior_style
  if (control.includeSoul) {
    if (control.includeIdentity) {
      lines.push("");  // 两者都包含时，中间加空行
    }
    lines.push(...renderTagBlock("behavior_style", fileMap.get("SOUL"), false));
  }

  lines.push("</agent_profile>", "");
  return lines;
}

function renderOperatingRulesBlock(fileMap: Map<string, string>, control: ContextControl): string[] {
  // 如果三者都不包含，返回空
  if (!control.includeRules && !control.includeAgents && !control.includeTools) {
    return [];
  }

  const lines = ["<operating_rules>"];
  let hasContent = false;

  // 条件渲染 rules
  if (control.includeRules) {
    lines.push(...renderTagBlock("rules", fileMap.get("RULES"), false));
    hasContent = true;
  }

  // 条件渲染 workflow
  if (control.includeAgents) {
    if (hasContent) lines.push("");
    lines.push(...renderTagBlock("workflow", fileMap.get("AGENTS"), false));
    hasContent = true;
  }

  // 条件渲染 tools
  if (control.includeTools) {
    if (hasContent) lines.push("");
    lines.push(...renderTagBlock("tools", fileMap.get("TOOLS"), false));
  }

  lines.push("</operating_rules>", "");
  return lines;
}

function renderHandoffArtifactsBlock(artifacts?: HandoffPromptArtifacts): string[] {
  const exactPayloadFile = artifacts?.exactPayloadFile?.trim();
  const latestExactPayloadFile = artifacts?.latestExactPayloadFile?.trim();
  if (!exactPayloadFile && !latestExactPayloadFile) {
    return [];
  }

  const lines = ["<handoff_artifacts>", ""];
  if (exactPayloadFile) {
    lines.push(...renderTagBlock("exact_payload_file", exactPayloadFile));
  }
  if (latestExactPayloadFile) {
    lines.push(...renderTagBlock("latest_exact_payload_file", latestExactPayloadFile));
  }
  lines.push("<usage_notes>");
  lines.push("The plugin wrote the exact final handoff payload to the files above before this child session started.");
  lines.push("Paths are relative to the current working directory.");
  lines.push(
    "If you need to preserve or compare the payload exactly, prefer copying one of these files instead of reconstructing the full payload through shell input, a heredoc, or manual reformatting.",
  );
  lines.push("</usage_notes>");
  lines.push("</handoff_artifacts>", "");
  return lines;
}

function renderGuideBlock(
  customGuide: string | undefined,
  control: ContextControl,
  hasArtifactPaths: boolean,
): string[] {
  if (customGuide) {
    // 使用自定义 guide（完全覆盖）
    return [
      "<guide>",
      customGuide.trim(),
      "</guide>",
    ];
  }

  // 使用默认 guide（优化后的表达）
  const lines = [
    "<guide>",
    "你是 <identity> 定义的 Agent，按 <behavior_style> 的风格行事，服务 <user_profile> 定义的用户。",
    "",
  ];

  // 动态生成执行规则优先级（仅包含启用的部分）
  const priorities: string[] = [];
  if (control.includeRules) {
    priorities.push("<rules> — 核心原则，不可违反");
  }
  if (control.includeAgents) {
    priorities.push("<workflow> — 工作规范和协作方式");
  }
  priorities.push("<behavior_style> — 你的风格偏好");

  if (priorities.length > 0) {
    lines.push("执行规则优先级：");
    priorities.forEach((p, i) => {
      lines.push(`${i + 1}. ${p}`);
    });
    lines.push("");
  }

  // 动态生成参考资源说明
  const references: string[] = [];
  if (control.includeTools) {
    references.push("参考 <tools> 使用工具");
  }
  if (control.includeMemory) {
    references.push("参考 <memory> 了解历史上下文");
  }
  if (references.length > 0) {
    lines.push(references.join("，") + "。");
  }

  // 如果有 artifacts，追加使用提示
  if (hasArtifactPaths) {
    lines.push("");
    lines.push(
      "如果任务需要逐字保存、比对或转发当前收到的 payload，优先直接使用 <handoff_artifacts> 里的文件路径，不要通过 shell heredoc、手动重写或重新格式化来重建整段 payload。",
    );
  }

  lines.push("</guide>");
  return lines;
}

function renderTagBlock(tag: string, content?: string, trailingBlankLine = true): string[] {
  const lines = [`<${tag}>`];
  if (content) {
    lines.push(content);
  }
  lines.push(`</${tag}>`);
  if (trailingBlankLine) {
    lines.push("");
  }
  return lines;
}

export async function writeRenderedPromptFile(params: {
  outputDir: string;
  snapshot: HandoffSnapshot;
  prompt: string;
}): Promise<{
  absolutePath: string;
  relativePath: string;
  fileName: string;
  latestAbsolutePath: string;
  latestRelativePath: string;
}> {
  const promptFileName = buildPromptFileName(params.snapshot);
  const relativePath = path.join(...HANDOFF_DIR, promptFileName);
  const absolutePath = path.join(params.outputDir, relativePath);
  const latestRelativePath = path.join(...HANDOFF_DIR, LATEST_PROMPT_FILE);
  const latestAbsolutePath = path.join(params.outputDir, latestRelativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, params.prompt, "utf8");
  await fs.writeFile(latestAbsolutePath, params.prompt, "utf8");
  return {
    absolutePath,
    relativePath: toPortablePath(relativePath),
    fileName: promptFileName,
    latestAbsolutePath,
    latestRelativePath: toPortablePath(latestRelativePath),
  };
}
