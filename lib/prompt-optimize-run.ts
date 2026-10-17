// The prompt optimizer's one-shot model call.
//
// Nothing here creates a session, touches a session file, or writes settings:
// the browser sends the text it is about to send, this rewrites it, and the
// browser puts the result back in its own draft. The model comes from the same
// extension-aware runtime the Models settings read, so an API key, OAuth login
// or models.json provider configured there works here unchanged.

import { randomUUID } from "node:crypto";
import type { AssistantMessage, Model, Api } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { getModelRuntimeWithExtensions } from "./model-runtime";
import { listProjectFiles } from "./project-files";
import {
  buildOptimizeSystemPrompt,
  buildOptimizeUserMessage,
  buildRetrievalPlanUserMessage,
  parseOptimizedText,
  parseRetrievalPlan,
  RETRIEVAL_PLAN_SYSTEM_PROMPT,
  type RetrievalPlan,
} from "./prompt-optimize";
import {
  PROJECT_SEARCH_LIMITS,
  formatProjectContext,
  rankCandidateFiles,
  readProjectExcerpts,
  searchProjectContents,
} from "./prompt-retrieval";
import { resolveTitleThinkingLevel } from "./session-title";

/** A rewrite is one short request; anything slower is a stuck provider. */
const OPTIMIZE_TIMEOUT_MS = 90_000;
/** The planner only picks paths, so it is cheaper and quicker to give up on. */
const PLAN_TIMEOUT_MS = 30_000;
const OPTIMIZE_MAX_TOKENS = 2_048;
const PLAN_MAX_TOKENS = 512;
/** Content search hits considered before the local rank picks its excerpts. */
const CONTENT_HIT_LIMIT = 20;

export class PromptOptimizeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PromptOptimizeError";
  }
}

export interface PromptOptimizeInput {
  /** The text to rewrite (the part after a slash command). */
  body: string;
  /** The slash command, when the user typed one. */
  command?: string;
  commandDescription?: string;
  /** Look through the project's files first. */
  search: boolean;
  /** The session's working directory; required for the search step. */
  cwd?: string;
  provider: string;
  modelId: string;
  signal?: AbortSignal;
}

export interface PromptOptimizeResult {
  text: string;
  /** Paths whose excerpts reached the model. */
  retrieved: string[];
  /** Search was asked for but nothing could be gathered. */
  degraded: boolean;
}

interface CompleteOptions {
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

function linkSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function completeText(
  runtime: ModelRuntime,
  model: Model<Api>,
  context: { systemPrompt: string; userMessage: string },
  options: CompleteOptions,
): Promise<AssistantMessage> {
  const controller = new AbortController();
  const signal = linkSignals(options.signal, controller.signal);
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  // A rewrite is a rewriting task, not a reasoning one: the cheapest level the
  // model supports, the same rule titles use (and the same helper).
  const thinkingLevel = resolveTitleThinkingLevel(model);

  try {
    const message = await runtime.completeSimple(model, {
      systemPrompt: context.systemPrompt,
      messages: [{
        role: "user",
        content: context.userMessage,
        timestamp: Date.now(),
      }],
    }, {
      maxTokens: options.maxTokens,
      cacheRetention: "none",
      sessionId: `pi-web-optimize-${randomUUID()}`,
      signal,
      ...(thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    });

    if (message.stopReason === "error") {
      throw new PromptOptimizeError(message.errorMessage || "The optimizer request failed", 502);
    }
    if (message.stopReason === "aborted") {
      throw new PromptOptimizeError("The optimizer request timed out", 504);
    }
    return message;
  } catch (error) {
    // A provider that rejects on the aborting signal reads the same: this
    // request's own deadline, not a caller who left.
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new PromptOptimizeError("The optimizer request timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Whether the search may read this folder at all: the cwd comes from the
 * browser, so it is checked against the same allow-list `/api/file-index` and
 * `/api/files` use before git or the walk runs anywhere.
 */
async function isAllowedSearchCwd(cwd: string | undefined): Promise<string | undefined> {
  if (!cwd) return undefined;
  try {
    return isExistingFilePathAllowed(cwd, await getAllowedFileRoots()) ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/** The model for `provider/modelId`, or a typed refusal the route can pass on. */function resolveModel(runtime: ModelRuntime, provider: string, modelId: string): Model<Api> {
  const model = runtime.getModel(provider, modelId);
  if (!model) {
    throw new PromptOptimizeError(`Model not found: ${provider}/${modelId}`, 400);
  }
  return model;
}

/** The planner's picks, or null when it answered nothing usable. */
async function planRetrieval(
  runtime: ModelRuntime,
  model: Model<Api>,
  body: string,
  signal?: AbortSignal,
): Promise<RetrievalPlan | null> {
  try {
    const message = await completeText(runtime, model, {
      systemPrompt: RETRIEVAL_PLAN_SYSTEM_PROMPT,
      userMessage: buildRetrievalPlanUserMessage(body),
    }, { maxTokens: PLAN_MAX_TOKENS, timeoutMs: PLAN_TIMEOUT_MS, signal });
    return parseRetrievalPlan(textOf(message));
  } catch {
    // A failed plan is not a failed rewrite: fall back to rewriting alone.
    return null;
  }
}

export async function runPromptOptimize(input: PromptOptimizeInput): Promise<PromptOptimizeResult> {
  const runtime = await getModelRuntimeWithExtensions();
  const model = resolveModel(runtime, input.provider, input.modelId);

  let projectContext: string | undefined;
  let retrieved: string[] = [];
  let degraded = false;

  if (input.search) {
    const searchCwd = await isAllowedSearchCwd(input.cwd);
    const plan = searchCwd ? await planRetrieval(runtime, model, input.body, input.signal) : null;
    if (plan && searchCwd) {
      try {
        const listing = await listProjectFiles(searchCwd);
        const contentHits = await searchProjectContents(searchCwd, plan.keywords, CONTENT_HIT_LIMIT);
        const candidates = rankCandidateFiles(
          listing.files,
          plan,
          PROJECT_SEARCH_LIMITS.maxFiles + 2,
          contentHits,
        );
        const excerpts = await readProjectExcerpts(searchCwd, candidates);
        if (excerpts.length > 0) {
          retrieved = excerpts.map((excerpt) => excerpt.path);
          projectContext = formatProjectContext(excerpts, Math.max(0, candidates.length - excerpts.length));
        } else {
          degraded = true;
        }
      } catch {
        degraded = true;
      }
    } else {
      degraded = true;
    }
  }

  const message = await completeText(runtime, model, {
    systemPrompt: buildOptimizeSystemPrompt({
      ...(input.command ? { command: input.command } : {}),
      ...(input.commandDescription ? { commandDescription: input.commandDescription } : {}),
      search: Boolean(projectContext),
    }),
    userMessage: buildOptimizeUserMessage(input.body, projectContext),
  }, { maxTokens: OPTIMIZE_MAX_TOKENS, timeoutMs: OPTIMIZE_TIMEOUT_MS, signal: input.signal });

  const text = textOf(message);
  if (!text) throw new PromptOptimizeError("The optimizer returned an empty prompt", 502);

  return {
    text: parseOptimizedText(text),
    retrieved,
    degraded,
  };
}
