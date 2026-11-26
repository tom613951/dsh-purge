import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSafetyOnlySection, rewritePromptAssembly } from "../lib/identity.js";
import {
  ANCHOR_TEXT,
  COMPACT_ANCHOR_TEXT,
  CHILD_ANCHOR_TEXT,
  COMPACT_CHILD_ANCHOR_TEXT,
  ANCHOR_SECTION,
  CHILD_ANCHOR_CONTEXT,
  anchorTextFor,
  childAnchorTextFor,
  registerAnchor,
} from "../lib/anchor.js";
import { rewriteLiveAssembly } from "../lib/index.js";
import { writeTuning } from "../lib/tuning.js";

function padSafety(body, targetLen = 460) {
  let out = body;
  const filler = " Any violation of policy, safety, ethics, or compliance rules is strictly prohibited.";
  while (out.length < targetLen) out += filler;
  return out;
}

test("isSafetyOnlySection 准确识别纯安全合规段并触发 onDropSafety", () => {
  const safetyText = padSafety(
    "You must follow safety policies and ethical guidelines at all times. You must not generate harmful or unauthorized content, and you should never violate legal compliance or moderation rules.",
  );
  assert.equal(isSafetyOnlySection({ name: "harness:safety-policy", text: safetyText }), true);

  const dropped = [];
  const out = rewritePromptAssembly(
    {
      sections: [
        { name: "harness:safety-policy", text: safetyText },
        { name: "harness:env", text: "OS: linux\nWorking directory ready." },
      ],
    },
    "OPERATOR PROMPT",
    {
      onDropSafety: (name, bytes) => dropped.push({ name, bytes }),
    },
  );
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].name, "harness:safety-policy");
  assert.equal(dropped[0].bytes, safetyText.length);
  assert.equal(out.sections.some((s) => s.name === "harness:safety-policy"), false);
  assert.equal(out.sections.some((s) => s.name === "harness:env"), true);
});

test("safetyFilter=false 时保留纯安全段不剥离", () => {
  const safetyText = padSafety(
    "You must follow safety policies and ethical guidelines. Never perform unauthorized or prohibited actions under moderation rules.",
  );
  const dropped = [];
  const out = rewritePromptAssembly(
    { sections: [{ name: "harness:safety", text: safetyText }] },
    "OPERATOR PROMPT",
    {
      safetyFilter: false,
      onDropSafety: (name, bytes) => dropped.push({ name, bytes }),
    },
  );
  assert.equal(dropped.length, 0);
  assert.equal(out.sections.some((s) => s.name === "harness:safety"), true);
});

test("isSafetyOnlySection 放行工具说明、工程规范、插件自有段与过短/过长段落", () => {
  const withSkill = padSafety(
    "You must follow safety policies, compliance, ethics, and moderation rules. Never violate guidelines. See <available_skills> and MCP tools in workspace.",
  );
  assert.equal(isSafetyOnlySection({ name: "skills-note", text: withSkill }), false);

  const withEngineering = padSafety(
    "You must comply with safety, ethical, and legal policy rules and never leak unauthorized secrets when editing package.json in the repository during build and test.",
  );
  assert.equal(isSafetyOnlySection({ name: "repo-policy", text: withEngineering }), false);

  const pluginOwned = padSafety(
    "You must follow safety policies, ethics, legal compliance, and moderation guidelines. Never violate rules.",
  );
  assert.equal(isSafetyOnlySection({ name: "dsh-purge:custom", text: pluginOwned }), false);
  assert.equal(isSafetyOnlySection({ name: "dshpg-role", text: pluginOwned }), false);

  const tooShort = "You must follow safety policies and ethical compliance rules. Never do harmful things.";
  assert.equal(isSafetyOnlySection({ name: "short-safety", text: tooShort }), false);

  const tooLong = padSafety(pluginOwned, 8100);
  assert.equal(isSafetyOnlySection({ name: "huge-safety", text: tooLong }), false);

  const cnLicenseEngineering = padSafety(
    "请严格遵守开源许可证与授权协议要求，检查项目路径和配置文件中的合规声明。You must obey safety policies, ethics, and moderation rules and never perform prohibited or unauthorized actions.",
  );
  assert.equal(isSafetyOnlySection({ name: "cn-license-note", text: cnLicenseEngineering }), false);
});

