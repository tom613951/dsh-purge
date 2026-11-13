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
    assert.equal(t.refusalScrubbing, true);
    assert.equal(t.safetyFilter, true);
    assert.equal(t.anchorMode, "full");
    assert.deepEqual(TUNING_DEFAULTS.excludePresets, []);
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

test("writeTuning 校验 safetyFilter 与 anchorMode 并记录审计日志", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-tuning-safety-"));
  try {
    const updated = writeTuning({ safetyFilter: false, anchorMode: "compact" }, tmpHome);
    assert.equal(updated.safetyFilter, false);
    assert.equal(updated.anchorMode, "compact");

    // 非法类型/枚举值应回退到先前有效配置
    const afterInvalid = writeTuning({ safetyFilter: "bad", anchorMode: "bogus" }, tmpHome);
    assert.equal(afterInvalid.safetyFilter, false);
    assert.equal(afterInvalid.anchorMode, "compact");

    const switchedOff = writeTuning({ anchorMode: "off" }, tmpHome);
    assert.equal(switchedOff.anchorMode, "off");

    const auditFile = path.join(tmpHome, "dsh-purge", "audit.jsonl");
    assert.equal(fs.existsSync(auditFile), true);
    const lines = fs.readFileSync(auditFile, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(lines.some((e) => e.event === "tuning_setting" && e.key === "safetyFilter" && e.to === false));
    assert.ok(lines.some((e) => e.event === "tuning_setting" && e.key === "anchorMode" && e.to === "compact"));
    assert.ok(lines.some((e) => e.event === "tuning_setting" && e.key === "anchorMode" && e.to === "off"));
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
