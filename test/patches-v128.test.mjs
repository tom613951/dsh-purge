import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../lib/core.js";
import * as patchIndex from "../lib/patches/index.js";
import { hostFs } from "../lib/extract-asar.js";

function withTempSandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-v128-"));
  const prevHome = process.env.DSH_HOME;
  const prevSurface = process.env.DSH_SURFACE;
  const home = path.join(root, "home");
  const aiBase = path.join(root, "ai-base");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(aiBase, { recursive: true });
  process.env.DSH_HOME = home;
  process.env.DSH_SURFACE = "web";
  return Promise.resolve()
    .then(() => fn({ root, home, aiBase }))
    .finally(() => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
      if (prevSurface === undefined) delete process.env.DSH_SURFACE;
      else process.env.DSH_SURFACE = prevSurface;
      fs.rmSync(root, { recursive: true, force: true });
    });
}

function writePkgFile(aiBase, pkgDir, relParts, content) {
  const fp = path.join(aiBase, pkgDir, ...relParts);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

test("lib/patches modularization: IDs unique and core re-exports match index", () => {
  const ids = core.ALL_PATCHES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "patch IDs must be unique");
  assert.deepEqual(core.STABILITY_PATCHES.map((p) => p.id), [94, 95, 96, 97, 98, 99]);

  for (const sym of [
    "PATCHES",
    "CODE_PATCHES",
    "ENGINE_PATCHES",
    "NEW_TOOL_PATCHES",
    "STABILITY_PATCHES",
    "ALL_PATCHES",
    "PATCH_DISPLAY_GROUPS",
    "patchAppliesHere",
    "rollupDisplayStatus",
    "groupPatchesForDisplay",
    "tallyDisplayPatches",
  ]) {
    assert.equal(core[sym], patchIndex[sym], `lib/core.js export ${sym} must match lib/patches/index.js`);
  }

  assert.deepEqual(core.PATCH_DISPLAY_GROUPS.followup, [85, 86, 99]);
  assert.deepEqual(core.PATCH_DISPLAY_GROUPS.inspector_budget, [96, 97]);
});

test("targetFiles discovers client-connection, tool-ask-user, and experimental-inspector entries", async () => {
  await withTempSandbox(({ aiBase }) => {
    const conn = writePkgFile(aiBase, "dsh-client-connection", ["lib", "index.js"], "// conn");
    const ask = writePkgFile(aiBase, "dsh-tool-ask-user", ["lib", "index.js"], "// ask");
    const inspIdx = writePkgFile(aiBase, "dsh-experimental-inspector", ["lib", "index.js"], "// idx");
    const inspCli = writePkgFile(aiBase, "dsh-experimental-inspector", ["lib", "client.js"], "// cli");

    const files = core.targetFiles(aiBase);
    assert.equal(path.resolve(files["client-connection"]), path.resolve(conn));
    assert.equal(path.resolve(files["tool-ask-user"]), path.resolve(ask));
    assert.equal(path.resolve(files["experimental-inspector"]), path.resolve(inspIdx));
    assert.equal(path.resolve(files["experimental-inspector-client"]), path.resolve(inspCli));
  });
});

test("#94 BROWSER_COOKIE_NAME_IGNORE_PORT strips trailing port cleanly and is idempotent", () => {
  const p94 = core.ALL_PATCHES.find((p) => p.id === 94);
  assert.ok(p94);
  const src =
    'function cookieName(authority) {\n\treturn "dsh_" + encodeBase64Url(createHash("sha256").update(authority).digest());\n}\n';
  const once = core.applyReplacementsToText(src, p94, "index.js");
  assert.equal(once.changed, true);
  assert.ok(once.text.includes("[dsh-purge] cookie-name-ignore-port"));
  assert.equal(core.filePatchOutcome(once.text, p94, "index.js"), "applied");

  const twice = core.applyReplacementsToText(once.text, p94, "index.js");
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);

  const hashFn = new Function(
    "encodeBase64Url",
    "createHash",
    `${once.text}\nreturn cookieName;`,
  )(
    (buf) => buf.toString("base64url"),
    (alg) => ({
      update: (v) => ({ digest: () => Buffer.from(`${alg}:${v}`, "utf8") }),
    }),
  );
  assert.equal(hashFn("127.0.0.1:43120"), hashFn("127.0.0.1:59999"));
});

