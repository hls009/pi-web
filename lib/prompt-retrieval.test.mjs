import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  PROJECT_SEARCH_LIMITS,
  formatProjectContext,
  isLikelyTextPath,
  rankCandidateFiles,
  readProjectExcerpts,
  searchProjectContents,
  truncateExcerpt,
} = await createJiti(import.meta.url).import("./prompt-retrieval.ts");

async function withTempDir(run, prefix = "pi-web-prompt-retrieval-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reads source files, never binaries, locks or bundles", () => {
  for (const path of ["src/a.ts", "README", "Makefile", "Dockerfile", "a/b/c.py", "x.jsonc"]) {
    assert.equal(isLikelyTextPath(path), true, path);
  }
  for (const path of ["logo.png", "app.exe", "lib.so", "data.sqlite", "font.woff2", "package-lock.json", "yarn.lock", "dist/app.min.js", "x.js.map"]) {
    assert.equal(isLikelyTextPath(path), false, path);
  }
});

test("ranks a guessed path over a keyword, a content hit over a folder name", () => {
  const files = [
    "docs/session-notes.md",
    "src/auth/session.ts",
    "src/auth/login.ts",
    "assets/session.png",
    "package-lock.json",
  ];
  const ranked = rankCandidateFiles(files, { paths: ["src/auth/session.ts"], keywords: ["session"] }, 3);
  assert.equal(ranked[0], "src/auth/session.ts");
  assert.deepEqual(ranked.includes("assets/session.png"), false);
  assert.deepEqual(ranked.includes("package-lock.json"), false);
  // Only the two files the plan actually points at; the limit never pads.
  assert.deepEqual(ranked, ["src/auth/session.ts", "docs/session-notes.md"]);

  // The word being in the file beats the word being in its folder, and a
  // shallower path wins a tie.
  const content = rankCandidateFiles(
    ["packages/app/src/token.ts", "src/token.ts", "src/auth.ts"],
    { paths: [], keywords: ["auth"] },
    3,
    ["packages/app/src/token.ts"],
  );
  assert.equal(content[0], "packages/app/src/token.ts");
  assert.equal(content[1], "src/auth.ts");

  assert.deepEqual(rankCandidateFiles(["a/b.ts"], { paths: ["nowhere.ts"], keywords: ["zzz"] }, 5), []);
  assert.deepEqual(rankCandidateFiles(["a/b.ts"], { paths: ["a/b.ts"], keywords: [] }, 0), []);
});

test("cuts an excerpt to the budget, at a line boundary", () => {
  assert.equal(truncateExcerpt("short\n", 100), "short\n");
  const cut = truncateExcerpt("a\nb\nc\n", 4);
  assert.equal(cut, "a\nb\n… [truncated]");
  assert.match(truncateExcerpt("x".repeat(100_000), 1024), /… \[truncated\]$/);
  assert.ok(Buffer.byteLength(truncateExcerpt("你".repeat(10_000), 1024), "utf8") < 1100);
});

test("reads only allowed, plausible, non-binary files within the limits", async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), "export const app = 1;\n");
    await writeFile(join(root, "note.txt"), Buffer.from([0x68, 0x69, 0x00, 0x21]));
    await writeFile(join(root, "big.ts"), "x".repeat(600 * 1024));
    await writeFile(join(root, "second.ts"), "export const second = 2;\n");

    const roots = new Set([root]);
    const excerpts = await readProjectExcerpts(
      root,
      ["src/app.ts", "note.txt", "big.ts", "../outside.ts", "missing.ts"],
      undefined,
      roots,
    );
    assert.deepEqual(excerpts.map((excerpt) => excerpt.path), ["src/app.ts"]);
    assert.match(excerpts[0].content, /const app = 1/);

    // The total budget stops the reading; what was read still comes back.
    const limited = await readProjectExcerpts(
      root,
      ["src/app.ts", "second.ts"],
      { maxFiles: 1, maxBytesPerFile: 6 * 1024, maxTotalBytes: 20 * 1024 },
      roots,
    );
    assert.deepEqual(limited.map((excerpt) => excerpt.path), ["src/app.ts"]);

    const truncated = await readProjectExcerpts(
      root,
      ["src/app.ts"],
      { maxFiles: 1, maxBytesPerFile: 8, maxTotalBytes: 8 },
      roots,
    );
    assert.equal(truncated[0].content, "export c\n… [truncated]");
    assert.equal(PROJECT_SEARCH_LIMITS.maxFiles, 6);
  });
});

test("finds content through git and gives up quietly outside a repository", async () => {
  await withTempDir(async (root) => {
    execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
    await writeFile(join(root, "only.ts"), "const refreshToken = 'x';\n");
    execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { stdio: "ignore" });

    assert.deepEqual(await searchProjectContents(root, ["refreshToken"], 10), ["only.ts"]);
    assert.deepEqual(await searchProjectContents(root, ["nothingmatchesthis"], 10), []);
    assert.deepEqual(await searchProjectContents(root, [], 10), []);
    assert.deepEqual(await searchProjectContents(join(root, "nope"), ["refreshToken"], 10), []);
  });
});

test("formats the excerpts as the prompt's project context", () => {
  const context = formatProjectContext([
    { path: "src/a.ts", content: "const a = 1;" },
    { path: "src/b.ts", content: "const b = 2;" },
  ], 0);
  assert.equal(context, "--- src/a.ts\nconst a = 1;\n\n--- src/b.ts\nconst b = 2;");
  assert.match(formatProjectContext([{ path: "a.ts", content: "x" }], 3), /3 other matching file\(s\) not shown\.$/);
  assert.equal(formatProjectContext([], 0), "");
});
