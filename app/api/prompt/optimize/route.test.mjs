import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The route reads the agent dir for the model runtime; keep it off the real one.
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-prompt-optimize-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const { POST } = await createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
}).import("./route.ts");

const jsonHeaders = { host: "localhost", "Content-Type": "application/json" };

function post(body, headers = jsonHeaders) {
  return POST(new Request("http://localhost/api/prompt/optimize", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("refuses an untrusted request, a wrong content type and a bad body", async () => {
  const payload = { body: "fix the login bug", provider: "p", modelId: "m" };

  assert.equal((await post(payload, { ...jsonHeaders, origin: "https://evil.example" })).status, 403);
  assert.equal((await post(payload, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("{")).status, 400);
  assert.equal((await post({ ...payload, body: "" })).status, 400);
  assert.equal((await post({ ...payload, body: "   " })).status, 400);
  assert.equal((await post({ ...payload, body: "x".repeat(20_001) })).status, 400);
  assert.equal((await post({ body: "fix it" })).status, 400);
  assert.equal((await post({ ...payload, provider: "" })).status, 400);
});

test("reports an unknown model without calling anything", async () => {
  const response = await post({ body: "fix the login bug", provider: "pi-web-nope", modelId: "pi-web-nope" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Model not found: pi-web-nope/pi-web-nope" });
});

test("keeps the public response shape and maps invalid results, timeouts and cancellation", async () => {
  const payload = { body: "fix login", provider: "isolated", modelId: "model" };
  let response;
  let calls = 0;
  let onComplete = () => {};
  globalThis.__piWebSharedModelRuntime = {
    agentDir, expiresAt: Infinity, queueKey: "optimize-route-test",
    runtime: Promise.resolve({
      refresh: async () => {}, getAvailable: async () => [],
      getModel: () => ({ id: "model", provider: "isolated", reasoning: false }),
      completeSimple: async () => { calls++; onComplete(); return response; },
    }),
  };
  try {
    response = { stopReason: "stop", content: [{ type: "text", text: '{"text":"Fix the login button."}' }] };
    const success = await post({ ...payload, sessionId: "current-chat", messages: [{ role: "user", content: "do not inject" }] });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { text: "Fix the login button.", retrieved: [], degraded: false });
    for (const stopReason of ["length", "toolUse", "error"]) {
      response = { ...response, stopReason };
      assert.equal((await post(payload)).status, 502);
    }
    response = { stopReason: "stop", content: [{ type: "text", text: "Here is your prompt" }] };
    assert.equal((await post(payload)).status, 502);
    response = { stopReason: "aborted", content: [] };
    assert.equal((await post(payload)).status, 504);
    const controller = new AbortController();
    onComplete = () => controller.abort();
    assert.equal((await POST(new Request("http://localhost/api/prompt/optimize", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify(payload), signal: controller.signal,
    }))).status, 499);
    const previousCalls = calls;
    assert.equal((await POST(new Request("http://localhost/api/prompt/optimize", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify(payload), signal: controller.signal,
    }))).status, 499);
    assert.equal(calls, previousCalls);
  } finally {
    delete globalThis.__piWebSharedModelRuntime;
  }
});
