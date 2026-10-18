// Project retrieval for the prompt optimizer's "search first" mode.
//
// The request alone is usually enough for a model to guess where the relevant
// code lives; this module turns those guesses into real file paths and short
// excerpts, all locally. Nothing here is sent anywhere by itself: the caller
// decides what reaches the model, and every path is checked against the same
// allow-list as `/api/files` before it is read.

import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import type { RetrievalPlan } from "./prompt-optimize";
import { readRegularFileText } from "./regular-file";

const execFileAsync = promisify(execFile);

/**
 * Files this large are never the target of a request this small, and the read
 * is bounded so a FIFO or a device never blocks the server (see regular-file).
 * The excerpt is then cut well below this.
 */
const HARD_READ_BYTES = 512 * 1024;

const GIT_GREP_TIMEOUT_MS = 5_000;
/** Same window as the file listing: a prompt rewritten twice reuses the search. */
const GIT_GREP_CACHE_TTL_MS = 10_000;
const GIT_GREP_CACHE_MAX_ENTRIES = 20;
/** Paths kept per query; the caller's `limit` slices below this. */
const GIT_GREP_HARD_CAP = 1_000;

interface GrepCacheEntry {
  hits: string[];
  expiresAt: number;
}

// Per-process so it survives Next.js hot-reload, like the file-index cache; the
// keys include the cwd and the sorted terms, so only a repeated query reuses it.
declare global {
  var __piPromptGrepCache: Map<string, GrepCacheEntry> | undefined;
}

function getGrepCache(): Map<string, GrepCacheEntry> {
  if (!globalThis.__piPromptGrepCache) globalThis.__piPromptGrepCache = new Map();
  return globalThis.__piPromptGrepCache;
}

function grepCacheKey(cwd: string, terms: readonly string[]): string {
  return `${cwd}\0${[...new Set(terms)].sort().join("\0")}`;
}
/** Extensions we never read: binaries and archives. Everything else is tried. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svgz", "tif", "tiff",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war", "exe", "dll",
  "so", "dylib", "bin", "class", "pyc", "node", "wasm", "woff", "woff2", "ttf",
  "otf", "eot", "mp3", "mp4", "m4a", "mov", "avi", "webm", "ogg", "wav", "flac",
  "sqlite", "sqlite3", "db", "dat", "pdb", "lib", "o", "a", "obj",
  "lockb", "snap", "pack", "idx",
]);
/** Lock files and minified bundles: text, but never useful context. */
const NOISY_BASENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "composer.lock",
  "cargo.lock", "poetry.lock", "gemfile.lock",
]);

export function isLikelyTextPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  if (NOISY_BASENAMES.has(base)) return false;
  if (base.endsWith(".min.js") || base.endsWith(".min.css") || base.endsWith(".map")) return false;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return true;
  return !BINARY_EXTENSIONS.has(base.slice(dot + 1));
}

export interface RankedCandidate {
  path: string;
  score: number;
}

/**
 * Candidate paths for a plan, ranked. A guessed path that matches wins over a
 * keyword hit in the name, which wins over a keyword anywhere in the path;
 * content hits (from `git grep`) are placed between the two, since the word
 * being in the file is stronger evidence than its being in a folder name.
 * Shallower paths win ties, so the project's own code beats a vendored copy.
 */
export function rankCandidateFiles(
  files: readonly string[],
  plan: RetrievalPlan,
  limit: number,
  contentHits: readonly string[] = [],
): string[] {
  const wantedPaths = plan.paths.map((entry) => entry.replace(/\\/g, "/").toLowerCase());
  const keywords = plan.keywords.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const hitSet = new Set(contentHits.map((entry) => entry.replace(/\\/g, "/").toLowerCase()));
  const scored = new Map<string, number>();

  for (const file of files) {
    if (!isLikelyTextPath(file)) continue;
    const lower = file.replace(/\\/g, "/").toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score = 0;
    for (const wanted of wantedPaths) {
      const wantedBase = wanted.slice(wanted.lastIndexOf("/") + 1);
      if (lower === wanted) score += 100;
      else if (lower.endsWith(`/${wanted}`)) score += 60;
      else if (wanted.endsWith(`/${lower}`)) score += 40;
      else if (base === wantedBase) score += 20;
    }
    if (hitSet.has(lower)) score += 30;
    for (const keyword of keywords) {
      if (base.includes(keyword)) score += 12;
      else if (lower.includes(keyword)) score += 5;
    }
    if (score > 0) scored.set(file, score);
  }

  const depth = (value: string) => value.split("/").length;
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || depth(a[0]) - depth(b[0]) || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([file]) => file);
}

