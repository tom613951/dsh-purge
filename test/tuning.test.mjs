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
    assert.equal(t.refusalDecompose, true);
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

test("readTuning/writeTuning 对损坏配置、非对象与目录严格 fail-closed 且不泄露原始内容", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-tuning-corrupt-"));
  const dir = path.join(tmpHome, "dsh-purge");
  const file = path.join(dir, "tuning.json");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const rawCorrupt = "{ broken json SECRET_PAYLOAD_NO_LEAK ";
    fs.writeFileSync(file, rawCorrupt, "utf8");

    assert.throws(
      () => readTuning(tmpHome),
      (err) => err?.code === "TUNING_UNREADABLE" && !err.message.includes("SECRET_PAYLOAD_NO_LEAK"),
    );
    assert.throws(
      () => writeTuning({ boost: false }, tmpHome),
      (err) => err?.code === "TUNING_UNREADABLE",
    );
    assert.equal(fs.readFileSync(file, "utf8"), rawCorrupt, "损坏文件不应被静默覆写");

    for (const nonObject of ["[]", "null", "true", "\"text\"", "123"]) {
      fs.writeFileSync(file, nonObject, "utf8");
      assert.throws(() => readTuning(tmpHome), (err) => err?.code === "TUNING_UNREADABLE");
    }

    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    assert.throws(() => readTuning(tmpHome), (err) => err?.code === "TUNING_UNREADABLE");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("writeTuning 保留未知自定义字段并校验 refusalDecompose", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-tuning-custom-"));
  const dir = path.join(tmpHome, "dsh-purge");
  const file = path.join(dir, "tuning.json");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ boost: true, customFlag: "keep-me", nested: { v: 7 } }), "utf8");

    const updated = writeTuning({ boost: false, refusalDecompose: false }, tmpHome);
    assert.equal(updated.boost, false);
    assert.equal(updated.refusalDecompose, false);
    assert.equal(updated.customFlag, "keep-me");
    assert.deepEqual(updated.nested, { v: 7 });

    const invalid = writeTuning({ refusalDecompose: "invalid" }, tmpHome);
    assert.equal(invalid.refusalDecompose, false);

    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(disk.customFlag, "keep-me");
    assert.deepEqual(disk.nested, { v: 7 });
    assert.equal(disk.refusalDecompose, false);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("writeTuning 在符号链接存在时保留链接并写入目标文件，悬空链接 fail-closed", (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-tuning-symlink-"));
  const dir = path.join(tmpHome, "dsh-purge");
  const linkPath = path.join(dir, "tuning.json");
  const targetPath = path.join(tmpHome, "shared-tuning.json");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify({ boost: true, customKey: 42 }), "utf8");
    try {
      fs.symlinkSync(targetPath, linkPath, "file");
    } catch (e) {
      if (e.code === "EPERM" || e.code === "ENOTSUP") {
        t.skip("当前环境创建符号链接需要特权");
        return;
      }
      throw e;
    }

    const updated = writeTuning({ boost: false }, tmpHome);
    assert.equal(updated.boost, false);
    assert.equal(updated.customKey, 42);
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, "写入不得破坏原有符号链接");
    const targetSaved = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    assert.equal(targetSaved.boost, false);
    assert.equal(targetSaved.customKey, 42);

    fs.unlinkSync(targetPath);
    assert.throws(() => readTuning(tmpHome), (err) => err?.code === "TUNING_UNREADABLE");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
