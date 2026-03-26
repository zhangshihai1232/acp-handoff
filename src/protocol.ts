import { unescapeXmlText } from "./xml.js";

export type StructuredResponseMode = "sync-return" | "async-callback";

export type StructuredDiscordCallback = {
  channel: "discord";
  to: string;
  accountId?: string;
  replyToId?: string;
};

export type ContextControl = {
  includeArtifacts?: boolean;
  includeTools?: boolean;
  includeMemory?: boolean;
  includeRules?: boolean;
  includeAgents?: boolean;
  includeIdentity?: boolean;
  includeSoul?: boolean;
};

export type StructuredAcpRequest = {
  version: "1";
  rawEnvelope: string;
  task: string;
  agentId?: string;
  sessionKey?: string;
  model?: string;
  maxTurns?: number;
  responseMode: StructuredResponseMode;
  callback?: StructuredDiscordCallback;
  contextControl?: ContextControl;
  customGuide?: string;
};

export class StructuredAcpRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredAcpRequestError";
  }
}

function decodeXmlValue(rawValue: string): string {
  if (!rawValue.includes("<![CDATA[")) {
    return unescapeXmlText(rawValue).trim();
  }

  let decoded = "";
  let cursor = 0;
  const pattern = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  for (const match of rawValue.matchAll(pattern)) {
    const matchIndex = match.index ?? 0;
    const prefix = rawValue.slice(cursor, matchIndex);
    if (prefix.trim()) {
      decoded += unescapeXmlText(prefix);
    }
    decoded += match[1] ?? "";
    cursor = matchIndex + match[0].length;
  }
  const suffix = rawValue.slice(cursor);
  if (suffix.trim()) {
    decoded += unescapeXmlText(suffix);
  }
  return decoded.trim();
}

function extractSingleTag(text: string, tagName: string): string | null {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new StructuredAcpRequestError(`Structured ACP request contains multiple <${tagName}> blocks.`);
  }
  return matches[0]?.[1] ?? null;
}

function extractEnvelope(text: string): { rawEnvelope: string; openTag: string; body: string } | null {
  const pattern = /<acp_request\b[^>]*>[\s\S]*?<\/acp_request>/gi;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new StructuredAcpRequestError("Structured ACP request must contain exactly one <acp_request> block.");
  }
  const rawEnvelope = matches[0]?.[0] ?? "";
  const openTagMatch = rawEnvelope.match(/^<acp_request\b([^>]*)>/i);
  const bodyMatch = rawEnvelope.match(/^<acp_request\b[^>]*>([\s\S]*?)<\/acp_request>$/i);
  if (!openTagMatch || !bodyMatch) {
    throw new StructuredAcpRequestError("Structured ACP request envelope is malformed.");
  }
  return {
    rawEnvelope,
    openTag: openTagMatch[1] ?? "",
    body: bodyMatch[1] ?? "",
  };
}

function extractVersion(openTag: string): "1" {
  const versionMatch = openTag.match(/\bversion\s*=\s*["']([^"']+)["']/i);
  const version = versionMatch?.[1]?.trim() || "1";
  if (version !== "1") {
    throw new StructuredAcpRequestError(`Unsupported <acp_request> version: ${version}`);
  }
  return "1";
}

function parseCallback(metaBody: string): StructuredDiscordCallback | undefined {
  const callbackBody = extractSingleTag(metaBody, "callback");
  if (!callbackBody) {
    return undefined;
  }
  const channel = decodeXmlValue(extractSingleTag(callbackBody, "channel") ?? "");
  if (channel !== "discord") {
    throw new StructuredAcpRequestError(`Unsupported callback channel: ${channel || "(empty)"}`);
  }
  const to = decodeXmlValue(extractSingleTag(callbackBody, "to") ?? "");
  if (!to) {
    throw new StructuredAcpRequestError("Structured ACP callback requires <to>.");
  }
  const accountId = decodeXmlValue(extractSingleTag(callbackBody, "accountId") ?? "") || undefined;
  const replyToId = decodeXmlValue(extractSingleTag(callbackBody, "replyToId") ?? "") || undefined;
  return {
    channel: "discord",
    to,
    ...(accountId ? { accountId } : {}),
    ...(replyToId ? { replyToId } : {}),
  };
}

