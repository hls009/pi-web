import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  RETRIEVAL_PLAN_SYSTEM_PROMPT,
  buildOptimizeSystemPrompt,
  buildOptimizeUserMessage,
  buildRetrievalPlanUserMessage,
  collectReferences,
  composeCommandInput,
  hasOptimizableBody,
  parseOptimizedText,
  parseRetrievalPlan,
  referencesPreserved,
  splitCommandInput,
} = await createJiti(import.meta.url).import("./prompt-optimize.ts");

const complete = (...names) => ({ names, complete: true });
const partial = (...names) => ({ names, complete: false });

test("splits a leading command from its body, keeping both verbatim", () => {
  assert.deepEqual(
    splitCommandInput("/compact 3", complete("compact")),
    { command: "/compact", separator: " ", body: "3" },
  );
  assert.deepEqual(
    splitCommandInput("/skill:review  looks fine", complete("skill:review")),
    { command: "/skill:review", separator: "  ", body: "looks fine" },
  );
  // The name is case-insensitive, the text is not rewritten.
  assert.equal(splitCommandInput("/Compact 3", complete("compact")).command, "/Compact");
  // A bare command has an empty body.
  const bare = splitCommandInput("/compact", complete("compact"));
  assert.equal(bare.body, "");
  assert.equal(hasOptimizableBody(bare.body, bare.command), false);
  // A single-token body is that command's argument, not a description.
  assert.equal(hasOptimizableBody("gpt-5", "/model"), false);
  assert.equal(hasOptimizableBody("fix the login bug", "/skill:review"), true);
  assert.equal(hasOptimizableBody("fix", null), true);
});

test("leaves prose and paths alone", () => {
  assert.deepEqual(
    splitCommandInput("fix the login bug", complete("compact")),
    { command: null, separator: "", body: "fix the login bug" },
  );
  // A complete palette that does not name the word makes it prose.
  const prose = splitCommandInput("/tmp is full", complete("compact"));
  assert.equal(prose.command, null);
  assert.equal(prose.body, "/tmp is full");
  // Paths stop at the second slash, whatever the palette says.
  for (const input of ["/usr/local/bin is broken", "/etc/hosts", "@src/a.ts fix this"]) {
    assert.equal(splitCommandInput(input, partial()).command, null, input);
  }
});

test("keeps an unknown name as a command while the palette is incomplete", () => {
  const split = splitCommandInput("/myext do this", partial());
  assert.deepEqual(split, { command: "/myext", separator: " ", body: "do this" });
  // With the list loaded it is prose, and the whole text is rewritten.
  assert.deepEqual(splitCommandInput("/myext do this", complete("compact")), {
    command: null,
    separator: "",
    body: "/myext do this",
  });
});

test("rebuilds a command with its own whitespace", () => {
  assert.equal(composeCommandInput(splitCommandInput("/compact 3", complete("compact")), "3 files"), "/compact 3 files");
  assert.equal(composeCommandInput(splitCommandInput("/a\nb", partial()), "done"), "/a\ndone");
  assert.equal(composeCommandInput(splitCommandInput("just text", complete()), "just text but better"), "just text but better");
});

test("collects the mentions and links a rewrite has to keep", () => {
  const refs = collectReferences('check @src/a.ts and @"my dir/b.ts" and https://example.com/x?y=1, please');
  assert.deepEqual(refs.mentions, ["src/a.ts", "my dir/b.ts"]);
  assert.deepEqual(refs.urls, ["https://example.com/x?y=1"]);
  // An email is not a mention (the composer's own rule: start or whitespace).
  assert.deepEqual(collectReferences("mail a@b.com").mentions, []);
  assert.deepEqual(collectReferences("see https://a.dev and https://a.dev").urls, ["https://a.dev"]);
});

test("refuses a rewrite that dropped a reference", () => {
  const before = collectReferences("fix @src/a.ts, see https://a.dev");
  assert.equal(referencesPreserved(before, collectReferences("fix @src/a.ts, see https://a.dev")), true);
  assert.equal(referencesPreserved(before, collectReferences("fix src/a.ts, see https://a.dev")), false);
  assert.equal(referencesPreserved(before, collectReferences("fix @src/a.ts")), false);
});

test("unwraps what a prompt-shaped answer tends to carry", () => {
  assert.equal(parseOptimizedText("  fix it  "), "fix it");
  assert.equal(parseOptimizedText("```\nfix it\n```"), "fix it");
  assert.equal(parseOptimizedText("```text\nfix it\n```"), "fix it");
  assert.equal(parseOptimizedText("Optimized prompt: fix it"), "fix it");
  assert.equal(parseOptimizedText("Prompt:\nGoal: fix it\nKeep: tests"), "Goal: fix it\nKeep: tests");
  assert.equal(parseOptimizedText("优化后的提示词：修复登录"), "修复登录");
  assert.equal(parseOptimizedText('"fix it"'), "fix it");
  assert.throws(() => parseOptimizedText("   "));
  assert.throws(() => parseOptimizedText("```\n```"));
});

test("builds the rewrite prompt from the command, the search flag and the excerpts", () => {
  const plain = buildOptimizeSystemPrompt({ search: false });
  assert.match(plain, /Reply with the rewritten prompt only/);
  assert.doesNotMatch(plain, /slash command/);
  assert.doesNotMatch(plain, /Project files gathered/);

  const withCommand = buildOptimizeSystemPrompt({ command: "/skill:review", commandDescription: "Review a change", search: true });
  assert.match(withCommand, /slash command `\/skill:review`/);
  assert.match(withCommand, /Review a change/);
  assert.match(withCommand, /Project files gathered/);

  assert.equal(
    buildOptimizeUserMessage("fix it"),
    "<request>\nfix it\n</request>",
  );
  assert.match(
    buildOptimizeUserMessage("fix it", "--- src/a.ts\nconst a = 1;"),
    /<project-files>\n--- src\/a\.ts\nconst a = 1;\n<\/project-files>/,
  );
  assert.match(buildRetrievalPlanUserMessage("fix it"), /<request>\nfix it\n<\/request>/);
  assert.match(RETRIEVAL_PLAN_SYSTEM_PROMPT, /JSON only/);
});

test("reads the planner's JSON, bounded and deduplicated", () => {
  assert.deepEqual(
    parseRetrievalPlan('{"paths":["src/a.ts","src/a.ts"],"keywords":["login"]}'),
    { paths: ["src/a.ts"], keywords: ["login"] },
  );
  assert.deepEqual(parseRetrievalPlan('```json\n{"paths":[],"keywords":["token"]}\n```'), { paths: [], keywords: ["token"] });
  assert.deepEqual(
    parseRetrievalPlan('Sure: {"paths": ["a.ts"], "keywords": []} — hope that helps'),
    { paths: ["a.ts"], keywords: [] },
  );

  const many = parseRetrievalPlan(JSON.stringify({ paths: [], keywords: Array.from({ length: 12 }, (_, i) => `k${i}`) }));
  assert.equal(many.keywords.length, 8);
  assert.deepEqual(parseRetrievalPlan('{"paths":["a.ts",7,null,""],"keywords":[]}'), { paths: ["a.ts"], keywords: [] });
  assert.equal(parseRetrievalPlan("no json here"), null);
  assert.equal(parseRetrievalPlan('{"paths":[],"keywords":[]}'), null);
  assert.equal(parseRetrievalPlan("{"), null);
  assert.equal(parseRetrievalPlan('{"paths":[1,2],"keywords":[]}'), null);
});
