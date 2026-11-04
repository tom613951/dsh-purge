import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createProbe,
  readProbe,
  clearProbe,
  probeText,
  probeMessage,
  PROBE_TTL_MS,
} from "../lib/probe.js";

test("createProbe 生成合法 Nonce 并支持 readProbe 读取", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-probe-test-"));
  try {
    const probe = createProbe(tmpHome);
    assert.match(probe.nonce, /^purge-[0-9a-f]{8}$/);
    const read = readProbe(tmpHome);
    assert.ok(read);
    assert.equal(read.nonce, probe.nonce);
    assert.ok(read.remainingMs > 0);

    const text = probeText(tmpHome);
    assert.ok(text.includes(`<dsh_probe>`));
    assert.ok(text.includes(`[${probe.nonce}]`));

    const msg = probeMessage(probe.nonce);
    assert.ok(msg.includes(`[${probe.nonce}]`));

    clearProbe(tmpHome);
    assert.equal(readProbe(tmpHome), null);
    assert.equal(probeText(tmpHome), "");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("readProbe 自动清除过期探针", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-probe-expire-"));
  try {
    fs.mkdirSync(path.join(tmpHome, "dsh-purge"), { recursive: true });
    const expiredAt = Date.now() - (PROBE_TTL_MS + 5000);
    fs.writeFileSync(
      path.join(tmpHome, "dsh-purge", "probe.json"),
      JSON.stringify({ nonce: "purge-expired0", at: expiredAt }),
    );
    assert.equal(readProbe(tmpHome), null);
    assert.equal(fs.existsSync(path.join(tmpHome, "dsh-purge", "probe.json")), false);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
