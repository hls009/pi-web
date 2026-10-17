// The project's file listing, shared by the composer's `@` menu
// (`/api/file-index`) and the prompt optimizer's project search. Git answers
// when the folder is a repository — `.gitignore` then decides what is listed,
// as the TUI's fd does — and a bounded readdir walk is the fallback.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { type FileIndexEntry } from "./file-fuzzy";
import { isHiddenOutsideGit } from "./file-tree-visibility";

const execFileAsync = promisify(execFile);

/** Hard caps on the full in-memory listing ("q" searches run against it). */
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

export interface ProjectFileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
  /** Derived lazily on the first search against this listing */
  entries?: FileIndexEntry[];
}

interface CacheEntry extends ProjectFileListing {
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

async function listWithGit(cwd: string): Promise<ProjectFileListing | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const all = stdout.split("\0").filter(Boolean);
    if (all.length > GIT_HARD_CAP) {
      return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

function listWithWalk(cwd: string): ProjectFileListing {
  const files: string[] = [];
  // BFS so shallow files win when the cap truncates the listing.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      // The file tree's name list, only for this non-git fallback. Git repos
      // rely on .gitignore instead (matches the TUI's fd behavior).
      if (isHiddenOutsideGit(d.name)) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) {
          queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
        }
      } else if (d.isFile()) {
        if (files.length >= WALK_HARD_CAP) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated: false };
}

/** Every file under `cwd`, relative and `/`-separated, from the shared cache. */
export async function listProjectFiles(cwd: string): Promise<ProjectFileListing> {
  const cache = getIndexCache();
  const now = Date.now();
  const cached = cache.get(cwd);
  // The map survives hot reload, so an entry written by an older shape of this
  // module would still be inside its TTL: recompute instead of trusting it.
  if (cached && cached.expiresAt > now && Array.isArray(cached.files)) return cached;

  const listing = (await listWithGit(cwd)) ?? listWithWalk(cwd);
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  const entry: CacheEntry = { ...listing, expiresAt: now + CACHE_TTL_MS };
  cache.set(cwd, entry);
  return entry;
}
