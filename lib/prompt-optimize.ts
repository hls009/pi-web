// Prompt optimization: the pure half, shared by the composer and the route.
//
// The feature rewrites what the user typed into a clearer prompt, before it is
// sent. Nothing here touches pi: the route only calls a model, and the composer
// only replaces its own draft text. The slash-command rules are the delicate
// part — a rewrite must never change or lose the command the user typed, so the
// split keeps the command and the whitespace after it verbatim and only the
// body is ever sent for rewriting.

export interface CommandSplit {
  /** The leading slash command exactly as typed (`/skill:review`), or null. */
  command: string | null;
  /** Whitespace between the command and its body, kept verbatim on rebuild. */
  separator: string;
  /** The text to rewrite. Without a command this is the whole input. */
  body: string;
}

export interface KnownCommands {
  /** Command names without the leading slash, as the palette lists them. */
  names: readonly string[];
  /**
   * True once the session's extension, prompt and skill commands have loaded.
   * Until then an unknown name is still treated as a command: preserving a
   * prefix the user typed is harmless, rewriting one is not.
   */
  complete: boolean;
}

// A command name is one token. A path like `/usr/local/bin` stops at the second
// slash, so the "whole word" check below rejects it before any list is needed.
const COMMAND_TOKEN = /^\/([A-Za-z0-9_.:-]+)/;

export function splitCommandInput(text: string, known: KnownCommands): CommandSplit {
  const match = COMMAND_TOKEN.exec(text);
  if (!match) return { command: null, separator: "", body: text };

  const rest = text.slice(match[0].length);
  // The token must be a whole word: `/foo bar` splits, `/foo/bar` and `/foo@x` do not.
  if (rest !== "" && !/^\s/.test(rest)) return { command: null, separator: "", body: text };

  const name = match[1].toLowerCase();
  const isKnown = known.names.some((command) => command.replace(/^\//, "").toLowerCase() === name);
  // A complete list that does not name it means prose that starts with a slash:
  // `/tmp is full` is a question, not a command, and the whole text is the body.
  // Without the list, keep the prefix rather than risk rewriting a command.
  if (!isKnown && known.complete) return { command: null, separator: "", body: text };

  const separator = /^\s+/.exec(rest)?.[0] ?? "";
  return { command: match[0], separator, body: rest.slice(separator.length) };
}

/** Rebuild the composer text from a split and a rewritten body. */
export function composeCommandInput(split: CommandSplit, body: string): string {
  if (!split.command) return body;
  return `${split.command}${split.separator}${body}`;
}

/**
 * Whether there is a description worth rewriting. A bare command has nothing,
 * and neither has a single-token body: `/model gpt-5` or `/compact 3` is an
 * argument to that command, and a rewrite could only damage it.
 */
export function hasOptimizableBody(body: string, command?: string | null): boolean {
  const text = body.trim();
  if (!text) return false;
  return command ? /\s/.test(text) : true;
}

export interface TextReferences {
  mentions: string[];
  urls: string[];
}

/**
 * The verbatim items a rewrite must keep. `@file` mentions follow the
 * composer's own rule (at the start of the text or after whitespace), so an
 * email never counts as one.
 */
export function collectReferences(text: string): TextReferences {
  const mentions = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|([^\s@"]+))/g)) {
    mentions.add(match[1] ?? match[2]);
  }
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>()"'\]]+/g)) {
    urls.add(match[0].replace(/[.,;:!?]+$/, ""));
  }
  return { mentions: [...mentions], urls: [...urls] };
}

/**
 * Whether a rewrite kept every reference the original held. A model that drops
 * an `@path` would silently change what pi reads, so the composer refuses such
 * a result and keeps the user's text instead of showing half of it.
 */
export function referencesPreserved(before: TextReferences, after: TextReferences): boolean {
  const keptMentions = new Set(after.mentions);
  if (before.mentions.some((mention) => !keptMentions.has(mention))) return false;
  const keptUrls = new Set(after.urls);
  return before.urls.every((url) => keptUrls.has(url));
}

const LABEL_LINES = [
  /^(?:optimized\s+prompt|improved\s+prompt|rewritten\s+prompt|prompt)\s*[:：-]\s*/i,
  /^(?:优化后的?提示词|优化后|改写后的?提示词|提示词)\s*[:：-]\s*/,
];

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["\u201c", "\u201d"],
    ["\u300c", "\u300d"],
    ["\u300e", "\u300f"],
  ];
  for (const [start, end] of pairs) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, -end.length).trim();
    }
  }
  return value;
}

/**
 * The model's reply, cleaned of the wrappers a prompt-shaped answer tends to
 * carry: a code fence around the whole thing and a leading "Optimized prompt:"
 * label. Multi-paragraph text is kept as it is — this is a prompt, not a title.
 */
