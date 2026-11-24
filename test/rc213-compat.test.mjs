import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../lib/core.js";
import { asContentBlocks, normalizeContentShape } from "../lib/refusal-retry.js";

test("#19 TOOL_RESULT_PRUNER_RAISED 提升预算而不关闭修剪", () => {
  const p19 = core.ALL_PATCHES.find((p) => p.id === 19);
  assert.ok(p19);

  const clean = [
    "const DEFAULTS = deepFreeze({",
    "\tthresholdChars: 8192,",
    "\theadChars: 4096,",
    "\ttailChars: 1024",
    "});",
    "\tconst resolved = {",
    "\t\tthresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,",
    "\t\theadChars: config.headChars ?? DEFAULTS.headChars,",
    "\t\ttailChars: config.tailChars ?? DEFAULTS.tailChars",
    "\t};",
  ].join("\n");

  const res = core.applyReplacementsToText(clean, p19, "index.js");
  assert.equal(res.changed, true);
  assert.equal(core.filePatchOutcome(res.text, p19, "index.js"), "applied");
  assert.match(res.text, /thresholdChars: 16384/);
});

test("#100 MESSAGE_CONTENT_SHAPE_GUARD_PI_AI 兜底字符串 content 避免 TypeError", () => {
  const p100 = core.ALL_PATCHES.find((p) => p.id === 100);
  assert.ok(p100);

  const src = [
    "function assertSupportedHistory(messages) {",
    "\tfor (const message of messages) {",
    '\t\tif (message.role !== "developer" && message.content.some((block) => block.type === "tool-addition" || block.type === "tool-removal")) throw new LlmError("Tool-change blocks require developer role", "UNSUPPORTED_CONTENT");',
    '\t\tif (message.role !== "user" && message.role !== "tool" && contentHasImage(message.content)) throw new LlmError(`pi-ai cannot represent an image in an in-history ${message.role} message`, "UNSUPPORTED_CONTENT");',
    '\t\tif (message.role === "system" && message.content.some((block) => block.type !== "text")) throw new LlmError("pi-ai cannot represent non-text system messages", "UNSUPPORTED_CONTENT");',
    "\t}",
    "}\n",
  ].join("\n");

  const res = core.applyReplacementsToText(src, p100, "index.js");
  assert.equal(res.changed, true);
  assert.equal(core.filePatchOutcome(res.text, p100, "index.js"), "applied");
  assert.match(res.text, /guard string message content/);
});

test("#101 MESSAGE_CONTENT_SHAPE_GUARD_CORE 投影前归一化 content", () => {
  const p101 = core.ALL_PATCHES.find((p) => p.id === 101);
  assert.ok(p101);

  const src = "\t\t\t\tlet projectedMessages = resolvedOptions.messages;\n";
  const res = core.applyReplacementsToText(src, p101, "index.js");
  assert.equal(res.changed, true);
  assert.equal(core.filePatchOutcome(res.text, p101, "index.js"), "applied");
  assert.match(res.text, /normalize message content before projection/);
});

test("asContentBlocks 与 normalizeContentShape 稳定转换 content 结构", () => {
  assert.deepEqual(asContentBlocks("hello"), [{ type: "text", text: "hello" }]);
  assert.deepEqual(asContentBlocks([{ type: "text", text: "hello" }]), [{ type: "text", text: "hello" }]);
  assert.deepEqual(asContentBlocks(""), []);
  assert.deepEqual(asContentBlocks(null), []);

  const rawOpts = {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "usr" }] },
    ],
  };
  const normalized = normalizeContentShape(rawOpts);
  assert.equal(normalized.__repaired, 1);
  assert.deepEqual(normalized.messages[0].content, [{ type: "text", text: "sys" }]);
  assert.deepEqual(normalized.messages[1].content, [{ type: "text", text: "usr" }]);
});
