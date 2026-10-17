import { useSyncExternalStore } from "react";
import {
  DEFAULT_PROMPT_OPTIMIZE_PREFERENCE,
  PROMPT_OPTIMIZE_STORAGE_KEY,
  getPromptOptimizePreference,
  setPromptOptimizePreference as writePromptOptimizePreference,
  type PromptOptimizePreference,
} from "@/lib/prompt-optimize-preference";

// One store behind the composer's Optimize button and Settings › General, so a
// choice made in the panel applies to an open composer without a remount.
let preference: PromptOptimizePreference | null = null;
const listeners = new Set<() => void>();

function samePreference(a: PromptOptimizePreference, b: PromptOptimizePreference): boolean {
  return a.search === b.search
    && a.model?.provider === b.model?.provider
    && a.model?.modelId === b.model?.modelId;
}

// Storage is read here rather than through the library's own default, so a
// blocked or missing localStorage changes nothing but this store.
function readStoredPreference(): PromptOptimizePreference {
  try {
    return getPromptOptimizePreference(window.localStorage);
  } catch {
    return DEFAULT_PROMPT_OPTIMIZE_PREFERENCE;
  }
}

function getSnapshot(): PromptOptimizePreference {
  if (preference === null) preference = readStoredPreference();
  return preference;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

// Another tab chose; `key` is null when that tab cleared its storage.
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== PROMPT_OPTIMIZE_STORAGE_KEY) return;
  const next = readStoredPreference();
  if (preference !== null && samePreference(next, preference)) return;
  preference = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    // Nobody listened for another tab's choice meanwhile.
    preference = readStoredPreference();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/** Saves the choice for every open composer and panel in this browser. */
export function setPromptOptimizePreference(next: PromptOptimizePreference): void {
  if (samePreference(next, getSnapshot())) return;
  preference = next;
  try {
    writePromptOptimizePreference(next, window.localStorage);
  } catch {
    // Applies in memory even if the browser cannot save it.
  }
  notify();
}

export function usePromptOptimizePreference(): PromptOptimizePreference {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_PROMPT_OPTIMIZE_PREFERENCE);
}