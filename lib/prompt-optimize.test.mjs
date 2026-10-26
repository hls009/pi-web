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
  missingReferences,
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

test("names the references a rewrite dropped, in original order", () => {
  const before = collectReferences('fix @src/a.ts and @"my dir/b.ts", see https://a.dev');
  // Nothing missing: the rewrite kept everything.
  assert.deepEqual(missingReferences(before, before), []);
  // The dropped mention gets its `@` back; the dropped link is appended as-is.
  assert.deepEqual(
    missingReferences(before, collectReferences("fix src/a.ts")),
    ["@src/a.ts", '@"my dir/b.ts"', "https://a.dev"],
  );
});

test("accepts only the strict JSON rewrite envelope", () => {
  assert.equal(parseOptimizedText(' {"text":"  fix it  "} '), "fix it");
  assert.equal(parseOptimizedText(JSON.stringify({ text: "Goal: fix it\nKeep: tests" })), "Goal: fix it\nKeep: tests");
  for (const raw of ["fix it", '"fix it"', '```json\n{"text":"fix"}\n```',
    'Here you go: {"text":"fix"}', '{"text":"fix"} done', '{"text":"fix", "explanation":"why"}',
    '{"text":42}', '{"text":"  "}', '{}', 'null', '[]', '{"text":"fix"', ""]) {
    assert.throws(() => parseOptimizedText(raw), undefined, raw);
  }
});

test("rejects new optimizer commentary and thinking tags but allows legitimate optimization requests", () => {
  for (const text of ["以下是优化后的提示词：\n修复登录按钮", "我分析了你的需求，下面是优化后的提示词：修复登录按钮",
    "好的，以下是优化后的提示词：\n请修复登录按钮。", "**优化后的提示词：**\n请修复登录按钮。",
    "  - **Here is the optimized prompt:**\nFix login", "请修复登录按钮。\n\n说明：我保留了原始意图并优化了表达。",
    "修复登录按钮\n优化说明：表达更清楚了", "Here is the optimized prompt:\nFix login",
    "Fix login\nChanges made: clarified the goal", "<think>analysis</think>Fix login", "<analysis>reasoning</analysis>Fix login"]) {
    assert.throws(() => parseOptimizedText(JSON.stringify({ text }), "修复登录按钮"), undefined, text);
  }
  for (const text of ["请修复优化提示词按钮，不要把优化过程加入聊天。", "Improve the prompt optimizer button.",
    '把按钮标签改成“优化后的提示词”。', "解释 <think> 标签的解析规则。", "优化说明：这个设置项的标签需要更清晰"]) {
    assert.equal(parseOptimizedText(JSON.stringify({ text }), text), text);
  }
});

test("builds the rewrite prompt from the command, the search flag and the excerpts", () => {
  const plain = buildOptimizeSystemPrompt({ search: false });
  assert.match(plain, /JSON/);
  assert.match(plain, /"text"/);
  assert.match(plain, /commentary/);
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