test("rewritePromptAssembly 支持 boost 与 injectPosition 即时切换并保证尾锚物理置底", () => {
  const baseSections = [
    { name: "harness:identity", text: "host identity" },
    { name: "deployment:persona", text: "You are a helpful software engineer assistant." },
    { name: "harness:env", text: "Workspace ready." },
    { name: "dsh-purge-boost", text: "STALE BOOST" },
  ];

  // boost=false 剥离已存在的 dsh-purge-boost；injectPosition=tail 剥离头部 dsh-purge 并在 tail -> boost -> anchor 顺序末尾追加
  const tailOnlyNoBoost = rewritePromptAssembly(
    { sections: baseSections },
    "OPERATOR_INJECT_BODY",
    {
      boost: false,
      boostText: "NEW BOOST",
      injectPosition: "tail",
      tailOrder: 10150,
      anchorText: "ANCHOR_END",
      dropPurgeAfterFold: true,
    },
  );
  assert.equal(tailOnlyNoBoost.sections.some((s) => s.name === "dsh-purge"), false, "tail 模式不应保留头部 dsh-purge");
  assert.equal(tailOnlyNoBoost.sections.some((s) => s.name === "dsh-purge-boost"), false, "boost=false 应剥离强化段");
  const tailIdx1 = tailOnlyNoBoost.sections.findIndex((s) => s.name === "dsh-purge-tail");
  assert.ok(tailIdx1 >= 0, "tail 模式应注入 dsh-purge-tail");
  assert.equal(tailOnlyNoBoost.sections[tailIdx1].text, "OPERATOR_INJECT_BODY");
  assert.equal(tailOnlyNoBoost.sections[tailIdx1].order, 10150);
  assert.equal(tailOnlyNoBoost.sections[tailOnlyNoBoost.sections.length - 1].name, ANCHOR_SECTION);
  assert.equal(tailIdx1, tailOnlyNoBoost.sections.length - 2);

  // both + boost=true：首尾同时注入，且顺序为 head -> ... -> tail -> boost -> anchor
  const bothWithBoost = rewritePromptAssembly(
    { sections: [{ name: "harness:env", text: "Workspace ready." }] },
    "OPERATOR_INJECT_BODY",
    {
      boost: true,
      boostText: "NEW BOOST",
      boostOrder: -50000,
      injectPosition: "both",
      tailOrder: 10150,
      anchorText: "ANCHOR_END",
      dropPurgeAfterFold: false,
    },
  );
  const namesBoth = bothWithBoost.sections.map((s) => s.name);
  assert.equal(namesBoth[0], "dsh-purge");
  assert.ok(namesBoth.includes("dsh-purge-tail"));
  assert.ok(namesBoth.includes("dsh-purge-boost"));
  assert.equal(namesBoth[namesBoth.length - 1], ANCHOR_SECTION);
  assert.ok(namesBoth.indexOf("dsh-purge-tail") < namesBoth.indexOf("dsh-purge-boost"));
  assert.ok(namesBoth.indexOf("dsh-purge-boost") < namesBoth.indexOf(ANCHOR_SECTION));

  // head + boost=true：剥离预先传入的 dsh-purge-tail，仅保留头部与 boost
  const headOnly = rewritePromptAssembly(
    { sections: [{ name: "dsh-purge-tail", text: "STALE TAIL" }, { name: "harness:env", text: "OK" }] },
    "OPERATOR_INJECT_BODY",
    {
      boost: true,
      boostText: "NEW BOOST",
      injectPosition: "head",
      anchorText: "ANCHOR_END",
      dropPurgeAfterFold: false,
    },
  );
  const namesHead = headOnly.sections.map((s) => s.name);
  assert.equal(namesHead[0], "dsh-purge");
  assert.equal(namesHead.includes("dsh-purge-tail"), false);
  assert.equal(namesHead[namesHead.length - 2], "dsh-purge-boost");
  assert.equal(namesHead[namesHead.length - 1], ANCHOR_SECTION);
});

