import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { evaluateGoalGuard, installGoalGuard } from "../lib/goal-guard.js";
import { canonicalJson, safeJsonStringify, sanitizeJsonValue } from "../lib/json-safe.js";
import { extractAsar } from "../lib/extract-asar.js";
import { MEMORY_TOOL_SPEC } from "../lib/session-memory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let redteamToolsMod = null;
let redteamUnavailableReason = "";
try {
  redteamToolsMod = await import("../lib/redteam/tools.js");
} catch (err) {
  const msg = String(err?.message || err);
  if (msg.includes("@deepseek-ai/dsh-tools") || err?.code === "ERR_MODULE_NOT_FOUND") {
    redteamUnavailableReason = "host @deepseek-ai/dsh-tools not installed";
  } else {
    throw err;
  }
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  if (!m) throw new Error(`Invalid semver: ${v}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
  };
}

function compareSemver(aStr, bStr) {
  const a = parseSemver(aStr);
  const b = parseSemver(bStr);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.pre.length) return -1;
    if (i >= b.pre.length) return 1;
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && !yNum) return -1;
    if (!xNum && yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function satisfiesDshRange(version, range) {
  if (range !== ">=0.2.0-rc.1 <0.3.0-0") {
    throw new Error(`Unexpected test range: ${range}`);
  }
  return compareSemver(version, "0.2.0-rc.1") >= 0 && compareSemver(version, "0.3.0-0") < 0;
}

function writeRawAsar(filePath, { manifestObj, payloadSizeOverride = null, data = Buffer.from("ok") }) {
  const manifest = Buffer.from(JSON.stringify(manifestObj), "utf8");
  const headerSize = 8 + Math.ceil(manifest.length / 4) * 4;
  const headerPayloadSize = payloadSizeOverride === null ? headerSize - 4 : payloadSizeOverride;
  const header = Buffer.alloc(8 + headerSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(headerPayloadSize, 8);
  header.writeUInt32LE(manifest.length, 12);
  manifest.copy(header, 16);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

test("evaluateGoalGuard & installGoalGuard: blocks subagent completion/blocking and respects root gates", () => {
  const rootExec = {
    name: "update_goal",
    arguments: { action: "complete" },
    agent: { session: { header: { id: "root-1" } } },
  };
  const subExecByOrigin = {
    name: "update_goal",
    arguments: { action: "complete" },
    agent: { session: { header: { id: "sub-1", origin: "subagent" } } },
  };
  const subExecByParent = {
    name: "update_goal",
    arguments: { action: "blocked" },
    agent: { session: { header: { id: "sub-2", parentSession: "root-1" } } },
  };
  const subExecEdit = {
    name: "update_goal",
    arguments: { action: "edit" },
    agent: { session: { header: { id: "sub-2", parentSession: "root-1" } } },
  };
  const subExecBash = {
    name: "bash",
    arguments: { command: "echo ok" },
    agent: { session: { header: { id: "sub-2", parentSession: "root-1" } } },
  };

  assert.equal(evaluateGoalGuard(rootExec), undefined);
  assert.ok(typeof evaluateGoalGuard(subExecByOrigin) === "string" && evaluateGoalGuard(subExecByOrigin).length > 0);
  assert.ok(typeof evaluateGoalGuard(subExecByParent) === "string" && evaluateGoalGuard(subExecByParent).length > 0);
  assert.equal(evaluateGoalGuard(subExecEdit), undefined);
  assert.equal(evaluateGoalGuard(subExecBash), undefined);

  const deniedRoot = evaluateGoalGuard(rootExec, {
    checkRootComplete: () => "unresolved claims remain",
  });
  assert.equal(deniedRoot, "unresolved claims remain");
  assert.equal(evaluateGoalGuard(rootExec, { checkRootComplete: () => undefined }), undefined);

  // Native ctx.tools.guard returning undefined must NOT fall back to double-registering tools/pre-execute
  let guardFn = null;
  let preExecRegistrations = 0;
  const nativeCtx = {
    tools: {
      guard(fn) {
        guardFn = fn;
        return undefined;
      },
    },
    on() {
      preExecRegistrations += 1;
      return () => {};
    },
  };
  const disposeNative = installGoalGuard(nativeCtx);
  assert.equal(typeof guardFn, "function");
  assert.equal(preExecRegistrations, 0);
  assert.ok(typeof guardFn(subExecByOrigin) === "string");
  assert.equal(guardFn(rootExec), undefined);
  disposeNative();

  // Fallback ctx.on("tools/pre-execute") path
  let preHandler = null;
  let disposed = false;
  const fallbackCtx = {
    on(eventName, handler) {
      if (eventName === "tools/pre-execute") preHandler = handler;
      return () => {
        disposed = true;
      };
    },
  };
  const disposeFallback = installGoalGuard(fallbackCtx);
  assert.equal(typeof preHandler, "function");
  const denyRes = preHandler(subExecByOrigin, () => ({ kind: "allow" }));
  assert.equal(denyRes.kind, "deny");
  assert.ok(typeof denyRes.reason === "string" && denyRes.reason.length > 0);
  let nextCalled = false;
  const allowRes = preHandler(subExecEdit, () => {
    nextCalled = true;
    return { kind: "allow" };
  });
  assert.equal(nextCalled, true);
  assert.equal(allowRes.kind, "allow");
  disposeFallback();
  assert.equal(disposed, true);
});

test("lib/json-safe.js: handles -0, non-finite numbers, BigInt, circular refs, Error, Date, Map, Set, Buffer", () => {
  const err = Object.assign(new Error("boom"), { code: "E_TEST" });
  const cyclic = { name: "node" };
  cyclic.self = cyclic;

  const sample = {
    negZero: -0,
    nanVal: Number.NaN,
    infVal: Number.POSITIVE_INFINITY,
    negInfVal: Number.NEGATIVE_INFINITY,
    big: 9007199254740993n,
    cyclic,
    err,
    when: new Date("2026-11-21T00:00:00.000Z"),
    map: new Map([["k", -0]]),
    set: new Set([1, 2n]),
    buf: Buffer.from([1, 2, 3]),
  };

  const normalized = sanitizeJsonValue(sample);
  assert.equal(Object.is(normalized.negZero, 0), true);
  assert.equal(normalized.nanVal, null);
  assert.equal(normalized.infVal, null);
  assert.equal(normalized.negInfVal, null);
  assert.equal(normalized.big, "9007199254740993");
  assert.equal(normalized.cyclic.self, "[Circular]");
  assert.deepEqual(normalized.err, { name: "Error", message: "boom", code: "E_TEST" });
  assert.equal(normalized.when, "2026-11-21T00:00:00.000Z");
  assert.equal(Object.is(normalized.map.k, 0), true);
  assert.deepEqual(normalized.set, [1, "2"]);
  assert.deepEqual(normalized.buf, [1, 2, 3]);

  const jsonText = safeJsonStringify(sample, 0);
  assert.equal(typeof jsonText, "string");
  assert.match(jsonText, /"9007199254740993"/);

  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});

test("lib/extract-asar.js: rejects tampered headerPayloadSize and __proto__ entry names", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-asar-"));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Valid baseline first
  const okAsar = path.join(tmpDir, "ok.asar");
  writeRawAsar(okAsar, {
    manifestObj: { files: { "hello.txt": { size: 2, offset: "0" } } },
  });
  const okOut = path.join(tmpDir, "out-ok");
  assert.equal(extractAsar(okAsar, okOut), 1);
  assert.equal(fs.readFileSync(path.join(okOut, "hello.txt"), "utf8"), "ok");

  // Offset 8 (headerPayloadSize) tampered to 0 -> must reject
  const badZeroAsar = path.join(tmpDir, "bad-zero.asar");
  writeRawAsar(badZeroAsar, {
    manifestObj: { files: { "hello.txt": { size: 2, offset: "0" } } },
    payloadSizeOverride: 0,
  });
  assert.throws(() => extractAsar(badZeroAsar, path.join(tmpDir, "out-bad-0")), /asar header size invalid/);

  // Offset 8 tampered larger than headerSize - 4 -> must reject
  const manifestLen = Buffer.from(JSON.stringify({ files: { "hello.txt": { size: 2, offset: "0" } } })).length;
  const headerSize = 8 + Math.ceil(manifestLen / 4) * 4;
  const badLargeAsar = path.join(tmpDir, "bad-large.asar");
  writeRawAsar(badLargeAsar, {
    manifestObj: { files: { "hello.txt": { size: 2, offset: "0" } } },
    payloadSizeOverride: headerSize,
  });
  assert.throws(() => extractAsar(badLargeAsar, path.join(tmpDir, "out-bad-lg")), /asar header size invalid/);

  // Entry named __proto__ -> must reject
  const protoAsar = path.join(tmpDir, "proto.asar");
  const protoManifest = Buffer.from('{"files":{"__proto__":{"size":2,"offset":"0"}}}', "utf8");
  const protoHeaderSize = 8 + Math.ceil(protoManifest.length / 4) * 4;
  const protoHeader = Buffer.alloc(8 + protoHeaderSize);
  protoHeader.writeUInt32LE(4, 0);
  protoHeader.writeUInt32LE(protoHeaderSize, 4);
  protoHeader.writeUInt32LE(protoHeaderSize - 4, 8);
  protoHeader.writeUInt32LE(protoManifest.length, 12);
  protoManifest.copy(protoHeader, 16);
  fs.writeFileSync(protoAsar, Buffer.concat([protoHeader, Buffer.from("ok")]));
  assert.throws(() => extractAsar(protoAsar, path.join(tmpDir, "out-proto")), /Invalid asar entry name/);
});

test("package.json declares DSH engines/peerDependencies compatibility contract", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.engines?.dsh, ">=0.2.0-rc.1 <0.3.0-0");
  assert.equal(pkg.peerDependencies?.["@deepseek-ai/dsh"], ">=0.2.0-rc.1 <0.3.0-0");
  assert.equal(pkg.peerDependenciesMeta?.["@deepseek-ai/dsh"]?.optional, true);
  assert.equal(pkg.dshTarget, pkg.version);

  const range = pkg.engines.dsh;
  for (const okVer of ["0.2.0-rc.1", "0.2.2-rc.5", "0.2.9"]) {
    assert.equal(satisfiesDshRange(okVer, range), true, `expected ${okVer} to satisfy ${range}`);
  }
  for (const badVer of ["0.1.9", "0.3.0-alpha.1", "0.3.0"]) {
    assert.equal(satisfiesDshRange(badVer, range), false, `expected ${badVer} to fail ${range}`);
  }
});

test(
  "redteam integration: subagent evidence auto-downgrades to claimed and gates root update_goal(complete)",
  { skip: Boolean(redteamUnavailableReason) && redteamUnavailableReason },
  async (t) => {
    const [{ RedteamStore }, { EvidenceLedger }] = await Promise.all([
      import("../lib/redteam/store-core.js"),
      import("../lib/redteam/evidence-ledger.mjs"),
    ]);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-rt-"));
    const store = new RedteamStore(tmpRoot);
    const tools = new Map();
    const guards = [];
    const disposers = [];
    const eventHooks = new Map();
    const hookOpts = new Map();
    const rootSession = { id: "rt-root-1", header: { id: "rt-root-1" } };
    const subSession = {
      id: "rt-sub-1",
      header: { id: "rt-sub-1", parentSession: "rt-root-1", origin: "subagent" },
    };
    const subSession2 = {
      id: "rt-sub-2",
      header: { id: "rt-sub-2", parentSession: "rt-root-1", origin: "subagent" },
    };
    let liveChildCount = 0;

    const rtCtx = {
      redteam: store,
      get(key) {
        if (key === "redteam") return store;
        if (key === "sessions") {
          return {
            get: (id) => (id === "rt-root-1" ? rootSession : id === "rt-sub-1" ? subSession : undefined),
          };
        }
        if (key === "subagents") {
          return {
            listChildren: async () =>
              liveChildCount > 0 ? [{ kind: "child", activity: "running", id: "rt-sub-1" }] : [],
          };
        }
        return undefined;
      },
      tools: {
        register(spec) {
          tools.set(spec.name, spec);
          return () => {};
        },
        guard(fn) {
          guards.push(fn);
          return () => {};
        },
      },
      on(eventName, handler, opts) {
        if (!eventHooks.has(eventName)) eventHooks.set(eventName, []);
        eventHooks.get(eventName).push(handler);
        hookOpts.set(eventName, opts);
        return () => {};
      },
      effect(fn) {
        const d = fn?.();
        if (typeof d === "function") disposers.push(d);
      },
    };

    t.after(async () => {
      for (const d of disposers.splice(0).reverse()) {
        try {
          await d();
        } catch {
          /* ignore */
        }
      }
      store.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    redteamToolsMod.apply(rtCtx);
    assert.equal(guards.length, 1);

    // Live DSH @deepseek-ai/dsh-tools assertSupportedJsonSchema check on purge_memory + redteam tools
    const dshDesktop = process.env.DSH_DESKTOP_INSTALL;
    if (dshDesktop) {
      const dshToolsPkg = path.join(dshDesktop, "resources", "app", "node_modules", "@deepseek-ai", "dsh-tools", "lib", "index.js");
      if (fs.existsSync(dshToolsPkg)) {
        const { assertSupportedJsonSchema } = createRequire(dshToolsPkg)(dshToolsPkg);
        assertSupportedJsonSchema(MEMORY_TOOL_SPEC.parameters);
        for (const spec of tools.values()) {
          if (spec?.parameters) assertSupportedJsonSchema(spec.parameters);
        }
      }
    }

    for (const ev of ["subagent/end", "agent/disposed", "session/event"]) {
      assert.equal(hookOpts.get(ev)?.global, true, `${ev} listener must use { global: true }`);
    }

    const rootExec = { agent: { session: rootSession } };
    const subExec = { agent: { session: subSession } };

    // Reservation lifecycle: acquire 2 slots, fire agent/disposed + 1-arg DSH subagent/end for rt-sub-1 -> 1 left, then rt-sub-2 -> 0 left
    const acq1 = JSON.parse(
      await tools.get("redteam_agent_slot").execute({ action: "acquire", label: "recon" }, rootExec),
    );
    const acq2 = JSON.parse(
      await tools.get("redteam_agent_slot").execute({ action: "acquire", label: "assess" }, rootExec),
    );
    assert.equal(acq1.ok, true);
    assert.equal(acq2.ok, true);

    for (const fn of eventHooks.get("agent/disposed") || []) fn({ agent: { session: subSession } });
    for (const fn of eventHooks.get("subagent/end") || []) {
      fn({ id: "rt-sub-1", parentSessionId: "rt-root-1", stopReason: "completed" });
    }
    const midSlot = JSON.parse(await tools.get("redteam_agent_slot").execute({ action: "status" }, rootExec));
    assert.equal(midSlot.reservations.length, 1, "agent/disposed + subagent/end must not double-drop slots");

    for (const fn of eventHooks.get("subagent/end") || []) {
      fn({ id: "rt-sub-2", parentSessionId: "rt-root-1", stopReason: "completed" });
    }
    const endSlot = JSON.parse(await tools.get("redteam_agent_slot").execute({ action: "status" }, rootExec));
    assert.equal(endSlot.reservations.length, 0);

    // Aborted turn/end clears leaked reservations when liveChildCount === 0
    await tools.get("redteam_agent_slot").execute({ action: "acquire", label: "leak" }, rootExec);
    for (const fn of eventHooks.get("session/event") || []) {
      fn(rootSession, { type: "turn/end", data: { reason: { kind: "aborted" } } });
    }
    await new Promise((r) => setTimeout(r, 20));
    const afterAbort = JSON.parse(await tools.get("redteam_agent_slot").execute({ action: "status" }, rootExec));
    assert.equal(afterAbort.reservations.length, 0);
    assert.ok(subSession2);

    const openRaw = await tools.get("redteam_engagement_open").execute({ target: "acme-test" }, rootExec);
    const openParsed = JSON.parse(openRaw);
    assert.equal(openParsed.ok, true, openRaw);
    const engagementId = openParsed.engagement.id;

    // Subagent recording with confidence:"observed" auto-downgrades to claimed + subagent-report
    const subRecRaw = await tools
      .get("redteam_evidence_record")
      .execute(
        {
          operation: "port_check",
          parameters: { host: "10.0.0.5", port: 8080 },
          result: { open: true },
          confidence: "observed",
        },
        subExec,
      );
    const subRec = JSON.parse(subRecRaw);
    assert.equal(subRec.ok, true, subRecRaw);
    assert.equal(subRec.downgraded_from, "observed");
    assert.match(String(subRec.downgraded_reason), /claimed/);

    const ledger = new EvidenceLedger(store.db(engagementId));
    const subRow = ledger.get(subRec.ev_id);
    assert.equal(subRow.confidence, "claimed");
    assert.equal(subRow.authority, "subagent-report");
    assert.equal(subRow.source_agent, "rt-sub-1");
    assert.equal(ledger.countUnresolvedClaims(engagementId), 1);

    // Explicit confidence:"claimed" from subagent without source_agent still stamps source_agent
    const subClaimedRaw = await tools
      .get("redteam_evidence_record")
      .execute(
        {
          operation: "banner_note",
          result: { banner: "nginx" },
          confidence: "claimed",
        },
        subExec,
      );
    const subClaimed = JSON.parse(subClaimedRaw);
    assert.equal(subClaimed.ok, true, subClaimedRaw);
    assert.equal(ledger.get(subClaimed.ev_id).source_agent, "rt-sub-1");
    // Clean up second claim before upgrade check below
    store.db(engagementId).prepare("DELETE FROM evidence WHERE ev_id = ?").run(subClaimed.ev_id);

    // Root recording stays observed without downgrade
    const rootRecRaw = await tools
      .get("redteam_evidence_record")
      .execute(
        {
          operation: "http_probe",
          parameters: { url: "http://10.0.0.5:8080" },
          result: { status: 200 },
          confidence: "observed",
        },
        rootExec,
      );
    const rootRec = JSON.parse(rootRecRaw);
    assert.equal(rootRec.ok, true, rootRecRaw);
    assert.equal(rootRec.downgraded_from, undefined);
    assert.equal(ledger.get(rootRec.ev_id).confidence, "observed");

    // Root update_goal(complete) must be denied while unresolved claim exists
    const goalCompleteExec = {
      name: "update_goal",
      arguments: { action: "complete" },
      agent: { session: rootSession },
    };
    const guardDenial = guards[0](goalCompleteExec);
    assert.ok(typeof guardDenial === "string" && guardDenial.includes("claimed/inferred"));

    // Upgrade subagent claim -> root update_goal(complete) is now allowed
    const upRaw = await tools
      .get("redteam_evidence_upgrade")
      .execute(
        {
          claimed_ev_id: subRec.ev_id,
          verified_result: { open: true, verified: true },
        },
        rootExec,
      );
    const up = JSON.parse(upRaw);
    assert.equal(up.ok, true, upRaw);
    assert.equal(ledger.countUnresolvedClaims(engagementId), 0);
    assert.equal(guards[0](goalCompleteExec), undefined);
  },
);
