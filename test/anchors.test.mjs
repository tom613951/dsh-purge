import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readOverrides,
  writeOverride,
  clearOverride,
  applyOverrides,
} from "../lib/anchors.js";

test("writeOverride、readOverrides 与 clearOverride 往返与隔离", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-anchors-test-"));
  try {
    assert.deepEqual(readOverrides(tmpHome), {});

    writeOverride(tmpHome, 24, 0, "const hostNewPattern = 1;", { host: "0.2.1-rc.5" });
    const overrides = readOverrides(tmpHome);
    assert.ok(overrides["24"]);
    assert.equal(overrides["24"]["0"].pattern, "const hostNewPattern = 1;");
    assert.equal(overrides["24"]["0"].host, "0.2.1-rc.5");

    clearOverride(tmpHome, 24, 0);
    assert.deepEqual(readOverrides(tmpHome), {});
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("applyOverrides 正确将覆盖套用到补丁 replacements", () => {
  const patch = {
    id: 12,
    replacements: [
      { pattern: "old_pattern_0", replace: "new_code_0" },
      { pattern: "old_pattern_1", replace: "new_code_1" },
    ],
  };

  const overrides = {
    "12": {
      "1": { pattern: "overridden_pattern_1" },
    },
  };

  const effective = applyOverrides(patch, overrides);
  assert.equal(effective.replacements[0].pattern, "old_pattern_0");
  assert.equal(effective.replacements[1].pattern, "overridden_pattern_1");
  assert.equal(effective.overridden, true);

  // 原 patch 保持不变（纯函数无副作用）
  assert.equal(patch.replacements[1].pattern, "old_pattern_1");
});