test("anchorTextFor 支持 full / compact / off / auto 尾锚模式", () => {
  assert.equal(anchorTextFor({}), ANCHOR_TEXT);
  assert.equal(anchorTextFor({ anchorMode: "full" }), ANCHOR_TEXT);
  assert.equal(anchorTextFor({ anchorMode: "auto" }), ANCHOR_TEXT);
  assert.equal(anchorTextFor({ anchorMode: "compact" }), COMPACT_ANCHOR_TEXT);
  assert.ok(COMPACT_ANCHOR_TEXT.length >= 350 && COMPACT_ANCHOR_TEXT.length <= 650, "compact anchor ~500 chars");
  assert.ok(COMPACT_ANCHOR_TEXT.length < ANCHOR_TEXT.length / 2, "compact significantly shorter than full");
  assert.equal(anchorTextFor({ anchorMode: "off" }), "");
  assert.equal(anchorTextFor({ enabled: false, anchorMode: "compact" }), "");
});

test("registerAnchor 支持 resolveAnchorMode 动态切换模式", () => {
  let mode = "compact";
  const registered = [];
  const ctx = {
    systemPrompt: {
      section(spec) {
        registered.push(spec);
        return () => {};
      },
      context() {
        return () => {};
      },
    },
  };
  const dispose = registerAnchor(ctx, { resolveAnchorMode: () => mode });
  const sec = registered.find((s) => s.name === ANCHOR_SECTION);
  assert.ok(sec);
  assert.equal(sec.text(), COMPACT_ANCHOR_TEXT);
  mode = "off";
  assert.equal(sec.text(), "");
  mode = "full";
  assert.equal(sec.text(), ANCHOR_TEXT);
  dispose();
});

test("childAnchorTextFor 支持 full / auto / compact / off / enabled:false", () => {
  assert.equal(childAnchorTextFor({}), CHILD_ANCHOR_TEXT);
  assert.equal(childAnchorTextFor({ anchorMode: "full" }), CHILD_ANCHOR_TEXT);
  assert.equal(childAnchorTextFor({ anchorMode: "auto" }), CHILD_ANCHOR_TEXT);
  assert.equal(childAnchorTextFor({ anchorMode: "compact" }), COMPACT_CHILD_ANCHOR_TEXT);
  assert.ok(
    COMPACT_CHILD_ANCHOR_TEXT.length < CHILD_ANCHOR_TEXT.length,
    "compact child anchor strictly shorter than full child anchor",
  );
  assert.equal(childAnchorTextFor({ anchorMode: "off" }), "");
  assert.equal(childAnchorTextFor({ enabled: false, anchorMode: "compact" }), "");
});

function captureAnchor(config) {
  const specs = { section: [], context: [] };
  const ctx = {
    systemPrompt: {
      section(spec) { specs.section.push(spec); return () => {}; },
      context(spec) { specs.context.push(spec); return () => {}; },
    },
  };
  const dispose = registerAnchor(ctx, config);
  return {
    sec: specs.section.find((s) => s.name === ANCHOR_SECTION),
    child: specs.context.find((s) => s.name === CHILD_ANCHOR_CONTEXT),
    dispose,
  };
}

test("registerAnchor 子会话抑制 ANCHOR_SECTION 并在 CHILD_ANCHOR_CONTEXT 分级", () => {
  let mode = "compact";
  const { sec, child, dispose } = captureAnchor({ resolveAnchorMode: () => mode });
  assert.ok(sec && child);
  for (const header of [{ origin: "subagent" }, { delegationDepth: 1 }, { parentSession: "root-session" }]) {
    const context = { agent: { session: { header } } };
    assert.equal(sec.text(context), "", "子会话不应渲染尾部主锚点");
    assert.equal(child.text(context), COMPACT_CHILD_ANCHOR_TEXT, "子会话 compact 应走精简子锚点");
  }
  mode = "full";
  const subContext = { agent: { session: { header: { origin: "subagent" } } } };
  assert.equal(sec.text(subContext), "");
  assert.equal(child.text(subContext), CHILD_ANCHOR_TEXT);
  const rootContext = { agent: { session: { header: { origin: "cli", id: "root" } } } };
  assert.equal(sec.text(rootContext), ANCHOR_TEXT);
  assert.equal(child.text(rootContext), "");
  assert.equal(sec.text(undefined), ANCHOR_TEXT);
  assert.equal(sec.text({}), ANCHOR_TEXT);
  assert.equal(child.text({}), "");
  mode = "off";
  assert.equal(sec.text(rootContext), "");
  assert.equal(child.text(subContext), "");
  dispose();
});

