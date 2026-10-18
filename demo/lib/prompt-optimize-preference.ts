// The prompt optimizer's model and search choices, kept per browser like the
// tool preset: they steer a composer action, not pi, and writing them to
// settings.json would add a key the pi CLI does not read.

const STORAGE_KEY = "pi-prompt-optimizer";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PromptOptimizePreference {
  /** null means "follow the model the composer is showing". */
  model: { provider: string; modelId: string } | null;
  /** Look through the project's files before rewriting. */
  search: boolean;
}

export const DEFAULT_PROMPT_OPTIMIZE_PREFERENCE: PromptOptimizePreference = {
  model: null,
  // Off by default: searching first costs an extra model call and a project
  // search. Opt in from Settings › General.
  search: false,
};

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseModel(value: unknown): PromptOptimizePreference["model"] {
  if (typeof value !== "object" || value === null) return null;
  const provider = (value as { provider?: unknown }).provider;
  const modelId = (value as { modelId?: unknown }).modelId;
  if (typeof provider !== "string" || !provider || typeof modelId !== "string" || !modelId) return null;
  return { provider, modelId };
}

export function getPromptOptimizePreference(
  storage: StorageLike | null = getBrowserStorage(),
): PromptOptimizePreference {
  if (!storage) return DEFAULT_PROMPT_OPTIMIZE_PREFERENCE;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PROMPT_OPTIMIZE_PREFERENCE;
    const parsed = JSON.parse(raw) as { model?: unknown; search?: unknown };
    return {
      model: parseModel(parsed?.model),
      search: typeof parsed?.search === "boolean"
        ? parsed.search
        : DEFAULT_PROMPT_OPTIMIZE_PREFERENCE.search,
    };
  } catch {
    return DEFAULT_PROMPT_OPTIMIZE_PREFERENCE;
  }
}

export function setPromptOptimizePreference(
  preference: PromptOptimizePreference,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Browser storage is best-effort.
  }
}