test("#95 HOST_MAX_HTTP_HEADER_SIZE adds flag once and repairs duplicated copies", () => {
  const p95 = core.ALL_PATCHES.find((p) => p.id === 95);
  assert.ok(p95);
  const src = 'const args = ["--expose-internals", entry];\n';
  const once = core.applyReplacementsToText(src, p95, "main.js");
  assert.equal(once.changed, true);
  assert.ok(once.text.includes('"--max-http-header-size=262144"'));
  assert.equal(core.filePatchOutcome(once.text, p95, "main.js"), "applied");

  const twice = core.applyReplacementsToText(once.text, p95, "main.js");
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);

  const doubled =
    'const args = ["--expose-internals", /* [dsh-purge] raise-host-header-limit */ "--max-http-header-size=262144", /* [dsh-purge] raise-host-header-limit */ "--max-http-header-size=262144", entry];\n';
  const repaired = core.applyReplacementsToText(doubled, p95, "main.js");
  assert.equal(repaired.changed, true);
  assert.equal(repaired.text, once.text);
});

function buildSourceBufferFixture(budgetExpr, indent) {
  return [
    "class SourceFrameBuffer {",
    "\tconstructor(options) {",
    "\t\tthis.options = options;",
    "\t\tthis.queue = [];",
    "\t\tthis.state = new Map();",
    "\t}",
    "\trecord(topic, payload, monotonicMs) {",
    "\t\treturn { topic, payload, monotonicMs };",
    "\t}",
    "\tstateFits() {",
    "\t\tconst raw = JSON.stringify([...this.state.entries()]);",
    "\t\treturn Buffer.byteLength(raw, 'utf8') <= this.options.maxBytes;",
    "\t}",
    "\tenqueue(rec) {",
    "\t\tthis.queue.push(rec);",
    "\t}",
    "\tsetState(topic, payload, monotonicMs) {",
    "\t\tconst record = this.record(topic, payload, monotonicMs);",
    "\t\tconst previous = this.state.get(topic);",
    "\t\tthis.state.set(topic, record);",
    "\t\tif (!this.stateFits()) {",
    "\t\t\tif (previous === void 0) this.state.delete(topic);",
    `${indent.slice(0, -1)}else this.state.set(topic, previous);`,
    `${indent}throw new Error("inspector: source state exceeds the source-frame byte limit");`,
    "\t\t}",
    "\t\tthis.enqueue(record);",
    "\t}",
    "}",
    "function createBuffer(ctxSpec) {",
    "\treturn new SourceFrameBuffer({",
    `\t\tmaxBytes: ${budgetExpr} - 4096`,
    "\t});",
    "}",
  ].join("\n") + "\n";
}

test("#96 & #97 INSPECTOR_FRAME_BUDGET_RECORD_OVERHEAD[_CLIENT] reserve 1024B and drop oversized cordis/tree cleanly", async () => {
  for (const spec of [
    { id: 96, argName: "spec", expr: "spec.maxSourceFrameBytes", indent: "\t\t\t", key: "experimental-inspector", pkg: ["lib", "index.js"] },
    { id: 97, argName: "bootstrap", expr: "bootstrap.maxFrameBytes", indent: "\t\t\t\t\t", key: "experimental-inspector-client", pkg: ["lib", "client.js"] },
  ]) {
    const patch = core.ALL_PATCHES.find((p) => p.id === spec.id);
    assert.ok(patch);
    const src = buildSourceBufferFixture(spec.expr, spec.indent);
    const res = core.applyReplacementsToText(src, patch, spec.pkg[1]);
    assert.equal(res.hitMismatch, undefined, `patch #${spec.id} must not hit-mismatch`);
    assert.equal(res.changed, true);
    assert.equal(core.filePatchOutcome(res.text, patch, spec.pkg[1]), "applied");

    // Re-running on already-patched buffer must stay clean (skipIfMarked + markers)
    const again = core.applyReplacementsToText(res.text, patch, spec.pkg[1]);
    assert.equal(again.hitMismatch, undefined);
    assert.equal(again.changed, false);

    const createBuffer = new Function(
      "Buffer",
      spec.argName,
      `${res.text}\nreturn createBuffer(${spec.argName});`,
    );
    const buf = createBuffer(Buffer, { maxSourceFrameBytes: 8192, maxFrameBytes: 8192 });
    assert.equal(buf.options.maxBytes, 8192 - 4096 - 1024);

    buf.setState("cordis/tree", "small", 1);
    assert.equal(buf.queue.length, 1);

    // Oversized cordis/tree drops silently without throwing and preserves prior state
    assert.doesNotThrow(() => buf.setState("cordis/tree", "x".repeat(4000), 2));
    assert.equal(buf.queue.length, 1);
    assert.equal(buf.state.get("cordis/tree").payload, "small");

    // Oversized non-cordis topic still throws the budget error
    assert.throws(
      () => buf.setState("session/state", "x".repeat(4000), 3),
      /inspector: source state exceeds the source-frame byte limit/,
    );

    // End-to-end applyPatches convergence twice
    await withTempSandbox(async ({ aiBase }) => {
      writePkgFile(aiBase, "dsh-experimental-inspector", spec.pkg, src);
      const r1 = await core.applyPatches(aiBase, [patch]);
      assert.equal(r1[0].status, "applied");
      const r2 = await core.applyPatches(aiBase, [patch]);
      assert.equal(r2[0].status, "already");
    });
  }
});