export function parseStructuredAcpRequest(text: string): StructuredAcpRequest | null {
  const envelope = extractEnvelope(text);
  if (!envelope) {
    return null;
  }

  const version = extractVersion(envelope.openTag);
  const metaBody = extractSingleTag(envelope.body, "meta") ?? "";
  // <cli_prompt> 是 <task> 的语义别名：明确表达"这是透传给 ACP CLI 的内容，不是给当前 agent 执行的"
  // 两者功能完全相同，<cli_prompt> 语义更清晰，推荐在新 payload 中使用
  const taskBody = extractSingleTag(envelope.body, "cli_prompt") ?? extractSingleTag(envelope.body, "task");
  if (!taskBody) {
    throw new StructuredAcpRequestError("Structured ACP request requires a <cli_prompt> (or <task>) block.");
  }

  const task = decodeXmlValue(taskBody);
  if (!task) {
    throw new StructuredAcpRequestError("Structured ACP request task must not be empty.");
  }

  const agentId = decodeXmlValue(extractSingleTag(metaBody, "agentId") ?? "") || undefined;
  const sessionKey = decodeXmlValue(extractSingleTag(metaBody, "sessionKey") ?? "") || undefined;
  const model = decodeXmlValue(extractSingleTag(metaBody, "model") ?? "") || undefined;
  const maxTurnsRaw = decodeXmlValue(extractSingleTag(metaBody, "maxTurns") ?? "");
  const maxTurns = (() => {
    if (!maxTurnsRaw) return undefined;
    const n = parseInt(maxTurnsRaw, 10);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  })();
  const responseModeRaw = decodeXmlValue(extractSingleTag(metaBody, "responseMode") ?? "") || "sync-return";
  if (responseModeRaw !== "sync-return" && responseModeRaw !== "async-callback") {
    throw new StructuredAcpRequestError(
      `Unsupported structured ACP responseMode: ${responseModeRaw}`,
    );
  }

  const callback = parseCallback(metaBody);
  if (responseModeRaw === "async-callback" && !callback) {
    throw new StructuredAcpRequestError(
      "Structured ACP request with async-callback requires a <callback> block.",
    );
  }

  // 解析 contextControl（每个字段都是可选的）
  const contextControl: ContextControl = {};

  const includeArtifacts = extractSingleTag(metaBody, "includeArtifacts");
  if (includeArtifacts !== null) {
    contextControl.includeArtifacts = includeArtifacts.toLowerCase() === "true";
  }

  const includeTools = extractSingleTag(metaBody, "includeTools");
  if (includeTools !== null) {
    contextControl.includeTools = includeTools.toLowerCase() === "true";
  }

  const includeMemory = extractSingleTag(metaBody, "includeMemory");
  if (includeMemory !== null) {
    contextControl.includeMemory = includeMemory.toLowerCase() === "true";
  }

  const includeRules = extractSingleTag(metaBody, "includeRules");
  if (includeRules !== null) {
    contextControl.includeRules = includeRules.toLowerCase() === "true";
  }

  const includeAgents = extractSingleTag(metaBody, "includeAgents");
  if (includeAgents !== null) {
    contextControl.includeAgents = includeAgents.toLowerCase() === "true";
  }

  const includeIdentity = extractSingleTag(metaBody, "includeIdentity");
  if (includeIdentity !== null) {
    contextControl.includeIdentity = includeIdentity.toLowerCase() === "true";
  }

  const includeSoul = extractSingleTag(metaBody, "includeSoul");
  if (includeSoul !== null) {
    contextControl.includeSoul = includeSoul.toLowerCase() === "true";
  }

  // 解析 customGuide（支持 CDATA）
  const customGuideRaw = extractSingleTag(metaBody, "customGuide");
  const customGuide = customGuideRaw ? decodeXmlValue(customGuideRaw) : undefined;

  return {
    version,
    rawEnvelope: envelope.rawEnvelope,
    task,
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(model ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    responseMode: responseModeRaw,
    ...(callback ? { callback } : {}),
    ...(Object.keys(contextControl).length > 0 ? { contextControl } : {}),
    ...(customGuide ? { customGuide } : {}),
  };
}