/** A whole-file excerpt cut to `maxBytes`, preferring a line boundary. */
export function truncateExcerpt(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    end += character.length;
  }
  const cut = text.slice(0, end);
  const boundary = cut.lastIndexOf("\n");
  const kept = (boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd();
  return `${kept}\n… [truncated]`;
}

export interface ProjectSearchLimits {
  /** Files whose excerpts are read. */
  maxFiles: number;
  /** Total bytes of all excerpts together. */
  maxTotalBytes: number;
  /** Bytes read per file. */
  maxBytesPerFile: number;
}

export const PROJECT_SEARCH_LIMITS: ProjectSearchLimits = {
  // Six excerpts of at most 6 KB are about 5k tokens of context: enough to name
  // the right file and its symbols, small enough to keep the rewrite cheap.
  maxFiles: 6,
  maxBytesPerFile: 6 * 1024,
  maxTotalBytes: 20 * 1024,
};

export async function searchProjectContents(
  cwd: string,
  keywords: readonly string[],
  limit: number,
): Promise<string[]> {
  const terms = keywords.map((entry) => entry.trim()).filter(Boolean).slice(0, 8);
  if (terms.length === 0) return [];
  const wanted = Math.max(0, limit);
  if (wanted === 0) return [];

  const cache = getGrepCache();
  const key = grepCacheKey(cwd, terms);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.hits.slice(0, wanted);

  let hits: string[];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "grep", "-l", "-I", "-i", "-F", ...terms.flatMap((term) => ["-e", term]), "--"],
      { timeout: GIT_GREP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    hits = stdout.split(/\r?\n/).filter(Boolean).slice(0, GIT_GREP_HARD_CAP);
  } catch {
    // Not a git repo, no match, or the search timed out: path matching alone.
    hits = [];
  }

  // The empty answer is cached too: outside a repository the repeated git call
  // is cheap but pointless, and a real miss is the same answer within the TTL.
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(entryKey);
  }
  if (cache.size >= GIT_GREP_CACHE_MAX_ENTRIES) cache.clear();
  cache.set(key, { hits, expiresAt: now + GIT_GREP_CACHE_TTL_MS });
  return hits.slice(0, wanted);
}

export interface RetrievedExcerpt {
  /** Relative to cwd, as the listing spells it. */
  path: string;
  content: string;
}

/**
 * The excerpts for a set of candidate paths, in the order given. A path the
 * allow-list does not cover, a file too large to be worth reading, or one that
 * turns out to be binary is dropped rather than failing the request.
 *
 * `allowedRoots` is resolved once per request by the caller; a test passes its
 * own instead of publishing roots for a project it just created.
 */
export async function readProjectExcerpts(
  cwd: string,
  paths: readonly string[],
  limits: ProjectSearchLimits = PROJECT_SEARCH_LIMITS,
  allowedRoots?: Set<string>,
): Promise<RetrievedExcerpt[]> {
  const roots = allowedRoots ?? await getAllowedFileRoots();
  const excerpts: RetrievedExcerpt[] = [];
  let used = 0;

  for (const relative of paths) {
    if (excerpts.length >= limits.maxFiles || used >= limits.maxTotalBytes) break;
    if (!isLikelyTextPath(relative)) continue;
    const absolute = path.resolve(cwd, relative);
    if (!isExistingFilePathAllowed(absolute, roots)) continue;

    let text: string | undefined;
    try {
      text = readRegularFileText(absolute, HARD_READ_BYTES);
    } catch {
      continue;
    }
    if (!text || text.includes("\0")) continue;

    const remaining = limits.maxTotalBytes - used;
    const budget = Math.min(limits.maxBytesPerFile, remaining);
    const content = truncateExcerpt(text, budget);
    used += Buffer.byteLength(content, "utf8");
    excerpts.push({ path: relative.replace(/\\/g, "/"), content });
  }

  return excerpts;
}

/** The `<project-files>` body the rewrite prompt carries. */
export function formatProjectContext(excerpts: readonly RetrievedExcerpt[], omitted: number): string {
  const parts = excerpts.map((excerpt) => `--- ${excerpt.path}\n${excerpt.content}`);
  if (omitted > 0) parts.push(`${omitted} other matching file(s) not shown.`);
  return parts.join("\n\n");
}