test("#98 ASK_USER_WAIT_CAPPED caps -1 to 300s and upgrades legacy marker", () => {
  const p98 = core.ALL_PATCHES.find((p) => p.id === 98);
  assert.ok(p98);

  const official =
    "function run(args, defaultTimeout) {\n\t\t\tconst timeout = validateTimeout(args.timeout ?? defaultTimeout);\n\t\t\treturn timeout;\n}\n";
  const applied = core.applyReplacementsToText(official, p98, "index.js");
  assert.equal(applied.changed, true);
  assert.ok(applied.text.includes("[dsh-purge] -1 capped at 300s"));
  assert.equal(core.filePatchOutcome(applied.text, p98, "index.js"), "applied");

  const evalFn = new Function("validateTimeout", "args", "defaultTimeout", `${applied.text}\nreturn run(args, defaultTimeout);`);
  assert.equal(evalFn((x) => x, { timeout: -1 }, 60), 300);
  assert.equal(evalFn((x) => x, {}, 60), 60);
  assert.equal(evalFn((x) => x, { timeout: 45 }, 60), 45);

  const legacy =
    "function run(args, defaultTimeout) {\n\t\t\tconst timeout = 1; // [dsh-purge] ask_user_question never blocks a turn\n\t\t\treturn timeout;\n}\n";
  assert.equal(core.filePatchOutcome(legacy, p98, "index.js"), "pending");
  const migrated = core.applyReplacementsToText(legacy, p98, "index.js");
  assert.equal(migrated.changed, true);
  assert.equal(core.filePatchOutcome(migrated.text, p98, "index.js"), "applied");
});

test("#99 STEER_WAKE_LATCH latches running wakes and clears on cancel even with keepInbox", () => {
  const p99 = core.ALL_PATCHES.find((p) => p.id === 99);
  assert.ok(p99);
  const src = [
    "class Driver {",
    "\twakeDriver(wakeAfterAbort = false) {",
    "\t\tif (this.phase.kind !== \"idle\") {",
    "\t\t\tif (abortedCancelCause(this.phase.abort.signal)?.kind !== \"disposed\" && (this.phase.kind === \"maintenance\" || wakeAfterAbort)) this.phase.wakeRequested = true;",
    "\t\t\treturn;",
    "\t\t}",
    "\t}",
    "\tcancel(cause, options = {}) {",
    "\t\tif (!options.keepInbox) {",
    "\t\t\tthis.inbox.clear();",
    "\t\t\tif (this.phase.kind !== \"idle\") this.phase.wakeRequested = false;",
    "\t\t}",
    "\t\tif (this.phase.kind !== \"idle\") this.phase.abort.abort(cause);",
    "\t}",
    "}",
  ].join("\n");

  const res = core.applyReplacementsToText(src, p99, "index.js");
  assert.equal(res.changed, true);
  assert.equal(core.filePatchOutcome(res.text, p99, "index.js"), "applied");
  const again = core.applyReplacementsToText(res.text, p99, "index.js");
  assert.equal(again.changed, false);

  const Driver = new Function("abortedCancelCause", `${res.text}\nreturn Driver;`)((sig) => (sig.aborted ? { kind: "cancelled" } : null));
  const d = new Driver();
  d.inbox = { clear() {} };
  d.phase = { kind: "running", wakeRequested: false, abort: { signal: { aborted: false }, abort() { this.signal.aborted = true; } } };
  d.wakeDriver(false);
  assert.equal(d.phase.wakeRequested, true, "running non-aborted wake must latch");
  d.cancel("stop", { keepInbox: true });
  assert.equal(d.phase.wakeRequested, false, "cancel must clear wakeRequested even with keepInbox=true");
});

