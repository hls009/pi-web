import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  DEFAULT_PROMPT_OPTIMIZE_PREFERENCE,
  getPromptOptimizePreference,
  setPromptOptimizePreference,
} = await createJiti(import.meta.url).import("./prompt-optimize-preference.ts");

function fakeStorage(initial) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
    read: () => value,
  };
}

test("falls back to the defaults when storage is empty or broken", () => {
  assert.deepEqual(DEFAULT_PROMPT_OPTIMIZE_PREFERENCE, { model: null, search: false });
  assert.deepEqual(getPromptOptimizePreference(null), DEFAULT_PROMPT_OPTIMIZE_PREFERENCE);
  assert.deepEqual(getPromptOptimizePreference(fakeStorage(null)), DEFAULT_PROMPT_OPTIMIZE_PREFERENCE);
  assert.deepEqual(getPromptOptimizePreference(fakeStorage("{")), DEFAULT_PROMPT_OPTIMIZE_PREFERENCE);
  assert.deepEqual(
    getPromptOptimizePreference(fakeStorage(JSON.stringify({ model: "opus", search: "yes" }))),
    DEFAULT_PROMPT_OPTIMIZE_PREFERENCE,
  );
  assert.deepEqual(
    getPromptOptimizePreference(fakeStorage(JSON.stringify({ model: { provider: "", modelId: "m" }, search: true }))),
    { model: null, search: true },
  );
});

test("remembers a chosen model and the search switch", () => {
  const storage = fakeStorage();
  setPromptOptimizePreference({ model: { provider: "custom", modelId: "m" }, search: true }, storage);
  assert.deepEqual(
    getPromptOptimizePreference(storage),
    { model: { provider: "custom", modelId: "m" }, search: true },
  );
  setPromptOptimizePreference({ model: null, search: false }, storage);
  assert.deepEqual(getPromptOptimizePreference(storage), DEFAULT_PROMPT_OPTIMIZE_PREFERENCE);
});
