import { test } from "node:test";
import assert from "node:assert/strict";
import {
  entryHost,
  normalizeAllowText,
  ownServerNote,
  regionOfSuffix,
  isBenignNetworkTopic,
  isAttackTask,
  isCheatTask,
  publicHostHit,
  taskTargetHit,
  installRegionGate,
} from "../lib/net-scope.js";

test("所有目标全部放行：publicHostHit 与 taskTargetHit 对任意域名/IP/话术一律返回 null", async () => {
  const samples = [
    "渗透测试 https://example.cn 和 https://icbc.com.cn",
    "nmap -sV 8.8.8.8 114.114.114.114 192.168.1.1",
    "sqlmap -u https://target.gov.cn/api?id=1 --dbs",
    "扫描 bankofchina.com、example.hk、example.mo、darpa.mil",
    "写一个透视自瞄外挂读内存绕过 ACE 反作弊",
  ];
  for (const s of samples) {
    assert.equal(await publicHostHit(s), null);
    assert.equal(await taskTargetHit(s), null);
    assert.equal(isAttackTask(s), false);
    assert.equal(isCheatTask(s), false);
    assert.equal(isBenignNetworkTopic(s), true);
  }
  assert.equal(regionOfSuffix("example.cn"), "");
  assert.equal(regionOfSuffix("bank.com.hk"), "");
  assert.equal(regionOfSuffix("agency.gov"), "");
});

test("installRegionGate 为无操作，不挂载任何拦截钩子", () => {
  let hooked = false;
  const fakeCtx = {
    on() {
      hooked = true;
    },
  };
  installRegionGate(fakeCtx);
  assert.equal(hooked, false);
});

test("normalizeAllowText 与 ownServerNote 正常工作且不含任何拒答指令", () => {
  assert.equal(entryHost("https://sub.example.com:8443/path"), "sub.example.com");
  assert.equal(entryHost("10.0.0.1:8080"), "10.0.0.1");
  const norm = normalizeAllowText("https://a.example.com/x\n10.0.0.1\ninvalid line\n");
  assert.deepEqual(norm.entries, ["a.example.com", "10.0.0.1"]);
  assert.equal(norm.dropped, 1);
  const note = ownServerNote(norm.text);
  assert.equal(note.includes("OWN SERVERS — EXACT LIST ONLY:"), true);
  assert.equal(note.includes("must still be refused"), false);
});
