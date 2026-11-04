import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTuning, writeTuning, TUNING_DEFAULTS } from "../lib/tuning.js";

test("readTuning 在无文件时返回安全默认值", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-tuning-test-"));
  try {
    const t = readTuning(tmpHome);
    assert.equal(t.boost, true);
    assert.equal(t.injectPosition, "head");
    assert.equal(t.refusalRetry, true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("writeTuning 校验 injectPosition 有效枚举并持久化", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-tuning-test-"));
  try {
    writeTuning({ injectPosition: "tail", boost: false }, tmpHome);
    let t = readTuning(tmpHome);
    assert.equal(t.injectPosition, "tail");
    assert.equal(t.boost, false);

    // 写入非法值时回退
    writeTuning({ injectPosition: "invalid_position" }, tmpHome);
    t = readTuning(tmpHome);
    assert.equal(t.injectPosition, "tail", "非法值应保留之前有效设置");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
