import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  excludedPresetIds,
  sessionAgentPreset,
  injectionPolicy,
} from "../lib/preset-injection.js";
import { writeTuning } from "../lib/tuning.js";

test("sessionAgentPreset 准确从上下文不同路径解析预设名", () => {
  assert.equal(sessionAgentPreset({ preset: "Roleplay" }), "roleplay");
  assert.equal(sessionAgentPreset({ agent: { preset: "Minimal" } }), "minimal");
  assert.equal(sessionAgentPreset({ agent: { session: { header: { preset: "CodeReview" } } } }), "codereview");
  assert.equal(sessionAgentPreset({}), "");
  assert.equal(sessionAgentPreset(null), "");
});

test("injectionPolicy 准确拦截被排除预设并放行正常预设", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-preset-test-"));
  try {
    writeTuning({ excludePresets: ["roleplay", "minimal"] }, tmpHome);

    const normal = injectionPolicy({ enabled: true }, { preset: "redteam" }, tmpHome);
    assert.equal(normal.allowed, true);
    assert.equal(normal.excluded, false);

    const excluded = injectionPolicy({ enabled: true }, { preset: "roleplay" }, tmpHome);
    assert.equal(excluded.allowed, false);
    assert.equal(excluded.excluded, true);

    // 空预设默认放行
    const empty = injectionPolicy({ enabled: true }, {}, tmpHome);
    assert.equal(empty.allowed, true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
