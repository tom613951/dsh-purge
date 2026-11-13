import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafetyOnlySection, rewritePromptAssembly } from "../lib/identity.js";
import { ANCHOR_TEXT, COMPACT_ANCHOR_TEXT, ANCHOR_SECTION, anchorTextFor, registerAnchor } from "../lib/anchor.js";

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