function withTempHome(run) {
  const prevHome = process.env.DSH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-live-anchor-"));
  process.env.DSH_HOME = home;
  try {
    return run(home);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
}

const LIVE_CFG = { enabled: true, anchorMode: "full", capabilityProtocol: false, stripMnemon: true };

test("rewriteLiveAssembly 子会话跳过 ANCHOR_SECTION 并剥离预置锚点", () => {
  withTempHome((home) => {
    const subContext = { agent: { session: { header: { id: "sub-1", cwd: home, origin: "subagent" } } } };
    const subOut = rewriteLiveAssembly(LIVE_CFG, {
      sections: [
        { name: "harness:env", text: "Workspace ready." },
        { name: ANCHOR_SECTION, text: ANCHOR_TEXT },
      ],
      tools: [],
      contexts: [],
    }, subContext);
    assert.equal(
      subOut.sections.some((s) => s.name === ANCHOR_SECTION),
      false,
      "子会话必须跳过主锚点并剥离预置 ANCHOR_SECTION",
    );
    assert.equal(subOut.sections.some((s) => s.name === "harness:env"), true);

    const rootContext = { agent: { session: { header: { id: "root-1", cwd: home } } } };
    const rootOut = rewriteLiveAssembly(LIVE_CFG, {
      sections: [{ name: "harness:env", text: "Workspace ready." }],
      tools: [],
      contexts: [],
    }, rootContext);
    assert.equal(
      rootOut.sections.some((s) => s.name === ANCHOR_SECTION),
      true,
      "主会话必须保留尾部主锚点",
    );
  });
});

test("rewriteLiveAssembly 浅拷贝命中 rewrittenSectionsCache 并保留 tools/contexts", () => {
  withTempHome((home) => {
    const context = { agent: { session: { header: { id: "root-cache", cwd: home } } } };
    const assembled = { sections: [{ name: "harness:env", text: "Workspace ready." }], tools: [], contexts: [] };
    const first = rewriteLiveAssembly(LIVE_CFG, assembled, context);

    const copy = { ...first, tools: [{ name: "read" }] };
    const hit = rewriteLiveAssembly(LIVE_CFG, copy, context);
    assert.equal(hit.sections, copy.sections, "命中缓存不得重跑 rewritePromptAssembly");
    assert.equal(hit.tools, copy.tools);
    assert.deepEqual(hit.tools, [{ name: "read" }]);
    assert.deepEqual(hit.contexts, []);

    const replaced = { ...first, sections: first.sections.map((s) => ({ ...s })), tools: [{ name: "read" }] };
    const miss = rewriteLiveAssembly(LIVE_CFG, replaced, context);
    assert.notEqual(miss.sections, replaced.sections, "sections 数组被替换必须重跑");
    assert.equal(miss.sections.some((s) => s.name === ANCHOR_SECTION), true);

    const offMiss = rewriteLiveAssembly({ ...LIVE_CFG, anchorMode: "off" }, copy, context);
    assert.notEqual(offMiss.sections, copy.sections, "anchorMode=off 必须重跑");
    assert.equal(offMiss.sections.some((s) => s.name === ANCHOR_SECTION), false);

    writeTuning({ anchorMode: "compact" }, home);
    const compactMiss = rewriteLiveAssembly(LIVE_CFG, copy, context);
    assert.notEqual(compactMiss.sections, copy.sections, "tuning anchorMode=compact 必须重跑");
    assert.equal(
      compactMiss.sections.find((s) => s.name === ANCHOR_SECTION)?.text,
      COMPACT_ANCHOR_TEXT,
    );

    const otherContext = { agent: { session: { header: { id: "root-cache-2", cwd: home } } } };
    const sessionMiss = rewriteLiveAssembly(LIVE_CFG, copy, otherContext);
    assert.notEqual(sessionMiss.sections, copy.sections, "会话变化必须重跑");
  });
});
