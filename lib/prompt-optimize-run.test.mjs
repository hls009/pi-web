import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(tmpdir(), "pi-optimize-isolation-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const sessions = join(root, "sessions");
await mkdir(sessions);
const sessionFile = join(sessions, "current.jsonl");
const timestamp = "2026-10-26T00:00:00.000Z";
const transcript = [
  { type: "session", version: 3, id: "current-chat", cwd: root, timestamp },
  { type: "message", id: "user-entry", parentId: null, timestamp,
    message: { role: "user", content: "existing conversation", timestamp: Date.parse(timestamp) } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
await writeFile(sessionFile, transcript);
await writeFile(join(root, "target.ts"), "export const target = 1;\n");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
});
const { runPromptOptimize } = await jiti.import("./prompt-optimize-run.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const manager = SessionManager.open(sessionFile, sessions, root);
const inner = {
  sessionId: manager.getSessionId(), sessionFile, sessionManager: manager,
  agent: { state: { messages: [{ role: "user", content: "existing conversation" }] } },
  isStreaming: false, isCompacting: false, isBashRunning: false,
  prompt() { throw new Error("The optimizer must never prompt the current session"); },
  steer() { throw new Error("The optimizer must never steer the current session"); },
  followUp() { throw new Error("The optimizer must never queue a follow-up"); },
};
const wrapper = new AgentSessionWrapper(inner);
const registry = new Map([[inner.sessionId, wrapper]]);
globalThis.__piSessions = registry;
const sessionEvents = [];
const unsubscribe = wrapper.onEvent((event) => sessionEvents.push(event));
wrapper.emit({ type: "isolation-listener-probe" });
assert.deepEqual(sessionEvents, [{ type: "isolation-listener-probe" }]);
sessionEvents.length = 0;
const originalEntries = JSON.stringify(manager.getEntries());
const originalMessages = JSON.stringify(inner.agent.state.messages);
const originalLeaf = manager.getLeafId();
const model = { id: "isolated-model", provider: "isolated-provider", api: "openai-completions", reasoning: false };
const input = { body: "修复登录按钮", search: false, provider: model.provider, modelId: model.id };
const answer = (text, stopReason = "stop") => ({ content: [{ type: "text", text }], stopReason });
const rewritten = JSON.stringify({ text: "请修复登录按钮的问题。" });

function fixture({ complete, refresh } = {}) {
  const calls = [];
  const runtime = {
    refresh: refresh ?? (async () => {}),
    getAvailable: async () => [],
    getModel: () => model,
    completeSimple: async (selected, context, options) => {
      calls.push({ selected, context, options });
      return complete ? complete(context, options, calls.length) : answer(rewritten);
    },
  };
  globalThis.__piWebSharedModelRuntime = {
    agentDir: root, runtime: Promise.resolve(runtime), queueKey: "optimizer-isolation-test", expiresAt: Infinity,
  };
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Infinity };
  return calls;
}

test.afterEach(async () => {
  assert.equal(await readFile(sessionFile, "utf8"), transcript);
  assert.deepEqual(await readdir(sessions, { recursive: true }), ["current.jsonl"]);
  assert.equal(globalThis.__piSessions, registry);
  assert.deepEqual([...registry.keys()], [inner.sessionId]);
  assert.equal(registry.get(inner.sessionId), wrapper);
  assert.equal(JSON.stringify(manager.getEntries()), originalEntries);
  assert.equal(manager.getLeafId(), originalLeaf);
  assert.equal(JSON.stringify(inner.agent.state.messages), originalMessages);
  assert.deepEqual(sessionEvents, [], "the live wrapper listener must receive no optimizer events");
  delete globalThis.__piWebSharedModelRuntime;
  delete globalThis.__piAllowedRootsCache;
});
test.after(async () => {
  unsubscribe();
  delete globalThis.__piSessions;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

test("rewrites through independent tool-free requests without creating or editing conversations", async () => {
  const calls = fixture();
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await runPromptOptimize(input), { text: "请修复登录按钮的问题。", retrieved: [], degraded: false });
  }
  assert.equal(new Set(calls.map(({ options }) => options.sessionId)).size, 2);
  for (const { context, options } of calls) {
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0].role, "user");
    assert.equal(context.tools, undefined);
    assert.equal(JSON.stringify(context).includes("current-chat"), false);
    assert.equal(options.cacheRetention, "none");
    assert.match(options.sessionId, /^pi-web-optimize-/);
  }
});

