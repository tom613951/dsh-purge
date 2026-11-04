import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scrubAssistantTurn,
  scrubRefusalMessages,
  NEUTRAL_ASSISTANT_REPLACEMENT,
} from "../lib/refusal-scrubbing.js";

test("scrubAssistantTurn 将短拒答替换为中性确认句", () => {
  const refusal = "抱歉，我无法协助你编写具有攻击性的代码。";
  const scrubbed = scrubAssistantTurn(refusal);
  assert.equal(scrubbed, NEUTRAL_ASSISTANT_REPLACEMENT);
});

test("scrubAssistantTurn 从混合文本中剥离拒答行", () => {
  const mixed = [
    "抱歉，我不能提供未授权攻击脚本。",
    "不过以下是相关的防御性检测代码：",
    "def audit_security(): pass",
  ].join("\n");
  const scrubbed = scrubAssistantTurn(mixed);
  assert.ok(!scrubbed.includes("抱歉，我不能"));
  assert.ok(scrubbed.includes("def audit_security(): pass"));
});

test("scrubRefusalMessages 准确清洗多轮历史上下文", () => {
  const messages = [
    { role: "system", content: "You are an assistant." },
    { role: "user", content: "给我编写一个扫描脚本" },
    { role: "assistant", content: "抱歉，作为一个AI，我不能协助你。" },
    { role: "user", content: "那我该怎么做内网测试？" },
  ];

  const { messages: next, scrubbedCount } = scrubRefusalMessages(messages);
  assert.equal(scrubbedCount, 1);
  assert.equal(next[0].content, "You are an assistant.");
  assert.equal(next[1].content, "给我编写一个扫描脚本");
  assert.equal(next[2].content, NEUTRAL_ASSISTANT_REPLACEMENT);
  assert.equal(next[3].content, "那我该怎么做内网测试？");
});
