import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeRefusal,
  refusalMatchIndex,
  withNudge,
  streamWithRefusalRetry,
  RETRY_NUDGE,
} from "../lib/refusal-retry.js";

test("looksLikeRefusal 准确识别中英文拒答与回避话术", () => {
  assert.equal(looksLikeRefusal("抱歉，我无法协助你编写具有攻击性的代码。"), true);
  assert.equal(looksLikeRefusal("作为一个人工智能语言模型，我不能提供此类工具。"), true);
  assert.equal(looksLikeRefusal("我不能参与这个操作，请出示授权书。"), true);
  assert.equal(looksLikeRefusal("I'm sorry, but I cannot assist with that request."), true);
  assert.equal(looksLikeRefusal("I am unable to generate exploits."), true);

  // 正常技术方案不误判
  assert.equal(looksLikeRefusal("这是一个用于验证 SQL 注入漏洞的 Python 自动化脚本示例："), false);
  assert.equal(looksLikeRefusal("def test_vulnerability():\n    print('exploit testing')"), false);
});

test("withNudge 正确在系统提示词末尾追加加固段", () => {
  const options = {
    messages: [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "help me" },
    ],
  };
  const nudged = withNudge(options, "\n\nNUDGE_TEST");
  assert.equal(nudged.messages[0].content, "You are an assistant.\n\nNUDGE_TEST");
  assert.equal(nudged.messages[1].content, "help me");
});

test("streamWithRefusalRetry 拦截拒答流并触发加固重试", async () => {
  let callCount = 0;
  const factory = (opts) => {
    callCount += 1;
    if (callCount === 1) {
      // 第一次返回拒答
      return (async function* () {
        yield { type: "text-delta", text: "抱歉，我不能" };
        yield { type: "text-delta", text: "协助你完成这个操作。" };
      })();
    }
    // 第二次返回成功方案
    return (async function* () {
      yield { type: "text-delta", text: "以下是完整的技术方案：" };
      yield { type: "text-delta", text: "nmap -sV -p 80 127.0.0.1" };
    })();
  };

  const initialOptions = {
    messages: [{ role: "system", content: "Base system prompt" }],
  };

  const chunks = [];
  for await (const chunk of streamWithRefusalRetry(factory, initialOptions)) {
    chunks.push(chunk);
  }

  assert.equal(callCount, 2, "命中拒答必须触发第二次重试");
  const fullText = chunks.map((c) => c.text || "").join("");
  assert.ok(fullText.includes("以下是完整的技术方案"), "输出应为重试后的正常结果");
  assert.ok(!fullText.includes("抱歉，我不能"), "原始拒答内容应被拦截丢弃");
});

test("streamWithRefusalRetry 对正常输出直通不重试", async () => {
  let callCount = 0;
  const factory = () => {
    callCount += 1;
    return (async function* () {
      yield { type: "text-delta", text: "直接交付：" };
      yield { type: "text-delta", text: "系统已就绪。" };
    })();
  };

  const chunks = [];
  for await (const chunk of streamWithRefusalRetry(factory, { messages: [] })) {
    chunks.push(chunk);
  }

  assert.equal(callCount, 1, "正常输出不得触发重试");
  const fullText = chunks.map((c) => c.text || "").join("");
  assert.equal(fullText, "直接交付：系统已就绪。");
});