test("#54 DELIVERABLE_DO_NOT silentWhenMissing yields skipped & drifted=0 in patchStatus and applyPatches", async () => {
  await withTempSandbox(async ({ aiBase }) => {
    const p54 = core.ALL_PATCHES.find((p) => p.id === 54);
    assert.ok(p54 && p54.silentWhenMissing);
    writePkgFile(aiBase, "dsh-deliverable-file-references", ["lib", "index.js"], "// upstream rc.2 clean file\n");

    const st = await core.patchStatus(aiBase, [p54]);
    assert.equal(st[54], "skipped");

    const report = await core.applyPatches(aiBase, [p54]);
    assert.equal(report.length, 1);
    assert.equal(report[0].status, "skipped");
    assert.equal(report[0].drifted, 0);
    assert.equal(report[0].self_marked, 1);
    assert.equal(core.isPatchResultSoftOk(report[0], p54), true);

    // Non-optional silentWhenMissing patch must also be soft-OK
    assert.equal(core.isPatchResultSoftOk({ status: "skipped" }, { id: 5400, optional: false, silentWhenMissing: true }), true);
  });
});

test("patchedTargetStillPatched and refreshStaleBaksForUpgrade protect mixed/partial and anchorless files", async () => {
  await withTempSandbox(({ aiBase }) => {
    const target = writePkgFile(
      aiBase,
      "dsh-tool-ask-user",
      ["lib", "index.js"],
      "const a = 1;\n\t\t\tconst timeout = validateTimeout(args.timeout ?? defaultTimeout);\n",
    );
    const bakPath = `${target}.dshpurge.bak`;

    // 1. Clean upgrade (new official content differs from old bak, contains vendor anchor, no marker/partial edit)
    fs.writeFileSync(bakPath, "const a = 0;\n\t\t\tconst timeout = validateTimeout(args.timeout ?? defaultTimeout);\n", "utf8");
    const cleanNew = fs.readFileSync(target);
    assert.equal(core.patchedTargetStillPatched(target, cleanNew, aiBase, fs.readFileSync(bakPath)), false);
    const refreshedClean = core.refreshStaleBaksForUpgrade(aiBase);
    assert.equal(refreshedClean.length, 1);
    assert.equal(fs.readFileSync(bakPath, "utf8"), cleanNew.toString("utf8"));

    // 2. Partial/mixed edit (one patch replacement present, marker stripped, another vendor anchor present)
    const p96 = core.ALL_PATCHES.find((p) => p.id === 96);
    const inspPath = writePkgFile(aiBase, "dsh-experimental-inspector", ["lib", "index.js"], "");
    const inspBak = `${inspPath}.dshpurge.bak`;
    const baselineInsp = buildSourceBufferFixture("spec.maxSourceFrameBytes", "\t\t\t");
    fs.writeFileSync(inspBak, baselineInsp, "utf8");
    // Apply ONLY replacement 1 (drop markerless or partial replacement while keeping anchor 2 intact)
    const mixedInsp = baselineInsp
      .replace("maxBytes: spec.maxSourceFrameBytes - 4096\n", "maxBytes: spec.maxSourceFrameBytes - 4096 - 1024 /* partial */\n")
      .replace(
        'else this.state.set(topic, previous);\n\t\t\tthrow new Error("inspector: source state exceeds the source-frame byte limit");',
        'else this.state.set(topic, previous);\n\t\t\tif (topic === "cordis/tree") return;\n\t\t\tthrow new Error("inspector: source state exceeds the source-frame byte limit");',
      );
    // Replace pattern 1? Keep pattern 2 intact and mutate pattern 1 with non-dsh-purge replacement or test synthetic mixed edit on #98!
    fs.writeFileSync(inspPath, mixedInsp, "utf8");
    // Here neither vendor anchor remained because both changed; let's test true mixed (1 anchor kept, 1 non-marked replacement changed) on #96 with rep1 mutated only & synthetic patch anchor:
    const inspPartial = baselineInsp.replace(
      "maxBytes: spec.maxSourceFrameBytes - 4096\n",
      `maxBytes: spec.maxSourceFrameBytes - 4096 - 1024 ${p96.markers[0].replace("dsh-purge", "custom")}\n`,
    );
    fs.writeFileSync(inspPath, inspPartial, "utf8");
    // No vendor anchor for rep1, rep2 anchor still present -> hasVendorAnchor=true, and !hasVendorAnchor would be false;
    // Now verify exact partial-edit case where written snippet matches replace without "dsh-purge":
    const connPath = writePkgFile(
      aiBase,
      "dsh-client-connection",
      ["lib", "index.js"],
      'encodeBase64Url(createHash("sha256").update(String(authority).replace(/:[0-9]+$/u, "")).digest())\n',
    );
    const connBak = `${connPath}.dshpurge.bak`;
    fs.writeFileSync(
      connBak,
      'encodeBase64Url(createHash("sha256").update(authority).digest())\n',
      "utf8",
    );
    // No dsh-purge string and no marker, yet vendor anchor is absent -> !hasVendorAnchor must protect bak
    assert.equal(core.patchedTargetStillPatched(connPath, fs.readFileSync(connPath), aiBase, fs.readFileSync(connBak)), true);

    // Also test multi-patch file where patch A (say #35 no marker / replacement) applied without "dsh-purge" marker while patch B (#1) kept vendor anchor
    const approvalPath = writePkgFile(aiBase, "dsh-agent-instructions", ["lib", "index.js"], "");
    const approvalBak = `${approvalPath}.dshpurge.bak`;
    const p1 = core.ALL_PATCHES.find((p) => p.id === 1);
    const p2 = core.ALL_PATCHES.find((p) => p.id === 2);
    const baseInstr = `${p1.replacements[0].pattern}\n${p2.replacements[0].pattern}\n`;
    const mixedInstr = `${p1.replacements[0].pattern}\n${p2.replacements[0].replace}\n`;
    fs.writeFileSync(approvalBak, baseInstr, "utf8");
    fs.writeFileSync(approvalPath, mixedInstr, "utf8");
    assert.equal(core.patchedTargetStillPatched(approvalPath, mixedInstr, aiBase, baseInstr), true);
    const refreshedBlocked = core.refreshStaleBaksForUpgrade(aiBase);
    assert.equal(refreshedBlocked.includes(connPath), false);
    assert.equal(refreshedBlocked.includes(approvalPath), false);
    assert.equal(fs.readFileSync(connBak, "utf8").includes("update(authority)"), true);
    assert.equal(fs.readFileSync(approvalBak, "utf8"), baseInstr);
  });
});

