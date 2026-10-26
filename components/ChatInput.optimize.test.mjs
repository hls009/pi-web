import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const pure = await createJiti(import.meta.url).import("../lib/prompt-optimize.ts");
const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  const node = find(source);
  assert.ok(node, `missing component callback ${name}`);
  return new Script(ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function layoutEffect(containing) {
  function find(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useLayoutEffect"
      && node.arguments[0].getText(source).includes(containing)) return node.arguments[0];
    return ts.forEachChild(node, find);
  }
  const node = find(source);
  assert.ok(node, `missing layout effect ${containing}`);
  return new Script(ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
}

// Execute the real component callbacks, as ChatInput.test.mjs does for keyboard
// handlers. The deferred fetch deliberately ignores abort to expose late results.
function fixture(initial = "修复登录按钮") {
  const state = { value: initial, notice: null, busy: false, sent: [] };
  const requests = [];
  const env = {
    ...pure, AbortController,
    valueRef: { current: initial }, draftKeyRef: { current: "chat-a" },
    draftRevisionRef: { current: 0 }, optimizeRequestRef: { current: null },
    optimizeAbortRef: { current: null }, optimizeContextRef: { current: { draftKey: "chat-a", cwd: "/project" } },
    knownCommands: { names: ["skill:review"], complete: true },
    optimizeModel: { provider: "p", modelId: "m" }, optimizePreference: { search: true },
    cwd: "/project", draftKey: "chat-a", slashCommands: [],
    slashCommandsRequestedRef: { current: false }, onLoadSlashCommands: undefined,
    findPaletteCommand: () => undefined, getSlashDescription: () => "", t: (key) => key,
    setOptimizing: (value) => { state.busy = value; },
    setOptimizeNotice: (value) => { state.notice = value; },
    setValueState: (value) => { state.value = typeof value === "function" ? value(state.value) : value; },
    textareaRef: { current: null }, setAtQuery: () => {}, requestAnimationFrame: () => {},
    setHistoryMenuOpen: () => {}, clearImages: () => {}, clearDraft: () => {},
    attachedImages: [{ data: "original-image", mimeType: "image/png" }],
    isStreaming: false, runBuiltinCommand: async () => false, onAudioUnlock: undefined,
    offersBuiltinSlashCommandWhileStreaming: () => false,
    onSend: (...args) => state.sent.push(args),
    fetch: (url, options) => {
      assert.equal(url, "/api/prompt/optimize");
      return new Promise((resolve, reject) => requests.push({
        options, reject,
        resolve: (data, ok = true) => resolve({ ok, status: ok ? 200 : 502, json: async () => data }),
      }));
    },
  };
  for (const name of ["invalidateOptimize", "setValue", "clearInput", "applyOptimizedText", "runOptimize", "cancelOptimize", "handleSend"]) {
    env[name] = callback(name).runInNewContext(env);
  }
  return {
    state, env, requests,
    edit(value) { env.valueRef.current = value; env.setValue(value); },
    async finish(index = 0, data = { text: "请修复登录按钮。", retrieved: ["target.ts"], degraded: false }) {
      requests[index].resolve(data); await tick();
    },
  };
}

test("optimization applies only prompt text, preserves command prefixes, never sends, and remains undoable", async () => {
  const f = fixture("/skill:review  修复 登录按钮");
  f.env.runOptimize();
  assert.equal(f.state.busy, true);
  const payload = JSON.parse(f.requests[0].options.body);
  assert.equal(payload.command, "/skill:review");
  assert.equal(payload.body, "修复 登录按钮");
  assert.equal(payload.sessionId, undefined);
  assert.equal(payload.messages, undefined);
  await f.finish();
  assert.equal(f.state.value, "/skill:review  请修复登录按钮。");
  assert.equal(f.state.notice.previous, "/skill:review  修复 登录按钮");
  assert.deepEqual(f.state.sent, []);
  f.env.optimizeNotice = f.state.notice;
  callback("undoOptimize").runInNewContext(f.env)();
  assert.equal(f.state.value, "/skill:review  修复 登录按钮");
});

test("editing and restoring identical text invalidates the old request", async () => {
  const f = fixture();
  f.env.runOptimize();
  f.edit("changed"); f.edit("修复登录按钮");
  assert.equal(f.requests[0].options.signal.aborted, true);
  await f.finish();
  assert.equal(f.state.value, "修复登录按钮");
  assert.equal(f.state.notice, null);
  assert.equal(f.state.busy, false);
});

test("optimization never loads commands through a callback that can start the current session", async () => {
  const f = fixture();
  let commandLoads = 0;
  f.env.slashCommands = undefined;
  f.env.onLoadSlashCommands = async () => { commandLoads++; };
  f.env.runOptimize(); await f.finish();
  assert.equal(commandLoads, 0);
});

test("an identical draft in another chat or cwd cannot receive the result", async () => {
  for (const context of [{ draftKey: "chat-b", cwd: "/project" }, { draftKey: "chat-a", cwd: "/other" }]) {
    const f = fixture(); f.env.runOptimize();
    // Guard before effects: result ownership checks the latest committed context.
    f.env.optimizeContextRef.current = context;
    f.env.draftKeyRef.current = context.draftKey;
    await f.finish();
    assert.equal(f.state.value, "修复登录按钮");
    assert.equal(f.state.notice, null);
  }
});

test("context changes and unmount cleanup abort and invalidate late results", async () => {
  for (const phase of ["context", "unmount"]) {
    const f = fixture(); f.env.runOptimize();
    if (phase === "context") {
      f.env.draftKey = "chat-b";
      f.env.draftKeyRef.current = "chat-b";
      layoutEffect("optimizeContextRef.current =").runInNewContext(f.env)();
      assert.equal(f.state.busy, false);
    } else {
      layoutEffect("optimizeRequestRef.current?.controller.abort()").runInNewContext(f.env)()();
    }
    assert.equal(f.requests[0].options.signal.aborted, true);
    await f.finish();
    assert.equal(f.state.value, "修复登录按钮");
    assert.equal(f.state.notice, null);
  }
});

test("cancel and retry ignore old successes, errors and finalizers", async () => {
  for (const oldFails of [false, true]) {
    const f = fixture(); f.env.runOptimize(); f.env.cancelOptimize(); f.env.runOptimize();
    assert.equal(f.requests[0].options.signal.aborted, true);
    if (oldFails) { f.requests[0].reject(new Error("old failure")); await tick(); }
    else await f.finish(0);
    assert.equal(f.state.value, "修复登录按钮");
    assert.equal(f.state.notice, null);
    assert.equal(f.state.busy, true);
    await f.finish(1);
    assert.equal(f.state.value, "请修复登录按钮。");
    assert.equal(f.state.busy, false);
  }
});

test("provider errors preserve the draft and remain outside the send payload", async () => {
  const f = fixture(); f.env.runOptimize();
  f.requests[0].resolve({ error: "optimizer failed" }, false); await tick();
  assert.equal(f.state.value, "修复登录按钮");
  assert.equal(f.state.notice.kind, "error");
  assert.deepEqual(f.state.sent, []);
});

test("user submission sends only the current draft and original attachments, then invalidates optimization", async () => {
  const f = fixture(); f.env.runOptimize(); await f.finish();
  f.env.value = f.state.value;
  await f.env.handleSend();
  assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.sent[0][0], "请修复登录按钮。");
  assert.equal(f.state.sent[0][1], f.env.attachedImages);
  assert.equal(f.state.notice, null);
  assert.equal(f.state.value, "");

  const pending = fixture(); pending.env.runOptimize(); pending.env.value = pending.state.value;
  await pending.env.handleSend(); await pending.finish();
  assert.equal(pending.state.value, "");
  assert.equal(pending.state.sent.length, 1);
  assert.equal(pending.requests[0].options.signal.aborted, true);
});