test("search planning and rewrite stay separate and only excerpts reach the final request", async () => {
  const calls = fixture({ complete: async (_, __, n) => answer(n === 1
    ? JSON.stringify({ paths: ["target.ts"], keywords: [] }) : rewritten) });
  const result = await runPromptOptimize({ ...input, search: true, cwd: root });
  assert.deepEqual(result.retrieved, ["target.ts"]);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].options.sessionId, calls[1].options.sessionId);
  assert.equal(calls[1].context.messages.length, 1);
  assert.match(calls[1].context.messages[0].content, /export const target/);
  assert.doesNotMatch(calls[1].context.messages[0].content, /"keywords"/);
});

test("a failed planner degrades but never appends an error to the rewritten text", async () => {
  const calls = fixture({ complete: async (_, __, n) => {
    if (n === 1) throw new Error("private planner failure");
    return answer(rewritten);
  } });
  const result = await runPromptOptimize({ ...input, search: true, cwd: root });
  assert.equal(calls.length, 2);
  assert.equal(result.degraded, true);
  assert.equal(result.text, "请修复登录按钮的问题。");
});

test("rejects incomplete completions, tool calls, invalid envelopes and optimizer commentary with 502", async () => {
  for (const response of [answer(rewritten, "length"), answer(rewritten, "toolUse"), answer(rewritten, "pending"),
    answer("plain text"), answer('{"text":"fix","explanation":"why"}'),
    answer(JSON.stringify({ text: "以下是优化后的提示词：修复登录" })),
    { content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }, { type: "text", text: rewritten }], stopReason: "stop" }]) {
    fixture({ complete: async () => response });
    await assert.rejects(runPromptOptimize(input), (error) => error.status === 502);
  }
});

test("thinking blocks never become part of the returned prompt", async () => {
  fixture({ complete: async () => ({ content: [
    { type: "thinking", thinking: "private optimizer reasoning" }, { type: "text", text: rewritten },
  ], stopReason: "stop" }) });
  assert.equal((await runPromptOptimize(input)).text, "请修复登录按钮的问题。");
});

test("cancellation before or during runtime preparation prevents model calls", async () => {
  for (const phase of ["before", "runtime"]) {
    const controller = new AbortController();
    const calls = fixture({ refresh: async () => { if (phase === "runtime") controller.abort(); } });
    if (phase === "before") controller.abort();
    await assert.rejects(runPromptOptimize({ ...input, signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls.length, 0);
  }
});

test("cancelling the planner never falls through to a rewrite", async () => {
  const controller = new AbortController();
  const calls = fixture({ complete: async () => {
    controller.abort();
    return answer('{"paths":["target.ts"],"keywords":[]}');
  } });
  await assert.rejects(runPromptOptimize({ ...input, search: true, cwd: root, signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls.length, 1);
});

test("a cancelled provider result is ignored even if the provider resolves successfully", async () => {
  const controller = new AbortController();
  fixture({ complete: async () => { controller.abort(); return answer(rewritten); } });
  await assert.rejects(runPromptOptimize({ ...input, signal: controller.signal }), { name: "AbortError" });
});

test("provider errors propagate and aborted providers retain timeout status", async () => {
  fixture({ complete: async () => answer("", "error") });
  await assert.rejects(runPromptOptimize(input), (error) => error.status === 502);
  fixture({ complete: async () => answer("", "aborted") });
  await assert.rejects(runPromptOptimize(input), (error) => error.status === 504);
});

test("the request deadline rejects a late provider success with 504", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let finish;
  const calls = fixture({ complete: () => new Promise((resolve) => { finish = resolve; entered(); }) });
  const result = runPromptOptimize(input);
  await started;
  t.mock.timers.tick(90_001);
  assert.equal(calls[0].options.signal.aborted, true);
  finish(answer(rewritten));
  await assert.rejects(result, (error) => error.status === 504);
});