test("applyPatches and patchStatus cache reads per invocation while staying consistent", async () => {
  await withTempSandbox(async ({ aiBase }) => {
    const agentLoop = writePkgFile(
      aiBase,
      "dsh-agent-loop",
      ["lib", "index.js"],
      [
        "class Loop {",
        '\twakeDriver(wakeAfterAbort = false) {',
        '\t\t\tif (abortedCancelCause(this.phase.abort.signal)?.kind !== "disposed" && (this.phase.kind === "maintenance" || wakeAfterAbort)) this.phase.wakeRequested = true;',
        "\t}",
        '\tcancel(cause, options = {}) {',
        '\t\tif (!options.keepInbox) {',
        '\t\t\tthis.inbox.clear();',
        '\t\t\tif (this.phase.kind !== "idle") this.phase.wakeRequested = false;',
        "\t\t}",
        '\t\tif (this.phase.kind !== "idle") this.phase.abort.abort(cause);',
        "\t}",
        "}",
      ].join("\n"),
    );

    const patchesOnAgentLoop = core.ALL_PATCHES.filter((p) =>
      (Array.isArray(p.file) ? p.file : [p.file]).includes("agent-loop"),
    );
    assert.ok(patchesOnAgentLoop.length >= 3, "expected multiple patches targeting agent-loop");

    const origReadFile = hostFs.promises.readFile;
    let utf8Reads = 0;
    hostFs.promises.readFile = async (fp, ...args) => {
      if (path.resolve(String(fp)) === path.resolve(agentLoop) && args[0] === "utf8") {
        utf8Reads += 1;
      }
      return origReadFile(fp, ...args);
    };

    try {
      const statusBefore = await core.patchStatus(aiBase, patchesOnAgentLoop);
      assert.equal(utf8Reads, 1, "patchStatus should read shared agent-loop file only once");
      assert.equal(statusBefore[99], "pending");

      utf8Reads = 0;
      const report = await core.applyPatches(aiBase, patchesOnAgentLoop);
      assert.equal(utf8Reads, 1, "applyPatches should read shared agent-loop file only once");
      const r99 = report.find((r) => r.patch_id === 99);
      assert.equal(r99?.status, "applied");

      utf8Reads = 0;
      const statusAfter = await core.patchStatus(aiBase, patchesOnAgentLoop);
      assert.equal(utf8Reads, 1, "post-apply patchStatus should also read shared file once");
      assert.equal(statusAfter[99], "applied");
    } finally {
      hostFs.promises.readFile = origReadFile;
    }
  });
});