export function parseOptimizedText(raw: string): string {
  let value = raw.trim();
  const fenced = /^```[A-Za-z]*\s*\n?([\s\S]*?)\n?```$/.exec(value);
  if (fenced) value = fenced[1].trim();

  const lines = value.split(/\r?\n/);
  const labelIndex = lines.findIndex((line) => line.trim() !== "");
  if (labelIndex >= 0) {
    for (const pattern of LABEL_LINES) {
      const stripped = lines[labelIndex].replace(pattern, "");
      if (stripped !== lines[labelIndex]) {
        lines[labelIndex] = stripped;
        break;
      }
    }
    value = lines.join("\n").trim();
  }

  value = stripWrappingQuotes(value).trim();
  if (!value) throw new Error("The optimizer returned an empty prompt");
  return value;
}

export interface OptimizePromptContext {
  /** The slash command the body belongs to, as typed. */
  command?: string;
  /** What the palette says that command is for. */
  commandDescription?: string;
  /** True when project files were retrieved for this request. */
  search: boolean;
}

const BASE_SYSTEM_PROMPT = [
  "You rewrite a user's rough request into a prompt for a coding agent.",
  "",
  "Reply with the rewritten prompt only: no preamble, no commentary, no surrounding quotes, no code fences.",
  "",
  "Rules:",
  "- Keep the user's intent and language. Never add requirements, features or files the user did not ask for.",
  "- Copy verbatim: file paths, @file mentions, URLs, code blocks, command names, identifiers, numbers and error messages.",
  "- Make the goal explicit, and keep constraints the user already gave.",
  "- Use short sections or a list when that makes the request clearer; one short paragraph when it does not.",
  "- If the request is already clear, stay close to its wording.",
  "- Do not answer the request, do not plan the implementation, do not call tools.",
].join("\n");

export function buildOptimizeSystemPrompt(context: OptimizePromptContext): string {
  const parts = [BASE_SYSTEM_PROMPT];
  if (context.command) {
    const description = context.commandDescription?.trim();
    parts.push([
      "",
      `- The user typed this text after the slash command \`${context.command}\`${description ? ` (${description})` : ""}.`,
      "  Rewrite only the text that follows it, as arguments for that command: keep what it already asks for and make it precise.",
      "  Never write a slash command yourself, and never move the command into the text.",
      "  That text may be an argument rather than a request (a number, a path, a flag, a model or skill name). When it is, return it unchanged.",
    ].join("\n"));
  }
  if (context.search) {
    parts.push([
      "",
      "- Project files gathered from the working directory follow the request below.",
      "  Reference only paths and symbols that appear there; never invent a path.",
    ].join("\n"));
  }
  return parts.join("\n");
}

export function buildOptimizeUserMessage(body: string, projectContext?: string): string {
  const parts = ["<request>", body.trim(), "</request>"];
  if (projectContext?.trim()) {
    parts.push("", "<project-files>", projectContext.trim(), "</project-files>");
  }
  return parts.join("\n");
}

export const RETRIEVAL_PLAN_SYSTEM_PROMPT = [
  "You locate files in a software project that are relevant to a request, so they can be read and used as context. You do not see the repository here.",
  "",
  'Reply with JSON only: {"paths": [], "keywords": []}',
  "- paths: up to 6 paths you expect to exist in this project, relative to its root, most relevant first. Empty when the request implies no particular file.",
  "- keywords: up to 8 short search terms — identifiers, symbol names, error text or domain words — that would find the relevant code. Use the language the code is most likely written in.",
].join("\n");

export function buildRetrievalPlanUserMessage(body: string): string {
  return ["<request>", body.trim(), "</request>"].join("\n");
}

export interface RetrievalPlan {
  paths: string[];
  keywords: string[];
}

const MAX_PLAN_ITEMS = 8;

function boundedStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, 200);
    if (!trimmed || items.includes(trimmed)) continue;
    items.push(trimmed);
    if (items.length >= limit) break;
  }
  return items;
}

/** The planner's reply, or null when it is not the JSON shape we asked for. */
export function parseRetrievalPlan(raw: string): RetrievalPlan | null {
  let value = raw.trim();
  const fenced = /^```[A-Za-z]*\s*\n?([\s\S]*?)\n?```$/.exec(value);
  if (fenced) value = fenced[1].trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1)) as { paths?: unknown; keywords?: unknown };
    const paths = boundedStrings(parsed.paths, MAX_PLAN_ITEMS);
    const keywords = boundedStrings(parsed.keywords, MAX_PLAN_ITEMS);
    if (paths.length === 0 && keywords.length === 0) return null;
    return { paths, keywords };
  } catch {
    return null;
  }
}
