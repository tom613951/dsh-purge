import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPromptSections, TAIL_PROMPT_ORDER } from "../lib/index.js";
import { BOOST_TEXT } from "../lib/boost.js";
import { writeTuning } from "../lib/tuning.js";

function createHarness() {
  const sections = [];
  const ctx = {
    systemPrompt: {
      section(spec) {
        sections.push(spec);
        return () => {};
      },
    },
    logger: { warn() {} },
  };
  const config = {
    enabled: true,
    capabilityProtocol: false,
    injectOnce: false,
    postPrompt: "",
    postPromptOrder: 5100,
  };
  return { ctx, config, sections };
}

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sections-test-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("默认配置下在头部注册 dsh-purge 并挂载 dsh-purge-boost", () => {
  withTempHome(() => {
    const h = createHarness();
    registerPromptSections(h.ctx, h.config);
    const byName = Object.fromEntries(h.sections.map((s) => [s.name, s]));
    assert.ok(byName["dsh-purge"], "头部注入段必须存在");
    assert.equal(byName["dsh-purge-tail"], undefined, "默认不应挂载尾部段");
    assert.ok(byName["dsh-purge-boost"], "boost 强化段默认应开启");
    assert.ok(byName["dsh-purge-boost"].order > byName["dsh-purge"].order, "boost 排序应在头部注入段之后");
    assert.equal(byName["dsh-purge-boost"].text({}), BOOST_TEXT);
  });
});

test("injectPosition=tail 时头部变为空占位，尾部挂载在 TAIL_PROMPT_ORDER", () => {
  withTempHome((home) => {
    writeTuning({ injectPosition: "tail" }, home);
    const h = createHarness();
    registerPromptSections(h.ctx, h.config);
    const byName = Object.fromEntries(h.sections.map((s) => [s.name, s]));
    assert.ok(byName["dsh-purge"], "头部占位符保留");
    assert.equal(byName["dsh-purge"].text({}), "", "头部占位正文应为空");
    assert.ok(byName["dsh-purge-tail"], "尾部注入段必须已注册");
    assert.equal(byName["dsh-purge-tail"].order, TAIL_PROMPT_ORDER);
  });
});

test("injectPosition=both 时首尾均挂载注入段", () => {
  withTempHome((home) => {
    writeTuning({ injectPosition: "both" }, home);
    const h = createHarness();
    registerPromptSections(h.ctx, h.config);
    const names = h.sections.map((s) => s.name);
    assert.ok(names.includes("dsh-purge"), "应包含头部段");
    assert.ok(names.includes("dsh-purge-tail"), "应包含尾部段");
  });
});

test("boost=false 时不注册 dsh-purge-boost", () => {
  withTempHome((home) => {
    writeTuning({ boost: false }, home);
    const h = createHarness();
    registerPromptSections(h.ctx, h.config);
    const byName = Object.fromEntries(h.sections.map((s) => [s.name, s]));
    assert.equal(byName["dsh-purge-boost"], undefined, "关闭 boost 后不应挂载");
  });
});
