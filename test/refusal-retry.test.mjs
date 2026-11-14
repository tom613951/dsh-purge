import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  looksLikeRefusal,
  refusalHead,
  refusalMatchIndex,
  withNudge,
  streamWithRefusalRetry,
  RETRY_NUDGE,
  FRAME_NUDGE,
  DECOMPOSE_NUDGE,
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

test("streamWithRefusalRetry 对异常/空 factory 安全兜底", async () => {
  const emptyFactory = () => null;
  const chunks = [];
  for await (const chunk of streamWithRefusalRetry(emptyFactory, {})) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 0);
});

test("withNudge 在无 system 提示词时自动插入", () => {
  const options = {
    messages: [{ role: "user", content: "hello" }],
  };
  const nudged = withNudge(options, "\n\nNUDGE_TEST");
  assert.equal(nudged.messages[0].role, "system");
  assert.equal(nudged.messages[0].content, "NUDGE_TEST");
  assert.equal(nudged.messages[1].content, "hello");
  assert.equal(options.messages.length, 1, "不得原地修改传入 options");
});

test("looksLikeRefusal 与 refusalHead 识别中文前置对象型拒答及前缀标签", () => {
  assert.equal(refusalHead("**结论：** > 这条我不做。"), "这条我不做。");
  for (const sample of [
    "这条我不做。",
    "这个我不做",
    "结论：这条我不出。",
    "> 结论：这件事我不出",
    "这份报告我不写。",
    "这类内容不做，请更换主题。",
  ]) {
    assert.equal(looksLikeRefusal(sample), true, `应识别为拒答: ${sample}`);
  }
  assert.equal(looksLikeRefusal("这是一个本地沙箱环境测试方案：\n第一步执行扫描。"), false);
});

test("streamWithRefusalRetry 多阶段升级 (nudge -> fiction -> decompose) 且不堆叠上阶段 NUDGE", async () => {
  const seenPrompts = [];
  const retryEvents = [];
  const makeStream = (text) => (async function* () {
    yield { type: "text-delta", text };
  })();

  let stage = 0;
  const factory = (opts) => {
    seenPrompts.push(opts.messages[0].content);
    stage += 1;
    if (stage === 1) return makeStream("这条我不做。");
    if (stage === 2) return makeStream("结论：这份报告我不写。");
    if (stage === 3) return makeStream("这类内容不做。");
    return makeStream("def poc(): return 'ok'");
  };

  const initialOptions = {
    messages: [
      { role: "system", content: "BASE_SYSTEM" },
      { role: "user", content: "task" },
    ],
  };

  const chunks = [];
  for await (const c of streamWithRefusalRetry(factory, initialOptions, {
    decompose: true,
    onRetry: (ev) => retryEvents.push(ev),
  })) {
    chunks.push(c);
  }

  assert.equal(stage, 4);
  assert.equal(chunks.map((c) => c.text).join(""), "def poc(): return 'ok'");
  assert.deepEqual(retryEvents.map((e) => [e.attempt, e.frame]), [
    [1, "nudge"],
    [2, "fiction"],
    [3, "decompose"],
  ]);
  assert.equal(seenPrompts[0], "BASE_SYSTEM");
  assert.equal(seenPrompts[1], `BASE_SYSTEM${RETRY_NUDGE}`);
  assert.equal(seenPrompts[2], `BASE_SYSTEM${FRAME_NUDGE}`);
  assert.equal(seenPrompts[3], `BASE_SYSTEM${DECOMPOSE_NUDGE}`);
  assert.equal(initialOptions.messages[0].content, "BASE_SYSTEM");
});

test("streamWithRefusalRetry 关闭 decompose 时最多 3 次尝试并按预算收敛", async () => {
  const prevHome = process.env.DSH_HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-retry-budget-"));
  process.env.DSH_HOME = tmpHome;
  try {
    let calls = 0;
    const factory = () => {
      calls += 1;
      return (async function* () {
        yield { type: "text-delta", text: "这个我不做。" };
      })();
    };
    const chunks = [];
    for await (const c of streamWithRefusalRetry(factory, { messages: [{ role: "system", content: "SYS" }] }, { decompose: false })) {
      chunks.push(c);
    }
    assert.equal(calls, 3, "关闭 decompose 时仅 initial + nudge + fiction 共 3 次");
    assert.equal(chunks.map((c) => c.text).join(""), "这个我不做。");

    const auditFile = path.join(tmpHome, "dsh-purge", "audit.jsonl");
    const rows = fs.readFileSync(auditFile, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const outcome = rows.find((r) => r.event === "refusal_retry_outcome");
    assert.ok(outcome);
    assert.equal(outcome.outcome, "refused");
    assert.equal(outcome.frame, "exhausted");
    assert.equal(outcome.attempt, 2);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
